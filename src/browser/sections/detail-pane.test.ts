// @vitest-environment happy-dom
//
// Element-level tests for the detail-pane section (src/browser/sections/detail-pane.ts):
// links, references, attributes, findings and changes since review. Describe
// blocks moved verbatim from doorstop-panel-element.test.ts; shared scaffolding
// lives in ../doorstop-panel-element-test-support.ts.

import { afterEach, describe, expect, it } from "vitest";
import { type DoorstopIndex } from "../../doorstop-contract.js";
import { computeItemStamp } from "../../doorstop-state.js";
import { shortFingerprint, type DoorstopPanelBodyElement } from "../doorstop-panel-elements.js";
import { text } from "../../test-support.js";
import {
  flushMicro,
  makeDocument,
  makeItem,
  makeResult,
  makeTreeResult,
  settle,
} from "../../test-fixtures.js";
import {
  opendoorProvider,
  reviewedBlob,
  makeEditedItemResult,
  makeBaselineResponse,
  withGitStatusBackend,
  mountBody,
  bindBody,
  makeRunResponse,
  resetElementTestEnvironment,
} from "../doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

describe("DoorstopPanelBodyElement (detail pane: links, references, attributes, findings)", () => {
  it("shows suspect links with recorded vs current fingerprint shorts and navigates on click", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    const row = root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]');
    row?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

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
    await flushMicro(body);
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
    await flushMicro(body);
    expect(root.querySelector('[aria-label="Parent links"]')?.textContent).toContain("ok");

    // Select REQ0001: TST002 shows up as a child link, clickable.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
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
    await flushMicro(body);

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
    await flushMicro(body);

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
    await flushMicro(body);
    expect(root.querySelector(".doorstop-detail")?.textContent).toContain("No local findings for this item.");
  });

  it("never injects raw HTML from text, header, attributes, uid, link UIDs, or diagnostics", async () => {
    const evil = makeItem({
      uid: "REQ0001",
      documentPrefix: "REQ",
      text: "<script>alert(1)</script>",
      header: "<b>bold</b>",
      attributes: { payload: "<img src=x onerror=alert(2)>" },
      links: [{ uid: "<img src=x onerror=alert(3)>", fingerprint: "STALE" }],
    });
    // A hostile uid must render as escaped text in both the list row and the
    // detail head (it is a distinct, non-colliding item).
    const evilUid = makeItem({ uid: "<svg onload=alert(4)>", documentPrefix: "REQ", text: "has a hostile uid" });
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
    // Scoped to the uid cell: the row now carries the insert-into-prompt
    // <svg> icon, so the hostile uid is asserted to have parsed into no
    // element of its own.
    expect(evilUidRow?.querySelector(".doorstop-item-uid svg")).toBeNull();
    // The row's insert-into-prompt title is the one place the hostile uid
    // legitimately appears in an attribute; assert it landed in
    // `getAttribute` as literal text rather than as parsed markup.
    expect(evilUidRow?.querySelector(".doorstop-item-insert")?.getAttribute("title")).toBe(
      "Insert <svg onload=alert(4)> into the prompt",
    );

    // Selecting the hostile-uid item pins the detail-head uid as escaped text.
    evilUidRow?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    const detail = root.querySelector(".doorstop-detail");
    if (detail === null) throw new Error("detail");
    expect(detail.querySelector(".doorstop-detail-uid")?.textContent).toBe("<svg onload=alert(4)>");
    expect(detail.querySelector("svg")).toBeNull();

    // Selecting the evil item: text/header/attribute + the link's hostile uid
    // all escape to literal text.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
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
    // The trash can's `title` is the one place a hostile UID legitimately
    // appears verbatim: it is an attribute value, and the HTML serializer does
    // not entity-escape `<`/`>` inside attribute values. Assert it landed in
    // `getAttribute` (not as parsed markup) and then drop exactly that one
    // affordance's title before the substring scan, so every OTHER attribute,
    // text node, and tag name is still checked. A blanket `title="..."`
    // strip would mask a future injection into any title attribute.
    const trash = linksOut?.querySelector<HTMLElement>(".doorstop-link-remove");
    expect(trash?.getAttribute("title")).toBe("doorstop unlink REQ0001 <img src=x onerror=alert(3)>");
    trash?.removeAttribute("title");
    const markup = body.shadowRoot?.innerHTML ?? "";
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    // Lit escapes the text into entity form instead.
    expect(detail2.innerHTML).toContain("&lt;script&gt;");
    expect(detail2.innerHTML).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(detail2.innerHTML).toContain("&lt;img");
  });

  it("renders a per-row trash can that unlinks the clicked parent without navigating", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    const rows = [...root.querySelectorAll<HTMLElement>('[aria-label="Parent links"] .doorstop-link-row')];
    expect(rows).toHaveLength(1);
    const remove = rows[0]?.querySelector<HTMLElement>(".doorstop-link-remove");
    expect(remove).not.toBeNull();
    // Pointer-only, aria-hidden affordance: the row IS a <button>, so a nested
    // button would be hoisted by the HTML parser (see renderLinkOut).
    expect(remove?.getAttribute("aria-hidden")).toBe("true");
    expect(remove?.getAttribute("title")).toBe("doorstop unlink REQ0002 REQ0001");

    remove?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: unlink REQ0002",
      command: "doorstop unlink REQ0002 REQ0001",
      metadata: { "opendoor.op": "unlink" },
      open: false,
    });
    // stopPropagation: the trash click must not also select the parent link.
    expect(controller.selectedUid).toBe("REQ0002");
  });

  it("renders the trash can on an unknown-target link row and dispatches the same unlink", async () => {
    const item = makeItem({
      uid: "REQ0002",
      documentPrefix: "REQ",
      path: "reqs/REQ0002.yml",
      links: [{ uid: "REQ0009", fingerprint: null }],
    });
    const { body, controller, context } = await mountBody(() =>
      Promise.resolve(makeResult([item], [makeDocument()])),
    );
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    const row = root.querySelector<HTMLElement>('[aria-label="Parent links"] .doorstop-link-row');
    // The unknown target renders a <div> (not a clickable <button>).
    expect(row?.tagName).toBe("DIV");
    const remove = row?.querySelector<HTMLElement>(".doorstop-link-remove");
    expect(remove).not.toBeNull();
    remove?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: unlink REQ0002",
      command: "doorstop unlink REQ0002 REQ0009",
      metadata: { "opendoor.op": "unlink" },
      open: false,
    });
  });

  it("does not dispatch the unlink while a run is already in flight", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    controller.runInProgress = "Doorstop: validate";
    bindBody(body, controller, context);
    await flushMicro(body);
    const remove = root.querySelector<HTMLElement>('[aria-label="Parent links"] .doorstop-link-remove');
    expect(remove).not.toBeNull();
    remove?.click();
    await settle();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
  });

  it("renders no trash can when the item has no parent links", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    // TST001 has no outgoing links.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(root.querySelector(".doorstop-detail")?.textContent).toContain("No parent links.");
    expect(root.querySelector(".doorstop-link-remove")).toBeNull();
  });
});

