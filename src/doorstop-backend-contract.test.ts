// @vitest-environment node
//
// Contract tests for the paired-server boundary module
// (src/doorstop-backend-contract.ts), per plan Phase A steps 1–4 (and step
// 17's contract tests) — the TWO operation names, request/response shapes,
// strict parse validators, and the UID/publish-target/item-path grammars
// shared by the browser and server bundles.
// Pure node environment: the module carries no DOM and no host imports.
//
// The parity tests import the ported grammar consumers — the element-level
// Link/Unlink guard (doorstop-panel-elements.ts `isValidTargetUid`, which
// now aliases `isValidDoorstopUid` by identity) and the settings chain
// (doorstop-settings.ts `parseOpendoorSettings`, which now delegates to
// `isValidPublishTarget`) — and assert the shared validators agree with
// them on a positive AND negative corpus (the bad targets mirror the
// element test's no-shell-injection corpus).

import { describe, expect, it } from "vitest";
import {
  DOORSTOP_BASELINE_BLOB_MAX,
  DOORSTOP_BASELINE_GREP_LIMIT,
  DOORSTOP_BASELINE_HISTORY_LIMIT,
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_RUN_OPERATION,
  isValidDoorstopItemPath,
  isValidDoorstopUid,
  isValidPublishTarget,
  OPENDOOR_PLUGIN_ID,
  parseDoorstopBaselineRequest,
  parseDoorstopBaselineResponse,
  parseDoorstopCommitOutcome,
  parseDoorstopGitStageResponse,
  parseDoorstopGitStatusResponse,
  parseDoorstopRunRequest,
  parseDoorstopRunResponse,
  type DoorstopBaselineResponse,
  type DoorstopRunResponse,
} from "./doorstop-backend-contract.js";
import { isValidTargetUid } from "./doorstop-panel-elements.js";
import { DEFAULT_OPENDOOR_SETTINGS, parseOpendoorSettings } from "./doorstop-settings.js";

/** The server's exact output shape: `ServerPluginExecFileResult` fields
 *  (exitCode/signal/stdout/stderr/truncation flags) + `op` + `durationMs`.
 *  `overrides` replace fields for the junk cases. */
function validResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "validate",
    exitCode: 0,
    signal: null,
    stdout: "doorstop 1.0.0",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 12,
    ...overrides,
  };
}

describe("constants", () => {
  it("exposes the plugin id and the single backend operation name", () => {
    expect(OPENDOOR_PLUGIN_ID).toBe("opendoor");
    expect(DOORSTOP_RUN_OPERATION).toBe("doorstop.run");
    // The host's operation-name grammar: lowercase letter, then letters /
    // digits / dots / hyphens.
    expect(DOORSTOP_RUN_OPERATION).toMatch(/^[a-z][a-z0-9.-]*$/);
  });
});

describe("baseline constants", () => {
  it("exposes the item-baseline operation name, matching the host operation grammar", () => {
    expect(DOORSTOP_BASELINE_OPERATION).toBe("doorstop.item-baseline");
    // The host's operation-name grammar: lowercase letter, then letters /
    // digits / dots / hyphens.
    expect(DOORSTOP_BASELINE_OPERATION).toMatch(/^[a-z][a-z0-9.-]*$/);
  });

  it("pins the three baseline limits the server and browser share", () => {
    expect(DOORSTOP_BASELINE_GREP_LIMIT).toBe(20);
    expect(DOORSTOP_BASELINE_HISTORY_LIMIT).toBe(50);
    expect(DOORSTOP_BASELINE_BLOB_MAX).toBe(256 * 1024);
  });
});

