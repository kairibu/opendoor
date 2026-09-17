// @vitest-environment happy-dom
//
// Coordinator/layout/render-root tests for the Doorstop panel body element
// (src/browser/doorstop-panel-element.ts). The section-specific describes now
// live in sections/*.test.ts; shared scaffolding lives in
// doorstop-panel-element-test-support.ts and is imported below.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Workspace } from "@jmfederico/pi-web/plugin-api";
import { type DoorstopWorkspaceJob } from "./doorstop-panel-controller.js";
import { type DoorstopWorkspaceResult } from "./doorstop-panel.js";
import {
  EMPTY_WORKSPACE_MESSAGE,
  type DoorstopPanelBodyElement,
} from "./doorstop-panel-elements.js";
import { text, tree } from "../test-support.js";
import {
  flushMicro,
  makeDocument,
  makeItem,
  makeResult,
  makeTreeResult,
  settle,
} from "../test-fixtures.js";
import {
  opendoorProvider,
  mountBody,
  bindBody,
  makeRunResponse,
  resetElementTestEnvironment,
} from "./doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

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
    await flushMicro(body);
    const alert = body.shadowRoot?.querySelector<HTMLElement>(".doorstop-error[role=alert]");
    expect(alert?.textContent).toBe("Workspace read failed: EACCES");
  });

  it("renders the stale notice as a button that rescans, and clears it", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    controller.stale = true;
    bindBody(body, controller, context);
    await flushMicro(body);
    const stale = body.shadowRoot?.querySelector<HTMLElement>(".doorstop-stale");
    expect(stale?.textContent).toBe("stale — refresh");
    // The stale notice is a button: clicking it rescans the workspace.
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());
    stale?.click();
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(1);

    controller.stale = false;
    bindBody(body, controller, context);
    await flushMicro(body);
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
    await flushMicro(body);
    const uidCells = [...root.querySelectorAll(".doorstop-item-uid")].map((cell) => cell.textContent);
    expect(uidCells).toEqual(["REQ0001", "REQ0002"]);

    // The "All" chip clears the document filter.
    const allChip = root.querySelector<HTMLElement>('.doorstop-doc-chip[data-prefix=""]');
    allChip?.click();
    expect(controller.selectedDocumentPrefix).toBe("");
    bindBody(body, controller, context);
    await flushMicro(body);
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
    const item = makeItem({ uid: "REQ0001", documentPrefix: "REQ", path: "reqs/REQ0001.yml", level: "1.0", text: "The system shall do X." });
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

