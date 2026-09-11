// ---------------------------------------------------------------------------
// Opendoor server-side request backend (plan-opendoor-server-plugin step 2 +
// plan-review-baseline-and-diff Phase B steps 5–7, chain E2 server half):
// the TWO request handlers (`doorstop.run` and `doorstop.item-baseline`)
// routed through `workspaceProvider.request`. The browser never sends shell
// strings or raw argv — it sends the STRUCTURED requests (doorstop-backend-
// contract.ts) and this module builds the argv, runs the doorstop CLI and
// (for the review→commit pipeline and the baseline fetch) git through the
// host-bounded `context.execFile`, and returns the validated response shapes
// as `JsonValue` (the browser re-parses them with the contract parsers).
//
// Error taxonomy (mirrors plan §"Error taxonomy"): malformed input (unknown
// op, invalid UID/publish-target grammar) throws BEFORE any exec — and before
// the workspace run queue (a malformed request never parks behind a slow
// run); a spawn ENOENT maps to the "CLI not found" message; the CLI running
// to ANY exit code (incl. validate's exit 1) RESOLVES with the response —
// findings are output, not an infrastructure error; a killed run resolves
// with `signal !== null` and partial output preserved; truncated streams pass
// through as flags (deliberately NOT the git throw-on-truncation idiom —
// display wants partial content); host-attributed failures (exec timeout,
// callback abort) rethrow untouched — the host owns the process kill and the
// error.
//
// Exec shape adaptation: the plan's sketch assumed a positional
// `execFile(file, args, …)`; the real host API takes ONE request object
// (`ServerPluginExecFileRequest`) and `signal` is a REQUIRED field that must
// be forwarded per invocation — this module always forwards `request.signal`
// and never retains it.
//
// Per-workspace serialization: doorstop CLI runs are not concurrency-safe
// (no file locking — two concurrent runs in one checkout can corrupt the
// YAML/HTML artifacts), so concurrent `request()` calls for the same
// `workspace.path` are chained. The queue map is ACTIVATION-SCOPED: a
// module-level `WeakMap` keyed by the frozen activation context object gives
// each activation its own `Map<string, Promise<void>>` (entries die with the
// context), and each per-workspace entry self-cleans once the run settles
// with no successor chained — the activation never accumulates settled
// promises.
//
// Settings: `context.settings` (host `plugins.opendoor.settings`, captured at
// sessiond startup) is parsed LENIENTLY as `{ doorstopPath?: string,
// gitPath?: string, timeoutMs?: number }` — wrong types fall back to
// defaults silently, never throw (the sessiond config is a startup snapshot,
// not a request payload). A configured `timeoutMs` may SHORTEN the default
// but never exceed it: a longer value would cross the ~10 s host callback
// bound, letting the host abort the whole callback instead of opendoor
// returning its own structured killed/timeout result — which is the reason
// the default exists.
//
// Review→commit pipeline (plan step 5): a review request carrying the
// browser's opt-in `commit: true` runs the review first and, ONLY on a clean
// exit 0, records a pathspec-limited git commit of the item file (the
// pathspecs are LITERALIZED with git's `:(literal)` magic so a path can never
// widen the matched set beyond the one item file) with the pinned conforming
// message `doorstop: review <uid>` (the item-baseline grep anchors on
// exactly that string). The whole pipeline — the doorstop exec plus up to 5
// git execs — shares one `startedAt` deadline budget
// (PIPELINE_DEADLINE_BUDGET_MS, headroom under the ~10 s host callback
// bound); every exec gets `min(settings.timeoutMs, remaining)` and an
// exhausted budget skips the git phase with `status: "skipped"`. The commit
// outcome is narration: a failed/skipped commit leaves the review result
// standing and the response RESOLVES (the outcome's contract JSDoc pins
// this — same philosophy as the truncation flags). git runs through the
// same `context.execFile` shape on `settings.gitPath` with the git plugin's
// `GIT_*` unset-env hygiene.
//
// Baseline handler (plan step 6): `doorstop.item-baseline` locates the
// reviewed version of an item file in git history (conforming-message grep,
// generic history fallback — both pathspecs literalized identically) and
// returns the `{ git, source, candidates }` shape — read-only and
// best-effort, never an infrastructure error (the contract response has no
// error channel).
// ---------------------------------------------------------------------------

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
  DOORSTOP_RUN_OPERATION,
  isValidDoorstopItemPath,
  parseDoorstopBaselineRequest,
  parseDoorstopRunRequest,
  type DoorstopBaselineCandidate,
  type DoorstopBaselineResponse,
  type DoorstopCommitOutcome,
  type DoorstopRunRequest,
  type DoorstopRunResponse,
} from "./doorstop-backend-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";

