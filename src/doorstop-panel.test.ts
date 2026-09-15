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
import {
  DOORSTOP_GIT_STATUS_FILES_MAX,
  type DoorstopBaselineResponse,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopGitUnstageResponse,
} from "./doorstop-backend-contract.js";
import { buildDoorstopIndex } from "./doorstop-model.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import {
  DoorstopWorkspaceController,
  doorstopPaths,
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
import {
  commitOutcomeText,
  GIT_CHIP_LABELS,
  gitChipKind,
  gitStatusFileFor,
  gitStatusFilesByPath,
  gitStatusFilesTruncated,
  itemGitState,
  itemStageable,
  itemUnstageable,
} from "./doorstop-panel-view-model.js";
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

describe("DoorstopWorkspaceController (git status, plan-add-git-actions Phase C step 10)", () => {
  /** A controller with a counting load job (detects invalidate-driven
   *  reloads) and a mock backend. */
  function statusController(backend: Mock, loadCount: { calls: number }) {
    const { context, requestRender } = panelContext(createFakeFiles());
    const contextWithBackend: WorkspacePanelContext = { ...context, backend: { request: backend } };
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(host, contextWithBackend, () => {
      loadCount.calls += 1;
      return Promise.resolve(makeResult([makeItem("REQ0001", "REQ")]));
    });
    controller.hostConnected();
    return { controller, requestRender };
  }

  function gitReady(overrides: Partial<DoorstopGitStatusResponse> = {}): DoorstopGitStatusResponse {
    return {
      git: true,
      branch: "main",
      ahead: 1,
      behind: 0,
      staged: 2,
      dirty: 3,
      files: [{ path: "reqs/REQ0001.yml", index: "modified", workingTree: "unmodified" }],
      ...overrides,
    };
  }

  it("fetches through the git-status operation, parses strictly, and maps git:false to the no-git view", async () => {
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-status") {
        return Promise.resolve(gitReady());
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller, requestRender } = statusController(backend, { calls: 0 });
    await settle();
    requestRender.mockClear();

    await controller.requestGitStatus();

    expect(backend).toHaveBeenCalledWith("doorstop.git-status", {});
    expect(controller.gitStatusView?.state).toBe("ready");
    if (controller.gitStatusView?.state === "ready") {
      expect(controller.gitStatusView.response.branch).toBe("main");
      expect(controller.gitStatusView.response.ahead).toBe(1);
      expect(controller.gitStatusView.response.files[0]?.index).toBe("modified");
    }
    expect(controller.gitStatusInFlight).toBe(false);
    expect(requestRender).toHaveBeenCalled();

    // git: false → the no-git view, not an error.
    const noGitBackend = vi.fn(() => Promise.resolve({ git: false, staged: 0, dirty: 0, files: [] } satisfies DoorstopGitStatusResponse));
    const { controller: noGit } = statusController(noGitBackend, { calls: 0 });
    await settle();
    await noGit.requestGitStatus();
    expect(noGit.gitStatusView?.state).toBe("no-git");

    // A rejected bridge request lands the transient error view.
    const failingBackend = vi.fn(() => Promise.reject(new Error("bridge hiccup")));
    const { controller: failing } = statusController(failingBackend, { calls: 0 });
    await settle();
    await failing.requestGitStatus();
    expect(failing.gitStatusView?.state).toBe("error");
    if (failing.gitStatusView?.state === "error") {
      expect(failing.gitStatusView.errorMessage).toContain("bridge hiccup");
    }
  });

  it("joins concurrent fetches (two calls share one request)", async () => {
    let resolveStatus: ((value: DoorstopGitStatusResponse) => void) | undefined;
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-status") {
        return new Promise<DoorstopGitStatusResponse>((resolve) => {
          resolveStatus = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = statusController(backend, { calls: 0 });
    await settle();

    const first = controller.requestGitStatus();
    const second = controller.requestGitStatus();
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.git-status")).toHaveLength(1);

    resolveStatus?.(gitReady());
    await Promise.all([first, second]);
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.git-status")).toHaveLength(1);
    expect(controller.gitStatusView?.state).toBe("ready");
    expect(controller.gitStatusInFlight).toBe(false);
  });

  it("clears the cached view on invalidate (the single cache-clearing point) and drops late writes after a disconnect", async () => {
    let resolveStatus: ((value: DoorstopGitStatusResponse) => void) | undefined;
    const backend = vi.fn(() => new Promise<DoorstopGitStatusResponse>((resolve) => {
      resolveStatus = resolve;
    }));
    const { controller } = statusController(backend, { calls: 0 });
    await settle();

    const first = controller.requestGitStatus();
    resolveStatus?.(gitReady());
    await first;
    expect(controller.gitStatusView?.state).toBe("ready");

    // invalidate clears the strip view (a rescan/run may change dirtiness).
    const promise = controller.invalidate();
    expect(controller.gitStatusView).toBeUndefined();
    await promise;

    // A fetch resolved AFTER hostDisconnected drops its write (loading view
    // stays; the next request refetches).
    let secondResolve: ((value: DoorstopGitStatusResponse) => void) | undefined;
    backend.mockImplementation(() => new Promise<DoorstopGitStatusResponse>((resolve) => {
      secondResolve = resolve;
    }));
    const refetch = controller.requestGitStatus();
    expect(controller.gitStatusView?.state).toBe("loading");
    controller.hostDisconnected();
    secondResolve?.(gitReady());
    await refetch;
    expect(controller.gitStatusView?.state).toBe("loading");
    expect(controller.gitStatusInFlight).toBe(false);
  });

  it("hostConnected recovers an orphaned loading view (a disconnect mid-fetch) so the strip refetches", async () => {
    const resolvers: Array<(value: DoorstopGitStatusResponse) => void> = [];
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-status") {
        return new Promise<DoorstopGitStatusResponse>((resolve) => {
          resolvers.push(resolve);
        });
      }
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = statusController(backend, { calls: 0 });
    await settle();

    // Fetch A is in flight when the panel disconnects…
    const first = controller.requestGitStatus();
    expect(controller.gitStatusView?.state).toBe("loading");
    controller.hostDisconnected();
    // …its landing is dropped by the late-write guard: the view stays an
    // ORPHANED `loading` placeholder with no fetch in flight (the marker was
    // cleared by the fetch's finally) — the stuck `⎇ …` the element would
    // render until the user clicks the strip.
    resolvers[0]?.(gitReady());
    await first;
    expect(controller.gitStatusView?.state).toBe("loading");
    expect(controller.gitStatusInFlight).toBe(false);

    // …and RECONNECTING clears the orphan (hostConnected is the reconnect
    // point: the element's next ensureGitStatus sees `undefined` and
    // refetches — the strip never strands on `⎇ …` until a manual click).
    controller.hostConnected();
    expect(controller.gitStatusView).toBeUndefined();
    const refetch = controller.requestGitStatus();
    expect(controller.gitStatusView?.state).toBe("loading");
    resolvers[1]?.(gitReady());
    await refetch;
    expect(controller.gitStatusView?.state).toBe("ready");
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.git-status")).toHaveLength(2);
  });

  it("an in-flight fetch never resurrects a stale view over a cache invalidate() just cleared", async () => {
    let resolveStatus: ((value: DoorstopGitStatusResponse) => void) | undefined;
    const backend = vi.fn(() => new Promise<DoorstopGitStatusResponse>((resolve) => {
      resolveStatus = resolve;
    }));
    const { controller } = statusController(backend, { calls: 0 });
    await settle();

    // Fetch A is in flight (its loading view is installed)…
    const first = controller.requestGitStatus();
    expect(controller.gitStatusView?.state).toBe("loading");

    // …an invalidate lands MID-FLIGHT (a stage/commit run's success path or
    // a rescan) and clears the cache — the single cache-clearing point.
    const invalidation = controller.invalidate();
    expect(controller.gitStatusView).toBeUndefined();
    await invalidation;

    // Fetch A's PRE-invalidate snapshot resolves: the write is dropped
    // (the loading view THIS fetch installed is gone), so a stale
    // pre-stage/pre-rescan view never resurrects over the cleared cache.
    // The next requestGitStatus() refetches instead.
    resolveStatus?.(gitReady());
    await first;
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.gitStatusInFlight).toBe(false);
  });
});

