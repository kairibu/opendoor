// @vitest-environment node
//
// Pure view-model tests for the panel's DOM-free helpers
// (doorstop-panel-view-model.ts, re-exported by the doorstop-panel-elements.ts
// barrel). Split out of the panel-element suite (plan P4) so each test file
// matches the production module it covers: these three describes render
// nothing and need no DOM, while doorstop-panel-element.test.ts keeps the
// happy-dom element rendering.

import { describe, expect, it } from "vitest";
import {
  documentStateDots,
  doorstopShowAdditionalAttribute,
  filteredItems,
  shownAttributeRows,
  STATE_CHIP_LABELS,
  stateChipKind,
  suspectParentItems,
} from "./doorstop-panel-elements.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../doorstop-settings.js";
import { makeDocument, makeItem, makeTreeResult } from "../test-fixtures.js";

describe("stateChipKind and STATE_CHIP_LABELS (chip color + label mapping)", () => {
  it("maps every ItemStateKey to a label and a color kind", () => {
    expect(Object.keys(STATE_CHIP_LABELS).sort()).toEqual(
      [
        "normative",
        "non-normative",
        "inactive",
        "reviewed",
        "unreviewed",
        "suspect-link",
        "no-child-links",
        "no-links",
        "unknown-link",
        "missing-reference",
      ].sort(),
    );
    // informational → muted
    expect(stateChipKind("normative")).toBe("muted");
    expect(stateChipKind("non-normative")).toBe("muted");
    expect(stateChipKind("reviewed")).toBe("muted");
    // warn-ish → warning
    expect(stateChipKind("unreviewed")).toBe("warning");
    expect(stateChipKind("no-child-links")).toBe("warning");
    expect(stateChipKind("no-links")).toBe("warning");
    // error-ish → danger
    expect(stateChipKind("inactive")).toBe("danger");
    expect(stateChipKind("suspect-link")).toBe("danger");
    expect(stateChipKind("unknown-link")).toBe("danger");
    expect(stateChipKind("missing-reference")).toBe("danger");
  });
});

describe("documentStateDots (aggregate document state)", () => {
  const doc = makeDocument({ prefix: "REQ" });

  it("returns [] for a document with no items", () => {
    expect(documentStateDots(doc, [])).toEqual([]);
  });

  it("returns a green ok dot when every item is reviewed with no suspect links", () => {
    const item = makeItem({ uid: "REQ0001", documentPrefix: "REQ", stateKeys: ["normative", "reviewed"] });
    expect(documentStateDots(doc, [item])).toEqual(["ok"]);
  });

  it("adds an amber dot when any item is unreviewed", () => {
    const item = makeItem({ uid: "REQ0001", documentPrefix: "REQ", stateKeys: ["normative", "unreviewed"] });
    expect(documentStateDots(doc, [item])).toEqual(["unreviewed"]);
  });

  it("adds a red dot when any item has a suspect link (amber kept)", () => {
    const clean = makeItem({ uid: "REQ0001", documentPrefix: "REQ", stateKeys: ["normative", "reviewed"] });
    const suspect = makeItem({ uid: "REQ0002", documentPrefix: "REQ", stateKeys: ["normative", "unreviewed", "suspect-link"] });
    expect(documentStateDots(doc, [clean, suspect])).toEqual(["unreviewed", "suspect"]);
  });
});

