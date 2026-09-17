import type { WorkspacePanelContext, WorkspaceBackend } from "@jmfederico/pi-web/plugin-api";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { createRef, type Ref } from "lit/directives/ref.js";
import { property, state } from "lit/decorators.js";
import { panelStyles } from "./doorstop-panel-styles.js";
import type { ItemRecord, ItemStateKey } from "../doorstop-contract.js";
import { formatUnknownError } from "../doorstop-contract.js";
import {
  OPENDOOR_PLUGIN_ID,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopRunResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopRunRequest,
} from "../doorstop-backend-contract.js";
import {
  type DoorstopGitStatusView,
  type DoorstopLastRunView,
  type DoorstopWorkspaceController,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import {
  gitStatusFilesByPath,
  gitStatusFilesTruncated,
  lastRunHasMessage,
  type DoorstopPanelView,
} from "./doorstop-panel-view-model.js";
import { renderProjectActions } from "./sections/project-actions.js";
import { renderViewer, renderStateChip as renderStateChipTemplate } from "./sections/item-list.js";
import { renderItemActionPalette } from "./sections/item-action-palette.js";
import { renderStatusBar } from "./sections/status-bar.js";

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

      /** section-API: the Ask-agent menu's open flag (scoped to one item). */
      @state()
      askMenuOpen = false;

      /** section-API: the palette's target-input validation error. */
      @state()
      targetError: string | undefined;

      /** section-API: the git stage/commit inline error. */
      @state()
      gitActionError: string | undefined;

      /** section-API: the typed commit message that gates the Commit button. */
      @state()
      gitCommitMessage = "";

      /** section-API: sandboxed plugin hosts may not expose window.confirm. */
      @state()
      confirmSkipped = false;

      /** section-API: element-local view switch — the controller has no view concept. */
      @state()
      view: DoorstopPanelView = "items";

      /** section-API: element-local output expansion — the controller has no
       *  expansion concept. */
      @state()
      statusExpanded = false;

      private lastExpandedRun: DoorstopLastRunView | undefined;

      /** section-API: the palette's free-text Link target input. */
      readonly linkInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();
      /** section-API: the toolbar's commit-message input. */
      readonly gitCommitInputRef: Ref<HTMLInputElement> = createRef<HTMLInputElement>();

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
       * no help here — the section keys the node by UID, so Lit recreates it
       * closed and the user's expand fires a real `toggle`.)
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
          ${renderProjectActions(this)}
          ${this.error === undefined ? nothing : html`<div class="doorstop-error" role="alert">${this.error}</div>`}
          <section class="doorstop-viewer">${renderViewer(this)}</section>
          ${renderItemActionPalette(this)}
          ${renderStatusBar(this)}
        `;
      }

      /** section-API: the baseline fetch and the review→commit pipeline live
       *  server-side, so this gates the sections that need them. */
      backendActive(): boolean {
        const context = this.context;
        return (
          context?.backend !== undefined &&
          context.workspace.provider?.pluginId === OPENDOOR_PLUGIN_ID &&
          context.workspace.provider?.capabilities.request !== false
        );
      }

      /** section-API: the status response usable for PER-ITEM git UI: a paired
       *  install, a ready view, and an UNTRUNCATED `files` list. `undefined` when
       *  unpaired / loading / no-git / error / truncated, so the item list and
       *  action row render no chips, no per-row add, and no svg inside the row
       *  (the XSS assertion's structural dependency). The strip reads
       *  `gitStatusView` directly, so its honest counts still render even when
       *  this is `undefined`. */
      readyGitStatus(): DoorstopGitStatusResponse | undefined {
        if (!this.backendActive()) return undefined;
        const view = this.gitStatusView;
        if (view === undefined || view.state !== "ready") return undefined;
        if (gitStatusFilesTruncated(view.response)) return undefined;
        return view.response;
      }

      /** section-API: the path→git-file map for one list render; `undefined`
       *  when per-item git UI is unavailable (see {@link readyGitStatus}). */
      readyGitFiles(): Map<string, DoorstopGitStatusFile> | undefined {
        const response = this.readyGitStatus();
        return response === undefined ? undefined : gitStatusFilesByPath(response);
      }

      /** section-API: stage one item's own file — the same `doorstop.git-stage`
       *  operation with `[item.path]`; the shared run dispatch narrates the uid.
       *  Shared by the row's `git add` span and the palette's Stage button. */
      stageItem(item: ItemRecord): void {
        const controller = this.controller;
        if (controller === undefined || controller.runInProgress !== undefined) return;
        void controller.runGitStage([item.path], `Git: stage ${item.uid}`);
      }

      /** section-API: unstage one item's own file — the `doorstop.git-unstage`
       *  inverse with `[item.path]`; the shared run dispatch narrates the uid.
       *  Shared by the row's minus span and the palette's Unstage button. The
       *  guard mirrors {@link stageItem}: a run already in flight must never be
       *  overlapped (the disabled states cover pointer clicks; this covers
       *  every call path). */
      unstageItem(item: ItemRecord): void {
        const controller = this.controller;
        if (controller === undefined || controller.runInProgress !== undefined) return;
        void controller.runGitUnstage([item.path], `Git: unstage ${item.uid}`);
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

      /** section-API: insert an Ask-agent prompt and close the menu. */
      insertPrompt(text: string): void {
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
      runDoorstop(
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

      /** section-API: the currently selected item, resolved against the
       *  loaded index. */
      selectedItem(): ItemRecord | undefined {
        const result = this.result;
        const uid = this.selectedUid;
        if (result === undefined || uid === undefined) return undefined;
        return result.index.byUid.get(uid);
      }

      /** section-API: the shared state chip (item rows + detail head). The
       *  renderer is a free function in `sections/item-list.ts`; this delegate
       *  lets detail-pane reach it through the host, keeping the runtime import
       *  graph one-way (coordinator → sections). */
      renderStateChip(key: ItemStateKey): TemplateResult {
        return renderStateChipTemplate(key);
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
