// ---------------------------------------------------------------------------
// Bounded recursive `.doorstop.yml` workspace discovery + document-config
// reading.
//
// Walks the active workspace through an injected `files` adapter carrying
// only the two methods discovery needs (`listFiles` + `readFile`); the host
// `context.files` satisfies `DoorstopFiles` structurally and tests inject the
// in-memory fake from src/test-support.ts (createFakeFiles). No fetch/URL
// code lives here — the adapter is the only boundary.
//
// The walk follows the OpenSE discovery idiom (notes/opense-recon.md fact
// 10), copied with Doorstop semantics:
//
// - Every file named `.doorstop.yml` marks a Doorstop document; the file's
//   directory is the document's item directory. Only those config files are
//   read here; item files are parsed by the doorstop-model chain.
// - Hard caps bound the walk on large workspaces (entries visited, config
//   files admitted for reading, directory-listing depth). A fired cap stops
//   expansion and reports a diagnostic; caps never silently truncate.
// - Response flags are never dropped silently: a truncated listing, and a
//   config read flagged `truncated`/`binary`, each become a warning
//   diagnostic. Truncated/binary config content is NEVER parsed.
// - The minimal config reader is never silently lossy either: an unsupported
//   block scalar (`key: |` / `key: >`) consumes its deeper block verbatim
//   (into `extra`) so every setting AFTER it still parses, and raises a
//   warning; a line indented deeper than its enclosing block is skipped with
//   a warning instead of ending the parse; and a config path not shaped
//   exactly `.doorstop.yml` (root) or `<dir>/.doorstop.yml` is diagnosed and
//   skipped rather than yielding a silently wrong directory path.
// - Discovery is total: listFiles/readFile rejections become diagnostics, so
//   this module never throws on adapter failures.
// - Symlink entries are neither expanded nor collected, and never recorded
//   into the file index (a browser walk has no symlink-escape protection).
// - Determinism: traverses listFiles responses in returned order, a
//   visited-directory set guards against cyclic listings, read outcomes
//   commit in encounter order, and documents are sorted by directory path
//   before returning.
// - Reads are bounded-concurrent: readFile calls are issued in batches of up
//   to MAX_CONCURRENT_READS.
// - Depth semantics: the root listing is depth 0; directories at depth
//   1..MAX_DISCOVERY_DEPTH are expanded; deeper entries are reported once.
//
// Config parsing — the `.doorstop.yml` reader. This module reads the MINIMAL
// scalar subset the document config needs: `settings.prefix` (required),
// `settings.digits` (default 3 — Doorstop's `DEFAULT_DIGITS`, verified in
// doorstop/core/document.py; a quoted numeric string like `'4'` is coerced,
// mirroring Doorstop's `int(value)` loader), `settings.sep` (default "" —
// also Doorstop's `DEFAULT_SEP`), plus `parent`
// and `itemformat` at top level AND nested under `settings` (real Doorstop
// writes them under `settings`, see doorstop/core/document.py Document.save;
// the top-level spelling is also accepted, with the top-level value taking
// precedence when both are present). It is implemented as a small
// indentation-aware scalar reader for exactly those keys — NOT a general YAML
// parser (the model chain vendors js-yaml for item files). Everything else in
// the file is preserved in `extra` as a best-effort raw record (nested
// maps/lists of scalar leaves; unmodeled keys like `attributes`/`extensions`
// are kept so downstream chains can read e.g. `attributes.reviewed`).
//
//   KNOWN LIMITATION (deliberate): YAML features beyond scalar maps/lists
//   are not modeled. Block scalars (`|`/`>` and their `|-`/`|+`/`|2` variants)
//   and lines indented deeper than their enclosing block raise a warning and
//   are consumed WITHOUT truncating the file: block content is preserved
//   verbatim in `extra` and stray lines are skipped, so neither can silently
//   drop the settings that follow them. Flow collections on one line
//   (`[a, b]`, `{a: 1}`), anchors/aliases/tags (`!include`, `&a`), escape
//   sequences, and exotic quoting are captured verbatim as opaque strings.
//   Malformed *known* settings (a non-scalar or missing `prefix`, a
//   non-negative-integer `digits` — a quoted numeric string like `'4'`
//   is coerced, mirroring Doorstop's `int(value)` loader — or an unknown
//   `itemformat`) make the document config invalid: the document is skipped
//   with a warning diagnostic, exactly like a truncated/binary read. Config
//   paths that are not exactly `.doorstop.yml` or `<dir>/.doorstop.yml` are
//   diagnosed and skipped instead of deriving a wrong directory path.
//   Configs are machine-written by Doorstop in practice, so these forms are
//   rare; full YAML fidelity for configs is out of scope (mirroring the
//   OpenSE policy of diagnosing what is not understood rather than guessing).
// ---------------------------------------------------------------------------

