// ---------------------------------------------------------------------------
// Opendoor paired-server contract: the SIX backend operation names
// (`doorstop.run`, `doorstop.item-baseline`, and the four project-scoped
// git operations `doorstop.git-status` / `doorstop.git-stage` /
// `doorstop.git-unstage` / `doorstop.git-commit`), their request/response
// shapes, and runtime parse validators shared by the browser bundle (panel
// dispatcher) and the server bundle (`doorstop-backend.ts` request handler),
// plus the UID/publish-
// target/item-path/commit-message grammars both sides validate with.
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
// the element-level Link/Unlink target guard (doorstop-panel-view-model.ts
// `isValidTargetUid`, which now delegates here) and `isValidPublishTarget`
// the port of the settings-chain safe-relative-path rule
// (doorstop-settings.ts), which also delegates here — one grammar, no
// second copy anywhere. `isValidDoorstopItemPath` is the NEW review/
// baseline-safe item-path rule (plan Phase A step 4), shared by the
// baseline request parser and the Phase B review-commit pathspec — no
// second copy anywhere either. `isValidGitCommitMessage` is the NEW
// git-actions commit-message rule (plan-add-git-actions.md Phase A step 4),
// shared by the `doorstop.git-commit` request parser — no second copy
// anywhere either.
//
// Conventions (strictest tsconfig flags incl. `exactOptionalPropertyTypes`):
// typed fields are REQUIRED and always present unless documented optional
// (the review variant's `commit` flag, the response's `commit` outcome, the
// outcome's `sha`/`stderr` excerpts, the git status response's
// `branch`/`ahead`/`behind`, and the git stage response's `staged`/
// `stderr`). With `exactOptionalPropertyTypes`
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
 * private `isValidTargetUid` in doorstop-panel-view-model.ts, which now
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
 * `PUBLISH_TARGET_SAFE_TOKEN` concern of doorstop-panel-view-model.ts
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

// ---------------------------------------------------------------------------
// Git operations — `doorstop.git-status`, `doorstop.git-stage`,
// `doorstop.git-unstage`, `doorstop.git-commit` (plan-add-git-actions.md
// Phase A steps 1–5; unstage is the per-item follow-up): the project-scoped
// git quartet behind the Requirements panel's project-actions group. Status
// is READ-ONLY and best-effort — a `git` flag, not an error channel (the
// baseline idiom); stage and commit are mutating runs whose outcomes reuse
// the review→commit `DoorstopCommitOutcome` grammar (`status`/`sha`/
// `stderr`). The stage request is a path ARRAY — the same operation backs
// the future per-item staging palette with `{ paths: [item.path] }`, no new
// operation, no contract change.
// ---------------------------------------------------------------------------

/** The third backend operation — the read-only git status readout:
 *  `backend.request(DOORSTOP_GIT_STATUS_OPERATION, {})`. The server runs
 *  `rev-parse --is-inside-work-tree --show-prefix` (repo check) and
 *  `status --porcelain=v1 -z -b` (branch line + ahead/behind + per-file XY
 *  states) and returns the {@link DoorstopGitStatusResponse} shape backing
 *  the project-actions status strip. Matches the host's `^[a-z][a-z0-9.-]*$`
 *  operation grammar. */
export const DOORSTOP_GIT_STATUS_OPERATION = "doorstop.git-status";

/** One `doorstop.git-status` request: the status fetch carries NO fields —
 *  every workspace state the readout needs is derived server-side from the
 *  workspace path. (A field here is a forward-compat hook, never a current
 *  parameter; the parser accepts `{}` and tolerates extra keys.) */
export interface DoorstopGitStatusRequest {}

/** One git status file state — the porcelain XY columns decoded to the host
 *  git plugin's `GitStatusFile` vocabulary (its `parseGitFileState` shape,
 *  verbatim; the server's status handler maps the XY codes onto exactly
 *  these states). `index` carries the staged X column, `workingTree` the
 *  unstaged Y column. */
