// ---------------------------------------------------------------------------
// Opendoor model chain: item parsing and index assembly (feature spec §5/§6 —
// docs/feature-doorstop-plugin.md, module `doorstop-model.ts` in the
// architecture diagram).
//
// Implements the two model contracts declared in the FROZEN boundary module
// (src/doorstop-contract.ts — its types imported here, never redefined):
//
//     parseDoorstopItem(path, content, config) → DoorstopParseResult
//     buildDoorstopIndex(documents, items, diagnostics, knownFilePaths) → DoorstopIndex
//
// Parsing mirrors upstream Doorstop (doorstop-dev/doorstop, core/item.py,
// core/common.py, core/types.py) as closely as the browser toolchain allows:
//
//   - itemformat "yaml"     — the whole file is YAML (common.load_yaml).
//   - itemformat "markdown" — YAML frontmatter between leading `---` dash
//     fences of 3+ dashes (common.load_markdown via python-frontmatter; the
//     fence split mirrors deployed frontmatter 1.3.0 exactly — see
//     `splitMarkdown`): `header` is derived from the first level-1 markdown
//     heading of the body and the remaining body becomes `text`
//     (common.update_data_from_markdown_content).
//
//     YAML-schema caveat (state chain): the frontmatter YAML is parsed with
//     js-yaml in non-JSON mode, which applies the YAML 1.2 core schema — NOT
//     the YAML 1.1 schema of python-frontmatter's PyYAML SafeLoader, despite
//     `{ json: false }`. The modeled fields compensate (`to_bool` handles
//     `yes`/`off`/etc., `stampFrom` mirrors `Stamp`, level/text are
//     normalized), but scalar typing differences leak into non-modeled
//     extended/`raw` attributes — e.g. `due: 2024-01-01` is a
//     `datetime.date` in Python but a string here. Doorstop's stamp
//     serialization is type-aware (`_convert_to_str` embeds the Python
//     type), so fingerprint parity (computeItemStamp) can break for extended
//     *reviewed* attributes holding such scalars.
//   - Attribute normalization follows Item._set_attributes + the type layer:
//     `Level` component normalization (with the documented YAML float gotcha
//     `level: 1.10` → 1.1), `Text` load_text for text/header, `to_bool` for
//     active/normative/derived, `ref` stripping, and Stamp semantics for
//     links/reviewed (`- REQ001` / `- REQ001: null` → fingerprint null; a
//     legacy boolean `reviewed: true` — the `Stamp(True)` placeholder —
//     becomes null with a warning, see `reviewedFrom`).
//
// Conventions (contract idiom, notes/opense-recon.md fact 12): optional
// fields are OMITTED — never set to `undefined` (`exactOptionalPropertyTypes`
// is on). Parsing never throws: every content problem becomes a
// {DiscoveryDiagnostic} and a default-configured item is returned so the
// downstream state chain always has an ItemRecord to annotate.
//
// Truncation/binary obligation: parseDoorstopItem receives *strings* — the
// discovery chain guarantees that reads whose `truncated`/`binary` flags are
// set never reach a parser (see the `DiscoverDoorstopDocuments` contract; the
// feature spec §6 missing-reference chip builds on the same file index). A
// truncated file is therefore never observable here. The one binary signal
// that survives into a string — a NUL byte, which no valid YAML scalar can
// contain — is still refused defensively below.
// ---------------------------------------------------------------------------

import * as yaml from "js-yaml";

import type {
  BuildDoorstopIndex,
  DiscoveryDiagnostic,
  DoorstopCounts,
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopItemReference,
  DoorstopParseResult,
  Finding,
  ItemRecord,
  LinkRecord,
  ParseDoorstopItem,
} from "./doorstop-contract.js";

// --- constants -----------------------------------------------------------------

/** Default item level (Item.DEFAULT_LEVEL). */
const DEFAULT_LEVEL = "1.0";
/** Item content keys the model knows; every other parsed key is an extended
 *  attribute (Doorstop `Item.attribute(name)` data). */
const MODELED_ATTRIBUTE_KEYS = new Set([
  "active",
  "derived",
  "normative",
  "level",
  "header",
  "text",
  "links",
  "ref",
  "references",
  "reviewed",
]);
/** UID prefix/number separators (Doorstop settings.SEP_CHARS). */
const SEP_CHARS = "-_.";