describe("suspectParentItems and filteredItems (pure selection helpers)", () => {
  it("resolves the changed parents of a suspect link, matching the state chain", () => {
    const result = makeTreeResult();
    const req0002 = result.index.byUid.get("REQ0002");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0002 === undefined || req0001 === undefined) throw new Error("fixture");
    expect(req0002.stateKeys).toContain("suspect-link");
    expect(suspectParentItems(req0002, result.index).map((parent) => parent.uid)).toEqual(["REQ0001"]);
    // TST002 recorded the current stamp → not suspect.
    const tst002 = result.index.byUid.get("TST002");
    if (tst002 === undefined) throw new Error("fixture");
    expect(tst002.stateKeys).not.toContain("suspect-link");
    expect(suspectParentItems(tst002, result.index)).toEqual([]);
  });

  it("filters by document prefix, state key, and search over uid/header/text", () => {
    const result = makeTreeResult();
    const index = result.index;
    expect(index.items).toHaveLength(4);

    expect(filteredItems(index, "REQ", undefined, "").map((item) => item.uid)).toEqual(["REQ0001", "REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "").map((item) => item.uid)).toEqual([
      "REQ0001",
      "TST001",
      "REQ0002",
      "TST002",
    ]);
    expect(filteredItems(index, undefined, "suspect-link", "").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, "reviewed", "").map((item) => item.uid)).toEqual(["REQ0001"]);
    // The empty string sentinel (the "All" chip's selectDocument("")) means all.
    expect(filteredItems(index, "", undefined, "").map((item) => item.uid)).toHaveLength(4);
    // Search over UID, header, and text.
    expect(filteredItems(index, undefined, undefined, "REQ0002").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "capacity").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "verify").map((item) => item.uid)).toEqual(["TST001", "TST002"]);
    expect(filteredItems(index, undefined, undefined, "nope")).toEqual([]);
  });
});

describe("doorstopShowAdditionalAttribute (configured attribute NAMES)", () => {
  it("surfaces the configured names, falling back to the frozen default when absent", () => {
    const result = makeTreeResult();
    expect(doorstopShowAdditionalAttribute(undefined)).toBe(DEFAULT_OPENDOOR_SETTINGS.showAdditionalAttribute);
    expect(doorstopShowAdditionalAttribute(result)).toBe(DEFAULT_OPENDOOR_SETTINGS.showAdditionalAttribute);
    const configured: DoorstopWorkspaceResult = {
      ...result,
      settings: { ...result.settings, showAdditionalAttribute: ["component"] },
    };
    expect(doorstopShowAdditionalAttribute(configured)).toEqual(["component"]);
  });

  it("falls back to the default on a settings-stripped result (the optional-chain guard)", () => {
    const result = makeTreeResult();
    const stripped = { index: result.index } as unknown as DoorstopWorkspaceResult;
    expect(doorstopShowAdditionalAttribute(stripped)).toBe(DEFAULT_OPENDOOR_SETTINGS.showAdditionalAttribute);
  });
});

describe("shownAttributeRows (per-item configured attributes)", () => {
  it("returns [] for no configured keys (and leaves the keys array untouched)", () => {
    const keys: string[] = [];
    expect(shownAttributeRows(makeItem({ text: "x" }), keys)).toEqual([]);
    expect(keys).toEqual([]);
  });

  it("jsonish-renders string/number/null/object extended values and skips absent keys", () => {
    const item = makeItem({
      attributes: { component: "auth", priority: 2, missing: null, meta: { a: 1 }, other: "ignored" },
    });
    expect(shownAttributeRows(item, ["component", "priority", "missing", "meta"])).toEqual([
      { key: "component", text: '"auth"' },
      { key: "priority", text: "2" },
      { key: "missing", text: "null" },
      { key: "meta", text: '{"a":1}' },
    ]);
  });

  it("iterates the CONFIGURED keys only: an absent key is skipped, an unconfigured attribute never leaks", () => {
    const item = makeItem({ attributes: { other: "ignored" } });
    expect(shownAttributeRows(item, ["component"])).toEqual([]);
  });

  it("renders the modeled text jsonish-quoted, and skips it when the item body is empty", () => {
    expect(shownAttributeRows(makeItem({ text: "The system shall do X." }), ["text"])).toEqual([
      { key: "text", text: '"The system shall do X."' },
    ]);
    expect(shownAttributeRows(makeItem({ text: "" }), ["text"])).toEqual([]);
  });

  it("preserves the configured order and returns exactly one row per configured-and-present key", () => {
    const item = makeItem({ text: "body", attributes: { component: "auth", priority: 2, other: "ignored" } });
    expect(shownAttributeRows(item, ["text", "priority", "component"]).map((row) => row.key)).toEqual([
      "text",
      "priority",
      "component",
    ]);
    // A configured key the item lacks is simply absent from the result.
    expect(shownAttributeRows(item, ["component"])).toHaveLength(1);
  });
});