export type DoorstopGitFileState =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted";

/** One changed file in a status response, carrying BOTH porcelain columns
 *  kept SEPARATE (the host git plugin's `GitStatusFile` shape): `index` is
 *  the staged state (X), `workingTree` the unstaged state (Y). A single
 *  collapsed `state` field would force a BREAKING contract change when
 *  per-item staging lands (that UI must distinguish "has unstaged changes —
 *  stage it" from "staged, awaiting commit"); carrying both columns now
 *  costs one extra field and keeps every future consumer parse-compatible. */
export interface DoorstopGitStatusFile {
  path: string;
  index: DoorstopGitFileState;
  workingTree: DoorstopGitFileState;
}

/** The backend's structured result for one `doorstop.git-status` request —
 *  read-only and best-effort, NEVER an infrastructure error (the baseline
 *  handler's exact philosophy): `git: false` when the workspace is not a
 *  git repository (every other field at its default/empty value), and the
 *  browser shows the strip's "no git" text instead of an error.
 *
 * `staged` counts files whose INDEX column changed (X not in `' '`, `'?'`,
 *  `'!'` — the changes a commit will record); `dirty` counts files with any
 *  non-unmodified state (staged OR working-tree). Both counts cover the
 *  FULL porcelain output — `files` is capped at {@link
 *  DOORSTOP_GIT_STATUS_FILES_MAX} entries so the response stays bounded
 *  while the counts stay honest above the cap. */
export interface DoorstopGitStatusResponse {
  /** false → not a git repository; every other field is default/empty. */
  git: boolean;
  /** Current branch; ABSENT on a detached HEAD (porcelain `-b` prints
   *  `HEAD (no branch)` — the server reports no `branch`). */
  branch?: string;
  /** Commits ahead of the upstream; absent without an upstream. */
  ahead?: number;
  /** Commits behind the upstream; absent without an upstream. */
  behind?: number;
  /** Files with an index change (X column not `' '`, `'?'`, `'!'`). */
  staged: number;
  /** Files with any non-unmodified state (either column). */
  dirty: number;
  /** Per-file { path, index (staged X), workingTree (unstaged Y) }; capped
   *  at {@link DOORSTOP_GIT_STATUS_FILES_MAX} (the counts above remain
   *  full-output). */
  files: readonly DoorstopGitStatusFile[];
}

/** Cap on the status response's `files` array: the `staged`/`dirty` counts
 *  are computed from the FULL porcelain output, `files` holds the first 200
 *  entries — bounded responses, honest counts. */
export const DOORSTOP_GIT_STATUS_FILES_MAX = 200;

/** The recognized git file states (strict-enum style: unknown values throw,
 *  nothing is defaulted — the git plugin's `parseGitFileState` idiom). */
const DOORSTOP_GIT_FILE_STATES = new Set<DoorstopGitFileState>([
  "unmodified",
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "ignored",
  "conflicted",
]);

/** Validate that `value` is one of the known file states (a non-string is
 *  junk, not a state — nothing is coerced). */
function parseDoorstopGitFileState(value: unknown): DoorstopGitFileState {
  if (typeof value !== "string" || !DOORSTOP_GIT_FILE_STATES.has(value as DoorstopGitFileState)) {
    throw new Error(`Invalid doorstop git file state: ${JSON.stringify(value)}`);
  }
  return value as DoorstopGitFileState;
}

/** Guard: `record[key]` must be a finite NON-NEGATIVE number when present
 *  (a COUNT — the status response's optional `ahead`/`behind` and the
 *  stage response's optional `staged` count are commit/file counts; a
 *  negative value is impossible and rejected, the module's standing
 *  nothing-coerced rule); `undefined` passes (the git-contract
 *  `optionalNumber` idiom). */
