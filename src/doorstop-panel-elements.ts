import type { WorkspacePanelContext, WorkspaceBackend } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { keyed } from "lit/directives/keyed.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { property, state } from "lit/decorators.js";
import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopItemReference,
  ItemRecord,
  ItemStateKey,
  LinkRecord,
} from "./doorstop-contract.js";
import {
  isValidDoorstopUid,
  OPENDOOR_PLUGIN_ID,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopRunResponse,
  type DoorstopCommitOutcome,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";
import { computeItemStamp } from "./doorstop-state.js";
import {
  doorstopPaths,
  type DoorstopBaselineView,
  type DoorstopGitStatusView,
  type DoorstopLastRunView,
  type DoorstopWorkspaceController,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";
import type { DiffLine, ItemFieldDiff } from "./doorstop-diff.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
} from "./doorstop-prompts.js";

export const bodyElementTag = "pi-web-opendoor-panel-body";

export const EMPTY_WORKSPACE_MESSAGE =
  "This workspace has no Doorstop documents — run `doorstop create REQ ./reqs` in the workspace to start a requirements tree.";

const ALL_DOCUMENTS_LABEL = "All";

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

/** `documentPrefix` `""` (the sentinel `selectDocument("")` writes for the
 *  "All" chip) and `undefined` both mean "all documents". */
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

/** `null` (a link Doorstop has not stamped yet) renders as "none". */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint === null ? "none" : `${fingerprint.slice(0, 8)}…`;
}

// --- findings view (feature spec §7.2) ---------------------------------------

/** Element-local sub-view (spec §7.2) — the controller has no view concept,
 *  so the toggle is intentionally not mirrored by the host render. */
export type DoorstopPanelView = "items" | "findings";

export const FINDINGS_EMPTY_MESSAGE = "No findings — the tree is clean.";

export const FINDINGS_EMPTY_HINT =
  "Findings are plugin-local; run `doorstop` validation in the terminal for the authoritative check.";

export const FINDINGS_PLUGIN_LOCAL_NOTE =
  "plugin-local findings — `doorstop` validation in the terminal is authoritative";

/** Merged shape over the index's findings and discovery diagnostics, which
 *  already carry exactly these fields structurally. */
export interface FindingsViewRow {
  severity: "error" | "warning" | "info";
  uid?: string;
  path?: string;
  message: string;
}

const FINDING_SEVERITY_RANK: Record<FindingsViewRow["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function findingsViewRows(index: DoorstopIndex): FindingsViewRow[] {
  const rows: FindingsViewRow[] = [...index.findings, ...index.diagnostics];
  return rows.sort((a, b) => FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity]);
}

export interface FindingsViewCounts {
  errors: number;
  warnings: number;
  info: number;
}

export function findingsViewCounts(rows: readonly FindingsViewRow[]): FindingsViewCounts {
  const counts: FindingsViewCounts = { errors: 0, warnings: 0, info: 0 };
  for (const row of rows) {
    if (row.severity === "error") counts.errors += 1;
    else if (row.severity === "warning") counts.warnings += 1;
    else counts.info += 1;
  }
  return counts;
}

export function findingsCountText(counts: FindingsViewCounts): string {
  const errors = counts.errors === 1 ? "1 error" : `${String(counts.errors)} errors`;
  const warnings = counts.warnings === 1 ? "1 warning" : `${String(counts.warnings)} warnings`;
  return `${errors} · ${warnings} · ${String(counts.info)} info`;
}

/** Exported so the exact fallback is testable independent of the toolbar. */
export function doorstopPublishTarget(result: DoorstopWorkspaceResult | undefined): string {
  return result?.settings?.publishTarget ?? DEFAULT_OPENDOOR_SETTINGS.publishTarget;
}

/** The commit flag travels only on the BACKEND path; the terminal fallback
 *  does not commit. */
export function doorstopCommitAfterReview(result: DoorstopWorkspaceResult | undefined): boolean {
  return result?.settings?.commitAfterReview ?? DEFAULT_OPENDOOR_SETTINGS.commitAfterReview;
}

/** `op` picks the narrative voice: the two outcome types SHARE the
 *  `clean`/`skipped`/`failed` statuses and are indistinguishable on them —
 *  a stage's `clean` means "nothing to stage", a commit's "nothing staged"
 *  — so the status alone cannot narrate correctly. The outcome is
 *  informational: for a REVIEW run it never flips the run's ok/failed
 *  badge, and on the git runs the run's own `status` already reflects a
 *  `failed` outcome. */
export function commitOutcomeText(op: DoorstopLastRunView["op"], outcome: DoorstopCommitOutcome | DoorstopGitStageResponse): string {
  const gitRun = op === "git-stage" || op === "git-commit";
  switch (outcome.status) {
    case "staged":
      return `staged ${String(outcome.staged ?? 0)} paths`;
    case "committed":
      return gitRun ? `committed ${outcome.sha ?? "<unknown sha>"}` : `commit: ${outcome.sha ?? "<unknown sha>"}`;
    case "clean":
      if (!gitRun) return "commit: clean (already committed)";
      return op === "git-stage" ? "clean — nothing to stage" : "clean — nothing staged";
    case "skipped":
      return gitRun ? "skipped" : "commit: skipped (not a git repository | review failed | deadline)";
    case "failed":
      return gitRun ? `failed — ${outcome.stderr ?? "git step errored"}` : `commit: failed — ${outcome.stderr ?? "git step errored"}`;
  }
}

export function lastRunHasMessage(lastRun: DoorstopLastRunView): boolean {
  return (
    lastRun.stdout !== "" ||
    lastRun.stderr !== "" ||
    (lastRun.errorMessage ?? "") !== "" ||
    lastRun.commit !== undefined
  );
}

/**
 * Zero counts are dropped because git OMITS the zero side of the
 * `[ahead N]` bracket — `ahead`/`behind` are absent at 0, mirrored here.
 * Exported for the Phase F element tests (the `commitOutcomeText` idiom).
 */
export function gitStatusText(response: DoorstopGitStatusResponse): string {
  const parts: string[] = [response.branch === undefined ? "⎇" : `⎇ ${response.branch}`];
  if (response.staged > 0) parts.push(`${String(response.staged)} staged`);
  if (response.dirty > 0) parts.push(`${String(response.dirty)} dirty`);
  if ((response.ahead ?? 0) > 0) parts.push(`↑${String(response.ahead)}`);
  if ((response.behind ?? 0) > 0) parts.push(`↓${String(response.behind)}`);
  return parts.join(" · ");
}

/** Shell-inert alphabet for a publish target (the UID guard's `\w` alphabet
 *  plus `/` for the default `./public`); anything else is shell-quoted by
 *  {@link doorstopPublishCommand}. */
const PUBLISH_TARGET_SAFE_TOKEN = /^[\w./-]+$/;

