import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type {
  JsonObject,
  JsonValue,
  ProviderRequestContext,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  DOORSTOP_BASELINE_BLOB_MAX,
  DOORSTOP_BASELINE_GREP_LIMIT,
  DOORSTOP_BASELINE_HISTORY_LIMIT,
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_FILES_MAX,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_RUN_OPERATION,
  isValidDoorstopItemPath,
  parseDoorstopBaselineRequest,
  parseDoorstopGitCommitRequest,
  parseDoorstopGitStageRequest,
  parseDoorstopGitStatusRequest,
  parseDoorstopRunRequest,
  type DoorstopBaselineCandidate,
  type DoorstopBaselineResponse,
  type DoorstopCommitOutcome,
  type DoorstopGitFileState,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopRunRequest,
  type DoorstopRunResponse,
} from "./doorstop-backend-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";

const DEFAULT_DOORSTOP_COMMAND = "doorstop";
const DEFAULT_GIT_COMMAND = "git";
/** Default run timeout: headroom under the 10 s host callback bound. */
const DEFAULT_DOORSTOP_TIMEOUT_MS = 8_500;

/** Environment keys removed from the host env before the run (git `GIT_*`
 *  hygiene idiom). Doorstop's CLI reads nothing from the environment except
 *  `$EDITOR` (verified against the installed package: no `getenv`/`environ`
 *  use in `doorstop/cli`, `doorstop/settings`); the unset list is defensive
 *  — `PYTHONPATH` is the real import-poisoning vector for a Python CLI, and
 *  a future Doorstop home-directory override (`DOORSTOP_HOME`, per plan)
 *  must never leak into the run. */
const DOORSTOP_UNSET_ENV_KEYS = Object.freeze(["DOORSTOP_HOME", "PYTHONPATH"] as const);

/** ENOENT taxonomy message — surfaced verbatim to the browser session error. */
const DOORSTOP_CLI_NOT_FOUND_MESSAGE =
  "opendoor: doorstop CLI not found on the sessiond host PATH — configure plugins.opendoor.settings.doorstopPath";

/** ENOENT taxonomy message for git — surfaced verbatim as the commit
 *  outcome's `failed` stderr excerpt (the baseline handler degrades its
 *  rev-parse failure to `{ git: false }` instead; the unpaired-install
 *  terminal fallback never reaches either path). */
const GIT_NOT_FOUND_MESSAGE =
  "opendoor: git not found on the sessiond host PATH — configure plugins.opendoor.settings.gitPath";

/** Hard pipeline budget measured from `startedAt` — the review+commit
 *  pipeline and the baseline fetch share one callback with the host's ~10 s
 *  bound, and this budget keeps the plugin inside it with headroom, skipping
 *  or degrading the git phase instead of letting the host abort the whole
 *  callback. */
const PIPELINE_DEADLINE_BUDGET_MS = 9_500;

/** Echo cap for a `failed` commit outcome's stderr excerpt (~2 KiB, plan
 *  step 5) — the excerpt is Last run narration, not a firehose. */
const COMMIT_STDERR_EXCERPT_LIMIT = 2048;

/** The git plugin's `GIT_*` hygiene list, verbatim: git only needs a clean
 *  `GIT_*`-free env — a leaked GIT_DIR/GIT_INDEX_FILE from the host
 *  environment would silently point the porcelain at the wrong repository,
 *  and GIT_PREFIX would skew every relative pathspec. */
const GIT_UNSET_ENV_KEYS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const);

/** Item-path walk bounds (see findItemPath): how deep and how many entries
 *  the uid→path resolution scans. Doorstop trees are shallow (document
 *  subdirectories, a few levels of nesting); the bounds keep the walk cheap
 *  inside the review→commit deadline budget. */
const ITEM_PATH_WALK_MAX_DEPTH = 12;
const ITEM_PATH_WALK_MAX_ENTRIES = 2048;
/** Directory names the item-path walk never enters — the plugin discovery
 *  skip set plus the plugin's own settings directory (never an item dir). */
const ITEM_PATH_WALK_SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", ".pi-web"]);

const activationRunQueues = new WeakMap<ServerPluginActivationContext, Map<string, Promise<void>>>();

/**
 * Lenient host-settings projection: `doorstopPath` and `gitPath` (non-empty
 * strings) and `timeoutMs` (positive finite number) are honored — `timeoutMs`
 * clamped to the default ceiling (settings may shorten the default, never
 * exceed it); anything else falls back to the defaults silently. Neither
 * command path is validated beyond type (a host PATH lookup resolves the
 * default; an absolute path is the user's responsibility — the doorstopPath
 * idiom), and the SAME `timeoutMs` bounds the doorstop exec and every git
 * exec of the commit/baseline pipelines.
 */
interface DoorstopBackendSettings {
  readonly doorstopPath: string;
  readonly gitPath: string;
  readonly timeoutMs: number;
}

/** The server-plugin dispatcher routes by operation; this guard keeps DIRECT
 *  calls pinned to the run contract. */
export async function requestDoorstopBackend(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_RUN_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // Strict parse BEFORE any exec and before queueing — a malformed request
  // never parks behind a slow run.
  const run = parseDoorstopRunRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    const result = await runDoorstop(
      context,
      settings,
      cwd,
      doorstopArgv(run),
      request.signal,
      Math.min(settings.timeoutMs, remainingBudgetMs(startedAt)),
    );
    let commit: DoorstopCommitOutcome | undefined;
    if (run.op === "review" && run.commit === true) {
      commit =
        result.exitCode === 0
          ? await reviewCommitPipeline(context, settings, cwd, run.uid, request.signal, startedAt)
          : { status: "skipped" };
    }
    return doorstopRunResponse(run.op, result, Date.now() - startedAt, commit);
  });
}

/** The server-side argv map — mirrors the terminal command builders in
 *  doorstop-panel-element.ts exactly (bare `doorstop` validates; publish is
 *  always `publish all <target>`; clear takes the multi-parent form). Any
 *  drift breaks the browser's narration/parity expectations silently. */
