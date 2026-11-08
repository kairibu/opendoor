// ---------------------------------------------------------------------------
// Shared test fixture factories for the opendoor suite (test-only module,
// excluded from the runtime build by scripts/build-plugin.mjs and from the
// coverage `include` set: only reachable from *.test.ts).
//
// This module is deliberately DOM-free so the node-env suites
// (doorstop-panel.test.ts, doorstop-state.test.ts, …) can import it without
// pulling happy-dom in. The DOM-adjacent helpers here — `flushMicro(body?)`
// and `flushAll()` — type their element parameter structurally
// (`{ updateComplete }`) rather than via the custom-element class.
//
// `test-support.ts` stays focused on the workspace-files fake; everything that
// builds a real-shaped Doorstop document/item/result or a host context lives
// here.
// ---------------------------------------------------------------------------

import { vi, type Mock } from "vitest";
import type {
  PluginCatalog,
  PluginRuntimeContextV5,
  TerminalCommandRun,
  TerminalCommandRunHandle,
  Workspace,
  WorkspacePanelContextV5,
  WorkspacePanelNavigationV1,
} from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, DoorstopIndex, ItemRecord } from "./doorstop-contract.js";
import { buildDoorstopIndex } from "./doorstop-model.js";
import type { DoorstopWorkspaceResult } from "./browser/doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import { createFakeFiles, type FakeWorkspaceFiles } from "./test-support.js";

// --- read-only catalog fake (browser API v5) -----------------------------------

/** A minimal read-only catalog fake (browser API v5): the v5 callback
 *  contexts carry `catalog`/`backend` by construction, but the opendoor
 *  contributions never touch either surface — the stubs exist purely so the
 *  fixtures typecheck against the V5 context variants. The getters never
 *  resolve real data (the harness workspaces below are the stand-ins). */
export function fakeCatalog(machineId = "local"): PluginCatalog {
  return {
    machineId,
    version: 1,
    projects: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("fakeCatalog: not implemented")),
    },
    workspaces: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("fakeCatalog: not implemented")),
    },
    sessions: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("fakeCatalog: not implemented")),
    },
  } satisfies PluginCatalog;
}

// --- document / item / index fixtures ------------------------------------------

/** Canonical document config factory: the byte-identical shape the panel,
 *  panel-element and diff suites each carried a copy of. `configPath` is
 *  derived from `directoryPath` (with `""` mapping to `.`, matching the state
 *  suite's old local factory), so overriding only `directoryPath` never yields
 *  an inconsistent fixture. `parentPrefix` is only present when overridden
 *  (exactOptionalPropertyTypes forbids an explicit `undefined` write). */
export function makeDocument(overrides: Partial<DoorstopDocumentConfig> = {}): DoorstopDocumentConfig {
  const directoryPath = overrides.directoryPath ?? "reqs";
  return {
    directoryPath,
    configPath: overrides.configPath ?? `${directoryPath === "" ? "." : directoryPath}/.doorstop.yml`,
    prefix: overrides.prefix ?? "REQ",
    digits: overrides.digits ?? 4,
    separator: overrides.separator ?? "",
    itemformat: overrides.itemformat ?? "yaml",
    extra: overrides.extra ?? {},
    ...(overrides.parentPrefix === undefined ? {} : { parentPrefix: overrides.parentPrefix }),
  };
}

/** Canonical item factory: overrides-object form so every call-site shape in
 *  the suite unifies on one signature. `path` defaults to `<uid>.yml`; the
 *  optional `header`/`references` fields are only present when overridden. */
export function makeItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    uid: overrides.uid ?? "REQ0001",
    documentPrefix: overrides.documentPrefix ?? "REQ",
    path: overrides.path ?? `${overrides.uid ?? "REQ0001"}.yml`,
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

/** Canonical result builder: a genuine index (real `buildDoorstopIndex` +
 *  `computeItemStates` chains) over the given items/documents, so callers run
 *  against the real shape instead of a stub that could drift from
 *  `DoorstopIndex`. */