// --- small helpers ---------------------------------------------------------------

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return String(value);
}

/** Doorstop to_bool: YAML 1.1 truthy strings, otherwise Boolean(). */
function toBool(value: unknown): boolean {
  if (typeof value === "string") {
    const lowered = value.toLowerCase().trim();
    return lowered === "yes" || lowered === "true" || lowered === "enabled" || lowered === "1";
  }
  return Boolean(value);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Doorstop Text.load_text: drop leading/trailing blank lines, rstrip every
 *  line (normalizes the `|` block scalars Doorstop writes). */
function loadText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = typeof value === "string" ? value : String(value);
  return raw
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

/** Spread of Doorstop UID.split_uid: prefix + number|name, over the separator
 *  characters "-_." (`\w` is ASCII here — close enough for the ASCII UIDs
 *  Doorstop generates; documented approximation). */
interface UidParts {
  prefix: string;
  number: number | null;
  name: string | null;
}

function splitUid(value: string): UidParts | undefined {
  const withSeparator = /^([\w.-]+)[-_\.](\w+)/.exec(value);
  if (withSeparator) {
    const prefix = withSeparator[1] ?? "";
    const rest = withSeparator[2] ?? "";
    if (/^\d+$/.test(rest)) {
      const number = Number(rest);
      if (Number.isSafeInteger(number)) return { prefix, number, name: null };
    }
    return { prefix, number: null, name: rest };
  }
  const prefixAndNumber = /^([\w.-]*\D)(\d+)/.exec(value);
  if (prefixAndNumber) {
    const prefix = (prefixAndNumber[1] ?? "").replace(new RegExp(`[${SEP_CHARS}]+$`), "");
    return { prefix, number: Number(prefixAndNumber[2]), name: null };
  }
  return undefined;
}

/** Identity key under Doorstop UID equality: separator-agnostic
 *  ("REQ001" ≡ "REQ_001" ≡ "REQ-001") and prefix-case-agnostic
 *  ("req001" ≡ "REQ001", matching `Prefix.__eq__`'s `.lower()`; the name
 *  part stays case-sensitive like UID's plain-str comparison). */
function canonicalUidKey(uid: string): string | undefined {
  const parts = splitUid(uid);
  if (parts === undefined) return undefined;
  const prefix = parts.prefix.toLowerCase();
  if (parts.number !== null) return `${prefix}#${parts.number}`;
  return `${prefix}#name:${parts.name}`;
}

/** Level string parts, for ordering and duplicate-level comparisons. */
function levelPartsOf(value: string): number[] {
  return value.split(".").map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

// --- level normalization ----------------------------------------------------------

/** js-yaml collapses `2.0` to the number 2, so a YAML float's `.0` is
 *  unrecoverable. Doorstop (Python) keeps `str(2.0) == "2.0"`, and the files
 *  it writes store two-part levels as floats (`level: 1.2`, `level: 1.0`), so
 *  rendering integer-valued numbers with a trailing `.0` matches the common
 *  case; ordering stays identical either way.
 *
 *  Heading trade-off: a trailing `.0` is ALSO Doorstop's heading marker
 *  (types.py: zeros are reserved for heading levels; item.md: a
 *  non-normative item whose level ends in `.0` is treated as a document
 *  heading), and Python's `Level(1)` is the non-heading `"1"`. The JS YAML
 *  layer cannot tell `level: 1.0` from `level: 1`, so both render as
 *  `"1.0"` here — `level: 1` gets heading-marked where Doorstop would keep
 *  a plain non-heading `"1"`. Downstream consumers see the `.0` suffix
 *  consistently and treat `.0`-suffixed levels like Python's heading flag. */
function levelStringForNumber(value: number): string {
  if (Number.isInteger(value)) return `${value}.0`;
  return String(value);
}

/** Doorstop Level.load_level parts from any YAML value. Undefined for shapes
 *  Doorstop would reject (non-numeric parts). */
function levelParts(value: unknown): number[] | undefined {
  let nums: unknown[];
  if (Array.isArray(value)) {
    nums = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    nums = levelStringForNumber(value).split(".");
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    nums = trimmed.split(".");
  } else if (value === undefined || value === null) {
    nums = [1]; // Level(None) → load_level default → [1]
  } else {
    return undefined;
  }
  const parts: number[] = [];
  for (const num of nums) {
    if (typeof num !== "string" && typeof num !== "number") return undefined;
    const n = Number(num);
    if (!Number.isFinite(n)) return undefined;
    parts.push(n);
  }
  return parts;
}

/** Doorstop Level string form: periods keep at most one trailing ".0"
 *  (heading marker), so "1.10" → "1.1.0" and "1.0.0" → "1.0". */
function levelToString(parts: number[]): string {
  if (parts.length === 0) return DEFAULT_LEVEL;
  if (parts[parts.length - 1] === 0) {
    let trimmed = parts;
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === 0) {
      trimmed = trimmed.slice(0, -1);
    }
    parts = [...trimmed, 0];
  }
  return parts.join(".");
}

// --- name / path handling -------------------------------------------------------------

/** Item UID = file name without extension (os.path.splitext semantics: last
 *  extension). */
function uidFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Resolve a reference/ref path — Doorstop stores these relative to the item
 *  file's directory — into workspace-root-relative form (the knownFilePaths
 *  path format of the contract). Base is the owning document's directory;
 *  items live directly in their document directory, so this equals the item
 *  file's own directory for well-formed workspaces (which is what the
 *  contract pins down in `DoorstopItemReference.path`). ".." segments clamp
 *  at the workspace root. */
