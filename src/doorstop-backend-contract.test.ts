// @vitest-environment node
//
// Contract tests for the paired-server boundary module
// (src/doorstop-backend-contract.ts), per plan Phase A step 1 — the ONE
// operation name, request/response shapes, strict parse validators, and the
// UID/publish-target grammars shared by the browser and server bundles.
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
  DOORSTOP_RUN_OPERATION,
  isValidDoorstopUid,
  isValidPublishTarget,
  OPENDOOR_PLUGIN_ID,
  parseDoorstopRunRequest,
  parseDoorstopRunResponse,
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