function doorstopArgv(run: DoorstopRunRequest): readonly string[] {
  switch (run.op) {
    case "validate":
      return [];
    case "publish":
      return ["publish", "all", run.target];
    case "review":
      return ["review", run.uid];
    case "clear":
      return ["clear", run.uid, ...run.parents];
    case "edit":
      return ["edit", run.uid];
    case "link":
      return ["link", run.uid, run.target];
    case "unlink":
      return ["unlink", run.uid, run.target];
  }
}

/**
 * Internal `context.execFile` wrapper: `file` resolves from settings
 * (`doorstopPath`), `cwd` is the host-validated absolute workspace path
 * (never derived from `project.path`), and the per-invocation signal is
 * always forwarded (the host API requires a `signal` field per invocation;
 * it is never retained). `timeoutMs` hands deadline-budget control to the
 * caller. Errors: ENOENT (spawn could not resolve the binary) maps to the
 * "CLI not found" message; anything else is host-attributed (exec timeout
 * kill, callback abort) and rethrows untouched.
 */
async function runDoorstop(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = settings.timeoutMs,
): Promise<ServerPluginExecFileResult> {
  try {
    return await context.execFile({
      file: settings.doorstopPath,
      args,
      cwd,
      unsetEnv: DOORSTOP_UNSET_ENV_KEYS,
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(DOORSTOP_CLI_NOT_FOUND_MESSAGE);
    }
    throw error;
  }
}

/**
 * Map the host exec result onto the shared response shape: `op` echoed from
 * the validated request, the exec fields verbatim — INCLUDING the
 * truncation flags, which pass through deliberately (the git pipelines
 * throw on truncation; a CLI run's partial content is display material,
 * not an error) — and the measured `durationMs`. Built as an object
 * LITERAL so the strict `parseDoorstopRunResponse` sees the exact server
 * output shape. (The declared return is `JsonValue` — the host bridge
 * type — rather than the `DoorstopRunResponse` interface, because a named
 * interface lacks the implicit index signature `JsonObject` requires.)
 */
function doorstopRunResponse(
  op: DoorstopRunRequest["op"],
  result: ServerPluginExecFileResult,
  durationMs: number,
  commit?: DoorstopCommitOutcome,
): JsonValue {
  return {
    op,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs,
    // Omitted unless the pipeline produced one (exactOptionalPropertyTypes:
    // a response without `commit` must not carry the key at all). The spread
    // yields a fresh object so the value admits the host bridge's JsonObject
    // index signature (the interface itself lacks it).
    ...(commit === undefined ? {} : { commit: { ...commit } }),
  } satisfies DoorstopRunResponse;
}

/**
 * Serialize all runs for ONE workspace.path within ONE activation. Doorstop
 * CLI runs are not concurrency-safe (no file locking — two concurrent runs
 * in one checkout can corrupt the YAML/HTML artifacts). The queue map is
 * ACTIVATION-SCOPED: a module-level WeakMap keyed by the frozen activation
 * context gives each activation its own map (entries die with the context),
 * and each per-workspace entry self-cleans once settled with no successor —
 * the activation never accumulates settled promises.
 */
async function runSerialized<T>(
  context: ServerPluginActivationContext,
  cwd: string,
  action: () => Promise<T>,
): Promise<T> {
  let queues = activationRunQueues.get(context);
  if (queues === undefined) {
    queues = new Map<string, Promise<void>>();
    activationRunQueues.set(context, queues);
  }
  // Chain past the previous tail whether it resolved or rejected; the stored
  // tail is always a settled-void promise so it never poisons successors.
  const previous = queues.get(cwd) ?? Promise.resolve();
  const run = previous.then(action, action);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(cwd, tail);
  try {
    return await run;
  } finally {
    // Reap only when no successor chained onto OUR tail (a successor keeps
    // the entry alive and reaps itself); `await` (not bare `return`) so the
    // finally runs when `run` actually settles, not at scheduling time.
    if (queues.get(cwd) === tail) queues.delete(cwd);
  }
}

/** Lenient settings parse: wrong types fall back to defaults silently (the
 *  sessiond config is a startup snapshot, not a request payload); a
 *  configured `timeoutMs` is clamped to the default ceiling. */
function parseDoorstopBackendSettings(settings: JsonObject): DoorstopBackendSettings {
  const configuredPath = settings["doorstopPath"];
  const doorstopPath =
    typeof configuredPath === "string" && configuredPath !== "" ? configuredPath : DEFAULT_DOORSTOP_COMMAND;
  const configuredGitPath = settings["gitPath"];
  const gitPath =
    typeof configuredGitPath === "string" && configuredGitPath !== "" ? configuredGitPath : DEFAULT_GIT_COMMAND;
  const configuredTimeout = settings["timeoutMs"];
  const timeoutMs =
    typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, DEFAULT_DOORSTOP_TIMEOUT_MS)
      : DEFAULT_DOORSTOP_TIMEOUT_MS;
  return { doorstopPath, gitPath, timeoutMs };
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The provider's unsupported-operation error — shared by the server-plugin
 *  dispatcher and every handler's own guard, so the message text cannot
 *  drift between the two. */
export function unsupportedBackendOperationError(operation: string): Error {
  return new Error(`opendoor: unsupported workspace backend operation: ${operation}`);
}

function remainingBudgetMs(startedAt: number): number {
  return PIPELINE_DEADLINE_BUDGET_MS - (Date.now() - startedAt);
}

/** Per-exec timeout under the deadline budget: `min(settings.timeoutMs,
 *  remaining)` with a 1 ms floor so a non-positive remainder can never reach
 *  the host (callers check `remainingBudgetMs > 0` first and skip). */
function gitExecTimeoutMs(settings: DoorstopBackendSettings, startedAt: number): number {
  return Math.max(1, Math.min(settings.timeoutMs, remainingBudgetMs(startedAt)));
}

function commitStderrExcerpt(stderr: string): string {
  return stderr.length > COMMIT_STDERR_EXCERPT_LIMIT
    ? `${stderr.slice(0, COMMIT_STDERR_EXCERPT_LIMIT)}\n… (stderr truncated)`
    : stderr;
}

/**
 * Internal `context.execFile` wrapper for git: `file` resolves from
 * settings (`gitPath`, default "git"), the same call shape as runDoorstop
 * (cwd = the host-validated workspace path, per-invocation signal always
 * forwarded, hygiene via the git plugin's `GIT_*` unset list), and a
 * deadline-budgeted `timeoutMs`. ENOENT maps to the "git not found"
 * message; the review→commit pipeline folds that message (and every other
 * throw) into the `failed` commit outcome, and the baseline/status
 * handlers degrade it to `{ git: false }` / an empty candidate set.
 */
async function runGit(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ServerPluginExecFileResult> {
  try {
    return await context.execFile({
      file: settings.gitPath,
      args,
      cwd,
      unsetEnv: GIT_UNSET_ENV_KEYS,
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(GIT_NOT_FOUND_MESSAGE);
    }
    throw error;
  }
}

/** Whether a `rev-parse --is-inside-work-tree` exec proved the cwd sits in
 *  a git work tree: exit 0 AND the FIRST stdout line is exactly `true`. A
 *  bare repository (or a `.git` directory) prints `false` with EXIT 0 — an
 *  empty-output check would wrongly PASS those, and the NEXT git step
 *  would surface `failed` ("this operation must be run in a work tree")
 *  instead of the plan's `skipped` / `{ git: false }`. First-line, not
 *  whole-output: the sites appending `--show-prefix` (baseline/status)
 *  print `true` on line one and the cwd→root prefix on line two — a
 *  whole-output trim would read a nested workspace's `"true\nreqs/\n"` as
 *  "not true" and wrongly degrade it. */
function isWorkTreeResult(result: ServerPluginExecFileResult): boolean {
  return result.exitCode === 0 && result.stdout.split(/\r?\n/, 1)[0] === "true";
}

/** The short sha from a successful `git commit`'s own FIRST stdout line —
 *  `[main abc1234] message` (branch), `[detached HEAD abc1234] …`, or
 *  `[main (root-commit) abc1234] …` (the first commit) — the fallback when
 *  a post-commit `rev-parse --short HEAD` fails or is skipped by the
 *  deadline budget: the commit ALREADY LANDED, so the outcome must stay
 *  `committed` (narrating a landed user commit as `failed`/`skipped` while
 *  the strip silently shows it committed is dishonest narration; a dropped
 *  rev-parse is an instrumentation failure, not an outcome failure).
 *  `undefined` when the first line carries no bracket sha (defensive — git
 *  always prints one on success). The greedy `.*` backtracks to the LAST
 *  `\b<hex>]` in the line, which is the sha token: git puts the sha last
 *  inside the bracket, before the message. */
function commitBracketSha(commitStdout: string): string | undefined {
  const firstLine = commitStdout.split(/\r?\n/, 1)[0] ?? "";
  const match = /^\[.*\b([0-9a-f]{7,40})\](?:.*)$/.exec(firstLine);
  return match?.[1];
}

/** A git step resolved with a non-zero exit (or no exit at all) where the
 *  pipeline requires success: throw the stderr (or a synthesized line when
 *  the exec was killed with no output) so the pipeline's single catch folds
 *  it into the bounded `failed` outcome. Deliberately never returns. */
function gitStepFailure(result: ServerPluginExecFileResult, args: readonly string[]): never {
  const stderr = result.stderr.trim();
  const reason =
    stderr !== ""
      ? stderr
      : result.signal !== null
        ? `git ${args.join(" ")} ended from signal ${result.signal}`
        : `git ${args.join(" ")} exited ${String(result.exitCode)}`;
  throw new Error(reason);
}

/**
 * The review→commit git phase: after `doorstop review <uid>` exited 0,
 * record the item file's new state as ONE pathspec-limited conforming
 * commit. Every exec shares the pipeline's `startedAt` deadline budget and
 * forwards the per-invocation signal; an exhausted budget skips the phase,
 * an already-committed file is `clean`, and ANY git failure collapses into
 * `{ status: "failed", stderr }` — the review succeeded and its result
 * stands, so the caller still returns the successful run response with
 * this outcome attached (the outcome is narration, not infrastructure
 * error).
 */
async function reviewCommitPipeline(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  uid: string,
  signal: AbortSignal,
  startedAt: number,
): Promise<DoorstopCommitOutcome> {
  try {
    // An exhausted budget skips the git phase — the commit is narration,
    // never a second chance to hold the host callback hostage.
    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const inWorkTree = await runGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      signal,
      gitExecTimeoutMs(settings, startedAt),
    );
    if (!isWorkTreeResult(inWorkTree)) return { status: "skipped" };

    // The request carries only the uid; the item file is resolved by the
    // bounded walk below, then passed through the SAME safe-relative-path
    // rule the baseline request paths satisfy (isValidDoorstopItemPath) — a
    // pathspec the rule rejects can never reach git. The outcome has no
    // "item not found" status, so an unresolvable path is `skipped`.
    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const itemPath = await findItemPath(cwd, uid);
    if (itemPath === undefined || !isValidDoorstopItemPath(itemPath)) return { status: "skipped" };

    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const status = await runGit(
      context,
      settings,
      cwd,
      ["status", "--porcelain", "--", literalPathspec(itemPath)],
      signal,
      gitExecTimeoutMs(settings, startedAt),
    );
    if (status.exitCode !== 0) gitStepFailure(status, ["status", "--porcelain", "--", literalPathspec(itemPath)]);
    // Empty porcelain output → already committed, no working-tree change.
    // Known edge, documented not "fixed": an IGNORED item file also prints
    // nothing (plain porcelain hides ignored files), so it reports `clean`
    // while its content was never committed — the later baseline then
    // honestly reports `none`. A gitignored item file is a
    // misconfiguration, not a pipeline concern.
    if (status.stdout === "") return { status: "clean" };

    // `git add` first: `git commit -- <path>` only commits paths KNOWN to
    // git, so untracked new item files would fail without it; the literal
    // pathspec-limited form records only the item file and leaves the
    // user's other staged/unstaged WIP untouched.
    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const add = await runGit(context, settings, cwd, ["add", "--", literalPathspec(itemPath)], signal, gitExecTimeoutMs(settings, startedAt));
    if (add.exitCode !== 0) gitStepFailure(add, ["add", "--", literalPathspec(itemPath)]);

    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const commit = await runGit(
      context,
      settings,
      cwd,
      ["commit", "-m", `doorstop: review ${uid}`, "--", literalPathspec(itemPath)],
      signal,
      gitExecTimeoutMs(settings, startedAt),
    );
    if (commit.exitCode !== 0)
      gitStepFailure(commit, ["commit", "-m", `doorstop: review ${uid}`, "--", literalPathspec(itemPath)]);
    // The message format is PINNED: the item-baseline grep matches
    // `^doorstop: review <uid>$` against exactly this string — any drift
    // silently breaks the fast baseline path.

    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const head = await runGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--short", "HEAD"],
      signal,
      gitExecTimeoutMs(settings, startedAt),
    );
    if (head.exitCode !== 0) gitStepFailure(head, ["rev-parse", "--short", "HEAD"]);
    const sha = head.stdout.trim();
    if (sha === "") gitStepFailure(head, ["rev-parse", "--short", "HEAD"]);
    return { status: "committed", sha };
  } catch (error) {
    // Any git failure — non-zero exit, killed exec, missing binary —
    // collapses into the bounded `failed` outcome and the response still
    // RESOLVES. A host-attributed ABORT is the exception: it rethrows
    // untouched — a cancelled callback has no consumer for a resolved
    // narration.
    if (signal.aborted) throw error;
    return { status: "failed", stderr: commitStderrExcerpt(formatUnknownError(error)) };
  }
}

/**
 * The `doorstop.item-baseline` handler: locate the reviewed version of an
 * item file in git history — the cheap conforming-message grep with the
 * generic history walk as fallback — and return the `{ git, source,
 * candidates }` contract shape. Read-only and BEST-EFFORT: a non-repo
 * resolves `{ git: false }`, a broken log/show step degrades to fewer
 * candidates, an oversize blob is skipped — never an infrastructure error
 * (the contract response has no error channel). Shares the per-workspace
 * serialization and the same `startedAt` deadline budget.
 */
export async function requestDoorstopBaseline(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_BASELINE_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // Strict parse before any exec and before queueing.
  const baseline = parseDoorstopBaselineRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    // Any rev-parse failure — non-zero exit in a bare/absent repo, a
    // missing git binary, a killed exec — maps to `{ git: false }`: the
    // baseline response has no error channel.
    const inWorkTree = await baselineGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
      request.signal,
      startedAt,
    );
    if (inWorkTree === undefined || !isWorkTreeResult(inWorkTree)) {
      return baselineResponse(false, "none", []);
    }
    // The rev-parse second line is the cwd→repo-root prefix ("sub/dir/",
    // empty at the root): the `git show <sha>:<path>` TREE path below is
    // repo-root-relative while the browser's `path` is cwd-relative, so the
    // show path is translated by prepending this prefix (identical when the
    // workspace IS the repo root — the common case).
    const showPrefix = inWorkTree.stdout.split(/\r?\n/)[1] ?? "";

    // Fast path: the pinned conforming review-commit message. The uid is
    // escaped against the TRUE basic-regex (BRE) metacharacters, and the
    // BRE `^…$` anchors defeat the REQ001-matches-REQ0012 substring trap
    // that `--fixed-strings` cannot.
    const pattern = `^doorstop: review ${escapeRegexMeta(baseline.uid)}$`;
    const grep = await baselineGit(
      context,
      settings,
      cwd,
      [
        "log",
        `--max-count=${DOORSTOP_BASELINE_GREP_LIMIT}`,
        `--grep=${pattern}`,
        "--format=%H",
        "--",
        literalPathspec(baseline.path),
      ],
      request.signal,
      startedAt,
    );
    let shas: readonly string[];
    let source: DoorstopBaselineResponse["source"];
    if (grep !== undefined && grep.exitCode === 0 && grep.stdout.trim() !== "") {
      shas = grep.stdout.trim().split(/\r?\n/);
      source = "review-commit";
    } else {
      // Zero grep hits → the generic history fallback (rewritten/squashed
      // history missed the conforming message); the browser still finds the
      // reviewed version by stamp-matching the blobs.
      const history = await baselineGit(
        context,
        settings,
        cwd,
        ["log", `--max-count=${DOORSTOP_BASELINE_HISTORY_LIMIT}`, "--format=%H", "--", literalPathspec(baseline.path)],
        request.signal,
        startedAt,
      );
      if (history === undefined || history.exitCode !== 0 || history.stdout.trim() === "") {
        return baselineResponse(true, "none", []);
      }
      shas = history.stdout.trim().split(/\r?\n/);
      source = "history";
    }

    const candidates: DoorstopBaselineCandidate[] = [];
    for (const sha of shas) {
      if (sha === "" || remainingBudgetMs(startedAt) <= 0) break;
      // `git show <sha>:<path>` per candidate, NEWEST-first (git log order).
      // A commit that predates the item's current path (renames), an
      // oversize blob, or a budget/tool failure all merely SKIP the
      // candidate — nothing here is fatal. `<rev>:<path>` is a TREE path
      // (repo-root-relative), translated by the rev-parse `--show-prefix`
      // line (a leading `./` — tolerated by the path grammar — is dropped:
      // tree paths cannot contain a `.` segment, while the log pathspecs
      // above normalize it away).
      const show = await baselineGit(
        context,
        settings,
        cwd,
        ["show", `${sha}:${showPrefix}${stripLeadingDotSlash(baseline.path)}`],
        request.signal,
        startedAt,
      );
      if (show === undefined || show.exitCode !== 0) continue;
      if (show.stdout.length > DOORSTOP_BASELINE_BLOB_MAX) continue;
      candidates.push({ sha, blob: show.stdout });
    }
    return baselineResponse(true, source, candidates);
  });
}

