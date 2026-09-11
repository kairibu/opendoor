// ---------------------------------------------------------------------------
// Layer 2 (node env): unit tests for the "Changes since review" diff engine
// (plan Phase D step 12 / test step 21) — the pure LCS line diff and the
// semantic field diff. No DOM, no backend: both functions are pure, so this
// suite pins their exact semantics exhaustively.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DoorstopDocumentConfig, ItemRecord } from "./doorstop-contract.js";
import { computeItemStamp } from "./doorstop-state.js";
import { diffItemFields, diffLines, type DiffLine } from "./doorstop-diff.js";

// --- fixtures -----------------------------------------------------------------

function makeDocument(overrides: Partial<DoorstopDocumentConfig> = {}): DoorstopDocumentConfig {
  return {
    directoryPath: overrides.directoryPath ?? "reqs",
    configPath: overrides.configPath ?? "reqs/.doorstop.yml",
    prefix: overrides.prefix ?? "REQ",
    digits: overrides.digits ?? 4,
    separator: overrides.separator ?? "",
    itemformat: overrides.itemformat ?? "yaml",
    extra: overrides.extra ?? {},
    ...(overrides.parentPrefix === undefined ? {} : { parentPrefix: overrides.parentPrefix }),
  };
}

function makeItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    uid: overrides.uid ?? "REQ0001",
    documentPrefix: overrides.documentPrefix ?? "REQ",
    path: overrides.path ?? "reqs/REQ0001.yml",
    level: overrides.level ?? "1.0",
    active: overrides.active ?? true,
    derived: overrides.derived ?? false,
    normative: overrides.normative ?? true,
    text: overrides.text ?? "",
    ref: overrides.ref ?? "",
    links: overrides.links ?? [],
    reviewed: overrides.reviewed ?? null,
    attributes: overrides.attributes ?? {},
    raw: overrides.raw ?? {},
    stateKeys: overrides.stateKeys ?? [],
    ...(overrides.header === undefined ? {} : { header: overrides.header }),
    ...(overrides.references === undefined ? {} : { references: overrides.references }),
  };
}

/** Compare a diff to an array of [kind, text] pairs (terse). */
function expectLines(diff: readonly DiffLine[] | undefined, expected: Array<[DiffLine["kind"], string]>): void {
  if (diff === undefined) throw new Error("diffLines returned undefined (oversized guard hit)");
  expect(diff.map((line) => [line.kind, line.text])).toEqual(expected);
}

// --- diffLines (LCS) ------------------------------------------------------------

describe("diffLines (LCS line diff)", () => {
  it("returns all-same rows for identical multi-line texts", () => {
    const before = "The system shall do X.\nSecondary requirement.";
    expectLines(diffLines(before, before), [
      ["same", "The system shall do X."],
      ["same", "Secondary requirement."],
    ]);
  });

  it("marks every line added for a pure add", () => {
    expectLines(diffLines("", "a\nb\nc"), [
      ["added", "a"],
      ["added", "b"],
      ["added", "c"],
    ]);
  });

  it("marks every line removed for a pure remove", () => {
    expectLines(diffLines("a\nb\nc", ""), [
      ["removed", "a"],
      ["removed", "b"],
      ["removed", "c"],
    ]);
  });

  it("interleaves removed/added rows around the common subsequence (LCS, removals before additions on ties)", () => {
    expectLines(diffLines("a\nb\nc\nd\ne", "a\nx\nc\nf\ne"), [
      ["same", "a"],
      ["removed", "b"],
      ["added", "x"],
      ["same", "c"],
      ["removed", "d"],
      ["added", "f"],
      ["same", "e"],
    ]);
  });

  it("handles empty strings as zero lines (no phantom empty row)", () => {
    expectLines(diffLines("", ""), []);
    // A blank line INSIDE a text is a real row; only the empty string is zero.
    expectLines(diffLines("a\n\nb", "a\n\nb"), [
      ["same", "a"],
      ["same", ""],
      ["same", "b"],
    ]);
  });

  it("prefers the longer common run (a real LCS, not a greedy match)", () => {
    // Greedy prefix matching would match a,b then diverge; the LCS keeps
    // b,c,d contiguous and shows only the two edits.
    expectLines(diffLines("a\nb\nc\nd", "x\nb\nc\nd\ny"), [
      ["removed", "a"],
      ["added", "x"],
      ["same", "b"],
      ["same", "c"],
      ["same", "d"],
      ["added", "y"],
    ]);
  });

  it("guards the LCS cell budget: oversized texts yield undefined (a text-changed notice), never a giant DP table", () => {
    const lines = (count: number): string => Array.from({ length: count }, () => "line").join("\n");
    // At the budget ceiling (500 × 500 = 250000 cells) the diff still runs.
    expect(diffLines(lines(500), lines(500))).toHaveLength(500);
    // Just past the ceiling (501 × 500 = 250500 cells) the line diff is
    // skipped. Either side being oversized trips the guard.
    expect(diffLines(lines(501), lines(500))).toBeUndefined();
    expect(diffLines(lines(500), lines(501))).toBeUndefined();
    expect(diffLines(lines(501), lines(501))).toBeUndefined();
  });
});

// --- diffItemFields (semantic field diff) -------------------------------------

