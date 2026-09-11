// @vitest-environment node
//
// Panel/controller unit tests (plan §5): DOM-free. Drive
// `DoorstopWorkspaceController` through a fake host (`{isConnected}` — the
// minimal `DoorstopWorkspaceHost` surface for the late-async-write guard, no
// addController/removeController needed since the panel drives the lifecycle
// directly) with injected fake load jobs for rejection and deferred-control
// cases, plus one genuine end-to-end `loadDoorstopWorkspace` run over the
// fake files adapter. Render notifications are asserted on the context
// host's `requestRender` — the controller routes updates through the CURRENT
// context handle, so the spy simply wraps the same `WorkspacePanelHost` it
// would call in the panel. The element/DOM wiring is covered by a later
// chain; these cover the controller's state logic and the load job with no
// DOM at all.

import { describe, expect, it, vi, type Mock } from "vitest";
import type { Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, DoorstopIndex, ItemRecord } from "./doorstop-contract.js";
import type { DoorstopBaselineResponse } from "./doorstop-backend-contract.js";
import { buildDoorstopIndex } from "./doorstop-model.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopLastRunView,
  type DoorstopWorkspaceHost,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";
import {
  DOORSTOP_WORKSPACE_STATE_LIMIT,
  DoorstopWorkspaceRegistry,
  isItemFile,
  loadDoorstopWorkspace,
  type DoorstopWorkspaceResult,
} from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";
import { createFakeFiles, dirEntry, fileEntry, text, tree, type FakeWorkspaceFiles } from "./test-support.js";

const doorstopWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

// --- small real-shape fixtures ---------------------------------------------------------

function makeDocument(overrides: Partial<DoorstopDocumentConfig> = {}): DoorstopDocumentConfig {
  return {
    directoryPath: overrides.directoryPath ?? "reqs",
    configPath: overrides.configPath ?? "reqs/.doorstop.yml",
    prefix: overrides.prefix ?? "REQ",
    digits: overrides.digits ?? 4,
    separator: overrides.separator ?? "",
    itemformat: overrides.itemformat ?? "yaml",
    extra: overrides.extra ?? {},
    ...(overrides.parentPrefix === undefined ? {} : { parentPrefix: overrides.parentPrefix }),
  };
}

function makeItem(uid: string, documentPrefix: string, overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    uid,
    documentPrefix,
    path: overrides.path ?? `${uid}.yml`,
    level: overrides.level ?? "1.0",
    active: overrides.active ?? true,
    derived: overrides.derived ?? false,
    normative: overrides.normative ?? true,
    text: overrides.text ?? "",
    ref: overrides.ref ?? "",
    links: overrides.links ?? [],
    reviewed: overrides.reviewed ?? null,
    attributes: overrides.attributes ?? {},
    raw: overrides.raw ?? {},
    stateKeys: overrides.stateKeys ?? [],
    ...(overrides.header === undefined ? {} : { header: overrides.header }),
    ...(overrides.references === undefined ? {} : { references: overrides.references }),
  };
}

/** A genuine index over the given items/documents (real build + state
 *  chains), so the controller's selection/filter paths run against the real
 *  shape instead of a stub that could drift from `DoorstopIndex`. */
function makeResult(
  items: ItemRecord[],
  documents: DoorstopDocumentConfig[] = [makeDocument()],
  diagnostics: DoorstopIndex["diagnostics"] = [],
): DoorstopWorkspaceResult {
  const index = buildDoorstopIndex(documents, items, diagnostics, new Set());
  computeItemStates(index);
  return { index, settings: DEFAULT_OPENDOOR_SETTINGS };
}

