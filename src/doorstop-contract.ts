// ---------------------------------------------------------------------------
// Opendoor contract: plugin-local types, function-signature contracts, and
// shared runtime helpers.
//
// This is the FROZEN boundary module of the opendoor plugin (feature spec
// §5/§6 — docs/feature-doorstop-plugin.md). It owns every plugin-local shape
// the discovery/model/state/panel chains share: later modules import these
// types and MUST NOT redefine them (mirrors the opense-contract.ts idiom).
//
// Discovery, parsing, index building, and state computation are deliberately
// NOT implemented here — the chains implement the functions declared (as
// types) at the bottom:
//
//   doorstop-discovery.ts → discoverDoorstopDocuments   (module to be built)
//   doorstop-model.ts     → parseDoorstopItem, buildDoorstopIndex
//   doorstop-state.ts     → computeItemStamp, computeItemStates,
//                           stampFromFingerprintParts
//
// Shapes mirror Doorstop itself (doorstop-dev/doorstop, doorstop/core):
//
//   - One item = one YAML file (`REQ001.yml`) or markdown file with YAML
//     frontmatter (`REQ001.md`); the item UID is the file name base.
//   - One document = a directory of item files + a `.doorstop.yml`
//     (settings: prefix/sep/digits/parent/itemformat; attributes:
//     defaults/reviewed/publish; extensions). Documents reference each other
//     through the parent document's prefix.
//   - `links` stores each linked parent UID together with that parent's
//     fingerprint at record time; `reviewed` stores the item's own
//     fingerprint at review time. Fingerprints are Doorstop `Stamp`s:
//     SHA-256 over serialized parts, URL-safe Base64 (`Stamp.digest`).
//
// Conventions for object construction (the strictest tsconfig flags are on,
// incl. `exactOptionalPropertyTypes`): optional fields are OMITTED — spread
// conditionally, `...(x === undefined ? {} : { x })` — never set to
// `undefined`, matching the opense-contract idiom.
// ---------------------------------------------------------------------------

/** Narrow file-access surface the plugin's discovery needs, structurally
 *  satisfied by the host `context.files` (`WorkspaceFiles`): its
 *  `listFiles`/`readFile` return supersets of the response types below, so no
 *  host import is required. Tests inject the in-memory fake from
 *  src/test-support.ts (createFakeFiles). */
export interface DoorstopFiles {
  listFiles(relativePath: string): Promise<DoorstopFileTree>;
  readFile(relativePath: string): Promise<DoorstopFileContent>;
}

/** Minimal `FileTreeResponse` subset: entry list plus the truncation flag. */
export interface DoorstopFileTree {
  entries: DoorstopTreeEntry[];
  truncated: boolean;
}

/** Minimal `FileTreeEntry` subset — the three fields a walk branches on. */
export interface DoorstopTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
}

/** Minimal `FileContentResponse` subset: source plus the two flags. */
export interface DoorstopFileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * A non-fatal discovery or parse problem, attributed to a workspace path
 * when known. Discovery/parse never throw; every adapter rejection or shape
 * problem becomes one of these (opense-discovery idiom). These are the
 * *file-level* diagnostics; per-item *state* problems are {@link Finding}s.
 */
export interface DiscoveryDiagnostic {
  severity: "error" | "warning";
  path?: string;
  message: string;
}

/** Item storage format of a document (`itemformat` in `.doorstop.yml`). */
export type DoorstopItemFormat = "yaml" | "markdown";

/**
 * Normalized configuration of one Doorstop document, parsed from its
 * `.doorstop.yml` (feature spec §5: "reads each config to learn prefix,
 * parent prefix, itemformat, and the document's item directory").
 */
export interface DoorstopDocumentConfig {
  /** Relative path of the directory holding this document's item files. */
  directoryPath: string;
  /** Relative path of this document's `.doorstop.yml`. */
  configPath: string;
  /** Document prefix (e.g. `REQ`), which keys {@link DoorstopIndex.byPrefix}. */
  prefix: string;
  /** Zero-padded width of the numeric part of child UIDs (e.g. 4 → `REQ0001`). */
  digits: number;
  /** Separator between prefix and number (Doorstop `sep`); "" when unset. */
  separator: string;
  /** Prefix of the parent document; OMITTED for root documents (Doorstop
   *  stores these as an empty `parent: ''`, normalized away here). */
  parentPrefix?: string;
  /** Item storage format; "yaml" when unset (Doorstop's default). */
  itemformat: DoorstopItemFormat;
  /** Raw, unmodeled keys of the `.doorstop.yml`, preserved verbatim (e.g.
   *  the `attributes`/`extensions` sections, `!include` results, or legacy
   *  flat-file extras). The escape hatch for anything the plugin does not
   *  model yet (extended-reviewed attribute names, publish settings, ...). */
  extra: Record<string, unknown>;
}