function resolveRefPath(baseDir: string, refPath: string): string {
  const combined = baseDir === "" ? refPath : `${baseDir}/${refPath}`;
  const out: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

// --- scalar normalization ------------------------------------------------------------

/** Stamp semantics for a link fingerprint / `reviewed` value: null-ish and
 *  YAML-1.1-truthy scalars become null (Doorstop's `Stamp()`/`Stamp(True)`
 *  placeholders), every other string is kept verbatim. */
function stampFrom(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const lowered = value.toLowerCase().trim();
    if (lowered === "" || lowered === "yes" || lowered === "true" || lowered === "enabled" || lowered === "1") {
      return null;
    }
    return value;
  }
  return null;
}

/** Doorstop's `Stamp(True)` placeholder — "manually-confirmed matching hash,
 *  to be replaced later" (types.py `Stamp.__init__`): a bare boolean where a
 *  fingerprint belongs. Old Doorstop items stored the review status that way,
 *  and any YAML-1.1-truthy scalar (to_bool: `yes`/`true`/`enabled`/`1`,
 *  booleans, non-zero numbers) still normalizes to it today. The modern
 *  `reviewed` property (item.py) lazily replaces a stored `Stamp(True)` with
 *  the item's CURRENT stamp, so upstream a legacy `reviewed: true` reads as
 *  reviewed-at-current-stamp. The model chain cannot compute stamps (that is
 *  computeItemStamp's job), so a legacy placeholder is normalized to
 *  `reviewed: null` with a warning — the state chain flags the item
 *  unreviewed until `doorstop review` rewrites the file, and `item.raw`
 *  keeps the legacy value verbatim. */
function isLegacyReviewPlaceholder(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.toLowerCase().trim();
    return lowered === "yes" || lowered === "true" || lowered === "enabled" || lowered === "1";
  }
  return false;
}

/** `reviewed` normalization (buildItemRecord): Stamp semantics for the item's
 *  own review fingerprint — a fingerprint string is kept, `Stamp(None)` forms
 *  (null/false/0/'') are silent null (never reviewed, exactly like
 *  `stampFrom`), and a `Stamp(True)` legacy placeholder becomes null WITH a
 *  warning (see {@link isLegacyReviewPlaceholder}). Links keep their own
 *  silent placeholder→null mapping — the contract documents `null` as
 *  covering `Stamp()`/`Stamp(True)` there. */
function reviewedFrom(value: unknown, path: string, diagnostics: DiscoveryDiagnostic[]): string | null {
  if (isLegacyReviewPlaceholder(value)) {
    diagnostics.push({
      severity: "warning",
      path,
      message: "legacy boolean reviewed attribute; treat as unreviewed until next doorstop review",
    });
  }
  return stampFrom(value);
}

/** Doorstop `ref` handling: `str(value) if value else ""`, stripped.
 *  Non-empty reference paths are resolved root-relative afterwards. */