/** Budget-bounded git runner for the read-only fetches: an exec failure of
 *  ANY kind (ENOENT, killed, host abort, exhausted budget) degrades to
 *  `undefined` — there is no error channel, so a missing candidate is
 *  always acceptable and the response must keep resolving in the contract
 *  shape. */
async function baselineGit(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  startedAt: number,
): Promise<ServerPluginExecFileResult | undefined> {
  if (remainingBudgetMs(startedAt) <= 0) return undefined;
  try {
    return await runGit(context, settings, cwd, args, signal, gitExecTimeoutMs(settings, startedAt));
  } catch {
    return undefined;
  }
}

/** The `doorstop.item-baseline` response literal, pinned to the contract
 *  shape (see doorstopRunResponse for the JsonValue idiom). */
function baselineResponse(
  git: boolean,
  source: DoorstopBaselineResponse["source"],
  candidates: readonly DoorstopBaselineCandidate[],
): JsonValue {
  return {
    git,
    source,
    // Each candidate is spread into a fresh object so the value admits the
    // host bridge's JsonObject index signature.
    candidates: candidates.map((candidate) => ({ ...candidate })),
  } satisfies DoorstopBaselineResponse;
}

/** Escape the TRUE basic-regex (BRE) metacharacters for interpolation into
 *  the git `--grep` pattern — `.`, `*`, `[`, `]`, `^`, `$`, `\` — the set
 *  whose escaped form is LITERAL in every regex engine (git's `--grep` runs
 *  basic regex by default). The GNU-extension characters `+ ? ( ) | { }`
 *  are deliberately NOT in the set: they are LITERAL in plain BRE, and
 *  their escaped forms are quantifiers/grouping/alternation/intervals
 *  (`\+` `\?` `\(` `\)` `\|` `\{` `\}`), so escaping them would FLIP
 *  semantics instead of literalizing — silently missing the conforming
 *  commit and degrading the baseline to the history fallback. `-` is
 *  likewise unescaped (literal in BRE outside a bracket expression, where
 *  escaping an ordinary character is undefined behavior across engines).
 *  Only `.` can occur in the UID alphabet today; the set keeps a future
 *  grammar widening safe. */
