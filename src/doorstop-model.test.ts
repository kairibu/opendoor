// ---------------------------------------------------------------------------
// Model-chain tests (feature spec §5/§6): item parsing (yaml + markdown with
// frontmatter) and index assembly (lookups, maps, structural findings).
// Pure functions — no files adapter needed (parseDoorstopItem receives
// strings, buildDoorstopIndex receives parsed objects).
//
// Expected values mirror upstream Doorstop semantics (core/item.py,
// core/common.py, core/types.py — see /tmp clone of doorstop-dev/doorstop):
// Text/Level/Stamp normalization, the markdown header/text derivation, and
// the extension behavior of the reference entries.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type {
  DoorstopDocumentConfig,
  DiscoveryDiagnostic,
  DoorstopParseResult,
  ItemRecord,
} from "./doorstop-contract.js";
import { buildDoorstopIndex, parseDoorstopItem } from "./doorstop-model.js";

// --- fixtures ------------------------------------------------------------------------

function config(overrides: Partial<DoorstopDocumentConfig> = {}): DoorstopDocumentConfig {
  const result: DoorstopDocumentConfig = {
    directoryPath: overrides.directoryPath ?? "reqs/REQ",
    configPath: overrides.configPath ?? "reqs/REQ/.doorstop.yml",
    prefix: overrides.prefix ?? "REQ",
    digits: overrides.digits ?? 3,
    separator: overrides.separator ?? "",
    itemformat: overrides.itemformat ?? "yaml",
    extra: overrides.extra ?? {},
  };
  if (overrides.parentPrefix !== undefined) result.parentPrefix = overrides.parentPrefix;
  return result;
}

function parse(
  path: string,
  content: string,
  overrides: Partial<DoorstopDocumentConfig> = {},
): DoorstopParseResult {
  return parseDoorstopItem(path, content, config(overrides));
}

/** A hand-built ItemRecord for index tests (post-parse shape). */
function item(overrides: Partial<ItemRecord> & Pick<ItemRecord, "uid">): ItemRecord {
  return {
    documentPrefix: "REQ",
    path: `reqs/REQ/${overrides.uid}.yml`,
    level: "1.0",
    active: true,
    derived: false,
    normative: true,
    text: "",
    ref: "",
    links: [],
    reviewed: null,
    attributes: {},
    raw: {},
    stateKeys: [],
    ...overrides,
  };
}

const YAML_ITEM = [
  "active: true",
  "derived: false",
  "header: |",
  "  Identifiers",
  "level: 2.1",
  "links:",
  "  - REQ001: null",
  "  - REQ002: abc123=",
  "  - REQ003",
  "normative: true",
  "ref: ''",
  "reviewed: 9TcFUzsQWUHhoh5wsqnhL7VRtSqMaIhrCXg7mfIkxKM=",
  "text: |",
  "  Doorstop **shall** provide unique",
  "  and permanent identifiers.",
  "references:",
  "  - path: tests/test1.cpp",
  "    type: file",
  "  - path: tests/test2.cpp",
  "    type: file",
  "    keyword: REQ1",
  "invented-by: jane@example.com",
].join("\n");

const MARKDOWN_ITEM = [
  "---",
  "active: true",
  "derived: false",
  "level: 2.1",
  "links:",
  "  - REQ001: abc123=",
  "normative: true",
  "ref: ''",
  "reviewed: 9TcFUzsQWUHhoh5wsqnhL7VRtSqMaIhrCXg7mfIkxKM=",
  "invented-by: jane@example.com",
  "---",
  "",
  "# Identifiers",
  "",
  "Doorstop **shall** provide unique and permanent identifiers to linkable",
  "sections of text.",
].join("\n");

// --- parseDoorstopItem: yaml format ------------------------------------------------------