export function makeResult(
  items: ItemRecord[],
  documents: DoorstopDocumentConfig[] = [makeDocument()],
  diagnostics: DoorstopIndex["diagnostics"] = [],
  knownFilePaths: ReadonlySet<string> = new Set(),
): DoorstopWorkspaceResult {
  const index = buildDoorstopIndex(documents, items, diagnostics, knownFilePaths);
  computeItemStates(index);
  return { index, settings: DEFAULT_OPENDOOR_SETTINGS };
}

// --- the standard tree ----------------------------------------------------------

/** The standard tree the panel tests render: REQ ← [TST], with one suspect
 *  link (REQ0002 → REQ0001 recorded against a stale stamp), one reviewed
 *  item (REQ0001), one clean child link (TST002 → REQ0001 with the current
 *  link-record stamp), and a missing reference (docs/gone.md). */
export function makeTreeResult(): DoorstopWorkspaceResult {
  const reqConfig = makeDocument({ directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 4 });
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
  // REQ0001 was reviewed against its current fingerprint.
  req0001.reviewed = computeItemStamp(req0001, reqConfig, true);
  // TST002 records the CURRENT link-record stamp of REQ0001 → ok link.
  const parentStamp = computeItemStamp(req0001, reqConfig, false);
  const req0002 = makeItem({
    uid: "REQ0002",
    documentPrefix: "REQ",
    path: "reqs/REQ0002.yml",
    level: "1.1",
    header: "Capacity allocation",
    text: "The system shall do Y.",
    ref: "docs/spec.md",
    references: [{ type: "file", path: "docs/gone.md" }],
    links: [{ uid: "REQ0001", fingerprint: "STALE-stamp-0123456789" }],
    attributes: { owner: "team-a", priority: 2 },
  });
  const tst001 = makeItem({
    uid: "TST001",
    documentPrefix: "TST",
    path: "tests/TST001.yml",
    level: "1.0",
    text: "Verify X.",
  });
  const tst002 = makeItem({
    uid: "TST002",
    documentPrefix: "TST",
    path: "tests/TST002.yml",
    level: "1.1",
    text: "Verify X end-to-end.",
    links: [{ uid: "REQ0001", fingerprint: parentStamp }],
  });
  const knownFilePaths = new Set([
    "reqs/REQ0001.yml",
    "reqs/REQ0002.yml",
    "tests/TST001.yml",
    "tests/TST002.yml",
    "docs/spec.md",
  ]);
  return makeResult([req0001, req0002, tst001, tst002], [reqConfig, tstConfig], [], knownFilePaths);
}

// --- workspace / host context fixtures -----------------------------------------

export const doorstopWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

/** A workspace identical to `doorstopWorkspace` but with the given id. */
export function makeWorkspace(id: Workspace["id"]): Workspace {
  return { ...doorstopWorkspace, id };
}

export interface PanelContextHook {
  /** Fake workspace-files adapter; defaults to an empty `createFakeFiles()`. */
  fake?: FakeWorkspaceFiles;
  workspace?: Workspace;
  /** Provider metadata to attach to the workspace (peer-vs-terminal gating). */
  provider?: Workspace["provider"];
  insertText?: Mock;
  focusPrompt?: Mock;
  runCommand?: Mock;
  peer?: Mock;
  /** Build the v5 openChannel-only peer shape (a legal `PluginPeer` with
   *  `request?: undefined`; the surface also exists on v4): the
   *  paired-backend gate must treat it as unpaired and fall back to the
   *  terminal instead of silently no-oping. */
  peerChannelOnly?: boolean;
  /** Deep-link navigation harness (plan Phase C step C2): when supplied, the
   *  context carries this `navigation` — a real-shaped
   *  `WorkspacePanelNavigationV1` whose backing `query` record is MUTABLE (a
   *  test simulates a URL change by mutating it and re-rendering) and whose
   *  `set` records every call for write assertions. See
   *  {@link navigationHarness}. */
  navigation?: PanelNavigationHarness;
}