/** Default command name resolved by the sessiond host PATH. */
const DEFAULT_DOORSTOP_COMMAND = "doorstop";
/** Default git command name resolved by the sessiond host PATH. */
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

/** Activation-scoped serialization: context object → per-workspace run queues. */
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

/** Handle one `workspaceProvider.request` call routed here with operation
 *  `doorstop.run`: validate, queue, exec, map — and, for a review request
 *  carrying the opt-in `commit: true` flag, run the review→commit git
 *  pipeline afterwards. (The operation dispatch in server-plugin.ts routes;
 *  this guard keeps DIRECT calls pinned to the run contract.) */
export async function requestDoorstopBackend(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_RUN_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // STRICT parse before any exec AND before queueing (git-contract grammar:
  // junk of any kind throws; extra keys tolerated for forward compat).
  const run = parseDoorstopRunRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    // The deadline budget anchors the WHOLE pipeline (review + git): record
    // `startedAt` first; every exec — doorstop included — gets
    // `min(settings.timeoutMs, remaining)`.
    const startedAt = Date.now();
    const result = await runDoorstop(
      context,
      settings,
      cwd,
      doorstopArgv(run),
      request.signal,
      Math.min(settings.timeoutMs, remainingBudgetMs(startedAt)),
    );
    // Review→commit: when the REQUEST asked for a commit (the browser's
    // opt-in `commitAfterReview` setting), a clean-exit review is followed
    // by the git pipeline; the `commit` outcome field is ABSENT otherwise,
    // mirroring the response parser's omission. A failed review (exit ≠ 0,
    // or killed — exitCode null) must NEVER be committed: the outcome is
    // `skipped` and git never runs at all.
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
 *  doorstop-panel-elements.ts exactly (bare `doorstop` validates; publish is
 *  always `publish all <target>`; clear takes the multi-parent form). */
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
 * always forwarded. The `timeoutMs` parameter hands the deadline-budget
 * control to the caller (defaults to `settings.timeoutMs` — 8.5 s, headroom
 * under the 10 s host callback bound — and is budgeted DOWN inside the
 * review→commit pipeline). Errors: ENOENT (spawn could not resolve the
 * binary) maps to the "CLI not found" message; anything else is
 * host-attributed (exec timeout kill, callback abort) and rethrows
 * untouched.
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
 * the validated request, the exec fields verbatim (incl. the truncation
 * flags and a possibly-killed `exitCode: null` / `signal` pair), and the
 * measured `durationMs`. Built as an object LITERAL so the strict
 * `parseDoorstopRunResponse` sees the exact server output shape; `satisfies`
 * keeps it pinned to the contract without widening. (The declared return is
 * `JsonValue` — the host bridge type — rather than the `DoorstopRunResponse`
 * interface, because a named interface lacks the implicit index signature
 * `JsonObject` requires.)
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
    // The optional outcome is omitted unless the pipeline produced one
    // (exactOptionalPropertyTypes — a response without `commit` must not
    // carry the key at all; the contract parser mirrors that asymmetry).
    // The spread `{ ...commit }` yields a fresh object so the value admits
    // the host bridge's JsonObject index signature (the interface itself
    // lacks it); `satisfies` keeps the shape pinned to the contract.
    ...(commit === undefined ? {} : { commit: { ...commit } }),
  } satisfies DoorstopRunResponse;
}

