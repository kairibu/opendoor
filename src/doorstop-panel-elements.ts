// ---------------------------------------------------------------------------
// Opendoor panel Lit element (plan §3.1/§3.4, integration chain E2): the
// single workspace panel root `<pi-web-opendoor-panel-body>`, mirroring the
// opense-panel-elements.ts idiom (same register-once guard, same
// state-flow: controller fields mirrored into reactive properties by the
// host render function, controller passed for *actions*).
//
// Layout follows docs/feature-doorstop-plugin.md §7.1 — three regions in
// host-chrome classes (the git/opense panel conventions — toolbar/viewer/
// empty/muted), all `doorstop-*`-prefixed like git's `git-*`/opense's
// `opense-*`:
//
//   1. Toolbar — the document tree as chips (`REQ ← [TST, LLT]` via each
//      config's `parentPrefix`; item count + aggregate state dots; the
//      "All" chip clears the document filter), state-filter dropdown, search
//      input, Refresh (controller.invalidate), Run validation and Publish
//      HTML (terminal), and the stale notice.
//   2. Item list — level/uid/header-excerpt rows with per-ItemStateKey
//      chips; click selects the item. Diagnostics (truncated/binary/parse
//      errors) surface as an inline warning strip above the list.
//   3. Detail pane — uid/level/header, the item text as ESCAPED text (v1
//      deliberately renders no markdown — injection-safe by construction),
//      flags, links out (suspect/ok + recorded vs current fingerprint
//      shorts), links in, references, extended attributes as JSON-ish text,
//      local findings, and the action row: Review / Clear suspect links /
//      Edit / Unlink / Link / Ask-agent menu.
//
// Every terminal command goes through `context.terminal.runCommand({ title,
// command, metadata: { "opendoor.op": … }, open })`. `TerminalCommandRunHandle`
// (node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts) exposes
// `completed: Promise<TerminalCommandRun>`, so on completion the panel
// invalidates (rescans the workspace) — the §9.3 "re-scan on completion"
// obligation fulfilled without polling.
//
// The body element drives the controller lifecycle directly (opense hands
// that duty to its activity element; here there is only one element, so it
// raises/lowers the connection flag itself) — connect kicks the first load,
// disconnect drops late async writes, and a controller re-commit (workspace
// switch) ends the old workspace's connection and starts the new one's.
// ---------------------------------------------------------------------------

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { property, state } from "lit/decorators.js";
import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  ItemRecord,
  ItemStateKey,
  LinkRecord,
} from "./doorstop-contract.js";
import { computeItemStamp } from "./doorstop-state.js";
import type { DoorstopWorkspaceController } from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
} from "./doorstop-prompts.js";

export const bodyElementTag = "pi-web-opendoor-panel-body";

/** Empty-state copy for a workspace with no Doorstop documents (spec §7.1
 *  "empty states": no documents → the create hint). */
export const EMPTY_WORKSPACE_MESSAGE =
  "This workspace has no Doorstop documents — run `doorstop create REQ ./reqs` in the workspace to start a requirements tree.";

/** Reading title on the "All items" toolbar chip. */
const ALL_DOCUMENTS_LABEL = "All";

/** Human-readable chip label for every ItemStateKey (the UI never renders
 *  the raw key string). */
export const STATE_CHIP_LABELS: Record<ItemStateKey, string> = {
  normative: "normative",
  "non-normative": "non-normative",
  inactive: "inactive",
  reviewed: "reviewed",
  unreviewed: "unreviewed",
  "suspect-link": "suspect link",
  "no-child-links": "no child links",
  "no-links": "no links",
  "unknown-link": "unknown link",
  "missing-reference": "missing reference",
};

/** Chip color story for one ItemStateKey: informational states are muted,
 *  warn-ish states use the warning color, error-ish states (suspect links,
 *  unknown links, missing references, inactive) use the danger color —
 *  spec §7.1 "suspect/unreviewed/error-ish = distinct colors, muted for
 *  informational". */
export type StateChipKind = "muted" | "warning" | "danger";

export function stateChipKind(key: ItemStateKey): StateChipKind {
  switch (key) {
    case "normative":
    case "non-normative":
    case "reviewed":
      return "muted";
    case "unreviewed":
    case "no-child-links":
    case "no-links":
      return "warning";
    case "inactive":
    case "suspect-link":
    case "unknown-link":
    case "missing-reference":
      return "danger";
  }
}

/** Aggregate document state dot kinds ("green / suspect / unreviewed" of
 *  spec §7.1). */
export type DocumentStateDot = "ok" | "unreviewed" | "suspect";

function dotTitle(dot: DocumentStateDot): string {
  switch (dot) {
    case "ok":
      return "all items reviewed, no suspect links";
    case "unreviewed":
      return "has unreviewed changes";
    case "suspect":
      return "has suspect links";
  }
}

/**
 * The aggregate state dots of one document chip: a green "ok" dot when every
 * item is reviewed with no suspect links, an amber dot when any item is
 * unreviewed, and a red dot when any item has a suspect link (each shown
 * when it applies — a document can carry both amber and red).
 */
export function documentStateDots(
  document: DoorstopDocumentConfig,
  items: readonly ItemRecord[],
): DocumentStateDot[] {
  const own = items.filter((item) => item.documentPrefix === document.prefix);
  const dots: DocumentStateDot[] = [];
  if (own.length === 0) return dots;
  const hasSuspect = own.some((item) => item.stateKeys.includes("suspect-link"));
  const hasUnreviewed = own.some((item) => item.stateKeys.includes("unreviewed"));
  if (!hasSuspect && !hasUnreviewed) dots.push("ok");
  if (hasUnreviewed) dots.push("unreviewed");
  if (hasSuspect) dots.push("suspect");
  return dots;
}

/**
 * The item-list filter pipeline (document prefix + state chip + search over
 * UID/header/text). `documentPrefix` `undefined` and `""` both mean "all
 * documents" — `""` is the sentinel `selectDocument("")` writes when the
 * "All" chip clears the document filter (the controller's selectDocument
 * takes a plain string, so the element documents the empty-string meaning
 * here rather than mutating controller state directly).
 */