import { formatUnknownError, isRecord } from "./doorstop-contract.js";
import type {
  DiscoveryDiagnostic,
  DoorstopDiscoveryResult,
  DoorstopDocumentConfig,
  DoorstopFileContent,
  DoorstopFiles,
  DoorstopFileTree,
  DoorstopItemFormat,
} from "./doorstop-contract.js";

/** Path of the workspace root, matching `context.files.listFiles("")`. */
const WORKSPACE_ROOT = "";

/** Exact file name that marks a Doorstop document directory. */
const DOORSTOP_CONFIG_NAME = ".doorstop.yml";

/** Hard cap: total tree entries examined across every listFiles response. */
export const MAX_DISCOVERY_ENTRIES = 2000;
/** Hard cap: `.doorstop.yml` files admitted for reading. */
export const MAX_DISCOVERY_FILES = 500;
/** Hard cap: deepest directory the walk expands (the root listing is depth 0). */
export const MAX_DISCOVERY_DEPTH = 12;
/** Max readFile calls issued concurrently (bounded batches of ~8). */
export const MAX_CONCURRENT_READS = 8;

/** Directories never expanded, at any depth (matched by exact leaf name). */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

const ENTRIES_CAP_MESSAGE = `Discovery stopped after ${String(MAX_DISCOVERY_ENTRIES)} entries; remaining files were not scanned`;
const FILES_CAP_MESSAGE = `Discovery stopped after ${String(MAX_DISCOVERY_FILES)} .doorstop.yml files; remaining files were not scanned`;
const DEPTH_CAP_MESSAGE = `Discovery stopped expanding below ${String(MAX_DISCOVERY_DEPTH)} nested directories; deeper files were not scanned`;
const TREE_TRUNCATED_MESSAGE = "Directory listing truncated by the workspace API; some entries were not scanned";
const BINARY_FILE_MESSAGE = "Binary file skipped; not parsed as a Doorstop document config";
const TRUNCATED_FILE_MESSAGE = "File content truncated by the workspace API and skipped";
const READ_ERROR_PREFIX = "Could not read file: ";

/** One directory queued for expansion: its path and listing depth. */
interface PendingDirectory {
  path: string;
  depth: number;
}

// --- minimal indentation-aware scalar reader for .doorstop.yml -----------------

/** One non-empty, non-comment line of config text, with its indentation. */
interface ConfigLine {
  /** Number of leading whitespace characters (Doorstop writes 2-space indents). */
  indent: number;
  /** The line content, trimmed of leading/trailing whitespace. */
  content: string;
  /** 1-based source line number (for reader diagnostics). */
  lineNumber: number;
}

/** Nested map of parsed config values (indirect so the type is not circular). */
interface ConfigRecord {
  [key: string]: ConfigValue;
}

/** Parsed plain config value: nested maps/lists of scalar leaves. */
type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigRecord;

/** Successful read of a valid document config. */
interface ConfigSuccess {
  kind: "config";
  config: DoorstopDocumentConfig;
  /** Reader warnings (block scalars, unreadable lines) collected while
   *  parsing this config; surfaced as diagnostics even for valid configs. */
  problems: string[];
}

/** Invalid config — the document is skipped and a warning diagnostic emitted. */
interface ConfigProblem {
  kind: "problem";
  problem: string;
  /** Reader warnings collected before the fatal problem (may be empty). */
  problems: string[];
}

type ConfigReadResult = ConfigSuccess | ConfigProblem;

/** Keys extracted from the `settings` block (Doorstop's modeled settings). */
const MODELED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "prefix",
  "digits",
  "sep",
  "parent",
  "itemformat",
]);

function isItemFormat(value: unknown): value is DoorstopItemFormat {
  return value === "yaml" || value === "markdown";
}

