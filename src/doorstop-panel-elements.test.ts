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
import { buildDoorstopIndex } from "./doorstop-model.js";
import { computeItemStamp, computeItemStates } from "./doorstop-state.js";
import {
  DoorstopWorkspaceController,
  type DoorstopWorkspaceHost,
  type DoorstopWorkspaceJob,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
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
  EMPTY_WORKSPACE_MESSAGE,
  filteredItems,
  shortFingerprint,
  STATE_CHIP_LABELS,
  stateChipKind,
  suspectParentItems,
  type DoorstopPanelBodyElement,
} from "./doorstop-panel-elements.js";
import { createFakeFiles, type FakeWorkspaceFiles } from "./test-support.js";

const doorstopWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
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
  return { index };
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
}

async function flush(body: DoorstopPanelBodyElement): Promise<void> {
  await body.updateComplete;
  await settle();
}

/** Build one panel context wrapping a fake files adapter plus spies for the
 *  surfaces the element reads at click time: `requestRender` (the
 *  controller's render path), `prompt.insertText`, a `focusPrompt` widening,
 *  and `terminal.runCommand`. */
function panelContext(hook: {
  insertText?: Mock;
  focusPrompt?: Mock;
  runCommand?: Mock;
} = {}): {
  context: WorkspacePanelContext;
  requestRender: Mock;
  insertText: Mock;
  focusPrompt: Mock;
  runCommand: Mock;
} {
  const requestRender = vi.fn();
  const insertText = hook.insertText ?? vi.fn();
  const focusPrompt = hook.focusPrompt ?? vi.fn();
  const runCommand = hook.runCommand ?? vi.fn(() => Promise.resolve(completedHandle()));
  const files: FakeWorkspaceFiles = createFakeFiles();
  const context: WorkspacePanelContext & { focusPrompt: Mock } = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace: doorstopWorkspace,
    state: {
      selectedWorkspace: doorstopWorkspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
    files: files.files,
    host: { requestRender },
    prompt: { insertText, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand },
    focusPrompt,
  };
  return { context, requestRender, insertText, focusPrompt, runCommand };
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