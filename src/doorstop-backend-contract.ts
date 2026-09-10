// ---------------------------------------------------------------------------
// Opendoor paired-server contract: the ONE operation name, request/response
// shapes, and runtime parse validators shared by the browser bundle (panel
// dispatcher) and the server bundle (`doorstop-backend.ts` request handler),
// plus the UID/publish-target grammars both sides validate with.
//
// This follows the git-plugin contract idiom exactly
// (pi-web-plugins/git/browser/git-contract.ts, shipped as
// dist/pi-web-plugins/git/browser/git-contract.js): a plain TS module with
// NO runtime imports from `@jmfederico/pi-web` (type-only at most — here not
// even that), so it compiles into both bundles and runs in both vitest
// environments (browser tests under happy-dom, server tests under node).
// The guard helpers come from the plugin's existing frozen boundary module
// (src/doorstop-contract.ts, `requireRecord`/`requireString`/…), keeping
// their error-message wording stable across every validator in this repo.
//
// Shape discipline: `DoorstopRunResponse` is the structural sibling of the
// host's `ServerPluginExecFileResult` (server-plugin-api.d.ts) — the
// backend maps that result onto this interface verbatim, adding `op` and
// `durationMs`. Both parse validators are STRICT: junk of any kind
// (non-objects, arrays, null, missing fields, wrong types, unknown ops,
// out-of-grammar UIDs/targets) throws; nothing is coerced or defaulted.
// Extra keys on a valid request/response object are tolerated silently
// (forward compatibility, git-contract idiom) — but every field the
// operation needs must be present and correctly typed.
//
// Grammar note (single source of truth): `isValidDoorstopUid` is the port of
// the element-level Link/Unlink target guard (doorstop-panel-elements.ts
// `isValidTargetUid`, which now delegates here) and `isValidPublishTarget`
// the port of the settings-chain safe-relative-path rule
// (doorstop-settings.ts), which also delegates here — one grammar, no
// second copy anywhere.
//
// Conventions (strictest tsconfig flags incl. `exactOptionalPropertyTypes`):
// every typed field here is REQUIRED and always present — there are no
// optional fields to omit. The host JSON bridge carries `null` for
// `exitCode`/`signal` (values, not omitted fields), so the parser treats
// `null` as the one legal non-typed value for those two fields (and
// rejects an empty-string `signal` — "killed with no signal" is
// meaningless; the host emits `null` or a real signal name).
// ---------------------------------------------------------------------------

import {
  requireArrayValue,
  requireBoolean,
  requireFiniteNumber,
  requireRecord,
  requireString,
} from "./doorstop-contract.js";

/** The plugin id opendoor registers under in the pi-web manifest — the
 *  browser gate `context.workspace.provider?.pluginId === OPENDOOR_PLUGIN_ID`
 *  that decides between the backend path and the terminal fallback. */
export const OPENDOOR_PLUGIN_ID = "opendoor";

/** The single backend operation: `backend.request(DOORSTOP_RUN_OPERATION,
 *  input)`. Matches the host's `^[a-z][a-z0-9.-]*$` operation grammar. The
 *  server bundle maps the request to an argv array — the browser never sends
 *  shell strings or raw argv. */
export const DOORSTOP_RUN_OPERATION = "doorstop.run";

/**
 * One doorstop CLI invocation request, dispatched through
 * `backend.request("doorstop.run", input)`. The discriminated `op` picks the
 * server-side argv builder (`doorstop-backend.ts`):
 *
 *   op        argv
 *   validate  []                     (today's bare `doorstop`)
 *   publish   ["publish", "all", target]
 *   review    ["review", uid]
 *   clear     ["clear", uid, …parents]
 *   edit      ["edit", uid]
 *   link      [op, uid, target]
 *   unlink    [op, uid, target]
 *
 * `publish.target` is a workspace-relative PATH (validated by
 * {@link isValidPublishTarget}; the browser sends the workspace settings
 * value, already trimmed/normalized). The `uid` and link/unlink `target`
 * fields are item UIDs (validated by {@link isValidDoorstopUid} — the same
 * grammar the Link/Unlink inputs guard with).
 *
 * `clear.parents` is never empty: the panel disables the Clear button at
 * zero suspect links (and `clearSuspects` early-returns), so a clear
 * request with no parents is a contradiction the browser never emits — the
 * request parser rejects an empty list for strict parity with that guard.
 */
