// @vitest-environment happy-dom
//
// Shared scaffolding for the split element tests (doorstop-panel-element.test.ts
// and sections/*.test.ts). Imported, never run directly: each test file
// registers `afterEach(resetElementTestEnvironment)` itself, so a file's DOM
// state never leaks between tests. (The split removed these helpers from the
// individual test files; see plans/plan-browser-split.md section 6.3.)

import { vi, type Mock } from "vitest";
import type { TerminalCommandRun, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, ItemRecord } from "../doorstop-contract.js";
import {
  DOORSTOP_GIT_STATUS_OPERATION,
  type DoorstopBaselineResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopRunResponse,
} from "../doorstop-backend-contract.js";
import { computeItemStamp } from "../doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import {
  bodyElementTag,
  defineDoorstopPanelElements,
  type DoorstopPanelBodyElement,
} from "./doorstop-panel-elements.js";
import {
  flushMicro,
  makeDocument,
  makeItem,
  makeResult,
  makeTreeResult,
  panelContext,
  settle,
} from "../test-fixtures.js";

/** Provider metadata variants for the Phase D dispatch tests: the opendoor
 *  provider enables the backend path, the git provider (the usual fallback
 *  owner) and a request-disabled opendoor provider force the terminal path. */
export const opendoorProvider: Workspace["provider"] = {
  pluginId: "opendoor",
  capabilities: { request: true, remove: false },
};
export const opendoorNoRequestProvider: Workspace["provider"] = {
  pluginId: "opendoor",
  capabilities: { request: false, remove: false },
};
export const gitProvider: Workspace["provider"] = {
  pluginId: "git",
  capabilities: { request: true, remove: false },
};

/** Access to `window.confirm` for stubbing — happy-dom's Window does not
 *  implement confirm, so tests install a stub here and the afterEach removes
 *  it (the optional field tolerates the assignment under exactOptional). */
export type WindowWithConfirm = { confirm?: (message?: string) => boolean };

export function stubConfirm(result: boolean): Mock {
  const spy = vi.fn(() => result);
  (window as unknown as WindowWithConfirm).confirm = spy;
  return spy;
}

// --- small real-shape fixtures ---------------------------------------------------------

/** The REQ document config with an extended REVIEWED attribute ("owner") —
 *  the shape the "Changes since review" tests need so the field diff and the
 *  stamp both cover it. */
export function makeReviewAttrConfig(): DoorstopDocumentConfig {
  return makeDocument({
    directoryPath: "reqs",
    configPath: "reqs/.doorstop.yml",
    prefix: "REQ",
    digits: 4,
    extra: { attributes: { reviewed: ["owner"] } },
  });
}

/** A baseline blob whose parsed item stamps to `item.reviewed`: the item's
 *  pre-edit content (the reviewed version of the fixture below). Extended
 *  attributes are TOP-LEVEL item keys (Doorstop's own file shape — the
 *  model chain's `attributes` bucket is everything not modeled), so they are

/** A baseline blob whose parsed item stamps to `item.reviewed`: the item's
 *  pre-edit content (the reviewed version of the fixture below). Extended
 *  attributes are TOP-LEVEL item keys (Doorstop's own file shape — the
 *  model chain's `attributes` bucket is everything not modeled), so they are
 *  serialized as siblings of text/links, not under an `attributes:` key. */
export function reviewedBlob(item: ItemRecord): string {
  const lines = [
    "active: true",
    "derived: false",
    "normative: true",
    `level: ${item.level}`,
    "text: |-",
    ...item.text.split("\n").map((line) => `  ${line}`),
    "links:",
    ...item.links.map((link) => `- ${link.uid}`),
    ...Object.entries(item.attributes).map(([key, value]) => `${key}: ${String(value)}`),
  ];
  return lines.join("\n");
}

/** A workspace with ONE edited-after-review item (REQ0003): `reviewed` holds
 *  the stamp of the reviewed version (parsed from {@link reviewedBlob}), the
 *  current content diverges (one added line, one added link, owner changed)

/** A workspace with ONE edited-after-review item (REQ0003): `reviewed` holds
 *  the stamp of the reviewed version (parsed from {@link reviewedBlob}), the
 *  current content diverges (one added line, one added link, owner changed)
 *  — so the item is unreviewed AND has a recoverable baseline. */