describe("parseDoorstopRunResponse", () => {
  it("accepts the server's exact output shape for every op", () => {
    for (const op of ["validate", "publish", "review", "clear", "edit", "link", "unlink"]) {
      // Compile-time proof that the parser's result is assignable to the
      // contract's response type.
      const parsed: DoorstopRunResponse = parseDoorstopRunResponse(validResponse({ op }));
      expect(parsed).toEqual(validResponse({ op }));
      expect(parsed.op).toBe(op);
    }
  });

  it("accepts a killed shape: exitCode null, signal set, partial output preserved, truncation flagged", () => {
    const killed = validResponse({
      op: "publish",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "partial output",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: true,
      durationMs: 0,
    });
    expect(parseDoorstopRunResponse(killed)).toEqual(killed);
  });

  it("rejects non-object junk: null, undefined, arrays, primitives", () => {
    for (const junk of [null, undefined, [], ["op"], "string", 42, true]) {
      expect(() => parseDoorstopRunResponse(junk)).toThrow(/must be an object/);
    }
  });

  it("rejects missing required fields", () => {
    const fields = ["op", "exitCode", "signal", "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "durationMs"];
    for (const field of fields) {
      const { [field]: _removed, ...rest } = validResponse();
      expect(() => parseDoorstopRunResponse(rest)).toThrow();
    }
  });

  it("rejects wrong-typed fields", () => {
    expect(() => parseDoorstopRunResponse(validResponse({ op: 42 }))).toThrow(/Expected string field: op/);
    expect(() => parseDoorstopRunResponse(validResponse({ exitCode: "0" }))).toThrow(/Expected finite number or null field: exitCode/);
    expect(() => parseDoorstopRunResponse(validResponse({ exitCode: NaN }))).toThrow(/finite number/);
    expect(() => parseDoorstopRunResponse(validResponse({ exitCode: Infinity }))).toThrow(/finite number/);
    expect(() => parseDoorstopRunResponse(validResponse({ signal: 5 }))).toThrow(/Expected string or null field: signal/);
    expect(() => parseDoorstopRunResponse(validResponse({ signal: [] }))).toThrow(/string or null/);
    expect(() => parseDoorstopRunResponse(validResponse({ signal: "" }))).toThrow(/Expected non-empty string or null field: signal/);
    expect(() => parseDoorstopRunResponse(validResponse({ stdout: null }))).toThrow(/Expected string field: stdout/);
    expect(() => parseDoorstopRunResponse(validResponse({ stderr: ["x"] }))).toThrow(/Expected string field: stderr/);
    expect(() => parseDoorstopRunResponse(validResponse({ stdoutTruncated: "yes" }))).toThrow(/Expected boolean field: stdoutTruncated/);
    expect(() => parseDoorstopRunResponse(validResponse({ stderrTruncated: 1 }))).toThrow(/Expected boolean field: stderrTruncated/);
    expect(() => parseDoorstopRunResponse(validResponse({ durationMs: "10" }))).toThrow(/Expected finite number field: durationMs/);
  });

  it("rejects an unknown or empty op", () => {
    expect(() => parseDoorstopRunResponse(validResponse({ op: "purge" }))).toThrow(/Invalid doorstop run op/);
    expect(() => parseDoorstopRunResponse(validResponse({ op: "" }))).toThrow(/Invalid doorstop run op/);
  });

  it("accepts the optional commit outcome on a response (compile-time proof)", () => {
    const withCommit = validResponse({
      op: "review",
      commit: { status: "committed", sha: "abc1234" },
    });
    const parsed: DoorstopRunResponse = parseDoorstopRunResponse(withCommit);
    expect(parsed).toEqual(withCommit);
    expect(parsed.commit).toEqual({ status: "committed", sha: "abc1234" });
  });

  it("omits the commit field when the response carries none", () => {
    const parsed = parseDoorstopRunResponse(validResponse());
    expect(parsed).toEqual(validResponse());
    expect("commit" in parsed).toBe(false);
  });

  it("rejects a wrongly-typed commit field", () => {
    expect(() => parseDoorstopRunResponse(validResponse({ commit: "yes" }))).toThrow(/must be an object/);
    expect(() => parseDoorstopRunResponse(validResponse({ commit: { status: "unknown" } }))).toThrow(/Invalid doorstop commit status/);
    expect(() => parseDoorstopRunResponse(validResponse({ commit: { status: "failed", stderr: 42 } }))).toThrow(/Expected string field: stderr/);
  });

  it("pins the commit field's null-vs-undefined asymmetry (null throws, undefined omits)", () => {
    // Undefined (absent) → the field is omitted from the parsed result
    // (see the omission test above). null → throws: the host JSON bridge
    // emits null for the `exitCode`/`signal` values, never for an optional
    // object field — a null commit is junk, not an absent outcome (the
    // request parser omits `commit` under the default, so a well-formed
    // response never carries the field as null).
    expect(() => parseDoorstopRunResponse(validResponse({ commit: null }))).toThrow(/must be an object/);
  });
});

describe("parseDoorstopRunRequest", () => {
  it("accepts the validate request (and tolerates extra keys, forward compat)", () => {
    expect(parseDoorstopRunRequest({ op: "validate" })).toEqual({ op: "validate" });
    expect(parseDoorstopRunRequest({ op: "validate", futureField: 1 })).toEqual({ op: "validate" });
  });

  it("accepts each op variant with its required fields", () => {
    expect(parseDoorstopRunRequest({ op: "publish", target: "./public" })).toEqual({ op: "publish", target: "./public" });
    expect(parseDoorstopRunRequest({ op: "review", uid: "REQ0001" })).toEqual({ op: "review", uid: "REQ0001" });
    expect(parseDoorstopRunRequest({ op: "clear", uid: "REQ0001", parents: ["TST001", "TST002"] })).toEqual({
      op: "clear",
      uid: "REQ0001",
      parents: ["TST001", "TST002"],
    });
    expect(parseDoorstopRunRequest({ op: "edit", uid: "REQ0001" })).toEqual({ op: "edit", uid: "REQ0001" });
    expect(parseDoorstopRunRequest({ op: "link", uid: "REQ0001", target: "TST001" })).toEqual({
      op: "link",
      uid: "REQ0001",
      target: "TST001",
    });
    expect(parseDoorstopRunRequest({ op: "unlink", uid: "REQ0001", target: "TST-ALPHA" })).toEqual({
      op: "unlink",
      uid: "REQ0001",
      target: "TST-ALPHA",
    });
  });

  it("accepts a review request with and without the optional commit flag", () => {
    // Absent (today's shape) and explicit true/false all parse; the field
    // is omitted from the result when absent (exactOptionalPropertyTypes).
    expect(parseDoorstopRunRequest({ op: "review", uid: "REQ0001" })).toEqual({ op: "review", uid: "REQ0001" });
    expect(parseDoorstopRunRequest({ op: "review", uid: "REQ0001", commit: true })).toEqual({
      op: "review",
      uid: "REQ0001",
      commit: true,
    });
    expect(parseDoorstopRunRequest({ op: "review", uid: "REQ0001", commit: false })).toEqual({
      op: "review",
      uid: "REQ0001",
      commit: false,
    });
  });

  it("rejects a wrongly-typed commit flag on the review variant", () => {
    expect(() => parseDoorstopRunRequest({ op: "review", uid: "REQ0001", commit: "yes" })).toThrow(
      /Expected boolean field: commit/,
    );
    expect(() => parseDoorstopRunRequest({ op: "review", uid: "REQ0001", commit: 1 })).toThrow(/Expected boolean field: commit/);
    expect(() => parseDoorstopRunRequest({ op: "review", uid: "REQ0001", commit: null })).toThrow(/Expected boolean field: commit/);
  });

  it("rejects non-object requests", () => {
    for (const junk of [null, undefined, [], "validate", 42, true]) {
      expect(() => parseDoorstopRunRequest(junk)).toThrow(/must be an object/);
    }
  });

  it("rejects unknown, empty, and non-string ops, and a missing op", () => {
    expect(() => parseDoorstopRunRequest({ op: "purge" })).toThrow(/Invalid doorstop run op/);
    expect(() => parseDoorstopRunRequest({ op: "" })).toThrow(/Invalid doorstop run op/);
    expect(() => parseDoorstopRunRequest({ op: 42 })).toThrow(/Expected string field: op/);
    expect(() => parseDoorstopRunRequest({})).toThrow(/Expected string field: op/);
  });

  it("accepts safe workspace-relative publish targets", () => {
    for (const target of ["./public", "public", "docs/site", "a/b/c", ".hidden", "x-y_z.1"]) {
      expect(parseDoorstopRunRequest({ op: "publish", target })).toMatchObject({ target });
    }
  });

  it("rejects absolute, drive-letter, backslash, traversal, leading-dash, and empty publish targets", () => {
    for (const target of ["/abs", "/../abs", "C:/win", "c:\\win", "out\\dir", "a/../b", "../escape", "-x", "-public", ""]) {
      expect(() => parseDoorstopRunRequest({ op: "publish", target })).toThrow(/Invalid publish target/);
    }
  });

  it("rejects publish requests missing or mistyping the target", () => {
    expect(() => parseDoorstopRunRequest({ op: "publish" })).toThrow(/Expected string field: target/);
    expect(() => parseDoorstopRunRequest({ op: "publish", target: 42 })).toThrow(/Expected string field: target/);
  });

  it("rejects UIDs outside the grammar in every uid field", () => {
    const badUids = ["", "0001", "REQ", "REQ-", "REQ0 001", "REQ0001; echo pwn", "REQ0001 && rm -rf /", 'REQ0001"|cat', "REQ0001$(id)", "REQ%01", "REQ\u00e9"];
    for (const uid of badUids) {
      expect(() => parseDoorstopRunRequest({ op: "review", uid })).toThrow(/Invalid doorstop UID in field: uid/);
      expect(() => parseDoorstopRunRequest({ op: "edit", uid })).toThrow(/Invalid doorstop UID in field: uid/);
      expect(() => parseDoorstopRunRequest({ op: "link", uid, target: "TST001" })).toThrow(/Invalid doorstop UID in field: uid/);
      expect(() => parseDoorstopRunRequest({ op: "unlink", uid, target: "TST001" })).toThrow(/Invalid doorstop UID in field: uid/);
    }
  });

  it("rejects invalid link/unlink target UIDs", () => {
    const badTargets = ["", "0001", "REQ0 001", "REQ0001;rm -rf /"];
    for (const target of badTargets) {
      expect(() => parseDoorstopRunRequest({ op: "link", uid: "REQ0001", target })).toThrow(/Invalid doorstop UID in field: target/);
      expect(() => parseDoorstopRunRequest({ op: "unlink", uid: "REQ0001", target })).toThrow(/Invalid doorstop UID in field: target/);
    }
  });

  it("rejects missing uid/target fields on the uid-bearing ops", () => {
    expect(() => parseDoorstopRunRequest({ op: "review" })).toThrow(/Expected string field: uid/);
    expect(() => parseDoorstopRunRequest({ op: "edit" })).toThrow(/Expected string field: uid/);
    expect(() => parseDoorstopRunRequest({ op: "link", uid: "REQ0001" })).toThrow(/Expected string field: target/);
    expect(() => parseDoorstopRunRequest({ op: "unlink", uid: "REQ0001" })).toThrow(/Expected string field: target/);
  });

  it("validates clear parents as a non-empty string array of UIDs", () => {
    // Missing or non-array parents is junk (the server argv needs the field).
    expect(() => parseDoorstopRunRequest({ op: "clear", uid: "REQ0001" })).toThrow(/must be an array/);
    expect(() => parseDoorstopRunRequest({ op: "clear", uid: "REQ0001", parents: "TST001" })).toThrow(/must be an array/);
    expect(() => parseDoorstopRunRequest({ op: "clear", uid: "REQ0001", parents: [42] })).toThrow(/Expected string array field: parents/);
    expect(() => parseDoorstopRunRequest({ op: "clear", uid: "REQ0001", parents: ["bad uid"] })).toThrow(/Invalid doorstop UID in field: parents/);
    // An empty parents list is rejected for strict parity with the element
    // guard: the Clear button is disabled at zero suspects, so a clear
    // request with no parents is a contradiction the browser never emits.
    expect(() => parseDoorstopRunRequest({ op: "clear", uid: "REQ0001", parents: [] })).toThrow(/at least one parent/);
  });
});

describe("parseDoorstopCommitOutcome", () => {
  it("accepts every status, with and without the optional excerpts", () => {
    expect(parseDoorstopCommitOutcome({ status: "committed", sha: "abc1234" })).toEqual({ status: "committed", sha: "abc1234" });
    expect(parseDoorstopCommitOutcome({ status: "committed" })).toEqual({ status: "committed" });
    expect(parseDoorstopCommitOutcome({ status: "clean" })).toEqual({ status: "clean" });
    expect(parseDoorstopCommitOutcome({ status: "skipped" })).toEqual({ status: "skipped" });
    expect(parseDoorstopCommitOutcome({ status: "failed", stderr: "fatal: not a git repository" })).toEqual({
      status: "failed",
      stderr: "fatal: not a git repository",
    });
  });

  it("rejects an unknown status (nothing is defaulted)", () => {
    expect(() => parseDoorstopCommitOutcome({ status: "pushed" })).toThrow(/Invalid doorstop commit status/);
    expect(() => parseDoorstopCommitOutcome({ status: "" })).toThrow(/Invalid doorstop commit status/);
    expect(() => parseDoorstopCommitOutcome({ status: 42 })).toThrow(/Expected string field: status/);
    expect(() => parseDoorstopCommitOutcome({})).toThrow(/Expected string field: status/);
  });

  it("rejects non-object junk and wrongly-typed optional excerpts", () => {
    for (const junk of [null, undefined, [], "committed", 42, true]) {
      expect(() => parseDoorstopCommitOutcome(junk)).toThrow(/must be an object/);
    }
    expect(() => parseDoorstopCommitOutcome({ status: "failed", stderr: 42 })).toThrow(/Expected string field: stderr/);
    expect(() => parseDoorstopCommitOutcome({ status: "committed", sha: [] })).toThrow(/Expected string field: sha/);
    expect(() => parseDoorstopCommitOutcome({ status: "committed", sha: 7 })).toThrow(/Expected string field: sha/);
  });

  it("ties sha to committed and stderr to failed — a stray excerpt on any other status throws", () => {
    // The outcome JSDoc declares sha "committed only" and stderr "failed
    // only"; the parser enforces that coupling. `{ status: "clean", sha }`,
    // `{ status: "committed", stderr }`, etc. are malformed outcomes — the
    // field is rejected, never silently ignored (strict-parse idiom).
    expect(() => parseDoorstopCommitOutcome({ status: "clean", sha: "abc1234" })).toThrow(
      /Only a "committed" outcome may carry "sha"/,
    );
    expect(() => parseDoorstopCommitOutcome({ status: "skipped", sha: "abc1234" })).toThrow(/Only a "committed" outcome may carry "sha"/);
    expect(() => parseDoorstopCommitOutcome({ status: "failed", sha: "abc1234" })).toThrow(/Only a "committed" outcome may carry "sha"/);
    expect(() => parseDoorstopCommitOutcome({ status: "committed", stderr: "fatal: oops" })).toThrow(
      /Only a "failed" outcome may carry "stderr"/,
    );
    expect(() => parseDoorstopCommitOutcome({ status: "clean", stderr: "fatal: oops" })).toThrow(/Only a "failed" outcome may carry "stderr"/);
    expect(() => parseDoorstopCommitOutcome({ status: "skipped", stderr: "fatal: oops" })).toThrow(/Only a "failed" outcome may carry "stderr"/);
    // The legal pairings still parse: sha only on committed, stderr only on failed.
    expect(parseDoorstopCommitOutcome({ status: "committed", sha: "abc1234" })).toEqual({ status: "committed", sha: "abc1234" });
    expect(parseDoorstopCommitOutcome({ status: "failed", stderr: "fatal: oops" })).toEqual({ status: "failed", stderr: "fatal: oops" });
  });
});

/** The server's exact baseline response shape; `overrides` replace fields
 *  for the junk cases (mirrors `validResponse` above). */
function validBaselineResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    git: true,
    source: "none",
    candidates: [],
    ...overrides,
  };
}