export function filteredItems(
  index: DoorstopIndex,
  documentPrefix: string | undefined,
  stateFilter: ItemStateKey | undefined,
  search: string,
): ItemRecord[] {
  const needle = search.trim().toLowerCase();
  return index.items.filter((item) => {
    if (documentPrefix !== undefined && documentPrefix !== "" && item.documentPrefix !== documentPrefix) {
      return false;
    }
    if (stateFilter !== undefined && !item.stateKeys.includes(stateFilter)) return false;
    if (needle !== "" && !`${item.uid} ${item.header ?? ""} ${item.text}`.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

/** Short fingerprint display form: first 8 chars + ellipsis; `null` (a link
 *  Doorstop has not stamped yet) renders as "none". */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint === null ? "none" : `${fingerprint.slice(0, 8)}…`;
}

/**
 * Whether `value` is a syntactically valid Doorstop target UID for the
 * Link/Unlink inline inputs — the model chain's `split_uid` grammar (prefix
 * [+sep] + digits [+sep+name]), ANCHORED to the whole string and restricted
 * to the UID alphabet. The unanchored model splitter intentionally ignores
 * trailing junk ("REQ001;echo" parses as REQ/1, matching Python `re.match`),
 * so reusing it directly as a validator would let shell syntax survive
 * interpolation into `doorstop ${op} ${item.uid} ${target}`. Here the entire
 * string must be one bare UID token: the explicit `[\w.-]` alphabet guard
 * rejects whitespace, quotes, and every shell metacharacter by construction
 * (a stray space can never slip in as a `\D`), and the structural checks
 * require a prefix + separator + digits|name, or a prefix + digits.
 */
function isValidTargetUid(value: string): boolean {
  if (value === "") return false;
  // UID alphabet guard — this alone rejects whitespace, quotes, and all
  // shell metacharacters, so an accepted target is always a safe bare token.
  if (!/^[\w.-]+$/.test(value)) return false;
  // prefix + separator + digits|name   (e.g. "REQ-001", "REQ_001", "REQ-ALPHA")
  if (/^[\w.-]+[-_.][\w]+$/.test(value)) return true;
  // prefix ending in a non-digit + digits, no separator (e.g. "REQ0001")
  if (/^[\w.-]*\D\d+$/.test(value)) return true;
  return false;
}

/** Config of an item's own document, or an inert fallback when the index is
 *  missing it — the state chain's own configForItem idiom, exported so the
 *  element's suspect/reviewed fingerprint comparisons reuse the exact same
 *  fallback (a missing config must not silently break stamps). */
function documentConfigFor(index: DoorstopIndex, item: ItemRecord): DoorstopDocumentConfig {
  return index.byPrefix.get(item.documentPrefix) ?? {
    directoryPath: "",
    configPath: "",
    prefix: item.documentPrefix,
    digits: 0,
    separator: "",
    itemformat: "yaml",
    extra: {},
  };
}

/**
 * The linked parent items of `item` whose recorded fingerprint no longer
 * matches the parent's current link-record stamp — the exact comparison the
 * state chain uses for the "suspect-link" chip (contract/state: recorded
 * `LinkRecord.fingerprint` vs `computeItemStamp(parent, config, false)`;
 * `null` recordings are never suspect). Drives the Clear button and the
 * Fix-suspect-links prompt.
 */
export function suspectParentItems(item: ItemRecord, index: DoorstopIndex): ItemRecord[] {
  const suspects: ItemRecord[] = [];
  for (const link of item.links) {
    if (link.fingerprint === null) continue;
    const target = index.byUid.get(link.uid);
    if (target === undefined) continue;
    if (link.fingerprint !== computeItemStamp(target, documentConfigFor(index, target), false)) {
      suspects.push(target);
    }
  }
  return suspects;
}

/** Prefix of the first child document of the item's own document (the
 *  document `doorstop add <PREFIX>` names when drafting a child item), or
 *  undefined when the document has no children (§7.3 draft-child action). */
export function firstChildDocumentPrefix(index: DoorstopIndex, item: ItemRecord): string | undefined {
  for (const document of index.documents) {
    if (document.parentPrefix === item.documentPrefix) return document.prefix;
  }
  return undefined;
}

/** JSON-ish text for one extended attribute value — always escaped by lit,
 *  never rendered as raw HTML (spec §7.1 extended-attributes table). */
function jsonishText(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/** Row summary for the item list: the header when present, else the first
 *  line of the text (truncated), else a placeholder dash. */
function itemExcerpt(item: ItemRecord): string {
  const header = item.header;
  if (header !== undefined && header !== "") return header;
  const firstLine = (item.text.split("\n")[0] ?? "").trim();
  if (firstLine === "") return "—";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

/**
 * Public property surface of the panel-root custom element. The host render
 * function mirrors the workspace controller's render inputs here (state flow
 * documented at the top of this module); `controller` provides the action
 * methods and `context` the terminal + prompt editor.
 */
export interface DoorstopPanelBodyElement extends LitElement {
  controller: DoorstopWorkspaceController | undefined;
  context: WorkspacePanelContext | undefined;
  result: DoorstopWorkspaceResult | undefined;
  loading: boolean;
  stale: boolean;
  error: string | undefined;
  selectedUid: string | undefined;
  selectedDocumentPrefix: string | undefined;
  stateFilter: ItemStateKey | undefined;
  search: string;
}

/**
 * The real host's workspace panel context does not declare `focusPrompt`
 * (it lives on the runtime context), so the prompt-insert path calls it
 * through this structural widening — present only where the host supplies it
 * (tests); anywhere else the insertText call alone focuses the mounted
 * editor (the host's prompt editor focuses itself on insert).
 */
type PanelContextWithFocusPrompt = WorkspacePanelContext & { focusPrompt?: () => void };

/** Toolbar icon: doorstop checklist (the panel title mark). */
const doorstopIconSvg = svg`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect width="8" height="4" x="8" y="3" rx="1"/><path d="m9 12 2 2 4-4"/></svg>`;

/** Toolbar icon: refresh (re-run discovery + load). */
const refreshIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;

/** Toolbar icon: validation shield. */
const validateIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;

/** Toolbar icon: publish (upload arrow). */
const publishIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;

/** Register the body element; safe to call more than once (plugin modules
 *  can be evaluated across reloads — each call is guarded per tag). */
export function defineDoorstopPanelElements(): void {
  defineDoorstopPanelBodyElement();
}

function defineDoorstopPanelBodyElement(): void {
  defineCustomElementOnce(bodyElementTag, () => {
    class DoorstopPanelBodyElement extends LitElement {
      /** Action surface (refresh/select/filter/terminal/prompt); all
       *  rendered inputs arrive via the mirrored properties below (module
       *  header documents the state flow). */
      @property({ attribute: false })
      controller: DoorstopWorkspaceController | undefined;

      /** Workspace context for the terminal and the prompt editor. */
      @property({ attribute: false })
      context: WorkspacePanelContext | undefined;

      /** Load result (mirrored from the controller; new object per load). */
      @property({ attribute: false })
      result: DoorstopWorkspaceResult | undefined;

      @property({ attribute: false })
      loading = false;

      @property({ attribute: false })
      stale = false;

      @property({ attribute: false })
      error: string | undefined;

      @property({ attribute: false })
      selectedUid: string | undefined;

      @property({ attribute: false })
      selectedDocumentPrefix: string | undefined;

      @property({ attribute: false })
      stateFilter: ItemStateKey | undefined;

      @property({ attribute: false })
      search = "";

      /** Whether the Ask-agent menu is expanded. */
      @state()
      private askMenuOpen = false;

      /** Inline error for the Link/Unlink target inputs (shown in the action
       *  row; cleared on the next successful run). */
      @state()
      private targetError: string | undefined;

      /** Whether a publish ran without an available confirmation dialog
       *  (sandboxed plugin hosts may not expose window.confirm) — surfaced
       *  as a muted notice so a skipped confirmation is never silent. */
      @state()
      private confirmSkipped = false;

      /** Inline target inputs of the Link/Unlink actions. Values stay
       *  uncontrolled (typed by the user; cleared after a run). */
      private readonly unlinkInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();
      private readonly linkInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();

      static override styles = [
        css`
        :host {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: var(--pi-text);
          background: var(--pi-bg);
          font: 13px system-ui, sans-serif;
        }

        button {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          background: var(--pi-surface);
          color: var(--pi-text);
          padding: 5px 7px;
          cursor: pointer;
        }

        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        input,
        select {
          border: 1px solid var(--pi-border);
          border-radius: 6px;
          background: var(--pi-surface);
          color: var(--pi-text);
          font-size: 12px;
          padding: 4px 6px;
        }

        code {
          border: 1px solid var(--pi-border-muted);
          border-radius: 5px;
          background: var(--pi-bg);
          padding: 1px 4px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }

        .doorstop-muted {
          color: var(--pi-muted);
        }

        /* --- toolbar (region 1) --- */
        .doorstop-toolbar {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--pi-border-muted);
        }

        .doorstop-title {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        .doorstop-docs {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 5px;
        }

        .doorstop-doc-chip {
          border-radius: 999px;
          padding: 2px 9px;
          font-size: 12px;
        }

        .doorstop-doc-chip.is-selected {
          border-color: var(--pi-accent);
          background: var(--pi-selection-bg);
          color: var(--pi-accent);
        }

        .doorstop-doc-arrow {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-doc-count {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: 0 0 auto;
        }

        .doorstop-dot-ok {
          background: var(--pi-success);
        }

        .doorstop-dot-unreviewed {
          background: var(--pi-warning);
        }

        .doorstop-dot-suspect {
          background: var(--pi-danger);
        }

        .doorstop-toolbar-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          margin-left: auto;
        }

        .doorstop-stale {
          border: 1px solid var(--pi-warning-border);
          border-radius: 999px;
          color: var(--pi-warning);
          padding: 1px 8px;
          font-size: 12px;
        }

        /* --- viewer (region 2 + 3) --- */
        .doorstop-viewer {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
        }

        .doorstop-standalone {
          margin: 14px;
        }

        .doorstop-error {
          margin: 8px;
          border: 1px solid var(--pi-danger);
          border-radius: 7px;
          color: var(--pi-danger);
          padding: 8px;
        }

        .doorstop-diagnostics {
          border-bottom: 1px solid var(--pi-border);
          padding: 6px;
          display: grid;
          gap: 5px;
        }

        .doorstop-diagnostic {
          display: flex;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 5px 7px;
        }

        .doorstop-diagnostic.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-diagnostic.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
        }

        .doorstop-severity {
          flex: 0 0 auto;
          padding: 0 6px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
        }

        .doorstop-diagnostic.doorstop-error .doorstop-severity {
          background: var(--pi-danger);
          color: var(--pi-bg);
        }

        .doorstop-diagnostic.doorstop-warning .doorstop-severity {
          background: var(--pi-warning);
          color: var(--pi-bg);
        }

        .doorstop-diagnostic-copy {
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 5px;
        }

        .doorstop-split {
          min-height: 100%;
          display: grid;
          grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr);
        }

        .doorstop-list {
          min-width: 0;
          border-right: 1px solid var(--pi-border-muted);
          display: flex;
          flex-direction: column;
        }

        .doorstop-detail-pane {
          min-width: 0;
        }

        .doorstop-items {
          padding: 6px;
          display: grid;
          gap: 1px;
        }

        .doorstop-item-row {
          display: grid;
          grid-template-columns: max-content max-content minmax(0, 1fr) max-content;
          gap: 8px;
          align-items: baseline;
          width: 100%;
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 4px 6px;
        }

        .doorstop-item-row:hover,
        .doorstop-item-row.is-selected {
          background: var(--pi-selection-bg);
        }

        .doorstop-item-level {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-item-summary {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--pi-text-secondary);
        }

        .doorstop-item-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          justify-content: flex-end;
        }

        /* --- state chips (item rows + detail head) --- */
        .doorstop-chip {
          border-radius: 999px;
          padding: 0 7px;
          font-size: 11px;
          white-space: nowrap;
        }

        .doorstop-chip-muted {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-chip-warning {
          border: 1px solid var(--pi-warning);
          color: var(--pi-warning);
        }

        .doorstop-chip-danger {
          border: 1px solid var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-chip-ok {
          border: 1px solid var(--pi-success-border);
          color: var(--pi-success);
        }

        /* --- detail pane (region 3) --- */
        .doorstop-detail {
          padding: 12px;
          display: grid;
          gap: 10px;
          align-content: start;
        }

        .doorstop-detail-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 8px;
        }

        .doorstop-detail-head h3 {
          margin: 0;
          font-size: 15px;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .doorstop-level {
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-flags {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .doorstop-flag {
          border: 1px solid var(--pi-border-muted);
          border-radius: 999px;
          color: var(--pi-muted);
          padding: 0 7px;
          font-size: 11px;
        }

        .doorstop-flag.is-inactive {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-state-chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .doorstop-section-title {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin: 0;
        }

        .doorstop-text {
          border: 1px solid var(--pi-border-muted);
          border-radius: 7px;
          background: var(--pi-surface);
          padding: 8px 10px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          margin: 0;
        }

        .doorstop-text.doorstop-text-empty {
          color: var(--pi-muted);
          font-style: italic;
        }

        .doorstop-links {
          display: grid;
          gap: 4px;
        }

        .doorstop-link-row {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 7px;
          width: 100%;
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 3px 6px;
        }

        .doorstop-link-row:hover {
          background: var(--pi-selection-bg);
        }

        .doorstop-fingerprint {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-attributes {
          margin: 0;
          display: grid;
          gap: 5px;
        }

        .doorstop-attribute {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr);
          gap: 10px;
          align-items: baseline;
        }

        .doorstop-attribute dt {
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-attribute dd {
          margin: 0;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .doorstop-findings {
          display: grid;
          gap: 4px;
        }

        .doorstop-finding {
          display: flex;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 3px 6px;
        }

        .doorstop-finding.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
          color: var(--pi-danger);
        }

        .doorstop-finding.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
          color: var(--pi-warning);
        }

        .doorstop-finding.doorstop-info {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-severity {
          flex: 0 0 auto;
          font-size: 11px;
          font-weight: 600;
        }

        /* --- action row --- */
        .doorstop-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          border-top: 1px solid var(--pi-border-muted);
          padding-top: 8px;
        }

        .doorstop-op {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .doorstop-target-input {
          width: 110px;
        }

        .doorstop-op-error {
          color: var(--pi-danger);
          font-size: 12px;
        }

        .doorstop-menu {
          position: relative;
        }

        .doorstop-menu-items {
          position: absolute;
          right: 0;
          top: calc(100% + 4px);
          z-index: 3;
          min-width: 180px;
          display: grid;
          gap: 2px;
          padding: 4px;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          background: var(--pi-surface);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
        }

        .doorstop-menu-item {
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 5px 8px;
        }

        .doorstop-menu-item:hover:not(:disabled) {
          background: var(--pi-selection-bg);
        }

        /* --- empty states --- */
        .doorstop-empty {
          margin: 10px 12px;
          border: 1px dashed var(--pi-border-muted);
          border-radius: 8px;
          color: var(--pi-muted);
          padding: 12px;
        }

        .doorstop-empty p {
          margin: 0;
        }

        .doorstop-empty .doorstop-muted {
          margin-top: 6px;
        }
      `,
      ];

      override connectedCallback(): void {
        super.connectedCallback();
        // The Ask-agent menu's outside-click/Escape dismissal needs a
        // document-level listener while the element is mounted.
        document.addEventListener("click", this.onDocumentClick);
        document.addEventListener("keydown", this.onDocumentKeydown);
        // The workspace panel became visible: raise the controller's
        // connection flag and kick the first load (idempotent — a cached
        // result or an in-flight loadRequest is left alone, §3.2).
        this.controller?.hostConnected();
      }

      override disconnectedCallback(): void {
        super.disconnectedCallback();
        document.removeEventListener("click", this.onDocumentClick);
        document.removeEventListener("keydown", this.onDocumentKeydown);
        // The panel left the DOM: drop the connection flag so late async
        // writes (load results landing afterwards) are discarded until the
        // workspace reconnects (plan §3.2).
        this.controller?.hostDisconnected();
      }

      protected override willUpdate(changedProperties: PropertyValues<this>): void {
        // Switching the selected item dismisses the Ask-agent menu (the menu
        // is scoped to one item; a stale menu for a previous selection is
        // meaningless).
        if (changedProperties.has("selectedUid")) {
          this.askMenuOpen = false;
        }
        // Workspace switch while the element stays connected (the host
        // re-commits a DIFFERENT controller): end the old workspace's
        // connection, start the new one's — same guarded ordering as the
        // pre-refactor controller-commit guards. `previous === undefined`
        // (initial mount) is skipped: connectedCallback already connected.
        if (this.isConnected && changedProperties.has("controller")) {
          const previous = changedProperties.get("controller") as DoorstopWorkspaceController | undefined;
          if (previous !== undefined && previous !== this.controller) {
            previous?.hostDisconnected();
            this.controller?.hostConnected();
          }
        }
      }

      protected override render(): TemplateResult {
        return html`
          ${this.renderToolbar()}
          ${this.error === undefined ? nothing : html`<div class="doorstop-error" role="alert">${this.error}</div>`}
          <section class="doorstop-viewer">${this.renderViewer()}</section>
        `;
      }

      // --- toolbar ------------------------------------------------------------------

      private renderToolbar(): TemplateResult {
        const result = this.result;
        return html`
          <section class="doorstop-toolbar">
            <strong class="doorstop-title">${doorstopIconSvg}Doorstop</strong>
            <div class="doorstop-docs" role="list" aria-label="Doorstop documents">
              ${result === undefined
                ? html`<span class="doorstop-muted">documents…</span>`
                : html`
                    ${this.renderDocumentChip(undefined, result)}
                    ${result.index.documents.map((document) => this.renderDocumentChip(document, result))}
                  `}
            </div>
            <div class="doorstop-toolbar-actions">
              ${this.stale ? html`<button type="button" class="doorstop-stale" title="Doorstop ran or files changed behind the panel — click to rescan" @click=${this.onRefreshClick}>stale — refresh</button>` : nothing}
              ${this.confirmSkipped ? html`<span class="doorstop-muted doorstop-confirm-skipped" title="No confirmation dialog is available in this environment — publishing proceeded without one">confirmation skipped — publishing</span>` : nothing}
              <select class="doorstop-state-filter" aria-label="Filter by state" @change=${this.onStateFilterChange}>
                <option value="" .selected=${this.stateFilter === undefined}>All states</option>
                ${Object.entries(STATE_CHIP_LABELS).map(
                  ([key, label]) =>
                    html`<option value=${key} .selected=${this.stateFilter === key}>${label}</option>`,
                )}
              </select>
              <input
                class="doorstop-search"
                type="search"
                aria-label="Search items"
                placeholder="Search UID or text"
                .value=${this.search}
                @input=${this.onSearchInput}
              />
              <button type="button" class="doorstop-refresh" title="Re-read the workspace" @click=${this.onRefreshClick}>${refreshIconSvg}Refresh</button>
              <button type="button" class="doorstop-validate" title="Run \`doorstop\` in the workspace terminal" @click=${this.onValidateClick}>${validateIconSvg}Run validation</button>
              <button type="button" class="doorstop-publish" title="Publish the tree to ./public" @click=${this.onPublishClick}>${publishIconSvg}Publish HTML</button>
            </div>
          </section>
        `;
      }

      /**
       * One document chip — `REQ ← [TST, LLT]`: each non-root chip shows
       * its `parentPrefix` as a small `← REQ` arrow (the tree edges come
       * from the configs' `parentPrefix`, spec §7.1), plus the item count
       * and the aggregate state dots. `undefined` renders the "All" chip
       * (clears the document filter). Clicking a chip filters the item list
       * to that document.
       */
      private renderDocumentChip(
        document: DoorstopDocumentConfig | undefined,
        result: DoorstopWorkspaceResult,
      ): TemplateResult {
        const prefix = document?.prefix ?? ALL_DOCUMENTS_LABEL;
        const count =
          document === undefined
            ? result.index.items.length
            : result.index.items.filter((item) => item.documentPrefix === document.prefix).length;
        const dots = document === undefined ? [] : documentStateDots(document, result.index.items);
        const selected =
          document === undefined
            ? this.selectedDocumentPrefix === undefined || this.selectedDocumentPrefix === ""
            : this.selectedDocumentPrefix === document.prefix;
        return html`
          <button
            type="button"
            role="listitem"
            class=${classMap({ "doorstop-doc-chip": true, "is-selected": selected })}
            data-prefix=${document?.prefix ?? ""}
            @click=${() => { this.controller?.selectDocument(document?.prefix ?? ""); }}
          >
            ${document?.parentPrefix === undefined ? nothing : html`<span class="doorstop-doc-arrow">← ${document.parentPrefix}</span>`}
            <span class="doorstop-doc-prefix">${prefix}</span>
            <span class="doorstop-doc-count">${String(count)}</span>
            ${dots.map((dot) => html`<span class=${`doorstop-dot doorstop-dot-${dot}`} title=${dotTitle(dot)}></span>`)}
          </button>
        `;
      }

      // --- item list ------------------------------------------------------------------

      private renderViewer(): TemplateResult {
        const result = this.result;
        if (result === undefined) {
          return html`<p class="doorstop-muted doorstop-standalone">${this.loading ? "Loading workspace…" : "Run Refresh to scan for Doorstop documents."}</p>`;
        }
        return html`
          ${this.renderDiagnostics(result)}
          ${result.index.documents.length === 0
            ? html`<section class="doorstop-empty"><p>${EMPTY_WORKSPACE_MESSAGE}</p></section>`
            : html`
                <section class="doorstop-split">
                  <section class="doorstop-list">${this.renderItemList(result)}</section>
                  <section class="doorstop-detail-pane">${this.renderDetail(result)}</section>
                </section>
              `}
        `;
      }

      /** Inline warning strip: every discovery + parse diagnostic (truncated
       *  reads, binary skips, item-name mismatches, parse errors) attributed
       *  by path — the module family's never-drop-silently discipline. */
      private renderDiagnostics(result: DoorstopWorkspaceResult): TemplateResult | typeof nothing {
        if (result.index.diagnostics.length === 0) return nothing;
        return html`
          <section class="doorstop-diagnostics" aria-label="Workspace diagnostics">
            ${result.index.diagnostics.map((diagnostic) => {
              const kind = diagnostic.severity === "error" ? "doorstop-error" : "doorstop-warning";
              return html`
                <div class=${`doorstop-diagnostic ${kind}`}>
                  <span class="doorstop-severity">${diagnostic.severity}</span>
                  <span class="doorstop-diagnostic-copy">
                    ${diagnostic.path === undefined ? nothing : html`<code>${diagnostic.path}</code>`}
                    ${diagnostic.message}
                  </span>
                </div>
              `;
            })}
          </section>
        `;
      }

      private renderItemList(result: DoorstopWorkspaceResult): TemplateResult {
        if (result.index.items.length === 0) {
          return html`<p class="doorstop-muted doorstop-standalone">No Doorstop items found (item files may be binary or truncated — see the diagnostics above).</p>`;
        }
        const items = filteredItems(result.index, this.selectedDocumentPrefix, this.stateFilter, this.search);
        if (items.length === 0) {
          return html`<p class="doorstop-muted doorstop-standalone">No items match the current document, state, or search filters.</p>`;
        }
        return html`
          <div class="doorstop-items" role="list" aria-label="Doorstop items">
            ${repeat(items, (item) => item.uid, (item) => this.renderItemRow(item))}
          </div>
        `;
      }

      private renderItemRow(item: ItemRecord): TemplateResult {
        const selected = this.selectedUid === item.uid;
        return html`
          <button
            type="button"
            role="listitem"
            class=${classMap({ "doorstop-item-row": true, "is-selected": selected })}
            data-uid=${item.uid}
            @click=${() => { this.controller?.selectUid(item.uid); }}
          >
            <span class="doorstop-item-level">${item.level}</span>
            <code class="doorstop-item-uid">${item.uid}</code>
            <span class="doorstop-item-summary">${itemExcerpt(item)}</span>
            <span class="doorstop-item-chips">
              ${item.stateKeys.map((key) => this.renderStateChip(key))}
            </span>
          </button>
        `;
      }

      private renderStateChip(key: ItemStateKey): TemplateResult {
        const kind = stateChipKind(key);
        return html`<span class=${`doorstop-chip doorstop-chip-${kind}`}>${STATE_CHIP_LABELS[key]}</span>`;
      }

      // --- detail pane ------------------------------------------------------------------

      private renderDetail(result: DoorstopWorkspaceResult): TemplateResult {
        const selectedUid = this.selectedUid;
        if (selectedUid === undefined) {
          return html`<p class="doorstop-muted doorstop-standalone">Select an item in the list to inspect its details.</p>`;
        }
        const item = result.index.byUid.get(selectedUid);
        // result is always assigned at the end of a load and the controller
        // clears dangling selections after every re-load, so a missing item
        // only means a selection that no longer exists — never a loading race.
        if (item === undefined) {
          return html`<p class="doorstop-muted doorstop-standalone">This item is no longer available — refresh the panel.</p>`;
        }
        const suspects = suspectParentItems(item, result.index);
        const children = result.index.childrenByUid.get(item.uid) ?? [];
        const findings = result.index.findings.filter((finding) => finding.uid === item.uid);
        return html`
          <section class="doorstop-detail" aria-label="Item details">
            <div class="doorstop-detail-head">
              <code class="doorstop-detail-uid">${item.uid}</code>
              <span class="doorstop-level">level ${item.level}</span>
              ${item.header === undefined ? nothing : html`<h3>${item.header}</h3>`}
            </div>
            ${this.renderFlags(item)}
            <div class="doorstop-state-chip-row">
              ${item.stateKeys.map((key) => this.renderStateChip(key))}
            </div>
            <h4 class="doorstop-section-title">Text</h4>
            <p class=${item.text === "" ? "doorstop-text doorstop-text-empty" : "doorstop-text"}>${item.text === "" ? "empty" : item.text}</p>
            <h4 class="doorstop-section-title">Parent links</h4>
            ${this.renderLinksOut(item, result.index)}
            <h4 class="doorstop-section-title">Child links</h4>
            ${this.renderLinksIn(item, result.index, children)}
            <h4 class="doorstop-section-title">References</h4>
            ${this.renderReferences(item, result.index)}
            ${Object.entries(item.attributes).length === 0
              ? nothing
              : html`
                  <h4 class="doorstop-section-title">Extended attributes</h4>
                  <dl class="doorstop-attributes">
                    ${Object.entries(item.attributes).map(
                      ([key, value]) =>
                        html`<div class="doorstop-attribute"><dt>${key}</dt><dd><code>${jsonishText(value)}</code></dd></div>`,
                    )}
                  </dl>
                `}
            <h4 class="doorstop-section-title">Findings</h4>
            ${findings.length === 0
              ? html`<p class="doorstop-muted">No local findings for this item.</p>`
              : html`<div class="doorstop-findings" aria-label="Findings for this item">
                  ${findings.map((finding) => {
                    const kind = finding.severity === "error" ? "doorstop-error" : finding.severity === "warning" ? "doorstop-warning" : "doorstop-info";
                    return html`<div class=${`doorstop-finding ${kind}`}><span class="doorstop-finding-severity">${finding.severity}</span><span>${finding.message}</span></div>`;
                  })}
                </div>`}
          </section>
          <section class="doorstop-actions" aria-label="Item actions">
            ${this.renderActionRow(item, result.index, suspects)}
          </section>
        `;
      }

      private renderFlags(item: ItemRecord): TemplateResult {
        return html`
          <div class="doorstop-flags" aria-label="Item flags">
            <span class=${classMap({ "doorstop-flag": true, "is-inactive": !item.active })}>
              ${item.active ? "active" : "inactive"}
            </span>
            <span class="doorstop-flag">${item.normative ? "normative" : "non-normative"}</span>
            <span class="doorstop-flag">${item.derived ? "derived" : "non-derived"}</span>
          </div>
        `;
      }

      /**
       * Links out (parents): each recorded link as UID + suspect/ok verdict
       * + recorded vs current fingerprint short forms. Clicking navigates
       * to the parent item. `computeItemStamp(parent, config, false)` is
       * exactly the link-record stamp the state chain compares against.
       */
      private renderLinksOut(item: ItemRecord, index: DoorstopIndex): TemplateResult {
        if (item.links.length === 0) return html`<p class="doorstop-muted">No parent links.</p>`;
        return html`
          <div class="doorstop-links" aria-label="Parent links">
            ${item.links.map((link) => this.renderLinkOut(link, index))}
          </div>
        `;
      }

      private renderLinkOut(link: LinkRecord, index: DoorstopIndex): TemplateResult {
        const target = index.byUid.get(link.uid);
        if (target === undefined) {
          return html`
            <div class="doorstop-link-row">
              <code>${link.uid}</code>
              <span class="doorstop-chip doorstop-chip-danger">unknown</span>
              <span class="doorstop-fingerprint">not in the index — ${link.fingerprint === null ? "no recorded fingerprint" : `recorded ${shortFingerprint(link.fingerprint)}`}</span>
            </div>
          `;
        }
        const current = computeItemStamp(target, documentConfigFor(index, target), false);
        const suspect = link.fingerprint !== null && link.fingerprint !== current;
        return html`
          <button
            type="button"
            class="doorstop-link-row"
            data-uid=${link.uid}
            title=${`Open ${link.uid}`}
            @click=${() => { this.controller?.selectUid(link.uid); }}
          >
            <code>${link.uid}</code>
            <span class=${suspect ? "doorstop-chip doorstop-chip-danger" : "doorstop-chip doorstop-chip-ok"}>${suspect ? "suspect" : "ok"}</span>
            <span class="doorstop-fingerprint">recorded ${shortFingerprint(link.fingerprint)} · current ${shortFingerprint(current)}</span>
          </button>
        `;
      }

      /** Links in (children): every item whose links include this UID,
       *  clickable to navigate. */
      private renderLinksIn(
        item: ItemRecord,
        index: DoorstopIndex,
        children: readonly ItemRecord[],
      ): TemplateResult {
        if (children.length === 0) {
          return html`<p class="doorstop-muted">No child links.</p>`;
        }
        return html`
          <div class="doorstop-links" aria-label="Child links">
            ${children.map((child) =>
              html`<button type="button" class="doorstop-link-row" data-uid=${child.uid} title=${`Open ${child.uid}`} @click=${() => { this.controller?.selectUid(child.uid); }}>
                <code>${child.uid}</code>
                <span class="doorstop-muted">${child.level}</span>
              </button>`,
            )}
          </div>
        `;
      }

      /** References: workspace-root-relative paths (resolved by the model
       *  chain), compared against the discovery file index — a missing file
       *  gets a "not found" chip (best effort; `doorstop validate` remains
       *  authoritative). */
      private renderReferences(item: ItemRecord, index: DoorstopIndex): TemplateResult {
        const paths: string[] = [];
        if (item.ref !== "") paths.push(item.ref);
        if (item.references !== undefined) {
          for (const reference of item.references) paths.push(reference.path);
        }
        if (paths.length === 0) return html`<p class="doorstop-muted">No file references.</p>`;
        return html`
          <div class="doorstop-links" aria-label="File references">
            ${paths.map((path) => {
              const found = index.knownFilePaths.has(path);
              return html`
                <div class="doorstop-link-row">
                  <code>${path}</code>
                  ${found ? nothing : html`<span class="doorstop-chip doorstop-chip-danger">not found</span>`}
                </div>
              `;
            })}
          </div>
        `;
      }

      // --- action row ------------------------------------------------------------------

      private renderActionRow(
        item: ItemRecord,
        index: DoorstopIndex,
        suspects: readonly ItemRecord[],
      ): TemplateResult {
        const reviewed = item.stateKeys.includes("reviewed");
        const suspectUids = suspects.length > 0 ? suspects.map((parent) => parent.uid) : [];
        return html`
          <button
            type="button"
            class="doorstop-review"
            ?disabled=${reviewed}
            title=${reviewed
              ? `${item.uid} is already reviewed against its current fingerprint`
              : `Mark ${item.uid} reviewed`}
            @click=${() => { this.reviewItem(item); }}
          >Review</button>
          <button
            type="button"
            class="doorstop-clear"
            ?disabled=${suspects.length === 0}
            title=${suspects.length === 0
              ? `No suspect links to clear`
              : `Re-record the parent fingerprints of ${item.uid}`}
            @click=${() => { this.clearSuspects(item, suspectUids); }}
          >Clear suspect links</button>
          <button
            type="button"
            class="doorstop-edit"
            title=${`Open ${item.uid} in the editor`}
            @click=${() => { this.editItem(item); }}
          >Edit</button>
          <div class="doorstop-op">
            <input
              type="text"
              class="doorstop-target-input"
              data-op="unlink"
              placeholder="parent UID"
              ${ref(this.unlinkInputRef)}
              @keydown=${this.onTargetKeydown}
            />
            <button type="button" class="doorstop-unlink" title=${`doorstop unlink ${item.uid} <target>`} @click=${() => { this.runTargetOp("unlink", this.unlinkInputRef, item); }}>Unlink</button>
          </div>
          <div class="doorstop-op">
            <input
              type="text"
              class="doorstop-target-input"
              data-op="link"
              placeholder="parent UID"
              ${ref(this.linkInputRef)}
              @keydown=${this.onTargetKeydown}
            />
            <button type="button" class="doorstop-link" title=${`doorstop link ${item.uid} <target>`} @click=${() => { this.runTargetOp("link", this.linkInputRef, item); }}>Link</button>
          </div>
          ${this.targetError === undefined ? nothing : html`<span class="doorstop-op-error" role="alert">${this.targetError}</span>`}
          ${this.renderAskMenu(item, index, suspects)}
        `;
      }

      /** Ask-agent menu (§7.3): the four prompt builders inserted into the
       *  prompt editor, followed by a focus of the editor. Fix-suspect-links
       *  and Draft-child are disabled (with an explaining title) when their
       *  builders would have nothing actionable to say. */
      private renderAskMenu(
        item: ItemRecord,
        index: DoorstopIndex,
        suspects: readonly ItemRecord[],
      ): TemplateResult {
        const children = index.childrenByUid.get(item.uid) ?? [];
        const childPrefix = firstChildDocumentPrefix(index, item);
        return html`
          <div class="doorstop-menu">
            <button
              type="button"
              class="doorstop-menu-toggle"
              aria-expanded=${this.askMenuOpen ? "true" : "false"}
              @click=${this.onAskMenuToggle}
            >Ask agent</button>
            ${this.askMenuOpen
              ? html`
                  <div class="doorstop-menu-items" role="menu" aria-label="Ask the agent about ${item.uid}">
                    <button type="button" role="menuitem" class="doorstop-menu-item doorstop-explain" @click=${() => { this.insertPrompt(explainItemPrompt(item)); }}>Explain</button>
                    <button
                      type="button"
                      role="menuitem"
                      class="doorstop-menu-item doorstop-fix-suspects"
                      ?disabled=${suspects.length === 0}
                      title=${suspects.length === 0 ? "No suspect links — nothing to fix" : `Fix the suspect links of ${item.uid}`}
                      @click=${() => { this.insertPrompt(fixSuspectLinksPrompt(item, suspects)); }}
                    >Fix suspect links</button>
                    <button
                      type="button"
                      role="menuitem"
                      class="doorstop-menu-item doorstop-draft-child"
                      ?disabled=${childPrefix === undefined}
                      title=${childPrefix === undefined ? "No child document to add to" : `Draft a child item in the ${childPrefix} document`}
                      @click=${() => {
                        if (childPrefix !== undefined) this.insertPrompt(draftChildRequirementPrompt(item, childPrefix));
                      }}
                    >Draft child requirement</button>
                    <button type="button" role="menuitem" class="doorstop-menu-item doorstop-review-readiness" @click=${() => { this.insertPrompt(reviewReadinessPrompt(item, children)); }}>Review readiness</button>
                  </div>
                `
              : nothing}
          </div>
        `;
      }

      // --- handlers ------------------------------------------------------------------

      private onRefreshClick = (): void => {
        void this.controller?.invalidate();
      };

      private onValidateClick = (): void => {
        this.runDoorstop("validate", "Doorstop: validate", "doorstop", true);
      };

      private onPublishClick = (): void => {
        // Publishing writes HTML artifacts across the workspace — confirm
        // before running when the host exposes a confirm dialog. Sandboxed
        // plugin hosts may not define window.confirm (it silently evaluates
        // false/undefined there), so feature-detect: when unavailable, run
        // publish anyway and surface a muted notice that the confirmation
        // was skipped rather than dropping the action.
        if (typeof window.confirm === "function") {
          if (!window.confirm("Publish the Doorstop tree as HTML to ./public in the workspace terminal?")) return;
          this.confirmSkipped = false;
        } else {
          this.confirmSkipped = true;
        }
        this.runDoorstop("publish", "Doorstop: publish", "doorstop publish all ./public", false);
      };

      private onStateFilterChange = (event: Event): void => {
        const value = (event.target as HTMLSelectElement).value;
        this.controller?.setStateFilter(value === "" ? undefined : (value as ItemStateKey));
      };

      private onSearchInput = (event: Event): void => {
        this.controller?.setSearch((event.target as HTMLInputElement).value);
      };

      private onTargetKeydown = (event: KeyboardEvent): void => {
        const input = event.target as HTMLInputElement;
        const op = input.getAttribute("data-op");
        if (op !== "unlink" && op !== "link") return;
        if (event.key === "Enter") {
          event.preventDefault();
          const item = this.selectedItem();
          if (item !== undefined) this.runTargetOp(op, op === "unlink" ? this.unlinkInputRef : this.linkInputRef, item);
        } else if (event.key === "Escape") {
          input.value = "";
        }
      };

      private reviewItem(item: ItemRecord): void {
        this.runDoorstop("review", `Doorstop: review ${item.uid}`, `doorstop review ${item.uid}`, false);
      }

      private clearSuspects(item: ItemRecord, suspectUids: readonly string[]): void {
        if (suspectUids.length === 0) return;
        // `doorstop clear <uid> [parent…]` re-records the current parent
        // fingerprints for the given links (the button is disabled without
        // suspect links, so the parents list is never empty here).
        this.runDoorstop(
          "clear",
          "Doorstop: clear suspect links",
          `doorstop clear ${item.uid} ${suspectUids.join(" ")}`,
          false,
        );
      }

      private editItem(item: ItemRecord): void {
        this.runDoorstop("edit", `Doorstop: edit ${item.uid}`, `doorstop edit ${item.uid}`, false);
      }

      private runTargetOp(op: "unlink" | "link", inputRef: Ref<HTMLInputElement>, item: ItemRecord): void {
        const input = inputRef.value;
        const target = input?.value.trim() ?? "";
        // Empty and invalid targets are surfaced as a visible inline error
        // (never a silent return, and never interpolated into the command)
        // — an unvalidated free-text target could smuggle shell syntax into
        // `doorstop ${op} ${item.uid} ${target}`.
        if (target === "") {
          this.targetError = `Enter a ${op} target UID (e.g. ${item.documentPrefix}0001)`;
          input?.focus();
          return;
        }
        if (!isValidTargetUid(target)) {
          this.targetError = `Invalid ${op} target "${target}" — expected a Doorstop UID like ${item.documentPrefix}0001 (no spaces, quotes, or special characters)`;
          input?.focus();
          return;
        }
        this.targetError = undefined;
        if (input !== undefined) input.value = "";
        this.runDoorstop(op, `Doorstop: ${op} ${item.uid}`, `doorstop ${op} ${item.uid} ${target}`, false);
      }

      private onDocumentClick = (event: MouseEvent): void => {
        // Outside-click dismissal of the Ask-agent menu. Uses composedPath so
        // clicks on the toggle/items inside the shadow-DOM menu root (which
        // would otherwise be retargeted to the host) stay "inside".
        if (!this.askMenuOpen) return;
        const menuRoot = this.shadowRoot?.querySelector(".doorstop-menu");
        if (menuRoot === undefined || menuRoot === null) {
          this.askMenuOpen = false;
          return;
        }
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        if (path.includes(menuRoot)) return;
        const target = event.target;
        if (target instanceof Node && menuRoot.contains(target)) return;
        this.askMenuOpen = false;
      };

      private onDocumentKeydown = (event: KeyboardEvent): void => {
        // Escape closes the Ask-agent menu (scoped to the menu; the target
        // inputs' own Escape-clear is handled separately in onTargetKeydown).
        if (event.key === "Escape" && this.askMenuOpen) {
          this.askMenuOpen = false;
        }
      };

      private onAskMenuToggle = (): void => {
        this.askMenuOpen = !this.askMenuOpen;
      };

      private insertPrompt(text: string): void {
        const context = this.context;
        if (context === undefined) return;
        context.prompt.insertText(text);
        // The panel context in the real host does not declare focusPrompt
        // (it lives on the runtime context); call it defensively where the
        // host supplies it — otherwise insertText already focuses the
        // mounted editor.
        (context as PanelContextWithFocusPrompt).focusPrompt?.();
        this.askMenuOpen = false;
      }

      /**
       * Run one doorstop CLI command in the workspace terminal (the exact
       * invocation surface of every panel action): a named run with
       * `metadata: { "opendoor.op": … }` so runs are identifiable, and —
       * because `TerminalCommandRunHandle.completed` resolves when the run
       * finishes — a rescan (invalidate) on completion so the panel picks up
       * whatever the CLI changed to the item files (§9.3, no polling). open
       * keeps the current view for item-scoped ops; validation opens the
       * terminal so its full output is visible.
       */
      private runDoorstop(op: string, title: string, command: string, open: boolean): void {
        const terminal = this.context?.terminal;
        if (terminal === undefined) return;
        void terminal
          .runCommand({ title, command, metadata: { "opendoor.op": op }, open })
          .then((handle) => {
            void handle.completed
              .then(() => { void this.controller?.invalidate(); })
              .catch(() => { void this.controller?.invalidate(); });
          })
          .catch(() => {
            // A rejected runCommand never reaches the panel domain: the
            // terminal surfaces its own error, and the panel has nothing
            // authoritative to add.
          });
      }

      private selectedItem(): ItemRecord | undefined {
        const result = this.result;
        const uid = this.selectedUid;
        if (result === undefined || uid === undefined) return undefined;
        return result.index.byUid.get(uid);
      }
    }
    customElements.define(bodyElementTag, DoorstopPanelBodyElement);
  });
}

/** Register a custom element exactly once. No-ops outside a DOM environment
 *  (node-side tests import modules that define elements) and on
 *  re-registration (plugin modules can be evaluated more than once across
 *  reloads). Local copy of the opense-shared idiom — this chain only creates
 *  the elements module. */
function defineCustomElementOnce(tag: string, define: () => void): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(tag) !== undefined) return;
  define();
}