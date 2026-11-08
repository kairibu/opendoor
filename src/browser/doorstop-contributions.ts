// ---------------------------------------------------------------------------
// Opendoor browser contributions (integration chain F): the actions,
// workspace panel, workspace label, and session-list row label that
// `pi-web-plugin.ts` exposes via
// `createOpendoorBrowserContributions(runtimePluginId, html, svg)` — the
// thin entry calls this factory, exactly like OpenSE's
// createOpenseBrowserContributions. All logic lives in the reviewed modules:
// the per-workspace controller registry + load job (doorstop-panel.ts), the
// Lit body element (doorstop-panel-element.ts), and the model/state chain.
//
// This module only:
//   1. instantiates the registry + registers the panel elements,
//   2. wires the panel contribution (render mirrors the controller's render
//      inputs into the body element's properties — state flow documented in
//      doorstop-panel-element.ts),
//   3. wires the palette actions (view + refresh),
//   4. wires the informational workspace label (§7.4) with the documented
//      async-cache idiom, and
//   5. wires the session-list row label (relay
//      `opendoor-session-metadata-labels`) that reopens the Requirements tab
//      from a session row carrying public opendoor metadata.
//
// The validate / publish / review / clear / edit / link / unlink Doorstop
// operations are deliberately NOT palette actions: they need the rendered
// panel — either the workspace's paired server surface
// (`context.peer.request`) or, unpaired, the panel terminal
// (`context.terminal`), which only exists on the `WorkspacePanelContextV5` of
// a rendered panel (the palette action callback context has neither). So they
// stay as panel-toolbar/action-row buttons, dispatched by
// doorstop-panel-element via the Phase D step 9 runDoorstop dispatcher.
// ---------------------------------------------------------------------------

import type {
  HtmlTemplateTag,
  PluginActionV5,
  PluginContributionsV5,
  PluginRuntimeContextV5,
  SvgTemplateTag,
  WorkspaceLabelContributionV5,
  WorkspaceLabelContextV5,
  WorkspaceLabelItem,
  WorkspacePanelContextV5,
  WorkspacePanelContributionV5,
} from "@jmfederico/pi-web/plugin-api";
import { html, svg } from "lit";
import type { DoorstopIndex } from "../doorstop-contract.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DoorstopWorkspaceRegistry, loadDoorstopWorkspace } from "./doorstop-panel.js";
import { readPanelNavigationQuery } from "./doorstop-panel-navigation.js";
import { createDoorstopSessionLabel } from "./doorstop-session-labels.js";
import { defineDoorstopPanelElements } from "./doorstop-panel-elements.js";
import type { DoorstopMarkdownHolder } from "./doorstop-markdown.js";

const DOORSTOP_PANEL_LOCAL_ID = "workspace.doorstop";

/** Keep a few recent workspaces' label counts so labels survive workspace
 *  switches without re-running discovery (mirrors the panel registry's LRU
 *  bound, §11 fact 11). */
const DOORSTOP_LABEL_STATE_LIMIT = 8;

/**
 * Browser contribution factory: actions + the always-visible Requirements
 * panel + the informational status label. `runtimePluginId` prefixes the
 * panel and action targets so qualified contribution references stay
 * host-unique on federated machines.
 *
 * `html`/`svg` are accepted-but-ignored (plan §3.3): the panel renders with
 * this module's own lit tags, but the parameter list is frozen so a single
 * revert restores the pre-refactor host-tag renderer. A plugin-lit
 * TemplateResult renders fine under the host's lit-html — template results
 * are structural objects, not tied to a lit copy.
 *
 * `markdown` is the late-bound holder for the host's `markdown-rendering@1`
 * renderer (plan-piweb-1-202611-1 §2.1, decision D1 in doorstop-markdown.ts):
 * `start()` fills it after this factory has already run, and the panel render
 * below mirrors its current value onto the body element.
 */
// Every callback below takes a v5 context variant (pi-web 1.202610.8):
// the same context shape it always read plus `catalog`/`backend` — neither
// is consulted anywhere in this module, so behavior is byte-identical while
// the host's v5 callback dispatch typechecks against `PiWebPluginV5`.
export function createOpendoorBrowserContributions(
  runtimePluginId: string,
  _html: HtmlTemplateTag,
  _svg: SvgTemplateTag,
  markdown: DoorstopMarkdownHolder,
): PluginContributionsV5 {
  const panelId = `${runtimePluginId}:${DOORSTOP_PANEL_LOCAL_ID}`;
  const registry = new DoorstopWorkspaceRegistry();
  const labelCache = new DoorstopLabelCache();
  defineDoorstopPanelElements();
  return {
    actions: createDoorstopActions(panelId),
    workspacePanels: [createDoorstopPanel(registry, markdown)],
    workspaceLabels: [createDoorstopLabel(labelCache)],
    sessionLabels: [createDoorstopSessionLabel(runtimePluginId)],
  };
}