describe("diffItemFields (semantic field compare)", () => {
  it("flags added and removed link UIDs (raw-UID set diff, sorted)", () => {
    const before = makeItem({ links: [{ uid: "REQ0001", fingerprint: null }, { uid: "REQ0002", fingerprint: null }] });
    const after = makeItem({ links: [{ uid: "REQ0001", fingerprint: null }, { uid: "REQ0003", fingerprint: null }] });
    const diff = diffItemFields(before, after, makeDocument());
    expect(diff.linksAdded).toEqual(["REQ0003"]);
    expect(diff.linksRemoved).toEqual(["REQ0002"]);
    // A reorder only (same UID set) reads as unchanged.
    const reordered = diffItemFields(
      makeItem({ links: [{ uid: "REQ0002", fingerprint: null }, { uid: "REQ0001", fingerprint: null }] }),
      makeItem({ links: [{ uid: "REQ0001", fingerprint: null }, { uid: "REQ0002", fingerprint: null }] }),
      makeDocument(),
    );
    expect(reordered.linksAdded).toEqual([]);
    expect(reordered.linksRemoved).toEqual([]);
  });

  it("reports a ref change as before → after", () => {
    const diff = diffItemFields(
      makeItem({ ref: "docs/old.md" }),
      makeItem({ ref: "docs/new.md" }),
      makeDocument(),
    );
    expect(diff.ref).toEqual({ before: "docs/old.md", after: "docs/new.md" });
    // Unchanged refs are omitted.
    const same = diffItemFields(makeItem({ ref: "docs/a.md" }), makeItem({ ref: "docs/a.md" }), makeDocument());
    expect(same.ref).toBeUndefined();
  });

  it("reports a references-list change (and only when the list serializes differently)", () => {
    const before = makeItem({ references: [{ type: "file", path: "docs/a.md" }] });
    const after = makeItem({ references: [{ type: "file", path: "docs/a.md" }, { type: "file", path: "docs/b.md" }] });
    const diff = diffItemFields(before, after, makeDocument());
    expect(diff.references).toEqual({
      before: [{ type: "file", path: "docs/a.md" }],
      after: [{ type: "file", path: "docs/a.md" }, { type: "file", path: "docs/b.md" }],
    });
    const same = diffItemFields(before, makeItem({ references: [{ type: "file", path: "docs/a.md" }] }), makeDocument());
    expect(same.references).toBeUndefined();
    // Absent → absent (both undefined) is unchanged.
    const neither = diffItemFields(makeItem(), makeItem(), makeDocument());
    expect(neither.references).toBeUndefined();
  });

  it("reports changed extended REVIEWED attribute values only, in config order", () => {
    const config = makeDocument({ extra: { attributes: { reviewed: ["priority", "owner"] } } });
    const before = makeItem({ attributes: { owner: "team-a", priority: 1, note: "ignored" } });
    const after = makeItem({ attributes: { owner: "team-b", priority: 1, note: "also ignored" } });
    const diff = diffItemFields(before, after, config);
    // `priority` is unchanged (same value), `owner` changed; `note` is not a
    // configured reviewed attribute, so its change is invisible to the stamp.
    expect(diff.extended).toEqual([{ name: "owner", before: "team-a", after: "team-b" }]);
  });

  it("reports a configured reviewed attribute added or removed (undefined on one side)", () => {
    const config = makeDocument({ extra: { attributes: { reviewed: ["owner"] } } });
    const added = diffItemFields(makeItem({ attributes: {} }), makeItem({ attributes: { owner: "team-a" } }), config);
    expect(added.extended).toEqual([{ name: "owner", before: undefined, after: "team-a" }]);
    const removed = diffItemFields(makeItem({ attributes: { owner: "team-a" } }), makeItem({ attributes: {} }), config);
    expect(removed.extended).toEqual([{ name: "owner", before: "team-a", after: undefined }]);
  });

  it("skips the line diff but keeps every field diff when the text exceeds the cell budget", () => {
    const huge = Array.from({ length: 501 }, () => "line").join("\n");
    const before = makeItem({ text: huge });
    const after = makeItem({ text: huge, attributes: { owner: "team-b" } });
    const config = makeDocument({ extra: { attributes: { reviewed: ["owner"] } } });
    const diff = diffItemFields(before, after, config);
    // The text rows are skipped, but the fingerprint-visible field change
    // (owner added) is still reported — a stamp mismatch stays visible.
    expect(diff.text).toBeUndefined();
    expect(diff.extended).toEqual([{ name: "owner", before: undefined, after: "team-b" }]);
  });

  it("text diff and the stamp field set are consistent: any stamp mismatch has at least one visible field change", () => {
    const config = makeDocument({ extra: { attributes: { reviewed: ["owner"] } } });
    const before = makeItem({
      text: "The system shall do X.",
      ref: "docs/a.md",
      links: [{ uid: "REQ0001", fingerprint: null }],
      attributes: { owner: "team-a" },
    });
    const after = makeItem({
      text: "The system shall do Y.",
      ref: "docs/b.md",
      links: [{ uid: "REQ0001", fingerprint: null }, { uid: "REQ0002", fingerprint: null }],
      attributes: { owner: "team-b" },
    });
    expect(computeItemStamp(before, config, true)).not.toBe(computeItemStamp(after, config, true));
    const diff = diffItemFields(before, after, config);
    expectLines(diff.text, [
      ["removed", "The system shall do X."],
      ["added", "The system shall do Y."],
    ]);
    expect(diff.ref).toBeDefined();
    expect(diff.linksAdded).toEqual(["REQ0002"]);
    expect(diff.extended).toEqual([{ name: "owner", before: "team-a", after: "team-b" }]);
  });
});