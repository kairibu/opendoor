// ---------------------------------------------------------------------------
// Opendoor workspace panel: the per-workspace controller registry (plan §6.1
// — one `DoorstopWorkspaceController` per workspace, handed to consumers via
// properties), the private `DoorstopPanelHost` connection-flag holder, and
// the in-browser load job `loadDoorstopWorkspace`. The panel UI itself (the
// body element, action palette, and the contributions factory) is wired by a
// LATER chain (integration chain E2): this module deliberately does NOT
// define the contributions factory / panel contribution — it only exports
// the registry and controller so that chain can use them.
//
// Browser-side adaptation of the git panel's controller/activity idiom
// (mirrors opense-panel.ts): what git does as a `context.peer`
// round-trip becomes one in-browser job here — workspace settings
// (doorstop-settings, `.pi-web/opendoor.json`; its exclusions shape the
// walk and its diagnostics join the result) → discovery walk
// (doorstop-discovery) → per-document item-file reads (bounded concurrent) →
// parse (doorstop-model) → index assembly (buildDoorstopIndex) → state
// computation (computeItemStates). `context.files` is the only boundary
// used in THIS module; the plugin's CLI actions do reach `context.peer`,
// but only from the panel elements' `runDoorstop` (Phase D), never here.
//
// Load pipeline: discoverDoorstopDocuments returns the workspace's document
// configs plus the discovery file index (`knownFilePaths`). For each
// document this module lists its item directory and matches the item files
// against the document's configured name shape — `prefix` + `sep` + the
// numeric part zero-padded to `digits`, with a `.yml`/`.md` extension, dotfiles
// never counted, and a stray `digits: 0` config never matching (see
// isItemFile). Matching is strict (Doorstop `item_re` semantics): the
// configured `sep` is mandatory when set, and there is no trailing free-form
// name part. A file in the document directory that matches no item pattern and
// is not the document's own `.doorstop.yml` is surfaced as a warning
// diagnostic rather than dropped silently — the module family's policy is
// diagnosing what is not understood rather than guessing. Matched files are
// read in bounded-concurrent batches (MAX_CONCURRENT_READS 8, mirroring the
// discovery caps idiom); binary/truncated reads are skipped with a warning
// diagnostic, and an item whose extension contradicts the document's
// `itemformat` is called out so mixed-format workspaces stay debuggable.
// Each clean read is parsed through parseDoorstopItem. The resulting
// items are assembled by buildDoorstopIndex (which carries over the
// discovery diagnostics and `knownFilePaths`) and annotated in place by
// computeItemStates.
// ---------------------------------------------------------------------------

import type {
  ContributionQueryValue,
  WorkspaceInvalidation,
  WorkspacePanelContextV5,
} from "@jmfederico/pi-web/plugin-api";
import type {
  DiscoveryDiagnostic,
  DoorstopDocumentConfig,
  DoorstopFileContent,
  DoorstopFiles,
  DoorstopFileTree,
  DoorstopIndex,
  DoorstopTreeEntry,
  ItemRecord,
} from "../doorstop-contract.js";
import { formatUnknownError } from "../doorstop-contract.js";
import { discoverDoorstopDocuments, MAX_CONCURRENT_READS } from "../doorstop-discovery.js";
import { readOpendoorSettings, type OpendoorSettings } from "../doorstop-settings.js";
import { buildDoorstopIndex, parseDoorstopItem } from "../doorstop-model.js";
import { computeItemStates } from "../doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopWorkspaceHost,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";
import { DOORSTOP_NAV_FILE } from "./doorstop-panel-navigation.js";

/** Keep parse state for a few recent workspaces so results survive panel
 *  switches; evicted workspaces release their controllers (index freed). */
export const DOORSTOP_WORKSPACE_STATE_LIMIT = 8;

/** Upper bound on the numeric-part width used by the item-name regex, so a
 *  hand-edited `digits` can never push an unbounded `\d{N}` quantifier into
 *  `new RegExp` (defensive: huge N is pathological, and some engines throw on
 *  very large quantifiers). Item UIDs are zero-padded to exactly `digits`
 *  width, and Doorstop defaults to 3 — any config at or above this cap is a
 *  config error, so clamping the regex width is harmless. */
export const MAX_ITEM_DIGITS = 24;

/** One load job's full result. The controller (doorstop-panel-controller.ts)
 *  consumes this type-only, so the load job and its result stay in this
 *  module. */