function escapeRegexMeta(value: string): string {
  return value.replace(/[.*\[\]^$\\]/g, "\\$&");
}

/** Wrap a workspace-relative item path as a LITERAL git pathspec — the
 *  `:(literal)` magic disables pathspec magic and glob expansion, so a
 *  path beginning with `:` (magic prefixes like `:!`, `:(glob)`, `:(top)`,
 *  `:(icase)`) or containing glob characters (`*?[`) can never widen the
 *  matched set beyond the one item file, and a literal `*` stays a literal
 *  `*` for a file that is really named that. The magic is followed by NO
 *  `/`: a `/` after `:(literal)` would re-anchor the pathspec to the repo
 *  root, silently breaking nested workspaces — cwd-relative resolution is
 *  exactly what the tree-path translation below (showPrefix) compensates
 *  for. Shell safety stays the `--` separator's job: the pathspec itself
 *  is argv (never a shell string), this function only makes its MEANING
 *  literal. */
function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

/** Drop a leading `./` from a workspace-relative path for use as a git TREE
 *  path (`<rev>:<path>`): tree paths are repo-root-relative and cannot
 *  contain a `.` segment, while git pathspecs (used by the log calls, where
 *  the path stays untransformed) normalize `./` away. The baseline path
 *  grammar tolerates `./` prefixes; the letter of the path must survive in
 *  both readings. */