describe("DoorstopWorkspaceController (fake host, no DOM)", () => {
  it("kicks the first load on hostConnected and surfaces loading → result", async () => {
    let resolveJob: ((result: DoorstopWorkspaceResult) => void) | undefined;
    const job: DoorstopWorkspaceJob = () =>
      new Promise<DoorstopWorkspaceResult>((resolve) => {
        resolveJob = resolve;
      });
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, job);

    controller.hostConnected();
    // The load begins synchronously: loading is up and the host is notified
    // before any await.
    expect(controller.loading).toBe(true);
    expect(host.isConnected).toBe(true);
    expect(requestRender).toHaveBeenCalled();

    resolveJob?.(makeResult([makeItem("REQ0001", "REQ")]));
    await settle();
    expect(controller.loading).toBe(false);
    expect(controller.stale).toBe(false);
    expect(controller.error).toBeUndefined();
    expect(controller.result?.index.byUid.has("REQ0001")).toBe(true);
    expect(requestRender).toHaveBeenCalled();
  });

  it("reuses one in-flight job for re-entrant loads (no overlapping jobs)", async () => {
    let resolveJob: ((result: DoorstopWorkspaceResult) => void) | undefined;
    const job: DoorstopWorkspaceJob = () =>
      new Promise<DoorstopWorkspaceResult>((resolve) => {
        resolveJob = resolve;
      });
    const { context } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, job);

    controller.hostConnected();
    expect(controller.loading).toBe(true);

    // Refresh-button spam / invalidate during a run / switch-back all join
    // the running job instead of stacking new ones.
    const first = controller.load();
    const second = controller.load();
    expect(second).toBe(first);
    controller.hostConnected();
    expect(controller.loading).toBe(true);

    resolveJob?.(makeResult([]));
    await settle();
    expect(controller.loading).toBe(false);
    expect(controller.result?.index).toBeDefined();
  });

  it("marks the result stale during an invalidate load and keeps the old result until it lands", async () => {
    let currentJob: () => Promise<DoorstopWorkspaceResult> = () =>
      Promise.resolve(makeResult([makeItem("REQ0001", "REQ")]));
    const job: DoorstopWorkspaceJob = () => currentJob();
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, job);
    controller.hostConnected();
    await settle();
    const before = controller.result;
    if (before === undefined) throw new Error("Expected the first load to land");
    expect(controller.stale).toBe(false);

    let resolveJob: ((result: DoorstopWorkspaceResult) => void) | undefined;
    currentJob = () =>
      new Promise<DoorstopWorkspaceResult>((resolve) => {
        resolveJob = resolve;
      });
    requestRender.mockClear();
    const pending = controller.invalidate();

    expect(controller.stale).toBe(true);
    expect(controller.loading).toBe(true);
    // The old result stays rendered while the fresh load is in flight.
    expect(controller.result).toBe(before);
    expect(requestRender).toHaveBeenCalled();

    resolveJob?.(makeResult([makeItem("REQ0002", "REQ")]));
    await pending;
    expect(controller.stale).toBe(false);
    expect(controller.loading).toBe(false);
    expect(controller.result?.index.byUid.has("REQ0002")).toBe(true);
  });

  it("surfaces a rejected load as the formatted error message", async () => {
    const { context } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, async () => {
      throw new Error("Load crashed");
    });
    controller.hostConnected();
    await settle();
    expect(controller.error).toBe("Load crashed");
    expect(controller.loading).toBe(false);
    expect(controller.result).toBeUndefined();
  });

  it("drops late async writes after hostDisconnected and after the eviction release", async () => {
    const resolvers: Array<(result: DoorstopWorkspaceResult) => void> = [];
    const job: DoorstopWorkspaceJob = () =>
      new Promise<DoorstopWorkspaceResult>((resolve) => {
        resolvers.push(resolve);
      });
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, job);

    controller.hostConnected();
    controller.hostDisconnected();
    requestRender.mockClear();
    resolvers[0]?.(makeResult([]));
    await settle();
    expect(controller.result).toBeUndefined();
    expect(controller.loading).toBe(false);
    // The host is no longer connected: no state mutation reached it.
    expect(requestRender).not.toHaveBeenCalled();

    // The LRU eviction release drops writes the same way — even while the
    // element itself stayed connected.
    controller.hostConnected();
    controller.release();
    requestRender.mockClear();
    resolvers[1]?.(makeResult([]));
    await settle();
    expect(controller.result).toBeUndefined();
    expect(controller.loading).toBe(false);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("skips requestRender while disconnected and restores it on reconnect", async () => {
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, () =>
      Promise.resolve(makeResult([])),
    );
    controller.hostConnected();
    await settle();
    requestRender.mockClear();

    controller.selectUid("REQ0001");
    expect(requestRender).toHaveBeenCalledTimes(1);

    controller.hostDisconnected();
    controller.selectUid("REQ0002");
    expect(requestRender).toHaveBeenCalledTimes(1);

    // Reconnecting restores updates (the cached result is reused, no re-load).
    controller.hostConnected();
    controller.selectUid("REQ0003");
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("selection/navigation setters write their fields and notify the host", async () => {
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(
      host,
      context,
      () => Promise.resolve(makeResult([makeItem("REQ0001", "REQ")])),
    );
    controller.hostConnected();
    await settle();
    requestRender.mockClear();

    controller.selectUid("REQ0001");
    expect(controller.selectedUid).toBe("REQ0001");
    controller.selectDocument("REQ");
    expect(controller.selectedDocumentPrefix).toBe("REQ");
    controller.setStateFilter("unreviewed");
    expect(controller.stateFilter).toBe("unreviewed");
    controller.setSearch("allocated");
    expect(controller.search).toBe("allocated");
    expect(requestRender).toHaveBeenCalledTimes(4);
  });

  it("drops a selection hidden by the state filter and on a vanished re-load", async () => {
    const req001 = makeItem("REQ0001", "REQ");
    const { context } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    let currentJob: () => Promise<DoorstopWorkspaceResult> = () => Promise.resolve(makeResult([req001]));
    const controller = new DoorstopWorkspaceController(host, context, () => currentJob());
    controller.hostConnected();
    await settle();

    controller.selectUid("REQ0001");
    expect(controller.selectedUid).toBe("REQ0001");

    // Filtering to "reviewed" hides the never-reviewed REQ0001 → dangling
    // selection dropped (a filtered-out detail pane would dangle).
    controller.setStateFilter("reviewed");
    expect(controller.stateFilter).toBe("reviewed");
    expect(controller.selectedUid).toBeUndefined();

    // Switching the filter back keeps a (now visible) selection.
    controller.selectUid("REQ0001");
    controller.setStateFilter(undefined);
    expect(controller.selectedUid).toBe("REQ0001");

    // A re-load that drops the item clears the selection.
    currentJob = () => Promise.resolve(makeResult([]));
    await controller.load();
    expect(controller.selectedUid).toBeUndefined();
  });

  it("keeps one controller per workspace in the LRU and evicts the oldest", async () => {
    const registry = new DoorstopWorkspaceRegistry();
    const contexts: WorkspacePanelContext[] = [];
    const controllers: DoorstopWorkspaceController[] = [];
    for (let i = 0; i < DOORSTOP_WORKSPACE_STATE_LIMIT; i += 1) {
      const { context } = panelContext(createFakeFiles(), makeWorkspace(i));
      contexts.push(context);
      const controller = registry.for(context);
      controller.hostConnected();
      controllers.push(controller);
    }
    // Touching workspace 0 bumps it to the LRU tail (same instance reused).
    expect(registry.for(contexts[0]!)).toBe(controllers[0]);

    // Adding one more past the limit evicts the least-recently-used — now
    // workspace 1 (workspace 0 was bumped to the tail).
    const { context: nextContext } = panelContext(createFakeFiles(), makeWorkspace(99));
    const next = registry.for(nextContext);
    next.hostConnected();
    expect(controllers[1]!.host.isConnected).toBe(false); // evicted
    expect(controllers[0]!.host.isConnected).toBe(true); // bumped tail survives

    // The evicted workspace's old controller is gone; a fresh get creates a new one.
    const { context: freshContext } = panelContext(createFakeFiles(), makeWorkspace(1));
    const fresh = registry.for(freshContext);
    expect(fresh).not.toBe(controllers[1]);
  });

  it("toggles runInProgress and commits/dismisses lastRun through the run mutators", async () => {
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, () =>
      Promise.resolve(makeResult([])),
    );
    controller.hostConnected();
    await settle();
    requestRender.mockClear();

    controller.beginRun("Doorstop: validate");
    expect(controller.runInProgress).toBe("Doorstop: validate");
    expect(requestRender).toHaveBeenCalledTimes(1);

    const view: DoorstopLastRunView = {
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
    };
    controller.commitRun(view);
    expect(controller.lastRun).toBe(view);
    expect(requestRender).toHaveBeenCalledTimes(2);

    controller.endRun();
    expect(controller.runInProgress).toBeUndefined();
    expect(requestRender).toHaveBeenCalledTimes(3);

    controller.dismissRun();
    expect(controller.lastRun).toBeUndefined();
    expect(requestRender).toHaveBeenCalledTimes(4);
  });

  it("keeps lastRun across invalidate()/load() and drops only the render notification while disconnected", async () => {
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, context, () =>
      Promise.resolve(makeResult([])),
    );
    controller.hostConnected();
    await settle();
    const view: DoorstopLastRunView = {
      op: "validate",
      title: "Doorstop: validate",
      status: "ok",
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      at: 0,
    };
    controller.commitRun(view);
    requestRender.mockClear();

    // Run output is independent of the rescan: neither the re-load nor the
    // re-render touches lastRun, and a fresh load result keeps it.
    const before = controller.result;
    await controller.invalidate();
    expect(controller.lastRun).toBe(view);
    expect(before).not.toBe(controller.result);
    expect(controller.runInProgress).toBeUndefined();
    await controller.load();
    expect(controller.lastRun).toBe(view);

    // A disconnected panel skips the render notification (the write itself
    // is NOT dropped — plan: lastRun is cleared only by dismiss or a new
    // run, so a workspace switch-back still shows the run).
    requestRender.mockClear();
    controller.hostDisconnected();
    controller.commitRun({ ...view, status: "error", errorMessage: "opendoor: exploded" });
    expect(requestRender).not.toHaveBeenCalled();
    expect(controller.lastRun).not.toBe(view);
    expect(controller.lastRun?.status).toBe("error");
    controller.dismissRun();
    expect(controller.lastRun).toBeUndefined();
  });
});