describe("DoorstopPanelBodyElement (changes since review, Phase D)", () => {
  it("is gated on unreviewed + stored reviewed fingerprint + active backend", async () => {
    // A REVIEWED item (stamp matches): no section, even with a backend.
    const reviewedCase = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: withGitStatusBackend(() => undefined),
      provider: opendoorProvider,
    });
    reviewedCase.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(reviewedCase.body, reviewedCase.controller, reviewedCase.context);
    await flushMicro(reviewedCase.body);
    expect(reviewedCase.body.shadowRoot?.querySelector(".doorstop-changes")).toBeNull();

    // Unreviewed WITH a stored fingerprint and an active backend: present.
    const unpaired = await mountBody(() => Promise.resolve(makeEditedItemResult()));
    unpaired.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(unpaired.body, unpaired.controller, unpaired.context);
    await flushMicro(unpaired.body);
    // No backend (unpaired install): the section is hidden entirely.
    expect(unpaired.body.shadowRoot?.querySelector(".doorstop-changes")).toBeNull();

    // Same item with the backend active: the section renders (collapsed).
    const paired = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend: withGitStatusBackend(() => undefined),
      provider: opendoorProvider,
    });
    paired.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(paired.body, paired.controller, paired.context);
    await flushMicro(paired.body);
    const section = paired.body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    expect(section).not.toBeNull();
    expect(section?.open).toBe(false); // collapsed by default
    expect(section?.querySelector("summary")?.textContent).toBe("Changes since review");
  });

  it("sends the baseline request on expand; a later expand is a cache hit (exactly one fetch)", async () => {
    const backend = withGitStatusBackend((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve(makeBaselineResponse({ source: "none", candidates: [] }));
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    const details = body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    if (details === undefined || details === null) throw new Error("no changes section");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    // One fetch with the exact request (uid + workspace-relative path).
    const baselineCalls = backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline");
    expect(baselineCalls).toHaveLength(1);
    expect(baselineCalls[0]).toEqual(["doorstop.item-baseline", { uid: "REQ0003", path: "reqs/REQ0003.yml" }]);

    // A second expand (collapse then reopen): the cached ready view matches
    // the current key → no second fetch.
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(1);
  });

  it("stamp-walks the candidates newest-first and renders the semantic diff (text rows + field chips)", async () => {
    const oldVersion = makeItem({
      uid: "REQ0003",
      documentPrefix: "REQ",
      path: "reqs/REQ0003.yml",
      level: "1.2",
      text: "The system shall do Z.\nAnd approve.",
      links: [{ uid: "REQ0001", fingerprint: null }],
      attributes: { owner: "team-a" },
    });
    const backend = withGitStatusBackend((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve(
          makeBaselineResponse({
            source: "review-commit",
            candidates: [
              // Newest first: this NEWER blob does NOT match `reviewed` (a
              // different revision), so the walk must skip it and land on
              // the matching candidate below.
              { sha: "beef0000", blob: "active: true\nnormative: true\ntext: Different.\n" },
              { sha: "abc1234", blob: reviewedBlob(oldVersion) },
            ],
          }),
        );
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    const details = body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    if (details === undefined || details === null) throw new Error("no changes section");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);

    const root = body.shadowRoot;
    const sectionText = root?.querySelector(".doorstop-changes")?.textContent ?? "";
    expect(root?.querySelector(".doorstop-changes-source")?.textContent).toBe("matched via review commit");
    // Text rows: the one added line (+ Async.), unchanged lines rendered same.
    const added = root?.querySelectorAll(".doorstop-diff-line.is-added");
    expect(added?.length).toBe(1);
    expect(added?.[0]?.textContent).toContain("Async.");
    const same = root?.querySelectorAll(".doorstop-diff-line.is-same");
    expect(same?.length).toBe(2);
    expect(same?.[0]?.textContent).toContain("The system shall do Z.");
    expect(root?.querySelectorAll(".doorstop-diff-line.is-removed").length).toBe(0);
    // Field chips: the added link, the removed link (none), the owner change.
    expect(sectionText).toContain("+ REQ0002");
    expect(sectionText).toContain("team-a");
    expect(sectionText).toContain("team-b");
    expect(root?.querySelectorAll(".doorstop-field-chip-before").length).toBe(1); // owner before
    expect(root?.querySelectorAll(".doorstop-field-chip-after").length).toBe(2); // owner after + link
    // No ref/references rows (those fields did not change).
    expect(sectionText).not.toContain("ref");
  });

  it("renders the no-match notice when no candidate stamps to the reviewed fingerprint", async () => {
    const backend = withGitStatusBackend((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve(makeBaselineResponse({ source: "history", candidates: [] }));
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    const details = body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    if (details === undefined || details === null) throw new Error("no changes section");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-changes-notice")?.textContent).toBe(
      "Could not locate the reviewed version (history may have been rewritten)",
    );
  });

  it("renders the no-git notice when the backend reports git: false", async () => {
    const backend = withGitStatusBackend((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve(makeBaselineResponse({ git: false, source: "none", candidates: [] }));
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    const details = body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    if (details === undefined || details === null) throw new Error("no changes section");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-changes-notice")?.textContent).toBe(
      "No git history — previous version unavailable",
    );
  });

  it("self-heals an open section after an edit invalidates the cache key (reused <details> fires no toggle)", async () => {
    const backend = withGitStatusBackend((operation: string) => {
      if (operation === "doorstop.item-baseline") {
        return Promise.resolve(makeBaselineResponse({ source: "history", candidates: [] }));
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeEditedItemResult()), {
      backend,
      provider: opendoorProvider,
    });
    body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    const details = body.shadowRoot?.querySelector<HTMLDetailsElement>(".doorstop-changes");
    if (details === undefined || details === null) throw new Error("no changes section");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    // The no-match view is cached under REQ0003's current key.
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(1);
    expect(body.shadowRoot?.querySelector(".doorstop-changes-notice")?.textContent).toContain(
      "Could not locate",
    );

    // An edit lands: the item's stamp changes, so the cached view's key no
    // longer matches. The host re-renders the pane with the fresh result
    // (simulated by mirroring then rebinding a new result object) — the
    // reused <details> stays OPEN and no `toggle` event fires, so only the
    // post-render self-heal can kick the fetch.
    const item = controller.result?.index.byUid.get("REQ0003");
    if (item === undefined) throw new Error("REQ0003 missing");
    item.text += "\nEdited after review.";
    bindBody(body, controller, context);
    body.result = { ...controller.result! };
    await flushMicro(body);
    // Still open (node reused, not recreated) — and the fetch happened with
    // no user action at all.
    expect(details.open).toBe(true);
    expect(backend.mock.calls.filter(([op]) => op === "doorstop.item-baseline")).toHaveLength(2);
    // Mirror the landing (the refetch bumped `baselineVersion`) so the
    // element re-renders the terminal notice instead of the loading view.
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-changes-notice")?.textContent).toContain(
      "Could not locate",
    );
  });
});
