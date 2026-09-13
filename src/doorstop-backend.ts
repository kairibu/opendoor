// ---------------------------------------------------------------------------
// Opendoor server-side request backend (plan-opendoor-server-plugin step 2 +
// plan-review-baseline-and-diff Phase B steps 5–7, chain E2 server half +
// plan-add-git-actions.md Phase B steps 6–8, chain E2 server half): the
// FIVE request handlers — `doorstop.run`, `doorstop.item-baseline`, and the
// project-scoped git trio `doorstop.git-status` / `doorstop.git-stage` /
// `doorstop.git-commit` — routed through `workspaceProvider.request`. The
// browser never sends shell strings or raw argv — it sends the STRUCTURED
// requests (doorstop-backend-contract.ts) and this module builds the argv,
// runs the doorstop CLI and (for the review→commit pipeline, the baseline
// fetch, and the git trio) git through the host-bounded `context.execFile`,
// and returns the validated response shapes as `JsonValue` (the browser
// re-parses them with the contract parsers).
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
//
// Git actions trio (plan-add-git-actions.md Phase B steps 6–8): the
// project-scoped `doorstop.git-status` readout (read-only and best-effort,
// the baseline handler's exact philosophy — any failure degrades to
// `{ git: false }`), the `doorstop.git-stage` Stage-all run (repo check →
// a `-z` porcelain status over the literalized Doorstop paths (VERBATIM
// paths; the only plain-porcelain form that never re-quotes — a `M <path>`
// selection would silently drop non-ASCII/space paths) → `git add --
// :(literal)…` for the worktree-changed subset), and the
// `doorstop.git-commit` run (`git diff --cached --quiet` → `git commit -m
// <message>` with NO pathspec and NO add — the staged index is the
// content, whatever it holds → `rev-parse --short HEAD`). Both runs are
// MUTATING and narrate their outcome (reusing `DoorstopCommitOutcome` for
// commit); all three reuse the review→commit infra — `runGit` (`GIT_*`
// hygiene, `settings.gitPath`), `runSerialized` (per-workspace
// serialization), the shared `startedAt` deadline budget,
// `literalPathspec`, `gitStepFailure`, and `commitStderrExcerpt` — and
// resolve on every git outcome, rejecting only for a host-attributed abort.
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
    // Not a git repository (non-zero exit, or stdout other than a literal
    // `true` — a bare repo/`.git` prints `false` with EXIT 0) → nothing to
    // commit; the browser still sees the review result.
    if (!isWorkTreeResult(inWorkTree)) return { status: "skipped" };

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
    if (inWorkTree === undefined || !isWorkTreeResult(inWorkTree)) {
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

// ---------------------------------------------------------------------------
// Git status / stage / commit handlers (plan-add-git-actions.md Phase B
// steps 6–8): the project-scoped git trio served to the Requirements
// panel's project-actions group. All three reuse the review→commit
// infrastructure wholesale — runGit (GIT_* hygiene, settings.gitPath,
// deadline-budgeted timeout), runSerialized (per-workspace serialization,
// never racing a doorstop CLI run), literalPathspec (:(literal) magic),
// gitStepFailure, commitStderrExcerpt, and the shared `startedAt` budget.
//
//   doorstop.git-status  read-only and BEST-EFFORT (the baseline handler's
//                        philosophy): any failure — non-repo, killed exec,
//                        missing binary, exhausted budget — degrades to
//                        the `{ git: false }` contract shape; the response
//                        has no error channel, so the strip never sees a
//                        fetch "fail".
//   doorstop.git-stage   a MUTATING run (Stage all): repo check → `-z`
//                        porcelain over the literalized Doorstop paths
//                        (no worktree-column change → `clean`) → `git add
//                        -- :(literal)<worktree-changed paths>` (git ≥ 2.x
//                        stages named-path deletions too; an
//                        already-staged deletion is SKIPPED — its path
//                        exists in neither index nor worktree, re-adding
//                        it would abort the whole add). Outcome is
//                        narration — `skipped` on non-repo / exhausted
//                        budget, `failed` + bounded stderr excerpt on any
//                        git error, both resolving; only a host-attributed
//                        ABORT rethrows (module header taxonomy).
//   doorstop.git-commit  a MUTATING run (Commit): repo check → `git diff
//                        --cached --quiet` (exit 0 → `clean`) → `git commit
//                        -m <message>` (NO pathspec, NO add — the staged
//                        index is the content, whatever it holds) → `git
//                        rev-parse --short HEAD`. The outcome reuses
//                        {@link DoorstopCommitOutcome} verbatim; same
//                        failure taxonomy as stage.
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
  // Same operation guard as the run/baseline handlers (the server-plugin
  // dispatcher routes by operation; this keeps DIRECT calls pinned to the
  // status contract — a mismatched operation is rejected before any exec).
  if (request.operation !== DOORSTOP_GIT_STATUS_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // STRICT parse before any exec AND before queueing (the run/baseline
  // idiom): the status request is `{}` by contract; junk throws.
  parseDoorstopGitStatusRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    // Repo check. The `--show-prefix` line is unused by the status readout
    // (porcelain paths are cwd-relative when run from the workspace root);
    // the trigger is the `--is-inside-work-tree` exit code/output.
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
    // The porcelain fetch (`-v1` v1 format, `-z` NUL-separated records so
    // filenames with spaces survive, `-b` branch line + ahead/behind). A
    // failed porcelain exec (killed/abort/ENOENT) degrades identically — a
    // missing readout is `no git`, never an error.
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
    // at DOORSTOP_GIT_STATUS_FILES_MAX so the response stays bounded while
    // the counts stay honest above the cap (contract JSDoc).
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
 *  (the host bridge type is `JsonValue`; see doorstopRunResponse for the
 *  object-spread idiom). `branch`/`ahead`/`behind` are OMITTED when absent
 *  (exactOptionalPropertyTypes — the strict response parser couples them to
 *  `git: true`). */
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
    // Each file is spread into a fresh object so the values admit the host
    // bridge's JsonObject index signature (the interface-typed elements
    // themselves lack it); `satisfies` keeps the whole shape pinned.
    files: files.map((file) => ({ ...file })),
  } satisfies DoorstopGitStatusResponse;
}