/** Serialize all runs for ONE workspace.path within ONE activation. */
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

/** Lenient settings parse (wrong types fall back to defaults silently; a
 *  configured `timeoutMs` is clamped to the default ceiling). */
function parseDoorstopBackendSettings(settings: JsonObject): DoorstopBackendSettings {
  const configuredPath = settings["doorstopPath"];
  const doorstopPath =
    typeof configuredPath === "string" && configuredPath !== "" ? configuredPath : DEFAULT_DOORSTOP_COMMAND;
  // `gitPath` mirrors the doorstopPath idiom exactly: a non-empty string is
  // honored, anything else falls back to "git" silently — type-only, NO path
  // validation (a host PATH lookup resolves the default; an absolute path is
  // the user's responsibility, same as doorstopPath).
  const configuredGitPath = settings["gitPath"];
  const gitPath =
    typeof configuredGitPath === "string" && configuredGitPath !== "" ? configuredGitPath : DEFAULT_GIT_COMMAND;
  const configuredTimeout = settings["timeoutMs"];
  const timeoutMs =
    typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? // Config may SHORTEN the default timeout, never exceed the ceiling: a
        // value above the default would cross the ~10 s host callback bound,
        // so the host would abort the whole callback instead of opendoor
        // returning its own structured killed/timeout result — the reason the
        // 8 500 ms default exists.
        Math.min(configuredTimeout, DEFAULT_DOORSTOP_TIMEOUT_MS)
      : DEFAULT_DOORSTOP_TIMEOUT_MS;
  return { doorstopPath, gitPath, timeoutMs };
}

/** Whether `error` is a Node spawn ENOENT (`error.code === "ENOENT"`). */
function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The provider's unsupported-operation error — shared by the dispatcher in
 *  server-plugin.ts and the run handler's own guard, so the message text
 *  cannot drift between the two. */
export function unsupportedBackendOperationError(operation: string): Error {
  return new Error(`opendoor: unsupported workspace backend operation: ${operation}`);
}

/** Milliseconds left in the pipeline deadline budget since `startedAt`. */
function remainingBudgetMs(startedAt: number): number {
  return PIPELINE_DEADLINE_BUDGET_MS - (Date.now() - startedAt);
}

/** Per-exec timeout under the deadline budget: `min(settings.timeoutMs,
 *  remaining)` with a 1 ms floor so a non-positive remainder can never reach
 *  the host (callers check `remainingBudgetMs > 0` first and skip). */
function gitExecTimeoutMs(settings: DoorstopBackendSettings, startedAt: number): number {
  return Math.max(1, Math.min(settings.timeoutMs, remainingBudgetMs(startedAt)));
}

/** Bound a failed outcome's stderr to the ~2 KiB echo cap, with a truncation
 *  marker so the Last run narration never hides that content was cut. */
function commitStderrExcerpt(stderr: string): string {
  return stderr.length > COMMIT_STDERR_EXCERPT_LIMIT
    ? `${stderr.slice(0, COMMIT_STDERR_EXCERPT_LIMIT)}\n… (stderr truncated)`
    : stderr;
}

/** Internal `context.execFile` wrapper for git: `file` resolves from
 *  settings (`gitPath`, default "git"), the same call shape as runDoorstop
 *  (cwd = the host-validated workspace path, per-invocation signal always
 *  forwarded, hygiene via the git plugin's `GIT_*` unset list), and a
 *  deadline-budgeted `timeoutMs`. Errors: ENOENT (spawn could not resolve
 *  the git binary) maps to the "git not found" message; the review→commit
 *  pipeline folds that message (and every other throw) into the `failed`
 *  commit outcome, and the baseline handler degrades it to an empty
 *  candidate set. */
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