function stripLeadingDotSlash(path: string): string {
  return path.replace(/^\.\//, "");
}

/** Resolve the workspace-relative path of the item file whose base name is
 *  `uid`, via a bounded shallow walk (the review request carries only the
 *  uid; the item path is the file name base, and Doorstop item formats are
 *  yaml/markdown only — `.yml`/`.yaml`/`.md` — with a case-insensitive
 *  extension check mirroring Doorstop's own `ext.lower()` validation).
 *  Deterministic first-hit order; duplicate UIDs across documents are a
 *  doorstop validation error, so the first match IS the item. Never throws:
 *  an unreadable directory or an exhausted walk budget simply finds nothing. */
async function findItemPath(root: string, uid: string): Promise<string | undefined> {
  let scanned = 0;
  const walk = async (directory: string, depth: number, relPath: string): Promise<string | undefined> => {
    if (scanned >= ITEM_PATH_WALK_MAX_ENTRIES || depth > ITEM_PATH_WALK_MAX_DEPTH) return undefined;
    scanned += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (scanned >= ITEM_PATH_WALK_MAX_ENTRIES) return undefined;
      scanned += 1;
      if (entry.isDirectory()) {
        if (!ITEM_PATH_WALK_SKIP_DIRS.has(entry.name)) {
          const childRel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
          const found = await walk(join(directory, entry.name), depth + 1, childRel);
          if (found !== undefined) return found;
        }
      } else if (entry.isFile() && itemFileBase(entry.name) === uid) {
        // Workspace-relative, forward-slash separated — the same path
        // syntax the browser's item.path uses and git pathspecs accept.
        return relPath === "" ? entry.name : `${relPath}/${entry.name}`;
      }
    }
    return undefined;
  };
  return walk(root, 0, "");
}

/** The item file base name for a file whose extension is a Doorstop item
 *  format extension (`.yml`/`.yaml`/`.md`, case-insensitive like Doorstop's
 *  own `ext.lower()` check); `undefined` for any other file. */
function itemFileBase(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot).toLowerCase();
  if (extension !== ".yml" && extension !== ".yaml" && extension !== ".md") return undefined;
  return name.slice(0, dot);
}

// ---------------------------------------------------------------------------
// Git status / stage / commit handlers (plan-add-git-actions.md Phase B
// steps 6–8) — the project-scoped git trio. All three reuse the
// review→commit infrastructure wholesale (runGit, runSerialized,
// literalPathspec, gitStepFailure, commitStderrExcerpt, the shared
// `startedAt` deadline budget); per-handler specifics live on each
// function below.
// ---------------------------------------------------------------------------