/** POSIX single-quote argument; the same idiom the host's terminal service
 *  uses when it echoes each runCommand through `$SHELL -lc`. */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The settings validator only guarantees the target is a workspace-relative
 *  PATH (no `..` segment, not absolute); it does NOT guarantee it is
 *  shell-inert, and the host runs the command through a login shell, so an
 *  unquoted metacharacter target from a committed `.pi-web/opendoor.json`
 *  would execute in the workspace terminal. Targets outside the inert
 *  {@link PUBLISH_TARGET_SAFE_TOKEN} alphabet are therefore single-quoted
 *  here, at the command boundary.
 *
 *  `target` may be passed explicitly so a caller that already computed it
 *  (the publish confirm path) keeps the confirm message and the command
 *  provably consistent. */
export function doorstopPublishCommand(
  result: DoorstopWorkspaceResult | undefined,
  target: string = doorstopPublishTarget(result),
): string {
  const argument = PUBLISH_TARGET_SAFE_TOKEN.test(target) ? target : quoteShellArgument(target);
  return `doorstop publish all ${argument}`;
}

/** Aliased by identity so the browser and the server bundle validate
 *  identically — an accepted target is always a shell-safe bare token.
 *  Exported for the contract parity test. */
export const isValidTargetUid = isValidDoorstopUid;

/** An inert fallback when the index is missing an item's document config —
 *  the same fallback the state chain uses, so a missing config must not
 *  silently break stamps. */
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

/** Must stay the exact comparison the state chain uses for the
 *  "suspect-link" chip: recorded `LinkRecord.fingerprint` vs
 *  `computeItemStamp(parent, config, false)`; `null` recordings are never
 *  suspect. */
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

export function firstChildDocumentPrefix(index: DoorstopIndex, item: ItemRecord): string | undefined {
  for (const document of index.documents) {
    if (document.parentPrefix === item.documentPrefix) return document.prefix;
  }
  return undefined;
}