/** The review→commit git phase (plan step 5): after `doorstop review <uid>`
 *  exited 0, record the item file's new state as ONE pathspec-limited
 *  conforming commit. Every exec shares the pipeline's `startedAt` deadline
 *  budget and forwards the per-invocation signal; an exhausted budget skips
 *  the phase (`skipped`), an already-committed file is `clean`, and ANY git
 *  failure collapses into `{ status: "failed", stderr }` — the review
 *  succeeded and its result stands, so the caller still returns the
 *  successful run response with this outcome attached (contract pin: the
 *  outcome is narration, not infrastructure error).
 *
 * Exec order: rev-parse (repo check) → item-path walk (uid → file) →
 * status → add → commit → rev-parse --short HEAD. */
async function reviewCommitPipeline(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  uid: string,
  signal: AbortSignal,
  startedAt: number,
): Promise<DoorstopCommitOutcome> {
  try {
    // Deadline: if the review consumed the budget, the git phase is SKIPPED
    // (status `skipped`) — the commit is narration, never a second chance
    // to hold the host callback hostage.
    if (remainingBudgetMs(startedAt) <= 0) return { status: "skipped" };
    const inWorkTree = await runGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      signal,
      gitExecTimeoutMs(settings, startedAt),
    );
    // Not a git repository (non-zero exit or empty output) → nothing to
    // commit; the browser still sees the review result.
    if (inWorkTree.exitCode !== 0 || inWorkTree.stdout.trim() === "") return { status: "skipped" };

    // The item file path: resolved by a bounded workspace walk (the request
    // carries only the uid; the item file is named after it), then passed
    // through the SAME safe-relative-path rule the baseline request paths
    // satisfy (isValidDoorstopItemPath) — a pathspec the rule rejects can
    // never reach git. A file the review just rewrote must exist; an
    // unresolvable path simply means nothing to commit (skipped, honest —
    // the outcome has no "item not found" status).
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
    // Empty porcelain output → the item file is already committed with no
    // working-tree change (e.g. a review re-marking an unchanged item).
    // Known edge, documented not "fixed": an IGNORED item file also prints
    // nothing (plain porcelain hides ignored files), so it reports `clean`
    // while its content was never committed — the later baseline then
    // honestly reports `none`, and the contract has no "ignored" status;
    // a gitignored item file is a misconfiguration, not a pipeline concern.
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
    if (commit.exitCode !== 0) gitStepFailure(commit, ["commit", "-m", `doorstop: review ${uid}`, "--", literalPathspec(itemPath)]);
    // The message format is PINNED (contract + plan step 5): the
    // item-baseline grep matches `^doorstop: review <uid>$` against exactly
    // this string — any drift silently breaks the fast baseline path.

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
    // Any git failure — a non-zero exit, a killed exec, or a missing git
    // binary (ENOENT → the "git not found" message) — collapses into the
    // bounded `failed` outcome. The response still RESOLVES: the review
    // succeeded and its result stands (the contract JSDoc pins this
    // narration semantics). A host-attributed ABORT is the exception: it
    // rethrows untouched (module header taxonomy) — an aborted callback
    // must surface as a rejection like every other host-attributed
    // failure, and a cancelled callback has no consumer for a resolved
    // narration.
    if (signal.aborted) throw error;
    return { status: "failed", stderr: commitStderrExcerpt(formatUnknownError(error)) };
  }
}

/**
 * The `doorstop.item-baseline` handler (plan step 6): locate the reviewed
 * version of an item file in git history — the cheap conforming-message
 * grep (`^doorstop: review <uid>$`, capped at DOORSTOP_BASELINE_GREP_LIMIT)
 * with the generic history walk as fallback (capped at DOORSTOP_BASELINE_
 * HISTORY_LIMIT) — and return the `{ git, source, candidates }` contract
 * shape. Read-only and BEST-EFFORT: a non-repo resolves `{ git: false }`, a
 * broken log/show step degrades to fewer candidates, an oversize blob is
 * skipped — never an infrastructure error (the contract response has no
 * error channel, so the browser never sees a baseline fetch "fail"). Shares
 * the run handler's per-workspace serialization and the same `startedAt`
 * deadline budget (plan: same deadline budget idiom).
 */