export type DoorstopRunRequest =
  | { op: "validate" }
  | { op: "publish"; target: string }
  | { op: "review"; uid: string }
  | { op: "clear"; uid: string; parents: readonly string[] }
  | { op: "edit"; uid: string }
  | { op: "link"; uid: string; target: string }
  | { op: "unlink"; uid: string; target: string };

/**
 * The backend's structured result for one `doorstop.run` request — the
 * browser-facing sibling of the host `ServerPluginExecFileResult` plus `op`
 * (echoed from the request, for render routing) and `durationMs` (measured
 * around `execFile`). Findings ARE output, not infrastructure errors: the
 * CLI ran to any exit code (incl. validate's exit 1) and the request
 * RESOLVES with this shape. `signal !== null` means the run was killed
 * (host timeout/abort) — surfaced, not thrown, with partial output
 * preserved. `stdoutTruncated`/`stderrTruncated` carry the host's 2 MiB/
 * stream truncation flags; the browser renders them as a notice, not an
 * error (deliberate deviation from the git throw-on-truncation idiom).
 */
export interface DoorstopRunResponse {
  /** The request's `op`, echoed back for render routing. */
  op: DoorstopRunRequest["op"];
  /** Process exit code; `null` when the process never exited (killed). */
  exitCode: number | null;
  /** Killing signal (e.g. "SIGTERM"); `null` for a normal exit. An empty
   *  string is meaningless ("killed with no signal") and rejected. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Host 2 MiB output-stream truncation flags. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Wall time around the execFile call, in milliseconds. */
  durationMs: number;
}

/**
 * Whether `value` is a syntactically valid Doorstop item UID — the model
 * chain's `split_uid` grammar (prefix [+sep] + digits [+sep+name]),
 * ANCHORED to the whole string and restricted to the UID alphabet. This is
 * the exact grammar of the element-level Link/Unlink input guard (the
 * private `isValidTargetUid` in doorstop-panel-elements.ts, which now
 * delegates here): the explicit `[\w.-]` alphabet guard rejects whitespace,
 * quotes, and every shell metacharacter by construction, and the structural
 * checks require a prefix + separator + digits|name, or a prefix + digits.
 * An accepted UID is always a safe bare token for the server-built argv.
 */
export function isValidDoorstopUid(value: string): boolean {
  if (value === "") return false;
  // UID alphabet guard — rejects whitespace, quotes, and all shell
  // metacharacters, so an accepted UID is always a safe bare token.
  if (!/^[\w.-]+$/.test(value)) return false;
  // prefix + separator + digits|name   (e.g. "REQ-001", "REQ_001", "REQ-ALPHA")
  if (/^[\w.-]+[-_.][\w]+$/.test(value)) return true;
  // prefix ending in a non-digit + digits, no separator (e.g. "REQ0001")
  if (/^[\w.-]*\D\d+$/.test(value)) return true;
  return false;
}

/**
 * Whether `value` is a safe workspace-relative publish target PATH — the
 * exact rule of the settings chain's publish-target validation
 * (doorstop-settings.ts `parseOpendoorSettings`, which now delegates
 * here): non-empty, never absolute (no leading `/`), never a Windows
 * drive-letter prefix (`C:/x`), never a backslash, never a leading `-`
 * (doorstop's own argparse would misread a dash-prefixed target as a
 * flag), and no `..` segment (path traversal). Anything the settings
 * validator would reject is rejected here, so the backend can never be
 * asked to write outside the workspace. (This is a structural PATH check;
 * how the value is shell-QUOTED for the terminal fallback is the separate
 * `PUBLISH_TARGET_SAFE_TOKEN` concern of doorstop-panel-elements.ts
 * `doorstopPublishCommand`.)
 */
export function isValidPublishTarget(value: string): boolean {
  if (value === "") return false;
  // Leading dash: doorstop's own argparse would consume `-…` as a flag.
  if (value.startsWith("-")) return false;
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\")) return false;
  for (const segment of value.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

/** The recognized `doorstop.run` op strings. */
const DOORSTOP_RUN_OPS = new Set<DoorstopRunRequest["op"]>([
  "validate",
  "publish",
  "review",
  "clear",
  "edit",
  "link",
  "unlink",
]);

/** Validate that `value` is one of the known op strings (git-contract's
 *  strict-enum style: unknown values throw, nothing is defaulted). Shared by
 *  the request and response parsers so the two never disagree. */
function parseDoorstopRunOp(value: string): DoorstopRunRequest["op"] {
  if (!DOORSTOP_RUN_OPS.has(value as DoorstopRunRequest["op"])) {
    throw new Error(`Invalid doorstop run op: ${JSON.stringify(value)}`);
  }
  return value as DoorstopRunRequest["op"];
}

/** Guard: `record[key]` must be a string array (git-contract's
 *  `requireStringArray`, on top of doorstop-contract's `requireArrayValue`). */
function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const values = requireArrayValue(record[key], key);
  if (!values.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`Expected string array field: ${key}`);
  }
  return values;
}