function normalizeRef(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** Doorstop `references` array semantics + yaml_validator checks. Paths are
 *  resolved against the document directory; `keyword`/`sha` are preserved.
 *  Non-conforming entries become warnings and are skipped (Doorstop fails the
 *  whole item load instead — the model prefers a non-fatal diagnostic). */
function normalizeReferences(
  value: unknown,
  baseDir: string,
  diagnostics: DiscoveryDiagnostic[],
  path: string,
): DoorstopItemReference[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    // yaml_validator.py: `references:` (explicit null) fails the WHOLE item
    // upstream ("'references' must be an array with at least one reference
    // element"); the model's non-fatal preference turns it into a warning
    // and treats the item as having no references.
    diagnostics.push({
      severity: "warning",
      path,
      message: "'references' must be an array with at least one reference element",
    });
    return undefined;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "warning",
      path,
      message: `'references' must be an array, got: ${describe(value)}`,
    });
    return undefined;
  }
  const out: DoorstopItemReference[] = [];
  for (const entry of value) {
    if (!isRecordLike(entry)) {
      diagnostics.push({ severity: "warning", path, message: "'references' member must be a dictionary" });
      continue;
    }
    // yaml_validator's check order: type key → path key → type value →
    // path string → keyword string.
    if (!hasOwn(entry, "type")) {
      diagnostics.push({ severity: "warning", path, message: "'references' member must have a 'type' key" });
      continue;
    }
    if (!hasOwn(entry, "path")) {
      diagnostics.push({ severity: "warning", path, message: "'references' member must have a 'path' key" });
      continue;
    }
    if (entry["type"] !== "file") {
      diagnostics.push({ severity: "warning", path, message: "'references' member's 'type' value must be a 'file'" });
      continue;
    }
    if (typeof entry["path"] !== "string") {
      diagnostics.push({ severity: "warning", path, message: "'references' member's path must be a string value" });
      continue;
    }
    if (hasOwn(entry, "keyword") && typeof entry["keyword"] !== "string") {
      diagnostics.push({ severity: "warning", path, message: "'references' member's 'keyword' must be a string value" });
      continue;
    }
    const reference: DoorstopItemReference = {
      type: "file",
      path: resolveRefPath(baseDir, entry["path"] as string),
    };
    if (typeof entry["keyword"] === "string") reference.keyword = entry["keyword"] as string;
    // Doorstop never validates `sha`: a non-string value keeps the entry
    // upstream (its fingerprint serializes the raw dict, type-aware). The
    // contract pins `sha` to string, so a non-string sha is simply omitted
    // from the normalized form — the `raw` escape hatch preserves it.
    if (typeof entry["sha"] === "string") reference.sha = entry["sha"] as string;
    out.push(reference);
  }
  return out.length > 0 ? out : undefined;
}

/** Doorstop `links` semantics: each entry is either a bare UID string or a
 *  one-key {UID: stamp} mapping (UID(dict) keeps the FIRST pair — a
 *  multi-key mapping is not an error, matching types.py UID.__init__).
 *  Link UIDs are deduplicated with set semantics — first occurrence keeps
 *  its stamp, exactly like Python set.add of equal UIDs — and file order is
 *  preserved (Doorstop re-sorts links on save; the model reports what the
 *  file says). The dedup key is Doorstop UID equality (canonicalUidKey),
 *  not the raw string: "REQ001" and "REQ_001" are one UID, and keeping
 *  both would resolve to the same target twice in childrenByUid. */
function normalizeLinks(
  value: unknown,
  diagnostics: DiscoveryDiagnostic[],
  path: string,
): LinkRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({ severity: "warning", path, message: `'links' must be an array, got: ${describe(value)}` });
    return [];
  }
  const out: LinkRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    let uid: unknown;
    let fingerprint: unknown;
    if (typeof entry === "string") {
      uid = entry;
      fingerprint = null;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      uid = entry;
      fingerprint = null;
    } else if (isRecordLike(entry)) {
      // UID(dict): keep the first {UID: stamp} pair (types.py:126-131);
      // any further keys are ignored silently, exactly like upstream.
      const keys = Object.keys(entry);
      if (keys.length === 0) {
        diagnostics.push({ severity: "warning", path, message: `invalid link entry: ${describe(entry)}` });
        continue;
      }
      uid = keys[0];
      fingerprint = entry[keys[0] as string];
    } else {
      diagnostics.push({ severity: "warning", path, message: `invalid link entry: ${describe(entry)}` });
      continue;
    }
    if (typeof uid !== "string" && typeof uid !== "number" && typeof uid !== "boolean") {
      diagnostics.push({ severity: "warning", path, message: `invalid link UID: ${describe(uid)}` });
      continue;
    }
    const uidString = String(uid);
    if (uidString === "") {
      diagnostics.push({ severity: "warning", path, message: "link entry with empty UID" });
      continue;
    }
    // Set semantics keyed on UID equality: separator/case variants of one
    // UID collapse to the first occurrence ("REQ001" and "REQ_001" are the
    // same UID for Doorstop and for the reverse-link map).
    const key = canonicalUidKey(uidString) ?? uidString;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uid: uidString, fingerprint: stampFrom(fingerprint) });
  }
  return out;
}

