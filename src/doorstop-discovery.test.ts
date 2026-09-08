// ---------------------------------------------------------------------------
// Layer 2 (node env): Doorstop discovery — bounded recursive `.doorstop.yml`
// walk through the injected files adapter, plus the minimal indentation-aware
// config reader. The fake adapter is structurally the same way the real
// `context.files` satisfies `DoorstopFiles` without importing the host API.
// Coverage mirrors opense-discovery.test.ts and adds the config-parse cases.
// ---------------------------------------------------------------------------

import type { FileTreeEntry, FileTreeResponse } from "@jmfederico/pi-web/plugin-api";
import { describe, expect, it, vi } from "vitest";
import type { DoorstopFileContent, DoorstopFiles } from "./doorstop-contract.js";
import {
  MAX_CONCURRENT_READS,
  MAX_DISCOVERY_DEPTH,
  MAX_DISCOVERY_ENTRIES,
  MAX_DISCOVERY_FILES,
  MAX_SKIPPED_DIRECTORIES,
  discoverDoorstopDocuments,
} from "./doorstop-discovery.js";
import { createFakeFiles, dirEntry, fileEntry, symlinkEntry, text, tree } from "./test-support.js";

const REQ_CONFIG = [
  "settings:",
  "  digits: 4",
  "  prefix: REQ",
  "  sep: '-'",
  "  parent: ''",
  "attributes:",
  "  defaults:",
  "    level: '1.0'",
  "    active: true",
  "    normative: true",
  "    derived: false",
  "    text: ''",
].join("\n");

const TST_CONFIG = [
  "settings:",
  "  prefix: TST",
  "  digits: 3",
  "  sep: ''",
  "  parent: REQ",
  "  itemformat: markdown",
].join("\n");

const IT_CONFIG = [
  "settings:",
  "  prefix: IT",
  "  digits: 4",
  "parent: TST",
  "itemformat: markdown",
].join("\n");