/** One external file reference of an item (Doorstop `references` entry).
 *  Doorstop stores each entry with a `type` key that its YAML validation
 *  requires to be `file`; the value is preserved because the item
 *  fingerprint serializes the entry (see computeItemStamp). */
export interface DoorstopItemReference {
  /** Reference kind — always `"file"` (Doorstop's yaml validator rejects
   *  any other value; modeled explicitly so the fingerprint serialization
   *  of the entry can reproduce Doorstop byte-for-byte). */
  type: "file";
  /** File path — workspace-root-relative AFTER model-chain normalization.
   *  Doorstop stores reference paths relative to the item file's directory;
   *  the model chain resolves them against the owning document's
   *  {@link DoorstopDocumentConfig.directoryPath} into this root-relative
   *  form (the {@link DoorstopIndex.knownFilePaths} path format). The
   *  missing-reference chip compares these resolved paths against
   *  {@link DoorstopIndex.knownFilePaths}. */
  path: string;
  /** Optional search keyword for matching the reference inside the file. */
  keyword?: string;
  /** Optional SHA-256 checksum of the referenced file (Doorstop `item_sha_required`). */
  sha?: string;
}

/**
 * One recorded parent link of an item: the parent UID plus the fingerprint
 * that was recorded for that parent at link/clear time. `null` (Doorstop
 * records no stamp yet — `Stamp()`/`Stamp(True)` placeholders) means the
 * link has not been recorded against a parent fingerprint yet.
 */
export interface LinkRecord {
  uid: string;
  fingerprint: string | null;
}

/**
 * One parsed requirement/test item (feature spec §6). UID, file path, and
 * all attribute values are normalized by the model chain from the raw YAML;
 * the attribute defaults follow Doorstop's `Item` (`active: true`,
 * `normative: true`, `derived: false`, `text: ""`, `ref: ""`, `reviewed:
 * null`, level `"1.0"`).
 */
export interface ItemRecord {
  /** Item UID — the file name base (e.g. `REQ001`), unique in the index. */
  uid: string;
  /** Prefix of the document that owns this item file (from its
   *  `.doorstop.yml`). May differ from the UID's own prefix when a document
   *  contains foreign-prefixed items (Doorstop tolerates this). */
  documentPrefix: string;
  /** Relative workspace path of the item file. */
  path: string;
  /** Item level as a dotted string, e.g. "1.2", "2.0". */
  level: string;
  /** Active status (`active: false` items are excluded from validation). */
  active: boolean;
  /** Derived status (no parent-document links required, still linked to). */
  derived: boolean;
  /** Normative status (`normative: false` items are headings/comments). */
  normative: boolean;
  /** Item heading; OMITTED when the item has none (Doorstop `header`). */
  header?: string;
  /** Item body text (markdown). Empty text is legal but flagged by Doorstop. */
  text: string;
  /** Single external file reference (legacy Doorstop `ref`); "" when none.
   *  Workspace-root-relative after model-chain normalization (resolved from
   *  the item file's directory, like {@link DoorstopItemReference.path}). */
  ref: string;
  /** External file references; OMITTED when the item has none. */
  references?: DoorstopItemReference[];
  /** Parent links in file order (Doorstop stores them sorted by UID). */
  links: LinkRecord[];
  /** The item's own fingerprint at last review (`reviewed` attribute);
   *  `null` when never reviewed. Compared with the recomputed stamp
   *  (computeItemStamp) to decide the reviewed/unreviewed chips. */
  reviewed: string | null;
  /** Extended (custom) attributes beyond the modeled keys above, as
   *  uninterpreted values (Doorstop `Item.attribute(name)` data). */
  attributes: Record<string, unknown>;
  /** Escape hatch: the complete parsed item file data (every key, modeled or
   *  not, exactly as parsed) so no information is lost downstream.
   *  Diagnostics-only: never rendered (the detail panel renders the modeled
   *  fields plus the extended `attributes`, keeping the §7.1 extended-attr
   *  table unambiguous). */
  raw: Record<string, unknown>;
  /** State chips, annotated by computeItemStates: parseDoorstopItem
   *  initializes this to `[]`; computeItemStates fills it in place. The very
   *  same objects are referenced from {@link DoorstopIndex.items},
   *  `byUid`, and `childrenByUid`, so one write is visible everywhere. */
  stateKeys: ItemStateKey[];
}