// --- markdown body derivation ---------------------------------------------------------

/** Level-1 heading regex of the markdown body (common.update_data_from_markdown_content). */
const MARKDOWN_H1 = /^#{1}\s+(.*)$/;

/**
 * Derive `header` from the first level-1 heading of the body and keep the
 * remaining body as `text`, mirroring the upstream algorithm:
 *
 *   1. walk to the first non-blank line — if it is a level-1 heading, that is
 *      the header, otherwise it opens the text;
 *   2. when a header was found, skip blank lines before the text starts;
 *   3. everything left is text (raw lines; the shared loadText normalization
 *      runs afterwards, exactly like Doorstop's Text(value) wrap).
 */
function deriveMarkdownBody(content: string): { header: string | null; text: string } {
  const lines = content.split("\n");
  let index = 0;
  let header: string | null = null;
  const parts: string[] = [];

  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const match = MARKDOWN_H1.exec(line.trim());
    if (match) {
      header = match[1] ?? null;
    } else {
      parts.push(line);
    }
    index++;
    break;
  }

  if (header !== null) {
    while (index < lines.length && (lines[index] ?? "").trim() === "") index++;
    if (index < lines.length) {
      parts.push(lines[index] ?? "");
      index++;
    }
  }

  for (; index < lines.length; index++) {
    parts.push(lines[index] ?? "");
  }

  return { header, text: parts.join("\n") };
}

/** Split markdown-with-frontmatter into its YAML frontmatter and body,
 *  matching python-frontmatter 1.3.0 (the pinned upstream, poetry.lock)
 *  exactly: `frontmatter.parse` strips leading whitespace, then the
 *  YAMLHandler boundary `^-{3,}\s*$` splits the text on the FIRST TWO
 *  dash-fence lines (3+ dashes, nothing else) — the first opens the
 *  frontmatter, the second closes it. Without a closing fence there is no
 *  frontmatter and the whole content is body.
 *
 *  Pinned consequences of that dash-only, two-fence split (same behavior —
 *  and same failure modes — as upstream):
 *   - `...` is NOT a fence. A `...` line stays frontmatter content: inside
 *     a block scalar it is legal YAML and cannot truncate the frontmatter;
 *     at column 0 the YAML parser itself treats it as a document-end marker
 *     (`---`-fenced YAML followed by `...` closes the document; further
 *     YAML after it is a "single document" parse error — same as PyYAML).
 *   - `----`/`-----` (4+ dashes) open and close the frontmatter exactly
 *     like `---` (upstream's `-{3,}` has no upper bound).
 *   - a dash-fence line INSIDE the frontmatter (e.g. inside a block scalar)
 *     is taken as the closing fence — frontmatter truncates and the YAML
 *     parse fails with an error diagnostic, identically to upstream's naive
 *     split. Fences in the BODY after the closing fence are inert: the
 *     split consumes at most two fence lines, and `-- --`-style lines
 *     (non-consecutive dashes) never match the boundary regex at all.
 *   - leading blank lines before the opening fence are skipped, mirroring
 *     upstream's leading-whitespace strip before fence detection.
 */