function createDoorstopActions(panelId: string): PluginActionV5[] {
  return [
    {
      id: "view.doorstop",
      title: "Go to Requirements",
      // Shortcut-collision check (feature spec §9.5): mod+7 is free in the
      // current keybinding map. Claimed today: core mod+1/2/4 (view.chat/
      // files/terminal), git mod+3 (view.git) plus its mod+shift+g push,
      // opense mod+6 (view.opense) plus its mod+shift+m, and the mod+k /
      // mod+, / mod+enter / mod+. / mod+g * / mod+shift+f / mod+shift+r
      // sequences. mod+7 avoids every one of those.
      shortcut: "mod+7",
      group: "Navigation",
      // Enabled unconditionally: the Requirements panel is useful for every
      // workspace (paired or unpaired — it needs no owned provider).
      run: (context: PluginRuntimeContextV5) => { context.selectWorkspaceTool(panelId); },
    },
    {
      id: "workspace.refresh-doorstop",
      title: "Refresh Requirements",
      // Same collision-check result as above: mod+shift+d is unclaimed (the
      // map's other mod+shift combos are f/g/r, plus opense's mod+shift+m).
      shortcut: "mod+shift+d",
      group: "Workspace",
      // Re-run discovery + load for the selected workspace's Requirements
      // panel (context.refreshWorkspacePanels routes the panel's
      // onInvalidate → registry.invalidate).
      run: (context: PluginRuntimeContextV5) => { context.refreshWorkspacePanels(panelId); },
    },
  ];
}

function createDoorstopPanel(registry: DoorstopWorkspaceRegistry, markdown: DoorstopMarkdownHolder): WorkspacePanelContributionV5 {
  return {
    id: DOORSTOP_PANEL_LOCAL_ID,
    title: "Requirements",
    // Door/archive icon (currentColor): a filing cabinet with the doorstop
    // checklist mark — the panel title icon, created with this module's own
    // lit `svg` tag.
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"></path>
        <rect width="8" height="4" x="8" y="3" rx="1"></rect>
        <path d="m9 12 2 2 4-4"></path>
      </svg>
    `,
    // Plan Phase C step C3 follow-up — order 5: the host's chat-file-link
    // dispatch (resolveWorkspaceFileOpen) opens the FIRST ACCEPTING panel,
    // iterating panels by `order` ascending, and the bundled Files panel is
    // order 10 and answers `{ file: path }` for EVERY path unconditionally —
    // at order 60 this panel's `fileOpenQuery` was never consulted at all.
    // Sitting below 10 is the only host-supported way to claim doorstop item
    // files for the Requirements panel; the accepted consequence is that the
    // Requirements tab precedes Files in the workspace tab bar.
    order: 5,
    // The panel is always visible (paired or unpaired): when the workspace
    // is opendoor-owned the run actions use the backend, otherwise the
    // terminal fallback keeps every action working; the discovery-based
    // empty state carries the "no documents" story (feature spec §7.1).
    visible: () => true,
    // Plan Phase C step C1 — typed invalidation (browser API v4, unchanged
    // on v5): declare the fixed workspace resources whose automatic invalidations this panel
    // receives. With `workspace.files` declared, the host calls onInvalidate
    // not only for the manual Refresh action (refreshWorkspacePanels) but
    // also when workspace files change (`reason: "mutation"` — e.g. the
    // review-commit pipeline's commits landing, or any other plugin's file
    // writes) and when agent work finishes in the workspace (`reason:
    // "agent-activity"` — an agent editing doorstop documents refreshes the
    // panel without a manual Refresh). The reason is forwarded to the
    // registry, which rescans unconditionally (see
    // DoorstopWorkspaceRegistry.invalidate).
    invalidationResources: ["workspace.files"],
    onInvalidate: (context, invalidation) => registry.invalidate(context, invalidation),
    // Plan Phase C step C3 — chat file links: when the host resolves a
    // Markdown link to a workspace-relative path, this hook answers with the
    // panel's navigation query IF the panel owns the path (its last landed
    // discovery indexed it as an item file), so the chat opens the item IN
    // the Requirements panel instead of the Files fallback. Synchronous and
    // side-effect-free: it answers purely from the registry's recorded index
    // (never loads, never renders); unknown paths and pre-first-load panels
    // return undefined (the host asks the next panel / serves Files).
    fileOpenQuery: (context, path) => registry.fileOpenQuery(context, path),
    render: (context) => renderDoorstopPanel(registry, context, markdown),
  };
}