describe("itemGitState / itemStageable / gitStatusFilesByPath (per-item git state)", () => {
  function gitFile(
    index: DoorstopGitStatusFile["index"],
    workingTree: DoorstopGitStatusFile["workingTree"],
    path = "reqs/REQ0001.yml",
  ): DoorstopGitStatusFile {
    return { path, index, workingTree };
  }

  it("maps every porcelain XY pair onto the chip state", () => {
    const table: Array<[string, DoorstopGitStatusFile | undefined, ReturnType<typeof itemGitState>]> = [
      ["absent (unmodified is omitted from porcelain)", undefined, "clean"],
      ["'  ' unmodified/unmodified (defensive)", gitFile("unmodified", "unmodified"), "clean"],
      ["'!!' ignored (never stageable without -f)", gitFile("ignored", "ignored"), "clean"],
      ["'M ' staged modification", gitFile("modified", "unmodified"), "staged"],
      ["'A ' staged addition", gitFile("added", "unmodified"), "staged"],
      ["'D ' fully-staged deletion", gitFile("deleted", "unmodified"), "staged"],
      ["' M' unstaged modification", gitFile("unmodified", "modified"), "changed"],
      ["' D' unstaged deletion", gitFile("unmodified", "deleted"), "changed"],
      ["'MM' staged + unstaged modification", gitFile("modified", "modified"), "staged-changed"],
      ["'AM' staged addition + unstaged modification", gitFile("added", "modified"), "staged-changed"],
      ["'RM' rename + unstaged modification", gitFile("renamed", "modified"), "staged-changed"],
      ["'??' untracked", gitFile("untracked", "untracked"), "untracked"],
      ["'UU' conflicted", gitFile("conflicted", "conflicted"), "conflicted"],
      ["'AU' added-both conflict", gitFile("added", "conflicted"), "conflicted"],
    ];
    for (const [label, file, expected] of table) {
      expect(itemGitState(file), label).toBe(expected);
    }
  });

  it("marks exactly the working-tree-changed paths stageable (conflicts included, ignored excluded)", () => {
    const table: Array<[string, DoorstopGitStatusFile | undefined, boolean]> = [
      ["absent", undefined, false],
      ["unmodified/unmodified", gitFile("unmodified", "unmodified"), false],
      ["ignored", gitFile("ignored", "ignored"), false],
      ["staged only ('M ')", gitFile("modified", "unmodified"), false],
      ["fully-staged deletion ('D ')", gitFile("deleted", "unmodified"), false],
      ["unstaged modification (' M')", gitFile("unmodified", "modified"), true],
      ["unstaged deletion (' D')", gitFile("unmodified", "deleted"), true],
      ["staged + unstaged ('MM')", gitFile("modified", "modified"), true],
      ["untracked ('??')", gitFile("untracked", "untracked"), true],
      ["conflicted ('UU') — add resolves", gitFile("conflicted", "conflicted"), true],
    ];
    for (const [label, file, expected] of table) {
      expect(itemStageable(file), label).toBe(expected);
    }
  });

  it("marks exactly the index-dirty paths unstageable (the X-column mirror; every unmerged shape excluded)", () => {
    const table: Array<[string, DoorstopGitStatusFile | undefined, boolean]> = [
      ["absent", undefined, false],
      ["unmodified/unmodified", gitFile("unmodified", "unmodified"), false],
      ["ignored", gitFile("ignored", "ignored"), false],
      ["staged modification ('M ')", gitFile("modified", "unmodified"), true],
      ["staged addition ('A ')", gitFile("added", "unmodified"), true],
      ["fully-staged deletion ('D ')", gitFile("deleted", "unmodified"), true],
      ["staged rename ('R ')", gitFile("renamed", "unmodified"), true],
      ["unstaged modification (' M')", gitFile("unmodified", "modified"), false],
      ["unstaged deletion (' D')", gitFile("unmodified", "deleted"), false],
      ["staged + unstaged ('MM')", gitFile("modified", "modified"), true],
      ["untracked ('??') — never in the index", gitFile("untracked", "untracked"), false],
      ["conflicted ('UU') — reset would resolve the conflict", gitFile("conflicted", "conflicted"), false],
      ["both added ('AA') — unmerged pair", gitFile("added", "added"), false],
      ["both deleted ('DD') — unmerged pair", gitFile("deleted", "deleted"), false],
      ["deleted by us ('DU') — unmerged pair", gitFile("deleted", "conflicted"), false],
      ["added by us ('AU') — unmerged pair", gitFile("added", "conflicted"), false],
      ["deleted by them ('UD') — unmerged pair", gitFile("conflicted", "deleted"), false],
      ["added by them ('UA') — unmerged pair", gitFile("conflicted", "added"), false],
    ];
    for (const [label, file, expected] of table) {
      expect(itemUnstageable(file), label).toBe(expected);
    }
  });

  it("narrates the unstage run's own outcome voice (the shared status set + `unstaged`)", () => {
    expect(commitOutcomeText("git-unstage", { status: "unstaged", unstaged: 2 })).toBe("unstaged 2 paths");
    expect(commitOutcomeText("git-unstage", { status: "unstaged", unstaged: 0 })).toBe("unstaged 0 paths");
    expect(commitOutcomeText("git-unstage", { status: "clean" })).toBe("clean — nothing to unstage");
    expect(commitOutcomeText("git-unstage", { status: "skipped" })).toBe("skipped");
    expect(commitOutcomeText("git-unstage", { status: "failed", stderr: "boom" })).toBe("failed — boom");
  });

  it("labels and colors every state; clean is empty because the chip is skipped", () => {
    expect(GIT_CHIP_LABELS).toEqual({
      clean: "",
      staged: "staged",
      changed: "changed",
      "staged-changed": "staged + changed",
      untracked: "untracked",
      conflicted: "conflict",
    });
    expect(gitChipKind("staged")).toBe("ok");
    expect(gitChipKind("changed")).toBe("warning");
    expect(gitChipKind("staged-changed")).toBe("warning");
    expect(gitChipKind("conflicted")).toBe("danger");
    expect(gitChipKind("untracked")).toBe("muted");
    expect(gitChipKind("clean")).toBe("muted");
  });

  it("keys gitStatusFilesByPath by the porcelain path (a rename reports its NEW path)", () => {
    const renamed = gitFile("renamed", "unmodified", "reqs/REQ0009.yml");
    const modified = gitFile("unmodified", "modified", "reqs/REQ0002.yml");
    const files = gitStatusFilesByPath({
      git: true,
      staged: 1,
      dirty: 2,
      files: [renamed, modified],
    });
    expect(files.get("reqs/REQ0009.yml")).toBe(renamed);
    expect(files.get("reqs/REQ0002.yml")).toBe(modified);
    // The old (source) path is NOT in the map — a stale index row for it
    // renders clean until the next rescan (the documented rename gap).
    expect(files.get("reqs/REQ0001.yml")).toBeUndefined();
    expect(itemGitState(files.get("reqs/REQ0001.yml"))).toBe("clean");
    expect(itemStageable(files.get("reqs/REQ0001.yml"))).toBe(false);
  });

  it("finds one file by path for the action row (no map build)", () => {
    const modified = gitFile("unmodified", "modified", "reqs/REQ0002.yml");
    const response: DoorstopGitStatusResponse = { git: true, staged: 0, dirty: 1, files: [modified] };
    expect(gitStatusFileFor(response, "reqs/REQ0002.yml")).toBe(modified);
    expect(gitStatusFileFor(response, "reqs/REQ0001.yml")).toBeUndefined();
  });

  it("flags a files list as truncated only when dirty exceeds the capped length", () => {
    const cappedFiles = (): DoorstopGitStatusFile[] =>
      Array.from({ length: DOORSTOP_GIT_STATUS_FILES_MAX }, (_, index) =>
        gitFile("unmodified", "modified", `reqs/REQ${String(index).padStart(4, "0")}.yml`),
      );
    // Exactly at the cap with matching counts: nothing was dropped.
    expect(
      gitStatusFilesTruncated({
        git: true,
        staged: 0,
        dirty: DOORSTOP_GIT_STATUS_FILES_MAX,
        files: cappedFiles(),
      }),
    ).toBe(false);
    // dirty above the cap: paths past the cap are unreported.
    expect(
      gitStatusFilesTruncated({
        git: true,
        staged: 0,
        dirty: DOORSTOP_GIT_STATUS_FILES_MAX + 1,
        files: cappedFiles(),
      }),
    ).toBe(true);
    // A short list is never truncated, whatever the counts claim.
    expect(
      gitStatusFilesTruncated({
        git: true,
        staged: 0,
        dirty: 500,
        files: [gitFile("unmodified", "modified")],
      }),
    ).toBe(false);
  });
});