export function makeEditedItemResult(): DoorstopWorkspaceResult {
  const reqConfig = makeReviewAttrConfig();
  const tstConfig = makeDocument({
    directoryPath: "tests",
    configPath: "tests/.doorstop.yml",
    prefix: "TST",
    digits: 3,
    parentPrefix: "REQ",
  });
  const req0001 = makeItem({
    uid: "REQ0001",
    documentPrefix: "REQ",
    path: "reqs/REQ0001.yml",
    level: "1.0",
    text: "The system shall do X.",
  });
  req0001.reviewed = computeItemStamp(req0001, reqConfig, true);
  const oldVersion = makeItem({
    uid: "REQ0003",
    documentPrefix: "REQ",
    path: "reqs/REQ0003.yml",
    level: "1.2",
    text: "The system shall do Z.\nAnd approve.",
    links: [{ uid: "REQ0001", fingerprint: null }],
    attributes: { owner: "team-a" },
  });
  const current = makeItem({
    uid: "REQ0003",
    documentPrefix: "REQ",
    path: "reqs/REQ0003.yml",
    level: "1.2",
    text: "The system shall do Z.\nAnd approve.\nAsync.",
    links: [
      { uid: "REQ0001", fingerprint: null },
      { uid: "REQ0002", fingerprint: null },
    ],
    attributes: { owner: "team-b" },
  });
  // `reviewed` is the fingerprint of the REVIEWED (pre-edit) version.
  current.reviewed = computeItemStamp(oldVersion, reqConfig, true);
  const req0002 = makeItem({
    uid: "REQ0002",
    documentPrefix: "REQ",
    path: "reqs/REQ0002.yml",
    level: "1.1",
    text: "The system shall do Y.",
  });
  const knownFilePaths = new Set(["reqs/REQ0001.yml", "reqs/REQ0002.yml", "reqs/REQ0003.yml"]);
  return makeResult([req0001, req0002, current], [reqConfig, tstConfig], [], knownFilePaths);
}

/** A canned baseline response for the backend spies; callers override only

/** A canned baseline response for the backend spies; callers override only
 *  the fields their scenario cares about. */
export function makeBaselineResponse(overrides: Partial<DoorstopBaselineResponse> = {}): DoorstopBaselineResponse {
  return {
    git: true,
    source: "review-commit",
    candidates: [],
    ...overrides,
  };
}

/** A canned git-status response for the backend spies (plan-add-git-actions
 *  Phase D step 14): the mount-time `doorstop.git-status` auto-fetch fires
 *  on every backend-active mount, and answering it with a VALID status
 *  response keeps the strip's cached view honest on every mount (a
 *  run-shaped response would reject into a transient error view — harmless
 *  to assertions, but wrong). Callers override only the fields their

/** A canned git-status response for the backend spies (plan-add-git-actions
 *  Phase D step 14): the mount-time `doorstop.git-status` auto-fetch fires
 *  on every backend-active mount, and answering it with a VALID status
 *  response keeps the strip's cached view honest on every mount (a
 *  run-shaped response would reject into a transient error view — harmless
 *  to assertions, but wrong). Callers override only the fields their
 *  scenario cares about. */
export function makeGitStatusResponse(overrides: Partial<DoorstopGitStatusResponse> = {}): DoorstopGitStatusResponse {
  return {
    git: true,
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: 0,
    dirty: 0,
    files: [],
    ...overrides,
  };
}

/** Wrap a backend spy so the mount-time `doorstop.git-status` auto-fetch
 *  answers with a valid {@link makeGitStatusResponse} while every other
 *  operation delegates to `impl`. Use for every backend-active mount: the
 *  strip's cached view stays `"ready"` instead of landing on the transient

/** Wrap a backend spy so the mount-time `doorstop.git-status` auto-fetch
 *  answers with a valid {@link makeGitStatusResponse} while every other
 *  operation delegates to `impl`. Use for every backend-active mount: the
 *  strip's cached view stays `"ready"` instead of landing on the transient
 *  error view a run-shaped or `undefined` answer would produce. */
export function withGitStatusBackend(impl: (operation: string, input: unknown) => unknown | Promise<unknown>): Mock {
  return vi.fn((operation: string, input: unknown) =>
    operation === DOORSTOP_GIT_STATUS_OPERATION ? Promise.resolve(makeGitStatusResponse()) : impl(operation, input),
  );
}

/** Mount the body element over a controller driven by the given job, mirror
 *  the controller state onto it, and settle the first load. The bound context
 *  is the one returned, so action tests can assert on its spies exactly as

/** Mount the body element over a controller driven by the given job, mirror
 *  the controller state onto it, and settle the first load. The bound context
 *  is the one returned, so action tests can assert on its spies exactly as
 *  the element used them. */
export async function mountBody(
  job: DoorstopWorkspaceJob,
  hook: {
    insertText?: Mock;
    focusPrompt?: Mock;
    runCommand?: Mock;
    backend?: Mock;
    provider?: Workspace["provider"];
  } = {},
): Promise<{ body: DoorstopPanelBodyElement; controller: DoorstopWorkspaceController; context: ReturnType<typeof panelContext>["context"] }> {
  defineDoorstopPanelElements();
  const created = panelContext(hook);
  const controller = new DoorstopWorkspaceController({ isConnected: false }, created.context, job);
  const body = document.createElement(bodyElementTag) as DoorstopPanelBodyElement;
  bindBody(body, controller, created.context);
  document.body.append(body);
  await body.updateComplete;
  await settle();
  bindBody(body, controller, created.context);
  await flushMicro(body);
  return { body, controller, context: created.context };
}

// --- git strip + stage + commit (plan-add-git-actions Phase F item 23) -----------------