/**
 * Panel render wiring (state flow documented in doorstop-panel-element.ts):
 * the host template drives the single body element, mirroring the workspace
 * controller's render inputs into its reactive properties. The controller
 * object itself is committed for actions/lifecycle only — its identity never
 * changes for a workspace, so the *changed* mirrored values below are what
 * re-render the shadow trees (the controller pushes `requestRender` through
 * its current context handle on every state mutation, and the host re-invokes
 * this function). Every property of the `DoorstopPanelBodyElement` surface is
 * wired here.
 */
function renderDoorstopPanel(
  registry: DoorstopWorkspaceRegistry,
  context: WorkspacePanelContextV5,
  markdown: DoorstopMarkdownHolder,
) {
  const controller = registry.for(context);
  // Plan Phase C step C2 — deep links: apply the contribution-scoped URL query
  // (uid/doc/filter/search, plus the C3 chat-link `file` key) to the controller
  // BEFORE the property mirror below,
  // so a back/forward navigation re-render restores the linked selection in
  // the same render. Idempotent (values compared first): a user interaction's
  // re-render — the query its own setter just wrote — applies nothing.
  //
  // ABSENT navigation (older hosts, harnesses without one) applies NOTHING:
  // the controller is then the only state owner, and applying an empty query
  // would clear live user selections on every render.
  if (context.navigation !== undefined) {
    controller.applyNavigationQuery(readPanelNavigationQuery(context.navigation));
  }
  // Plan Phase C step C3 — record the chat file-open index from every LANDED
  // result (renders happen after the load lands too — the controller pushes
  // requestRender on landing — so the index mirrors the last landed discovery
  // without a dedicated load): fileOpenQuery answers from it synchronously.
  if (controller.result !== undefined) {
    registry.recordFileOpenIndex(context, controller.result);
  }
  return html`
    <pi-web-opendoor-panel-body
      .controller=${controller}
      .context=${context}
      .markdownRenderer=${markdown.renderer}
      .result=${controller.result}
      .loading=${controller.loading}
      .stale=${controller.stale}
      .error=${controller.error}
      .selectedUid=${controller.selectedUid}
      .selectedDocumentPrefix=${controller.selectedDocumentPrefix}
      .stateFilter=${controller.stateFilter}
      .search=${controller.search}
      .lastRun=${controller.lastRun}
      .runInProgress=${controller.runInProgress}
      .baselineVersion=${controller.baselineVersion}
      .baselineInFlight=${controller.baselineInFlight}
      .gitStatusView=${controller.gitStatusView}
      .gitStatusInFlight=${controller.gitStatusInFlight}
    ></pi-web-opendoor-panel-body>
  `;
}

function createDoorstopLabel(labelCache: DoorstopLabelCache): WorkspaceLabelContributionV5 {
  return {
    id: "doorstop-status",
    order: 10,
    visible: (context) => labelCache.visible(context),
    items: (context) => labelCache.items(context),
  };
}

// --- workspace label (§7.4) -------------------------------------------------
//
// One informational status label (e.g. `REQ 42 · 3 suspect · 5 unreviewed`)
// in the workspace list / status bar, following the documented async-cache
// label pattern: `items()` and `visible()` are SYNCHRONOUS, so they can only
// return cached counts; the first call kicks off an in-browser load job via
// `context.files`, and when it lands the cache calls `host.requestRender()`
// so the host re-invokes `items()` with fresh data.
//
// A label item cannot open the panel — labels only support text/link/render
// items, and `render` items cannot invoke a navigation side effect (they are
// pure template renderers). So the label is purely informational: it reports
// the requirement-health counts and offers no link. Opening the panel is the
// `view.doorstop` palette action / the Requirements workspace tab.

/** One workspace's cached label state: the load job plus the landed result
 *  (undefined while the load is in flight). */
interface DoorstopLabelEntry {
  result: DoorstopWorkspaceResult | undefined;
}

