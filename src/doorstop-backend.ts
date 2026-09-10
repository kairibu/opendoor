// ---------------------------------------------------------------------------
// Opendoor server-side request backend (plan Phase B step 2, chain E2 server
// half): the single `doorstop.run` request handler routed through
// `workspaceProvider.request`. The browser never sends shell strings or raw
// argv — it sends the STRUCTURED `DoorstopRunRequest` (doorstop-backend-
// contract.ts) and this module builds the argv, runs the doorstop CLI through
// the host-bounded `context.execFile`, and returns the validated
// `DoorstopRunResponse` shape as `JsonValue` (the browser re-parses it with
// `parseDoorstopRunResponse`).
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
// timeoutMs?: number }` — wrong types fall back to defaults silently, never
// throw (the sessiond config is a startup snapshot, not a request payload).
// A configured `timeoutMs` may SHORTEN the default but never exceed it: a
// longer value would cross the ~10 s host callback bound, letting the host
// abort the whole callback instead of opendoor returning its own structured
// killed/timeout result — which is the reason the default exists.
// ---------------------------------------------------------------------------

import type {
  JsonObject,
  JsonValue,
  ProviderRequestContext,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  DOORSTOP_RUN_OPERATION,
  type DoorstopRunRequest,
  type DoorstopRunResponse,
  parseDoorstopRunRequest,
} from "./doorstop-backend-contract.js";

/** Default command name resolved by the sessiond host PATH. */
const DEFAULT_DOORSTOP_COMMAND = "doorstop";
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

/** Activation-scoped serialization: context object → per-workspace run queues. */
const activationRunQueues = new WeakMap<ServerPluginActivationContext, Map<string, Promise<void>>>();

/**
 * Lenient host-settings projection: `doorstopPath` (non-empty string) and
 * `timeoutMs` (positive finite number) are honored — `timeoutMs` clamped to
 * the default ceiling (settings may shorten the default, never exceed it);
 * anything else falls back to the defaults silently.
 */
interface DoorstopBackendSettings {
  readonly doorstopPath: string;
  readonly timeoutMs: number;
}

/** Handle one `workspaceProvider.request` call: validate, queue, exec, map. */
export async function requestDoorstopBackend(
  context: ServerPluginActivationContext,
  request: ProviderRequestContext,
): Promise<JsonValue> {
  if (request.operation !== DOORSTOP_RUN_OPERATION) {
    throw new Error(`opendoor: unsupported workspace backend operation: ${request.operation}`);
  }
  // STRICT parse before any exec AND before queueing (git-contract grammar:
  // junk of any kind throws; extra keys tolerated for forward compat).
  const run = parseDoorstopRunRequest(request.input);
  const settings = parseDoorstopBackendSettings(context.settings);
  const cwd = request.workspace.path;
  return runSerialized(context, cwd, async () => {
    const startedAt = Date.now();
    const result = await runDoorstop(context, settings, cwd, doorstopArgv(run), request.signal);
    return doorstopRunResponse(run.op, result, Date.now() - startedAt);
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
 * (never derived from `project.path`), the default 8.5 s timeout leaves
 * headroom under the 10 s host callback bound, and the per-invocation signal
 * is always forwarded. Errors: ENOENT (spawn could not resolve the binary)
 * maps to the "CLI not found" message; anything else is host-attributed
 * (exec timeout kill, callback abort) and rethrows untouched.
 */
async function runDoorstop(
  context: ServerPluginActivationContext,
  settings: DoorstopBackendSettings,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<ServerPluginExecFileResult> {
  try {
    return await context.execFile({
      file: settings.doorstopPath,
      args,
      cwd,
      unsetEnv: DOORSTOP_UNSET_ENV_KEYS,
      timeoutMs: settings.timeoutMs,
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
  return { doorstopPath, timeoutMs };
}

/** Whether `error` is a Node spawn ENOENT (`error.code === "ENOENT"`). */
function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}