/**
 * Display-state chips for an item (feature spec §6). computeItemStates
 * derives the full set from the item attributes + the tree index:
 *
 *   normative / non-normative — attribute mirror (`normative` true/false).
 *   inactive — `active: false` (excluded from validation/publish).
 *   reviewed — current fingerprint == stored `reviewed`.
 *   unreviewed — fingerprint differs, or `reviewed` is null.
 *   suspect-link — a parent link's recorded fingerprint ≠ that parent's
 *     current fingerprint (the parent changed after the child agreed).
 *   no-child-links — the item's document has child documents but no child
 *     item links to this item.
 *   no-links — normative, non-derived, not top-level, and `links` is empty.
 *   unknown-link — a link target UID is not in the index.
 *   missing-reference — a normalized `ref`/`references` path is not among
 *     {@link DoorstopIndex.knownFilePaths} (the discovery file index; best
 *     effort — `doorstop validate` is authoritative).
 */
export type ItemStateKey =
  | "normative"
  | "non-normative"
  | "inactive"
  | "reviewed"
  | "unreviewed"
  | "suspect-link"
  | "no-child-links"
  | "no-links"
  | "unknown-link"
  | "missing-reference";

/**
 * A plugin-local finding — the display-relevant subset of Doorstop's
 * INFO/WARNING/ERROR validation model. `info` severities are attribute
 * mirrors (inactive/non-normative link targets), `warning` are traceability
 * problems (no links, suspect links, no child links), `error` are hard
 * problems (unknown link UIDs, missing references). This mapping covers the
 * *plugin's* local checks only; the exact severity model (which of these
 * Doorstop emits as INFO vs WARNING vs ERROR) is pinned by the state-chain
 * fixture tests against Doorstop's own validation issues. Findings may
 * target an item (`uid`), a workspace path (`path`), or neither.
 */
export interface Finding {
  severity: "info" | "warning" | "error";
  uid?: string;
  path?: string;
  message: string;
}

/** Workspace-wide counters the tab badge and workspace label render. */
export interface DoorstopCounts {
  /** Number of items flagged with the "suspect-link" state key. */
  suspectLinks: number;
  /** Number of items flagged with the "unreviewed" state key. */
  unreviewedChanges: number;
  /** Number of items flagged with the "unknown-link" state key. */
  unknownLinks: number;
  /** Number of items flagged with the "missing-reference" state key. */
  missingReferences: number;
  /** Total item count (== `items.length`). */
  items: number;
  /** Total document count (== `documents.length`). */
  documents: number;
}

/**
 * The frozen model index of one workspace (feature spec §5/§6). Built in two
 * phases: `buildDoorstopIndex` assembles documents/items/lookups/findings
 * scaffolding, fills the structural counters (`items`, `documents`), and
 * carries `knownFilePaths` over from the discovery result;
 * `computeItemStates` then annotates every item's `stateKeys`, appends the
 * per-item state findings, and fills `counts.suspectLinks` /
 * `counts.unreviewedChanges` / `counts.unknownLinks` /
 * `counts.missingReferences`. Consumers must run both before reading
 * state-derived data.
 *
 * `ok` is false when any error-severity entry exists among `diagnostics` or
 * `findings` (warnings alone leave it true) — the toolbar ok/issues pill.
 */