describe("DoorstopWorkspaceController (baseline cache, Phase D step 13)", () => {
  /** An edited-after-review workspace result: REQ0003's `reviewed` is the
   *  stamp of the pre-edit version (parsed from the baseline blob), the
   *  current content diverges. The REQ document reviews the `owner`
   *  extended attribute. */
  function baselineResult(): DoorstopWorkspaceResult {
    const reqConfig = makeDocument({
      directoryPath: "reqs",
      configPath: "reqs/.doorstop.yml",
      prefix: "REQ",
      digits: 4,
      extra: { attributes: { reviewed: ["owner"] } },
    });
    const req0001 = makeItem("REQ0001", "REQ", { path: "reqs/REQ0001.yml", level: "1.0", text: "X" });
    const req0002 = makeItem("REQ0002", "REQ", { path: "reqs/REQ0002.yml", level: "1.1", text: "Y" });
    const oldVersion = makeItem("REQ0003", "REQ", {
      path: "reqs/REQ0003.yml",
      level: "1.2",
      text: "The system shall do Z.\nAnd approve.",
      links: [{ uid: "REQ0001", fingerprint: null }],
      attributes: { owner: "team-a" },
    });
    const current = makeItem("REQ0003", "REQ", {
      path: "reqs/REQ0003.yml",
      level: "1.2",
      text: "The system shall do Z.\nAnd approve.\nAsync.",
      links: [
        { uid: "REQ0001", fingerprint: null },
        { uid: "REQ0002", fingerprint: null },
      ],
      attributes: { owner: "team-b" },
    });
    current.reviewed = computeItemStamp(oldVersion, reqConfig, true);
    return makeResult([req0001, req0002, current], [reqConfig]);
  }

  /** The baseline blob of the pre-edit version: extended attributes are
   *  TOP-LEVEL item keys (the model chain's `attributes` bucket is every
   *  unmodeled top-level key). */
  function oldVersionBlob(): string {
    return [
      "active: true",
      "derived: false",
      "normative: true",
      "level: 1.2",
      "text: |-",
      "  The system shall do Z.",
      "  And approve.",
      "links:",
      "- REQ0001",
      "owner: team-a",
    ].join("\n");
  }

  function baselineController(backend: Mock) {
    const { context, requestRender } = panelContext(createFakeFiles());
    const contextWithBackend: WorkspacePanelContext = { ...context, backend: { request: backend } };
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, contextWithBackend, () =>
      Promise.resolve(baselineResult()),
    );
    controller.hostConnected();
    return { controller, requestRender };
  }

  it("fetches via the baseline operation, stamp-walks the candidates, and caches under the reviewed+stamp key", async () => {
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve({
          git: true,
          source: "review-commit",
          candidates: [
            // Newest first: a newer NON-matching revision must be skipped by
            // the stamp walk before the matching candidate.
            { sha: "beef0000", blob: "active: true\nnormative: true\ntext: Different.\n" },
            { sha: "abc1234", blob: oldVersionBlob() },
          ],
        } satisfies DoorstopBaselineResponse);
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller, requestRender } = baselineController(backend);
    await settle();
    requestRender.mockClear();

    const item = controller.result?.index.byUid.get("REQ0003");
    if (item === undefined) throw new Error("REQ0003 missing");
    await controller.requestBaseline(item);

    expect(backend).toHaveBeenCalledWith("doorstop.item-baseline", { uid: "REQ0003", path: "reqs/REQ0003.yml" });
    // The render was requested (fetch start + landing notifications).
    expect(requestRender).toHaveBeenCalled();
    const view = controller.baselineViewFor(item);
    expect(view?.state).toBe("ready");
    expect(view?.source).toBe("review-commit");
    expect(view?.diff?.linksAdded).toEqual(["REQ0002"]);
    expect(view?.diff?.extended).toEqual([{ name: "owner", before: "team-a", after: "team-b" }]);
    // The in-flight flag cleared and the version counter moved.
    expect(controller.baselineInFlight).toBeUndefined();
    expect(controller.baselineVersion).toBeGreaterThan(0);

    // A cached hit under the current key does NOT refetch.
    await controller.requestBaseline(item);
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(1);
  });

  it("misses naturally after a further edit or a re-review (the cache key is reviewed+stamp)", async () => {
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve({
          git: true,
          source: "review-commit",
          candidates: [{ sha: "abc1234", blob: oldVersionBlob() }],
        } satisfies DoorstopBaselineResponse);
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = baselineController(backend);
    await settle();
    const item = controller.result?.index.byUid.get("REQ0003");
    if (item === undefined) throw new Error("REQ0003 missing");
    await controller.requestBaseline(item);
    expect(controller.baselineViewFor(item)?.state).toBe("ready");

    // A further edit changes the current stamp → the cached entry misses.
    item.text = item.text + "\nEdited again.";
    expect(controller.baselineViewFor(item)).toBeUndefined();

    // A re-review rewrites `reviewed` → the cached entry misses too.
    item.text = item.text.replace("\nEdited again.", "");
    item.reviewed = "REVIEWED-AGAIN-STAMP";
    expect(controller.baselineViewFor(item)).toBeUndefined();

    // An expand after the miss refetches (the new key has no entry).
    await controller.requestBaseline(item);
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(2);
  });

  it("retries on a later expand after a transient request error (an error view is not a terminal cache hit)", async () => {
    let failing = true;
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        if (failing) return Promise.reject(new Error("bridge hiccup"));
        return Promise.resolve({
          git: true,
          source: "review-commit",
          candidates: [{ sha: "abc1234", blob: oldVersionBlob() }],
        } satisfies DoorstopBaselineResponse);
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = baselineController(backend);
    await settle();
    const item = controller.result?.index.byUid.get("REQ0003");
    if (item === undefined) throw new Error("REQ0003 missing");

    // The one-off failure lands an error view (still cached FOR RENDERING).
    await controller.requestBaseline(item);
    expect(controller.baselineViewFor(item)?.state).toBe("error");
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(1);

    // The same key re-expanded: the stale error must NOT short-circuit the
    // fetch — the retry lands the ready view.
    failing = false;
    await controller.requestBaseline(item);
    expect(controller.baselineViewFor(item)?.state).toBe("ready");
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(2);
  });
});