/** Mount a backend-active body with the connection flag RAISED: `mountBody`
 *  constructs the controller disconnected (isConnected false), so the
 *  mount-time `doorstop.git-status` auto-fetch lands DROPPED (the
 *  late-write guard) and leaves an orphaned `loading` view — re-rendering
 *  (requestUpdate → updated → ensureGitStatus's orphan guard) refetches
 *  it, and this time the landing sticks. Callers then see the strip's
 *  honest state on every assertion. */
export async function mountGitBody(
  backend: Mock,
  job: () => Promise<DoorstopWorkspaceResult> = () => Promise.resolve(makeTreeResult()),
): Promise<{
  body: DoorstopPanelBodyElement;
  controller: DoorstopWorkspaceController;
  context: ReturnType<typeof panelContext>["context"];
  backend: Mock;
}> {
  const mounted = await mountBody(job, { backend, provider: opendoorProvider });
  mounted.controller.hostConnected();
  bindBody(mounted.body, mounted.controller, mounted.context);
  await flushMicro(mounted.body);
  mounted.body.requestUpdate();
  bindBody(mounted.body, mounted.controller, mounted.context);
  await flushMicro(mounted.body);
  return { ...mounted, backend };
}

/** The `doorstop.git-status` calls a backend spy has seen so far. */
export function gitStatusCalls(backend: Mock): number {
  return backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_STATUS_OPERATION).length;
}

// --- per-item git staging (per-item Stage + row chips + row "git add") -----------------

/** One porcelain pair as the server would report it (the contract's
 *  `{path, index, workingTree}` — index is X/staged, workingTree is Y). */
export function gitStatusFile(
  path: string,
  index: DoorstopGitStatusFile["index"],
  workingTree: DoorstopGitStatusFile["workingTree"],
): DoorstopGitStatusFile {
  return { path, index, workingTree };
}

/** Select a row and mirror the controller's selection onto the body (the
 *  host render wiring `bindBody` stands in for). */
export async function selectItemRow(
  body: DoorstopPanelBodyElement,
  controller: DoorstopWorkspaceController,
  context: WorkspacePanelContext,
  uid: string,
): Promise<void> {
  body.shadowRoot?.querySelector<HTMLElement>(`.doorstop-item-row[data-uid="${uid}"]`)?.click();
  bindBody(body, controller, context);
  await flushMicro(body);
}

// --- test helpers ------------------------------------------------------------------------

/** Stand-in for the panel render wiring's property bindings: mirrors the
 *  controller's render inputs onto the body element exactly as the host
 *  template does. */
export function bindBody(
  body: DoorstopPanelBodyElement,
  controller: DoorstopWorkspaceController,
  context: WorkspacePanelContext,
): void {
  body.controller = controller;
  body.context = context;
  body.result = controller.result;
  body.loading = controller.loading;
  body.stale = controller.stale;
  body.error = controller.error;
  body.selectedUid = controller.selectedUid;
  body.selectedDocumentPrefix = controller.selectedDocumentPrefix;
  body.stateFilter = controller.stateFilter;
  body.search = controller.search;
  // Phase D: the run-state fields the Last-run section and button gating read.
  body.lastRun = controller.lastRun;
  body.runInProgress = controller.runInProgress;
  // Phase D step 15: the baseline-cache state the contributions wiring mirrors.
  body.baselineVersion = controller.baselineVersion;
  body.baselineInFlight = controller.baselineInFlight;
  // Phase D step 16: the git-status strip state the contributions wiring
  // mirrors (the strip renders the cached view; `aria-busy` reads in-flight).
  body.gitStatusView = controller.gitStatusView;
  body.gitStatusInFlight = controller.gitStatusInFlight;
}

/** A canned `DoorstopRunResponse` for the backend spies; callers override
 *  only the fields their scenario cares about. */
export function makeRunResponse(overrides: Partial<DoorstopRunResponse> = {}): DoorstopRunResponse {
  return {
    op: "validate",
    exitCode: 0,
    signal: null,
    stdout: "Validated 4 items.",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 12,
    ...overrides,
  };
}

/** Build a minimal TerminalCommandRun literal for the terminal spies; callers
 *  override only the fields their scenario cares about (title/command/status/
 *  metadata/completedAt). */
export function makeRun(overrides: Partial<TerminalCommandRun> = {}): TerminalCommandRun {
  return {
    id: "run-1",
    origin: "opendoor:workspace.doorstop",
    projectId: "project-1",
    workspaceId: "workspace-1",
    terminalId: "terminal-1",
    title: "Doorstop: validate",
    command: "doorstop",
    status: "succeeded",
    createdAt: new Date().toISOString(),
    metadata: { "opendoor.op": "validate" },
    ...overrides,
  };
}

/** Test-file `afterEach` hook: clears the mounted body and removes the
 *  `window.confirm` stub. exactOptionalPropertyTypes forbids an explicit
 *  `undefined` write to an optional field, so the stub is deleted. */
export function resetElementTestEnvironment(): void {
  document.body.replaceChildren();
  delete (window as unknown as WindowWithConfirm).confirm;
}