describe("parseDoorstopBaselineRequest", () => {
  it("accepts a valid request and tolerates extra keys (forward compat)", () => {
    expect(parseDoorstopBaselineRequest({ uid: "REQ0001", path: "docs/reqs/REQ0001.yml" })).toEqual({
      uid: "REQ0001",
      path: "docs/reqs/REQ0001.yml",
    });
    expect(parseDoorstopBaselineRequest({ uid: "REQ0001", path: "docs/reqs/REQ0001.yml", futureField: 1 })).toEqual({
      uid: "REQ0001",
      path: "docs/reqs/REQ0001.yml",
    });
  });

  it("rejects non-object junk", () => {
    for (const junk of [null, undefined, [], "REQ0001", 42, true]) {
      expect(() => parseDoorstopBaselineRequest(junk)).toThrow(/must be an object/);
    }
  });

  it("rejects missing and wrongly-typed fields", () => {
    expect(() => parseDoorstopBaselineRequest({ uid: "REQ0001" })).toThrow(/Expected string field: path/);
    expect(() => parseDoorstopBaselineRequest({ path: "docs/reqs/REQ0001.yml" })).toThrow(/Expected string field: uid/);
    expect(() => parseDoorstopBaselineRequest({ uid: 42, path: "docs/reqs/REQ0001.yml" })).toThrow(/Expected string field: uid/);
    expect(() => parseDoorstopBaselineRequest({ uid: "REQ0001", path: null })).toThrow(/Expected string field: path/);
  });

  it("rejects UIDs outside the item grammar", () => {
    for (const uid of ["", "REQ", "REQ0001; echo pwn", "REQ0 001"]) {
      expect(() => parseDoorstopBaselineRequest({ uid, path: "docs/reqs/REQ0001.yml" })).toThrow(/Invalid doorstop UID in field: uid/);
    }
  });

  it("rejects unsafe item paths, mirroring the item-path rule", () => {
    for (const path of [
      "..",
      "../escape.yml",
      "docs/../../etc/passwd",
      "docs/..",
      "/abs/REQ0001.yml",
      "//abs",
      "C:/win/REQ0001.yml",
      "c:\\win\\REQ0001.yml",
      "docs\\REQ0001.yml",
      "docs/REQ0001\n.yml",
      "docs/REQ0001\r.yml",
      "docs/\u0000REQ0001.yml",
      "docs/REQ0001\u007f.yml",
      "docs/REQ0001\u0085.yml",
      "docs/REQ0001\u2028.yml",
      "a".repeat(257),
    ]) {
      expect(() => parseDoorstopBaselineRequest({ uid: "REQ0001", path })).toThrow(/Invalid doorstop item path/);
    }
  });

  it("accepts item paths at the 256-char boundary", () => {
    const exactly256 = "docs/" + "a".repeat(247) + ".yml";
    const beyond256 = "docs/" + "a".repeat(248) + ".yml";
    expect(parseDoorstopBaselineRequest({ uid: "REQ0001", path: exactly256 })).toMatchObject({ path: exactly256 });
    expect(() => parseDoorstopBaselineRequest({ uid: "REQ0001", path: beyond256 })).toThrow(/Invalid doorstop item path/);
  });
});