describe("doorstop discovery", () => {
  it("collects a multi-document tree (sorted by directory path) and the file index, parsing realistic and top-level configs", async () => {
    const { files, listCalls, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("docs", "docs"), fileEntry("notes.txt", "notes.txt"), symlinkEntry("link.yml", "link.yml")]),
        "docs": tree([dirEntry("reqs", "docs/reqs"), dirEntry("tests", "docs/tests"), fileEntry("README.md", "docs/README.md")]),
        "docs/reqs": tree([fileEntry(".doorstop.yml", "docs/reqs/.doorstop.yml"), fileEntry("REQ001.yml", "docs/reqs/REQ001.yml"), fileEntry("REQ002.yml", "docs/reqs/REQ002.yml")]),
        "docs/tests": tree([fileEntry(".doorstop.yml", "docs/tests/.doorstop.yml"), dirEntry("integration", "docs/tests/integration"), fileEntry("TST001.md", "docs/tests/TST001.md")]),
        "docs/tests/integration": tree([fileEntry(".doorstop.yml", "docs/tests/integration/.doorstop.yml"), fileEntry("IT001.md", "docs/tests/integration/IT001.md")]),
      },
      reads: {
        "docs/reqs/.doorstop.yml": text(REQ_CONFIG),
        "docs/tests/.doorstop.yml": text(TST_CONFIG),
        "docs/tests/integration/.doorstop.yml": text(IT_CONFIG),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      {
        directoryPath: "docs/reqs",
        configPath: "docs/reqs/.doorstop.yml",
        prefix: "REQ",
        digits: 4,
        separator: "-",
        itemformat: "yaml", // default: no itemformat key in this config
        extra: {
          attributes: {
            defaults: {
              level: "1.0",
              active: true,
              normative: true,
              derived: false,
              text: "",
            },
          },
        },
      },
      {
        directoryPath: "docs/tests",
        configPath: "docs/tests/.doorstop.yml",
        prefix: "TST",
        digits: 3,
        separator: "",
        parentPrefix: "REQ", // nested `settings.parent`
        itemformat: "markdown", // nested `settings.itemformat`
        extra: {},
      },
      {
        directoryPath: "docs/tests/integration",
        configPath: "docs/tests/integration/.doorstop.yml",
        prefix: "IT",
        digits: 4,
        separator: "",
        parentPrefix: "TST", // top-level `parent`
        itemformat: "markdown", // top-level `itemformat`
        extra: {},
      },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(listCalls).toEqual(["", "docs", "docs/reqs", "docs/tests", "docs/tests/integration"]);
    expect(readCalls).toEqual([
      "docs/reqs/.doorstop.yml",
      "docs/tests/.doorstop.yml",
      "docs/tests/integration/.doorstop.yml",
    ]);
    // Every enumerated file (configs, item files, docs) joins the index;
    // symlinks and skipped directories never do.
    expect(new Set(result.knownFilePaths)).toEqual(
      new Set([
        "notes.txt",
        "docs/README.md",
        "docs/reqs/.doorstop.yml",
        "docs/reqs/REQ001.yml",
        "docs/reqs/REQ002.yml",
        "docs/tests/.doorstop.yml",
        "docs/tests/TST001.md",
        "docs/tests/integration/.doorstop.yml",
        "docs/tests/integration/IT001.md",
      ]),
    );
  });

  it("skips .git and node_modules directories at any depth", async () => {
    const { files, listCalls, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry(".git", ".git"), dirEntry("node_modules", "node_modules"), dirEntry("src", "src")]),
        ".git": tree([fileEntry(".doorstop.yml", ".git/.doorstop.yml"), fileEntry("REQ001.yml", ".git/REQ001.yml")]),
        "node_modules": tree([fileEntry(".doorstop.yml", "node_modules/.doorstop.yml")]),
        "src": tree([dirEntry("node_modules", "src/node_modules"), fileEntry(".doorstop.yml", "src/.doorstop.yml")]),
        "src/node_modules": tree([fileEntry(".doorstop.yml", "src/node_modules/.doorstop.yml")]),
      },
      reads: { "src/.doorstop.yml": text("settings:\n  prefix: SRC") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "src", configPath: "src/.doorstop.yml", prefix: "SRC", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["src/.doorstop.yml"]));
    expect(listCalls).toEqual(["", "src"]);
    expect(readCalls).toEqual(["src/.doorstop.yml"]);
  });

  it("does not count skipped .git/node_modules entries toward the entries cap", async () => {
    const entries: FileTreeEntry[] = [];
    for (let i = 0; i < MAX_DISCOVERY_ENTRIES; i += 1) entries.push(dirEntry(".git", `g${String(i)}`));
    entries.push(fileEntry(".doorstop.yml", "reqs/.doorstop.yml"));

    const { files, readCalls } = createFakeFiles({
      trees: { "": tree(entries) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual(["reqs/.doorstop.yml"]);
  });

  it("reports (and skips) configs whose content was truncated or is binary, still indexing them", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("a", "a"), dirEntry("b", "b"), dirEntry("c", "c")]),
        "a": tree([fileEntry(".doorstop.yml", "a/.doorstop.yml")]),
        "b": tree([fileEntry(".doorstop.yml", "b/.doorstop.yml")]),
        "c": tree([fileEntry(".doorstop.yml", "c/.doorstop.yml")]),
      },
      reads: {
        "a/.doorstop.yml": { ...text("settings:\n  prefix: A"), truncated: true },
        "b/.doorstop.yml": { ...text(""), binary: true },
        "c/.doorstop.yml": text("settings:\n  prefix: C"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "c", configPath: "c/.doorstop.yml", prefix: "C", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "a/.doorstop.yml", message: "File content truncated by the workspace API and skipped" },
      { severity: "warning", path: "b/.doorstop.yml", message: "Binary file skipped; not parsed as a Doorstop document config" },
    ]);
    // Truncated/binary configs still joined the walk's file index.
    expect(new Set(result.knownFilePaths)).toEqual(
      new Set(["a/.doorstop.yml", "b/.doorstop.yml", "c/.doorstop.yml"]),
    );
  });

  it("reports read failures as diagnostics instead of throwing, still collecting the rest", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("bad", "bad"), dirEntry("good", "good")]),
        "bad": tree([fileEntry(".doorstop.yml", "bad/.doorstop.yml")]),
        "good": tree([fileEntry(".doorstop.yml", "good/.doorstop.yml")]),
      },
      reads: {
        "bad/.doorstop.yml": new Error("Permission denied"),
        "good/.doorstop.yml": text("settings:\n  prefix: GOOD"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "good", configPath: "good/.doorstop.yml", prefix: "GOOD", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "bad/.doorstop.yml", message: "Could not read file: Permission denied" },
    ]);
  });

  it("skips a config with a missing settings.prefix and reports it", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text("attributes:\n  reviewed:\n    - tag") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Invalid document config: missing required "settings.prefix"' },
    ]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["reqs/.doorstop.yml"]));
  });

  it("skips a config whose settings.prefix is not a scalar string", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix:\n    nested: true") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Invalid document config: "settings.prefix" must be a string' },
    ]);
  });

  it("skips a config whose settings.digits is not a non-negative integer", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: abc") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Invalid document config: "settings.digits" must be a non-negative integer' },
    ]);
  });

  it("skips a config with an unsupported itemformat", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  itemformat: html") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Invalid document config: unsupported "itemformat" value (expected "yaml" or "markdown")' },
    ]);
  });

  it("prefers a top-level parent/itemformat over nested settings values", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  parent: WRONG\n  itemformat: markdown\nparent: TST\nitemformat: yaml"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 3, separator: "", parentPrefix: "TST", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("stops the whole walk at the entries cap and reports it", async () => {
    const entries: FileTreeEntry[] = [];
    for (let i = 0; i < MAX_DISCOVERY_ENTRIES; i += 1) entries.push(fileEntry(`f${String(i)}.txt`, `f${String(i)}.txt`));
    entries.push(dirEntry("beyond", "beyond"));

    const { files, listCalls } = createFakeFiles({ trees: { "": tree(entries) } });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.knownFilePaths.size).toBe(MAX_DISCOVERY_ENTRIES);
    expect(result.diagnostics).toEqual([
      { severity: "warning", message: `Discovery stopped after ${String(MAX_DISCOVERY_ENTRIES)} entries; remaining files were not scanned` },
    ]);
    expect(listCalls).toEqual([""]);
  });

  it("stops collecting at the files cap and reports it", async () => {
    const entries: FileTreeEntry[] = [];
    const reads: Record<string, ReturnType<typeof text>> = {};
    for (let i = 0; i < MAX_DISCOVERY_FILES + 1; i += 1) {
      const path = `d${String(i).padStart(3, "0")}/.doorstop.yml`;
      entries.push(fileEntry(".doorstop.yml", path));
      reads[path] = text(`settings:\n  prefix: D${String(i).padStart(3, "0")}`);
    }

    const { files, readCalls } = createFakeFiles({ trees: { "": tree(entries) }, reads });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toHaveLength(MAX_DISCOVERY_FILES);
    expect(readCalls).toHaveLength(MAX_DISCOVERY_FILES);
    expect(result.diagnostics).toEqual([
      { severity: "warning", message: `Discovery stopped after ${String(MAX_DISCOVERY_FILES)} .doorstop.yml files; remaining files were not scanned` },
    ]);
  });

  it("stops expanding at the depth cap, still collects configs within it, and reports the cap once", async () => {
    const trees: Record<string, ReturnType<typeof tree>> = {
      "": tree([dirEntry("d1", "d1"), fileEntry(".doorstop.yml", ".doorstop.yml")]),
    };
    let dirPath = "d1";
    for (let level = 2; level <= MAX_DISCOVERY_DEPTH; level += 1) {
      const nextPath = `${dirPath}/d${String(level)}`;
      trees[dirPath] = tree([dirEntry(`d${String(level)}`, nextPath)]);
      dirPath = nextPath;
    }
    trees[dirPath] = tree([
      dirEntry("gone", `${dirPath}/gone`),
      dirEntry("gone2", `${dirPath}/gone2`),
      fileEntry(".doorstop.yml", `${dirPath}/.doorstop.yml`),
    ]);
    trees[`${dirPath}/gone`] = tree([fileEntry(".doorstop.yml", `${dirPath}/gone/.doorstop.yml`)]);
    trees[`${dirPath}/gone2`] = tree([fileEntry(".doorstop.yml", `${dirPath}/gone2/.doorstop.yml`)]);

    const { files, listCalls, readCalls } = createFakeFiles({
      trees,
      reads: {
        ".doorstop.yml": text("settings:\n  prefix: ROOT"),
        [`${dirPath}/.doorstop.yml`]: text("settings:\n  prefix: DEEP"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "", configPath: ".doorstop.yml", prefix: "ROOT", digits: 3, separator: "", itemformat: "yaml", extra: {} },
      { directoryPath: dirPath, configPath: `${dirPath}/.doorstop.yml`, prefix: "DEEP", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        path: `${dirPath}/gone`,
        message: `Discovery stopped expanding below ${String(MAX_DISCOVERY_DEPTH)} nested directories; deeper files were not scanned`,
      },
    ]);
    expect(listCalls).toHaveLength(MAX_DISCOVERY_DEPTH + 1); // root + d1..d12
    expect(listCalls).not.toContain(`${dirPath}/gone`);
    expect(listCalls).not.toContain(`${dirPath}/gone2`);
    expect(readCalls).toEqual([".doorstop.yml", `${dirPath}/.doorstop.yml`]);
  });

  it("reads collected configs with bounded concurrency (at most MAX_CONCURRENT_READS in flight)", async () => {
    const entries: FileTreeEntry[] = [];
    for (let i = 0; i < MAX_CONCURRENT_READS * 3; i += 1) {
      const path = `c${String(i).padStart(3, "0")}/.doorstop.yml`;
      entries.push(fileEntry(".doorstop.yml", path));
    }

    const readCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const files: DoorstopFiles = {
      listFiles: vi.fn<DoorstopFiles["listFiles"]>(() => Promise.resolve(tree(entries))),
      // Reads settle on a microtask after every call of the batch is issued
      // synchronously, so maxInFlight measures true peak concurrency.
      readFile: vi.fn<DoorstopFiles["readFile"]>((path: string) => {
        readCalls.push(path);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return Promise.resolve().then(() => {
          inFlight -= 1;
          return text("settings:\n  prefix: C");
        });
      }),
    };

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toHaveLength(MAX_CONCURRENT_READS * 3);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toHaveLength(MAX_CONCURRENT_READS * 3);
    expect(maxInFlight).toBe(MAX_CONCURRENT_READS);
  });

  it("reports a truncated directory listing while still scanning the returned entries", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("many", "many"), dirEntry("ok", "ok")]),
        "many": tree([fileEntry(".doorstop.yml", "many/.doorstop.yml")], true),
        "ok": tree([fileEntry(".doorstop.yml", "ok/.doorstop.yml")]),
      },
      reads: {
        "many/.doorstop.yml": text("settings:\n  prefix: MANY"),
        "ok/.doorstop.yml": text("settings:\n  prefix: OK"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "many", message: "Directory listing truncated by the workspace API; some entries were not scanned" },
    ]);
  });

  it("guards against a directory appearing as its own descendant (cycle safety)", async () => {
    const { files, listCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("a", "a")]),
        "a": tree([dirEntry("a", "a"), dirEntry("b", "a/b"), fileEntry(".doorstop.yml", "a/.doorstop.yml")]),
        "a/b": tree([dirEntry("a", "a"), fileEntry(".doorstop.yml", "a/b/.doorstop.yml")]),
      },
      reads: {
        "a/.doorstop.yml": text("settings:\n  prefix: A"),
        "a/b/.doorstop.yml": text("settings:\n  prefix: AB"),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents.map((d) => d.directoryPath)).toEqual(["a", "a/b"]);
    expect(result.diagnostics).toEqual([]);
    expect(listCalls).toEqual(["", "a", "a/b"]);
  });

  it("is total: a failed root listing becomes a diagnostic, not a throw", async () => {
    const { files } = createFakeFiles({ listErrors: { "": "Permission denied" } });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "error", message: "Could not list the workspace root: Permission denied" },
    ]);
  });

  it("reports a failed directory listing and continues the rest of the walk", async () => {
    const { files, listCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("ok", "ok"), dirEntry("bad", "bad")]),
        "ok": tree([fileEntry(".doorstop.yml", "ok/.doorstop.yml")]),
      },
      listErrors: { "bad": "No such directory" },
      reads: { "ok/.doorstop.yml": text("settings:\n  prefix: OK") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "bad", message: "Could not list directory: No such directory" },
    ]);
    expect(listCalls).toEqual(["", "ok", "bad"]);
  });

  it("returns an empty result for an empty workspace", async () => {
    const { files } = createFakeFiles({ trees: { "": tree([]) } });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set());
  });

  it("finds nothing in a workspace without .doorstop.yml files but still indexes the files", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([fileEntry("readme.md", "readme.md"), dirEntry("docs", "docs")]),
        "docs": tree([fileEntry("REQ001.yml", "docs/REQ001.yml"), fileEntry("guide.txt", "docs/guide.txt")]),
      },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual([]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["readme.md", "docs/REQ001.yml", "docs/guide.txt"]));
  });

  it("recognizes block scalars: keeps the settings after the block, captures content verbatim, and warns", async () => {
    const config = [
      "settings:",
      "  prefix: REQ",
      "  attributes:",
      "    defaults:",
      "      text: |",
      "        multi",
      "        line",
      "  digits: 4",
      "  notes: >",
      "    folded",
      "    text",
    ].join("\n");
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text(config) },
    });

    const result = await discoverDoorstopDocuments(files);

    // The settings AFTER each block scalar still parse — digits is 4, not the
    // default 3 the pre-fix reader silently fell back to after truncating.
    expect(result.documents).toEqual([
      {
        directoryPath: "reqs",
        configPath: "reqs/.doorstop.yml",
        prefix: "REQ",
        digits: 4,
        separator: "",
        itemformat: "yaml",
        extra: {
          settings: {
            attributes: { defaults: { text: "multi\nline" } },
            notes: "folded\ntext",
          },
        },
      },
    ]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Unsupported YAML block scalar after "text" (line 5); content captured verbatim' },
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Unsupported YAML block scalar after "notes" (line 9); content captured verbatim' },
    ]);
  });

  it("reports an unreadable deeper-indented line instead of silently ending the parse", async () => {
    const config = ["settings:", "  prefix: REQ", "  bogus: value", "    stray: deep", "  digits: 4"].join("\n");
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text(config) },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 4, separator: "", itemformat: "yaml", extra: { settings: { bogus: "value" } } },
    ]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "reqs/.doorstop.yml", message: 'Unreadable line 4 ("stray: deep"): indented deeper than its enclosing block and skipped' },
    ]);
  });

  it("coerces a quoted numeric settings.digits like Doorstop's int() loader", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: '4'") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 4, separator: "", itemformat: "yaml", extra: {} },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("commits read outcomes in encounter order even when reads settle out of order", async () => {
    // Root lists the documents in encounter order dir2 → dir1 → dir0, so the
    // read batch is issued in that order. The reads settle in REVERSE (dir0
    // first, dir2 last); commit order must still follow encounter order.
    // Directory-path sort would order dir0/dir1/dir2, so encounter-order
    // commit is observable through the (unsorted) diagnostics.
    const entries: FileTreeEntry[] = [
      dirEntry("dir2", "dir2"),
      fileEntry(".doorstop.yml", "dir2/.doorstop.yml"),
      dirEntry("dir1", "dir1"),
      fileEntry(".doorstop.yml", "dir1/.doorstop.yml"),
      dirEntry("dir0", "dir0"),
      fileEntry(".doorstop.yml", "dir0/.doorstop.yml"),
    ];

    const deferreds = new Map<string, { resolve: (value: DoorstopFileContent) => void; reject: (error: Error) => void }>();
    const files: DoorstopFiles = {
      listFiles: async (path: string) => (path === "" ? tree(entries) : tree([])),
      readFile: (path: string) =>
        new Promise<DoorstopFileContent>((resolve, reject) => {
          deferreds.set(path, { resolve, reject });
        }),
    };

    const discovery = discoverDoorstopDocuments(files);
    await vi.waitFor(() => expect(deferreds.size).toBe(3));

    // Settle in the opposite of issue order: dir0 first, dir2 last.
    const encounterOrder = ["dir2/.doorstop.yml", "dir1/.doorstop.yml", "dir0/.doorstop.yml"];
    for (const path of encounterOrder) {
      const gate = deferreds.get(path);
      if (gate === undefined) continue;
      if (path === "dir1/.doorstop.yml") gate.resolve(text("settings:\n  prefix: REQ"));
      else gate.reject(new Error(`boom ${path}`));
    }

    const result = await discovery;

    // The document set is complete regardless of settle order …
    expect(result.documents).toEqual([
      { directoryPath: "dir1", configPath: "dir1/.doorstop.yml", prefix: "REQ", digits: 3, separator: "", itemformat: "yaml", extra: {} },
    ]);
    // … and diagnostics keep encounter order: dir2's failure is recorded
    // before dir0's, even though dir0's read settled first.
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "dir2/.doorstop.yml", message: "Could not read file: boom dir2/.doorstop.yml" },
      { severity: "error", path: "dir0/.doorstop.yml", message: "Could not read file: boom dir0/.doorstop.yml" },
    ]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["dir2/.doorstop.yml", "dir1/.doorstop.yml", "dir0/.doorstop.yml"]));
  });

  it("keeps values containing colons intact (quoted sep and unquoted URL)", async () => {
    const config = ["settings:", "  prefix: REQ", "  sep: 'a:b'", "extensions:", "  url: http://example.com/x"].join("\n");
    const { files } = createFakeFiles({
      trees: { "": tree([dirEntry("reqs", "reqs")]), "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]) },
      reads: { "reqs/.doorstop.yml": text(config) },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([
      { directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 3, separator: "a:b", itemformat: "yaml", extra: { extensions: { url: "http://example.com/x" } } },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["reqs/.doorstop.yml"]));
  });

  it("diagnoses and skips a config whose path is not <dir>/.doorstop.yml", async () => {
    const { files } = createFakeFiles({
      trees: { "": tree([fileEntry(".doorstop.yml", "oddball")]) },
      reads: { "oddball": text("settings:\n  prefix: REQ") },
    });

    const result = await discoverDoorstopDocuments(files);

    expect(result.documents).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "oddball", message: 'Unexpected document config path ("oddball"); skipped' },
    ]);
    // The malformed path still joined the walk's file index.
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["oddball"]));
  });

  it("skips caller-declared excluded directories at any depth, merged with the built-in skip set", async () => {
    const { files, listCalls, readCalls } = createFakeFiles({
      trees: {
        "": tree([
          dirEntry(".git", ".git"), // built-in skip
          dirEntry("node_modules", "node_modules"), // built-in skip
          dirEntry("dist", "dist"), // caller exclusion, root level
          dirEntry("reqs", "reqs"),
          dirEntry("src", "src"),
        ]),
        ".git": tree([fileEntry(".doorstop.yml", ".git/.doorstop.yml")]),
        "node_modules": tree([fileEntry(".doorstop.yml", "node_modules/.doorstop.yml")]),
        "dist": tree([fileEntry(".doorstop.yml", "dist/.doorstop.yml")]),
        "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]),
        "src": tree([dirEntry("out", "src/out"), fileEntry(".doorstop.yml", "src/.doorstop.yml")]), // exclusion at depth 1
        "src/out": tree([fileEntry(".doorstop.yml", "src/out/.doorstop.yml")]),
      },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ"),
        "src/.doorstop.yml": text("settings:\n  prefix: SRC"),
      },
    });

    const result = await discoverDoorstopDocuments(files, { excludedDirectories: ["dist", "out"] });

    // Only reqs and src documents survive; dist (root) and src/out (nested)
    // were never expanded, exactly like .git/node_modules.
    expect(result.documents.map((d) => d.prefix)).toEqual(["REQ", "SRC"]);
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.knownFilePaths)).toEqual(new Set(["reqs/.doorstop.yml", "src/.doorstop.yml"]));
    expect(listCalls).toEqual(["", "reqs", "src"]);
    expect(readCalls).toEqual(["reqs/.doorstop.yml", "src/.doorstop.yml"]);
  });

  it("caps the merged skip set defensively against an unbounded exclusion list", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]),
      },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ") },
    });

    // An absurd caller list can never blow up the walk: the merged skip set is
    // capped, discovery still runs, and the cap never fires a diagnostic
    // (it is purely defensive).
    const hugeList = Array.from({ length: 5000 }, (_, index) => `dir${String(index)}`);
    const result = await discoverDoorstopDocuments(files, { excludedDirectories: hugeList });

    expect(result.documents.map((d) => d.prefix)).toEqual(["REQ"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts exactly 126 caller names beside the 2 built-ins before the merged skip-set cap fires", async () => {
    // The merged skip set = {.git, node_modules} (2) + caller names, capped at
    // MAX_SKIPPED_DIRECTORIES = 128 → exactly 126 caller names fit; the 127th
    // is dropped. A dropped name is an ORDINARY directory: the walk expands
    // it (listFiles is called), which listCalls makes observable — pinning
    // the cap arithmetic at the exact boundary rather than only "never breaks".
    const names = Array.from({ length: MAX_SKIPPED_DIRECTORIES + 2 }, (_, index) => `skip${String(index)}`);
    const rootEntries: FileTreeEntry[] = names.map((name) => dirEntry(name, name));
    rootEntries.push(dirEntry("reqs", "reqs"));
    const trees: Record<string, FileTreeResponse> = {
      "": tree(rootEntries),
      "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]),
    };
    for (const name of names) trees[name] = tree([]); // expandable but empty

    const { files, listCalls } = createFakeFiles({
      trees,
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ") },
    });

    const result = await discoverDoorstopDocuments(files, { excludedDirectories: names });

    expect(result.documents.map((d) => d.prefix)).toEqual(["REQ"]);
    expect(result.diagnostics).toEqual([]);
    // skip0..skip125 (126 names) fit inside the cap and are never listed;
    // skip126 — the 127th caller name — fell off the cap and was expanded
    // like any ordinary directory.
    expect(listCalls).toEqual(["", "skip126", "skip127", "skip128", "skip129", "reqs"]);
  });

  it("does not count caller-excluded directories toward the entries cap either", async () => {
    // 64 honored exclusion names + 1936 filler FILES + 1 config = 2001
    // listing entries. Counted entries (filler files + config = 1937) stay
    // under the cap ONLY because the excluded dirs short-circuit first — had
    // they counted, the cap would have fired mid-listing and stopped the walk
    // before the config. Filler files are files, so they count toward the cap
    // without being expanded (only directories are).
    const entries: FileTreeEntry[] = [];
    for (let i = 0; i < 64; i += 1) entries.push(dirEntry(`skip${String(i)}`, `skip${String(i)}`));
    for (let i = 0; i < MAX_DISCOVERY_ENTRIES - 64; i += 1) entries.push(fileEntry(`g${String(i)}.txt`, `g${String(i)}.txt`));
    entries.push(fileEntry(".doorstop.yml", "reqs/.doorstop.yml"));

    const { files, readCalls } = createFakeFiles({
      trees: { "": tree(entries) },
      reads: { "reqs/.doorstop.yml": text("settings:\n  prefix: REQ") },
    });

    const exclusions = Array.from({ length: 64 }, (_, index) => `skip${String(index)}`);
    const result = await discoverDoorstopDocuments(files, { excludedDirectories: exclusions });

    expect(result.documents.map((d) => d.prefix)).toEqual(["REQ"]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual(["reqs/.doorstop.yml"]);
  });
});