export async function requestDoorstopBaseline(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  // Same operation guard as the run handler (the server-plugin dispatcher
  // routes by operation; this keeps DIRECT calls pinned to the baseline
  // contract — a mismatched operation is rejected before any exec).
  if (request.operation !== DOORSTOP_BASELINE_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // STRICT parse before any exec AND before queueing (same as the run
  // handler): a malformed baseline request never reaches git.
  const baseline = parseDoorstopBaselineRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    // Not a git repository → the contract's `{ git: false }` shape (the
    // browser shows the "No git history" notice). ANY rev-parse failure —
    // non-zero exit in a bare/absent repo, a missing git binary, a killed
    // exec — maps here: the baseline response has no error channel.
    const inWorkTree = await baselineGit(
      context,
      settings,
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
      request.signal,
      startedAt,
    );
    if (inWorkTree === undefined || inWorkTree.exitCode !== 0 || inWorkTree.stdout.trim() === "") {
      return baselineResponse(false, "none", []);
    }
    // The rev-parse second line is the cwd→repo-root prefix ("sub/dir/",
    // empty at the root): the `git show <sha>:<path>` TREE path below is
    // repo-root-relative while the browser's `path` is cwd-relative, so the
    // show path is translated by prepending this prefix (identical when the
    // workspace IS the repo root — the common case). Splitting is safe for
    // the single-line prefix grammar; a missing line degrades to "".
    const showPrefix = inWorkTree.stdout.split(/\r?\n/)[1] ?? "";

    // Fast path: the pinned conforming review-commit message. The uid is
    // escaped against the true basic-regex (BRE) metacharacters (only `.`
    // can occur in the UID alphabet today; the escape keeps the validator
    // and the grep decoupled), and the BRE `^…$` anchors defeat the
    // REQ001-matches-REQ0012 substring trap that `--fixed-strings` cannot.
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
      // history missed the conforming message): a plain
      // `git log --max-count=HISTORY_LIMIT` over the item path — the
      // browser still finds the reviewed version by stamp-matching the
      // blobs.
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
      // oversize blob (DOORSTOP_BASELINE_BLOB_MAX — the browser could never
      // stamp-match it anyway), or a budget/tool failure all merely SKIP
      // the candidate — nothing here is fatal.
      // `<rev>:<path>` is a TREE path (repo-root-relative): the show path
      // is the browser's cwd-relative `path` translated by the rev-parse
      // `--show-prefix` line (a leading `./` — tolerated by the path
      // grammar — is dropped: tree paths cannot contain a `.` segment,
      // while the log pathspecs above normalize it away). The log
      // pathspecs stay cwd-relative, so the two sides agree whether or not
      // the workspace is the repo root, and a nested workspace no longer
      // degrades to zero candidates.
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

/** Budget-bounded git runner for the baseline fetch: an exec failure of ANY
 *  kind (ENOENT, killed, host abort, exhausted budget) degrades to
 *  `undefined` — the read-only fetch has no error channel, so a missing
 *  candidate is always acceptable and the response must keep resolving in
 *  the contract shape. */
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
 *  shape (the host bridge type is `JsonValue`; see doorstopRunResponse). */
function baselineResponse(
  git: boolean,
  source: DoorstopBaselineResponse["source"],
  candidates: readonly DoorstopBaselineCandidate[],
): JsonValue {
  return {
    git,
    source,
    // Each candidate is spread into a fresh object so the values admit the
    // host bridge's JsonObject index signature (the interface-typed
    // elements themselves lack it); the `satisfies` keeps the whole shape
    // pinned to the contract.
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
      // Unreadable directory: its subtree is invisible (probe idiom).
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