/** One decoded `git status --porcelain=v1 -z -b` output — the branch header
 *  state plus every changed file's two-column pair. Purely a pure function
 *  of the stdout: unit-testable without any exec. */
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
  // `-z` NUL-terminates every record, leaving one trailing empty string.
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
    // Header: the FIRST record, present only with `-b`.
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
    if (entry === null) continue; // defensive: no XY + space shape
    const xCode = entry[1]?.[0];
    const yCode = entry[1]?.[1];
    const indexState = gitFileStateFromPorcelainXy(xCode);
    const workingTreeState = gitFileStateFromPorcelainXy(yCode);
    files.push({ path: entry[2] ?? "", index: indexState, workingTree: workingTreeState });
    // Staged = the changes a commit will record: the index column is
    // neither blank (' ' → unmodified), untracked ('?'), nor ignored ('!')
    // — the contract's counting rule. `staged`/`dirty` count the FULL
    // output; the response caps only `files`.
    if (indexState !== "unmodified" && indexState !== "untracked" && indexState !== "ignored") {
      staged += 1;
    }
    if (indexState !== "unmodified" || workingTreeState !== "unmodified") {
      dirty += 1;
    }
    // A rename/copy `-z` entry is followed by a separate record with the
    // SOURCE path — consumed here, never parsed as an entry of its own.
    if (xCode === "R" || xCode === "C") index += 1;
  }
  // Optional fields are omitted, never set to undefined
  // (exactOptionalPropertyTypes — the git-contract idiom).
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
  // Unborn branch: git prints `No commits yet on <name>` instead of <name>.
  if (branchPart.startsWith("No commits yet on ")) {
    branchPart = branchPart.slice("No commits yet on ".length);
  }
  // Detached HEAD: `HEAD (no branch)` — the readout renders the sha
  // instead of a branch name, so no `branch` is reported (absent).
  if (branchPart === "HEAD (no branch)" || branchPart === "HEAD") return {};
  const upstreamDot = branchPart.indexOf("...");
  const branch = upstreamDot === -1 ? branchPart : branchPart.slice(0, upstreamDot);
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstreamDot !== -1) {
    // The bracket suffix is `[ahead N, behind M]` (a single side when the
    // other is zero) or `[gone]` (upstream deleted — no counts).
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
  // (exactOptionalPropertyTypes — the git-contract idiom).
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
 *  staged. Pure function of stdout — unit-testable without any exec. */
function stageAddTargets(stdout: string, paths: readonly string[]): string[] {
  const output = stdout.split("\0");
  // `-z` NUL-terminates every record, leaving one trailing empty string.
  const records = output[output.length - 1] === "" ? output.slice(0, -1) : output;
  const requestSet = new Set(paths);
  const targets = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    // Per-file record: `XY <path>` — one space separates the two state
    // columns in porcelain v1. The `s` flag lets `.*` span newlines inside
    // paths (records are NUL-delimited, never line-delimited).
    const entry = /^(.{2}) (.*)$/s.exec(record);
    if (entry === null) continue; // defensive: no XY + space shape
    const xCode = entry[1]?.[0];
    const yCode = entry[1]?.[1];
    // A rename/copy record is followed by the bare SOURCE path record
    // (`R  new\0old\0`); step past it before it can masquerade as an
    // entry (parsePorcelainV1Status's identical consume idiom).
    if (xCode === "R" || xCode === "C") index += 1;
    // Blank worktree column → the worktree matches the index (or the path
    // is a staged deletion) → nothing to add.
    if (yCode === undefined || yCode === " ") continue;
    const path = entry[2] ?? "";
    if (requestSet.has(path)) targets.add(path);
  }
  return [...targets];
}

