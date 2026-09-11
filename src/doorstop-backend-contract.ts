// ---------------------------------------------------------------------------
// Opendoor paired-server contract: the TWO backend operation names
// (`doorstop.run` and `doorstop.item-baseline`), their request/response
// shapes, and runtime parse validators shared by the browser bundle (panel
// dispatcher) and the server bundle (`doorstop-backend.ts` request handler),
// plus the UID/publish-target/item-path grammars both sides validate with.
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
// `durationMs` (and the optional `commit` outcome). Every parse validator
// in this module is STRICT: junk of any kind
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
// second copy anywhere. `isValidDoorstopItemPath` is the NEW review/
// baseline-safe item-path rule (plan Phase A step 4), shared by the
// baseline request parser and the Phase B review-commit pathspec — no
// second copy anywhere either.
//
// Conventions (strictest tsconfig flags incl. `exactOptionalPropertyTypes`):
// typed fields are REQUIRED and always present unless documented optional
// (the review variant's `commit` flag, the response's `commit` outcome, and
// the outcome's `sha`/`stderr` excerpts). With `exactOptionalPropertyTypes`
// the parsers OMIT absent optional fields — never set them to `undefined`
// (the git-contract `...(x === undefined ? {} : { x })` idiom). The host
// JSON bridge carries `null` for
// `exitCode`/`signal` (values, not omitted fields), so the parser treats
// `null` as the one legal non-typed value for those two fields (and
// rejects an empty-string `signal` — "killed with no signal" is
// meaningless; the host emits `null` or a real signal name).
// ---------------------------------------------------------------------------

import {
  optionalString,
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

/** The primary backend operation — one doorstop CLI invocation:
 *  `backend.request(DOORSTOP_RUN_OPERATION, input)`. Matches the host's
 *  `^[a-z][a-z0-9.-]*$` operation grammar. The server bundle maps the
 *  request to an argv array — the browser never sends shell strings or raw
 *  argv. (The sibling read-only baseline operation, `doorstop.item-baseline`,
 *  lives below with the {@link DoorstopBaselineResponse} types.) */
export const DOORSTOP_RUN_OPERATION = "doorstop.run";

/**
 * One doorstop CLI invocation request, dispatched through
 * `backend.request("doorstop.run", input)`. The discriminated `op` picks the
 * server-side argv builder (`doorstop-backend.ts`):
 *
 *   op        argv
 *   validate  []                     (today's bare `doorstop`)
 *   publish   ["publish", "all", target]
 *   review    ["review", uid]        (+ commit: true → review→commit pipeline)
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
 * `commit` is OPTIONAL on the review variant (absent/false behaves exactly
 * as today, so in-flight requests survive a mixed-version reload window).
 * It is the browser-driven opt-in policy flag — the plugin's
 * `commitAfterReview` workspace setting — not a server decision: the server
 * only validates the boolean and, when true, records a pathspec-limited git
 * commit of the item file with a conforming `doorstop: review <uid>` message
 * after the review run succeeds (the outcome travels back in
 * {@link DoorstopRunResponse.commit}).
 *
 * `clear.parents` is never empty: the panel disables the Clear button at
 * zero suspect links (and `clearSuspects` early-returns), so a clear
 * request with no parents is a contradiction the browser never emits — the
 * request parser rejects an empty list for strict parity with that guard.
 */
export type DoorstopRunRequest =
  | { op: "validate" }
  | { op: "publish"; target: string }
  | { op: "review"; uid: string; commit?: boolean }
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
 *
 * `commit` is ABSENT unless the request asked for the review→commit
 * pipeline (`commit: true`): the optional outcome narrating the post-review
 * git commit (see {@link DoorstopCommitOutcome}). A failed or skipped
 * commit never fails the run — the review result stands and the outcome is
 * narration, not infrastructure error (same philosophy as the truncation
 * flags).
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
  /** Post-review git commit outcome; absent when the request did not ask
   *  for a commit (the request parser keeps the field out under the
   *  default, so a response without one stays parseable both ways). */
  readonly commit?: DoorstopCommitOutcome;
}

/**
 * The post-review git commit outcome the server appends to a `doorstop.run`
 * review response when the request carried `commit: true` (the
 * review→commit pipeline, plan Phase B step 5). The outcome is narration:
 * the review already succeeded and its result stands — a `failed`/`skipped`
 * outcome leaves the run's ok/failed badge unchanged, and the response
 * still RESOLVES.
 */
