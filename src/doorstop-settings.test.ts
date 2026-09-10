// ---------------------------------------------------------------------------
// Layer 2 (node env): Opendoor workspace settings — `.pi-web/opendoor.json`
// reading + validation (the workspace-tasks `.pi-web/tasks.json` idiom).
// Covers: missing file (defaults, no diagnostic), unreadable/binary/
// truncated reads (warning + defaults), malformed JSON / wrong shape
// (warning + defaults, never throwing), the strict `version` gate, unknown
// keys tolerated for forward compatibility, `publishTarget` safe-relative-
// path validation, and `excludedDirectories` name validation (invalid
// entries dropped with warnings, dedup, the 16-cap, the 64-char cap).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DoorstopFiles } from "./doorstop-contract.js";
import {
  DEFAULT_OPENDOOR_SETTINGS,
  DEFAULT_PUBLISH_TARGET,
  MAX_EXCLUDED_DIRECTORY_LENGTH,
  MAX_EXCLUDED_DIRECTORIES,
  OPENDOOR_SETTINGS_PATH,
  OPENDOOR_SETTINGS_VERSION,
  parseOpendoorSettings,
  parseOpendoorSettingsText,
  readOpendoorSettings,
} from "./doorstop-settings.js";
import { createFakeFiles, text } from "./test-support.js";

const WARNING = "warning" as const;

describe("readOpendoorSettings (the read path)", () => {
  it("returns defaults with no diagnostic when the settings file is missing (the real missing-file error)", async () => {
    const { files } = createFakeFiles();
    const result = await readOpendoorSettings(files);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics).toEqual([]);
  });

  it("pins the coupling to the real API's missing-file message on the fake side (exact string)", async () => {
    // The settings module treats a read rejection as the benign missing-file
    // default ONLY when the error message is exactly "Path does not exist" —
    // the real workspace API's message, mirrored deliberately by
    // createFakeFiles in src/test-support.ts (see MISSING_FILE_ERROR in
    // doorstop-settings.ts). If the fake ever drifts, this exact-match test
    // fails loudly instead of every settings-less load quietly warning.
    const { files } = createFakeFiles();
    let caught: unknown;
    try {
      await files.readFile(OPENDOOR_SETTINGS_PATH);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : undefined).toBe("Path does not exist");
    // That exact message is what settles the read on defaults, no diagnostic.
    const result = await readOpendoorSettings(files);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics).toEqual([]);
  });

  it("warns (not silently defaults) when the missing-file message is only a near miss", async () => {
    // The drift the coupling comment warns about: the real API starts
    // appending the path ("Path does not exist: <path>"). The module's match
    // is EXACT, so a near miss must surface as a "Could not read" warning —
    // never a quiet default. Pinned so tightening/loosening the match is a
    // deliberate, visible decision.
    const nearMissFiles: DoorstopFiles = {
      listFiles: () => Promise.reject(new Error("not used")),
      readFile: () => Promise.reject(new Error(`Path does not exist: ${OPENDOOR_SETTINGS_PATH}`)),
    };
    const result = await readOpendoorSettings(nearMissFiles);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics).toEqual([
      { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("Could not read") },
    ]);
  });

  it("warns (with defaults) when the settings file cannot be read for another reason", async () => {
    const { files } = createFakeFiles({
      reads: { [OPENDOOR_SETTINGS_PATH]: new Error("Permission denied") },
    });
    const result = await readOpendoorSettings(files);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics).toEqual([
      {
        severity: WARNING,
        path: OPENDOOR_SETTINGS_PATH,
        message: expect.stringContaining("Could not read"),
      },
    ]);
  });

  it("warns (with defaults) for a binary settings file", async () => {
    const { files } = createFakeFiles({
      reads: { [OPENDOOR_SETTINGS_PATH]: { ...text(""), binary: true } },
    });
    const result = await readOpendoorSettings(files);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics[0]?.message).toContain("must be a text file");
  });

  it("warns (with defaults) for a truncated settings file", async () => {
    const { files } = createFakeFiles({
      reads: { [OPENDOOR_SETTINGS_PATH]: { ...text('{"publishTarget"'), truncated: true } },
    });
    const result = await readOpendoorSettings(files);
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics[0]?.message).toContain("truncated");
  });
});

describe("parseOpendoorSettingsText (JSON layer)", () => {
  it("warns (with defaults) on malformed JSON", () => {
    const result = parseOpendoorSettingsText("{ not json");
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.diagnostics).toEqual([
      { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("Invalid JSON") },
    ]);
  });

  it("warns (with defaults) on valid JSON of the wrong shape", () => {
    for (const value of ["null", "[1, 2]", '"string"', "42"]) {
      const result = parseOpendoorSettingsText(value);
      expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
      expect(result.diagnostics).toEqual([
        { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("must contain a JSON object") },
      ]);
    }
  });
});