export interface DoorstopIndex {
  /** Documents sorted ascending by directory path (code-unit comparison);
   *  the document tree is derived from `parentPrefix` at render time. */
  documents: DoorstopDocumentConfig[];
  /** Items sorted by level (component-wise: "1.2" < "1.10") then by uid. */
  items: ItemRecord[];
  /** Item UID → item, across all documents (built once; lookup map). */
  byUid: ReadonlyMap<string, ItemRecord>;
  /** Document prefix → document config (built once; lookup map). */
  byPrefix: ReadonlyMap<string, DoorstopDocumentConfig>;
  /** Item UID → that item's declared parent links (its `links`, indexed for
   *  O(1) access; values share the objects in `items`). */
  parentLinksByUid: ReadonlyMap<string, readonly LinkRecord[]>;
  /** Item UID → every item (in any document) whose links include that UID —
   *  the reverse "links in" map. The no-child-links chip additionally scopes
   *  this to child documents (see `byPrefix`: the configs whose
   *  `parentPrefix` matches the item's document prefix), exactly like
   *  Doorstop validation. */
  childrenByUid: ReadonlyMap<string, readonly ItemRecord[]>;
  /** Plugin-local findings (computed by computeItemStates; labeled as
   *  plugin-local in the UI — `doorstop validate` remains authoritative). */
  findings: Finding[];
  /** False when any error-severity diagnostic or finding exists. */
  ok: boolean;
  /** Discovery + parse diagnostics (non-fatal file-level problems). */
  diagnostics: DiscoveryDiagnostic[];
  /** Workspace-root-relative paths (forward-slash separated, deduplicated)
   *  of every file the discovery walk enumerated — the discovery file index
   *  the missing-reference chip compares resolved `ref`/`references` paths
   *  against. Carried from the discovery result by buildDoorstopIndex;
   *  never mutated after assembly. */
  knownFilePaths: ReadonlySet<string>;
  /** Workspace counters (see lifecycle note above). */
  counts: DoorstopCounts;
}

// --- function contracts (signatures only; the chains implement the values) --

/** Outcome of one workspace discovery. `knownFilePaths` is the discovery
 *  file index (feature spec §6, missing-reference chip): discovery walks
 *  every workspace directory anyway, so the walk records the
 *  workspace-root-relative path of every file it enumerates. */
export interface DoorstopDiscoveryResult {
  documents: DoorstopDocumentConfig[];
  diagnostics: DiscoveryDiagnostic[];
  /** Root-relative paths of every file the walk enumerated (deduplicated),
   *  in the {@link DoorstopFiles} path format. */
  knownFilePaths: ReadonlySet<string>;
}

/** Outcome of parsing one item file. */
export interface DoorstopParseResult {
  item: ItemRecord;
  diagnostics: DiscoveryDiagnostic[];
}

/** The fields `computeItemStamp` needs — a bare `ItemRecord` is not required,
 *  so state code can stamp a freshly parsed partial object too (a partial
 *  object must supply every listed field). */
export type DoorstopStampableItem = Pick<
  ItemRecord,
  "uid" | "text" | "ref" | "references" | "links" | "attributes"
>;

/**
 * `discoverDoorstopDocuments` — implemented by the doorstop-discovery chain.
 * Walks the workspace through the injected files adapter, finds every
 * `.doorstop.yml`, and reads each config (bounded, non-throwing; problems
 * become diagnostics). Returns normalized document configs sorted by
 * directory path, plus `knownFilePaths`: the workspace-root-relative path
 * of every file the walk enumerated (the discovery file index backing the
 * missing-reference chip of feature spec §6). Reads whose
 * `DoorstopFileContent.truncated` / `.binary` flags are set are NEVER
 * parsed — neither configs here nor item contents downstream — they become
 * warning diagnostics instead, so truncated/binary content never reaches
 * an item parser. Feature spec §5/§6/§10 and notes/opense-recon.md fact
 * 10.
 */
export type DiscoverDoorstopDocuments = (
  files: DoorstopFiles,
) => Promise<DoorstopDiscoveryResult>;

/**
 * `parseDoorstopItem` — implemented by the doorstop-model chain.
 * Parses one item file's content (YAML, or markdown with YAML frontmatter)
 * into a normalized {@link ItemRecord} with defaulted attributes, plus
 * per-file diagnostics. Never throws on content problems.
 *
 * The caller must only pass content from a read whose
 * `DoorstopFileContent.truncated`/`binary` flags were clear — the chains
 * that read item files skip truncated/binary reads and emit a warning
 * diagnostic (see {@link DiscoverDoorstopDocuments}); this function
 * assumes well-formed readable content. It also resolves `ref`/`references`
 * paths — Doorstop stores them relative to the item file's directory — into
 * workspace-root-relative form keyed to the owning document's directory.
 */
export type ParseDoorstopItem = (
  path: string,
  content: string,
  config: DoorstopDocumentConfig,
) => DoorstopParseResult;