describe("parseDoorstopItem (yaml format)", () => {
  it("parses every standard attribute, extended attributes, and links", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", YAML_ITEM);
    expect(diagnostics).toEqual([]);
    expect(item.uid).toBe("REQ001");
    expect(item.documentPrefix).toBe("REQ");
    expect(item.path).toBe("reqs/REQ/REQ001.yml");
    expect(item.level).toBe("2.1");
    expect(item.active).toBe(true);
    expect(item.derived).toBe(false);
    expect(item.normative).toBe(true);
    expect(item.header).toBe("Identifiers");
    expect(item.text).toBe("Doorstop **shall** provide unique\nand permanent identifiers.");
    expect(item.ref).toBe("");
    expect(item.reviewed).toBe("9TcFUzsQWUHhoh5wsqnhL7VRtSqMaIhrCXg7mfIkxKM=");
    expect(item.links).toEqual([
      { uid: "REQ001", fingerprint: null },
      { uid: "REQ002", fingerprint: "abc123=" },
      { uid: "REQ003", fingerprint: null },
    ]);
    expect(item.references).toEqual([
      { type: "file", path: "reqs/REQ/tests/test1.cpp" },
      { type: "file", path: "reqs/REQ/tests/test2.cpp", keyword: "REQ1" },
    ]);
    expect(item.attributes).toEqual({ "invented-by": "jane@example.com" });
    expect(item.stateKeys).toEqual([]);
  });

  it("keeps raw data as the escape hatch (uninterpreted link/reference shapes)", () => {
    const { item } = parse("reqs/REQ/REQ001.yml", YAML_ITEM);
    expect(item.raw).toEqual({
      active: true,
      derived: false,
      header: "Identifiers\n",
      level: 2.1,
      links: [{ REQ001: null }, { REQ002: "abc123=" }, "REQ003"],
      normative: true,
      ref: "",
      reviewed: "9TcFUzsQWUHhoh5wsqnhL7VRtSqMaIhrCXg7mfIkxKM=",
      text: "Doorstop **shall** provide unique\nand permanent identifiers.\n",
      references: [
        { path: "tests/test1.cpp", type: "file" },
        { path: "tests/test2.cpp", type: "file", keyword: "REQ1" },
      ],
      "invented-by": "jane@example.com",
    });
  });

  it("applies Doorstop defaults for missing attributes", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ002.yml", "");
    expect(diagnostics).toEqual([]);
    expect(item.uid).toBe("REQ002");
    expect(item.level).toBe("1.0");
    expect(item.active).toBe(true);
    expect(item.derived).toBe(false);
    expect(item.normative).toBe(true);
    expect(item.text).toBe("");
    expect(item.ref).toBe("");
    expect(item.links).toEqual([]);
    expect(item.reviewed).toBeNull();
    expect(item.header).toBeUndefined();
    expect(item.references).toBeUndefined();
    expect(item.attributes).toEqual({});
    expect(item.raw).toEqual({});
  });

  it("derives the document prefix from config even for foreign-prefixed file names", () => {
    const { item } = parse("reqs/REQ/TST999.yml", "level: 1.0\ntext: hello");
    expect(item.uid).toBe("TST999");
    expect(item.documentPrefix).toBe("REQ");
  });

  it("normalizes levels like Doorstop's Level type", () => {
    expect(parse("reqs/REQ/A.yml", "level: 2.1").item.level).toBe("2.1");
    expect(parse("reqs/REQ/A.yml", "level: 1.10").item.level).toBe("1.1"); // YAML float gotcha
    expect(parse("reqs/REQ/A.yml", "level: '1.10'").item.level).toBe("1.10"); // quoted part preserved
    expect(parse("reqs/REQ/A.yml", "level: 2.0").item.level).toBe("2.0"); // integer-valued float keeps .0
    expect(parse("reqs/REQ/A.yml", "level: '1.0.0'").item.level).toBe("1.0"); // multiple trailing zeros collapse
    expect(parse("reqs/REQ/A.yml", "level: 1").item.level).toBe("1.0"); // int-with-.0 rendering (JS YAML loss)
    expect(parse("reqs/REQ/A.yml", "level: [1, 2]").item.level).toBe("1.2");
    expect(parse("reqs/REQ/A.yml", "level: null").item.level).toBe("1"); // Level(None) → [1]
    expect(parse("reqs/REQ/A.yml", "").item.level).toBe("1.0"); // missing → DEFAULT_LEVEL
  });

  it("coerces active/normative/derived via to_bool", () => {
    expect(parse("reqs/REQ/A.yml", "active: false").item.active).toBe(false);
    expect(parse("reqs/REQ/A.yml", "active: 'False'").item.active).toBe(false);
    expect(parse("reqs/REQ/A.yml", "active: 'yes'").item.active).toBe(true);
    expect(parse("reqs/REQ/A.yml", "active: 1").item.active).toBe(true);
    expect(parse("reqs/REQ/A.yml", "normative: 'no'").item.normative).toBe(false);
    expect(parse("reqs/REQ/A.yml", "derived: true").item.derived).toBe(true);
  });

  it("maps reviewed placeholders to null and keeps real stamps", () => {
    expect(parse("reqs/REQ/A.yml", "reviewed: null").item.reviewed).toBeNull();
    expect(parse("reqs/REQ/A.yml", "reviewed: false").item.reviewed).toBeNull(); // Stamp(None) — never reviewed
    expect(parse("reqs/REQ/A.yml", "reviewed: ''").item.reviewed).toBeNull();
    expect(parse("reqs/REQ/A.yml", "reviewed: abc").item.reviewed).toBe("abc");
  });

  it("flags a legacy boolean `reviewed: true` (Stamp(True) placeholder) as unreviewed with a warning (yaml)", () => {
    // Doorstop's reviewed getter (item.py) lazily replaces a stored Stamp(True)
    // with the item's CURRENT stamp, so upstream this reads as
    // reviewed-at-current-stamp. The model chain cannot compute stamps, so the
    // faithful model-level representation is null + warning + raw preserved.
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "reviewed: true");
    expect(item.reviewed).toBeNull();
    expect(item.raw["reviewed"]).toBe(true); // legacy value never lost
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        path: "reqs/REQ/REQ001.yml",
        message: "legacy boolean reviewed attribute; treat as unreviewed until next doorstop review",
      },
    ]);
  });

  it("flags every Stamp(True) scalar form (yes/true/enabled/1/non-zero numbers) the same way", () => {
    const warning = {
      severity: "warning" as const,
      path: "reqs/REQ/REQ001.yml",
      message: "legacy boolean reviewed attribute; treat as unreviewed until next doorstop review",
    };
    // js-yaml keeps YAML-1.1 truthy scalars as strings (`yes`, `enabled`,
    // quoted `'true'`) and parses `1`/`5` as numbers; Doorstop's `Stamp()`
    // normalizes all of them to the Stamp(True) placeholder via to_bool.
    for (const line of ["reviewed: yes", "reviewed: 'true'", "reviewed: enabled", "reviewed: 1", "reviewed: 5"]) {
      const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", line);
      expect(item.reviewed).toBeNull();
      expect(diagnostics).toEqual([warning]);
    }
    // Stamp(None) forms — genuinely never reviewed — stay silent, no warning.
    for (const line of ["reviewed: false", "reviewed: 0", "reviewed: ''"]) {
      const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", line);
      expect(item.reviewed).toBeNull();
      expect(diagnostics).toEqual([]);
    }
  });

  it("deduplicates links (set semantics, first occurrence keeps its stamp)", () => {
    const content = ["links:", "  - REQ001: first=", "  - REQ001: second=", "  - REQ002"].join("\n");
    expect(parse("reqs/REQ/A.yml", content).item.links).toEqual([
      { uid: "REQ001", fingerprint: "first=" },
      { uid: "REQ002", fingerprint: null },
    ]);
  });

  it("keeps the first key of a multi-key link entry (UID(dict) semantics)", () => {
    const content = ["links:", "  - REQ001: abc=", "    REQ002: def="].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", content);
    expect(diagnostics).toEqual([]);
    expect(item.links).toEqual([{ uid: "REQ001", fingerprint: "abc=" }]);
  });

  it("treats an empty references array as no references", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "references: []");
    expect(item.references).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it("turns explicit `references:` null into a warning and no references", () => {
    // yaml_validator.py fails the whole item on `references:`; the model's
    // non-fatal preference warns instead.
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "references:");
    expect(item.references).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        path: "reqs/REQ/REQ001.yml",
        message: "'references' must be an array with at least one reference element",
      },
    ]);
  });

  it("keeps extended attributes verbatim", () => {
    expect(parse("reqs/REQ/A.yml", "shallow: { nested: [1, 2], flag: true }").item.attributes).toEqual({
      shallow: { nested: [1, 2], flag: true },
    });
  });
});

