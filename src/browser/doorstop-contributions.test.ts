// @vitest-environment happy-dom
//
// Integration-factory unit tests (integration chain F): the glue
// doorstop-contributions.ts introduced — the contribution shape of the
// actions/panel/label, the panel render wiring that mirrors every
// DoorstopPanelBodyElement property from the workspace controller, and the
// DoorstopLabelCache async choreography (miss → load → requestRender, the
// in-flight-entry guard against stale landings, LRU eviction at insert AND
// landing, and failed-load retry). The label's load boundary
// (loadDoorstopWorkspace) is mocked to a vi.fn whose DEFAULT implementation
// delegates to the real pipeline over the shared in-memory files fake, so
// plain flows stay end-to-end and the failure/deferred/LRU cases get
// deterministic control. Structural wiring for the host-facing entry itself
// lives in pi-web-plugin.test.ts; the controller/element internals are
// covered by doorstop-panel.test.ts / doorstop-panel-element.test.ts.

import { html, svg, type TemplateResult } from "lit";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  PluginContributions,
  Workspace,
  WorkspaceLabelContext,
  WorkspaceLabelItem,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { DoorstopCounts } from "../doorstop-contract.js";
import { buildDoorstopIndex } from "../doorstop-model.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../doorstop-settings.js";
import { loadDoorstopWorkspace } from "./doorstop-panel.js";
import type { DoorstopWorkspaceController } from "./doorstop-panel-controller.js";
import { createOpendoorBrowserContributions } from "./doorstop-contributions.js";
import { createFakeFiles, dirEntry, fileEntry, text, tree, type FakeWorkspaceFiles } from "../test-support.js";
import { doorstopWorkspace, flushAll, makeDocument, makeWorkspace, panelContext } from "../test-fixtures.js";

// The label cache's LRU bound (DOORSTOP_LABEL_STATE_LIMIT in
// doorstop-contributions.ts, deliberately module-private); tests pin the
// eviction behavior against the same constant the production code uses.
const LABEL_LIMIT = 8;

vi.mock("./doorstop-panel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doorstop-panel.js")>();
  return {
    ...actual,
    loadDoorstopWorkspace: vi.fn(),
  };
});

const loadMock = vi.mocked(loadDoorstopWorkspace);

/** The REAL load job, captured for the default mock implementation so plain
 *  label flows run the genuine discovery → model pipeline over the fake. */
let realLoad: typeof loadDoorstopWorkspace;

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("./doorstop-panel.js")>("./doorstop-panel.js");
  realLoad = actual.loadDoorstopWorkspace;
});

beforeEach(() => {
  loadMock.mockReset();
  loadMock.mockImplementation((files) => realLoad(files));
});

// --- small real-shape fixtures -------------------------------------------------

/** A real in-memory workspace with one REQ document and one item
 *  (REQ0001) — enough for the genuine discovery → load pipeline to land a
 *  non-empty result. */
function docFiles(): FakeWorkspaceFiles {
  return createFakeFiles({
    trees: {
      "": tree([dirEntry("reqs", "reqs")]),
      "reqs": tree([
        fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
        fileEntry("REQ0001.yml", "reqs/REQ0001.yml"),
      ]),
    },
    reads: {
      "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4\n  sep: ''\n  parent: ''"),
      "reqs/REQ0001.yml": text("text: The system shall do X."),
    },
  });
}

/** A workspace with no Doorstop documents at all. */
function emptyFiles(): FakeWorkspaceFiles {
  return createFakeFiles({ trees: { "": tree([]) } });
}

/** A structurally complete DoorstopWorkspaceResult whose counts are
 *  overridden to the given values — the label only reads
 *  `documents.length` + the three count fields, so this pins the label
 *  formatting deterministically without depending on state-chain details
 *  (those are covered by doorstop-state.test.ts). */
function makeResult(counts: Partial<DoorstopCounts> = {}): DoorstopWorkspaceResult {
  const index = buildDoorstopIndex([makeDocument()], [], [], new Set());
  return { index: { ...index, counts: { ...index.counts, ...counts } }, settings: DEFAULT_OPENDOOR_SETTINGS };
}

// --- helpers -----------------------------------------------------------------

function createContributions(runtimePluginId = "opendoor") {
  return createOpendoorBrowserContributions(runtimePluginId, html, svg);
}

/** The label contribution's two synchronous callbacks, guarded to be
 *  present (the factory always sets both). */
function requireLabel(contributions: PluginContributions): {
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem[];
  visible: (context: WorkspaceLabelContext) => boolean;
} {
  const label = contributions.workspaceLabels?.[0];
  if (label === undefined) throw new Error("Expected opendoor label contribution");
  const { items, visible } = label;
  if (visible === undefined) throw new Error("Expected the label contribution to provide visible()");
  return { items, visible };
}