describe("parseDoorstopBaselineResponse", () => {
  it("accepts a happy path with candidates (compile-time proof via the response type)", () => {
    const resp = validBaselineResponse({
      source: "review-commit",
      candidates: [
        { sha: "abc1234", blob: "uid: REQ0001\ntext: reviewed version" },
        { sha: "def5678", blob: "uid: REQ0001\ntext: older version" },
      ],
    });
    const parsed: DoorstopBaselineResponse = parseDoorstopBaselineResponse(resp);
    expect(parsed).toEqual(resp);
    expect(parsed.candidates[0]).toEqual({ sha: "abc1234", blob: "uid: REQ0001\ntext: reviewed version" });
  });

  it("accepts the no-git and generic-history shapes", () => {
    expect(parseDoorstopBaselineResponse({ git: false, source: "none", candidates: [] })).toEqual({
      git: false,
      source: "none",
      candidates: [],
    });
    expect(parseDoorstopBaselineResponse({ git: true, source: "history", candidates: [] })).toEqual({
      git: true,
      source: "history",
      candidates: [],
    });
  });

  it("rejects non-object junk", () => {
    for (const junk of [null, undefined, [], "x", 42, true]) {
      expect(() => parseDoorstopBaselineResponse(junk)).toThrow(/must be an object/);
    }
  });

  it("rejects missing required fields", () => {
    for (const field of ["git", "source", "candidates"]) {
      const { [field]: _removed, ...rest } = validBaselineResponse();
      expect(() => parseDoorstopBaselineResponse(rest)).toThrow();
    }
  });

  it("rejects unknown sources and wrongly-typed fields", () => {
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ source: "grep" }))).toThrow(
      /Invalid doorstop baseline source/,
    );
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ source: "" }))).toThrow(/Invalid doorstop baseline source/);
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ git: "yes" }))).toThrow(/Expected boolean field: git/);
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: {} }))).toThrow(/must be an array/);
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: "x" }))).toThrow(/must be an array/);
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: ["junk"] }))).toThrow(/must be an object/);
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: [{ sha: 42, blob: "x" }] }))).toThrow(
      /Expected string field: sha/,
    );
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: [{ sha: "abc", blob: null }] }))).toThrow(
      /Expected string field: blob/,
    );
    expect(() => parseDoorstopBaselineResponse(validBaselineResponse({ candidates: [{ sha: "abc" }] }))).toThrow(
      /Expected string field: blob/,
    );
  });
});