describe("reference/ref path normalization", () => {
  it("resolves refs against the owning document directory", () => {
    const { item } = parse("reqs/REQ/REQ001.yml", "ref: test-tst001.c");
    expect(item.ref).toBe("reqs/REQ/test-tst001.c");
  });

  it("resolves parent-relative references and clamps at the workspace root", () => {
    const { item } = parse("reqs/REQ/REQ001.yml", "ref: ../docs/x.md");
    expect(item.ref).toBe("reqs/docs/x.md");
    expect(parse("reqs/REQ/REQ001.yml", "ref: ../../../../rooted.txt").item.ref).toBe("rooted.txt");
  });

  it("keeps ref empty when empty", () => {
    expect(parse("reqs/REQ/REQ001.yml", "ref: ''").item.ref).toBe("");
    expect(parse("reqs/REQ/REQ001.yml", "").item.ref).toBe("");
  });

  it("preserves sha and keyword entries, resolving paths", () => {
    const content = [
      "references:",
      "  - path: files/a.file",
      "    sha: 28c16553011a46bca9b78d189f8fd30c59c4138a1b6a9a4961f525849d48037e",
      "    type: file",
    ].join("\n");
    expect(parse("reqs/REQ/REQ001.yml", content).item.references).toEqual([
      {
        type: "file",
        path: "reqs/REQ/files/a.file",
        sha: "28c16553011a46bca9b78d189f8fd30c59c4138a1b6a9a4961f525849d48037e",
      },
    ]);
  });

  it("emits warnings (not throws) for non-conforming reference entries", () => {
    const content = [
      "references:",
      "  - path: ok.cpp",
      "    type: file",
      "  - path: bad.cpp",
      "    type: doc", // Doorstop: type must be 'file'
      "  - badentry",
    ].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", content);
    expect(item.references).toEqual([{ type: "file", path: "reqs/REQ/ok.cpp" }]);
    expect(diagnostics.map((d) => d.severity)).toEqual(["warning", "warning"]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      "'references' member's 'type' value must be a 'file'",
      "'references' member must be a dictionary",
    ]);
  });

  it("distinguishes a missing 'type' key from a wrong type value", () => {
    const content = ["references:", "  - path: files/a.file"].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", content);
    expect(item.references).toBeUndefined();
    expect(diagnostics.map((d) => d.message)).toEqual(["'references' member must have a 'type' key"]);
  });

  it("keeps an entry with a non-string sha (Doorstop never validates sha)", () => {
    const content = ["references:", "  - path: files/a.file", "    sha: 12345", "    type: file"].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", content);
    expect(diagnostics).toEqual([]);
    // The contract pins sha to string, so the raw 12345 is omitted from the
    // normalized reference (the raw escape hatch keeps it); the entry itself
    // survives, exactly like upstream.
    expect(item.references).toEqual([{ type: "file", path: "reqs/REQ/files/a.file" }]);
    expect(item.raw["references"]).toEqual([{ path: "files/a.file", sha: 12345, type: "file" }]);
  });
});