/**
 * Split a config content string into indentation-tagged lines, dropping blank
 * lines and full-line comments. Never throws; unreadable lines vanish here
 * (the reader is best effort by design — see the module header).
 */
function toConfigLines(content: string): ConfigLine[] {
  const lines: ConfigLine[] = [];
  let lineNumber = 1;
  for (const rawLine of content.split(/\r?\n/)) {
    const indentMatch = /^[ \t]*/.exec(rawLine);
    const contentStart = indentMatch === null ? 0 : indentMatch[0].length;
    const trimmed = rawLine.slice(contentStart).trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      lines.push({ indent: contentStart, content: trimmed, lineNumber });
    }
    lineNumber += 1;
  }
  return lines;
}

/**
 * Split one `key: value` map line into its key and (trimmed) value text.
 * Returns undefined for lines that are not map entries (no key separator).
 * Quotes inside the key are not supported (Doorstop writes plain keys).
 */
function splitMapLine(content: string): { key: string; valueText: string } | undefined {
  let quote = "";
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    if (ch === undefined) break;
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      const key = content.slice(0, index).trim();
      if (key === "") return undefined;
      return { key, valueText: content.slice(index + 1).trim() };
    }
  }
  return undefined;
}

/** True when a line is a `- item` sequence entry. */
function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

/** Strip a trailing inline comment (" #…"), leaving the comment-less text. */
function stripInlineComment(text: string): string {
  const inlineComment = text.indexOf(" #");
  return inlineComment >= 0 ? text.slice(0, inlineComment).trimEnd() : text;
}

/** True when the (comment-stripped) value is a YAML block scalar indicator
 *  (`|`, `>`, and their `|+`/`|-`/`|2`/`>-`… chomping/indent variants). */
function isBlockScalarIndicator(valueText: string): boolean {
  return /^[>|][+-]?\d*$/.test(valueText);
}

/**
 * Resolve one scalar leaf into a plain value. Recognizes single/double
 * quotes, trailing inline comments, booleans/null, and integers/floats;
 * anything else stays an opaque string. The scalar subset is deliberately
 * narrow — see the module header for the documented limitations.
 */
function parseScalar(valueText: string): ConfigValue {
  const trimmed = valueText.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "";
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const close = trimmed.indexOf(first, 1);
    // Close must not be the last character handling an empty pair like ''.
    if (close > 0) return trimmed.slice(1, close);
    return trimmed; // unbalanced quote: keep the raw text (best effort)
  }
  const scalarText = stripInlineComment(trimmed);
  if (scalarText === "") return "";
  if (scalarText === "true" || scalarText === "True" || scalarText === "TRUE") return true;
  if (scalarText === "false" || scalarText === "False" || scalarText === "FALSE") return false;
  if (scalarText === "null" || scalarText === "Null" || scalarText === "NULL" || scalarText === "~") {
    return null;
  }
  if (/^-?\d+$/.test(scalarText)) return Number.parseInt(scalarText, 10);
  if (/^-?\d+\.\d+$/.test(scalarText)) return Number.parseFloat(scalarText);
  return scalarText;
}

/** Parse the block starting at `start` (a nested map or a scalar list). */
function parseValueBlock(
  lines: ConfigLine[],
  start: number,
  problems: string[],
): { value: ConfigValue; next: number } {
  const first = lines[start];
  if (first === undefined) return { value: {}, next: start };
  return isSequenceItem(first.content) ? parseListBlock(lines, start, problems) : parseMapBlock(lines, start, problems);
}