function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected finite number field: ${key}`);
  }
  if (value < 0) {
    throw new Error(`Expected non-negative count field: ${key}`);
  }
  return value;
}

/** Guard: `record[key]` must be a finite NON-NEGATIVE number — the status
 *  response's REQUIRED `staged`/`dirty` counts (the same rule as
 *  {@link optionalNumber}'s count guard; `Number.isFinite` alone would let
 *  an impossible `-3` file count through). */
function requireCount(record: Record<string, unknown>, key: string): number {
  const value = requireFiniteNumber(record, key);
  if (value < 0) {
    throw new Error(`Expected non-negative count field: ${key}`);
  }
  return value;
}

/** Parse and validate one status file record (two strict file states and a
 *  path string; extra keys tolerated, git-contract forward-compat idiom). */
function parseDoorstopGitStatusFile(value: unknown): DoorstopGitStatusFile {
  const record = requireRecord(value, "Doorstop git status file");
  return {
    path: requireString(record, "path"),
    index: parseDoorstopGitFileState(record["index"]),
    workingTree: parseDoorstopGitFileState(record["workingTree"]),
  };
}

/**
 * Parse and validate a `doorstop.git-status` request: the status fetch
 * carries NO fields, so any object parses (extra keys tolerated, forward
 * compatibility — the git-contract request idiom); non-object junk throws.
 */
export function parseDoorstopGitStatusRequest(value: unknown): DoorstopGitStatusRequest {
  requireRecord(value, "Doorstop git status request");
  return {};
}

/**
 * Parse and validate a `doorstop.git-status` response — strict, the
 * module's standing rule: junk of any kind (non-object input, a non-string
 * `branch`, a non-finite `ahead`/`behind`, a wrongly-typed `git`/`staged`/
 * `dirty`, a non-array `files`, a `files` entry with a missing or
 * wrong-typed field, or an unknown file state) throws; nothing is coerced
 * or defaulted. The optional `branch`/`ahead`/`behind` are omitted from the
 * result when absent (exactOptionalPropertyTypes idiom), and they are
 * coupled to `git` exactly like the stage/commit parsers couple their
 * optional fields to their status: `{ git: false, branch }` — branch /
 * upstream fields on a non-git workspace — is a malformed response and
 * throws (the interface documents every other field as default/empty on
 * `git: false`).
 */
export function parseDoorstopGitStatusResponse(value: unknown): DoorstopGitStatusResponse {
  const record = requireRecord(value, "Doorstop git status response");
  const branch = optionalString(record, "branch");
  const ahead = optionalNumber(record, "ahead");
  const behind = optionalNumber(record, "behind");
  const git = requireBoolean(record, "git");
  // The JSDoc on {@link DoorstopGitStatusResponse} couples the optional
  // fields to `git`: not-a-repository means the branch/upstream fields are
  // ALL ABSENT (every other field at its default/empty value). Enforce
  // that coupling strictly — `{ git: false, branch }` is a malformed
  // response, never a silently-ignored field (the sibling stage/commit
  // parser idiom: optional fields only on the status that declares them).
  if (!git && (branch !== undefined || ahead !== undefined || behind !== undefined)) {
    throw new Error(
      `Only a git repository may carry "branch"/"ahead"/"behind" (git: ${JSON.stringify(git)})`,
    );
  }
  return {
    git,
    ...(branch === undefined ? {} : { branch }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    staged: requireCount(record, "staged"),
    dirty: requireCount(record, "dirty"),
    files: requireArrayValue(record["files"], "files").map(parseDoorstopGitStatusFile),
  };
}

/** The fourth backend operation — the project-scoped stage-all action:
 *  `backend.request(DOORSTOP_GIT_STAGE_OPERATION, { paths })`. The server
 *  checks the repo, lists the given (literalized) pathspecs, and `git add`s
 *  whatever changed among them — modifications, additions, AND deletions
 *  (git ≥ 2.x `add` stages removals for named paths, so a deleted item file
 *  is staged for removal too). The path ARRAY makes the operation generic:
 *  per-item staging (the future item-action-palette feature) is the same
 *  operation with `{ paths: [item.path] }` — no new operation, no contract
 *  change, no server edit. */
export const DOORSTOP_GIT_STAGE_OPERATION = "doorstop.git-stage";

/** One stage request: the Doorstop-managed workspace-relative paths to
 *  stage (the root `.doorstop.yml`, each document's config file, each item
 *  file). NEVER empty — the panel disables Stage all when the loaded index
 *  has no documents, so an empty stage request is a contradiction the
 *  browser never emits (the same strict parity as the clear request's
 *  `parents` guard); the request parser rejects it. Each path is validated
 *  by {@link isValidDoorstopItemPath} and deduplicated by the parser. */
export interface DoorstopGitStageRequest {
  paths: readonly string[];
}

/** The backend's structured result for one `doorstop.git-stage` request.
 *  The outcome is NARRATION (Stage all is a mutating run — the Last run
 *  status bar narrates it), so the response RESOLVES with this shape on
 *  every outcome and never surfaces as an infrastructure error. */
export interface DoorstopGitStageResponse {
  /** staged → paths were staged (`staged` count set); clean → nothing to
   *  stage (every Doorstop-managed file already matches the index/HEAD);
   *  skipped → not a git repository / deadline budget exhausted; failed →
   *  a git step errored (`stderr` excerpt). */
  status: "staged" | "clean" | "skipped" | "failed";
  /** Number of changed paths the `add` covered ("staged" only). */
  staged?: number;
  /** Bounded stderr excerpt (≤ ~2 KiB; "failed" only). */
  stderr?: string;
}

/** The recognized stage statuses (strict-enum style — the commit outcome's
 *  status set with `staged` in `committed`'s slot). */
const DOORSTOP_GIT_STAGE_STATUSES = new Set<DoorstopGitStageResponse["status"]>([
  "staged",
  "clean",
  "skipped",
  "failed",
]);

/** Validate that `value` is one of the known stage statuses. */
function parseDoorstopGitStageStatus(value: string): DoorstopGitStageResponse["status"] {
  if (!DOORSTOP_GIT_STAGE_STATUSES.has(value as DoorstopGitStageResponse["status"])) {
    throw new Error(`Invalid doorstop git stage status: ${JSON.stringify(value)}`);
  }
  return value as DoorstopGitStageResponse["status"];
}

/**
 * Parse and validate a `doorstop.git-stage` request. Throws on junk:
 * non-object input, a missing or non-array `paths` field, an EMPTY `paths`
 * array (strict parity with the element guard: the Stage all button is
 * disabled when the loaded index has no documents — an empty stage request
 * is a contradiction the browser never emits, surfaced instead of silently
 * ignored), or any path outside the workspace-relative item-path grammar
 * ({@link isValidDoorstopItemPath}). Duplicate paths are deduplicated by
 * the parser (first occurrence order preserved) so the server stages each
 * unique path exactly once. Extra keys are tolerated.
 */
export function parseDoorstopGitStageRequest(value: unknown): DoorstopGitStageRequest {
  const record = requireRecord(value, "Doorstop git stage request");
  const paths = requireStringArray(record, "paths");
  // Strict parity with the element guard: the Stage all button is disabled
  // when the loaded index has no documents, so an empty stage request is a
  // contradiction the browser never emits — surface it instead of running
  // a bare `git add` over nothing.
  if (paths.length === 0) {
    throw new Error("Invalid doorstop.git-stage request: at least one path is required");
  }
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const path of paths) {
    if (!isValidDoorstopItemPath(path)) {
      throw new Error(`Invalid doorstop item path in field: paths`);
    }
    if (!seen.has(path)) {
      seen.add(path);
      uniquePaths.push(path);
    }
  }
  return { paths: uniquePaths };
}

/**
 * Parse and validate a `doorstop.git-stage` response — strict, with the
 * same field/status coupling {@link parseDoorstopCommitOutcome} enforces:
 * a `staged` count on any status but `"staged"`, or a `stderr` excerpt on
 * any status but `"failed"`, is a malformed response and throws (nothing
 * is coerced or defaulted; extra keys tolerated).
 */
export function parseDoorstopGitStageResponse(value: unknown): DoorstopGitStageResponse {
  const record = requireRecord(value, "Doorstop git stage response");
  const status = parseDoorstopGitStageStatus(requireString(record, "status"));
  const staged = optionalNumber(record, "staged");
  const stderr = optionalString(record, "stderr");
  // The JSDoc on {@link DoorstopGitStageResponse} couples the fields to
  // their statuses: `staged` is "staged" only, `stderr` is "failed" only.
  // Enforce that coupling strictly — `{ status: "clean", staged }`, a
  // stray excerpt on a successful stage, etc., are malformed responses.
  if (status !== "staged" && staged !== undefined) {
    throw new Error(`Only a "staged" outcome may carry "staged" (status: ${JSON.stringify(status)})`);
  }
  if (status !== "failed" && stderr !== undefined) {
    throw new Error(`Only a "failed" outcome may carry "stderr" (status: ${JSON.stringify(status)})`);
  }
  return {
    status,
    ...(staged === undefined ? {} : { staged }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

/** The sixth backend operation — the per-path unstage action, the inverse of
 *  `doorstop.git-stage`: `backend.request(DOORSTOP_GIT_UNSTAGE_OPERATION, {
 *  paths })`. The server checks the repo, lists the given (literalized)
 *  pathspecs, and `git reset -q`s whatever among them has a staged INDEX (X)
 *  change — restoring the index entry from HEAD while leaving the worktree
 *  untouched (`M ` → ` M`, `A ` → `??`, `D ` → ` D`, `R ` → both sides
 *  reset). `git reset` (mixed), not `git restore --staged`: the repo only
 *  assumes git ≥ 2.x `add` semantics, and `reset -- <path>` handles the
 *  staged-deletion and unborn-branch shapes that `git add`/`restore` would
 *  fatal on. The path ARRAY makes the operation generic: per-item unstaging
 *  is the same operation with `{ paths: [item.path] }` — no new operation,
 *  no contract change. */
export const DOORSTOP_GIT_UNSTAGE_OPERATION = "doorstop.git-unstage";

/** One unstage request: the Doorstop-managed workspace-relative paths to
 *  unstage — identical shape and semantics to {@link DoorstopGitStageRequest}.
 *  NEVER empty (an empty unstage request is a contradiction the browser never
 *  emits); each path is validated by {@link isValidDoorstopItemPath} and
 *  deduplicated by the parser. */
export interface DoorstopGitUnstageRequest {
  paths: readonly string[];
}

/** The backend's structured result for one `doorstop.git-unstage` request —
 *  the inverse narration of {@link DoorstopGitStageResponse}. The outcome
 *  RESOLVES on every outcome and never surfaces as an infrastructure error. */
export interface DoorstopGitUnstageResponse {
  /** unstaged → paths were unstaged (`unstaged` count set); clean → nothing
   *  to unstage (every selected path already matches HEAD); skipped → not a
   *  git repository / deadline budget exhausted; failed → a git step errored
   *  (`stderr` excerpt). */
  status: "unstaged" | "clean" | "skipped" | "failed";
  /** Number of selected paths the `reset` covered ("unstaged" only). */
  unstaged?: number;
  /** Bounded stderr excerpt (≤ ~2 KiB; "failed" only). */
  stderr?: string;
}

/** The recognized unstage statuses (strict-enum style — the stage status set
 *  with `unstaged` in `staged`'s slot). */
const DOORSTOP_GIT_UNSTAGE_STATUSES = new Set<DoorstopGitUnstageResponse["status"]>([
  "unstaged",
  "clean",
  "skipped",
  "failed",
]);

/** Validate that `value` is one of the known unstage statuses. */
function parseDoorstopGitUnstageStatus(value: string): DoorstopGitUnstageResponse["status"] {
  if (!DOORSTOP_GIT_UNSTAGE_STATUSES.has(value as DoorstopGitUnstageResponse["status"])) {
    throw new Error(`Invalid doorstop git unstage status: ${JSON.stringify(value)}`);
  }
  return value as DoorstopGitUnstageResponse["status"];
}

/**
 * Parse and validate a `doorstop.git-unstage` request. Throws on junk:
 * non-object input, a missing or non-array `paths` field, an EMPTY `paths`
 * array (strict parity with the element guard — an empty unstage request is
 * a contradiction the browser never emits), or any path outside the
 * workspace-relative item-path grammar ({@link isValidDoorstopItemPath}).
 * Duplicate paths are deduplicated (first occurrence order preserved). Extra
 * keys are tolerated.
 */
export function parseDoorstopGitUnstageRequest(value: unknown): DoorstopGitUnstageRequest {
  const record = requireRecord(value, "Doorstop git unstage request");
  const paths = requireStringArray(record, "paths");
  if (paths.length === 0) {
    throw new Error("Invalid doorstop.git-unstage request: at least one path is required");
  }
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const path of paths) {
    if (!isValidDoorstopItemPath(path)) {
      throw new Error(`Invalid doorstop item path in field: paths`);
    }
    if (!seen.has(path)) {
      seen.add(path);
      uniquePaths.push(path);
    }
  }
  return { paths: uniquePaths };
}

/**
 * Parse and validate a `doorstop.git-unstage` response — strict, with the
 * same field/status coupling {@link parseDoorstopGitStageResponse} enforces:
 * an `unstaged` count on any status but `"unstaged"`, or a `stderr` excerpt
 * on any status but `"failed"`, is a malformed response and throws (nothing
 * is coerced or defaulted; extra keys tolerated).
 */
export function parseDoorstopGitUnstageResponse(value: unknown): DoorstopGitUnstageResponse {
  const record = requireRecord(value, "Doorstop git unstage response");
  const status = parseDoorstopGitUnstageStatus(requireString(record, "status"));
  const unstaged = optionalNumber(record, "unstaged");
  const stderr = optionalString(record, "stderr");
  // The JSDoc on {@link DoorstopGitUnstageResponse} couples the fields to
  // their statuses: `unstaged` is "unstaged" only, `stderr` is "failed"
  // only — the sibling stage parser's exact idiom.
  if (status !== "unstaged" && unstaged !== undefined) {
    throw new Error(`Only an "unstaged" outcome may carry "unstaged" (status: ${JSON.stringify(status)})`);
  }
  if (status !== "failed" && stderr !== undefined) {
    throw new Error(`Only a "failed" outcome may carry "stderr" (status: ${JSON.stringify(status)})`);
  }
  return {
    status,
    ...(unstaged === undefined ? {} : { unstaged }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

/** The fifth backend operation — the project-scoped commit action:
 *  `backend.request(DOORSTOP_GIT_COMMIT_OPERATION, { message })`. The
 *  server checks the repo, verifies the index holds changes
 *  (`git diff --cached --quiet`), and runs `git commit -m <message>` — NO
 *  pathspec, NO add: the commit records WHATEVER the staged index holds
 *  (Stage all's paths, the user's own staged files, review-pipeline
 *  commits), exactly like a CLI `git commit`; unstaged WIP is never swept
 *  in. The response REUSES {@link DoorstopCommitOutcome} verbatim. */
export const DOORSTOP_GIT_COMMIT_OPERATION = "doorstop.git-commit";

/** One commit request: the message to record with the staged index,
 *  validated by {@link isValidGitCommitMessage} — EMPTY and whitespace-only
 *  are rejected (git with an empty `-m` opens `$EDITOR` and would hang the
 *  exec until the deadline budget kills it; git itself aborts a
 *  whitespace-only message after cleanup — the browser must never send
 *  either). Injection safety needs no grammar here: the message travels as
 *  execFile **argv**, never a shell string; the grammar is UX/hygiene only.
 *  There is NO scope field — the commit records the staged index, period;
 *  scope is decided at staging time (Stage all, the user's own `git add`,
 *  or the review→commit pipeline). */
export interface DoorstopGitCommitRequest {
  message: string;
}

/** The backend's structured result for one `doorstop.git-commit` request —
 *  {@link DoorstopCommitOutcome} reused verbatim (`committed`/`clean`/
 *  `skipped`/`failed` + `sha`/`stderr`), narrated by the Last run status
 *  bar; the response always RESOLVES. */
export type DoorstopGitCommitResponse = DoorstopCommitOutcome;

/**
 * Whether `value` is a valid git commit message per the operation grammar
 * — the same validator idiom as {@link isValidDoorstopUid} /
 * {@link isValidDoorstopItemPath}: NON-BLANK (not empty, and not
 * whitespace-only), at most 2 000 characters, and SINGLE LINE (no C0
 * controls U+0000–U+001F — newlines included — no DEL, no C1 controls
 * U+007F–U+009F, and no Unicode line separators U+2028/U+2029 — the exact
 * control character class of {@link isValidDoorstopItemPath}). Empty is
 * rejected because git with an empty `-m` opens `$EDITOR` and would hang
 * the exec until the deadline budget kills it; whitespace-only is rejected
 * too — git itself aborts such a message after cleanup when it arrives
 * (constant `-m "   "` yields "Aborting commit due to empty commit
 * message"), and the browser's element guard trims before sending, so
 * neither should ever arrive here (and the server's
 * `parseDoorstopGitCommitRequest` TRIMS the message it returns, so the
 * contract and the element guard agree in both directions — a padded
 * message commits trimmed, never padded). The grammar is UX/hygiene only: the
 * message travels as execFile **argv**, never a shell string, so injection
 * safety needs no grammar here.
 */
export function isValidGitCommitMessage(value: string): boolean {
  if (value === "") return false;
  // Length cap (plan: ≤ 2 000 chars).
  if (value.length > 2000) return false;
  // Whitespace-only ("   "): git itself aborts a message that is empty
  // after cleanup, and the browser's element guard trims before checking
  // empty — reject it here so the contract and the element guard agree
  // (the empty-message rule has exactly one unambiguous reading).
  if (value.trim() === "") return false;
  // Single line: C0 controls (incl. \n and \r), DEL, the C1 controls, and
  // the Unicode line separators — same class as the item-path rule.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  return true;
}

/**
 * Parse and validate a `doorstop.git-commit` request. Throws on junk: a
 * missing or wrongly-typed `message`, or a message outside the commit
 * message grammar ({@link isValidGitCommitMessage}). The message is
 * TRIMMED in the parsed result — the element guard trims before sending,
 * so a padded message only arrives from a non-compliant caller (git would
 * commit the padding verbatim), and a server-side trim makes the contract
 * and the element guard agree in both directions. Extra keys are
 * tolerated.
 */
export function parseDoorstopGitCommitRequest(value: unknown): DoorstopGitCommitRequest {
  const record = requireRecord(value, "Doorstop git commit request");
  const message = requireString(record, "message");
  if (!isValidGitCommitMessage(message)) {
    throw new Error(
      "Invalid git commit message — must be a non-blank single line of at most 2000 characters",
    );
  }
  return { message: message.trim() };
}

/**
 * Strict response parser for `doorstop.git-commit` — exactly
 * {@link parseDoorstopCommitOutcome} (the commit operation reuses the
 * review→commit {@link DoorstopCommitOutcome} shape verbatim, and the
 * field/status coupling — `sha` only on `committed`, `stderr` only on
 * `failed` — is already enforced there), exported under the operation's own
 * name so the dispatch side reads symmetrically with the status/stage
 * parsers. One parser, no second copy.
 */
export const parseDoorstopGitCommitResponse = parseDoorstopCommitOutcome;
