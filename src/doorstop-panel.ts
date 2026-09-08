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
// Browser-only adaptation of the git panel's controller/activity idiom
// (mirrors opense-panel.ts): what git does as a `context.backend`
// round-trip becomes one in-browser job here — discovery walk
// (doorstop-discovery) → per-document item-file reads (bounded concurrent) →
// parse (doorstop-model) → index assembly (buildDoorstopIndex) → state
// computation (computeItemStates). `context.files` is the only boundary;
// there is no `context.backend` anywhere in this module.
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

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type {
  DiscoveryDiagnostic,
  DoorstopDocumentConfig,
  DoorstopFileContent,
  DoorstopFiles,
  DoorstopFileTree,
  DoorstopIndex,
  DoorstopTreeEntry,
  ItemRecord,
} from "./doorstop-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";
import { discoverDoorstopDocuments, MAX_CONCURRENT_READS } from "./doorstop-discovery.js";
import { buildDoorstopIndex, parseDoorstopItem } from "./doorstop-model.js";
import { computeItemStates } from "./doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopWorkspaceHost,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";

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
  /** Wall-clock duration of the load job, in milliseconds. */
  loadingMs?: number;
}

/**
 * One in-browser load job: discovery walk → per-document item reads (bounded
 * concurrent) → parse → index assembly → state computation. The injected
 * `files` adapter (structurally satisfied by `context.files`) is the only
 * boundary, so tests drive the whole job through a fake and the panel never
 * touches `context.backend`. Never throws: discovery/parse convert every
 * problem into diagnostics on the index.
 */
export async function loadDoorstopWorkspace(files: DoorstopFiles): Promise<DoorstopWorkspaceResult> {
  const started = Date.now();
  const discovery = await discoverDoorstopDocuments(files);

  const items: ItemRecord[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [...discovery.diagnostics];

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
  return { index, loadingMs: Date.now() - started };
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

  /** Get-or-create the controller for a workspace (the render entry point). */
  for(context: WorkspacePanelContext): DoorstopWorkspaceController {
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
   *  connected workspace (browser-only plugin — no owned-workspace gate). */
  invalidate(context: WorkspacePanelContext): Promise<void> {
    return this.for(context).invalidate();
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

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}