describe("UID grammar (isValidDoorstopUid, shared with the element guard)", () => {
  const validUids = [
    "REQ0001",
    "REQ0001-EXT", // prefix + separator + name
    "REQ-001",
    "REQ_001",
    "REQ-ALPHA",
    "REQ.1",
    "TST-42",
    "A1", // one-letter prefix ending in a non-digit + digits
    "3REQ1", // leading digits are part of the prefix (split_uid quirk preserved)
  ];
  const invalidUids = [
    "",
    "0001", // no prefix
    "REQ", // prefix but no digits/name
    "X", // single letter, neither digits nor name follow
    "REQ-", // separator with nothing after it
    "REQ0 001", // internal whitespace
    "REQ0001; echo pwn",
    "REQ0001 && rm -rf /",
    'REQ0001"|cat',
    "REQ0001$(id)",
    "REQ%01", // % outside the UID alphabet
    "REQ\u00e9", // non-ASCII outside the UID alphabet
  ];

  it("accepts the positive corpus", () => {
    for (const uid of validUids) expect(isValidDoorstopUid(uid)).toBe(true);
  });

  it("rejects the negative corpus", () => {
    for (const uid of invalidUids) expect(isValidDoorstopUid(uid)).toBe(false);
  });

  it("agrees with the element-level Link/Unlink guard on the whole corpus (parity)", () => {
    for (const uid of [...validUids, ...invalidUids]) {
      expect(isValidTargetUid(uid), uid).toBe(isValidDoorstopUid(uid));
    }
  });

  it("is the element-level guard itself: `isValidTargetUid` aliases the contract grammar by identity", () => {
    expect(isValidTargetUid).toBe(isValidDoorstopUid);
  });
});

