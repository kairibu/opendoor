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
  PluginRuntimeContext,
  TerminalCommandRun,
  TerminalCommandRunHandle,
  Workspace,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, DoorstopIndex, ItemRecord } from "./doorstop-contract.js";
import { buildDoorstopIndex } from "./doorstop-model.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import { createFakeFiles, type FakeWorkspaceFiles } from "./test-support.js";

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
  /** Provider metadata to attach to the workspace (backend-vs-terminal gating). */
  provider?: Workspace["provider"];
  insertText?: Mock;
  focusPrompt?: Mock;
  runCommand?: Mock;
  backend?: Mock;
}

export interface PanelContextResult {
  context: WorkspacePanelContext;
  requestRender: Mock;
  insertText: Mock;
  focusPrompt: Mock;
  runCommand: Mock;
  backend: Mock | undefined;
}

/** One configurable panel context wrapping a fake files adapter plus spies for
 *  the surfaces the element/controller read at click time: `requestRender`,
 *  `prompt.insertText`, a `focusPrompt` widening, `terminal.runCommand`, and
 *  the optional `backend.request` surface plus the workspace `provider`
 *  metadata that gates the backend path. Without `hook.backend` the context
 *  carries no `backend` property (exactly the unpaired real shape). */
export function panelContext(hook: PanelContextHook = {}): PanelContextResult {
  const requestRender = vi.fn();
  const insertText = hook.insertText ?? vi.fn();
  const focusPrompt = hook.focusPrompt ?? vi.fn();
  const runCommand = hook.runCommand ?? vi.fn(() => Promise.resolve(completedTerminalHandle()));
  const backend = hook.backend;
  const baseWorkspace = hook.workspace ?? doorstopWorkspace;
  const workspace = hook.provider === undefined ? baseWorkspace : { ...baseWorkspace, provider: hook.provider };
  const files: FakeWorkspaceFiles = hook.fake ?? createFakeFiles();
  const context: WorkspacePanelContext & { focusPrompt: Mock } = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace,
    state: {
      selectedWorkspace: workspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
    files: files.files,
    host: { requestRender },
    prompt: { insertText, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand },
    // The optional `backend` field is only present when the hook supplied one
    // (exactOptionalPropertyTypes forbids an explicit undefined write).
    ...(backend === undefined ? {} : { backend: { request: backend } }),
    focusPrompt,
  };
  return { context, requestRender, insertText, focusPrompt, runCommand, backend };
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

/** A full `PluginRuntimeContext` with no-op host methods; `patch` overrides
 *  individual entries (usually the navigation/refresh spies). */
export function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: {
      selectedWorkspace: doorstopWorkspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
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