/**
 * The `doorstop.git-status` handler (plan step 6): repo check via
 * `rev-parse --is-inside-work-tree --show-prefix`, then `git status
 * --porcelain=v1 -z -b`, mapped onto the contract's `{ git, branch?,
 * ahead?, behind?, staged, dirty, files }` shape — the readout the
 * project-actions status strip renders. Read-only and BEST-EFFORT: ANY
 * failure (non-repo, killed exec, missing git binary, host abort,
 * exhausted budget) resolves `{ git: false, staged: 0, dirty: 0, files:
 * [] }` instead of rejecting — the response has no error channel (the
 * baseline handler's exact philosophy; `baselineGit` supplies the
 * never-reject runner). A host-attributed ABORT is deliberately NOT
 * rethrown here (unlike the stage/commit handlers): the readout is
 * best-effort and a cancelled fetch is a dropped view, not a lost
 * mutation — do not "fix" this into a rejection. Shares the per-workspace
 * serialization and the `startedAt` deadline budget.
 */
export async function requestDoorstopGitStatus(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_GIT_STATUS_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // Strict parse before any exec and before queueing.
  parseDoorstopGitStatusRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    // The `--show-prefix` line is unused by the status readout (porcelain
    // paths are cwd-relative when run from the workspace root); only the
    // work-tree check consumes it.
    const inWorkTree = await baselineGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
      request.signal,
      startedAt,
    );
    if (inWorkTree === undefined || !isWorkTreeResult(inWorkTree)) {
      return gitStatusResponse(false, undefined, undefined, undefined, 0, 0, []);
    }
    // `-z` NUL-separated records so filenames with spaces survive; `-b`
    // carries the branch line + ahead/behind. A failed porcelain exec
    // degrades identically — a missing readout is `no git`, never an error.
    const porcelain = await baselineGit(
      context,
      settings,
      cwd,
      ["status", "--porcelain=v1", "-z", "-b"],
      request.signal,
      startedAt,
    );
    if (porcelain === undefined || porcelain.exitCode !== 0) {
      return gitStatusResponse(false, undefined, undefined, undefined, 0, 0, []);
    }
    const parsed = parsePorcelainV1Status(porcelain.stdout);
    // The counts are computed from the FULL output; only `files` is capped
    // so the response stays bounded while the counts stay honest above it.
    return gitStatusResponse(
      true,
      parsed.branch,
      parsed.ahead,
      parsed.behind,
      parsed.staged,
      parsed.dirty,
      parsed.files.slice(0, DOORSTOP_GIT_STATUS_FILES_MAX),
    );
  });
}

/** The `doorstop.git-status` response literal, pinned to the contract shape
 *  (see doorstopRunResponse for the object-spread idiom).
 *  `branch`/`ahead`/`behind` are OMITTED when absent — the strict response
 *  parser couples them to `git: true`. */
function gitStatusResponse(
  git: boolean,
  branch: string | undefined,
  ahead: number | undefined,
  behind: number | undefined,
  staged: number,
  dirty: number,
  files: readonly DoorstopGitStatusFile[],
): JsonValue {
  return {
    git,
    ...(branch === undefined ? {} : { branch }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    staged,
    dirty,
    // Each file is spread into a fresh object so the value admits the host
    // bridge's JsonObject index signature.
    files: files.map((file) => ({ ...file })),
  } satisfies DoorstopGitStatusResponse;
}

/** One decoded `git status --porcelain=v1 -z -b` output — the branch header
 *  state plus every changed file's two-column pair. */
interface PorcelainV1Status {
  /** The current branch; absent on a detached HEAD (`HEAD (no branch)`). */
  branch?: string;
  /** Commits ahead of the upstream; absent without an upstream. */
  ahead?: number;
  /** Commits behind the upstream; absent without an upstream. */
  behind?: number;
  /** Every changed file, BEFORE the response's 200-file cap. */
  files: DoorstopGitStatusFile[];
  /** Count of files whose index (X) column is not unmodified/untracked/
   *  ignored — the changes a commit will record. */
  staged: number;
  /** Count of files with any non-unmodified state (either column). */
  dirty: number;
}

/** Decode porcelain v1 `-z -b` stdout into the contract's file states. The
 *  `-z` form NUL-terminates every record (the `## ` header included), so
 *  filenames with spaces survive untouched; a rename/copy prints its NEW
 *  path as an `XY <path>` record followed by a SEPARATE record holding the
 *  old (source) path, which is consumed here, never parsed as an entry of
 *  its own. The header decodes the branch and the `[ahead N, behind M]` /
 *  `[ahead N]` / `[behind M]` / `[gone]` suffixes; a detached HEAD
 *  (`HEAD (no branch)`) reports no branch, and an unborn branch
 *  (`No commits yet on <name>`) reports the name. */
function parsePorcelainV1Status(stdout: string): PorcelainV1Status {
  const output = stdout.split("\0");
  const records = output[output.length - 1] === "" ? output.slice(0, -1) : output;
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: DoorstopGitStatusFile[] = [];
  let staged = 0;
  let dirty = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (index === 0 && record.startsWith("## ")) {
      const header = parsePorcelainBranchHeader(record.slice(3));
      branch = header.branch;
      ahead = header.ahead;
      behind = header.behind;
      continue;
    }
    // Per-file: `XY <path>` — a single space separates the two state
    // columns in porcelain v1. The `s` flag lets `.*` span newlines inside
    // paths (records are NUL-delimited, never line-delimited).
    const entry = /^(.{2}) (.*)$/s.exec(record);
    if (entry === null) continue;
    const xCode = entry[1]?.[0];
    const yCode = entry[1]?.[1];
    const indexState = gitFileStateFromPorcelainXy(xCode);
    const workingTreeState = gitFileStateFromPorcelainXy(yCode);
    files.push({ path: entry[2] ?? "", index: indexState, workingTree: workingTreeState });
    // Staged = the changes a commit will record: the index column is
    // neither blank, untracked ('?'), nor ignored ('!') — the contract's
    // counting rule; `staged`/`dirty` count the FULL output, the response
    // caps only `files`.
    if (indexState !== "unmodified" && indexState !== "untracked" && indexState !== "ignored") {
      staged += 1;
    }
    if (indexState !== "unmodified" || workingTreeState !== "unmodified") {
      dirty += 1;
    }
    // A rename/copy `-z` entry is followed by a separate SOURCE-path record
    // — consumed, never parsed as an entry of its own.
    if (xCode === "R" || xCode === "C") index += 1;
  }
  // Optional fields are omitted, never set to undefined
  // (exactOptionalPropertyTypes).
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    files,
    staged,
    dirty,
  };
}

