// ---------------------------------------------------------------------------
// Opendoor browser contributions (integration chain F): the actions,
// workspace panel, and workspace label that `pi-web-plugin.ts` exposes via
// `createOpendoorBrowserContributions(runtimePluginId, html, svg)` — the
// thin entry calls this factory, exactly like OpenSE's
// createOpenseBrowserContributions. All logic lives in the reviewed modules:
// the per-workspace controller registry + load job (doorstop-panel.ts), the
// Lit body element (doorstop-panel-elements.ts), and the model/state chain.
//
// This module only:
//   1. instantiates the registry + registers the panel elements,
//   2. wires the panel contribution (render mirrors the controller's render
//      inputs into the body element's properties — state flow documented in
//      doorstop-panel-elements.ts),
//   3. wires the palette actions (view + refresh), and
//   4. wires the informational workspace label (§7.4) with the documented
//      async-cache idiom.
//
// The validate / publish / review / clear / edit / link / unlink Doorstop
// operations are deliberately NOT palette actions: they need the rendered
// panel — either the workspace's backend surface (`context.backend.request`)
// or, unpaired, the panel terminal (`context.terminal`), which only exists on
// the `WorkspacePanelContext` of a rendered panel (the palette action
// callback context has neither). So they stay as panel-toolbar/action-row
// buttons, dispatched by doorstop-panel-elements via the Phase D step 9
// runDoorstop dispatcher.
// ---------------------------------------------------------------------------

import type {
  HtmlTemplateTag,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  WorkspaceLabelContribution,
  WorkspaceLabelContext,
  WorkspaceLabelItem,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import { html, svg } from "lit";
import type { DoorstopIndex } from "./doorstop-contract.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DoorstopWorkspaceRegistry, loadDoorstopWorkspace } from "./doorstop-panel.js";
import { defineDoorstopPanelElements } from "./doorstop-panel-elements.js";

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
 */
export function createOpendoorBrowserContributions(
  runtimePluginId: string,
  _html: HtmlTemplateTag,
  _svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${DOORSTOP_PANEL_LOCAL_ID}`;
  const registry = new DoorstopWorkspaceRegistry();
  const labelCache = new DoorstopLabelCache();
  defineDoorstopPanelElements();
  return {
    actions: createDoorstopActions(panelId),
    workspacePanels: [createDoorstopPanel(registry)],
    workspaceLabels: [createDoorstopLabel(labelCache)],
  };
}

function createDoorstopActions(panelId: string): PluginAction[] {
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
      run: (context: PluginRuntimeContext) => { context.selectMainView(panelId); },
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
      run: (context: PluginRuntimeContext) => { context.refreshWorkspacePanels(panelId); },
    },
  ];
}

function createDoorstopPanel(registry: DoorstopWorkspaceRegistry): WorkspacePanelContribution {
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
    order: 60,
    // The panel is always visible (paired or unpaired): when the workspace
    // is opendoor-owned the run actions use the backend, otherwise the
    // terminal fallback keeps every action working; the discovery-based
    // empty state carries the "no documents" story (feature spec §7.1).
    visible: () => true,
    onInvalidate: (context) => registry.invalidate(context),
    render: (context) => renderDoorstopPanel(registry, context),
  };
}

/**
 * Panel render wiring (state flow documented in doorstop-panel-elements.ts):
 * the host template drives the single body element, mirroring the workspace
 * controller's render inputs into its reactive properties. The controller
 * object itself is committed for actions/lifecycle only — its identity never
 * changes for a workspace, so the *changed* mirrored values below are what
 * re-render the shadow trees (the controller pushes `requestRender` through
 * its current context handle on every state mutation, and the host re-invokes
 * this function). Every property of the `DoorstopPanelBodyElement` surface is
 * wired here.
 */
function renderDoorstopPanel(registry: DoorstopWorkspaceRegistry, context: WorkspacePanelContext) {
  const controller = registry.for(context);
  return html`
    <pi-web-opendoor-panel-body
      .controller=${controller}
      .context=${context}
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
    ></pi-web-opendoor-panel-body>
  `;
}

function createDoorstopLabel(labelCache: DoorstopLabelCache): WorkspaceLabelContribution {
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
  items(context: WorkspaceLabelContext): WorkspaceLabelItem[] {
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
  visible(context: WorkspaceLabelContext): boolean {
    const entry = this.entries.get(doorstopLabelKey(context));
    if (entry === undefined || entry.result === undefined) return false;
    return entry.result.index.documents.length > 0;
  }

  /** Kick off one in-browser load job; on landing, cache the result, bump
   *  the LRU, and ask the host to re-render the label. A failed load drops
   *  the entry so the next items() (a cache miss) retries — never thrown
   *  from a synchronous callback. */
  private startLoad(context: WorkspaceLabelContext, key: string, entry: DoorstopLabelEntry): void {
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

function doorstopLabelKey(context: WorkspaceLabelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}