describe("DoorstopPanelBodyElement (layout sections: actions / filters / palette / status bar)", () => {
  it("composes the panel sections in order", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // The panel body is: project-actions → (error alert) → viewer → action
    // palette → status bar. The error alert is a div, so the sections are the
    // direct <section> children. Before the first run the status bar renders
    // nothing (no row), and the palette shows its placeholder.
    const sections = [...root.children].filter((child) => child.tagName === "SECTION");
    expect(sections.map((section) => section.className)).toEqual([
      "doorstop-project-actions",
      "doorstop-viewer",
      "doorstop-action-palette",
    ]);
    expect(root.querySelector(".doorstop-status-bar")).toBeNull();
  });

  it("keeps the full section order (actions → viewer → palette → status bar) after a run", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // With a live run committed, the auto-expanded status bar is the LAST
    // section: project-actions → viewer → action-palette → status-bar
    // (the error alert is absent here, and the palette shows its placeholder
    // with nothing selected).
    const sections = [...root.children].filter((child) => child.tagName === "SECTION");
    expect(sections.map((section) => section.className)).toEqual([
      "doorstop-project-actions",
      "doorstop-viewer",
      "doorstop-action-palette",
      "doorstop-status-bar",
    ]);
    expect(root.querySelector(".doorstop-last-run")).not.toBeNull();
  });

  it("shows the project path as the project-actions heading", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // The heading is the workspace path's basename ("repo" for /repo); the
    // full path is the tooltip. Without a bound context the static
    // "Doorstop" label is the fallback.
    const title = root.querySelector(".doorstop-title");
    expect(title).not.toBeNull();
    expect(title?.textContent?.trim()).toBe("repo");
    expect(title?.getAttribute("title")).toBe("/repo");
  });

  it("renders the document/state/search filters in their own row above the split", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const viewer = root.querySelector(".doorstop-viewer");
    const filters = viewer?.querySelector(".doorstop-list-filters");
    const split = viewer?.querySelector(".doorstop-split");
    expect(filters).not.toBeNull();
    expect(split).not.toBeNull();
    if (viewer === null || filters === null || filters === undefined || split === null || split === undefined) {
      throw new Error("viewer/filters/split");
    }
    const viewerChildren = [...viewer.children];
    expect(viewerChildren.indexOf(filters)).toBeLessThan(viewerChildren.indexOf(split));
    // The filter row owns the doc chips, the state filter, and the search.
    expect(filters.querySelector(".doorstop-doc-chip")).not.toBeNull();
    expect(filters.querySelector(".doorstop-state-filter")).not.toBeNull();
    expect(filters.querySelector(".doorstop-search")).not.toBeNull();
    // The project-actions row no longer carries any of them.
    const actions = root.querySelector(".doorstop-project-actions");
    expect(actions?.querySelector(".doorstop-doc-chip")).toBeNull();
    expect(actions?.querySelector(".doorstop-state-filter")).toBeNull();
    expect(actions?.querySelector(".doorstop-search")).toBeNull();
  });

  it("shows a muted palette placeholder with no selection; hides the palette in findings and with no documents", async () => {
    // A tree with nothing selected: the palette is present at constant height
    // with the placeholder row only.
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const placeholder = root.querySelector(".doorstop-action-palette .doorstop-palette-placeholder");
    expect(placeholder?.textContent).toBe("Select an item…");
    expect(root.querySelectorAll(".doorstop-action-palette button")).toHaveLength(0);

    // The findings view has no palette at all.
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flushMicro(body);
    expect(root.querySelector(".doorstop-action-palette")).toBeNull();

    // A workspace with zero documents has no palette either.
    const noDocs = await mountBody(() => Promise.resolve(makeResult([], [])));
    expect(noDocs.body.shadowRoot?.querySelector(".doorstop-action-palette")).toBeNull();
  });

  it("moves the action row out of the detail pane into the panel-level palette", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    // The full action set lives in the palette section (placeholder replaced).
    const palette = root.querySelector(".doorstop-action-palette");
    expect(palette?.querySelector(".doorstop-palette-placeholder")).toBeNull();
    expect(palette?.querySelector(".doorstop-review")).not.toBeNull();
    expect(palette?.querySelector(".doorstop-clear")).not.toBeNull();
    expect(palette?.querySelector(".doorstop-link")).not.toBeNull();
    expect(palette?.querySelector(".doorstop-menu-toggle")).not.toBeNull();

    // The detail pane carries NO action buttons anymore (its remaining
    // buttons are link-row NAVIGATION buttons, which stay).
    const detailPane = root.querySelector(".doorstop-detail-pane");
    for (const selector of [
      ".doorstop-review",
      ".doorstop-clear",
      ".doorstop-edit",
      ".doorstop-unlink",
      ".doorstop-link",
      ".doorstop-menu-toggle",
      ".doorstop-target-input",
      ".doorstop-op",
      ".doorstop-actions",
    ]) {
      expect(detailPane?.querySelector(selector)).toBeNull();
    }
    expect(root.querySelector(".doorstop-actions")).toBeNull();
  });

  it("keeps the status bar (with its auto-expanded output) in the findings view", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    // Switch to the findings view: the palette must vanish, the status bar
    // (and its already-expanded output) must remain.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-action-palette")).toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();
  });
});