export interface DoorstopCommitOutcome {
  /** committed → a commit was created (`sha` set); clean → the item file
   *  was already committed (no working-tree change); skipped → not a git
   *  repository / the review failed / the deadline budget was exhausted;
   *  failed → a git step errored (`stderr` excerpt). */
  status: "committed" | "clean" | "skipped" | "failed";
  /** Abbreviated sha of the created commit ("committed" only). */
  sha?: string;
  /** Bounded stderr excerpt (≤ ~2 KiB; "failed" only). */
  stderr?: string;
}

/** The second backend operation — the read-only "changes since review"
 *  baseline fetch: `backend.request(DOORSTOP_BASELINE_OPERATION, input)`.
 *  Matches the host's `^[a-z][a-z0-9.-]*$` operation grammar. The server
 *  (plan Phase B step 6) locates the reviewed version of an item in git
 *  history — the fast `doorstop: review <uid>` grep path with the generic
 *  history walk as fallback — and the browser stamps the returned blobs
 *  until one matches `item.reviewed`, then renders a semantic diff against
 *  the current item. */
export const DOORSTOP_BASELINE_OPERATION = "doorstop.item-baseline";

/** One baseline fetch request: the UID whose reviewed version to find and
 *  the workspace-relative path of ITS item file (the review-commit
 *  pathspec is limited to this exact file). Both fields are validated
 *  before any exec — {@link parseDoorstopBaselineRequest}: the uid by
 *  {@link isValidDoorstopUid}, the path by {@link isValidDoorstopItemPath}
 *  (the identical rule the review-commit pathspec passes). */
export interface DoorstopBaselineRequest {
  uid: string;
  path: string;
}

/** One recoverable reviewed version: the commit sha and the item file blob
 *  at that commit. Blobs over {@link DOORSTOP_BASELINE_BLOB_MAX} are
 *  skipped server-side (the review stamp is a content hash, so an oversize
 *  blob would only ever be a dead end for the browser-side stamp walk). */
export interface DoorstopBaselineCandidate {
  sha: string;
  blob: string;
}

/** The backend's structured result for one `doorstop.item-baseline`
 *  request. The browser walks `candidates` NEWEST-first, parsing each blob
 *  and recomputing the item stamp until one matches the item's stored
 *  `reviewed` fingerprint (the "before" side of the diff). */
export interface DoorstopBaselineResponse {
  /** false → not a git repository; `candidates` is empty and the browser
   *  shows the "No git history" notice. */
  git: boolean;
  /** "review-commit" → grep hits found; "history" → generic log fallback
   *  (rewritten/squashed history); "none" → no candidates at all. */
  source: "review-commit" | "history" | "none";
  /** Newest first; each blob ≤ {@link DOORSTOP_BASELINE_BLOB_MAX} (oversize
   *  blobs are skipped server-side, never fatal). */
  candidates: readonly DoorstopBaselineCandidate[];
}

/** Cap on grep-mode baseline candidates (the conforming
 *  `^doorstop: review <uid>$` commits to walk). */
export const DOORSTOP_BASELINE_GREP_LIMIT = 20;

/** Cap on the generic-history fallback candidates (`git log --max-count=50`
 *  — rewritten/squashed history falls back to this stamp-walk). */
export const DOORSTOP_BASELINE_HISTORY_LIMIT = 50;

/** Blob size cap: candidate blobs larger than 256 KiB are skipped
 *  server-side. A review stamp is a SHA-256 content hash, so a blob the
 *  browser couldn't reach can never match a stored `reviewed` fingerprint;
 *  the cap keeps the baseline response bounded against pathological
 *  history. */
export const DOORSTOP_BASELINE_BLOB_MAX = 256 * 1024;

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
 * Whether `value` is a safe workspace-relative path to a Doorstop item
 * file — the rule the baseline request's `path` ({@link
 * DoorstopBaselineRequest}) and the review-commit pathspec (plan Phase B
 * step 5) must both pass, validated identically by the browser and the
 * server (the {@link isValidDoorstopUid} / {@link isValidPublishTarget}
 * idiom). The rule is deliberately EXTENSION-AGNOSTIC — a workspace may
 * configure non-`yml` item formats, so no name pattern is enforced;
 * pathspec safety comes from the relative-path grammar plus the execFile
 * argv `--` separator, never from a file-name convention.
 *
 * Rejected: empty paths, absolute paths (leading `/` or a `C:`-style drive
 * prefix), Windows backslashes, any `..` path segment (traversal), control
 * characters and line breaks (single line — no terminal/alt-text
 * injection), and anything over 256 characters. Unlike
 * {@link isValidPublishTarget}, a leading `-` is NOT rejected: every use of
 * this path goes through `--`-separated execFile argv (no shell, no
 * argparse), so a dash-prefixed name cannot be misread as an option.
 */