/** Parse consecutive `key: value` lines sharing one indentation level. */
function parseMapBlock(
  lines: ConfigLine[],
  start: number,
  problems: string[],
): { value: Record<string, ConfigValue>; next: number } {
  const mapIndent = lines[start]?.indent ?? 0;
  const value: Record<string, ConfigValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.indent < mapIndent) break; // returned to an ancestor level
    if (line.indent > mapIndent) {
      // Stray line indented deeper than this block: the reader cannot
      // attribute it to a key here. Report it instead of ending the parse
      // silently (breaking would truncate the remainder of the file).
      problems.push(
        `Unreadable line ${String(line.lineNumber)} ("${line.content}"): indented deeper than its enclosing block and skipped`,
      );
      index += 1;
      continue;
    }
    if (isSequenceItem(line.content)) break; // a list where a map was expected
    const entry = splitMapLine(line.content);
    if (entry === undefined) {
      // Not a `key: value` line (e.g. a bare scalar continuation): drop it.
      index += 1;
      continue;
    }
    if (entry.valueText === "") {
      // `key:` — value is the following deeper block when one exists.
      const next = lines[index + 1];
      if (next !== undefined && next.indent > line.indent) {
        const child = parseValueBlock(lines, index + 1, problems);
        value[entry.key] = child.value;
        index = child.next;
      } else {
        value[entry.key] = "";
        index += 1;
      }
      continue;
    }
    if (isBlockScalarIndicator(stripInlineComment(entry.valueText))) {
      // Block scalar (`key: |`): YAML makes every deeper line block content.
      // The reader cannot model it faithfully — capture the block verbatim,
      // consume it, and warn, so the settings that FOLLOW the block are never
      // silently dropped (the old behavior truncated the rest of the file).
      const blockContent: string[] = [];
      let blockIndex = index + 1;
      while (blockIndex < lines.length) {
        const blockLine = lines[blockIndex];
        if (blockLine === undefined || blockLine.indent <= line.indent) break;
        blockContent.push(blockLine.content);
        blockIndex += 1;
      }
      problems.push(
        `Unsupported YAML block scalar after "${entry.key}" (line ${String(line.lineNumber)}); content captured verbatim`,
      );
      value[entry.key] = blockContent.length === 0 ? entry.valueText : blockContent.join("\n");
      index = blockIndex;
      continue;
    }
    value[entry.key] = parseScalar(entry.valueText);
    index += 1;
  }
  return { value, next: index };
}

/** Parse consecutive `- item` lines sharing one indentation level. */
function parseListBlock(
  lines: ConfigLine[],
  start: number,
  problems: string[],
): { value: ConfigValue[]; next: number } {
  const listIndent = lines[start]?.indent ?? 0;
  const value: ConfigValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.indent < listIndent) break;
    if (line.indent > listIndent) {
      problems.push(
        `Unreadable line ${String(line.lineNumber)} ("${line.content}"): indented deeper than its enclosing list and skipped`,
      );
      index += 1;
      continue;
    }
    if (!isSequenceItem(line.content)) break; // the map after a list
    const itemText = line.content === "-" ? "" : line.content.slice(2).trim();
    const next = lines[index + 1];
    if (itemText === "" || itemText.startsWith("#")) {
      if (next !== undefined && next.indent > line.indent) {
        const child = parseValueBlock(lines, index + 1, problems);
        value.push(child.value);
        index = child.next;
      } else {
        value.push("");
        index += 1;
      }
      continue;
    }
    if (isBlockScalarIndicator(stripInlineComment(itemText))) {
      const blockContent: string[] = [];
      let blockIndex = index + 1;
      while (blockIndex < lines.length) {
        const blockLine = lines[blockIndex];
        if (blockLine === undefined || blockLine.indent <= line.indent) break;
        blockContent.push(blockLine.content);
        blockIndex += 1;
      }
      problems.push(
        `Unsupported YAML block scalar at list item on line ${String(line.lineNumber)}; content captured verbatim`,
      );
      value.push(blockContent.length === 0 ? itemText : blockContent.join("\n"));
      index = blockIndex;
      continue;
    }
    value.push(parseScalar(itemText));
    index += 1;
  }
  return { value, next: index };
}

/**
 * Parse config text into a best-effort structural record plus the reader
 * warnings collected along the way (block scalars, stray lines). Depth is
 * bounded only by the input (configs are machine-written and shallow);
 * pathological nesting surfaces as a caught error from the caller's
 * perspective.
 */
function readConfigRoot(content: string): { root: Record<string, ConfigValue>; problems: string[] } {
  const lines = toConfigLines(content);
  if (lines.length === 0) return { root: {}, problems: [] };
  const problems: string[] = [];
  const rootValue = parseValueBlock(lines, 0, problems).value;
  if (typeof rootValue === "object" && rootValue !== null && !Array.isArray(rootValue)) {
    return { root: rootValue, problems };
  }
  // A top-level list/scalar cannot be a document config.
  return { root: {}, problems };
}