function splitMarkdown(text: string): { frontmatter: string; body: string } {
  const lines = text.split("\n");
  // python-frontmatter YAMLHandler.FM_BOUNDARY: `^-{3,}\s*$` (dashes only).
  const isFence = (line: string) => /^-{3,}\s*$/.test(line);

  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start++;
  if (start >= lines.length || !isFence(lines[start] ?? "")) {
    return { frontmatter: "", body: text };
  }

  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFence(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: "", body: text };

  return {
    frontmatter: lines.slice(start + 1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

// --- parse pipeline ------------------------------------------------------------------

/** Parse a "yaml"-format item file: the entire content is YAML.
 *  Throws for parse failures (the caller converts them to diagnostics). */
function parseYamlFile(path: string, content: string): Record<string, unknown> {
  const parsed = yaml.load(content, { json: false, filename: path }) ?? {};
  if (!isRecordLike(parsed)) {
    throw new Error(`invalid contents: ${path} (expected a mapping, got ${describe(parsed)})`);
  }
  return parsed;
}

/** Parse a "markdown"-format item file: YAML frontmatter between leading
 *  `---` fences; `header`/`text` derived from the body. The returned object
 *  mirrors Doorstop's post-load data dict: frontmatter attributes plus the
 *  body-derived `header` (when found) and `text` (always — the derived values
 *  override any frontmatter copies, exactly like update_data_from_markdown_content).
 *  Throws for YAML failures (the caller converts them to diagnostics; the
 *  body text is discarded with the file, as Doorstop does on load failure). */
function parseMarkdownFile(path: string, content: string): Record<string, unknown> {
  const { frontmatter, body } = splitMarkdown(content);
  let data: Record<string, unknown> = {};
  if (frontmatter !== "") {
    const parsed = yaml.load(frontmatter, { json: false, filename: path }) ?? {};
    if (!isRecordLike(parsed)) {
      throw new Error(`invalid contents: ${path} (expected a mapping, got ${describe(parsed)})`);
    }
    data = parsed;
  }
  const { header, text } = deriveMarkdownBody(body);
  const merged: Record<string, unknown> = { ...data };
  if (header !== null) merged["header"] = header;
  merged["text"] = text;
  return merged;
}

/** Assemble a default-configured ItemRecord (Doorstop Item defaults). */
function defaultItem(path: string, config: DoorstopDocumentConfig): ItemRecord {
  return {
    uid: uidFromPath(path),
    documentPrefix: config.prefix,
    path,
    level: DEFAULT_LEVEL,
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
  };
}

/** Normalize a successfully parsed item dict into an ItemRecord. */
function buildItemRecord(
  path: string,
  config: DoorstopDocumentConfig,
  parsed: Record<string, unknown>,
  diagnostics: DiscoveryDiagnostic[],
): ItemRecord {
  const item = defaultItem(path, config);

  const uid = item.uid;
  const filename = path.split("/").pop() ?? path;
  if (splitUid(uid) === undefined) {
    diagnostics.push({ severity: "warning", path, message: `invalid item filename: ${filename}` });
  }

  if (hasOwn(parsed, "level")) {
    const parts = levelParts(parsed["level"]);
    if (parts === undefined) {
      diagnostics.push({
        severity: "warning",
        path,
        message: `invalid level value: ${describe(parsed["level"])}`,
      });
    } else {
      item.level = levelToString(parts);
    }
  }
  if (hasOwn(parsed, "active")) item.active = toBool(parsed["active"]);
  if (hasOwn(parsed, "derived")) item.derived = toBool(parsed["derived"]);
  if (hasOwn(parsed, "normative")) item.normative = toBool(parsed["normative"]);
  if (hasOwn(parsed, "header")) {
    const header = loadText(parsed["header"]);
    if (header !== "") item.header = header; // OMITTED when the item has none
  }
  item.text = loadText(parsed["text"]);
  const ref = hasOwn(parsed, "ref") ? normalizeRef(parsed["ref"]) : "";
  item.ref = ref === "" ? "" : resolveRefPath(config.directoryPath, ref);
  if (hasOwn(parsed, "references")) {
    const references = normalizeReferences(parsed["references"], config.directoryPath, diagnostics, path);
    if (references !== undefined) item.references = references; // OMITTED when none
  }
  if (hasOwn(parsed, "links")) item.links = normalizeLinks(parsed["links"], diagnostics, path);
  if (hasOwn(parsed, "reviewed")) item.reviewed = reviewedFrom(parsed["reviewed"], path, diagnostics);

  const attributes: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (MODELED_ATTRIBUTE_KEYS.has(key)) continue;
    attributes[key] = parsed[key];
  }
  item.attributes = attributes;
  item.raw = parsed;

  return item;
}

/**
 * `parseDoorstopItem` — see the `ParseDoorstopItem` contract.
 *
 * One item file (YAML, or markdown with YAML frontmatter) → normalized
 * {@link ItemRecord} + per-file diagnostics. Never throws on content problems:
 * malformed/unparsable content yields an error diagnostic and a
 * default-configured item.
 *
 * The caller must only pass content from reads whose
 * `DoorstopFileContent.truncated`/`.binary` flags were clear — that is the
 * discovery chain's obligation (see {@link DiscoverDoorstopDocuments}); a
 * truncated string is not observable here. As defense-in-depth, content that
 * still smuggles binary in (a NUL byte — impossible in valid YAML) is refused
 * with a warning and never parsed.
 */
export const parseDoorstopItem: ParseDoorstopItem = (path, content, config) => {
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (content.indexOf("\u0000") !== -1) {
    diagnostics.push({
      severity: "warning",
      path,
      message: "binary content (NUL byte) not parsed — discovery should have skipped this read",
    });
    return { item: defaultItem(path, config), diagnostics };
  }
  if (config.itemformat !== "yaml" && config.itemformat !== "markdown") {
    // Doorstop raises on unknown itemformats (item.py _check_itemformat);
    // discovery is supposed to normalize these away, so a stray value
    // becomes a warning here and parsing falls back to yaml.
    diagnostics.push({
      severity: "warning",
      path,
      message: `unknown itemformat '${String(config.itemformat)}' — treated as yaml`,
    });
  }
  try {
    const parsed =
      config.itemformat === "markdown"
        ? parseMarkdownFile(path, content)
        : parseYamlFile(path, content);
    return { item: buildItemRecord(path, config, parsed, diagnostics), diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({ severity: "error", path, message: `invalid contents: ${path}: ${message}` });
    return { item: defaultItem(path, config), diagnostics };
  }
};

// --- index assembly ------------------------------------------------------------------

function compareDocuments(left: DoorstopDocumentConfig, right: DoorstopDocumentConfig): number {
  return left.directoryPath < right.directoryPath
    ? -1
    : left.directoryPath > right.directoryPath
      ? 1
      : 0;
}

function compareLevels(left: string, right: string): number {
  const leftParts = levelPartsOf(left);
  const rightParts = levelPartsOf(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    const a = leftParts[i] ?? 0;
    const b = rightParts[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/** Doorstop Item.__lt__: level component-wise, then UID. */
function compareItems(left: ItemRecord, right: ItemRecord): number {
  const levelOrder = compareLevels(left.level, right.level);
  if (levelOrder !== 0) return levelOrder;
  return left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0;
}

/** Resolve a link target UID: exact byUid hit first, then Doorstop-UID
 *  matching ("REQ-001"/"req001" find the "REQ001" item — separator- and
 *  prefix-case-agnostic, like Doorstop UID equality). */
function resolveUid(
  uid: string,
  byUid: ReadonlyMap<string, ItemRecord>,
  canonicalByUid: ReadonlyMap<string, ItemRecord>,
): ItemRecord | undefined {
  const exact = byUid.get(uid);
  if (exact !== undefined) return exact;
  const key = canonicalUidKey(uid);
  if (key === undefined) return undefined;
  return canonicalByUid.get(key);
}

/**
 * `buildDoorstopIndex` — see the `BuildDoorstopIndex` contract.
 *
 * Assembles documents, items, the lookup maps (byUid/byPrefix/
 * parentLinksByUid/childrenByUid), carries `knownFilePaths` over from
 * discovery, and records the structural findings visible at index time:
 * duplicate item UID (error), duplicate level within a document (warning),
 * unknown link target (error), link to an unknown document (warning), an
 * undeclared document `parent` (warning), and duplicate document prefixes
 * (warning; byPrefix keeps the first). `counts.items`/`counts.documents` are
 * filled here; the four state-derived counters start at 0 because the state
 * chain (computeItemStates) fills them.
 *
 * `ok` is false when any error-severity entry exists among `diagnostics` or
 * `findings` (warnings alone leave it true).
 */
export const buildDoorstopIndex: BuildDoorstopIndex = (
  documents,
  items,
  diagnostics,
  knownFilePaths,
) => {
  const sortedDocuments = [...documents].sort(compareDocuments);
  const sortedItems = [...items].sort(compareItems);
  const findings: Finding[] = [];

  const byPrefix = new Map<string, DoorstopDocumentConfig>();
  for (const document of sortedDocuments) {
    if (byPrefix.has(document.prefix)) {
      findings.push({
        severity: "warning",
        path: document.configPath,
        message: `duplicate document prefix: ${document.prefix}`,
      });
      continue;
    }
    byPrefix.set(document.prefix, document);
  }

  // Undeclared document parents (config.parent ↔ prefix tree edges).
  for (const document of sortedDocuments) {
    if (document.parentPrefix !== undefined && !byPrefix.has(document.parentPrefix)) {
      findings.push({
        severity: "warning",
        path: document.configPath,
        message: `document parent prefix not found: ${document.parentPrefix} (parent of ${document.prefix})`,
      });
    }
  }

  const byUid = new Map<string, ItemRecord>();
  const canonicalByUid = new Map<string, ItemRecord>();
  const prefixLower = new Set<string>();
  for (const document of sortedDocuments) prefixLower.add(document.prefix.toLowerCase());
  for (const item of sortedItems) {
    const prior = byUid.get(item.uid);
    // UID equality is separator- and prefix-case-agnostic in Doorstop
    // (split_uid + Prefix.lower()), so REQ001 ≡ REQ_001 ≡ req001: files
    // whose canonical keys collide are duplicates too, not separate items.
    const canonical = canonicalUidKey(item.uid);
    const canonicalPrior = canonical !== undefined ? canonicalByUid.get(canonical) : undefined;
    if (prior !== undefined || canonicalPrior !== undefined) {
      const clash = prior ?? canonicalPrior;
      findings.push({
        severity: "error",
        uid: item.uid,
        path: item.path,
        message: `duplicate item UID: ${item.uid} (also at ${clash?.path})`,
      });
      continue;
    }
    byUid.set(item.uid, item);
    if (canonical !== undefined) {
      canonicalByUid.set(canonical, item);
    }
  }

  // Duplicate levels within one document (Doorstop would reorder; plugin
  // reports the clash at index time).
  const levelsByDocument = new Map<string, Map<string, ItemRecord>>();
  for (const item of sortedItems) {
    let byLevel = levelsByDocument.get(item.documentPrefix);
    if (byLevel === undefined) {
      byLevel = new Map();
      levelsByDocument.set(item.documentPrefix, byLevel);
    }
    const prior = byLevel.get(item.level);
    if (prior !== undefined) {
      findings.push({
        severity: "warning",
        uid: item.uid,
        path: item.path,
        message: `duplicate level in document ${item.documentPrefix}: ${item.level} (also used by ${prior.uid})`,
      });
    } else {
      byLevel.set(item.level, item);
    }
  }

  const parentLinksByUid = new Map<string, readonly LinkRecord[]>();
  const childrenByUid = new Map<string, ItemRecord[]>();
  for (const item of sortedItems) {
    parentLinksByUid.set(item.uid, item.links);
    for (const link of item.links) {
      const parts = splitUid(link.uid);
      // Prefix comparison is case-insensitive (Prefix.lower()), so it must
      // not report a spurious unknown-document warning for a case-variant
      // link into a declared document.
      if (
        parts !== undefined &&
        !byPrefix.has(parts.prefix) &&
        !prefixLower.has(parts.prefix.toLowerCase())
      ) {
        findings.push({
          severity: "warning",
          uid: item.uid,
          path: item.path,
          message: `linked to item in unknown document: ${link.uid} (no document with prefix ${parts.prefix})`,
        });
      }
      const target = resolveUid(link.uid, byUid, canonicalByUid);
      if (target === undefined) {
        findings.push({
          severity: "error",
          uid: item.uid,
          path: item.path,
          message: `linked to unknown item: ${link.uid}`,
        });
        continue;
      }
      const children = childrenByUid.get(target.uid);
      if (children !== undefined) {
        children.push(item);
      } else {
        childrenByUid.set(target.uid, [item]);
      }
    }
  }

  const counts: DoorstopCounts = {
    suspectLinks: 0,
    unreviewedChanges: 0,
    unknownLinks: 0,
    missingReferences: 0,
    items: sortedItems.length,
    documents: sortedDocuments.length,
  };

  const ok =
    !diagnostics.some((diagnostic) => diagnostic.severity === "error") &&
    !findings.some((finding) => finding.severity === "error");

  return {
    documents: sortedDocuments,
    items: sortedItems,
    byUid,
    byPrefix,
    parentLinksByUid,
    childrenByUid,
    findings,
    ok,
    diagnostics: [...diagnostics],
    knownFilePaths,
    counts,
  };
};