describe("doorstopPaths (plan-add-git-actions Phase C step 11)", () => {
  it("lists the root marker + document config paths + item paths, deduplicated", () => {
    const rootDoc = makeDocument({ directoryPath: "", configPath: ".doorstop.yml" });
    const reqsDoc = makeDocument();
    const items = [
      makeItem("REQ0001", "REQ", { path: "reqs/REQ0001.yml" }),
      makeItem("REQ0002", "REQ", { path: "reqs/REQ0002.yml" }),
    ];
    const index = buildDoorstopIndex(
      [rootDoc, reqsDoc],
      items,
      [],
      // The discovery file index carries the root marker (plus unrelated files).
      new Set([".doorstop.yml", "reqs/.doorstop.yml", "reqs/REQ0001.yml", "reqs/REQ0002.yml", "docs/README.md"]),
    );
    computeItemStates(index);
    const result: DoorstopWorkspaceResult = { index, settings: DEFAULT_OPENDOOR_SETTINGS };
    // Root marker first, then config paths, then item paths; the root marker
    // duplicated by the root document's own configPath is emitted once.
    expect(doorstopPaths(result)).toEqual([
      ".doorstop.yml",
      "reqs/.doorstop.yml",
      "reqs/REQ0001.yml",
      "reqs/REQ0002.yml",
    ]);
  });

  it("omits the root marker when discovery did not enumerate it", () => {
    // makeResult's index carries no knownFilePaths at all.
    const result = makeResult([makeItem("REQ0001", "REQ", { path: "reqs/REQ0001.yml" })]);
    expect(doorstopPaths(result)).toEqual(["reqs/.doorstop.yml", "reqs/REQ0001.yml"]);
  });
});