/** One label context wrapping the fake files adapter plus a requestRender
 *  spy — the cache's landing path fires this (via the context host). */
function labelContext(
  fake: FakeWorkspaceFiles,
  workspace: Workspace = doorstopWorkspace,
): { context: WorkspaceLabelContext; requestRender: Mock } {
  const requestRender = vi.fn();
  const context: WorkspaceLabelContext = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace,
    files: fake.files,
    host: { requestRender },
  };
  return { context, requestRender };
}

// `flushAll()` (from test-fixtures) waits one macrotask, which runs after all
// microtasks, so it deterministically lets any number of landed loads run.

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The property names of the host template's `.prop=${value}` bindings, in
 *  binding order. */
function bindingNames(template: TemplateResult): string[] {
  const names: string[] = [];
  for (const part of template.strings) {
    const match = /\.([A-Za-z][A-Za-z0-9]*)=$/.exec(part);
    if (match !== null) names.push(match[1] ?? "");
  }
  return names;
}

// --- contribution shape --------------------------------------------------------

describe("createOpendoorBrowserContributions (contribution shape)", () => {
  it("contributes the panel, both actions, and the status label with the reviewed ids/order", () => {
    const contributions = createContributions();
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected opendoor panel contribution");
    requireLabel(contributions);

    // The action ids (unqualified local ids; qualification happens through
    // the panel target, asserted in pi-web-plugin.test.ts).
    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.doorstop", "workspace.refresh-doorstop"]);
    // Exactly one panel, one label — nothing extra leaked into the host.
    expect(contributions.workspacePanels).toHaveLength(1);
    expect(contributions.workspaceLabels).toHaveLength(1);

    expect(panel.id).toBe("workspace.doorstop");
    expect(panel.title).toBe("Requirements");
    expect(panel.order).toBe(60);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.({} as WorkspacePanelContext)).toBe(true);
    expect(typeof panel.onInvalidate).toBe("function");
    expect(typeof panel.render).toBe("function");

    const label = contributions.workspaceLabels?.[0];
    if (label === undefined) throw new Error("Expected opendoor label contribution");
    expect(label.id).toBe("doorstop-status");
    expect(label.order).toBe(10);
    expect(typeof label.visible).toBe("function");
    expect(typeof label.items).toBe("function");
  });
});

// --- panel render wiring ---------------------------------------------------------

describe("panel render wiring", () => {
  it("mirrors every DoorstopPanelBodyElement property from the workspace controller", async () => {
    const contributions = createContributions();
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected opendoor panel contribution");

    const { context, requestRender } = panelContext({ fake: docFiles() });
    const rendered = panel.render(context);

    // The render function hands the body element the per-workspace
    // controller instance (property 0); drive that instance through its real
    // connect path so the load lands against the fake files.
    const controller = rendered.values[0] as DoorstopWorkspaceController | undefined;
    if (controller === undefined) throw new Error("Expected the render to bind the controller");
    expect(rendered.values[1]).toBe(context);
    controller.hostConnected();
    await flushAll();
    expect(requestRender).toHaveBeenCalled();
    if (controller.result === undefined) throw new Error("Expected the controller load to land");
    expect(controller.result.index.byUid.has("REQ0001")).toBe(true);

    // Mutate every controller field the body element reads.
    controller.selectUid("REQ0001");
    controller.selectDocument("REQ");
    controller.setStateFilter(undefined);
    controller.setSearch("allocated");
    // The run-state fields (Phase D): a run in flight and a committed view.
    controller.beginRun("Doorstop: validate");
    controller.commitRun({
      op: "validate",
      title: "Doorstop: validate",
      status: "ok",
      exitCode: 0,
      signal: null,
      stdout: "Validated 1 item.",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 12,
      at: 7,
    });

    const updated = panel.render(context);
    const expectedNames = [
      "controller",
      "context",
      "result",
      "loading",
      "stale",
      "error",
      "selectedUid",
      "selectedDocumentPrefix",
      "stateFilter",
      "search",
      "lastRun",
      "runInProgress",
      // Phase D step 15: the baseline-cache state the render wiring mirrors.
      "baselineVersion",
      "baselineInFlight",
      // Phase D step 16: the git-status strip state the render wiring mirrors.
      "gitStatusView",
      "gitStatusInFlight",
    ];
    expect(bindingNames(updated)).toEqual(expectedNames);
    expect(updated.values).toHaveLength(expectedNames.length);

    // Each binding mirrors the controller's current value — identity for
    // object fields, value equality for the primitives.
    expect(updated.values[0]).toBe(controller);
    expect(updated.values[1]).toBe(context);
    expect(updated.values[2]).toBe(controller.result);
    expect(updated.values[3]).toBe(controller.loading);
    expect(updated.values[4]).toBe(controller.stale);
    expect(updated.values[5]).toBe(controller.error);
    expect(updated.values[6]).toBe(controller.selectedUid);
    expect(updated.values[7]).toBe(controller.selectedDocumentPrefix);
    expect(updated.values[8]).toBe(controller.stateFilter);
    expect(updated.values[9]).toBe(controller.search);
    expect(updated.values[9]).toBe("allocated");
    // The Phase D additions mirror by identity too.
    expect(updated.values[10]).toBe(controller.lastRun);
    expect(updated.values[11]).toBe(controller.runInProgress);
    expect(updated.values[11]).toBe("Doorstop: validate");
    // The baseline cache state mirrors as counters/flag (plain values).
    expect(updated.values[12]).toBe(controller.baselineVersion);
    expect(updated.values[12]).toBe(0);
    expect(updated.values[13]).toBe(controller.baselineInFlight);
    expect(updated.values[13]).toBeUndefined();
    // The Phase D step 16 git-status strip state mirrors by identity / flag.
    expect(updated.values[14]).toBe(controller.gitStatusView);
    expect(updated.values[14]).toBeUndefined();
    expect(updated.values[15]).toBe(controller.gitStatusInFlight);
    expect(updated.values[15]).toBe(false);
  });
});