/** Map one porcelain v1 XY column character onto the contract's file-state
 *  vocabulary (the host git plugin's nine states, verbatim): the blank
 *  column → unmodified, `M` → modified, `T` (typechange — no enum state of
 *  its own) → modified, `A` → added, `D` → deleted, `R` → renamed, `C` →
 *  copied, `U` → conflicted, `?` → untracked, `!` → ignored. Only these
 *  ten characters can appear in a well-formed porcelain v1 XY pair; a
 *  defensive unknown maps to unmodified (nothing else is honest against
 *  the closed 9-state vocabulary). */
function gitFileStateFromPorcelainXy(code: string | undefined): DoorstopGitFileState {
  switch (code) {
    case "M":
    case "T":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return "unmodified"; // " " and any defensive unknown
  }
}

/** Decode the `## ` status header (with the prefix already stripped):
 *  `<branch>` (no upstream), `<branch>...<upstream>` with an
 *  `[ahead N, behind M]` / `[ahead N]` / `[behind M]` / `[gone]` suffix,
 *  `HEAD (no branch)` (detached — no branch), and `No commits yet on
 *  <branch>` (unborn). */
function parsePorcelainBranchHeader(header: string): { branch?: string; ahead?: number; behind?: number } {
  let branchPart = header;
  if (branchPart.startsWith("No commits yet on ")) {
    branchPart = branchPart.slice("No commits yet on ".length);
  }
  if (branchPart === "HEAD (no branch)" || branchPart === "HEAD") return {};
  const upstreamDot = branchPart.indexOf("...");
  const branch = upstreamDot === -1 ? branchPart : branchPart.slice(0, upstreamDot);
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstreamDot !== -1) {
    const bracket = /^.*\[(.*)\]$/.exec(branchPart.slice(upstreamDot + 3));
    if (bracket !== null && bracket[1] !== undefined) {
      for (const part of bracket[1].split(",")) {
        const aheadMatch = /^ahead (\d+)$/.exec(part.trim());
        const behindMatch = /^behind (\d+)$/.exec(part.trim());
        if (aheadMatch !== null) ahead = Number(aheadMatch[1]);
        if (behindMatch !== null) behind = Number(behindMatch[1]);
      }
    }
  }
  // Optional fields are omitted, never set to undefined
  // (exactOptionalPropertyTypes).
  return {
    branch,
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
  };
}

/** The request paths a stage's `-z` porcelain output still needs `git
 *  add`ed — every record whose WORKTREE (Y) column is non-blank, mapped
 *  back onto the request set (the pathspecs already constrain the porcelain
 *  to the request paths; the guard keeps the add set exactly them). A blank
 *  Y column means the worktree already matches the index — nothing to add,
 *  and a STAGED DELETION (`D `) must be skipped in particular: its path
 *  exists in NEITHER the index NOR the worktree, and `git add` on it
 *  aborts the WHOLE add with "did not match any files" (the idempotency
 *  break a second Stage-all click over an already-staged deletion would
 *  hit). Rename/copy records in `-z` mode print the NEW path followed by a
 *  SEPARATE bare record with the SOURCE path (`R  new\0old\0`): the source
 *  path is already fully recorded by the index (git mv) and adding it
 *  would fatal, so it is stepped past (the status parser's identical idiom)
 *  and only the record's own (new) path — when itself a request path — is
 *  staged. */
function stageAddTargets(stdout: string, paths: readonly string[]): string[] {
  const output = stdout.split("\0");
  const records = output[output.length - 1] === "" ? output.slice(0, -1) : output;
  const requestSet = new Set(paths);
  const targets = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const entry = /^(.{2}) (.*)$/s.exec(record);
    if (entry === null) continue;
    const xCode = entry[1]?.[0];
    const yCode = entry[1]?.[1];
    if (xCode === "R" || xCode === "C") index += 1;
    if (yCode === undefined || yCode === " ") continue;
    const path = entry[2] ?? "";
    if (requestSet.has(path)) targets.add(path);
  }
  return [...targets];
}

/**
 * The `doorstop.git-stage` handler — Stage all. Validates the request
 * BEFORE any exec and before queueing; then, each step budgeted and
 * skipped on exhaustion, inside `runSerialized`: a repo check, a `-z`
 * porcelain status over the literalized pathspecs, and `git add --
 * :(literal)<selected paths>` for exactly the REQUEST paths whose
 * worktree (Y) column is non-blank. The stage is IDEMPOTENT: an
 * already-staged entry is skipped, and a staged deletion (`D `) in
 * particular — its path exists in neither the index nor the worktree, and
 * re-adding it would abort the WHOLE add with "did not match any files" —
 * so a second Stage-all click over an already-staged deletion reports
 * `clean`, never a fatal add. The outcome is NARRATION (the Last run
 * status bar renders it): the response RESOLVES on every git outcome
 * (`skipped` for non-repo / exhausted budget, `failed` + bounded stderr
 * excerpt for a git error) and only a host-attributed ABORT rethrows.
 */