export interface PanelContextResult {
  context: WorkspacePanelContextV5;
  requestRender: Mock;
  insertText: Mock;
  focusPrompt: Mock;
  runCommand: Mock;
  peer: Mock | undefined;
  navigation: PanelNavigationHarness | undefined;
}

/** Test harness for the panel deep-link navigation (plan Phase C step
 *  C2): a real `WorkspacePanelNavigationV1` shape over a mutable backing
 *  query record (tests simulate URL changes — back/forward — by mutating
 *  `query` and re-rendering) plus a `setCalls` log of every controller write
 *  (`{ key, value, replace }` — the controller's `undefined` value writes
 *  are recorded as `undefined`, matching the clearing semantics). */
export interface PanelNavigationHarness extends WorkspacePanelNavigationV1 {
  /** The mutable backing record `query` reads. Mutate + re-render to
   *  simulate navigation. */
  backingQuery: Record<string, string | readonly string[]>;
  /** Every `navigation.set` call, in call order. */
  setCalls: Array<{ key: string; value: string | number | boolean | readonly (string | number | boolean)[] | undefined | null; replace: boolean | undefined }>;
}

/** Build one deep-link navigation harness with the given initial query. */
export function navigationHarness(initial: Record<string, string> = {}): PanelNavigationHarness {
  const backingQuery: Record<string, string | readonly string[]> = { ...initial };
  const setCalls: PanelNavigationHarness["setCalls"] = [];
  const navigation: PanelNavigationHarness = {
    version: 1,
    contributionId: "opendoor:workspace.doorstop",
    get query(): Readonly<Record<string, string | readonly string[]>> {
      return backingQuery;
    },
    set: (key, value, options) => {
      setCalls.push({ key, value, replace: options?.replace });
      // Mirror the host's namespaced-record semantics closely enough for
      // round-trip tests: a real value writes the key, undefined/null clears it.
      if (value === undefined || value === null) delete backingQuery[key];
      else backingQuery[key] = String(value);
    },
    backingQuery,
    setCalls,
  };
  return navigation;
}

/** One configurable panel context wrapping a fake files adapter plus spies for
 *  the surfaces the element/controller read at click time: `requestRender`,
 *  `prompt.insertText`, a `focusPrompt` widening, `terminal.runCommand`, and
 *  the optional `peer.request` surface plus the workspace `provider`
 *  metadata that gates the peer path. Without `hook.peer` the context
 *  carries no `peer` property (exactly the unpaired real shape). */
export function panelContext(hook: PanelContextHook = {}): PanelContextResult {
  const requestRender = vi.fn();
  const insertText = hook.insertText ?? vi.fn();
  const focusPrompt = hook.focusPrompt ?? vi.fn();
  const runCommand = hook.runCommand ?? vi.fn(() => Promise.resolve(completedTerminalHandle()));
  const peerRequest = hook.peer;
  const baseWorkspace = hook.workspace ?? doorstopWorkspace;
  const workspace = hook.provider === undefined ? baseWorkspace : { ...baseWorkspace, provider: hook.provider };
  const files: FakeWorkspaceFiles = hook.fake ?? createFakeFiles();
  const navigation = hook.navigation;
  const context: WorkspacePanelContextV5 & { focusPrompt: Mock } = {
    machine: { id: "local", name: "local", kind: "local" },
    // v5 contexts carry catalog/backend by construction; the plugin never
    // consults the read-only catalog (which is the reason it does NOT
    // declare the host catalog capability), so the fake is inert.
    catalog: fakeCatalog(),
    workspace,
    state: {
      selectedWorkspace: workspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "workspace",
    },
    files: files.files,
    host: { requestRender },
    prompt: { insertText, getText: () => "", getSelection: () => null },
    // pi-web 1.202610.3 made `navigate` a required member of
    // `WorkspacePanelContext` (absent in 1.202609.1). The plugin never calls
    // it, so the fixture stubs a no-op destination navigation.
    navigate: async () => undefined,
    terminal: { open: () => undefined, runCommand },
    // The peer field is only present when the hook supplied one
    // (exactOptionalPropertyTypes forbids an explicit undefined write). The
    // v5 peer is a request handler (the fake never needs openChannel), unless
    // `peerChannelOnly` asks for the openChannel-only variant that must fall
    // back to the terminal.
    ...(hook.peerChannelOnly === true
      ? { peer: { openChannel: openChannelOnlyStub } }
      : peerRequest === undefined
        ? {}
        : { peer: { request: peerRequest } }),
    // The optional `navigation` (deep links) is only present when the hook
    // supplied one (exactOptionalPropertyTypes forbids an explicit undefined
    // write) — exactly the absent-navigation shape of older hosts.
    ...(navigation === undefined ? {} : { navigation }),
    focusPrompt,
  };
  return { context, requestRender, insertText, focusPrompt, runCommand, peer: peerRequest, navigation };
}