export interface DoorstopWorkspaceResult {
  /** The frozen model index (documents, items, lookups, findings, counts)
   *  after buildDoorstopIndex + computeItemStates. */
  index: DoorstopIndex;
  /** Normalized workspace settings (`.pi-web/opendoor.json`), surfaced on
   *  the result so the elements chain can wire the publish command to
   *  `settings.publishTarget` (M5). Always present — defaults when no
   *  settings file exists. */
  settings: OpendoorSettings;
  /** Wall-clock duration of the load job, in milliseconds. */
  loadingMs?: number;
}

/**
 * One in-browser load job: discovery walk → per-document item reads (bounded
 * concurrent) → parse → index assembly → state computation. The injected
 * `files` adapter (structurally satisfied by `context.files`) is the only
 * boundary, so tests drive the whole job through a fake and the panel never
 * touches `context.peer`. Never throws: discovery/parse convert every
 * problem into diagnostics on the index.
 */
export async function loadDoorstopWorkspace(files: DoorstopFiles): Promise<DoorstopWorkspaceResult> {
  const started = Date.now();
  // Workspace settings first: their exclusions shape the discovery walk, and
  // their diagnostics flow into the result's diagnostics (a missing settings
  // file is the normal default state — no diagnostic).
  const settingsResult = await readOpendoorSettings(files);
  const discovery = await discoverDoorstopDocuments(files, {
    excludedDirectories: settingsResult.settings.excludedDirectories,
  });

  const items: ItemRecord[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [...settingsResult.diagnostics, ...discovery.diagnostics];

  for (const document of discovery.documents) {
    const listing = await listItemFiles(files, document);
    diagnostics.push(...listing.diagnostics);
    const parsed = await readAndParseItems(files, document, listing.matching);
    for (const outcome of parsed) {
      diagnostics.push(...outcome.diagnostics);
      if (outcome.item !== null) items.push(outcome.item);
    }
  }

  const index = buildDoorstopIndex(discovery.documents, items, diagnostics, discovery.knownFilePaths);
  computeItemStates(index);
  return { index, settings: settingsResult.settings, loadingMs: Date.now() - started };
}

/** List one document's item directory and select the item files. Listing
 *  failures become diagnostics (never throw); a truncated listing is
 *  reported as a warning. A file in the document directory that matches no
 *  item pattern and is not the document's own `.doorstop.yml` is reported as
 *  a warning diagnostic rather than dropped silently (the module family's
 *  diagnose-not-guess policy): stray files (`notes.txt`, editor backups, a
 *  stale `REQ0001.yml.bak`) are exactly the kind of thing that should not
 *  vanish without a trace. */
async function listItemFiles(
  files: DoorstopFiles,
  document: DoorstopDocumentConfig,
): Promise<{ matching: DoorstopTreeEntry[]; diagnostics: DiscoveryDiagnostic[] }> {
  let listing: DoorstopFileTree;
  try {
    listing = await files.listFiles(document.directoryPath);
  } catch (error) {
    return {
      matching: [],
      diagnostics: [
        {
          severity: "error",
          path: document.directoryPath,
          message: `Could not list item directory: ${formatUnknownError(error)}`,
        },
      ],
    };
  }
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (listing.truncated) {
    diagnostics.push({
      severity: "warning",
      path: document.directoryPath,
      message: "Directory listing truncated by the workspace API; some item files were not scanned",
    });
  }
  // The document's own `.doorstop.yml` matches no item pattern (it is a
  // config file, not an item) but is not a stranger — exempt it explicitly so
  // the no-match warning never flags it.
  const configName = document.configPath.slice(document.configPath.lastIndexOf("/") + 1);
  const isItem = makeItemFileMatcher(document);
  const matching: DoorstopTreeEntry[] = [];
  for (const entry of listing.entries) {
    if (entry.type !== "file") continue;
    if (entry.name === configName) continue;
    if (isItem(entry.name)) {
      matching.push(entry);
    } else {
      diagnostics.push({
        severity: "warning",
        path: entry.path,
        message: `File does not match the document's item naming pattern (expected "${document.prefix}${document.separator}<${String(document.digits)} digits>.yml|.md") and was skipped`,
      });
    }
  }
  return { matching, diagnostics };
}

/**
 * Read and parse a document's matched item files in bounded-concurrent
 * batches (MAX_CONCURRENT_READS at a time — the batch size is the
 * concurrency bound, mirroring the discovery caps idiom). Outcomes commit in
 * encounter order; a rejection never loses the rest of the batch.
 */
async function readAndParseItems(
  files: DoorstopFiles,
  document: DoorstopDocumentConfig,
  entries: DoorstopTreeEntry[],
): Promise<Array<{ item: ItemRecord | null; diagnostics: DiscoveryDiagnostic[] }>> {
  const outcomes: Array<{ item: ItemRecord | null; diagnostics: DiscoveryDiagnostic[] }> = [];
  for (let start = 0; start < entries.length; start += MAX_CONCURRENT_READS) {
    const batch = entries.slice(start, start + MAX_CONCURRENT_READS);
    const settled = await Promise.allSettled(batch.map((entry) => files.readFile(entry.path)));
    const zipped = batch.map((entry, index) => ({ entry, result: settled[index] }));
    for (const { entry, result } of zipped) {
      // Dead in practice — allSettled preserves order, so `result` is always
      // defined — but kept as a faithful mirror of the discovery idiom's
      // flushPendingConfigReads, which guards the same zip the same way.
      if (result === undefined) continue;
      const outcome = applyItemRead(entry, result, document);
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

/** Commit one item read: rejection/binary/truncated reads become diagnostics
 *  and are skipped; a clean read is parsed through parseDoorstopItem. A
 *  `.doorstop.yml` can never reach here — isItemFile excludes it by shape. */
function applyItemRead(
  entry: DoorstopTreeEntry,
  settled: PromiseSettledResult<DoorstopFileContent>,
  document: DoorstopDocumentConfig,
): { item: ItemRecord | null; diagnostics: DiscoveryDiagnostic[] } {
  const path = entry.path;
  if (settled.status === "rejected") {
    return {
      item: null,
      diagnostics: [{ severity: "error", path, message: `Could not read file: ${formatUnknownError(settled.reason)}` }],
    };
  }
  if (settled.value.binary) {
    return {
      item: null,
      diagnostics: [{ severity: "warning", path, message: "Binary file skipped; not parsed as a Doorstop item" }],
    };
  }
  if (settled.value.truncated) {
    return {
      item: null,
      diagnostics: [{ severity: "warning", path, message: "File content truncated by the workspace API and skipped" }],
    };
  }
  // A matched file whose extension contradicts the document's itemformat
  // (a `.md` in a yaml document, or a `.yml` in a markdown one) will be
  // parsed as the document's format and likely fail as "invalid contents".
  // Call the mismatch out explicitly so such mixed-format workspaces stay
  // debuggable instead of surfacing only a confusing parse error.
  const diagnostics: DiscoveryDiagnostic[] = [];
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  const expected = document.itemformat === "markdown" ? "md" : "yml";
  if (extension !== "" && extension !== expected) {
    diagnostics.push({
      severity: "warning",
      path,
      message: `Item file extension ".${extension}" does not match the document's itemformat (${document.itemformat}); parsed anyway`,
    });
  }
  const parsed = parseDoorstopItem(path, settled.value.content, document);
  return { item: parsed.item, diagnostics: [...diagnostics, ...parsed.diagnostics] };
}

/**
 * Compile the item-name matcher for one document. Matching is strict, in
 * Doorstop's own `item_re` spirit: the name must be exactly `prefix` + the
 * configured `sep` (mandatory when set — `sep: '-'` therefore requires
 * `REQ-0001.yml` and rejects a bare `REQ0001.yml`) + the numeric part
 * zero-padded to `digits`, with a `.yml`/`.md` extension and NO trailing
 * free-form name part (`REQ0001-anything.yml` never matches). `prefix`/`sep`
 * are escaped so regex metacharacters in either cannot break the match.
 * Compiling once per document (not once per directory entry) keeps
 * listItemFiles at O(files) matches instead of O(files) regex constructions.
 */
function makeItemFileMatcher(document: DoorstopDocumentConfig): (name: string) => boolean {
  const digits = document.digits;
  // `digits: 0` degenerates the pattern (`\d{0}` matches a bare prefix or
  // even `REQ-foo.yml`); a config with no numeric width can never name an
  // item, so it matches nothing. Never feed it to the regex.
  if (digits < 1) return () => false;
  // Clamp the quantifier width so a hand-edited absurd `digits` cannot push an
  // oversized `\d{N}` into `new RegExp` (defensive; see MAX_ITEM_DIGITS).
  const width = Math.min(digits, MAX_ITEM_DIGITS);
  const re = new RegExp(
    `^${escapeRegExp(document.prefix)}${escapeRegExp(document.separator)}\\d{${width}}\\.(?:yml|md)$`,
    "i",
  );
  return (name: string): boolean => {
    // Dotfiles are never items — an explicit structural guard (not an
    // accident of the `^prefix` anchor), so even a config whose `prefix`
    // starts with `.` cannot make hidden files parse as items, and the
    // document's own `.doorstop.yml` is never an item by construction.
    if (name.startsWith(".")) return false;
    return re.test(name);
  };
}

/**
 * Match a directory entry name as an item file of a document (strict
 * `prefix` + mandatory `sep` + zero-padded `digits` + `.yml`/`.md`, no
 * trailing name part; dotfiles never match; `digits: 0` never matches).
 * Exported so the panel's matching obligation is unit-testable directly.
 */
export function isItemFile(name: string, document: DoorstopDocumentConfig): boolean {
  return makeItemFileMatcher(document)(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One chat file-open index entry (plan Phase C step C3): the item a
 *  workspace-relative item-file path resolves to. The index mirrors the
 *  item's own two selection surfaces: the detail pane (`uid`) and the
 *  document tree (`documentPrefix`) — resolving a chat link selects both,
 *  exactly like clicking the item in the list. */
interface DoorstopFileOpenEntry {
  uid: string;
  documentPrefix: string;
}

/** The per-workspace recorded index: the landed result the entries were
 *  built from (kept by identity so re-renders of an unchanged result skip
 *  the rebuild) plus the path→item entries. */
interface DoorstopFileOpenIndex {
  result: DoorstopWorkspaceResult;
  entries: ReadonlyMap<string, DoorstopFileOpenEntry>;
}

/**
 * Per-workspace controller registry (plan §6.1 default: the panel module
 * keeps the per-workspace controller map and hands instances to consumers —
 * the body element — via properties; no Context provider). Rendering a
 * workspace refreshes its controller's context/files handle and moves it to
 * the LRU tail; past `DOORSTOP_WORKSPACE_STATE_LIMIT` the oldest workspace is
 * evicted (never the live panel — it is always the tail) and its controller
 * released, so late async writes are dropped (§3.2) and its index is
 * garbage-collected. Controllers keep results for a few recent workspaces so
 * they survive panel switches without re-loading. */
export class DoorstopWorkspaceRegistry {
  private readonly workspaces = new Map<string, DoorstopWorkspaceController>();

  /** Plan Phase C step C3 — the chat file-open index: per-workspace
   *  item-file path → { uid, documentPrefix } (plus the landed result it was
   *  built from, kept by identity), recorded from every LANDED
   *  load result (renderDoorstopPanel records it whenever the controller
   *  has a result), so the SYNCHRONOUS `fileOpenQuery` hook can answer from
   *  the last landed discovery without running one. Same LRU bound and the
   *  same workspace keys as the controller map; an evicted workspace drops
   *  its file-open entries with its controller. */
  private readonly fileOpenEntries = new Map<string, DoorstopFileOpenIndex>();

  /** Get-or-create the controller for a workspace (the render entry point). */
  for(context: WorkspacePanelContextV5): DoorstopWorkspaceController {
    const key = workspaceContextKey(context);
    const existing = this.workspaces.get(key);
    if (existing !== undefined) {
      // Refresh the controller's CURRENT context handle and move to the LRU
      // tail (most recent) — one handle feeds both load reads (`context.files`)
      // and the render path (`context.host.requestRender`), so the refreshed
      // snapshot reaches both.
      existing.context = context;
      this.workspaces.delete(key);
      this.workspaces.set(key, existing);
      return existing;
    }
    this.evictOldest();
    const controller = new DoorstopWorkspaceController(
      new DoorstopPanelHost(),
      context,
      loadDoorstopWorkspace,
    );
    this.workspaces.set(key, controller);
    return controller;
  }

  /** Panel invalidation: re-run discovery + load unconditionally for the
   *  connected workspace (paired or unpaired: the load job is browser-side, so there is no owned-workspace gate).
   *
   *  Plan Phase C step C1 — the typed invalidation (browser API v4,
   *  unchanged on v5): `invalidation` carries
   *  the reason (`"manual"` Refresh action / `"mutation"` a workspace file
   *  changed / `"agent-activity"` agent work finished) and the affected
   *  resources. The rescan stays REASON-AGNOSTIC deliberately: every reason
   *  may have changed item files, the load job re-reads everything anyway
   *  (no partial invalidation is possible — the index is one unit), and the
   *  controller's re-entrant guard coalesces storms (an invalidate while a
   *  load is running JOINS that load; only an invalidate after it lands
   *  starts a fresh one), so `"agent-activity"` bursts cannot stack loads.
   *  The payload is accepted (so the contribution can forward it) but not
   *  consulted. */
  invalidate(context: WorkspacePanelContextV5, invalidation?: WorkspaceInvalidation): Promise<void> {
    void invalidation;
    return this.for(context).invalidate();
  }

  /** Record the chat file-open index for one workspace from a LANDED result
   *  (plan Phase C step C3). Called from renderDoorstopPanel on every render
   *  that has a result, so the index always mirrors the last landed
   *  discovery; never throws and triggers nothing (the hook must be free of
   *  side effects — recording a plain index from a landed result is one). */
  recordFileOpenIndex(context: WorkspacePanelContextV5, result: DoorstopWorkspaceResult): void {
    const key = workspaceContextKey(context);
    const existing = this.fileOpenEntries.get(key);
    // The render path calls this on EVERY render with a result (keystrokes,
    // selections re-render too) — skip the O(items) rebuild when the landed
    // result is unchanged (result identity survives until the next load
    // replaces it), keeping the render cost at one map bump.
    if (existing !== undefined && existing.result === result) {
      this.fileOpenEntries.delete(key);
      this.fileOpenEntries.set(key, existing);
      return;
    }
    const entries = new Map<string, DoorstopFileOpenEntry>();
    for (const item of result.index.items) {
      entries.set(item.path, { uid: item.uid, documentPrefix: item.documentPrefix });
    }
    this.fileOpenEntries.delete(key);
    this.fileOpenEntries.set(key, { result, entries });
    this.boundFileOpenEntries();
  }

  /** The panel's chat file-open hook (plan Phase C step C3): does the last
   *  landed discovery of this workspace know `path` as an item file? Returns
   *  the panel's navigation query (`{ file: path }` — the key
   *  applyNavigationQuery resolves to the item's uid and document
   *  selection), or undefined when the panel does not own the path (the
   *  host then asks the next panel, or serves the Files fallback). Before
   *  the first load lands there is no index yet → undefined (the chat link
   *  falls back to Files; the panel still deep-links once opened and
   *  re-rendered). */
  fileOpenQuery(
    context: WorkspacePanelContextV5,
    path: string,
  ): Readonly<Record<string, ContributionQueryValue>> | undefined {
    const entries = this.fileOpenEntries.get(workspaceContextKey(context));
    if (entries === undefined) return undefined;
    return entries.entries.has(path) ? { [DOORSTOP_NAV_FILE]: path } : undefined;
  }

  /** Keep the file-open index at the same LRU bound as the controller map
   *  (strictly oldest-first, mirroring evictOldest). */
  private boundFileOpenEntries(): void {
    while (this.fileOpenEntries.size > DOORSTOP_WORKSPACE_STATE_LIMIT) {
      const key = this.fileOpenEntries.keys().next().value;
      if (key === undefined) break;
      this.fileOpenEntries.delete(key);
    }
  }

  private evictOldest(): void {
    if (this.workspaces.size < DOORSTOP_WORKSPACE_STATE_LIMIT) return;
    // Strictly oldest-first: the connected workspace is always the LRU tail —
    // every panel render of it calls for(), which bumps it — so the head is
    // never the live panel.
    const key = this.workspaces.keys().next().value;
    if (key === undefined) return;
    const controller = this.workspaces.get(key);
    if (controller !== undefined) controller.release();
    this.workspaces.delete(key);
    // The evicted workspace's chat file-open entries die with its controller
    // (C3): a stale index must not answer fileOpenQuery for a workspace whose
    // controller (and result) are gone.
    this.fileOpenEntries.delete(key);
  }
}

/** Host adapter for one workspace's controller: carries the connection flag
 *  the controller's late-async-write guards read (§3.2). The controller
 *  raises/lowers the flag from its own hostConnected/hostDisconnected/
 *  release lifecycle, so the adapter itself is a plain mutable state holder
 *  and holds no context — render routing goes through the controller's
 *  refreshed `context.host.requestRender()` instead. */
class DoorstopPanelHost implements DoorstopWorkspaceHost {
  isConnected = false;
}

function workspaceContextKey(context: WorkspacePanelContextV5): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}