/**
 * `buildDoorstopIndex` — implemented by the doorstop-model chain.
 * Assembles documents, items, the lookup maps (byUid/byPrefix/
 * parentLinksByUid/childrenByUid), the `knownFilePaths` discovery index,
 * and the initial findings/diagnostics scaffolding of the
 * {@link DoorstopIndex}; see the index lifecycle note.
 */
export type BuildDoorstopIndex = (
  documents: DoorstopDocumentConfig[],
  items: ItemRecord[],
  diagnostics: DiscoveryDiagnostic[],
  knownFilePaths: ReadonlySet<string>,
) => DoorstopIndex;

/**
 * `computeItemStamp` — implemented by the doorstop-state chain.
 * Returns the item's current fingerprint with Doorstop `Item.stamp(links)`
 * semantics: SHA-256 over [uid, text, ref, references (when present), link
 * UIDs sorted, extended reviewed attributes] serialized exactly as
 * Doorstop's `Stamp` digests them (parts concatenated, URL-safe Base64;
 * the Doorstop fixture tests pin the exact serialization).
 *
 * With `includeLinks` true — the default when omitted — this reproduces
 * `Item.stamp(links=True)`, the exact value `doorstop review` stores as
 * `reviewed`; comparing it with `ItemRecord.reviewed` decides the
 * reviewed/unreviewed chips. Extended reviewed attributes are part of the
 * fingerprint whenever the owning document configures them: their NAMES
 * come from the document's `.doorstop.yml` `attributes.reviewed` (held in
 * {@link DoorstopDocumentConfig.extra}; Doorstop sorts and deduplicates
 * them) and their VALUES from the item's `attributes`. A document with no
 * configured reviewed attributes contributes none.
 *
 * `includeLinks` false reproduces Doorstop's link-record stamp,
 * `Item.stamp()`: the fingerprint Doorstop records against an item in
 * other items' links (`clear`/re-validation assign `uid.stamp =
 * item.stamp()`). Suspect-link comparisons must therefore compare a
 * recorded `LinkRecord.fingerprint` against the linked item's current
 * fingerprint computed with `includeLinks: false`. Both variants share
 * this one implementation — never two divergent serializations — so the
 * reviewed and suspect chips cannot silently disagree.
 */
export type ComputeItemStamp = (
  item: DoorstopStampableItem,
  config: DoorstopDocumentConfig,
  includeLinks?: boolean,
) => string;

/**
 * `computeItemStates` — implemented by the doorstop-state chain.
 * Annotates every item of the index in place: fills `stateKeys`
 * (normative/non-normative/inactive/reviewed/unreviewed/suspect-link/
 * no-child-links/no-links/unknown-link/missing-reference per feature spec
 * §6), appends the per-item state findings to `index.findings`, and fills
 * `index.counts.suspectLinks` / `index.counts.unreviewedChanges` /
 * `index.counts.unknownLinks` / `index.counts.missingReferences`.
 *
 * `reviewed`/`unreviewed` compare `ItemRecord.reviewed` against
 * {@link ComputeItemStamp} with the item's own document config;
 * `suspect-link` compares recorded `LinkRecord.fingerprint`s against the
 * linked item's current fingerprint (`includeLinks: false`); and
 * `missing-reference` compares the resolved `ref`/`references` paths
 * against `index.knownFilePaths`. Returns void because the index (and the
 * shared item objects it references) is mutated directly.
 */
export type ComputeItemStates = (index: DoorstopIndex) => void;

/**
 * `stampFromFingerprintParts` — implemented by the doorstop-state chain.
 * The low-level Doorstop `Stamp.digest` equivalent: SHA-256 over the
 * concatenated serialized parts, URL-safe Base64-encoded, returned as a
 * string. The parts must be serialized exactly as Doorstop's `Stamp`
 * digests them (the state chain's fixture tests pin this down).
 */
export type StampFromFingerprintParts = (parts: string[]) => string;

// --- small shared helpers (runtime; importable by every chain) ---------------

/** Format an unknown thrown value for a user-facing message. */
export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Guard: assert `value` is a plain object (not null, not an array). */
export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

/** Guard: assert `value` is an array. */
export function requireArrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

/** Guard: assert `record[key]` is a string. */
export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

/** Guard: assert `record[key]` is a boolean. */
export function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

/** Guard: assert `record[key]` is a finite number. */
export function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite number field: ${key}`);
  return value;
}

/** Guard: `record[key]` must be a string when present; `undefined` passes. */
export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}
