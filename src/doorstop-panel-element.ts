import type { WorkspacePanelContext, WorkspaceBackend } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { keyed } from "lit/directives/keyed.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { property, state } from "lit/decorators.js";
import { panelStyles } from "./doorstop-panel-styles.js";
import {
  doorstopIconSvg,
  gitCommitIconSvg,
  gitStageIconSvg,
  gitUnstageIconSvg,
  publishIconSvg,
  refreshIconSvg,
  trashIconSvg,
  validateIconSvg,
} from "./doorstop-panel-icons.js";
import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  ItemRecord,
  ItemStateKey,
  LinkRecord,
} from "./doorstop-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";
import {
  OPENDOOR_PLUGIN_ID,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopRunResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import { computeItemStamp } from "./doorstop-state.js";
import {
  doorstopPaths,
  type DoorstopBaselineView,
  type DoorstopGitStatusView,
  type DoorstopLastRunView,
  type DoorstopWorkspaceController,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import type { DiffLine, ItemFieldDiff } from "./doorstop-diff.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
} from "./doorstop-prompts.js";
import {
  ALL_DOCUMENTS_LABEL,
  commitOutcomeText,
  diffValueText,
  documentConfigFor,
  documentStateDots,
  dotTitle,
  doorstopCommitAfterReview,
  doorstopPublishCommand,
  doorstopPublishTarget,
  EMPTY_WORKSPACE_MESSAGE,
  filteredItems,
  FINDINGS_EMPTY_HINT,
  FINDINGS_EMPTY_MESSAGE,
  FINDINGS_PLUGIN_LOCAL_NOTE,
  findingsCountText,
  findingsViewCounts,
  findingsViewRows,
  firstChildDocumentPrefix,
  GIT_CHIP_LABELS,
  gitChipKind,
  gitStatusFileFor,
  gitStatusFilesByPath,
  gitStatusFilesTruncated,
  gitStatusText,
  itemExcerpt,
  itemGitState,
  itemStageable,
  itemUnstageable,
  isValidTargetUid,
  jsonishText,
  lastRunHasMessage,
  referenceListText,
  shortFingerprint,
  STATE_CHIP_LABELS,
  stateChipKind,
  suspectParentItems,
  type DoorstopPanelView,
  type FindingsViewRow,
} from "./doorstop-panel-view-model.js";


export const bodyElementTag = "pi-web-opendoor-panel-body";

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

      static override styles = panelStyles;

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

      /** The status response usable for PER-ITEM git UI: a paired install, a
       *  ready view, and an UNTRUNCATED `files` list. `undefined` when
       *  unpaired / loading / no-git / error / truncated, so the item list and
       *  action row render no chips, no per-row add, and no svg inside the row
       *  (the XSS assertion's structural dependency). The strip reads
       *  `gitStatusView` directly, so its honest counts still render even when
       *  this is `undefined`. */
      private readyGitStatus(): DoorstopGitStatusResponse | undefined {
        if (!this.backendActive()) return undefined;
        const view = this.gitStatusView;
        if (view === undefined || view.state !== "ready") return undefined;
        if (gitStatusFilesTruncated(view.response)) return undefined;
        return view.response;
      }

      /** The path→git-file map for one list render; `undefined` when per-item
       *  git UI is unavailable (see {@link readyGitStatus}). */
      private readyGitFiles(): Map<string, DoorstopGitStatusFile> | undefined {
        const response = this.readyGitStatus();
        return response === undefined ? undefined : gitStatusFilesByPath(response);
      }

      private renderItemList(result: DoorstopWorkspaceResult): TemplateResult {
        if (result.index.items.length === 0) {
          return html`<p class="doorstop-muted doorstop-standalone">No Doorstop items found (item files may be binary or truncated — see the diagnostics above).</p>`;
        }
        const items = filteredItems(result.index, this.selectedDocumentPrefix, this.stateFilter, this.search);
        if (items.length === 0) {
          return html`<p class="doorstop-muted doorstop-standalone">No items match the current document, state, or search filters.</p>`;
        }
        // One lookup pass for the whole list; each row reads its own path.
        const gitFiles = this.readyGitFiles();
        return html`
          <div class="doorstop-items" role="list" aria-label="Doorstop items">
            ${repeat(items, (item) => item.uid, (item) => this.renderItemRow(item, gitFiles))}
          </div>
        `;
      }

      private renderItemRow(
        item: ItemRecord,
        gitFiles: Map<string, DoorstopGitStatusFile> | undefined,
      ): TemplateResult {
        const selected = this.selectedUid === item.uid;
        const gitState = itemGitState(gitFiles?.get(item.path));
        // The per-row add/remove is pointer-only by design: the row IS a
        // <button>, so a nested <button> would be hoisted out by the HTML
        // parser. A <span> parses fine, but a role="button" that is not
        // keyboard-operable would violate the ARIA contract — and the
        // affordance is redundant with the keyboard-reachable region-4
        // Stage/Unstage buttons — so it is hidden from the accessibility
        // tree (`aria-hidden`) and left as a pointer shortcut. One span
        // hosts BOTH directions: the minus (index/X dirty) takes precedence
        // over the plus (worktree/Y dirty) so a `staged-changed` (`MM`) row
        // shows the requested "I staged by mistake" minus, and the palette's
        // Stage button remains the keyboard path for the plus half.
        const stageable = itemStageable(gitFiles?.get(item.path));
        const unstageable = itemUnstageable(gitFiles?.get(item.path));
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
              ${gitState === "clean" ? nothing : html`<span class=${`doorstop-chip doorstop-chip-${gitChipKind(gitState)}`}>${GIT_CHIP_LABELS[gitState]}</span>`}
              ${unstageable && this.runInProgress === undefined
                ? html`<span
                    class="doorstop-item-add"
                    aria-hidden="true"
                    title=${`git reset ${item.path}`}
                    @click=${(event: Event) => { event.stopPropagation(); this.unstageItem(item); }}
                  >${gitUnstageIconSvg}</span>`
                : stageable && this.runInProgress === undefined
                  ? html`<span
                      class="doorstop-item-add"
                      aria-hidden="true"
                      title=${`git add ${item.path}`}
                      @click=${(event: Event) => { event.stopPropagation(); this.stageItem(item); }}
                    >${gitStageIconSvg}</span>`
                  : nothing}
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
            <h4 class="doorstop-section-title">Text</h4>
            <p class=${item.text === "" ? "doorstop-text doorstop-text-empty" : "doorstop-text"}>${item.text === "" ? "empty" : item.text}</p>
            ${this.renderChangesSinceReview(item)}
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
            ${item.links.map((link) => this.renderLinkOut(item, link, index))}
          </div>
        `;
      }

      private renderLinkOut(item: ItemRecord, link: LinkRecord, index: DoorstopIndex): TemplateResult {
        // The trash can is pointer-only by design: the known-target row IS a
        // <button>, so a nested <button> would be hoisted out by the HTML
        // parser. A <span> parses fine, but a role="button" that is not
        // keyboard-operable would violate the ARIA contract — and the
        // keyboard path is the palette's Unlink input — so it is hidden from
        // the accessibility tree (`aria-hidden`) and left as a pointer
        // shortcut. `stopPropagation` is mandatory on the known-target row so
        // the click does not also navigate to the link target.
        const remove = html`
          <span
            class="doorstop-link-remove"
            aria-hidden="true"
            title=${`doorstop unlink ${item.uid} ${link.uid}`}
            @click=${(event: Event) => { event.stopPropagation(); this.unlinkLink(item, link.uid); }}
          >${trashIconSvg}</span>
        `;
        const target = index.byUid.get(link.uid);
        if (target === undefined) {
          return html`
            <div class="doorstop-link-row">
              <code>${link.uid}</code>
              <span class="doorstop-chip doorstop-chip-danger">unknown</span>
              <span class="doorstop-fingerprint">not in the index — ${link.fingerprint === null ? "no recorded fingerprint" : `recorded ${shortFingerprint(link.fingerprint)}`}</span>
              ${remove}
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
            ${remove}
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
        // ONE ready-check for both the buttons and their stageable/
        // unstageable predicates; `readyGitStatus` already owns the
        // paired/ready/untruncated gate, so the chip row and the palette
        // buttons can never disagree.
        const gitStatus = this.readyGitStatus();
        const gitFile = gitStatus === undefined ? undefined : gitStatusFileFor(gitStatus, item.path);
        const stageable = itemStageable(gitFile);
        const unstageable = itemUnstageable(gitFile);
        return html`
          <button
            type="button"
            class="doorstop-review"
            ?disabled=${reviewed || this.runInProgress !== undefined}
            title=${reviewed
              ? `${item.uid} is already reviewed against its current fingerprint`
              : `Mark ${item.uid} reviewed`}
            @click=${() => { this.reviewItem(item); }}
          >Approve</button>
          <button
            type="button"
            class="doorstop-clear"
            ?disabled=${suspects.length === 0 || this.runInProgress !== undefined}
            title=${suspects.length === 0
              ? `No suspect links to clear`
              : `Re-record the parent fingerprints of ${item.uid}`}
            @click=${() => { this.clearSuspects(item, suspectUids); }}
          >Clear suspect links</button>
          ${gitStatus === undefined
            ? nothing
            : html`<button
                type="button"
                class="doorstop-item-stage"
                ?disabled=${this.runInProgress !== undefined || !stageable}
                title=${stageable
                  ? `Stage ${item.path}`
                  : `${item.uid} has no unstaged changes — commit next`}
                @click=${() => { this.stageItem(item); }}
              >${gitStageIconSvg}Stage</button>
              <button
                type="button"
                class="doorstop-item-unstage"
                ?disabled=${this.runInProgress !== undefined || !unstageable}
                title=${unstageable
                  ? `Unstage ${item.path} (git reset)`
                  : `${item.uid} has nothing staged`}
                @click=${() => { this.unstageItem(item); }}
              >${gitUnstageIconSvg}Unstage</button>`}
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

      /** Stage one item's own file — the same `doorstop.git-stage` operation
       *  with `[item.path]`; the shared run dispatch narrates the uid. Shared
       *  by the row's `git add` span and the palette's Stage button. */
      private stageItem(item: ItemRecord): void {
        const controller = this.controller;
        if (controller === undefined || controller.runInProgress !== undefined) return;
        void controller.runGitStage([item.path], `Git: stage ${item.uid}`);
      }

      /** Unstage one item's own file — the `doorstop.git-unstage` inverse with
       *  `[item.path]`; the shared run dispatch narrates the uid. Shared by
       *  the row's minus span and the palette's Unstage button. The guard
       *  mirrors {@link stageItem}: a run already in flight must never be
       *  overlapped (the disabled states cover pointer clicks; this covers
       *  every call path). */
      private unstageItem(item: ItemRecord): void {
        const controller = this.controller;
        if (controller === undefined || controller.runInProgress !== undefined) return;
        void controller.runGitUnstage([item.path], `Git: unstage ${item.uid}`);
      }

      /** Unlink one parent from one item — the same `unlink` run the palette's
       *  free-text Unlink button dispatches, but with the target sourced from
       *  the index (`link.uid`) instead of an input. The guard mirrors
       *  {@link stageItem}: a run already in flight must never be overlapped.
       *  There is no `targetError` interaction: an index-sourced UID cannot
       *  fail the free-text validation, and `parseDoorstopRunRequest`
       *  re-validates server-side. */
      private unlinkLink(item: ItemRecord, target: string): void {
        const controller = this.controller;
        // Deliberately redundant with the guard inside runDoorstop: keeping the
        // same early-out here as stageItem/unstageItem makes the in-flight
        // contract uniform across every detail-pane action.
        if (controller === undefined || controller.runInProgress !== undefined) return;
        this.runDoorstop(
          "unlink",
          `Doorstop: unlink ${item.uid}`,
          { op: "unlink", uid: item.uid, target },
          `doorstop unlink ${item.uid} ${target}`,
          false,
        );
      }

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
