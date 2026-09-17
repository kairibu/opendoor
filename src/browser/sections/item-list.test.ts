// @vitest-environment happy-dom
//
// Element-level tests for the item-list section (src/browser/sections/item-list.ts):
// document/state/search filters, item rows, configured attributes and the
// findings view. Describe blocks moved verbatim from
// doorstop-panel-element.test.ts; shared scaffolding lives in
// ../doorstop-panel-element-test-support.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { computeItemStamp } from "../../doorstop-state.js";
import { loadDoorstopWorkspace } from "../doorstop-panel.js";
import {
  FINDINGS_EMPTY_HINT,
  FINDINGS_EMPTY_MESSAGE,
  FINDINGS_PLUGIN_LOCAL_NOTE,
  findingsCountText,
  findingsViewCounts,
  findingsViewRows,
  type DoorstopPanelBodyElement,
} from "../doorstop-panel-elements.js";
import { createFakeFiles, dirEntry, fileEntry, text, tree } from "../../test-support.js";
import {
  flushMicro,
  makeDocument,
  makeItem,
  makeResult,
  makeTreeResult,
  settle,
} from "../../test-fixtures.js";
import {
  mountBody,
  bindBody,
  resetElementTestEnvironment,
} from "../doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

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
    await flushMicro(body);
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
    await flushMicro(body);
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
    await flushMicro(body);
    expect([...root.querySelectorAll(".doorstop-item-uid")].map((cell) => cell.textContent)).toEqual(["TST001", "TST002"]);

    // A filter with no matches renders the muted no-match copy.
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(root.textContent).toContain("No items match the current document, state, or search filters.");
  });

  it("shows the no-item copy when a document has items but none parse", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeResult([], [makeDocument()])));
    expect(body.shadowRoot?.textContent).toContain("No Doorstop items found");
  });
});

describe("DoorstopPanelBodyElement (row insert-into-prompt arrow)", () => {
  it("renders the arrow on every row — including clean rows — with the item's UID in the title", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");

    const rows = [...root.querySelectorAll<HTMLElement>(".doorstop-item-row")];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.querySelector(".doorstop-item-insert")).not.toBeNull();
    }

    const req0002Arrow = root.querySelector('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-insert');
    expect(req0002Arrow?.getAttribute("title")).toBe("Insert REQ0002 into the prompt");
    // Pointer-only contract: hidden from the accessibility tree (the row
    // itself stays the accessible target).
    expect(req0002Arrow?.getAttribute("aria-hidden")).toBe("true");

    // A clean row (no git affordance) still gets the arrow, unlike
    // `.doorstop-item-add` which is git-state-dependent.
    const cleanRow = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]');
    expect(cleanRow?.querySelector(".doorstop-item-add")).toBeNull();
    expect(cleanRow?.querySelector(".doorstop-item-insert")).not.toBeNull();
  });

  it("inserts exactly the item UID into the prompt and does not change the selection", async () => {
    const insertText = vi.fn();
    const focusPrompt = vi.fn();
    const { body, controller } = await mountBody(() => Promise.resolve(makeTreeResult()), { insertText, focusPrompt });
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    expect(controller.selectedUid).toBeUndefined();

    root
      .querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-insert')
      ?.click();
    await flushMicro(body);

    expect(insertText).toHaveBeenLastCalledWith("REQ0002");
    // The full insertPrompt contract: the text lands AND the prompt is focused.
    expect(focusPrompt).toHaveBeenCalled();
    // stopPropagation: clicking the nested arrow never selected the row.
    expect(controller.selectedUid).toBeUndefined();
  });

  it("omits the arrow when there is no panel context (insertPrompt would be a silent no-op)", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    expect(root.querySelector(".doorstop-item-insert")).not.toBeNull();

    body.context = undefined;
    await body.updateComplete;

    expect(root.querySelector(".doorstop-item-insert")).toBeNull();
    // The rows themselves stay rendered; only the dead affordance is gated.
    expect(root.querySelector(".doorstop-item-row")).not.toBeNull();
  });
});

