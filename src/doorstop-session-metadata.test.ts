// @vitest-environment node
//
// Unit tests for the shared public session-metadata schema (relay
// `opendoor-session-metadata-labels` design §2): the strict server-side
// builder and the tolerant browser-side parser, including the secrets policy
// (exactly the three schema keys) and junk/foreign/future-schema tolerance.

import { describe, expect, it } from "vitest";
import {
  buildDoorstopSessionMetadata,
  DOORSTOP_SESSION_METADATA_MAX_UIDS,
  DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH,
  DOORSTOP_SESSION_METADATA_SCHEMA,
  OPENDOOR_SESSION_METADATA_NAMESPACE,
  parseDoorstopSessionMetadata,
  type DoorstopSessionMetadataOp,
} from "./doorstop-session-metadata.js";

/** Opaque cast for the unknown-op rejection case (the public type is the
 *  reviewed enum; the test feeds the runtime a value outside it). */
function asOp(value: string): DoorstopSessionMetadataOp {
  return value as DoorstopSessionMetadataOp;
}

describe("buildDoorstopSessionMetadata", () => {
  it("round-trips through the tolerant parser and pins the namespace/schema", () => {
    expect(OPENDOOR_SESSION_METADATA_NAMESPACE).toBe("opendoor");
    expect(DOORSTOP_SESSION_METADATA_SCHEMA).toBe(1);

    const built = buildDoorstopSessionMetadata("review", ["REQ0001", "TST0002"]);
    expect(built).toEqual({ schema: 1, op: "review", uids: ["REQ0001", "TST0002"] });
    expect(parseDoorstopSessionMetadata(built)).toEqual(built);
    expect(parseDoorstopSessionMetadata({ ...built })).toEqual(built);
  });

  it("publishes exactly the three schema keys (secrets policy by construction)", () => {
    const built = buildDoorstopSessionMetadata("review", ["REQ0001"]);
    expect(Object.keys(built).sort()).toEqual(["op", "schema", "uids"]);
  });

  it("copies the UID list so frozen/aliased inputs cannot leak aliases", () => {
    const uids = Object.freeze(["REQ0001"]);
    const built = buildDoorstopSessionMetadata("review", uids);
    expect(built.uids).not.toBe(uids);
    expect(built.uids).toEqual(["REQ0001"]);
  });

  it("rejects junk: unknown op, empty/oversized lists, and invalid UIDs", () => {
    expect(() => buildDoorstopSessionMetadata(asOp("delete"), ["REQ0001"])).toThrow(
      "Unsupported doorstop session metadata op",
    );
    expect(() => buildDoorstopSessionMetadata("review", [])).toThrow("requires 1..8 UIDs");
    expect(() =>
      buildDoorstopSessionMetadata(
        "review",
        Array.from({ length: DOORSTOP_SESSION_METADATA_MAX_UIDS + 1 }, (_, i) => `REQ${String(i)}`),
      ),
    ).toThrow("requires 1..8 UIDs");
    expect(() => buildDoorstopSessionMetadata("review", [""])).toThrow("Invalid doorstop session metadata UID");
    expect(() => buildDoorstopSessionMetadata("review", ["bad uid"])).toThrow(
      "Invalid doorstop session metadata UID",
    );
    expect(() =>
      buildDoorstopSessionMetadata("review", ["R".repeat(DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH + 1)]),
    ).toThrow("Invalid doorstop session metadata UID");
    // The bound is inclusive: exactly 32 characters is still publishable.
    expect(
      buildDoorstopSessionMetadata("review", ["R".repeat(DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH)]).uids,
    ).toHaveLength(1);
  });
});

describe("parseDoorstopSessionMetadata", () => {
  it("returns undefined for absent, non-object, and foreign shapes", () => {
    expect(parseDoorstopSessionMetadata(undefined)).toBeUndefined();
    expect(parseDoorstopSessionMetadata(null)).toBeUndefined();
    expect(parseDoorstopSessionMetadata("REQ0001")).toBeUndefined();
    expect(parseDoorstopSessionMetadata(42)).toBeUndefined();
    expect(parseDoorstopSessionMetadata([])).toBeUndefined();
    expect(parseDoorstopSessionMetadata({})).toBeUndefined();
  });

  it("returns undefined for a future schema, unknown op, and malformed UID lists", () => {
    expect(parseDoorstopSessionMetadata({ schema: 2, op: "review", uids: ["REQ0001"] })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "merge", uids: ["REQ0001"] })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review" })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review", uids: [] })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review", uids: "REQ0001" })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review", uids: [""] })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review", uids: [1] })).toBeUndefined();
    expect(parseDoorstopSessionMetadata({ schema: 1, op: "review", uids: ["bad uid"] })).toBeUndefined();
    expect(
      parseDoorstopSessionMetadata({
        schema: 1,
        op: "review",
        uids: Array.from({ length: DOORSTOP_SESSION_METADATA_MAX_UIDS + 1 }, (_, i) => `REQ${String(i)}`),
      }),
    ).toBeUndefined();
  });

  it("normalizes extra keys away and accepts a frozen payload", () => {
    const parsed = parseDoorstopSessionMetadata(
      Object.freeze({ schema: 1, op: "review", uids: Object.freeze(["REQ0001"]), secret: "nope" }),
    );
    expect(parsed).toEqual({ schema: 1, op: "review", uids: ["REQ0001"] });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["op", "schema", "uids"]);
  });
});