/**
 * The `doorstop.git-stage` handler (plan step 7) — Stage all. Validates the
 * request (a NON-EMPTY array of literal-grammar Doorstop paths) BEFORE any
 * exec and before queueing, then — each step budgeted and skipped on
 * exhaustion, inside `runSerialized` — a repo check, a `-z` porcelain
 * status over the literalized pathspecs (no entry with a worktree-column
 * change → `clean`: every Doorstop-managed file already matches
 * index/HEAD, nothing to stage), and `git add -- :(literal)<selected
 * paths>` for exactly the REQUEST paths whose porcelain Y (worktree)
 * column is non-blank (git ≥ 2.x `add` stages named-path deletions too, so
 * a deleted item file is staged for removal). An already-staged entry is
 * SKIPPED — a staged deletion (`D `) in particular: its path exists in
 * neither the index nor the worktree, and re-adding it would abort the
 * WHOLE add with "did not match any files" (the stage's idempotency
 * promise: "Stage all is idempotent, and cheap to repeat" — a second
 * click over an already-staged deletion reports `clean`, never a fatal
 * add). The response's `staged` count narrates the SELECTED paths (what
 * the add covered), never the raw record count. The outcome is NARRATION
 * (Stage all is a mutating run — the Last run status bar renders it): the
 * response RESOLVES on every git outcome — `skipped` for non-repo /
 * exhausted budget, `failed` + bounded stderr excerpt for a git error,
 * both folded by the catch — and only a host-attributed ABORT rethrows
 * (the reviewCommitPipeline catch's exact taxonomy).
 */
export async function requestDoorstopGitStage(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_GIT_STAGE_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // STRICT parse before any exec AND before queueing (the run/baseline
  // idiom): an empty or out-of-grammar path list never reaches git.
  const stage = parseDoorstopGitStageRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    try {
      // 1. Repo check — a non-repo workspace has nothing to stage.
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

      // 2. What actually changed among the managed paths: every path is
      // LITERALIZED (`:(literal)` magic — a crafted path can never widen
      // the matched set beyond the Doorstop files). The porcelain fetch is
      // `-z` — NUL-delimited records with VERBATIM paths, the only format
      // plain porcelain never re-quotes (`core.quotePath` C-escapes
      // non-ASCII, and spaces are always quoted — either would silently
      // drop such paths from the selection below). No entry with a
      // WORKTREE (Y-column) change → every managed file already matches
      // index/HEAD: `clean`, no add.
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
      // The add set is the REQUEST paths with a worktree change (the paths
      // are in the output — parsed back verbatim; stageAddTargets). An
      // entry whose Y column is blank needs no add, and a STAGED DELETION
      // (`D `) must be skipped in particular: its path exists in NEITHER
      // the index NOR the worktree, and `git add` on it aborts the WHOLE
      // add with "did not match any files" — exactly the idempotency break
      // a second Stage-all click over an already-staged deletion would hit
      // ("Stage all is idempotent, and cheap to repeat" is the plan's
      // promise). The narrated `staged` count is the SELECTED paths (what
      // the add covers), never the raw record count — a re-click on an
      // already-staged set reports `clean`.
      const addPaths = stageAddTargets(status.stdout, stage.paths);
      if (addPaths.length === 0) return stageResponse("clean");

      // 3. Stage them: `git add -- <literal selected paths>` —
      // modifications, additions, AND deletions (git ≥ 2.x `add` stages
      // removals for named paths, so a deleted item file is staged for
      // removal too). Every selected path has a real Y-column change (it
      // exists in the index or the worktree), so this single add exec can
      // never abort on a pathspec that "did not match any files".
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
      // Any git failure — a non-zero exit, a killed exec, or a missing git
      // binary (ENOENT → the "git not found" message) — collapses into the
      // bounded `failed` outcome; the response RESOLVES (narration). A
      // host-attributed ABORT rethrows untouched (module header taxonomy).
      if (request.signal.aborted) throw error;
      return stageResponse("failed", undefined, commitStderrExcerpt(formatUnknownError(error)));
    }
  });
}