// --- workspace label cache choreography ---------------------------------------------

describe("workspace status label cache", () => {
  it("shows nothing while the first load is in flight and does not stack a second load", async () => {
    const { visible, items } = requireLabel(createContributions());
    const { context, requestRender } = labelContext(docFiles());
    const first = deferred<DoorstopWorkspaceResult>();
    loadMock.mockImplementationOnce(() => first.promise);

    // Miss → kick off the load; synchronous cycle renders nothing.
    expect(visible(context)).toBe(false);
    expect(items(context)).toEqual([]);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock.mock.calls[0]?.[0]).toBe(context.files);

    // The host may re-invoke items()/visible() while the load runs (its own
    // render schedule): still no items, and no second load is stacked.
    expect(visible(context)).toBe(false);
    expect(items(context)).toEqual([]);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(requestRender).not.toHaveBeenCalled();

    // Landing caches the result, bumps the LRU, and asks the host to
    // re-render — after which the label appears.
    first.resolve(makeResult({ items: 42, suspectLinks: 3, unreviewedChanges: 5 }));
    await flushAll();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(visible(context)).toBe(true);
    expect(items(context)).toEqual([
      {
        type: "text",
        text: "REQ 42 · 3 suspect · 5 unreviewed",
        title: "Doorstop requirements — informational",
      },
    ]);
    // Landed entry is cached: no further load on the next read.
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("formats the counts, omitting the zero parts", async () => {
    const { visible, items } = requireLabel(createContributions());

    // All-zero extras → just the total.
    loadMock.mockImplementationOnce(() => Promise.resolve(makeResult({ items: 3 })));
    const { context } = labelContext(docFiles());
    items(context);
    await flushAll();
    expect(visible(context)).toBe(true);
    expect(items(context)).toEqual([
      { type: "text", text: "REQ 3", title: "Doorstop requirements — informational" },
    ]);

    // Only the unreviewed part present.
    loadMock.mockImplementationOnce(() => Promise.resolve(makeResult({ items: 7, unreviewedChanges: 2 })));
    const { context: context2 } = labelContext(docFiles(), makeWorkspace("workspace-2"));
    items(context2);
    await flushAll();
    expect(items(context2)).toEqual([
      { type: "text", text: "REQ 7 · 2 unreviewed", title: "Doorstop requirements — informational" },
    ]);

    // Only the suspect part present.
    loadMock.mockImplementationOnce(() => Promise.resolve(makeResult({ items: 9, suspectLinks: 4 })));
    const { context: context3 } = labelContext(docFiles(), makeWorkspace("workspace-3"));
    items(context3);
    await flushAll();
    expect(items(context3)).toEqual([
      { type: "text", text: "REQ 9 · 4 suspect", title: "Doorstop requirements — informational" },
    ]);
  });

  it("renders no label for a workspace with no Doorstop documents (real discovery run)", async () => {
    const { visible, items } = requireLabel(createContributions());

    // Default mock implementation = the real discovery pipeline over the
    // empty workspace.
    const { context, requestRender } = labelContext(emptyFiles());
    expect(visible(context)).toBe(false);
    expect(items(context)).toEqual([]);
    await flushAll();
    expect(loadMock).toHaveBeenCalledTimes(1);
    // The landing re-renders, but the empty workspace still has nothing to say.
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(visible(context)).toBe(false);
    expect(items(context)).toEqual([]);
    // Cached (empty) result: repeated reads never re-run discovery.
    expect(items(context)).toEqual([]);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("drops a failed load so the next items() retries (no permanent hidden label)", async () => {
    const { visible, items } = requireLabel(createContributions());

    const { context, requestRender } = labelContext(docFiles());
    loadMock.mockRejectedValueOnce(new Error("federated reconnect dropped the files call"));

    // The transient failure hides the label for this cycle but never throws.
    expect(items(context)).toEqual([]);
    await flushAll();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(visible(context)).toBe(false);
    // Nothing new to render on a failure — and no re-render → no retry loop.
    expect(requestRender).not.toHaveBeenCalled();

    // The NEXT items() (a cache miss — the failed entry was dropped) retries
    // the load; when it lands the label appears.
    expect(items(context)).toEqual([]);
    expect(loadMock).toHaveBeenCalledTimes(2);
    await flushAll();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(visible(context)).toBe(true);
    expect(items(context)).toEqual([
      { type: "text", text: "REQ 1 · 1 unreviewed", title: "Doorstop requirements — informational" },
    ]);
  });

  it("keeps the LRU bounded at insert (not only at landing) and bumps entries on access", async () => {
    const { visible, items } = requireLabel(createContributions());

    // Real loads over the one-document workspace: every workspace gets a
    // visible label once its load lands.
    const contexts = Array.from({ length: LABEL_LIMIT + 1 }, (_, index) =>
      labelContext(docFiles(), makeWorkspace(`workspace-${String(index)}`)),
    );
    for (let index = 0; index < LABEL_LIMIT; index += 1) {
      items(contexts[index]!.context);
      await flushAll();
    }
    expect(loadMock).toHaveBeenCalledTimes(LABEL_LIMIT);
    for (let index = 0; index < LABEL_LIMIT; index += 1) {
      expect(visible(contexts[index]!.context)).toBe(true);
    }

    // Accessing workspace 0 moves it to the LRU tail (access-time ordering,
    // like the panel registry's for() bump).
    expect(items(contexts[0]!.context)).toHaveLength(1);

    // Inserting one more past the limit evicts the least-recently-used —
    // workspace 1 — synchronously at INSERT time: workspace 0 (bumped) and
    // workspace 8 (still in flight) must still be present right now, before
    // workspace 8's load has landed.
    const workspace8 = contexts[LABEL_LIMIT]!;
    items(workspace8.context);
    expect(visible(contexts[0]!.context)).toBe(true); // bumped tail survives
    expect(visible(contexts[1]!.context)).toBe(false); // evicted (oldest)
    expect(loadMock).toHaveBeenCalledTimes(LABEL_LIMIT + 1);

    // The evicted workspace's next read is a fresh cache miss → re-load.
    expect(items(contexts[1]!.context)).toEqual([]);
    expect(loadMock).toHaveBeenCalledTimes(LABEL_LIMIT + 2);

    // The ninth load lands and shows its label like any other.
    await flushAll();
    expect(visible(workspace8.context)).toBe(true);
  });

  it("drops a stale landing for an evicted-and-recreated entry (in-flight guard)", async () => {
    const { visible, items } = requireLabel(createContributions());

    const { context: contextA, requestRender: renderA } = labelContext(docFiles(), makeWorkspace("workspace-A"));
    const firstLoad = deferred<DoorstopWorkspaceResult>();
    loadMock.mockImplementationOnce(() => firstLoad.promise);

    // Workspace A starts a load that never lands yet.
    items(contextA);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // Eight more workspaces land, pushing A out of the LRU while its load is
    // still in flight (the 9th insert evicts A — the oldest entry).
    const fillers = Array.from({ length: LABEL_LIMIT }, (_, index) =>
      labelContext(docFiles(), makeWorkspace(`filler-${String(index)}`)),
    );
    for (const { context } of fillers) {
      items(context);
      await flushAll();
    }
    expect(loadMock).toHaveBeenCalledTimes(LABEL_LIMIT + 1);
    expect(renderA).not.toHaveBeenCalled(); // A's load never landed

    // A fresh read of A is a cache miss again: a new entry + new load land
    // (default = the real pipeline).
    items(contextA);
    expect(loadMock).toHaveBeenCalledTimes(LABEL_LIMIT + 2);
    await flushAll();
    expect(renderA).toHaveBeenCalledTimes(1);
    const freshText = items(contextA);
    expect(freshText).toEqual([
      { type: "text", text: "REQ 1 · 1 unreviewed", title: "Doorstop requirements — informational" },
    ]);

    // The ORIGINAL load finally lands — but it belongs to the evicted entry,
    // so the landing is dropped: no re-render, no clobbering of the fresh
    // result.
    renderA.mockClear();
    firstLoad.resolve(makeResult({ items: 999, suspectLinks: 1, unreviewedChanges: 1 }));
    await flushAll();
    expect(renderA).not.toHaveBeenCalled();
    expect(items(contextA)).toEqual(freshText);
    expect(visible(contextA)).toBe(true);
  });
});