export async function requestDoorstopGitStage(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_GIT_STAGE_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // Strict parse before any exec and before queueing — an empty or
  // out-of-grammar path list never reaches git.
  const stage = parseDoorstopGitStageRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    try {
      if (remainingBudgetMs(startedAt) <= 0) return stageResponse("skipped");
      const inWorkTree = await runGit(
        context,
        settings,
        cwd,
        ["rev-parse", "--is-inside-work-tree"],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (!isWorkTreeResult(inWorkTree)) return stageResponse("skipped");

      // The porcelain fetch is `-z` — NUL-delimited records with VERBATIM
      // paths, the only format plain porcelain never re-quotes
      // (`core.quotePath` C-escapes non-ASCII, and spaces are always
      // quoted — either would silently drop such paths from the selection
      // below).
      if (remainingBudgetMs(startedAt) <= 0) return stageResponse("skipped");
      const pathspecs = stage.paths.map(literalPathspec);
      const status = await runGit(
        context,
        settings,
        cwd,
        ["status", "--porcelain", "-z", "--", ...pathspecs],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (status.exitCode !== 0) {
        gitStepFailure(status, ["status", "--porcelain", "-z", "--", ...pathspecs]);
      }
      // The add set is the REQUEST paths with a worktree change
      // (stageAddTargets; the narrated `staged` count is the selected
      // paths, never the raw record count).
      const addPaths = stageAddTargets(status.stdout, stage.paths);
      if (addPaths.length === 0) return stageResponse("clean");

      // git ≥ 2.x `add` stages removals for named paths too (a deleted
      // item file is staged for removal), and every selected path has a
      // real Y-column change, so this single add exec can never abort on a
      // pathspec that "did not match any files".
      if (remainingBudgetMs(startedAt) <= 0) return stageResponse("skipped");
      const add = await runGit(
        context,
        settings,
        cwd,
        ["add", "--", ...addPaths.map(literalPathspec)],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (add.exitCode !== 0) gitStepFailure(add, ["add", "--", ...addPaths.map(literalPathspec)]);
      return stageResponse("staged", addPaths.length);
    } catch (error) {
      // Any git failure collapses into the bounded `failed` outcome (the
      // response RESOLVES); a host-attributed ABORT rethrows untouched.
      if (request.signal.aborted) throw error;
      return stageResponse("failed", undefined, commitStderrExcerpt(formatUnknownError(error)));
    }
  });
}

/** The `doorstop.git-stage` response literal (see doorstopRunResponse for
 *  the JsonValue idiom); `staged`/`stderr` are OMITTED except on the status
 *  that declares them — the strict response parser's field/status coupling. */
function stageResponse(status: DoorstopGitStageResponse["status"], staged?: number, stderr?: string): JsonValue {
  return {
    status,
    ...(staged === undefined ? {} : { staged }),
    ...(stderr === undefined ? {} : { stderr }),
  } satisfies DoorstopGitStageResponse;
}

/**
 * The `doorstop.git-commit` handler — Commit. Validates the message (the
 * commit-message grammar) BEFORE any exec and before queueing — the
 * browser never sends an empty/whitespace-only message, so a malformed
 * message never reaches git — then, budgeted and inside `runSerialized`:
 * a repo check; `git diff --cached --quiet` (exit 0 → `clean`, exit 1 →
 * staged changes exist); `git commit -m <message>` with NO pathspec and
 * NO add — the commit records WHATEVER the staged index holds (Stage
 * all's paths, the user's own staged files, review-pipeline commits);
 * unstaged WIP is never swept in; and `git rev-parse --short HEAD` for
 * the `committed` sha, with the bracket-sha fallback when the lookup
 * fails after the commit landed. A failing pre-commit hook (its stderr
 * surfaces verbatim in the excerpt) or a missing `user.name`/`user.email`
 * identity both resolve as `failed`; only a host-attributed ABORT
 * rethrows.
 */
export async function requestDoorstopGitCommit(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_GIT_COMMIT_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // Strict parse before any exec and before queueing — an out-of-grammar
  // message never reaches git.
  const commitRequest = parseDoorstopGitCommitRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    try {
      if (remainingBudgetMs(startedAt) <= 0) return commitResponse({ status: "skipped" });
      const inWorkTree = await runGit(
        context,
        settings,
        cwd,
        ["rev-parse", "--is-inside-work-tree"],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (!isWorkTreeResult(inWorkTree)) {
        return commitResponse({ status: "skipped" });
      }

      // `git diff --cached --quiet` exits 0 (nothing staged) or 1 (staged
      // changes exist); any other exit — or a killed exec — is a real git
      // error, never "clean".
      if (remainingBudgetMs(startedAt) <= 0) return commitResponse({ status: "skipped" });
      const staged = await runGit(
        context,
        settings,
        cwd,
        ["diff", "--cached", "--quiet"],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (staged.exitCode === 0) return commitResponse({ status: "clean" });
      if (staged.exitCode !== 1) gitStepFailure(staged, ["diff", "--cached", "--quiet"]);

      // NO pathspec, NO add — the index is the content, whatever it holds;
      // the message travels as execFile argv (never a shell string), so no
      // quoting/injection concern here.
      if (remainingBudgetMs(startedAt) <= 0) return commitResponse({ status: "skipped" });
      const commit = await runGit(
        context,
        settings,
        cwd,
        ["commit", "-m", commitRequest.message],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      if (commit.exitCode !== 0) gitStepFailure(commit, ["commit", "-m", commitRequest.message]);

      // The commit ALREADY LANDED (step 3 exited 0): a failed/skipped sha
      // lookup must not narrate it `skipped`/`failed` — git itself printed
      // the short sha in its first stdout bracket, which becomes the
      // fallback.
      if (remainingBudgetMs(startedAt) <= 0) {
        const fallback = commitBracketSha(commit.stdout);
        return fallback === undefined
          ? commitResponse({ status: "skipped" })
          : commitResponse({ status: "committed", sha: fallback });
      }
      const head = await runGit(
        context,
        settings,
        cwd,
        ["rev-parse", "--short", "HEAD"],
        request.signal,
        gitExecTimeoutMs(settings, startedAt),
      );
      const fromHead = head.exitCode === 0 ? head.stdout.trim() : "";
      if (fromHead !== "") return commitResponse({ status: "committed", sha: fromHead });
      const fallback = commitBracketSha(commit.stdout);
      if (fallback !== undefined) return commitResponse({ status: "committed", sha: fallback });
      gitStepFailure(head, ["rev-parse", "--short", "HEAD"]);
    } catch (error) {
      // Any git failure collapses into the bounded `failed` outcome (the
      // response RESOLVES); a host-attributed ABORT rethrows untouched.
      if (request.signal.aborted) throw error;
      return commitResponse({ status: "failed", stderr: commitStderrExcerpt(formatUnknownError(error)) });
    }
  });
}

/** The `doorstop.git-commit` response literal — the review→commit
 *  {@link DoorstopCommitOutcome} shape reused verbatim (see
 *  doorstopRunResponse for the JsonValue idiom). */
function commitResponse(outcome: DoorstopCommitOutcome): JsonValue {
  // The spread yields a fresh object so the value admits the host bridge's
  // JsonObject index signature.
  return { ...outcome } satisfies DoorstopCommitOutcome;
}