describe("DoorstopWorkspaceController (git stage/unstage/commit dispatch, plan-add-git-actions Phase C step 12)", () => {
  /** A controller with a counting load job whose backend answers the given
   *  operation (mirrors the baseline describe's `baselineController`). */
  function gitRunController(backend: Mock, loadCount: { calls: number }) {
    const { context } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new DoorstopWorkspaceController(
      host,
      { ...context, backend: { request: backend } },
      () => {
        loadCount.calls += 1;
        return Promise.resolve(makeResult([makeItem("REQ0001", "REQ")]));
      },
    );
    controller.hostConnected();
    return { controller, backend };
  }

  function stageBackend(response: DoorstopGitStageResponse): Mock {
    return vi.fn((operation: string) => {
      if (operation === "doorstop.git-stage") return Promise.resolve(response);
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
  }

  function unstageBackend(response: DoorstopGitUnstageResponse): Mock {
    return vi.fn((operation: string) => {
      if (operation === "doorstop.git-unstage") return Promise.resolve(response);
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
  }

  it("runGitStage sends the paths and commits the mapped run view (staged outcome, ok status)", async () => {
    const loadCount = { calls: 0 };
    const { controller, backend } = gitRunController(stageBackend({ status: "staged", staged: 2 }), loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitStage(["reqs/REQ0001.yml", "reqs/REQ0002.yml"]);

    expect(backend).toHaveBeenCalledWith("doorstop.git-stage", {
      paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"],
    });
    const run = controller.lastRun;
    expect(run?.op).toBe("git-stage");
    expect(run?.title).toBe("Git: stage all");
    expect(run?.status).toBe("ok");
    expect(run?.exitCode).toBeNull();
    expect(run?.commit).toEqual({ status: "staged", staged: 2 });
    // Success invalidates: the load reran and the strip cache cleared.
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("runGitStage honors an explicit per-item title (the element's `Git: stage <uid>`)", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(stageBackend({ status: "staged", staged: 1 }), loadCount);
    await settle();

    await controller.runGitStage(["reqs/REQ0002.yml"], "Git: stage REQ0002");

    expect(controller.lastRun?.op).toBe("git-stage");
    expect(controller.lastRun?.title).toBe("Git: stage REQ0002");
  });

  it("runGitUnstage sends the paths and commits the mapped run view (unstaged outcome, ok status, per-item title)", async () => {
    const loadCount = { calls: 0 };
    const { controller, backend } = gitRunController(
      unstageBackend({ status: "unstaged", unstaged: 2 }),
      loadCount,
    );
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitUnstage(["reqs/REQ0001.yml", "reqs/REQ0002.yml"], "Git: unstage REQ0001");

    expect(backend).toHaveBeenCalledWith("doorstop.git-unstage", {
      paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"],
    });
    const run = controller.lastRun;
    expect(run?.op).toBe("git-unstage");
    expect(run?.title).toBe("Git: unstage REQ0001");
    expect(run?.status).toBe("ok");
    expect(run?.exitCode).toBeNull();
    expect(run?.commit).toEqual({ status: "unstaged", unstaged: 2 });
    // Success invalidates: the load reran and the strip cache cleared.
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("runGitUnstage defaults its title to `Git: unstage all` (the non-per-item form)", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(unstageBackend({ status: "unstaged", unstaged: 1 }), loadCount);
    await settle();

    await controller.runGitUnstage(["reqs/REQ0001.yml"]);

    expect(controller.lastRun?.op).toBe("git-unstage");
    expect(controller.lastRun?.title).toBe("Git: unstage all");
  });

  it("maps a clean unstage outcome to an ok run (nothing to unstage) and still invalidates", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(unstageBackend({ status: "clean" }), loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitUnstage(["reqs/REQ0001.yml"]);

    const run = controller.lastRun;
    expect(run?.op).toBe("git-unstage");
    // The operation RESOLVED — `clean` is narration (nothing to unstage),
    // not failure: the badge stays ok and the outcome rides in `commit`.
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "clean" });
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a skipped unstage outcome to an ok run (not a repo / deadline)", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(unstageBackend({ status: "skipped" }), loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitUnstage(["reqs/REQ0001.yml"]);

    expect(controller.lastRun?.op).toBe("git-unstage");
    expect(controller.lastRun?.status).toBe("ok");
    expect(controller.lastRun?.commit).toEqual({ status: "skipped" });
    // `skipped` still RESOLVED, so the run is ok and the success path's
    // invalidate contract holds symmetrically with the unstaged/clean
    // cases above: the load reran and the strip cache cleared.
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a failed unstage outcome to a failed run, the excerpt riding in the commit narration", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(
      unstageBackend({ status: "failed", stderr: "fatal: bad revision" }),
      loadCount,
    );
    await settle();

    await controller.runGitUnstage(["reqs/REQ0001.yml"], "Git: unstage REQ0001");

    const run = controller.lastRun;
    expect(run?.op).toBe("git-unstage");
    expect(run?.status).toBe("failed");
    // The excerpt rides in the `commit` narration; the run's own stderr stays
    // empty (the review→commit idiom).
    expect(run?.stderr).toBe("");
    expect(run?.commit).toEqual({ status: "failed", stderr: "fatal: bad revision" });
    expect(controller.runInProgress).toBeUndefined();
  });

  it("a rejected unstage request commits an error run, does NOT invalidate, and clears runInProgress", async () => {
    const loadCount = { calls: 0 };
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-unstage") throw new Error("bridge hiccup");
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = gitRunController(backend, loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitUnstage(["reqs/REQ0001.yml"]);

    const run = controller.lastRun;
    expect(run?.status).toBe("error");
    if (run?.status === "error") expect(run.errorMessage).toContain("bridge hiccup");
    expect(run?.op).toBe("git-unstage");
    expect(run?.commit).toBeUndefined();
    expect(loadCount.calls).toBe(loadsBefore);
    expect(controller.runInProgress).toBeUndefined();
  });

  it("runGitCommit sends only the message and maps committed/sha onto the view", async () => {
    const loadCount = { calls: 0 };
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-commit") return Promise.resolve({ status: "committed", sha: "abc1234" });
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = gitRunController(backend, loadCount);
    await settle();

    await controller.runGitCommit("  Land the fixture  ");

    expect(backend).toHaveBeenCalledWith("doorstop.git-commit", { message: "  Land the fixture  " });
    const run = controller.lastRun;
    expect(run?.op).toBe("git-commit");
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "committed", sha: "abc1234" });
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a failed git outcome to a failed run, the excerpt riding in the commit narration", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(stageBackend({ status: "failed", stderr: "pre-commit hook rejected" }), loadCount);
    await settle();

    await controller.runGitStage(["reqs/REQ0001.yml"]);

    const run = controller.lastRun;
    expect(run?.status).toBe("failed");
    // The excerpt rides in the `commit` narration (the review→commit idiom):
    // the failed outcome never pollutes the run's own captured stderr.
    expect(run?.stderr).toBe("");
    expect(run?.commit).toEqual({ status: "failed", stderr: "pre-commit hook rejected" });
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a clean stage outcome to an ok run (nothing to stage) and still invalidates", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(stageBackend({ status: "clean" }), loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitStage(["reqs/REQ0001.yml"]);

    const run = controller.lastRun;
    expect(run?.op).toBe("git-stage");
    // The operation RESOLVED — a `clean` outcome is NARRATION (nothing to
    // stage), not failure: the badge stays ok and the outcome rides in the
    // `commit` field ("clean — nothing to stage").
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "clean" });
    // Success still invalidates: the strip cache cleared (a rescan is the
    // run's standing success contract; the refetch is cheap).
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a skipped stage outcome to an ok run (not a repo / deadline) and still invalidates", async () => {
    const loadCount = { calls: 0 };
    const { controller } = gitRunController(stageBackend({ status: "skipped" }), loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitStage(["reqs/REQ0001.yml"]);

    const run = controller.lastRun;
    expect(run?.op).toBe("git-stage");
    // Same as `clean`: the response RESOLVED — the skipped outcome is the
    // narration ("skipped"), never a failed badge.
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "skipped" });
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.gitStatusView).toBeUndefined();
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a clean commit outcome to an ok run (nothing staged) and still invalidates", async () => {
    const loadCount = { calls: 0 };
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-commit") return Promise.resolve({ status: "clean" });
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = gitRunController(backend, loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitCommit("nothing to commit");

    const run = controller.lastRun;
    expect(run?.op).toBe("git-commit");
    // The commit RESPONDED "nothing staged" — narration ("clean — nothing
    // staged"), not failure: ok badge, outcome in `commit`.
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "clean" });
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.runInProgress).toBeUndefined();
  });

  it("maps a skipped commit outcome to an ok run and still invalidates", async () => {
    const loadCount = { calls: 0 };
    const backend = vi.fn((operation: string) => {
      if (operation === "doorstop.git-commit") return Promise.resolve({ status: "skipped" });
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = gitRunController(backend, loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitCommit("nothing to commit");

    const run = controller.lastRun;
    expect(run?.op).toBe("git-commit");
    // `skipped` (not a repo / deadline) is an outcome of a RESOLVED
    // response — ok badge, "skipped" narration.
    expect(run?.status).toBe("ok");
    expect(run?.commit).toEqual({ status: "skipped" });
    expect(loadCount.calls).toBe(loadsBefore + 1);
    expect(controller.runInProgress).toBeUndefined();
  });

  it("a rejected request commits an error run, does NOT invalidate, and clears runInProgress", async () => {
    const loadCount = { calls: 0 };
    const backend = vi.fn((operation: string) => {
      // A rejection thrown synchronously by the mocked backend surface
      // (the bridge rejecting the request) lands in the controller's catch.
      if (operation === "doorstop.git-commit") throw new Error("bridge hiccup");
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const { controller } = gitRunController(backend, loadCount);
    await settle();
    const loadsBefore = loadCount.calls;

    await controller.runGitCommit("doomed");

    const run = controller.lastRun;
    expect(run?.status).toBe("error");
    if (run?.status === "error") expect(run.errorMessage).toContain("bridge hiccup");
    expect(run?.op).toBe("git-commit");
    expect(run?.commit).toBeUndefined();
    expect(loadCount.calls).toBe(loadsBefore);
    expect(controller.runInProgress).toBeUndefined();
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