describe("parseOpendoorSettings (validation)", () => {
  it("tolerates unknown keys silently (forward compatibility)", () => {
    const result = parseOpendoorSettings({ version: 1, futureKey: { anything: [1, 2, 3] }, publishTarget: "site" });
    expect(result.settings).toEqual({ publishTarget: "site", excludedDirectories: [] });
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts an absent version and the supported version", () => {
    expect(parseOpendoorSettings({ version: OPENDOOR_SETTINGS_VERSION }).settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(parseOpendoorSettings({}).settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
  });

  it("rejects a wrong version with a warning and full defaults (an unknown future schema is not half-read)", () => {
    // Numeric and non-numeric wrong versions alike fail the strict `!==`
    // gate — a future schema must never be half-read, whatever its shape.
    for (const badVersion of [2, "1", true]) {
      const result = parseOpendoorSettings({ version: badVersion, publishTarget: "site", excludedDirectories: ["x"] });
      expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
      expect(result.diagnostics).toEqual([
        { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("unsupported \"version\"") },
      ]);
    }
  });

  describe("publishTarget", () => {
    it("accepts a safe relative path (trimmed), normalizing duplicate/trailing separators", () => {
      // A leading "./" (the default spelling) is preserved; duplicate
      // separators collapse and a trailing separator drops so a later
      // publish join stays predictable.
      const result = parseOpendoorSettings({ publishTarget: "  ./docs/out/  " });
      expect(result.settings.publishTarget).toBe("./docs/out");
      expect(result.diagnostics).toEqual([]);
      expect(parseOpendoorSettings({ publishTarget: "a//b" }).settings.publishTarget).toBe("a/b");
      expect(parseOpendoorSettings({ publishTarget: "./public" }).settings.publishTarget).toBe("./public");
    });

    it("rejects traversal, absolute, backslashed, leading-dash, empty, and non-string targets with a warning + default", () => {
      for (const bad of ["../outside", "a/../b", "/abs", "\\evil", "site\\out", "C:/site", "c:site", "-x", "-public", "", "   "]) {
        const result = parseOpendoorSettings({ publishTarget: bad });
        expect(result.settings.publishTarget).toBe(DEFAULT_PUBLISH_TARGET);
        expect(result.diagnostics).toEqual([
          { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("invalid \"publishTarget\"") },
        ]);
      }
      const nonString = parseOpendoorSettings({ publishTarget: 42 });
      expect(nonString.settings.publishTarget).toBe(DEFAULT_PUBLISH_TARGET);
      expect(nonString.diagnostics[0]?.message).toContain("invalid \"publishTarget\"");
    });
  });

  describe("excludedDirectories", () => {
    it("accepts plain names (trimmed), deduplicating duplicates silently", () => {
      const result = parseOpendoorSettings({ excludedDirectories: ["dist", "  build ", "dist", "assets"] });
      expect(result.settings.excludedDirectories).toEqual(["dist", "build", "assets"]);
      expect(result.diagnostics).toEqual([]);
    });

    it("drops invalid entries with a warning each: separators, traversal, empty, non-strings, over-length", () => {
      const tooLong = "x".repeat(MAX_EXCLUDED_DIRECTORY_LENGTH + 1);
      const result = parseOpendoorSettings({
        excludedDirectories: ["a/b", "c\\d", "..", "a..b", "", 42, null, tooLong, "good"],
      });
      expect(result.settings.excludedDirectories).toEqual(["good"]);
      expect(result.diagnostics.length).toBe(8);
      expect(result.diagnostics.every((d) => d.message.includes("not a plain directory name"))).toBe(true);
    });

    it("keeps a name at exactly the length cap and a full-length name deduped", () => {
      const atCap = "y".repeat(MAX_EXCLUDED_DIRECTORY_LENGTH);
      const result = parseOpendoorSettings({ excludedDirectories: [atCap, atCap] });
      expect(result.settings.excludedDirectories).toEqual([atCap]);
      expect(result.diagnostics).toEqual([]);
    });

    it("caps the distinct names at 16 and warns once about the overflow", () => {
      const entries = Array.from({ length: MAX_EXCLUDED_DIRECTORIES + 3 }, (_, index) => `dir${String(index)}`);
      const result = parseOpendoorSettings({ excludedDirectories: entries });
      expect(result.settings.excludedDirectories).toEqual(entries.slice(0, MAX_EXCLUDED_DIRECTORIES));
      expect(result.diagnostics).toEqual([
        { severity: WARNING, path: OPENDOOR_SETTINGS_PATH, message: expect.stringContaining("more than 16 entries") },
      ]);
    });

    it("warns (with none) when excludedDirectories is not an array", () => {
      const result = parseOpendoorSettings({ excludedDirectories: "dist" });
      expect(result.settings.excludedDirectories).toEqual([]);
      expect(result.diagnostics[0]?.message).toContain("must be an array");
    });
  });

  it("truncates hostile-value echoes inside diagnostics (no megabyte warnings)", () => {
    const huge = "x".repeat(10_000);
    const targetResult = parseOpendoorSettings({ publishTarget: `${huge}/..` }); // invalid: traversal
    expect(targetResult.diagnostics[0]?.message.length ?? 0).toBeLessThan(300);
    const entryResult = parseOpendoorSettings({ excludedDirectories: [huge] }); // invalid: over-length name
    expect(entryResult.diagnostics[0]?.message.length ?? 0).toBeLessThan(300);
    const versionResult = parseOpendoorSettings({ version: huge }); // invalid: wrong version
    expect(versionResult.diagnostics[0]?.message.length ?? 0).toBeLessThan(300);
  });
});