/**
 * Read one config's known scalar settings from the structural record. Returns
 * the problem string when the config is invalid (document skipped), otherwise
 * the normalized {@link DoorstopDocumentConfig}.
 */
function parseDocumentConfig(
  directoryPath: string,
  configPath: string,
  content: string,
): ConfigReadResult {
  let root: Record<string, ConfigValue>;
  let problems: string[];
  try {
    const parsedRoot = readConfigRoot(content);
    root = parsedRoot.root;
    problems = parsedRoot.problems;
  } catch (error) {
    return { kind: "problem", problem: `malformed YAML (${formatUnknownError(error)})`, problems: [] };
  }

  const rawSettings = root["settings"];
  if (rawSettings !== undefined && rawSettings !== null && !isRecord(rawSettings)) {
    return { kind: "problem", problem: 'invalid "settings" section (expected a mapping)', problems };
  }
  const settings = isRecord(rawSettings) ? rawSettings : undefined;

  // settings.prefix is required and must be a non-empty string.
  const prefixValue = settings?.["prefix"];
  if (prefixValue === undefined || prefixValue === null || prefixValue === "") {
    return { kind: "problem", problem: 'missing required "settings.prefix"', problems };
  }
  if (typeof prefixValue !== "string") {
    return { kind: "problem", problem: '"settings.prefix" must be a string', problems };
  }
  const prefix = prefixValue.trim();
  if (prefix === "") {
    return { kind: "problem", problem: 'missing required "settings.prefix"', problems };
  }

  // settings.digits defaults to 3 (Doorstop's DEFAULT_DIGITS) and must be a
  // non-negative integer. A quoted numeric string (`digits: '4'` — YAML-legal)
  // is coerced, mirroring Doorstop's own loader (`int(value)`); a non-numeric
  // string stays invalid.
  let digits = 3;
  const digitsValue = settings?.["digits"];
  if (digitsValue !== undefined && digitsValue !== null) {
    const digitsNumber =
      typeof digitsValue === "number"
        ? digitsValue
        : typeof digitsValue === "string" && /^\d+$/.test(digitsValue)
          ? Number(digitsValue)
          : undefined;
    if (digitsNumber === undefined || !Number.isInteger(digitsNumber) || digitsNumber < 0) {
      return { kind: "problem", problem: '"settings.digits" must be a non-negative integer', problems };
    }
    digits = digitsNumber;
  }

  // settings.sep defaults to ""; must be a string when present.
  let separator = "";
  const sepValue = settings?.["sep"];
  if (sepValue !== undefined && sepValue !== null) {
    if (typeof sepValue !== "string") {
      return { kind: "problem", problem: '"settings.sep" must be a string', problems };
    }
    separator = sepValue;
  }

  // itemformat defaults to "yaml"; a top-level value wins over the nested
  // `settings.itemformat` (real Doorstop writes the nested spelling).
  let itemformat: DoorstopItemFormat = "yaml";
  const topItemformat = root["itemformat"];
  const nestedItemformat = settings?.["itemformat"];
  if (topItemformat !== undefined && topItemformat !== null) {
    if (!isItemFormat(topItemformat)) {
      return { kind: "problem", problem: 'unsupported "itemformat" value (expected "yaml" or "markdown")', problems };
    }
    itemformat = topItemformat;
  } else if (nestedItemformat !== undefined && nestedItemformat !== null) {
    if (!isItemFormat(nestedItemformat)) {
      return { kind: "problem", problem: 'unsupported "itemformat" value (expected "yaml" or "markdown")', problems };
    }
    itemformat = nestedItemformat;
  }

  // parent: an empty value (top level or under settings) means a root
  // document, normalized away. A non-string scalar is invalid. Top-level
  // wins over the nested spelling when both are present.
  let parentPrefix: string | undefined;
  const topParent = root["parent"];
  const nestedParent = settings?.["parent"];
  const readParent = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const topParentValue = readParent(topParent);
  if (topParentValue === null) {
    return { kind: "problem", problem: '"parent" must be a string', problems };
  }
  parentPrefix = topParentValue;
  if (parentPrefix === undefined) {
    const nestedParentValue = readParent(nestedParent);
    if (nestedParentValue === null) {
      return { kind: "problem", problem: '"parent" must be a string', problems };
    }
    parentPrefix = nestedParentValue;
  }

  return {
    kind: "config",
    problems,
    config: {
      directoryPath,
      configPath,
      prefix,
      digits,
      separator,
      itemformat,
      ...(parentPrefix === undefined ? {} : { parentPrefix }),
      extra: captureExtra(root),
    },
  };
}