/** Guard: `record[key]` must be a string (else throw) AND a valid Doorstop
 *  item UID (else throw with a grammar message). */
function requireUid(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!isValidDoorstopUid(value)) {
    throw new Error(`Invalid doorstop UID in field: ${key}`);
  }
  return value;
}

/**
 * Parse and validate an untrusted `doorstop.run` request (the `input` of a
 * `backend.request` call, which travels the host JSON bridge as unknown).
 * Throws on junk: non-object input, unknown/missing/non-string `op`,
 * variant fields missing or wrongly typed, publish targets outside the
 * safe-relative-path grammar ({@link isValidPublishTarget}), and UIDs
 * outside the item-UID grammar ({@link isValidDoorstopUid}). Extra keys are
 * tolerated (forward compatibility). The backend handler calls this BEFORE
 * any exec, so a malformed request never reaches the CLI.
 */
export function parseDoorstopRunRequest(value: unknown): DoorstopRunRequest {
  const record = requireRecord(value, "Doorstop run request");
  const op = parseDoorstopRunOp(requireString(record, "op"));
  switch (op) {
    case "validate":
      return { op };
    case "publish": {
      const target = requireString(record, "target");
      if (!isValidPublishTarget(target)) {
        throw new Error(
          "Invalid publish target in doorstop.run request — must be a workspace-relative " +
            'path (never absolute, never a drive-letter prefix, no ".." segment)',
        );
      }
      return { op, target };
    }
    case "review":
      return { op, uid: requireUid(record, "uid") };
    case "clear": {
      const uid = requireUid(record, "uid");
      const parents = requireStringArray(record, "parents");
      // Strict parity with the element-level guard: the Clear button is
      // disabled at zero suspects (and `clearSuspects` early-returns), so a
      // clear request with no parents is a contradiction the browser can
      // never emit — surface it instead of running a bare
      // `doorstop clear <uid>`.
      if (parents.length === 0) {
        throw new Error("Invalid doorstop.run clear request: at least one parent UID is required");
      }
      for (const parent of parents) {
        if (!isValidDoorstopUid(parent)) throw new Error(`Invalid doorstop UID in field: parents`);
      }
      return { op, uid, parents };
    }
    case "edit":
      return { op, uid: requireUid(record, "uid") };
    case "link":
    case "unlink": {
      const uid = requireUid(record, "uid");
      const target = requireUid(record, "target");
      return { op, uid, target };
    }
  }
}

/**
 * Parse and validate a `doorstop.run` response (the server's exact output
 * shape: `op`, `exitCode: number|null`, `signal: string|null`, stdout,
 * stderr, the two truncation flags, `durationMs`). Throws on junk:
 * non-object input, missing fields, wrong types (incl. non-finite numbers),
 * unknown ops, and a `signal` that is neither a non-empty string nor `null`
 * (an empty killing signal is meaningless — the host emits `null` or a real
 * signal name).
 * Every field is required — the server never omits any of them.
 */
export function parseDoorstopRunResponse(value: unknown): DoorstopRunResponse {
  const record = requireRecord(value, "Doorstop run response");
  const op = parseDoorstopRunOp(requireString(record, "op"));
  const exitCode = record["exitCode"];
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isFinite(exitCode))) {
    throw new Error("Expected finite number or null field: exitCode");
  }
  const signal = record["signal"];
  if (signal !== null && typeof signal !== "string") {
    throw new Error("Expected string or null field: signal");
  }
  if (signal === "") {
    throw new Error("Expected non-empty string or null field: signal");
  }
  return {
    op,
    exitCode,
    signal,
    stdout: requireString(record, "stdout"),
    stderr: requireString(record, "stderr"),
    stdoutTruncated: requireBoolean(record, "stdoutTruncated"),
    stderrTruncated: requireBoolean(record, "stderrTruncated"),
    durationMs: requireFiniteNumber(record, "durationMs"),
  };
}