export function isValidDoorstopItemPath(value: string): boolean {
  if (value === "") return false;
  // Length cap (plan: ≤ 256 chars).
  if (value.length > 256) return false;
  // Absolute paths: POSIX plus Windows drive-letter prefixes.
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  // Windows backslashes (and UNC roots) are never item paths.
  if (value.includes("\\")) return false;
  // Control characters and line breaks: single line, no terminal output
  // (C0 controls U+0000–U+001F, DEL and the C1 controls U+007F–U+009F,
  // and the Unicode line separators U+2028/U+2029).
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  // No ".." segment anywhere (path traversal).
  for (const segment of value.split("/")) {
    if (segment === "..") return false;
  }
  return true;
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

/** Guard: `record[key]` must be a boolean when present; `undefined` passes
 *  (git-contract's optional-field idiom, for the review request's optional
 *  `commit` flag). */
function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
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

/** Guard: `record[key]` must be a string (else throw) AND a safe
 *  workspace-relative item path (else throw with a grammar message). */
function requireItemPath(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!isValidDoorstopItemPath(value)) {
    throw new Error(`Invalid doorstop item path in field: ${key}`);
  }
  return value;
}

/**
 * Parse and validate an untrusted `doorstop.run` request (the `input` of a
 * `backend.request` call, which travels the host JSON bridge as unknown).
 * Throws on junk: non-object input, unknown/missing/non-string `op`,
 * variant fields missing or wrongly typed, publish targets outside the
 * safe-relative-path grammar ({@link isValidPublishTarget}), and UIDs
 * outside the item-UID grammar ({@link isValidDoorstopUid}); the review
 * variant's optional `commit` must be a boolean when present. Extra keys
 * are tolerated (forward compatibility). The backend handler calls this
 * BEFORE any exec, so a malformed request never reaches the CLI.
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
    case "review": {
      const uid = requireUid(record, "uid");
      // Optional opt-in flag (absent/false == today's behavior). The exact
      // optional-field idiom: omit, never set to undefined.
      const commit = optionalBoolean(record, "commit");
      return commit === undefined ? { op, uid } : { op, uid, commit };
    }
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
 * Every base field is required — the server never omits any of them.
 *
 * `commit` is the one OPTIONAL field: absent when the request did not ask
 * for a commit; when present it must parse as a {@link DoorstopCommitOutcome}
 * (strict — an unknown `status` or a wrongly-typed `sha`/`stderr` throws,
 * nothing is defaulted). The outcome never fails the response: it narrates
 * a git step that happened after a successful review.
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
  const commit = record["commit"];
  return {
    op,
    exitCode,
    signal,
    stdout: requireString(record, "stdout"),
    stderr: requireString(record, "stderr"),
    stdoutTruncated: requireBoolean(record, "stdoutTruncated"),
    stderrTruncated: requireBoolean(record, "stderrTruncated"),
    durationMs: requireFiniteNumber(record, "durationMs"),
    ...(commit === undefined ? {} : { commit: parseDoorstopCommitOutcome(commit) }),
  };
}

/** The recognized `commit` outcome statuses (strict-enum style: unknown
 *  values throw, nothing is defaulted — same style as
 *  {@link parseDoorstopRunOp}). */
const DOORSTOP_COMMIT_STATUSES = new Set<DoorstopCommitOutcome["status"]>([
  "committed",
  "clean",
  "skipped",
  "failed",
]);

/** Validate that `value` is one of the known commit outcome statuses. */
function parseDoorstopCommitStatus(value: string): DoorstopCommitOutcome["status"] {
  if (!DOORSTOP_COMMIT_STATUSES.has(value as DoorstopCommitOutcome["status"])) {
    throw new Error(`Invalid doorstop commit status: ${JSON.stringify(value)}`);
  }
  return value as DoorstopCommitOutcome["status"];
}