function jsonishText(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function diffValueText(value: unknown): string {
  return value === undefined ? "—" : jsonishText(value);
}

function referenceListText(references: readonly DoorstopItemReference[]): string {
  return references
    .map((reference) => {
      const parts = [reference.path];
      if (reference.keyword !== undefined) parts.push(`#${reference.keyword}`);
      if (reference.sha !== undefined) parts.push(`@${reference.sha.slice(0, 8)}`);
      return parts.join(" ");
    })
    .join(", ");
}

function itemExcerpt(item: ItemRecord): string {
  const header = item.header;
  if (header !== undefined && header !== "") return header;
  const firstLine = (item.text.split("\n")[0] ?? "").trim();
  if (firstLine === "") return "—";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

/**
 * The host render function mirrors the workspace controller's render inputs
 * into the reactive properties below; `controller` provides the actions and
 * `context` the terminal + prompt editor.
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
  /** Mirrored from the controller. */
  lastRun: DoorstopLastRunView | undefined;
  /** Mirrored from the controller. */
  runInProgress: string | undefined;
  /** Mirrored from the controller: bumped on every baseline-cache mutation. */
  baselineVersion: number;
  /** Mirrored from the controller. */
  baselineInFlight: string | undefined;
  /** Mirrored from the controller; `undefined` before the first fetch lands
   *  (or after an invalidate cleared it). */
  gitStatusView: DoorstopGitStatusView | undefined;
  /** Mirrored from the controller — but the fetch/render guards read the
   *  CONTROLLER's live flags, since the mirrored property may lag a render. */
  gitStatusInFlight: boolean;
}

/** The real host's workspace panel context does not declare `focusPrompt`
 *  (it lives on the runtime context); present only where the host supplies
 *  it (tests). */
type PanelContextWithFocusPrompt = WorkspacePanelContext & { focusPrompt?: () => void };

const doorstopIconSvg = svg`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect width="8" height="4" x="8" y="3" rx="1"/><path d="m9 12 2 2 4-4"/></svg>`;

const refreshIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;

const validateIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;

const publishIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;

const gitStageIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>`;

const gitCommitIconSvg = svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;

export function defineDoorstopPanelElements(): void {
  defineDoorstopPanelBodyElement();
}

function defineDoorstopPanelBodyElement(): void {
  defineCustomElementOnce(bodyElementTag, () => {
    class DoorstopPanelBodyElement extends LitElement {
      /** Actions only; rendered inputs arrive via the mirrored properties. */
      @property({ attribute: false })
      controller: DoorstopWorkspaceController | undefined;

      @property({ attribute: false })
      context: WorkspacePanelContext | undefined;

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

      @property({ attribute: false })
      lastRun: DoorstopLastRunView | undefined;

      @property({ attribute: false })
      runInProgress: string | undefined;

      @property({ attribute: false })
      baselineVersion = 0;

      @property({ attribute: false })
      baselineInFlight: string | undefined;

      @property({ attribute: false })
      gitStatusView: DoorstopGitStatusView | undefined;

      @property({ attribute: false })
      gitStatusInFlight = false;

      @state()
      private askMenuOpen = false;

      @state()
      private targetError: string | undefined;

      @state()
      private gitActionError: string | undefined;

      @state()
      private gitCommitMessage = "";

      /** Sandboxed plugin hosts may not expose window.confirm. */
      @state()
      private confirmSkipped = false;

      /** Element-local — the controller has no view concept. */
      @state()
      private view: DoorstopPanelView = "items";

      /** Element-local @state — the controller has no expansion concept. */
      @state()
      private statusExpanded = false;

      private lastExpandedRun: DoorstopLastRunView | undefined;

      private readonly unlinkInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();
      private readonly linkInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();
      private readonly gitCommitInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();

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

        /* --- project actions (region 1) --- */
        .doorstop-project-actions {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--pi-border-muted);
        }

        /* --- list filters (above the item list, inside the viewer) --- */
        .doorstop-list-filters {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
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

        /* --- project-scoped git actions (plan-add-git-actions Phase D step 17) --- */
        .doorstop-git-status {
          /* The muted chip row: single line, ellipsis overflow at the row's
             own cap (the toolbar row wraps, so the chip never squeezes the
             title). The strip is a button — click re-fetches. text-overflow
             lives on the inner .doorstop-git-status-text span, NOT here: it
             only applies to BLOCK containers, and the button is inline-flex
             (the anonymous text flex item would hard-clip at the 240px cap
             with no ellipsis). This rule keeps overflow: hidden as the clip
             fallback and the chip's pill. */
          display: inline-flex;
          align-items: center;
          max-width: 240px;
          overflow: hidden;
          white-space: nowrap;
          border: 1px solid var(--pi-border-muted);
          border-radius: 999px;
          background: transparent;
          color: var(--pi-muted);
          padding: 2px 9px;
          font-size: 12px;
        }

        .doorstop-git-status-text {
          /* The ellipsis clip for the chip's text (see the parent rule): a
             BLOCK element inside the inline-flex button, with min-width: 0
             so it may shrink below its content width (the flexbox default
             min-width: auto would defeat the ellipsis — a flex item never
             overflow-clips below its content). */
          display: block;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .doorstop-git-status:hover:not(:disabled) {
          background: var(--pi-selection-bg);
        }

        .doorstop-git-status-error {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-git-commit {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        .doorstop-git-commit-input {
          /* Sized beside the existing toolbar buttons (the target inputs'
             width idiom) — wide enough for a real commit message, still
             one row in the toolbar. */
          width: 170px;
        }

        /* --- Items / Findings view toggle (spec §7.2) --- */
        .doorstop-view-toggle {
          display: inline-flex;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          overflow: hidden;
          flex: 0 0 auto;
        }

        .doorstop-view-tab {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: var(--pi-muted);
          padding: 3px 10px;
          font-size: 12px;
        }

        .doorstop-view-tab + .doorstop-view-tab {
          border-left: 1px solid var(--pi-border);
        }

        .doorstop-view-tab.is-selected {
          background: var(--pi-selection-bg);
          color: var(--pi-accent);
        }

        /* --- viewer (regions 2 + 3; the filters row and split stack) --- */
        .doorstop-viewer {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
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
          position: sticky;
          top: 0;
          z-index: 1;
          background: var(--pi-bg);
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
          flex: 1 1 auto;
          min-height: 0;
          display: grid;
          grid-template-rows: minmax(110px, 40%) minmax(0, 1fr);
        }

        .doorstop-list,
        .doorstop-detail-pane {
          min-height: 0;
        }

        .doorstop-list {
          border-bottom: 1px solid var(--pi-border-muted);
          overflow: auto;
          display: flex;
          flex-direction: column;
        }

        .doorstop-detail-pane {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .doorstop-detail-pane .doorstop-detail {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
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

        /* --- changes since review (Phase D step 14) --- */
        .doorstop-changes {
          border: 1px solid var(--pi-border-muted);
          border-radius: 7px;
          padding: 6px 10px;
        }

        .doorstop-changes-summary {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          cursor: pointer;
          user-select: none;
        }

        .doorstop-changes-summary::-webkit-details-marker {
          color: var(--pi-muted);
        }

        .doorstop-changes-notice {
          margin: 6px 0 0;
          font-size: 12px;
        }

        .doorstop-changes-source {
          margin: 6px 0 4px;
          font-size: 11px;
        }

        .doorstop-diff-lines {
          display: grid;
          max-height: 180px;
          overflow: auto;
          border: 1px solid var(--pi-border-muted);
          border-radius: 6px;
          margin: 6px 0 8px;
        }

        .doorstop-diff-line {
          display: flex;
          gap: 7px;
          border-bottom: 1px solid var(--pi-border-muted);
          padding: 1px 7px;
          font-family: var(--pi-monospace-family, monospace);
          font-size: 12px;
        }

        .doorstop-diff-line:last-child {
          border-bottom: 0;
        }

        .doorstop-diff-line.is-added {
          background: color-mix(in srgb, var(--pi-success) 9%, transparent);
        }

        .doorstop-diff-line.is-removed {
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-diff-mark {
          flex: 0 0 auto;
          width: 1em;
          text-align: center;
          user-select: none;
        }

        .doorstop-diff-line.is-added .doorstop-diff-mark {
          color: var(--pi-success);
        }

        .doorstop-diff-line.is-removed .doorstop-diff-mark {
          color: var(--pi-danger);
        }

        .doorstop-diff-line.is-same .doorstop-diff-mark {
          color: var(--pi-muted);
        }

        .doorstop-diff-text {
          min-width: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .doorstop-field-change {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px;
          border-top: 1px solid var(--pi-border-muted);
          padding: 5px 0 0;
          margin-top: 5px;
        }

        .doorstop-field-name {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .doorstop-field-chip {
          border-radius: 5px;
          border: 1px solid var(--pi-border-muted);
          font-size: 12px;
          padding: 1px 6px;
          overflow-wrap: anywhere;
        }

        .doorstop-field-chip-before {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-field-chip-after {
          border-color: var(--pi-success-border);
          color: var(--pi-success);
          background: color-mix(in srgb, var(--pi-success) 9%, transparent);
        }

        .doorstop-field-arrow {
          color: var(--pi-muted);
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

        /* --- item action palette (region 4), sized to the prompt footer --- */
        .doorstop-action-palette {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 12px;
          border-top: 1px solid var(--pi-border);
        }

        .doorstop-action-palette button {
          min-height: 36px;
          padding: 7px 9px;
        }

        /* The Ask-agent dropdown items keep their compact sizing: the parity
           rule above has higher specificity (0,1,1) than the menu-item rule
           (0,1,0), so without this override the popover rows would become
           tall palette buttons. The Unlink/Link buttons inside the op group
           deliberately keep the palette size — they are primary actions in
           the row, not menu rows. */
        .doorstop-action-palette .doorstop-menu-item {
          min-height: auto;
          padding: 5px 8px;
        }

        .doorstop-palette-placeholder {
          min-height: 36px;
          display: inline-flex;
          align-items: center;
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

        /* --- findings view (spec §7.2) --- */
        .doorstop-findings-view {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 10px 12px;
          display: grid;
          gap: 8px;
          align-content: start;
        }

        .doorstop-findings-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px 10px;
        }

        .doorstop-findings-counts {
          font-size: 12px;
          font-weight: 600;
        }

        .doorstop-findings-note {
          font-size: 11px;
        }

        .doorstop-findings-list {
          display: grid;
          gap: 3px;
        }

        .doorstop-finding-row {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 5px 8px;
        }

        .doorstop-finding-row.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-finding-row.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
        }

        .doorstop-finding-row.doorstop-info {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-row .doorstop-severity {
          background: var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-row.doorstop-error .doorstop-severity {
          background: var(--pi-danger);
          color: var(--pi-bg);
        }

        .doorstop-finding-row.doorstop-warning .doorstop-severity {
          background: var(--pi-warning);
          color: var(--pi-bg);
        }

        .doorstop-finding-uid {
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: inherit;
          padding: 0;
          font-weight: 600;
        }

        .doorstop-finding-uid:hover {
          text-decoration: underline;
          cursor: pointer;
        }

        .doorstop-finding-message {
          min-width: 0;
          overflow-wrap: anywhere;
        }

        /* --- empty states --- */
        .doorstop-empty {
          margin: 10px 12px;
          border: 1px dashed var(--pi-border-muted);
          border-radius: 8px;
          color: var(--pi-muted);
          padding: 12px;
          overflow: auto;
        }

        .doorstop-empty p {
          margin: 0;
        }

        .doorstop-empty .doorstop-muted {
          margin-top: 6px;
        }

        /* --- status bar (region 5), sized to the host center status bar --- */
        .doorstop-status-bar {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          min-width: 0;
          /* Cap the whole bar at 38% of the panel (the pre-improvement cap),
             not 38vh: on a short viewport with a tall side panel a viewport
             unit can dwarf the panel. The cap cannot live on the body div
             (.doorstop-last-run) — its containing block (this bar) is
             content-sized, so a percentage max-height there would be treated
             as none — so the bar caps itself and the body shrinks (and
             scrolls) below it. */
          max-height: 38%;
          border-top: 1px solid var(--pi-border);
          background: var(--pi-bg);
          color: var(--pi-muted);
          font: 12px system-ui, sans-serif;
        }

        .doorstop-status-bar-row {
          flex: 0 0 auto; /* the status row never collapses under the body cap */
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          padding: 7px 12px;
          overflow: hidden;
          white-space: nowrap;
        }

        /* The status bar's expanded output body — no card chrome. Shrinks
           (and scrolls) when the bar hits its 38% cap; content-sized
           otherwise. */
        .doorstop-last-run {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 8px 12px 10px;
          border-top: 1px solid var(--pi-border-muted);
        }

        .doorstop-last-run-commit {
          margin: 0 0 6px;
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        .doorstop-last-run-status {
          flex: 0 0 auto; /* the badge label keeps its full width */
          border-radius: 999px;
          padding: 0 7px;
          font-size: 11px;
          white-space: nowrap;
        }

        .doorstop-last-run-status.is-ok {
          border: 1px solid var(--pi-success-border);
          color: var(--pi-success);
        }

        .doorstop-last-run-status.is-failed,
        .doorstop-last-run-status.is-error {
          border: 1px solid var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-last-run-status.is-killed {
          border: 1px solid var(--pi-warning);
          color: var(--pi-warning);
        }

        .doorstop-last-run-meta {
          /* Fills the row's leftover width (plain auto margins would instead
             push Dismiss right and leave the meta at content width), so the
             ellipsis only kicks in where space actually runs out — the run
             title never collapses to nothing while the badge/Dismiss pair
             stays fixed. */
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-last-run-dismiss {
          flex: 0 0 auto;
          /* Buttons do not inherit font; match the bar's 12px system-ui. */
          font: inherit;
        }

        .doorstop-last-run-pre {
          border: 1px solid var(--pi-border-muted);
          border-radius: 6px;
          background: var(--pi-surface);
          color: var(--pi-text);
          padding: 6px 8px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
          max-height: 12em;
          overflow: auto;
          margin: 4px 0 0;
        }

        .doorstop-last-run-notice {
          margin: 4px 0 0;
          color: var(--pi-muted);
          font-size: 11px;
        }
      `,
      ];

      override connectedCallback(): void {
        super.connectedCallback();
        // For the Ask-agent menu's outside-click/Escape dismissal.
        document.addEventListener("click", this.onDocumentClick);
        document.addEventListener("keydown", this.onDocumentKeydown);
        // Kick the first load; idempotent (§3.2).
        this.controller?.hostConnected();
      }

      override disconnectedCallback(): void {
        super.disconnectedCallback();
        document.removeEventListener("click", this.onDocumentClick);
        document.removeEventListener("keydown", this.onDocumentKeydown);
        // Discards late async writes until the workspace reconnects (§3.2).
        this.controller?.hostDisconnected();
      }

      protected override willUpdate(changedProperties: PropertyValues<this>): void {
        // The Ask-agent menu is scoped to one item.
        if (changedProperties.has("selectedUid")) {
          this.askMenuOpen = false;
        }
        if (changedProperties.has("lastRun")) {
          const lastRun = this.lastRun;
          if (lastRun === undefined) {
            this.lastExpandedRun = undefined;
            this.statusExpanded = false;
          } else if (lastRun !== this.lastExpandedRun) {
            this.lastExpandedRun = lastRun;
            this.statusExpanded = lastRunHasMessage(lastRun);
          }
        }
        // Initial mount (`previous === undefined`) is skipped:
        // connectedCallback already connected.
        if (this.isConnected && changedProperties.has("controller")) {
          const previous = changedProperties.get("controller") as DoorstopWorkspaceController | undefined;
          if (previous !== undefined && previous !== this.controller) {
            previous?.hostDisconnected();
            this.controller?.hostConnected();
          }
        }
      }

      /**
       * Self-heal the reused-`<details>` hole: Lit REUSES the section's DOM
       * node when the same selected item re-renders after its cache key
       * changed (an edit landed) — node reuse fires no `toggle`, so the
       * expand handler alone would strand the section on "Loading baseline…"
       * with no fetch in flight. `requestBaseline` installs its "loading"
       * view synchronously, so this cannot loop. (A selection switch needs
       * no help here — {@link renderChangesSinceReview} keys the node by UID,
       * so Lit recreates it closed and the user's expand fires a real
       * `toggle`.)
       */
      protected override updated(): void {
        // Re-fetch after every `invalidate()` — any run may change the
        // workspace's dirtiness.
        this.ensureGitStatus();
        const details = this.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
        if (details === null || details === undefined || !details.open) return;
        const item = this.selectedItem();
        if (item === undefined) return;
        if (this.controller?.baselineViewFor(item) !== undefined) return;
        void this.controller?.requestBaseline(item);
      }

      /**
       * A `loading` view with no in-flight fetch is an ORPHAN (a fetch that
       * finished while disconnected had its landing dropped by the
       * late-write guard); the guard therefore covers missing views and
       * orphans. The controller JOINS concurrent calls, so a redundant kick
       * cannot stack a duplicate round-trip.
       */
      private ensureGitStatus(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        if (!this.backendActive()) return;
        if (
          (controller.gitStatusView === undefined || controller.gitStatusView.state === "loading") &&
          !controller.gitStatusInFlight
        ) {
          void controller.requestGitStatus();
        }
      }

      protected override render(): TemplateResult {
        return html`
          ${this.renderProjectActions()}
          ${this.error === undefined ? nothing : html`<div class="doorstop-error" role="alert">${this.error}</div>`}
          <section class="doorstop-viewer">${this.renderViewer()}</section>
          ${this.renderItemActionPalette()}
          ${this.renderStatusBar()}
        `;
      }

      // --- project actions (region 1) -----------------------------------------------

      private renderProjectActions(): TemplateResult {
        const publishTarget = doorstopPublishTarget(this.result);
        const projectPath = this.context?.workspace.path ?? "";
        // The heading is the project path (not a static "Doorstop" label):
        // basename displayed, full path kept as the tooltip.
        const projectLabel = projectPath === "" ? "Doorstop" : projectPath.split("/").filter(Boolean).pop() ?? projectPath;
        return html`
          <section class="doorstop-project-actions">
            <strong class="doorstop-title" title=${projectPath === "" ? nothing : projectPath}>${doorstopIconSvg}${projectLabel}</strong>
            ${this.renderViewToggle()}
            <div class="doorstop-toolbar-actions">
              ${this.stale ? html`<button type="button" class="doorstop-stale" title="Doorstop ran or files changed behind the panel — click to rescan" @click=${this.onRefreshClick}>stale — refresh</button>` : nothing}
              ${this.confirmSkipped ? html`<span class="doorstop-muted doorstop-confirm-skipped" title="No confirmation dialog is available in this environment — publishing proceeded without one">confirmation skipped — publishing</span>` : nothing}
              <button type="button" class="doorstop-refresh" title="Re-read the workspace" @click=${this.onRefreshClick}>${refreshIconSvg}Refresh</button>
              <button type="button" class="doorstop-validate" title="Run \`doorstop\` in the workspace (terminal when unpaired)" ?disabled=${this.runInProgress !== undefined} @click=${this.onValidateClick}>${validateIconSvg}Run validation</button>
              <button type="button" class="doorstop-publish" title=${`Publish the tree to ${publishTarget}`} ?disabled=${this.runInProgress !== undefined} @click=${this.onPublishClick}>${publishIconSvg}Publish HTML</button>
              ${this.renderGitActions()}
            </div>
          </section>
        `;
      }

      /**
       * The commit INPUT is disabled while a run is in flight (like the
       * buttons) so a typed-but-never-submitted message cannot be lost when
       * the run's invalidate lands mid-typing.
       */
      private renderGitActions(): TemplateResult | typeof nothing {
        if (!this.backendActive()) return nothing;
        const hasDocuments = (this.result?.index.documents.length ?? 0) > 0;
        return html`
          ${this.renderGitStatus()}
          <button
            type="button"
            class="doorstop-git-stage"
            title="Stage all Doorstop-managed files (requirements, documents, configs)"
            ?disabled=${this.runInProgress !== undefined || !hasDocuments}
            @click=${this.onGitStageClick}
          >${gitStageIconSvg}Stage all</button>
          <div class="doorstop-git-commit">
            <input
              type="text"
              class="doorstop-git-commit-input"
              placeholder="Commit message"
              aria-label="Git commit message"
              ?disabled=${this.runInProgress !== undefined}
              ${ref(this.gitCommitInputRef)}
              @input=${this.onGitCommitInput}
              @keydown=${this.onGitCommitKeydown}
            />
            <button
              type="button"
              class="doorstop-git-commit-button"
              title="Commit the staged index with this message"
              ?disabled=${this.runInProgress !== undefined || this.gitCommitMessage.trim() === ""}
              @click=${this.onGitCommitClick}
            >${gitCommitIconSvg}Commit</button>
            ${this.gitActionError === undefined ? nothing : html`<span class="doorstop-op-error" role="alert">${this.gitActionError}</span>`}
          </div>
        `;
      }

      private renderGitStatus(): TemplateResult | typeof nothing {
        const view = this.gitStatusView;
        if (view === undefined) return nothing;
        const refresh = (): void => { void this.controller?.requestGitStatus(); };
        switch (view.state) {
          case "loading":
            return html`<button
              type="button"
              class="doorstop-git-status"
              title="Refreshing git status…"
              aria-busy=${this.gitStatusInFlight}
              @click=${refresh}
            ><span class="doorstop-git-status-text">⎇ …</span></button>`;
          case "no-git":
            return html`<button type="button" class="doorstop-git-status" title="Not a git repository — click to re-check" aria-busy=${this.gitStatusInFlight} @click=${refresh}><span class="doorstop-git-status-text">no git</span></button>`;
          case "error":
            return html`<button
              type="button"
              class="doorstop-git-status doorstop-git-status-error"
              title=${`Git status unavailable — ${view.errorMessage ?? "request failed"} — click to retry`}
              aria-busy=${this.gitStatusInFlight}
              @click=${refresh}
            ><span class="doorstop-git-status-text">git status error — retry</span></button>`;
          case "ready":
            return html`<button type="button" class="doorstop-git-status" title="Git status — click to refresh" aria-busy=${this.gitStatusInFlight} @click=${refresh}><span class="doorstop-git-status-text">${gitStatusText(view.response)}</span></button>`;
        }
      }

      // --- list filters (above the item list) ---------------------------------------

      private renderListFilters(result: DoorstopWorkspaceResult): TemplateResult {
        return html`
          <section class="doorstop-list-filters">
            <div class="doorstop-docs" role="list" aria-label="Doorstop documents">
              ${this.renderDocumentChip(undefined, result)}
              ${result.index.documents.map((document) => this.renderDocumentChip(document, result))}
            </div>
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
          </section>
        `;
      }

      /**
       * Expansion is CONTENT-DRIVEN (see `willUpdate`); there is no manual
       * expand/collapse toggle.
       */
      private renderStatusBar(): TemplateResult | typeof nothing {
        const lastRun = this.lastRun;
        if (lastRun === undefined) return nothing;
        const statusLabel = lastRun.status === "killed" ? "killed (timeout)" : lastRun.status;
        const detailParts: string[] = [lastRun.title, `${String(lastRun.durationMs)} ms`];
        if (lastRun.exitCode !== null && (lastRun.status === "failed" || lastRun.status === "killed")) {
          detailParts.push(`exit ${String(lastRun.exitCode)}`);
        }
        if (lastRun.signal !== null) detailParts.push(lastRun.signal);
        return html`
          <section class="doorstop-status-bar" aria-label="Last run">
            <div class="doorstop-status-bar-row">
              <span class=${`doorstop-last-run-status is-${lastRun.status}`}>${statusLabel}</span>
              <span class="doorstop-last-run-meta">${detailParts.join(" · ")}</span>
              <button
                type="button"
                class="doorstop-last-run-dismiss"
                title="Dismiss the last run output"
                @click=${this.onDismissRun}
              >Dismiss</button>
            </div>
            ${this.statusExpanded ? this.renderStatusBarBody(lastRun) : nothing}
          </section>
        `;
      }

      private renderStatusBarBody(lastRun: DoorstopLastRunView): TemplateResult {
        return html`
          <div class="doorstop-last-run">
            ${lastRun.commit === undefined
              ? nothing
              : html`<p class="doorstop-last-run-commit doorstop-muted">${commitOutcomeText(lastRun.op, lastRun.commit)}</p>`}
            ${lastRun.status === "error"
              ? html`<pre class="doorstop-last-run-pre">${lastRun.errorMessage ?? ""}</pre>`
              : nothing}
            ${lastRun.stdout === ""
              ? nothing
              : html`
                  <pre class="doorstop-last-run-pre">${lastRun.stdout}</pre>
                  ${lastRun.stdoutTruncated
                    ? html`<p class="doorstop-last-run-notice">stdout truncated by the host stream limit (2 MiB) — output not fully captured</p>`
                    : nothing}
                `}
            ${lastRun.stderr === ""
              ? nothing
              : html`
                  <pre class="doorstop-last-run-pre">${lastRun.stderr}</pre>
                  ${lastRun.stderrTruncated
                    ? html`<p class="doorstop-last-run-notice">stderr truncated by the host stream limit (2 MiB) — output not fully captured</p>`
                    : nothing}
                `}
            ${lastRun.stdout === "" && lastRun.stderr === "" && lastRun.status !== "error"
              ? html`<p class="doorstop-last-run-notice">No output captured.</p>`
              : nothing}
          </div>
        `;
      }

      private renderViewToggle(): TemplateResult {
        return html`
          <div class="doorstop-view-toggle" role="tablist" aria-label="Requirements panel view">
            <button
              type="button"
              role="tab"
              class=${classMap({
                "doorstop-view-tab": true,
                "doorstop-view-items": true,
                "is-selected": this.view === "items",
              })}
              aria-selected=${this.view === "items" ? "true" : "false"}
              title="Item list and detail"
              @click=${() => { this.view = "items"; }}
            >Items</button>
            <button
              type="button"
              role="tab"
              class=${classMap({
                "doorstop-view-tab": true,
                "doorstop-view-findings": true,
                "is-selected": this.view === "findings",
              })}
              aria-selected=${this.view === "findings" ? "true" : "false"}
              title="Validation findings"
              @click=${() => { this.view = "findings"; }}
            >Findings</button>
          </div>
        `;
      }

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
        // Rendered in BOTH branches: diagnostics must never be silently
        // dropped — a workspace whose only document failed to parse still
        // shows the strip above the empty state.
        if (this.view === "findings") {
          return this.renderFindingsView(result);
        }
        return html`
          ${this.renderListFilters(result)}
          ${result.index.documents.length === 0
            ? html`
                ${this.renderDiagnostics(result)}
                <section class="doorstop-empty"><p>${EMPTY_WORKSPACE_MESSAGE}</p></section>
              `
            : html`
                <section class="doorstop-split">
                  <section class="doorstop-list">
                    ${this.renderDiagnostics(result)}
                    ${this.renderItemList(result)}
                  </section>
                  <section class="doorstop-detail-pane">${this.renderDetail(result)}</section>
                </section>
              `}
        `;
      }

      private renderFindingsView(result: DoorstopWorkspaceResult): TemplateResult {
        const rows = findingsViewRows(result.index);
        const counts = findingsViewCounts(rows);
        return html`
          <section class="doorstop-findings-view" aria-label="Doorstop findings">
            <header class="doorstop-findings-head">
              <span class="doorstop-findings-counts" role="status" aria-label="Finding counts">${findingsCountText(counts)}</span>
              <span class="doorstop-findings-note doorstop-muted">${FINDINGS_PLUGIN_LOCAL_NOTE}</span>
            </header>
            ${rows.length === 0
              ? html`
                  <section class="doorstop-empty">
                    <p>${FINDINGS_EMPTY_MESSAGE}</p>
                    <p class="doorstop-muted">${FINDINGS_EMPTY_HINT}</p>
                  </section>
                `
              : html`<div class="doorstop-findings-list" role="list" aria-label="Validation findings">
                  ${rows.map((row) => this.renderFindingRow(row, result.index))}
                </div>`}
          </section>
        `;
      }

      private renderFindingRow(row: FindingsViewRow, index: DoorstopIndex): TemplateResult {
        const kind =
          row.severity === "error" ? "doorstop-error" : row.severity === "warning" ? "doorstop-warning" : "doorstop-info";
        const uid = row.uid;
        const navigable = uid !== undefined && index.byUid.has(uid);
        return html`
          <div class=${`doorstop-finding-row ${kind}`} role="listitem">
            <span class="doorstop-severity">${row.severity}</span>
            ${uid === undefined
              ? nothing
              : navigable
                ? html`<button type="button" class="doorstop-finding-uid" data-uid=${uid} title=${`Show ${uid} in the item list`} @click=${() => { this.selectFindingTarget(uid); }}><code>${uid}</code></button>`
                : html`<code class="doorstop-finding-uid">${uid}</code>`}
            ${row.path === undefined ? nothing : html`<code class="doorstop-finding-path">${row.path}</code>`}
            <span class="doorstop-finding-message">${row.message}</span>
          </div>
        `;
      }

      private selectFindingTarget(uid: string): void {
        const controller = this.controller;
        if (controller === undefined) return;
        controller.selectDocument("");
        controller.setStateFilter(undefined);
        controller.setSearch("");
        controller.selectUid(uid);
        this.view = "items";
      }

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

      /** The baseline fetch and the review→commit pipeline live server-side,
       *  so this gates the sections that need them. */
      private backendActive(): boolean {
        const context = this.context;
        return (
          context?.backend !== undefined &&
          context.workspace.provider?.pluginId === OPENDOOR_PLUGIN_ID &&
          context.workspace.provider?.capabilities.request !== false
        );
      }

      /**
       * The `<details>` is wrapped in `keyed(item.uid, …)` so a selection
       * switch RE-CREATES the node (fresh, collapsed, with a real `toggle` on
       * expand) instead of Lit reusing the old item's open node — a reused
       * node fires no `toggle`, which would strand the new item on
       * "Loading baseline…". {@link updated} covers the remaining reuse
       * hole (same item re-rendered after its cache key changed).
       */
      private renderChangesSinceReview(item: ItemRecord): ReturnType<typeof keyed> | typeof nothing {
        if (!item.stateKeys.includes("unreviewed") || item.reviewed === null) return nothing;
        if (!this.backendActive()) return nothing;
        const view = this.controller?.baselineViewFor(item);
        return keyed(
          item.uid,
          html`
            <details class="doorstop-changes" @toggle=${this.onChangesToggle}>
              <summary class="doorstop-changes-summary">Changes since review</summary>
              ${view === undefined || view.state === "loading"
                ? html`<p class="doorstop-muted doorstop-changes-notice">Loading baseline…</p>`
                : this.renderBaselineView(view)}
            </details>
          `,
        );
      }

      private renderBaselineView(view: DoorstopBaselineView): TemplateResult {
        switch (view.state) {
          case "loading":
            return html`<p class="doorstop-muted doorstop-changes-notice">Loading baseline…</p>`;
          case "no-git":
            return html`<p class="doorstop-muted doorstop-changes-notice">No git history — previous version unavailable</p>`;
          case "no-match":
            return html`<p class="doorstop-muted doorstop-changes-notice">Could not locate the reviewed version (history may have been rewritten)</p>`;
          case "error":
            return html`<p class="doorstop-muted doorstop-changes-notice">Baseline unavailable — ${view.errorMessage ?? "request failed"}</p>`;
          case "ready": {
            const diff = view.diff;
            if (diff === undefined) return html`<p class="doorstop-muted doorstop-changes-notice">No changes found.</p>`;
            return this.renderBaselineDiff(view, diff);
          }
        }
      }

      private renderBaselineDiff(view: DoorstopBaselineView, diff: ItemFieldDiff): TemplateResult {
        return html`
          ${view.source === undefined
            ? nothing
            : html`<p class="doorstop-muted doorstop-changes-source">matched via ${view.source === "review-commit" ? "review commit" : "history walk"}</p>`}
          ${diff.text === undefined
            ? html`<p class="doorstop-muted doorstop-changes-notice">Text changed — too large to render a line diff.</p>`
            : html`<div class="doorstop-diff-lines" role="list" aria-label="Text changes since review">
                ${diff.text.map((line) => this.renderDiffLine(line))}
              </div>`}
          ${diff.ref === undefined ? nothing : this.renderFieldChange("ref", diff.ref.before, diff.ref.after)}
          ${diff.references === undefined
            ? nothing
            : this.renderFieldChange(
                "references",
                referenceListText(diff.references.before),
                referenceListText(diff.references.after),
              )}
          ${diff.linksAdded.length === 0 && diff.linksRemoved.length === 0
            ? nothing
            : html`<div class="doorstop-field-change">
                <span class="doorstop-field-name">links</span>
                ${diff.linksAdded.map((uid) => html`<code class="doorstop-field-chip doorstop-field-chip-after">+ ${uid}</code>`)}
                ${diff.linksRemoved.map((uid) => html`<code class="doorstop-field-chip doorstop-field-chip-before">− ${uid}</code>`)}
              </div>`}
          ${diff.extended.map((change) => this.renderFieldChange(change.name, change.before, change.after))}
        `;
      }

      private renderDiffLine(line: DiffLine): TemplateResult {
        const mark = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "";
        return html`
          <div class=${`doorstop-diff-line is-${line.kind}`} role="listitem">
            <span class="doorstop-diff-mark">${mark}</span>
            <span class="doorstop-diff-text">${line.text === "" ? "\u00a0" : line.text}</span>
          </div>
        `;
      }

      private renderFieldChange(label: string, before: unknown, after: unknown): TemplateResult {
        return html`
          <div class="doorstop-field-change">
            <span class="doorstop-field-name">${label}</span>
            <code class="doorstop-field-chip doorstop-field-chip-before">${diffValueText(before)}</code>
            <span class="doorstop-field-arrow">→</span>
            <code class="doorstop-field-chip doorstop-field-chip-after">${diffValueText(after)}</code>
          </div>
        `;
      }

      // --- detail pane ------------------------------------------------------------------

      // v1 deliberately renders the item text as escaped text — no markdown,
      // injection-safe by construction.
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
            ${this.renderChangesSinceReview(item)}
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
        `;
      }

      // --- item action palette (region 4) --------------------------------------------

      private renderItemActionPalette(): TemplateResult | typeof nothing {
        if (this.view !== "items") return nothing;
        const result = this.result;
        if (result === undefined || result.index.documents.length === 0) return nothing;
        const item = this.selectedItem();
        if (item === undefined) {
          return html`
            <section class="doorstop-action-palette" aria-label="Item actions">
              <span class="doorstop-muted doorstop-palette-placeholder">Select an item…</span>
            </section>
          `;
        }
        const suspects = suspectParentItems(item, result.index);
        return html`
          <section class="doorstop-action-palette" aria-label="Item actions">
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

      /** `computeItemStamp(parent, config, false)` is exactly the
       *  link-record stamp the state chain compares against. */
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
            ?disabled=${reviewed || this.runInProgress !== undefined}
            title=${reviewed
              ? `${item.uid} is already reviewed against its current fingerprint`
              : `Mark ${item.uid} reviewed`}
            @click=${() => { this.reviewItem(item); }}
          >Review</button>
          <button
            type="button"
            class="doorstop-clear"
            ?disabled=${suspects.length === 0 || this.runInProgress !== undefined}
            title=${suspects.length === 0
              ? `No suspect links to clear`
              : `Re-record the parent fingerprints of ${item.uid}`}
            @click=${() => { this.clearSuspects(item, suspectUids); }}
          >Clear suspect links</button>
          <button
            type="button"
            class="doorstop-edit"
            ?disabled=${this.runInProgress !== undefined}
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
            <button type="button" class="doorstop-unlink" title=${`doorstop unlink ${item.uid} <target>`} ?disabled=${this.runInProgress !== undefined} @click=${() => { this.runTargetOp("unlink", this.unlinkInputRef, item); }}>Unlink</button>
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
            <button type="button" class="doorstop-link" title=${`doorstop link ${item.uid} <target>`} ?disabled=${this.runInProgress !== undefined} @click=${() => { this.runTargetOp("link", this.linkInputRef, item); }}>Link</button>
          </div>
          ${this.targetError === undefined ? nothing : html`<span class="doorstop-op-error" role="alert">${this.targetError}</span>`}
          ${this.renderAskMenu(item, index, suspects)}
        `;
      }

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

      private onDismissRun = (): void => {
        this.statusExpanded = false;
        this.controller?.dismissRun();
      };

      private onRefreshClick = (): void => {
        void this.controller?.invalidate();
      };

      private onValidateClick = (): void => {
        this.runDoorstop("validate", "Doorstop: validate", { op: "validate" }, "doorstop", true);
      };

      private onPublishClick = (): void => {
        // Publishing writes HTML artifacts across the workspace, so confirm
        // before running when the host exposes a confirm dialog. Sandboxed
        // plugin hosts may not define window.confirm (it silently evaluates
        // false/undefined there), so feature-detect: run publish anyway and
        // surface a muted notice rather than dropping the action.
        const target = doorstopPublishTarget(this.result);
        if (typeof window.confirm === "function") {
          if (!window.confirm(`Publish the Doorstop tree as HTML to ${target} in the workspace terminal?`)) return;
          this.confirmSkipped = false;
        } else {
          this.confirmSkipped = true;
        }
        this.runDoorstop(
          "publish",
          "Doorstop: publish",
          { op: "publish", target },
          doorstopPublishCommand(this.result, target),
          false,
        );
      };

      private onGitCommitInput = (event: Event): void => {
        this.gitCommitMessage = (event.target as HTMLInputElement).value;
      };

      private onGitStageClick = (): void => {
        // The button's disabled state covers pointer clicks; this guard
        // covers every call path. An empty path list is DEFENSIVE only (the
        // button is disabled without documents) — surfaced as an inline
        // error, never a silent return.
        const controller = this.controller;
        if (controller === undefined) return;
        if (controller.runInProgress !== undefined) return;
        const result = this.result;
        if (result === undefined) {
          this.gitActionError = "The workspace is not loaded — refresh first";
          return;
        }
        const paths = doorstopPaths(result);
        if (paths.length === 0) {
          this.gitActionError = "Nothing to stage — the workspace has no Doorstop-managed files";
          return;
        }
        this.gitActionError = undefined;
        void controller.runGitStage(paths);
      };

      private onGitCommitClick = (): void => {
        this.gitCommitSubmit();
      };

      private onGitCommitKeydown = (event: KeyboardEvent): void => {
        const input = this.gitCommitInputRef.value;
        if (input === undefined) return;
        if (event.key === "Enter") {
          event.preventDefault();
          this.gitCommitSubmit();
        } else if (event.key === "Escape") {
          input.value = "";
          this.gitCommitMessage = "";
          this.gitActionError = undefined;
        }
      };

      /**
       * The browser must never send an empty commit message: the server
       * rejects it, and git with an empty `-m` would hang the exec until the
       * deadline. The input is cleared only on SUCCESS so a `failed` commit
       * (hook stderr, missing identity) keeps the message for a corrected
       * retry.
       */
      private gitCommitSubmit(): void {
        const controller = this.controller;
        if (controller === undefined) return;
        if (controller.runInProgress !== undefined) return;
        const input = this.gitCommitInputRef.value;
        const message = input?.value.trim() ?? "";
        if (message === "") {
          this.gitActionError = "Enter a commit message";
          input?.focus();
          return;
        }
        this.gitActionError = undefined;
        void controller.runGitCommit(message).then(() => {
          const lastRun = controller.lastRun;
          if (lastRun?.op === "git-commit" && lastRun.status === "ok" && input !== undefined) {
            input.value = "";
            this.gitCommitMessage = "";
          }
        });
      }

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
        // The commit flag is OMITTED under the default (optional-field
        // idiom) so old servers and in-flight requests across a mixed-version
        // reload window parse the request fine.
        const commit = doorstopCommitAfterReview(this.result);
        this.runDoorstop(
          "review",
          `Doorstop: review ${item.uid}`,
          commit ? { op: "review", uid: item.uid, commit: true } : { op: "review", uid: item.uid },
          `doorstop review ${item.uid}`,
          false,
        );
      }

      private clearSuspects(item: ItemRecord, suspectUids: readonly string[]): void {
        if (suspectUids.length === 0) return;
        this.runDoorstop(
          "clear",
          "Doorstop: clear suspect links",
          { op: "clear", uid: item.uid, parents: suspectUids },
          `doorstop clear ${item.uid} ${suspectUids.join(" ")}`,
          false,
        );
      }

      private editItem(item: ItemRecord): void {
        this.runDoorstop(
          "edit",
          `Doorstop: edit ${item.uid}`,
          { op: "edit", uid: item.uid },
          `doorstop edit ${item.uid}`,
          false,
        );
      }

      private runTargetOp(op: "unlink" | "link", inputRef: Ref<HTMLInputElement>, item: ItemRecord): void {
        const input = inputRef.value;
        const target = input?.value.trim() ?? "";
        // An unvalidated free-text target could smuggle shell syntax into
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
        this.runDoorstop(
          op,
          `Doorstop: ${op} ${item.uid}`,
          { op, uid: item.uid, target },
          `doorstop ${op} ${item.uid} ${target}`,
          false,
        );
      }

      private onDocumentClick = (event: MouseEvent): void => {
        // composedPath so clicks on the toggle/items inside the shadow-DOM
        // menu root (which would otherwise be retargeted to the host) stay
        // "inside".
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
        if (event.key === "Escape" && this.askMenuOpen) {
          this.askMenuOpen = false;
        }
      };

      private onAskMenuToggle = (): void => {
        this.askMenuOpen = !this.askMenuOpen;
      };

      private onChangesToggle = (event: Event): void => {
        const details = event.currentTarget;
        if (!(details instanceof HTMLDetailsElement) || !details.open) return;
        const item = this.selectedItem();
        if (item === undefined) return;
        void this.controller?.requestBaseline(item);
      };

      private insertPrompt(text: string): void {
        const context = this.context;
        if (context === undefined) return;
        context.prompt.insertText(text);
        // focusPrompt lives on the runtime context, not the panel context.
        (context as PanelContextWithFocusPrompt).focusPrompt?.();
        this.askMenuOpen = false;
      }

      /**
       * The single dispatch surface of every panel action, with TWO paths:
       *
       *  - BACKEND path when the workspace is owned by the opendoor provider
       *    with an active backend: the STRUCTURED `input` goes through
       *    `context.backend.request("doorstop.run", …)` — argv is built
       *    server-side, so the browser never shell-quotes on this path. A
       *    rejected request commits `status: "error"` and does NOT
       *    invalidate (the run wrote nothing to the workspace).
       *  - TERMINAL fallback everywhere else: `handle.completed` resolves
       *    when the run finishes, so the panel invalidates (rescans) on
       *    completion — no polling.
       *
       * This is the SINGLE choke point for the run-in-flight invariant: any
       * call site can never start a second overlapping run.
       */
      private runDoorstop(
        op: DoorstopRunRequest["op"],
        title: string,
        input: DoorstopRunRequest,
        terminalCommand: string,
        open: boolean,
      ): void {
        const context = this.context;
        const controller = this.controller;
        if (context === undefined || controller === undefined) return;
        if (controller.runInProgress !== undefined) return;
        if (
          context.backend !== undefined &&
          context.workspace.provider?.pluginId === OPENDOOR_PLUGIN_ID &&
          context.workspace.provider?.capabilities.request !== false
        ) {
          void this.runDoorstopBackend(op, title, input, context.backend);
          return;
        }
        const terminal = context.terminal;
        if (terminal === undefined) return;
        void terminal
          .runCommand({ title, command: terminalCommand, metadata: { "opendoor.op": op }, open })
          .then((handle) => {
            void handle.completed
              .then(() => { void controller.invalidate(); })
              .catch(() => { void controller.invalidate(); });
          })
          .catch(() => { /* the terminal surfaces its own error */ });
      }

      private async runDoorstopBackend(
        op: DoorstopRunRequest["op"],
        title: string,
        input: DoorstopRunRequest,
        backend: WorkspaceBackend,
      ): Promise<void> {
        const controller = this.controller;
        if (controller === undefined) return;
        controller.beginRun(title);
        const startedAt = Date.now();
        try {
          const response = await backend.request(DOORSTOP_RUN_OPERATION, input);
          const parsed = parseDoorstopRunResponse(response);
          const status =
            parsed.signal !== null ? "killed" : parsed.exitCode === 0 ? "ok" : "failed";
          controller.commitRun({
            // The server echoes the op it actually ran; render that echo
            // rather than the requested `op` so a mismatch cannot be masked.
            op: parsed.op,
            title,
            status,
            exitCode: parsed.exitCode,
            signal: parsed.signal,
            stdout: parsed.stdout,
            stderr: parsed.stderr,
            stdoutTruncated: parsed.stdoutTruncated,
            stderrTruncated: parsed.stderrTruncated,
            durationMs: parsed.durationMs,
            at: startedAt,
            // Optional review→commit outcome, absent under the default.
            ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
          });
          void controller.invalidate();
        } catch (error) {
          // No response → no server duration; client-side wall time instead.
          controller.commitRun({
            op,
            title,
            status: "error",
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: Date.now() - startedAt,
            at: startedAt,
            errorMessage: formatUnknownError(error),
          });
        } finally {
          controller.endRun();
        }
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

/** No-ops outside a DOM environment (node-side tests import modules that
 *  define elements) and on re-registration (plugin modules can be evaluated
 *  more than once across reloads). */
function defineCustomElementOnce(tag: string, define: () => void): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(tag) !== undefined) return;
  define();
}