// --- parseDoorstopItem: markdown format ---------------------------------------------------

describe("parseDoorstopItem (markdown format)", () => {
  it("derives header from the first level-1 heading and text from the rest", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", MARKDOWN_ITEM, { itemformat: "markdown" });
    expect(diagnostics).toEqual([]);
    expect(item.header).toBe("Identifiers");
    expect(item.text).toBe(
      "Doorstop **shall** provide unique and permanent identifiers to linkable\nsections of text.",
    );
    // Frontmatter attributes and links are parsed like YAML-format items
    expect(item.level).toBe("2.1");
    expect(item.reviewed).toBe("9TcFUzsQWUHhoh5wsqnhL7VRtSqMaIhrCXg7mfIkxKM=");
    expect(item.links).toEqual([{ uid: "REQ001", fingerprint: "abc123=" }]);
    expect(item.attributes).toEqual({ "invented-by": "jane@example.com" });
  });

  it("flags a legacy boolean `reviewed: true` in markdown frontmatter the same way", () => {
    const content = ["---", "reviewed: true", "---", "", "# Legacy", "", "Reviewed once, long ago."].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(item.reviewed).toBeNull(); // Stamp(True) placeholder — model cannot mint a stamp
    expect(item.raw["reviewed"]).toBe(true); // legacy value kept verbatim in raw
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        path: "reqs/REQ/REQ001.md",
        message: "legacy boolean reviewed attribute; treat as unreviewed until next doorstop review",
      },
    ]);
  });

  it("lets body-derived header/text override frontmatter copies", () => {
    const content = [
      "---",
      "active: true",
      "text: ignored frontmatter text",
      "header: ignored frontmatter header",
      "---",
      "",
      "# Real Header",
      "",
      "Real body text.",
    ].join("\n");
    const { item } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(item.header).toBe("Real Header");
    expect(item.text).toBe("Real body text.");
    expect(item.raw["text"]).toBe("Real body text.");
    expect(item.raw["header"]).toBe("Real Header");
  });

  it("handles a body without a leading level-1 heading", () => {
    const { item } = parse("reqs/REQ/REQ001.md", "A plain paragraph.\n\nMore text.", {
      itemformat: "markdown",
    });
    expect(item.header).toBeUndefined();
    expect(item.text).toBe("A plain paragraph.\n\nMore text.");
  });

  it("derives header/text from a body without any frontmatter", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", "# Plain\n\nBody text", {
      itemformat: "markdown",
    });
    expect(diagnostics).toEqual([]);
    expect(item.header).toBe("Plain");
    expect(item.text).toBe("Body text");
    expect(item.links).toEqual([]);
    expect(item.raw).toEqual({ header: "Plain", text: "Body text" });
  });

  it("requires a closing fence for frontmatter (no fence → whole content is body)", () => {
    const content = ["---", "active: true", "# Heading", "", "text"].join("\n");
    const { item } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    // python-frontmatter: with only one `---` there is no frontmatter, so the
    // whole content becomes body. The first non-blank line (`---`) is not a
    // level-1 heading, so no header is derived and every line stays in text.
    expect(item.header).toBeUndefined();
    expect(item.text).toBe("---\nactive: true\n# Heading\n\ntext");
    expect(item.active).toBe(true); // attribute defaults — nothing was parsed as YAML
  });

  it("treats 4+ dash fences exactly like `---` (python-frontmatter -{3,})", () => {
    const content = ["----", "active: true", "level: 1.2", "-----", "# H", "", "body"].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(diagnostics).toEqual([]);
    expect(item.active).toBe(true);
    expect(item.level).toBe("1.2");
    expect(item.header).toBe("H");
    expect(item.text).toBe("body");
  });

  it("keeps a `...` line inside frontmatter as content (dash-only fence)", () => {
    const content = [
      "---",
      "active: true",
      "notes: |",
      "  one",
      "  ...",
      "  two",
      "---",
      "# H",
      "",
      "body",
    ].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(diagnostics).toEqual([]);
    expect(item.active).toBe(true);
    expect(item.attributes["notes"]).toBe("one\n...\ntwo\n");
    expect(item.header).toBe("H");
  });

  it("skips leading blank lines before the opening fence", () => {
    const content = ["", "", "---", "active: true", "---", "# H", "", "body"].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(diagnostics).toEqual([]);
    expect(item.active).toBe(true);
    expect(item.header).toBe("H");
    expect(item.text).toBe("body");
  });

  it("pins body behavior: `-- --` lines and post-fence `---` are body, never fences", () => {
    const content = [
      "---",
      "active: true",
      "---",
      "# H",
      "",
      "```",
      "---",
      "-- --",
      "```",
    ].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(diagnostics).toEqual([]);
    expect(item.header).toBe("H");
    expect(item.text).toBe("```\n---\n-- --\n```");
    expect(item.raw["text"]).toBe("```\n---\n-- --\n```");
  });
});