/** The `doorstop.git-stage` response literal, pinned to the contract shape
 *  (see doorstopRunResponse for the JsonValue idiom). `staged`/`stderr`
 *  are OMITTED except on the status that declares them — the strict
 *  response parser's field/status coupling. */
function stageResponse(status: DoorstopGitStageResponse["status"], staged?: number, stderr?: string): JsonValue {
  return {
    status,
    ...(staged === undefined ? {} : { staged }),
    ...(stderr === undefined ? {} : { stderr }),
  } satisfies DoorstopGitStageResponse;
}

/**
 * The `doorstop.git-commit` handler (plan step 8) — Commit. Validates the
 * message (the commit-message grammar: non-blank, single line, ≤ 2 000
 * chars) BEFORE any exec and before queueing — the browser never sends an
 * empty/whitespace-only message (git would open `$EDITOR` and hang the
 * exec), so a malformed message never reaches git — then, budgeted and in
 * `runSerialized`: a repo check; `git diff --cached --quiet` (exit 0 →
 * nothing staged → `clean`; exit 1 → staged changes exist → proceed; any
 * other exit or a killed exec → a real git error, never "clean");
 * `git commit -m <message>` with NO pathspec and NO add — the commit
 * records WHATEVER the staged index holds (Stage all's paths, the user's
 * own staged files, review-pipeline commits); unstaged WIP is never swept
 * in; and `git rev-parse --short HEAD` for the `committed` sha — a
 * rev-parse that fails or is skipped AFTER the commit landed falls back to
 * the short sha `git commit` itself printed (`[branch abc1234] …`), so a
 * landed commit is never narrated `failed`/`skipped` (a dropped
 * rev-parse is an instrumentation failure, not an outcome failure). The
 * outcome reuses {@link DoorstopCommitOutcome} verbatim — a failing
 * pre-commit hook (its stderr surfaces verbatim in the excerpt) or a
 * missing `user.name`/`user.email` identity (git's own stderr names the
 * remedy) both resolve as `failed`; only a host-attributed ABORT rethrows.
 */
export async function requestDoorstopGitCommit(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_GIT_COMMIT_OPERATION) {
    throw unsupportedBackendOperationError(request.operation);
  }
  // STRICT parse before any exec AND before queueing (the run/baseline
  // idiom): an out-of-grammar message never reaches git.
  const commitRequest = parseDoorstopGitCommitRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    try {
      // 1. Repo check — a non-repo workspace has nothing to commit.
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

      // 2. Nothing staged → `clean` (`git diff --cached --quiet` exit 0).
      // Exit 1 means staged changes exist → proceed; any other exit code
      // (or a killed exec — exitCode null) is a real git error, not
      // "clean".
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

      // 3. The commit itself: NO pathspec, NO add — the index is the
      // content, whatever it holds. The message travels as execFile argv
      // (never a shell string), so no quoting/injection concern here.
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

      // 4. The abbreviated HEAD sha for the `committed` narration. The
      // commit ALREADY LANDED (step 3 exited 0): a rev-parse that fails or
      // is skipped by the deadline budget must NOT narrate the commit as
      // `skipped`/`failed` while it exists — `git commit` printed the short
      // sha in its own first stdout bracket (`[main abc1234] …`), which
      // becomes the fallback; only when even that is missing (defensive)
      // does the step fail/skip.
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
      // Any git failure collapses into the bounded `failed` outcome; the
      // response RESOLVES (narration). A host-attributed ABORT rethrows
      // untouched (module header taxonomy).
      if (request.signal.aborted) throw error;
      return commitResponse({ status: "failed", stderr: commitStderrExcerpt(formatUnknownError(error)) });
    }
  });
}

/** The `doorstop.git-commit` response literal — the review→commit
 *  {@link DoorstopCommitOutcome} shape reused verbatim (see
 *  doorstopRunResponse for the JsonValue idiom): `sha` on `committed`
 *  only, `stderr` on `failed` only, both omitted otherwise. */
function commitResponse(outcome: DoorstopCommitOutcome): JsonValue {
  // The spread yields a fresh object so the value admits the host bridge's
  // JsonObject index signature (the interface itself lacks it); `satisfies`
  // keeps the shape pinned to the contract.
  return { ...outcome } satisfies DoorstopCommitOutcome;
}