/**
 * Best-effort raw record of everything the model does not consume: the parsed
 * structural record with the modeled keys removed (top-level `parent`/
 * `itemformat` and the known `settings` scalars). Values for unmodeled keys
 * come straight from the scalar reader — see the module header's limitations.
 */
function captureExtra(root: Record<string, ConfigValue>): Record<string, unknown> {
  const extra: Record<string, unknown> = { ...root };
  delete extra["parent"];
  delete extra["itemformat"];
  const settings = extra["settings"];
  if (isRecord(settings)) {
    for (const key of MODELED_SETTINGS_KEYS) {
      delete settings[key];
    }
    if (Object.keys(settings).length === 0) delete extra["settings"];
  }
  return extra;
}

/** The directory holding a config file — its document's item directory. */
function documentDirectory(configPath: string): string {
  if (configPath.length === DOORSTOP_CONFIG_NAME.length) return WORKSPACE_ROOT;
  return configPath.slice(0, configPath.length - DOORSTOP_CONFIG_NAME.length - 1);
}

function isDoorstopConfigName(name: string): boolean {
  return name === DOORSTOP_CONFIG_NAME;
}

/**
 * Discover every `.doorstop.yml` under the workspace root through the injected
 * `files` adapter, read each document config, and return the normalized
 * document configs (sorted by directory path) plus diagnostics for skipped/
 * inaccessible content and the workspace-root-relative paths of every file the
 * walk enumerated (`knownFilePaths` — the discovery file index of feature spec
 * §6). Never throws: adapter failures and invalid configs are diagnosed.
 */