describe("DoorstopPanelBodyElement (showAdditionalAttribute rows)", () => {
  it("renders no attribute span by default (the setting absent from the settings file)", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // The default rows are unchanged: four rows, no attribute span anywhere,
    // and the container keeps the original 4-column (no attrs track) grid.
    expect(root.querySelectorAll(".doorstop-item-row")).toHaveLength(4);
    expect(root.querySelectorAll(".doorstop-item-attrs")).toHaveLength(0);
    expect(root.querySelector(".doorstop-items")?.classList.contains("has-item-attrs")).toBe(false);
  });

  it("renders exactly the configured keys as `key: value` in order, skipping absent keys and never leaking others", async () => {
    const item = makeItem({
      uid: "REQ0001",
      text: "The system shall do X.",
      attributes: { component: "auth", priority: 2, other: "ignored" },
    });
    const base = makeResult([item], [makeDocument()]);
    const { body } = await mountBody(() =>
      Promise.resolve({
        index: base.index,
        settings: { ...base.settings, showAdditionalAttribute: ["component", "priority", "text"] },
      }),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]');
    if (row === null) throw new Error("row");
    // The configured list opts into the 5-column track so the attrs span has
    // a real column to live in.
    expect(root.querySelector(".doorstop-items")?.classList.contains("has-item-attrs")).toBe(true);
    const attrs = row.querySelector(".doorstop-item-attrs");
    expect(attrs?.textContent).toBe('component: "auth" · priority: 2 · text: "The system shall do X."');
    expect(attrs?.textContent).not.toContain("other");
  });

  it("omits the attribute span on a row that has none of the configured keys", async () => {
    const withKey = makeItem({ uid: "REQ0001", text: "one", attributes: { component: "auth" } });
    const without = makeItem({ uid: "REQ0002", text: "two" });
    const base = makeResult([withKey, without], [makeDocument()]);
    const { body } = await mountBody(() =>
      Promise.resolve({
        index: base.index,
        settings: { ...base.settings, showAdditionalAttribute: ["component"] },
      }),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    expect(root.querySelector('.doorstop-item-row[data-uid="REQ0001"] .doorstop-item-attrs')?.textContent).toBe(
      'component: "auth"',
    );
    expect(root.querySelector('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-attrs')).toBeNull();
  });

  it("escapes a hostile attribute value: the literal text renders and no element is parsed", async () => {
    const item = makeItem({ uid: "REQ0001", attributes: { note: "<img src=x onerror=alert(6)>" } });
    const base = makeResult([item], [makeDocument()]);
    const { body } = await mountBody(() =>
      Promise.resolve({
        index: base.index,
        settings: { ...base.settings, showAdditionalAttribute: ["note"] },
      }),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]');
    if (row === null) throw new Error("row");
    const attrs = row.querySelector(".doorstop-item-attrs");
    expect(attrs?.textContent).toBe('note: "<img src=x onerror=alert(6)>"');
    // Scoped to the attribute span: the row now legitimately carries the
    // insert-into-prompt <svg>, so the hostile value is asserted to have
    // parsed into no element of its own.
    expect(attrs?.querySelectorAll("img, svg")).toHaveLength(0);
  });

  it("flows a settings-file showAdditionalAttribute through the full load → mount pipeline", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("reqs", "reqs")]),
        "reqs": tree([fileEntry(".doorstop.yml", "reqs/.doorstop.yml"), fileEntry("REQ0001.yml", "reqs/REQ0001.yml")]),
      },
      reads: {
        ".pi-web/opendoor.json": text(JSON.stringify({ version: 1, showAdditionalAttribute: ["component"] })),
        "reqs/.doorstop.yml": text("settings:\n  prefix: REQ\n  digits: 4"),
        "reqs/REQ0001.yml": text("text: The system shall do X.\ncomponent: auth"),
      },
    });
    const { body, controller, context } = await mountBody(() => loadDoorstopWorkspace(files));
    // loadDoorstopWorkspace's async chain is a few frames longer than a bare
    // Promise.resolve result — give it room to land before asserting.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    expect(body.result?.settings.showAdditionalAttribute).toEqual(["component"]);
    expect(root.querySelector('.doorstop-item-row[data-uid="REQ0001"] .doorstop-item-attrs')?.textContent).toBe(
      'component: "auth"',
    );
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
    await flushMicro(body);

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
    await flushMicro(body);
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
    await flushMicro(body);
    let select = root.querySelector<HTMLSelectElement>(".doorstop-state-filter");
    let search = root.querySelector<HTMLInputElement>(".doorstop-search");
    expect(select?.value).toBe("suspect-link");
    expect(search?.value).toBe("REQ0002");
    expect(root.querySelector('.doorstop-doc-chip[data-prefix="REQ"]')?.classList.contains("is-selected")).toBe(true);

    // The findings view removes the items-only controls entirely…
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flushMicro(body);
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
    await flushMicro(body);
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
    await flushMicro(body);

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
    await flushMicro(body);

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
    await flushMicro(body);

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
    await flushMicro(body);
    expect(root.querySelector('.doorstop-item-row[data-uid="TST001"]')).toBeNull();

    // Switch to findings and click TST001's UID row.
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flushMicro(body);
    const uidButton = root.querySelector<HTMLElement>('.doorstop-finding-uid[data-uid="TST001"]');
    expect(uidButton).not.toBeNull();
    uidButton?.click();

    // Navigation cleared the filters, selected TST001, and switched to Items.
    expect(controller.selectedDocumentPrefix).toBe("");
    expect(controller.stateFilter).toBeUndefined();
    expect(controller.search).toBe("");
    expect(controller.selectedUid).toBe("TST001");
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(root.querySelector<HTMLElement>(".doorstop-view-items")?.getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector('.doorstop-item-row[data-uid="TST001"]')).not.toBeNull();
    expect(root.querySelector(".doorstop-detail-pane")?.textContent).toContain("TST001");
  });

  it("shows the clean-tree empty state with the plugin-local hint when there are no findings", async () => {
    const reqConfig = makeDocument();
    const req0001 = makeItem({ uid: "REQ0001", documentPrefix: "REQ", path: "reqs/REQ0001.yml", text: "The system shall do X." });
    // Reviewed against the current fingerprint → no state findings at all.
    req0001.reviewed = computeItemStamp(req0001, reqConfig, true);
    const result = makeResult([req0001], [reqConfig], []);
    const { body } = await mountBody(() => Promise.resolve(result));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>(".doorstop-view-findings")?.click();
    await flushMicro(body);

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
    await flushMicro(body);
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
