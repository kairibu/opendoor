// ---------------------------------------------------------------------------
// Contract runtime-helper tests. The frozen module is mostly type-level
// (feature spec §5/§6 shapes); its only runtime surface is the small shared
// helpers below, exercised here. Discovery/model/state behavior is tested by
// the later chains that implement the declared functions.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  formatUnknownError,
  isRecord,
  optionalString,
  requireArrayValue,
  requireBoolean,
  requireFiniteNumber,
  requireRecord,
  requireString,
} from "./doorstop-contract.js";

describe("shape guards", () => {
  it("requireRecord accepts plain objects and rejects non-objects", () => {
    expect(requireRecord({}, "x")).toEqual({});
    expect(requireRecord({ a: 1 }, "x")).toEqual({ a: 1 });
    expect(() => requireRecord(null, "x")).toThrow(/must be an object/);
    expect(() => requireRecord([], "x")).toThrow(/must be an object/);
    expect(() => requireRecord("str", "x")).toThrow(/must be an object/);
  });

  it("requireArrayValue accepts arrays and rejects others", () => {
    expect(requireArrayValue([1, 2], "x")).toEqual([1, 2]);
    expect(() => requireArrayValue({}, "x")).toThrow(/must be an array/);
  });

  it("requireString accepts strings and rejects non-strings", () => {
    expect(requireString({ k: "ok" }, "k")).toBe("ok");
    expect(() => requireString({ k: 5 }, "k")).toThrow(/Expected string field/);
    expect(() => requireString({ k: undefined }, "k")).toThrow(/Expected string field/);
  });

  it("requireBoolean accepts booleans and rejects others", () => {
    expect(requireBoolean({ k: true }, "k")).toBe(true);
    expect(() => requireBoolean({ k: "yes" }, "k")).toThrow(/Expected boolean field/);
  });

  it("requireFiniteNumber accepts finite numbers and rejects others", () => {
    expect(requireFiniteNumber({ k: 4 }, "k")).toBe(4);
    expect(() => requireFiniteNumber({ k: NaN }, "k")).toThrow(/finite number/);
    expect(() => requireFiniteNumber({ k: Infinity }, "k")).toThrow(/finite number/);
    expect(() => requireFiniteNumber({ k: "4" }, "k")).toThrow(/finite number/);
  });

  it("optionalString passes undefined through and validates present strings", () => {
    expect(optionalString({}, "k")).toBeUndefined();
    expect(optionalString({ k: "ok" }, "k")).toBe("ok");
    expect(() => optionalString({ k: 7 }, "k")).toThrow(/Expected string field/);
  });

  it("isRecord matches requireRecord's notion of an object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("formatUnknownError", () => {
  it("uses the message for Error instances and String() otherwise", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
    expect(formatUnknownError("raw")).toBe("raw");
    expect(formatUnknownError(42)).toBe("42");
    expect(formatUnknownError(undefined)).toBe("undefined");
  });
});