export async function discoverDoorstopDocuments(files: DoorstopFiles): Promise<DoorstopDiscoveryResult> {
  const documents: DoorstopDocumentConfig[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  const knownFilePaths = new Set<string>();
  const visitedDirectories = new Set<string>([WORKSPACE_ROOT]);

  let entriesVisited = 0;
  let filesAdmitted = 0;
  let depthCapReported = false;
  let walkStopped = false;

  const pendingConfigReads: string[] = [];
  const pending: PendingDirectory[] = [{ path: WORKSPACE_ROOT, depth: 0 }];
  let nextIndex = 0;
  while (nextIndex < pending.length && !walkStopped) {
    const directory = pending[nextIndex];
    if (directory === undefined) break;
    nextIndex += 1;

    let tree: DoorstopFileTree;
    try {
      tree = await files.listFiles(directory.path);
    } catch (error) {
      diagnostics.push(listErrorDiagnostic(directory.path, error));
      continue;
    }

    for (const entry of tree.entries) {
      // Skipped directories cost nothing toward the entries cap — the cap
      // bounds work actually examined, not entries short-circuited first.
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;

      entriesVisited += 1;
      if (entriesVisited > MAX_DISCOVERY_ENTRIES) {
        diagnostics.push({ severity: "warning", message: ENTRIES_CAP_MESSAGE });
        walkStopped = true;
        break;
      }

      if (entry.type === "directory") {
        if (directory.depth + 1 > MAX_DISCOVERY_DEPTH) {
          if (!depthCapReported) {
            depthCapReported = true;
            diagnostics.push({ severity: "warning", path: entry.path, message: DEPTH_CAP_MESSAGE });
          }
          continue;
        }
        if (visitedDirectories.has(entry.path)) continue;
        visitedDirectories.add(entry.path);
        pending.push({ path: entry.path, depth: directory.depth + 1 });
        continue;
      }

      if (entry.type !== "file") continue; // symlinks: neither expanded nor collected

      // Every file the walk enumerates joins the file index, configs and item
      // files alike (knownFilePaths backs the missing-reference chip).
      knownFilePaths.add(entry.path);

      if (!isDoorstopConfigName(entry.name)) continue;

      // Admission precedes the read, so the cap bounds readFile calls even
      // though read outcomes (binary/truncated/failure) are not yet known.
      if (filesAdmitted >= MAX_DISCOVERY_FILES) {
        diagnostics.push({ severity: "warning", message: FILES_CAP_MESSAGE });
        walkStopped = true;
        break;
      }
      filesAdmitted += 1;
      pendingConfigReads.push(entry.path);
      if (pendingConfigReads.length >= MAX_CONCURRENT_READS) {
        await flushPendingConfigReads(pendingConfigReads, documents, diagnostics, files);
      }
    }

    if (tree.truncated) {
      diagnostics.push({ severity: "warning", path: directory.path, message: TREE_TRUNCATED_MESSAGE });
    }
  }

  // The final partial batch (and any reads admitted before another cap fired).
  await flushPendingConfigReads(pendingConfigReads, documents, diagnostics, files);

  documents.sort(compareByDirectoryPath);
  return { documents, diagnostics, knownFilePaths };
}

/**
 * Issue every pending config path's readFile call (up to MAX_CONCURRENT_READS
 * at once — the batch size is the concurrency bound), then commit the outcomes
 * in encounter order. Rejections are handled per-read via allSettled, so one
 * failing read never loses the rest of the batch.
 */
async function flushPendingConfigReads(
  pending: string[],
  documents: DoorstopDocumentConfig[],
  diagnostics: DiscoveryDiagnostic[],
  files: DoorstopFiles,
): Promise<void> {
  const paths = pending.splice(0);
  if (paths.length === 0) return;
  const settled = await Promise.allSettled(paths.map((path) => files.readFile(path)));
  // Zip outcomes with their paths so commit order is encounter order.
  const outcomes = paths.map((path, index) => ({ path, result: settled[index] }));
  for (const { path, result } of outcomes) {
    if (result === undefined) continue;
    applyConfigReadResult(path, result, documents, diagnostics);
  }
}

/** Commit one config read outcome: diagnostics on rejection/binary/truncated/
 *  invalid config, else the normalized document config. */
function applyConfigReadResult(
  path: string,
  settled: PromiseSettledResult<DoorstopFileContent>,
  documents: DoorstopDocumentConfig[],
  diagnostics: DiscoveryDiagnostic[],
): void {
  if (settled.status === "rejected") {
    diagnostics.push({
      severity: "error",
      path,
      message: `${READ_ERROR_PREFIX}${formatUnknownError(settled.reason)}`,
    });
    return;
  }

  // A config path must be exactly `.doorstop.yml` (workspace root) or
  // `<dir>/.doorstop.yml`; any other shape is a malformed host path whose
  // derived directoryPath would be silently wrong — surface it instead.
  if (path !== DOORSTOP_CONFIG_NAME && !path.endsWith(`/${DOORSTOP_CONFIG_NAME}`)) {
    diagnostics.push({ severity: "warning", path, message: `Unexpected document config path ("${path}"); skipped` });
    return;
  }

  // A binary or truncated file must never reach the config reader: report and
  // skip (its path still joined knownFilePaths when it was enumerated).
  if (settled.value.binary) {
    diagnostics.push({ severity: "warning", path, message: BINARY_FILE_MESSAGE });
    return;
  }
  if (settled.value.truncated) {
    diagnostics.push({ severity: "warning", path, message: TRUNCATED_FILE_MESSAGE });
    return;
  }

  const result = parseDocumentConfig(documentDirectory(path), path, settled.value.content);
  // Reader warnings (block scalars, unreadable lines) surface even when the
  // config is otherwise valid — never a silent best-effort read.
  for (const problem of result.problems) {
    diagnostics.push({ severity: "warning", path, message: problem });
  }
  if (result.kind === "problem") {
    diagnostics.push({
      severity: "warning",
      path,
      message: `Invalid document config: ${result.problem}`,
    });
    return;
  }
  documents.push(result.config);
}

function listErrorDiagnostic(path: string, error: unknown): DiscoveryDiagnostic {
  return path === WORKSPACE_ROOT
    ? { severity: "error", message: `Could not list the workspace root: ${formatUnknownError(error)}` }
    : { severity: "error", path, message: `Could not list directory: ${formatUnknownError(error)}` };
}

/** Code-unit string comparison — fully environment-independent ordering. */
function compareByDirectoryPath(a: DoorstopDocumentConfig, b: DoorstopDocumentConfig): number {
  return a.directoryPath < b.directoryPath ? -1 : a.directoryPath > b.directoryPath ? 1 : 0;
}