describe("publish-target rule (isValidPublishTarget, shared with the settings chain)", () => {
  it("rejects absolute, drive-letter, backslash, traversal, leading-dash, and empty targets", () => {
    for (const target of ["/abs", "/x", "C:/win", "c:\\win", "out\\dir", "a/../b", "..", "../escape", "-x", "-public", ""]) {
      expect(isValidPublishTarget(target), target).toBe(false);
    }
  });

  it("accepts workspace-relative targets", () => {
    for (const target of ["./public", "public", "docs/site", "a/b/c", ".hidden", "x-y_z.1"]) {
      expect(isValidPublishTarget(target), target).toBe(true);
    }
  });

  it("agrees with the settings chain: parseOpendoorSettings accepts exactly the same targets (parity)", () => {
    for (const target of ["/abs", "C:/win", "out\\dir", "a/../b", "-x", ""]) {
      expect(isValidPublishTarget(target), target).toBe(false);
      const result = parseOpendoorSettings({ publishTarget: target });
      expect(result.settings.publishTarget).toBe(DEFAULT_OPENDOOR_SETTINGS.publishTarget);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    for (const target of ["./public", "public", "docs/site"]) {
      expect(isValidPublishTarget(target), target).toBe(true);
      expect(parseOpendoorSettings({ publishTarget: target }).settings.publishTarget).toBe(target);
    }
  });
});

describe("item-path rule (isValidDoorstopItemPath)", () => {
  it("accepts workspace-relative item paths with any extension", () => {
    for (const path of [
      "REQ0001.yml",
      "docs/reqs/REQ0001.yml",
      "docs/reqs/REQ-ALPHA.md",
      "./docs/REQ0001.yml",
      ".hidden/REQ0001.yml",
      "a/b/c/deep.yml",
      "docs/" + "a".repeat(247) + ".yml", // exactly 256 chars
    ]) {
      expect(isValidDoorstopItemPath(path), path).toBe(true);
    }
  });

  it("rejects empty, absolute, drive-letter, backslash, and traversal paths", () => {
    for (const path of [
      "",
      "/abs",
      "/abs/REQ0001.yml",
      "//abs",
      "C:/win/REQ0001.yml",
      "C:",
      "c:\\win\\REQ0001.yml",
      "docs\\REQ0001.yml",
      "..",
      "../REQ0001.yml",
      "docs/../../etc/passwd",
      "docs/..",
      "a/../b",
    ]) {
      expect(isValidDoorstopItemPath(path), path).toBe(false);
    }
  });

  it("rejects control characters and line breaks (single line)", () => {
    for (const path of [
      "docs/REQ0001\n.yml",
      "docs/REQ0001\r.yml",
      "docs/\u0000REQ0001.yml",
      "docs/\u0007REQ0001.yml",
      "docs/REQ0001\u007f.yml",
      // C1 controls (U+0080–U+009F) are controls too — the plan's "no
      // control characters" rule covers them, not just C0/DEL.
      "docs/REQ0001\u0085.yml",
      "docs/REQ0001\u009f.yml",
      "docs/REQ0001\u2028.yml",
      "docs/REQ0001\u2029.yml",
    ]) {
      expect(isValidDoorstopItemPath(path), path).toBe(false);
    }
  });

  it("rejects paths over 256 characters", () => {
    expect(isValidDoorstopItemPath("a".repeat(257))).toBe(false);
    expect(isValidDoorstopItemPath("docs/" + "a".repeat(248) + ".yml")).toBe(false); // 257 chars
  });
});
describe("git count guards (negative counts are impossible junk, nothing coerced)", () => {
  it("rejects negative ahead/behind/staged/dirty counts in the status response", () => {
    expect(parseDoorstopGitStatusResponse({ git: true, staged: 0, dirty: 1, files: [] })).toEqual({
      git: true,
      staged: 0,
      dirty: 1,
      files: [],
    });
    // `Number.isFinite` alone would let an impossible -3 file/commit count
    // through; the module's standing rule is: junk of any kind throws.
    expect(() =>
      parseDoorstopGitStatusResponse({
        git: true,
        branch: "main",
        ahead: -1,
        behind: 0,
        staged: 0,
        dirty: 0,
        files: [],
      }),
    ).toThrow(/non-negative count field: ahead/);
    expect(() =>
      parseDoorstopGitStatusResponse({
        git: true,
        ahead: 1,
        behind: -2,
        staged: 0,
        dirty: 0,
        files: [],
      }),
    ).toThrow(/non-negative count field: behind/);
    expect(() =>
      parseDoorstopGitStatusResponse({
        git: true,
        ahead: 1,
        behind: 2,
        staged: -3,
        dirty: 0,
        files: [],
      }),
    ).toThrow(/non-negative count field: staged/);
    expect(() =>
      parseDoorstopGitStatusResponse({
        git: true,
        ahead: 1,
        behind: 2,
        staged: 0,
        dirty: -4,
        files: [],
      }),
    ).toThrow(/non-negative count field: dirty/);
  });

  it("rejects a negative staged count in the stage response (and keeps positive counts)", () => {
    expect(parseDoorstopGitStageResponse({ status: "staged", staged: 3 })).toEqual({
      status: "staged",
      staged: 3,
    });
    expect(() => parseDoorstopGitStageResponse({ status: "staged", staged: -1 })).toThrow(
      /non-negative count field: staged/,
    );
  });
});