/**
 * Bounded async cache for the workspace status label. Keyed by
 * machine.id + projectId + workspace.id (mirrors the panel registry's key),
 * LRU-bounded to DOORSTOP_LABEL_STATE_LIMIT entries. `items()`/`visible()`
 * are synchronous reads of cached counts; a cache miss kicks off the load and
 * returns nothing this cycle; a landed result triggers `host.requestRender()`
 * so the label appears as soon as the counts are known.
 *
 * The label runs its own load job rather than reading the panel registry's
 * controller result for the same key — deliberately: labels render on
 * workspaces whose Requirements panel was never opened (the registry only
 * loads a workspace once its panel renders), and the label must never depend
 * on the panel controllers' lifecycle or LRU eviction (the two tails move
 * independently). Both caches share the same key and the same small LRU
 * bound, so the duplication is bounded: at worst one workspace is loaded
 * twice across the two features, and each load is cheap (discovery + item
 * reads over `context.files`). Keeping the label cache independent is what
 * lets `items()`/`visible()` stay pure synchronous reads.
 */
class DoorstopLabelCache {
  private readonly entries = new Map<string, DoorstopLabelEntry>();

  /** Synchronous: cached counts for the workspace, or nothing. A cache miss
   *  (or a still-running load) yields no items this cycle — the load's
   *  completion re-renders the label. */
  items(context: WorkspaceLabelContextV5): WorkspaceLabelItem[] {
    const key = doorstopLabelKey(context);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { result: undefined };
      this.entries.set(key, entry);
      // Enforce the LRU bound at INSERT time too — not only when a load
      // lands — so a sweep across many workspaces (or loads that fail, see
      // startLoad) can never grow the map past the limit. The fresh entry is
      // the tail, so eviction drops the oldest cached workspace.
      this.evictOldest();
      this.startLoad(context, key, entry);
    } else {
      // Cache hit: move the entry to the LRU tail, so eviction order follows
      // access time rather than each load's landing time (mirrors the panel
      // registry's for() bump on a cache hit).
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    const result = entry.result;
    // Load still in flight (or failed before producing a result): render
    // nothing this cycle — we never show stale/absent counts.
    if (result === undefined) return [];
    const index = result.index;
    // No documents → the label has nothing to say (visible() also gates on
    // this); still return [] so an empty workspace shows no label.
    if (index.documents.length === 0) return [];
    return [
      {
        type: "text",
        text: formatCounts(index),
        title: "Doorstop requirements — informational",
      },
    ];
  }

  /** Synchronous: show the label only once discovery found documents. */
  visible(context: WorkspaceLabelContextV5): boolean {
    const entry = this.entries.get(doorstopLabelKey(context));
    if (entry === undefined || entry.result === undefined) return false;
    return entry.result.index.documents.length > 0;
  }

  /** Kick off one in-browser load job; on landing, cache the result, bump
   *  the LRU, and ask the host to re-render the label. A failed load drops
   *  the entry so the next items() (a cache miss) retries — never thrown
   *  from a synchronous callback. */
  private startLoad(context: WorkspaceLabelContextV5, key: string, entry: DoorstopLabelEntry): void {
    loadDoorstopWorkspace(context.files)
      .then((result) => {
        // Re-check the entry is still the cached one for this key (the LRU
        // may have evicted and re-created a fresh entry in the interim).
        if (this.entries.get(key) !== entry) return;
        entry.result = result;
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.evictOldest();
        context.host.requestRender();
      })
      .catch(() => {
        // A failed load never throws through a synchronous label callback.
        // Drop the entry (label stays hidden this cycle) so the NEXT items()
        // call sees a cache miss and retries: one transient host/files
        // failure must not hide the label for the rest of the session. No
        // requestRender here — nothing new to render, and re-rendering would
        // immediately retry a load that just failed (a persistently broken
        // workspace would spin).
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
  }

  private evictOldest(): void {
    if (this.entries.size <= DOORSTOP_LABEL_STATE_LIMIT) return;
    const key = this.entries.keys().next().value;
    if (key !== undefined) this.entries.delete(key);
  }
}

/** `REQ <N> · <n> suspect · <n> unreviewed`, omitting the zero parts (the
 *  `REQ <N>` total is always shown — visible() guarantees documents exist). */
function formatCounts(index: DoorstopIndex): string {
  const parts: string[] = [`REQ ${index.counts.items}`];
  if (index.counts.suspectLinks > 0) parts.push(`${index.counts.suspectLinks} suspect`);
  if (index.counts.unreviewedChanges > 0) parts.push(`${index.counts.unreviewedChanges} unreviewed`);
  return parts.join(" · ");
}

function doorstopLabelKey(context: WorkspaceLabelContextV5): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}