// --- malformed content / binary guard -------------------------------------------------------

describe("parseDoorstopItem robustness", () => {
  it("turns malformed YAML into an error diagnostic and a default item, not a throw", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "active: [unclosed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.path).toBe("reqs/REQ/REQ001.yml");
    expect(diagnostics[0]?.message).toMatch(/invalid contents: reqs\/REQ\/REQ001\.yml/);
    expect(item.uid).toBe("REQ001");
    expect(item.level).toBe("1.0");
    expect(item.active).toBe(true);
    expect(item.text).toBe("");
    expect(item.links).toEqual([]);
    expect(item.raw).toEqual({});
  });

  it("rejects a YAML document that is not a mapping", () => {
    const { diagnostics } = parse("reqs/REQ/REQ001.yml", "- a\n- b");
    expect(diagnostics.map((d) => d.severity)).toEqual(["error"]);
    expect(diagnostics[0]?.message).toMatch(/expected a mapping, got/);
  });

  it("rejects malformed markdown frontmatter with a diagnostic, not a throw", () => {
    const content = ["---", "links: [broken", "---", "# H", "", "body"].join("\n");
    const { item, diagnostics } = parse("reqs/REQ/REQ001.md", content, { itemformat: "markdown" });
    expect(diagnostics.map((d) => d.severity)).toEqual(["error"]);
    expect(item.level).toBe("1.0");
  });

  it("never parses binary content smuggled as a string (NUL byte guard)", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "active: true\u0000binary");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.path).toBe("reqs/REQ/REQ001.yml");
    expect(item.active).toBe(true); // default — never parsed
    expect(item.raw).toEqual({});
  });

  it("warns on an unknown config.itemformat instead of silently parsing yaml", () => {
    const { item, diagnostics } = parse("reqs/REQ/REQ001.yml", "active: false", {
      itemformat: "text" as unknown as "yaml",
    });
    expect(diagnostics.map((d) => d.message)).toEqual(["unknown itemformat 'text' — treated as yaml"]);
    expect(item.active).toBe(false); // still parsed as yaml
  });

  it("handles separator variants in item file names", () => {
    expect(parse("reqs/REQ/REQ_001.yml", "level: 1.1").item.uid).toBe("REQ_001");
    expect(parse("reqs/REQ/REQ-001.yml", "level: 1.1", { separator: "-" }).item.uid).toBe("REQ-001");
  });
});

