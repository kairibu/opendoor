// ---------------------------------------------------------------------------
// Pure prompt builders (doorstop-prompts.ts): string-in/string-out, no DOM,
// no host API. Mirrors opense-prompts.test.ts: pin the exact full wording the
// panel menu inserts (feature spec §7.3) with one toBe per builder for a
// representative input — so wording regressions in un-asserted regions are
// caught, not just the key substrings — and keep toContain for the variable
// branches (uid counts, paths, degradation/enforcement cases).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ItemRecord } from "./doorstop-contract.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
  validatePrompt,
} from "./doorstop-prompts.js";
import { makeItem as makeFixtureItem } from "./test-fixtures.js";

/** Prompt-shaped item: the shared factory with this suite's baked-in defaults
 *  (REQ002 at level 1.2 under reqs/srd) applied before the caller's overrides. */
function makeItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return makeFixtureItem({
    uid: "REQ002",
    documentPrefix: "REQ",
    path: "reqs/srd/REQ002.yml",
    level: "1.2",
    text: "The system shall expose an interface.",
    ...overrides,
  });
}

function makeParent(uid: string, path: string): ItemRecord {
  return makeItem({ uid, path, documentPrefix: uid.replace(/[0-9]+$/, "") });
}

describe("explainItemPrompt", () => {
  it("pins the exact wording for a linked item", () => {
    const item = makeItem({ links: [{ uid: "REQ001", fingerprint: "stamp-a" }] });
    expect(explainItemPrompt(item)).toBe(
      "Read `reqs/srd/REQ002.yml` (doorstop requirement REQ002) and explain what REQ002 requires and why " +
        "it links to REQ001. Quote the text your explanation rests on; flag empty or ambiguous text and any " +
        "parent link that looks wrong.",
    );
  });

  it("names the item file, the uid, and the parent uids with a path clause", () => {
    const item = makeItem({ links: [{ uid: "REQ001", fingerprint: "stamp-a" }] });
    const prompt = explainItemPrompt(item);
    expect(prompt).toContain("`reqs/srd/REQ002.yml`");
    expect(prompt).toContain("doorstop requirement REQ002");
    expect(prompt).toContain("why it links to REQ001");
  });

  it("joins multiple parents with and", () => {
    const item = makeItem({
      links: [
        { uid: "REQ001", fingerprint: "stamp-a" },
        { uid: "REQ003", fingerprint: "stamp-b" },
      ],
    });
    expect(explainItemPrompt(item)).toContain("why it links to REQ001 and REQ003");
  });

  it("degrades to an assess-the-missing-links ask when the item declares no parents", () => {
    const prompt = explainItemPrompt(makeItem());
    expect(prompt).toContain("declares no parent links");
    expect(prompt).toContain("in the REQ document tree");
    expect(prompt).not.toContain("why it links to");
  });

  it("does not question the absence of links for derived items", () => {
    const prompt = explainItemPrompt(makeItem({ derived: true }));
    expect(prompt).toContain("which is expected for a derived item");
    expect(prompt).not.toContain("assess whether that is correct");
  });

  it("does not question the absence of links for non-normative items", () => {
    const prompt = explainItemPrompt(makeItem({ normative: false }));
    expect(prompt).toContain("which is expected for a non-normative item");
    expect(prompt).not.toContain("assess whether that is correct");
  });

  it("names both derived and non-normative when an item is both", () => {
    const prompt = explainItemPrompt(makeItem({ derived: true, normative: false }));
    expect(prompt).toContain("which is expected for a derived, non-normative item");
  });
});