describe("isItemFile (the document item-name matching obligation)", () => {
  const base = { prefix: "REQ", digits: 4, separator: "" };
  const sep = { prefix: "REQ", digits: 4, separator: "-" };

  it("matches the exact configured name shape (prefix + zero-padded digits + extension)", () => {
    expect(isItemFile("REQ0001.yml", makeDocument())).toBe(true);
    expect(isItemFile("REQ0001.md", makeDocument())).toBe(true);
    expect(isItemFile("REQ0001.yml", makeDocument({ ...base, separator: "-" }))).toBe(false);
    expect(isItemFile("REQ-0001.yml", makeDocument(sep))).toBe(true);
    expect(isItemFile("REQ0001.yml", makeDocument(sep))).toBe(false);
  });

  it("rejects wrong-width numeric parts", () => {
    expect(isItemFile("REQ001.yml", makeDocument(base))).toBe(false); // 3 < digits 4
    expect(isItemFile("REQ00001.yml", makeDocument(base))).toBe(false); // 5 > digits 4
    expect(isItemFile("TST001.yml", makeDocument({ prefix: "TST", digits: 3 }))).toBe(true);
    expect(isItemFile("REQ001.yml", makeDocument({ prefix: "TST", digits: 3 }))).toBe(false); // wrong prefix
  });

  it("rejects a trailing free-form name part after the number", () => {
    expect(isItemFile("REQ0001-anything.yml", makeDocument(base))).toBe(false);
    expect(isItemFile("REQ0001-name.yml", makeDocument(sep))).toBe(false);
    expect(isItemFile("REQ-0001.yml", makeDocument(sep))).toBe(true);
  });

  it("never treats dotfiles as items, even when the prefix itself starts with a dot", () => {
    expect(isItemFile(".doorstop.yml", makeDocument(base))).toBe(false);
    expect(isItemFile(".hidden.yml", makeDocument(base))).toBe(false);
    expect(isItemFile(".123.yml", makeDocument({ prefix: ".", digits: 3 }))).toBe(false);
  });

  it("degenerates `digits: 0` to never matching (no bare-prefix or empty-name files)", () => {
    expect(isItemFile("REQ.yml", makeDocument({ ...base, digits: 0 }))).toBe(false);
    expect(isItemFile("REQ0000.yml", makeDocument({ ...base, digits: 0 }))).toBe(false);
    expect(isItemFile("REQ-foo.yml", makeDocument({ ...sep, digits: 0 }))).toBe(false);
  });

  it("clamps an absurd `digits` instead of constructing an oversized quantifier", () => {
    expect(isItemFile("REQ0001.yml", makeDocument({ ...base, digits: 100000 }))).toBe(false);
    // Clamped to MAX_ITEM_DIGITS width: a file with exactly that many digits
    // still matches rather than the constructor throwing.
    const wide = "REQ" + "0".repeat(24) + ".yml";
    expect(isItemFile(wide, makeDocument({ ...base, digits: 100000 }))).toBe(true);
  });
});