/**
 * Parse and validate one post-review commit outcome ({@link
 * DoorstopCommitOutcome}). Throws on junk: non-object input, a missing or
 * unknown `status`, a wrongly-typed optional `sha`/`stderr` (strings when
 * present; nothing is coerced or defaulted; extra keys tolerated,
 * git-contract forward-compat idiom), and a `sha` on any status but
 * `committed` or a `stderr` on any status but `failed` — the outcome's
 * JSDoc-declared field/status coupling, enforced here so a malformed
 * outcome never half-parses. Exported so tests can pin the strict parse
 * without round-tripping through a full run response.
 */
export function parseDoorstopCommitOutcome(value: unknown): DoorstopCommitOutcome {
  const record = requireRecord(value, "Doorstop commit outcome");
  const status = parseDoorstopCommitStatus(requireString(record, "status"));
  const sha = optionalString(record, "sha");
  const stderr = optionalString(record, "stderr");
  // The JSDoc on {@link DoorstopCommitOutcome} couples the fields to their
  // statuses: `sha` is "committed" only, `stderr` is "failed" only. Enforce
  // that coupling strictly — `{ status: "clean", sha }`, a stray `stderr`
  // on a successful commit, etc., are malformed outcomes, never a
  // silently-ignored field (the strict-parse idiom of this module).
  if (status !== "committed" && sha !== undefined) {
    throw new Error(`Only a "committed" outcome may carry "sha" (status: ${JSON.stringify(status)})`);
  }
  if (status !== "failed" && stderr !== undefined) {
    throw new Error(`Only a "failed" outcome may carry "stderr" (status: ${JSON.stringify(status)})`);
  }
  return {
    status,
    ...(sha === undefined ? {} : { sha }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

/** The recognized baseline `source` values (strict-enum style). */
const DOORSTOP_BASELINE_SOURCES = new Set<DoorstopBaselineResponse["source"]>([
  "review-commit",
  "history",
  "none",
]);

/** Validate that `value` is one of the known baseline sources. */
function parseDoorstopBaselineSource(value: string): DoorstopBaselineResponse["source"] {
  if (!DOORSTOP_BASELINE_SOURCES.has(value as DoorstopBaselineResponse["source"])) {
    throw new Error(`Invalid doorstop baseline source: ${JSON.stringify(value)}`);
  }
  return value as DoorstopBaselineResponse["source"];
}

/** Parse and validate one baseline candidate record (two required strings;
 *  extra keys tolerated, git-contract forward-compat idiom). */
function parseDoorstopBaselineCandidate(value: unknown): DoorstopBaselineCandidate {
  const record = requireRecord(value, "Doorstop baseline candidate");
  return {
    sha: requireString(record, "sha"),
    blob: requireString(record, "blob"),
  };
}

/**
 * Parse and validate a `doorstop.item-baseline` request. Throws on junk:
 * non-object input, missing `uid`/`path`, a uid outside the item-UID
 * grammar ({@link isValidDoorstopUid}), or a path outside the
 * workspace-relative item-path grammar ({@link isValidDoorstopItemPath}) —
 * the exact pair of guards the server runs BEFORE any exec, so a
 * malformed request never reaches git. Extra keys are tolerated.
 */
export function parseDoorstopBaselineRequest(value: unknown): DoorstopBaselineRequest {
  const record = requireRecord(value, "Doorstop baseline request");
  return {
    uid: requireUid(record, "uid"),
    path: requireItemPath(record, "path"),
  };
}

/**
 * Parse and validate a `doorstop.item-baseline` response (the server's
 * exact output shape: `git` boolean, strict `source` enum, and a
 * `candidates` array of `{sha, blob}` records). Throws on junk:
 * non-object input, missing fields, wrongly-typed `git` or `candidates`, a
 * non-string `sha`/`blob`, or an unknown `source` — nothing is coerced or
 * defaulted, matching {@link parseDoorstopRunResponse}.
 */
export function parseDoorstopBaselineResponse(value: unknown): DoorstopBaselineResponse {
  const record = requireRecord(value, "Doorstop baseline response");
  return {
    git: requireBoolean(record, "git"),
    source: parseDoorstopBaselineSource(requireString(record, "source")),
    candidates: requireArrayValue(record["candidates"], "candidates").map(parseDoorstopBaselineCandidate),
  };
}