describe("fixSuspectLinksPrompt", () => {
  it("pins the exact wording for two changed parents", () => {
    const item = makeItem({
      uid: "REQ004",
      path: "reqs/mid/REQ004.yml",
      links: [
        { uid: "REQ001", fingerprint: "old-stamp-a" },
        { uid: "REQ002", fingerprint: "old-stamp-b" },
      ],
    });
    expect(
      fixSuspectLinksPrompt(item, [
        makeParent("REQ001", "reqs/high/REQ001.yml"),
        makeParent("REQ002", "reqs/low/REQ002.yml"),
      ]),
    ).toBe(
      "REQ004 has suspect links to REQ001 and REQ002: the recorded fingerprints no longer match because " +
        "those parents changed after REQ004 was last reviewed. Read `reqs/mid/REQ004.yml` and the changed " +
        "parents (REQ001 (`reqs/high/REQ001.yml`) and REQ002 (`reqs/low/REQ002.yml`)), compare the texts, " +
        "and propose updated text for REQ004 that still traces correctly to every changed parent. Then run " +
        "`doorstop clear REQ004` in the workspace root to re-record the parents' current fingerprints, and " +
        "run `doorstop` to confirm no suspect link remains.",
    );
  });

  it("names the item, its suspect parent uids, both file paths, and the clear command", () => {
    const item = makeItem({
      uid: "REQ004",
      path: "reqs/mid/REQ004.yml",
      links: [
        { uid: "REQ001", fingerprint: "old-stamp-a" },
        { uid: "REQ002", fingerprint: "old-stamp-b" },
      ],
    });
    const prompt = fixSuspectLinksPrompt(item, [
      makeParent("REQ001", "reqs/high/REQ001.yml"),
      makeParent("REQ002", "reqs/low/REQ002.yml"),
    ]);
    expect(prompt).toContain("REQ004 has suspect links to REQ001 and REQ002");
    expect(prompt).toContain("`reqs/mid/REQ004.yml`");
    expect(prompt).toContain("`reqs/high/REQ001.yml`");
    expect(prompt).toContain("`reqs/low/REQ002.yml`");
    expect(prompt).toContain("compare the texts");
    expect(prompt).toContain("propose updated text for REQ004");
    expect(prompt).toContain("`doorstop clear REQ004`");
    expect(prompt).toContain("workspace root");
  });

  it("uses the singular wording for a single changed parent", () => {
    const item = makeItem({
      uid: "REQ004",
      path: "reqs/mid/REQ004.yml",
      links: [{ uid: "REQ001", fingerprint: "old-stamp" }],
    });
    const prompt = fixSuspectLinksPrompt(item, [makeParent("REQ001", "reqs/high/REQ001.yml")]);
    expect(prompt).toContain("REQ004 has a suspect link to REQ001");
    expect(prompt).toContain("`doorstop clear REQ004`");
  });

  it("throws a TypeError when no changed parents are given", () => {
    const item = makeItem({ uid: "REQ004" });
    expect(() => fixSuspectLinksPrompt(item, [])).toThrow(TypeError);
    expect(() => fixSuspectLinksPrompt(item, [])).toThrow(/at least one changed parent/);
  });

  it("throws a TypeError when a parent is not one of the item's links", () => {
    const item = makeItem({ uid: "REQ004", links: [{ uid: "REQ001", fingerprint: "stamp" }] });
    expect(() =>
      fixSuspectLinksPrompt(item, [makeParent("REQ009", "reqs/other/REQ009.yml")]),
    ).toThrow(TypeError);
    expect(() =>
      fixSuspectLinksPrompt(item, [makeParent("REQ009", "reqs/other/REQ009.yml")]),
    ).toThrow(/must be links of REQ004/);
    expect(() =>
      fixSuspectLinksPrompt(item, [makeParent("REQ009", "reqs/other/REQ009.yml")]),
    ).toThrow(/REQ009 is not among REQ004's links/);
    // Plural completion: the message must not end mid-sentence.
    expect(() =>
      fixSuspectLinksPrompt(item, [
        makeParent("REQ009", "reqs/other/REQ009.yml"),
        makeParent("REQ010", "reqs/other/REQ010.yml"),
      ]),
    ).toThrow(/REQ009 and REQ010 are not among REQ004's links/);
  });
});

describe("draftChildRequirementPrompt", () => {
  it("pins the exact wording", () => {
    const parent = makeItem({ uid: "REQ003", path: "reqs/srd/REQ003.yml" });
    expect(draftChildRequirementPrompt(parent, "TST")).toBe(
      "Draft a new TST requirement that traces to REQ003 (`reqs/srd/REQ003.yml`). Run `doorstop add TST` " +
        "in the workspace root and note the UID it prints for the new item. Link the new item to its parent " +
        "with `doorstop link <new-uid> REQ003`, substituting the printed UID for <new-uid>. Then fill in " +
        "the new item's text so it elaborates REQ003 at TST level, referencing any relevant files (prefer " +
        "`doorstop edit <new-uid>` when available, otherwise edit the item file the add command created — " +
        "doorstop normalizes formatting on the next command run). Finally run `doorstop` in the workspace " +
        "root and confirm the new item introduces no WARNING or ERROR before judging whether it is ready " +
        "for `doorstop review <new-uid>`.",
    );
  });

  it("names the parent file, the add/link/review commands, and the child prefix", () => {
    const parent = makeItem({ uid: "REQ003", path: "reqs/srd/REQ003.yml" });
    const prompt = draftChildRequirementPrompt(parent, "TST");
    expect(prompt).toContain("`reqs/srd/REQ003.yml`");
    expect(prompt).toContain("traces to REQ003");
    expect(prompt).toContain("`doorstop add TST`");
    expect(prompt).toContain("`doorstop link <new-uid> REQ003`");
    expect(prompt).toContain("`doorstop review <new-uid>`");
    expect(prompt).toContain("workspace root");
  });

  it("throws a TypeError for a blank child document prefix", () => {
    const parent = makeItem({ uid: "REQ003" });
    expect(() => draftChildRequirementPrompt(parent, "")).toThrow(TypeError);
    expect(() => draftChildRequirementPrompt(parent, "   ")).toThrow(TypeError);
    expect(() => draftChildRequirementPrompt(parent, "")).toThrow(/non-empty child document prefix/);
  });
});

describe("reviewReadinessPrompt", () => {
  it("pins the exact wording with a child link resolved from the caller", () => {
    const item = makeItem({
      uid: "REQ005",
      documentPrefix: "REQ",
      path: "reqs/srd/REQ005.yml",
      text: "The system shall remain available.",
      links: [{ uid: "REQ001", fingerprint: "stamp-a" }],
      references: [{ type: "file", path: "spec/interface.md" }],
    });
    const children = [makeParent("REQ006", "reqs/test/REQ006.yml")];
    expect(reviewReadinessPrompt(item, children)).toBe(
      "Check whether REQ005 is ready for `doorstop review REQ005`. Read `reqs/srd/REQ005.yml` and verify " +
        "that its text is filled in; its recorded parent links (REQ001) are not suspect or missing a " +
        "fingerprint; its child links are declared (REQ006 (`reqs/test/REQ006.yml`)); its file references " +
        "exist (`spec/interface.md`). Then run `doorstop` in the workspace root and weigh any WARNING or " +
        "ERROR it reports about REQ005 (for example a requirement that should link to REQ005 but does not). " +
        "Report a verdict, and if REQ005 is not ready, the exact fixes to make first.",
    );
  });

  it("names the item file, the review command, recorded parents, and reference paths", () => {
    const item = makeItem({
      uid: "REQ005",
      documentPrefix: "REQ",
      path: "reqs/srd/REQ005.yml",
      text: "The system shall remain available.",
      links: [{ uid: "REQ001", fingerprint: "stamp-a" }],
      references: [{ type: "file", path: "spec/interface.md" }],
    });
    const prompt = reviewReadinessPrompt(item);
    expect(prompt).toContain("`doorstop review REQ005`");
    expect(prompt).toContain("`reqs/srd/REQ005.yml`");
    expect(prompt).toContain("REQ001");
    expect(prompt).toContain("`spec/interface.md`");
    expect(prompt).toContain("workspace root");
  });

  it("names child links explicitly when the caller passes the reverse-map entries", () => {
    const item = makeItem({ uid: "REQ005" });
    const prompt = reviewReadinessPrompt(item, [
      makeParent("REQ006", "reqs/test/REQ006.yml"),
      makeParent("REQ007", "reqs/test/REQ007.yml"),
    ]);
    expect(prompt).toContain(
      "its child links are declared (REQ006 (`reqs/test/REQ006.yml`) and REQ007 (`reqs/test/REQ007.yml`))",
    );
  });

  it("defers child-link coverage to the doorstop run when no children are passed", () => {
    const prompt = reviewReadinessPrompt(makeItem({ uid: "REQ005" }));
    expect(prompt).toContain("its child links are left to the `doorstop` run below");
    expect(prompt).not.toContain("its child links are declared");
  });

  it("degrades when the item has empty text and no links or references", () => {
    const item = makeItem({ uid: "REQ006", text: "" });
    const prompt = reviewReadinessPrompt(item);
    expect(prompt).toContain("its text is empty (that alone blocks review)");
    expect(prompt).toContain("it declares no parent links");
    expect(prompt).toContain("it has no file references to verify");
    expect(prompt).toContain("`doorstop review REQ006`");
  });
});

describe("validatePrompt", () => {
  it("pins the exact wording", () => {
    expect(validatePrompt()).toBe(
      "Run `doorstop` in the workspace root and read its validation output. Explain every WARNING and " +
        "ERROR it reports: what the message means, which item or document it concerns, and how to fix it " +
        "(with `doorstop link`, `doorstop clear`, `doorstop unlink`, `doorstop edit`, or a direct edit of " +
        "the item's file). Confirm the tree validates cleanly afterwards.",
    );
  });

  it("asks for the workspace-root run and per-message explanations with fix commands", () => {
    const prompt = validatePrompt();
    expect(prompt).toContain("`doorstop`");
    expect(prompt).toContain("workspace root");
    expect(prompt).toContain("WARNING");
    expect(prompt).toContain("ERROR");
    expect(prompt).toContain("`doorstop link`");
    expect(prompt).toContain("`doorstop clear`");
  });
});

describe("prompt word budget", () => {
  const wordCount = (text: string): number => text.trim().split(/\s+/).length;

  it("keeps every builder under 120 words", () => {
    const item = makeItem({
      uid: "REQ004",
      path: "reqs/mid/REQ004.yml",
      links: [
        { uid: "REQ001", fingerprint: "stamp-a" },
        { uid: "REQ002", fingerprint: "stamp-b" },
      ],
      references: [{ type: "file", path: "spec/interface.md" }],
    });
    const prompts = [
      explainItemPrompt(item),
      explainItemPrompt(makeItem({ derived: true })),
      fixSuspectLinksPrompt(item, [
        makeParent("REQ001", "reqs/high/REQ001.yml"),
        makeParent("REQ002", "reqs/low/REQ002.yml"),
      ]),
      fixSuspectLinksPrompt(makeItem({ uid: "REQ004", links: [{ uid: "REQ001", fingerprint: "s" }] }), [
        makeParent("REQ001", "reqs/high/REQ001.yml"),
      ]),
      draftChildRequirementPrompt(makeItem({ uid: "REQ003", path: "reqs/srd/REQ003.yml" }), "TST"),
      reviewReadinessPrompt(item),
      reviewReadinessPrompt(item, [
        makeParent("REQ006", "reqs/test/REQ006.yml"),
        makeParent("REQ007", "reqs/test/REQ007.yml"),
      ]),
      reviewReadinessPrompt(makeItem({ uid: "REQ006", text: "" })),
      validatePrompt(),
    ];
    for (const prompt of prompts) {
      expect(wordCount(prompt), prompt).toBeLessThanOrEqual(120);
    }
  });
});