describe("loadDoorstopWorkspace (end-to-end over the fake files adapter)", () => {
  it("loads a two-document fixture into the correct index and computed states", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs"), dirEntry("tests", "tests")]),
        "reqs": tree([
          fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
          fileEntry("REQ0001.yml", "reqs/REQ0001.yml"),
          fileEntry("REQ0002.yml", "reqs/REQ0002.yml"),
        ]),
        "tests": tree([
          fileEntry(".doorstop.yml", "tests/.doorstop.yml"),
          fileEntry("TST001.md", "tests/TST001.md"),
        ]),
      },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4\n  sep: ''\n  parent: ''"),
        "tests/.doorstop.yml": text(
          "settings:\n  prefix: TST\n  digits: 3\n  sep: ''\n  parent: REQ\n  itemformat: markdown",
        ),
        "reqs/REQ0001.yml": text("text: The system shall do X."),
        "reqs/REQ0002.yml": text("text: The system shall do Y."),
        "tests/TST001.md": text(
          ["---", "text: Verify X.", "links:", "  - REQ0001", "---", "", "# Verification", "", "Verify X end-to-end."].join(
            "\n",
          ),
        ),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    // Correct index shape: two documents, three items, lookups populated.
    expect(result.index.documents.map((d) => d.prefix)).toEqual(["REQ", "TST"]);
    expect(result.index.items).toHaveLength(3);
    expect(result.index.byUid.get("REQ0001")?.text).toBe("The system shall do X.");
    expect(result.index.byUid.get("REQ0002")?.text).toBe("The system shall do Y.");
    expect(result.index.byUid.get("TST001")?.links.map((l) => l.uid)).toEqual(["REQ0001"]);
    expect(result.index.counts.items).toBe(3);
    expect(result.index.counts.documents).toBe(2);

    // The item reads touched only the three item files + two configs + the
    // settings file (read first, missing → defaults, no diagnostic) — a
    // `.doorstop.yml` is never read/parsed as an item.
    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.index.diagnostics).toEqual([]);
    expect(new Set(readCalls)).toEqual(
      new Set([
        ".pi-web/opendoor.json",
        "reqs/.doorstop.yml",
        "tests/.doorstop.yml",
        "reqs/REQ0001.yml",
        "reqs/REQ0002.yml",
        "tests/TST001.md",
      ]),
    );
    expect(result.index.byUid.has(".doorstop.yml")).toBe(false);

    // computeItemStates ran: every item carries its chips and the counters
    // are filled.
    expect(result.index.byUid.get("REQ0001")!.stateKeys).toContain("normative");
    expect(result.index.byUid.get("REQ0001")!.stateKeys).toContain("unreviewed");
    expect(result.index.byUid.get("TST001")!.stateKeys).toContain("normative");
    expect(result.index.byUid.get("TST001")!.stateKeys).toContain("unreviewed");
    expect(result.index.byUid.get("TST001")!.stateKeys).not.toContain("suspect-link");
    expect(result.index.counts.unreviewedChanges).toBe(3);
    expect(result.index.ok).toBe(true);
  });

  it("surfaces a no-match warning for every stray file and still builds the matching items", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([
          fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
          fileEntry("REQ0001.yml", "reqs/REQ0001.yml"),
          fileEntry("REQ0002.yml", "reqs/REQ0002.yml"),
          fileEntry("notes.txt", "reqs/notes.txt"), // stray
          fileEntry("REQ0001.yml.bak", "reqs/REQ0001.yml.bak"), // editor backup
          fileEntry("REQ001.yml", "reqs/REQ001.yml"), // wrong digit width (3 < 4)
          fileEntry("REQ0001-extra.yml", "reqs/REQ0001-extra.yml"), // trailing name part
        ]),
      },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.yml": text("text: The system shall do X."),
        "reqs/REQ0002.yml": text("text: The system shall do Y."),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    // The two real items still parse.
    expect(result.index.items).toHaveLength(2);
    expect(result.index.byUid.has("REQ0001")).toBe(true);
    expect(result.index.byUid.has("REQ0002")).toBe(true);

    // Every non-item file except the document's own `.doorstop.yml` got a
    // warning diagnostic — nothing dropped silently.
    expect(result.index.diagnostics.map((d) => d.path).sort()).toEqual([
      "reqs/REQ0001-extra.yml",
      "reqs/REQ0001.yml.bak",
      "reqs/REQ001.yml",
      "reqs/notes.txt",
    ]);
    expect(result.index.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    // The config file was never flagged as a stranger, and only the two real
    // item files + the config were read.
    expect(result.index.diagnostics.some((d) => d.path === "reqs/.doorstop.yml")).toBe(false);
    expect(new Set(readCalls)).toEqual(
      new Set([".pi-web/opendoor.json", "reqs/.doorstop.yml", "reqs/REQ0001.yml", "reqs/REQ0002.yml"]),
    );
  });

  it("calls out an item file whose extension contradicts the document itemformat", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([
          fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
          fileEntry("REQ0001.md", "reqs/REQ0001.md"), // .md inside a yaml document
        ]),
      },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.md": text("text: The system shall do X."),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    expect(
      result.index.diagnostics.some(
        (d) => d.path === "reqs/REQ0001.md" && d.message.includes("itemformat"),
      ),
    ).toBe(true);
  });

  it("skips binary/truncated item files with warnings and still builds the rest", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([
          fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
          fileEntry("REQ0001.yml", "reqs/REQ0001.yml"),
          fileEntry("REQ0002.yml", "reqs/REQ0002.yml"),
        ]),
      },
      reads: {
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.yml": { ...text("text: good"), truncated: true },
        "reqs/REQ0002.yml": { ...text(""), binary: true },
      },
    });

    const result = await loadDoorstopWorkspace(files);

    expect(result.index.items).toHaveLength(0);
    expect(result.index.byUid.size).toBe(0);
    expect(result.index.diagnostics).toEqual([
      { severity: "warning", path: "reqs/REQ0001.yml", message: "File content truncated by the workspace API and skipped" },
      { severity: "warning", path: "reqs/REQ0002.yml", message: "Binary file skipped; not parsed as a Doorstop item" },
    ]);
  });

  it("reads the workspace settings file first: exclusions shape discovery and settings surface on the result", async () => {
    const { files, listCalls, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs"), dirEntry("dist", "dist")]),
        "reqs": tree([
          fileEntry(".doorstop.yml", "reqs/.doorstop.yml"),
          fileEntry("REQ0001.yml", "reqs/REQ0001.yml"),
        ]),
        // dist is excluded by the settings file — the walk must never list it.
        "dist": tree([
          fileEntry(".doorstop.yml", "dist/.doorstop.yml"),
          fileEntry("OUT001.yml", "dist/OUT001.yml"),
        ]),
      },
      reads: {
        ".pi-web/opendoor.json": text(
          ["{", "  \"version\": 1,", "  \"publishTarget\": \"./site\",", "  \"excludedDirectories\": [\"dist\"]", "}"].join("\n"),
        ),
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.yml": text("text: The system shall do X."),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    // Settings surfaced on the result (the elements chain wires the publish
    // command to settings.publishTarget from here).
    expect(result.settings).toEqual({ publishTarget: "./site", excludedDirectories: ["dist"], commitAfterReview: false });
    // The excluded document and its items were never discovered.
    expect(result.index.documents.map((d) => d.prefix)).toEqual(["REQ"]);
    expect(result.index.counts.documents).toBe(1);
    expect(result.index.counts.items).toBe(1);
    expect(result.index.byUid.has("REQ0001")).toBe(true);
    expect(result.index.byUid.has("OUT001")).toBe(false);
    expect(Array.from(result.index.knownFilePaths).some((p) => p.startsWith("dist/"))).toBe(false);
    // The walk never listed or read anything under dist (the discovery walk
    // lists "reqs" once and the load job's item-directory listing lists it
    // again), and the settings file was read exactly once, before the configs.
    expect(listCalls).not.toContain("dist");
    expect(readCalls).toEqual([".pi-web/opendoor.json", "reqs/.doorstop.yml", "reqs/REQ0001.yml"]);
    expect(result.index.diagnostics).toEqual([]);
    expect(result.index.ok).toBe(true);
  });

  it("flows settings-file diagnostics into the result (falling back to defaults)", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml")]),
      },
      reads: {
        ".pi-web/opendoor.json": text("{\"version\": 2}"), // unsupported version → warning + defaults
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    expect(result.settings).toEqual(DEFAULT_OPENDOOR_SETTINGS);
    expect(result.index.diagnostics).toEqual([
      {
        severity: "warning",
        path: ".pi-web/opendoor.json",
        message: expect.stringContaining('unsupported "version"'),
      },
    ]);
    expect(result.index.ok).toBe(true); // warnings alone leave ok true
  });

  it("drives a markdown-itemformat document end-to-end: discovery → parse → index → states", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("specs", "specs")]),
        "specs": tree([
          fileEntry(".doorstop.yml", "specs/.doorstop.yml"),
          fileEntry("SPC001.md", "specs/SPC001.md"),
          fileEntry("SPC002.md", "specs/SPC002.md"),
        ]),
      },
      reads: {
        "specs/.doorstop.yml": text(
          "settings:\n  prefix: SPC\n  digits: 3\n  sep: ''\n  parent: ''\n  itemformat: markdown",
        ),
        // Frontmatter `text:` is overridden by the body (Doorstop's
        // update_data_from_markdown_content), and `header` is derived from
        // the first level-1 body heading — pinned here at the full-job level.
        "specs/SPC001.md": text(
          ["---", "text: ignored frontmatter copy", "---", "", "# Login flow", "", "The system shall allow login."].join("\n"),
        ),
        "specs/SPC002.md": text(
          ["---", "text: ignored frontmatter copy", "links:", "  - SPC001", "---", "", "# Session expiry", "", "The system shall expire sessions."].join(
            "\n",
          ),
        ),
      },
    });

    const result = await loadDoorstopWorkspace(files);

    // Parse: markdown frontmatter + body-derived header/text.
    const spc001 = result.index.byUid.get("SPC001");
    const spc002 = result.index.byUid.get("SPC002");
    expect(spc001?.header).toBe("Login flow");
    expect(spc001?.text).toBe("The system shall allow login.");
    expect(spc002?.header).toBe("Session expiry");
    expect(spc002?.text).toBe("The system shall expire sessions.");
    expect(spc002?.links.map((l) => l.uid)).toEqual(["SPC001"]);

    // Index: the markdown document configured with itemformat markdown, two
    // items, full lookups.
    expect(result.index.documents.map((d) => d.prefix)).toEqual(["SPC"]);
    expect(result.index.documents[0]?.itemformat).toBe("markdown");
    expect(result.index.counts.documents).toBe(1);
    expect(result.index.counts.items).toBe(2);
    expect(result.index.byPrefix.get("SPC")?.itemformat).toBe("markdown");

    // States: computeItemStates ran over the markdown items — both are
    // normative, never reviewed → unreviewed chips, counters filled.
    expect(spc001?.stateKeys).toContain("normative");
    expect(spc001?.stateKeys).toContain("unreviewed");
    expect(spc002?.stateKeys).toContain("normative");
    expect(spc002?.stateKeys).toContain("unreviewed");
    expect(result.index.counts.unreviewedChanges).toBe(2);
    expect(result.index.diagnostics).toEqual([]);
    expect(result.index.ok).toBe(true);

    // Only the two item files + config (+ the missing settings read) were read.
    expect(new Set(readCalls)).toEqual(
      new Set([".pi-web/opendoor.json", "specs/.doorstop.yml", "specs/SPC001.md", "specs/SPC002.md"]),
    );
  });
});

// --- test helpers ------------------------------------------------------------------------

function fakeHost(): { host: DoorstopWorkspaceHost } {
  return { host: { isConnected: false } };
}

function makeWorkspace(id: number): Workspace {
  return { ...doorstopWorkspace, id: `workspace-${String(id)}` };
}

/** Build one panel context wrapping the fake files adapter plus a
 *  `requestRender` spy — the controller's render path fires this (via the
 *  context host). */
function panelContext(
  fake: FakeWorkspaceFiles,
  workspace: Workspace = doorstopWorkspace,
): { context: WorkspacePanelContext; requestRender: Mock } {
  const requestRender = vi.fn();
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace,
    state: {
      selectedWorkspace: workspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
    files: fake.files,
    host: { requestRender },
    prompt: { insertText: () => undefined, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
  return { context, requestRender };
}

/** How many microtask turns a bare `await settle()` waits for a resolved
 *  promise chain to flush. A magic number, but named and shared so every
 *  test's timing assumption is uniform. */
const SETTLE_TICKS = 10;

async function settle(): Promise<void> {
  for (let index = 0; index < SETTLE_TICKS; index += 1) await Promise.resolve();
}