// --- buildDoorstopIndex ----------------------------------------------------------------------

function itemFile(path: string, content: string, overrides: Partial<DoorstopDocumentConfig> = {}): ItemRecord {
  return parse(path, content, overrides).item;
}

describe("buildDoorstopIndex", () => {
  const reqDoc = config({ directoryPath: "reqs/REQ", prefix: "REQ" });
  const tstDoc = config({
    directoryPath: "reqs/TST",
    configPath: "reqs/TST/.doorstop.yml",
    prefix: "TST",
    parentPrefix: "REQ",
  });

  const req001 = itemFile("reqs/REQ/REQ001.yml", "level: 1.1\ntext: req one");
  const req002 = itemFile("reqs/REQ/REQ002.yml", "level: 1.2\nlinks:\n  - REQ001: abc=");
  const tst001 = itemFile("reqs/TST/TST001.yml", "level: 1.0\nlinks:\n  - REQ002: def=", {
    directoryPath: "reqs/TST",
    prefix: "TST",
  });

  it("builds the lookup maps and reverse link maps", () => {
    const index = buildDoorstopIndex([reqDoc, tstDoc], [req001, req002, tst001], [], new Set());

    expect(index.byUid.get("REQ001")).toBe(req001);
    expect(index.byUid.get("REQ002")).toBe(req002);
    expect(index.byUid.get("TST001")).toBe(tst001);
    expect(index.byPrefix.get("REQ")).toBe(reqDoc);
    expect(index.byPrefix.get("TST")).toBe(tstDoc);

    // parentLinksByUid shares the item's own link objects
    expect(index.parentLinksByUid.get("REQ002")).toBe(req002.links);
    expect(index.parentLinksByUid.get("TST001")).toEqual([{ uid: "REQ002", fingerprint: "def=" }]);

    // childrenByUid entries share the item object from `items`
    expect(index.childrenByUid.get("REQ001")).toEqual([req002]);
    expect(index.childrenByUid.get("REQ002")).toEqual([tst001]);
    expect(index.childrenByUid.get("TST001")).toBeUndefined();
  });

  it("sorts items by level (component-wise: 1.2 < 1.10) then uid", () => {
    const a = item({ uid: "REQ001" });
    a.level = "1.10";
    const b = item({ uid: "REQ002" });
    b.level = "1.2";
    const c = item({ uid: "REQ003" });
    c.level = "1.0";
    const index = buildDoorstopIndex([reqDoc], [a, b, c], [], new Set());
    expect(index.items.map((i) => i.uid)).toEqual(["REQ003", "REQ002", "REQ001"]);
  });

  it("sorts documents by directory path", () => {
    const index = buildDoorstopIndex([tstDoc, reqDoc], [req001, req002, tst001], [], new Set());
    expect(index.documents.map((d) => d.directoryPath)).toEqual(["reqs/REQ", "reqs/TST"]);
  });

  it("breaks level ties by uid", () => {
    const a = item({ uid: "REQ001" });
    const b = item({ uid: "REQ002" });
    a.level = "1.0";
    b.level = "1.0";
    const index = buildDoorstopIndex([reqDoc], [b, a], [], new Set());
    expect(index.items.map((i) => i.uid)).toEqual(["REQ001", "REQ002"]);
  });

  it("carries diagnostics and knownFilePaths through untouched", () => {
    const diagnostics: DiscoveryDiagnostic[] = [
      { severity: "warning", path: "reqs/REQ/.doorstop.yml", message: "config warning" },
    ];
    const knownFilePaths = new Set(["reqs/REQ/REQ001.yml", "docs/x.md"]);
    const index = buildDoorstopIndex([reqDoc], [req001], diagnostics, knownFilePaths);
    expect(index.diagnostics).toEqual(diagnostics);
    expect(index.knownFilePaths).toBe(knownFilePaths);
  });

  it("seeds counts with items/documents and zero state counters", () => {
    const index = buildDoorstopIndex([reqDoc, tstDoc], [req001, req002, tst001], [], new Set());
    expect(index.counts).toEqual({
      suspectLinks: 0,
      unreviewedChanges: 0,
      unknownLinks: 0,
      missingReferences: 0,
      items: 3,
      documents: 2,
    });
  });

  it("is ok when there are no error findings, even with warnings", () => {
    const index = buildDoorstopIndex([reqDoc, tstDoc], [req001, req002, tst001], [], new Set());
    expect(index.findings).toEqual([]);
    expect(index.ok).toBe(true);
  });

  it("flags duplicate item UIDs as errors and keeps the first in sorted order", () => {
    const dup = item({ uid: "REQ001" });
    dup.path = "other/REQ001.yml";
    dup.level = "1.1"; // sorts before req001 (level 1.10)
    const index = buildDoorstopIndex([reqDoc], [dup, req001], [], new Set());
    expect(index.byUid.get("REQ001")).toBe(dup); // first occurrence in sorted order wins
    const finding = index.findings.find((f) => f.severity === "error");
    expect(finding?.message).toMatch(/duplicate item UID: REQ001/);
    expect(index.ok).toBe(false);
  });

  it("flags duplicate levels within a document as warnings", () => {
    const clash = itemFile("reqs/REQ/REQ003.yml", "level: 1.1");
    const index = buildDoorstopIndex([reqDoc], [req001, clash], [], new Set());
    expect(index.findings).toEqual([
      {
        severity: "warning",
        uid: "REQ003",
        path: "reqs/REQ/REQ003.yml",
        message: "duplicate level in document REQ: 1.1 (also used by REQ001)",
      },
    ]);
    expect(index.ok).toBe(true);
  });

  it("flags unknown link UIDs as errors", () => {
    const broken = itemFile("reqs/REQ/REQ005.yml", "links:\n  - REQ999: null");
    const index = buildDoorstopIndex([reqDoc], [req001, broken], [], new Set());
    expect(index.findings).toContainEqual({
      severity: "error",
      uid: "REQ005",
      path: "reqs/REQ/REQ005.yml",
      message: "linked to unknown item: REQ999",
    });
    expect(index.childrenByUid.get("REQ999")).toBeUndefined();
    expect(index.ok).toBe(false);
  });

  it("flags links to items in unknown documents as warnings", () => {
    const broken = itemFile("reqs/REQ/REQ005.yml", "links:\n  - XX001: null");
    const index = buildDoorstopIndex([reqDoc], [req001, broken], [], new Set());
    expect(index.findings).toContainEqual({
      severity: "warning",
      uid: "REQ005",
      path: "reqs/REQ/REQ005.yml",
      message: "linked to item in unknown document: XX001 (no document with prefix XX)",
    });
  });

  it("resolves link targets across UID separators like Doorstop UID equality", () => {
    const tstDoc2 = config({
      directoryPath: "reqs/TST",
      configPath: "reqs/TST/.doorstop.yml",
      prefix: "TST",
      parentPrefix: "REQ",
    });
    const child = itemFile("reqs/TST/TST001.yml", "level: 1.0\nlinks:\n  - REQ_001: abc=", {
      directoryPath: "reqs/TST",
      prefix: "TST",
    });
    const index = buildDoorstopIndex([reqDoc, tstDoc2], [req001, child], [], new Set());
    expect(index.childrenByUid.get("REQ001")).toEqual([child]); // "REQ_001" links match item REQ001
    expect(index.findings).toEqual([]); // no unknown-link finding for the separator variant
  });

  it("does not double-count a target when one item links it with separator variants", () => {
    const parent = itemFile("reqs/REQ/REQ001.yml", "level: 1.0");
    const child = itemFile("reqs/REQ/REQ002.yml", "level: 1.1\nlinks:\n  - REQ001: abc=\n  - REQ_001: def=");
    const index = buildDoorstopIndex([reqDoc], [parent, child], [], new Set());
    expect(child.links).toEqual([{ uid: "REQ001", fingerprint: "abc=" }]); // canonical dedup
    expect(index.childrenByUid.get("REQ001")).toEqual([child]); // single child, never doubled
    expect(index.findings).toEqual([]);
  });

  it("flags separator-variant duplicate item files as duplicate-UID errors", () => {
    const variant = itemFile("reqs/REQ/REQ_001.yml", "level: 1.5");
    const index = buildDoorstopIndex([reqDoc], [req001, variant], [], new Set());
    expect(index.byUid.get("REQ001")).toBe(req001); // first in sorted order wins
    expect(index.byUid.has("REQ_001")).toBe(false);
    expect(index.findings).toEqual([
      {
        severity: "error",
        uid: "REQ_001",
        path: "reqs/REQ/REQ_001.yml",
        message: "duplicate item UID: REQ_001 (also at reqs/REQ/REQ001.yml)",
      },
    ]);
    expect(index.ok).toBe(false);
  });

  it("flags case-variant duplicate item files as duplicate-UID errors", () => {
    const lower = itemFile("reqs/REQ/req001.yml", "level: 1.5");
    const index = buildDoorstopIndex([reqDoc], [req001, lower], [], new Set());
    expect(index.byUid.get("REQ001")).toBe(req001);
    expect(index.byUid.has("req001")).toBe(false);
    expect(index.findings).toEqual([
      {
        severity: "error",
        uid: "req001",
        path: "reqs/REQ/req001.yml",
        message: "duplicate item UID: req001 (also at reqs/REQ/REQ001.yml)",
      },
    ]);
    expect(index.ok).toBe(false);
  });

  it("flags documents whose parent prefix is undeclared", () => {
    const orphan = config({
      directoryPath: "reqs/LLT",
      configPath: "reqs/LLT/.doorstop.yml",
      prefix: "LLT",
      parentPrefix: "MISSING",
    });
    const index = buildDoorstopIndex([reqDoc, orphan], [req001], [], new Set());
    expect(index.findings).toContainEqual({
      severity: "warning",
      path: "reqs/LLT/.doorstop.yml",
      message: "document parent prefix not found: MISSING (parent of LLT)",
    });
  });

  it("reflects error-severity input diagnostics in ok", () => {
    const diagnostics: DiscoveryDiagnostic[] = [
      { severity: "error", path: "reqs/REQ/REQ001.yml", message: "invalid contents" },
    ];
    const index = buildDoorstopIndex([reqDoc], [req001], diagnostics, new Set());
    expect(index.ok).toBe(false);
  });

  it("sorts with the caller's arrays left untouched", () => {
    const unsortedItems = [tst001, req002, req001];
    const unsortedDocs = [tstDoc, reqDoc];
    const index = buildDoorstopIndex([...unsortedDocs], [...unsortedItems], [], new Set());
    expect(unsortedItems.map((i) => i.uid)).toEqual(["TST001", "REQ002", "REQ001"]);
    expect(unsortedDocs.map((d) => d.prefix)).toEqual(["TST", "REQ"]);
    expect(index.items.map((i) => i.uid)).toEqual(["TST001", "REQ001", "REQ002"]);
  });
});