/** The `openChannel` of the openChannel-only `PluginPeer` fixture: the tests
 *  that use it only assert the terminal fallback, so the channel is never
 *  opened (rejecting keeps the stub honest if that ever changes). */
function openChannelOnlyStub(): Promise<never> {
  return Promise.reject(new Error("openChannel-only peer fixture: openChannel is not exercised"));
}

/** A minimal resolved `TerminalCommandRunHandle` for the default runCommand
 *  mock (only the panel-element suite inspects it; the type is structural so
 *  this module stays import-light). */
function completedTerminalHandle(): TerminalCommandRunHandle {
  const run: TerminalCommandRun = {
    id: "run-1",
    origin: "opendoor:workspace.doorstop",
    projectId: "project-1",
    workspaceId: "workspace-1",
    terminalId: "terminal-1",
    title: "Doorstop: validate",
    command: "doorstop",
    status: "succeeded",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metadata: { "opendoor.op": "validate" },
  };
  return { run, completed: Promise.resolve(run) };
}

/** A full v5 `PluginRuntimeContextV5` with no-op host methods; `patch`
 *  overrides individual entries (usually the navigation/refresh spies). */
export function runtimeContext(patch: Partial<PluginRuntimeContextV5> = {}): PluginRuntimeContextV5 {
  const noop = () => undefined;
  return {
    // v5 contexts carry catalog/backend by construction (never consulted by
    // the opendoor actions); the peer surface stays absent — this plugin is
    // browser-only at runtime scope.
    catalog: fakeCatalog(),
    state: {
      selectedWorkspace: doorstopWorkspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "workspace",
    },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    // pi-web 1.202610.3 requires `navigate` on `PluginRuntimeContext` (it was
    // absent in 1.202609.1); the runtime fixture navigates nowhere.
    navigate: async () => undefined,
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

// --- async settling ------------------------------------------------------------

/** How many microtask turns a bare `await settle()` waits for a resolved
 *  promise chain to flush. A magic number, but named and shared so every
 *  test's timing assumption is uniform. */
const SETTLE_TICKS = 10;

/** Drain microtask work (10 promise turns). */
export async function settle(): Promise<void> {
  for (let index = 0; index < SETTLE_TICKS; index += 1) await Promise.resolve();
}

/** Flush a Lit element (when given) and all promise-based work: awaits
 *  `updateComplete`, then the microtask turns `settle()` drains. This is the
 *  element suite's original timing contract (no macrotask turn), so element
 *  tests keep catching work that a timer has not yet run. The parameter is
 *  structural so node-env callers can pass nothing. */
export async function flushMicro(body?: { updateComplete: Promise<unknown> }): Promise<void> {
  if (body !== undefined) await body.updateComplete;
  await settle();
}

/** Drain one macrotask turn: the deferred label-cache loads in the
 *  contributions suite land on `setTimeout`, so a single timer flush
 *  deterministically lets any number of landed loads run. */
export async function flushAll(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
