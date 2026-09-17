// @vitest-environment happy-dom
//
// Element-level tests for the item-action-palette section
// (src/browser/sections/item-action-palette.ts) plus the terminal command
// lines it dispatches. Describe blocks moved verbatim from
// doorstop-panel-element.test.ts; shared scaffolding lives in
// ../doorstop-panel-element-test-support.ts.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  type TerminalCommandRun,
  type TerminalCommandRunHandle,
} from "@jmfederico/pi-web/plugin-api";
import {
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_STATUS_FILES_MAX,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
} from "../../doorstop-backend-contract.js";
import {
  draftChildRequirementPrompt,
  explainItemPrompt,
  fixSuspectLinksPrompt,
  reviewReadinessPrompt,
} from "../doorstop-prompts.js";
import { type DoorstopPanelBodyElement } from "../doorstop-panel-elements.js";
import { text } from "../../test-support.js";
import { flushMicro, makeTreeResult, settle } from "../../test-fixtures.js";
import {
  stubConfirm,
  makeGitStatusResponse,
  type WindowWithConfirm,
  mountBody,
  mountGitBody,
  gitStatusFile,
  selectItemRow,
  bindBody,
  makeRunResponse,
  makeRun,
  resetElementTestEnvironment,
} from "../doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

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
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-confirm-skipped")?.textContent).toContain("confirmation skipped");
  });

  it("runs review with the exact command; review is disabled for a reviewed-current item", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    root.querySelector<HTMLElement>(".doorstop-review")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: review REQ0002",
      command: "doorstop review REQ0002",
      metadata: { "opendoor.op": "review" },
      open: false,
    });

    // REQ0001 is reviewed against its current fingerprint: Review is
    // disabled with an explaining tooltip and clicks run nothing.
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0001"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
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
    await flushMicro(body);

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
    await flushMicro(body);
    const clear = root.querySelector<HTMLButtonElement>(".doorstop-clear");
    expect(clear?.disabled).toBe(true);
    expect(clear?.title).toContain("No suspect links");
  });

  it("runs link from the inline target input and clears the input after the run", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    const linkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="link"]');
    if (linkInput === null) throw new Error("input");

    // The Link button runs the op and clears the input afterwards.
    linkInput.value = "REQ0001";
    root.querySelector<HTMLElement>(".doorstop-link")?.click();
    expect(context.terminal.runCommand).toHaveBeenLastCalledWith({
      title: "Doorstop: link REQ0002",
      command: "doorstop link REQ0002 REQ0001",
      metadata: { "opendoor.op": "link" },
      open: false,
    });
    // The input is cleared after the run, ready for the next target.
    expect(linkInput.value).toBe("");

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
    linkInput.value = "REQ0001";
    linkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(linkInput.value).toBe("");
    expect(context.terminal.runCommand).not.toHaveBeenCalled();

    // An empty input runs nothing.
    root.querySelector<HTMLElement>(".doorstop-link")?.click();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
  });

  it("rejects empty and unsafe link targets with a visible inline error and runs nothing", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);

    const linkInput = root.querySelector<HTMLInputElement>('.doorstop-target-input[data-op="link"]');
    if (linkInput === null) throw new Error("input");

    // Empty input: a visible inline error, never a silent return, nothing runs.
    root.querySelector<HTMLElement>(".doorstop-link")?.click();
    await flushMicro(body);
    expect(root.querySelector(".doorstop-op-error")?.textContent).toContain("Enter a link target UID");
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(linkInput.value).toBe(""); // kept (empty) for the user to fill in

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
      await flushMicro(body);
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
    await flushMicro(body);
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
    await flushMicro(body);

    const result = controller.result;
    if (result === undefined) throw new Error("result");
    const req0002 = result.index.byUid.get("REQ0002");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0002 === undefined || req0001 === undefined) throw new Error("fixture");

    // The menu is closed by default; the toggle opens it.
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    const items = root.querySelector(".doorstop-menu-items");
    if (items === null) throw new Error("menu");

    items.querySelector<HTMLElement>(".doorstop-explain")?.click();
    expect(insertText).toHaveBeenLastCalledWith(explainItemPrompt(req0002));
    expect(focusPrompt).toHaveBeenCalled();
    // Selecting a prompt closes the menu after the insert commits.
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull(); // closes after insert

    // Fix suspect links names the changed parents.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    root.querySelector<HTMLElement>(".doorstop-fix-suspects")?.click();
    expect(insertText).toHaveBeenLastCalledWith(fixSuspectLinksPrompt(req0002, [req0001]));
    // Draft child targets the item's first child document prefix (TST).
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    root.querySelector<HTMLElement>(".doorstop-draft-child")?.click();
    expect(insertText).toHaveBeenLastCalledWith(draftChildRequirementPrompt(req0002, "TST"));
    // Review readiness names the children resolved from the reverse map.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
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
    await flushMicro(body);

    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
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
    await flushMicro(body);

    const result = controller.result;
    if (result === undefined) throw new Error("result");
    const req0001 = result.index.byUid.get("REQ0001");
    if (req0001 === undefined) throw new Error("fixture");
    const children = result.index.childrenByUid.get(req0001.uid) ?? [];
    expect(children.map((child) => child.uid)).toContain("TST002");

    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
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
    await flushMicro(body);

    // Open, then Escape closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();

    // Open, then an outside click closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();

    // Open, then selecting a different item closes it.
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).not.toBeNull();
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="TST001"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(root.querySelector(".doorstop-menu-items")).toBeNull();
  });

  it("skips a missing prompt editor without throwing", async () => {
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    if (root === null) throw new Error("shadow root");
    root.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"]')?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    // A context-less menu toggle still opens; inserting with context cleared
    // is a no-op (the element guards `context === undefined`).
    (body as DoorstopPanelBodyElement).context = undefined;
    root.querySelector<HTMLElement>(".doorstop-menu-toggle")?.click();
    await flushMicro(body);
    root.querySelector<HTMLElement>(".doorstop-explain")?.click();
    expect(controller.selectedUid).toBe("REQ0002");
  });
});

describe("DoorstopPanelBodyElement (per-item git staging: chips + row add + palette Stage)", () => {
  it("renders git chips for non-clean rows and the row add/remove where staged or stageable", async () => {
    const backend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? Promise.resolve(
            makeGitStatusResponse({
              staged: 1,
              dirty: 2,
              files: [
                gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"),
                gitStatusFile("tests/TST001.yml", "modified", "unmodified"),
                gitStatusFile("tests/TST002.yml", "untracked", "untracked"),
              ],
            }),
          )
        : Promise.resolve(makeRunResponse()),
    );
    const { body } = await mountGitBody(backend);
    const row = (uid: string) =>
      body.shadowRoot?.querySelector<HTMLElement>(`.doorstop-item-row[data-uid="${uid}"]`);
    const chips = (uid: string) => row(uid)?.querySelector(".doorstop-item-chips")?.textContent ?? "";

    expect(chips("REQ0002")).toContain("changed");
    expect(chips("TST001")).toContain("staged");
    expect(chips("TST002")).toContain("untracked");
    // REQ0001 is absent from `files` (porcelain omits unmodified paths) →
    // clean → only its state chips, no git chip.
    expect(chips("REQ0001")).not.toMatch(/changed|staged|untracked|conflict/);

    // The row span is direction-aware: the plus (`git add`) for stageable
    // rows (unstaged modification / untracked), the minus (`git reset`) for
    // rows with staged (X-column) changes, and nothing for a clean row.
    expect(row("REQ0002")?.querySelector(".doorstop-item-add")?.getAttribute("title")).toBe(
      "git add reqs/REQ0002.yml",
    );
    expect(row("TST002")?.querySelector(".doorstop-item-add")?.getAttribute("title")).toBe(
      "git add tests/TST002.yml",
    );
    expect(row("TST001")?.querySelector(".doorstop-item-add")?.getAttribute("title")).toBe(
      "git reset tests/TST001.yml",
    );
    expect(row("REQ0001")?.querySelector(".doorstop-item-add")).toBeNull();
  });

  it("the row git-add stages exactly that item and does not change the selection", async () => {
    const backend = vi.fn((operation: string) => {
      if (operation === DOORSTOP_GIT_STATUS_OPERATION) {
        return Promise.resolve(
          makeGitStatusResponse({
            dirty: 1,
            files: [gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified")],
          }),
        );
      }
      if (operation === DOORSTOP_GIT_STAGE_OPERATION) return Promise.resolve({ status: "staged", staged: 1 });
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller } = await mountGitBody(backend);
    expect(controller.selectedUid).toBeUndefined();

    body.shadowRoot
      ?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-add')
      ?.click();
    await flushMicro(body);

    expect(backend).toHaveBeenCalledWith(DOORSTOP_GIT_STAGE_OPERATION, { paths: ["reqs/REQ0002.yml"] });
    expect(controller.lastRun).toMatchObject({ op: "git-stage", status: "ok", title: "Git: stage REQ0002" });
    // stopPropagation: clicking the nested add never selected the row.
    expect(controller.selectedUid).toBeUndefined();
  });

  it("hides git chips, the row add, and the palette Stage when the status is not ready", async () => {
    const noGitBackend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? // The git:false degradation shape carries no branch/ahead/behind.
          Promise.resolve({ git: false, staged: 0, dirty: 0, files: [] } as DoorstopGitStatusResponse)
        : Promise.resolve(makeRunResponse()),
    );
    const noGit = await mountGitBody(noGitBackend);
    await selectItemRow(noGit.body, noGit.controller, noGit.context, "REQ0002");
    expect(noGit.body.shadowRoot?.querySelector(".doorstop-item-add")).toBeNull();
    expect(noGit.body.shadowRoot?.querySelector(".doorstop-item-stage")).toBeNull();
    expect(noGit.body.shadowRoot?.querySelector(".doorstop-item-unstage")).toBeNull();

    const errorBackend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? Promise.reject(new Error("status boom"))
        : Promise.resolve(makeRunResponse()),
    );
    const errored = await mountGitBody(errorBackend);
    await selectItemRow(errored.body, errored.controller, errored.context, "REQ0002");
    expect(errored.body.shadowRoot?.querySelector(".doorstop-item-add")).toBeNull();
    expect(errored.body.shadowRoot?.querySelector(".doorstop-item-stage")).toBeNull();
    expect(errored.body.shadowRoot?.querySelector(".doorstop-item-unstage")).toBeNull();

    // Unpaired install: zero per-item git affordances on any row.
    const unpaired = await mountBody(() => Promise.resolve(makeTreeResult()));
    expect(unpaired.body.shadowRoot?.querySelector(".doorstop-item-add")).toBeNull();
    // No stray parsed <svg> anywhere in a row: the ONLY svg a row carries is
    // the insert-into-prompt arrow. Scoped per row so the arrow svg does not
    // mask a parsed git-affordance icon (a bare `.doorstop-item-add svg` check
    // is vacuous once `.doorstop-item-add` is already null).
    const unpairedRows = [
      ...(unpaired.body.shadowRoot?.querySelectorAll<HTMLElement>(".doorstop-item-row") ?? []),
    ];
    expect(unpairedRows.length).toBeGreaterThan(0);
    expect(
      unpairedRows.every(
        (row) => row.querySelectorAll("svg").length === 1 && row.querySelector(".doorstop-item-insert svg") !== null,
      ),
    ).toBe(true);
    // The palette gate is the SAME `readyGitStatus()` check for both git
    // buttons (there is no per-button readiness): the Unstage button is
    // absent for exactly the same reason the Stage button is.
    await selectItemRow(unpaired.body, unpaired.controller, unpaired.context, "REQ0002");
    // Positive control: the palette DID render (Review is backend-independent),
    // so the two null assertions below are about the git gate, not a failed select.
    expect(unpaired.body.shadowRoot?.querySelector(".doorstop-review")).not.toBeNull();
    expect(unpaired.body.shadowRoot?.querySelector(".doorstop-item-stage")).toBeNull();
    expect(unpaired.body.shadowRoot?.querySelector(".doorstop-item-unstage")).toBeNull();
  });

  it("renders the palette Stage only when ready, disabled for staged items and in-flight runs", async () => {
    const backend = vi.fn((operation: string) => {
      if (operation === DOORSTOP_GIT_STATUS_OPERATION) {
        return Promise.resolve(
          makeGitStatusResponse({
            staged: 1,
            dirty: 2,
            files: [
              gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"),
              gitStatusFile("reqs/REQ0001.yml", "modified", "unmodified"),
            ],
          }),
        );
      }
      if (operation === DOORSTOP_GIT_STAGE_OPERATION) return Promise.resolve({ status: "staged", staged: 1 });
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountGitBody(backend);
    const stage = () => body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-item-stage");

    await selectItemRow(body, controller, context, "REQ0002");
    expect(stage()).not.toBeNull();
    expect(stage()?.disabled).toBe(false);

    // A fully-staged item has nothing left to add: present but disabled.
    await selectItemRow(body, controller, context, "REQ0001");
    expect(stage()?.disabled).toBe(true);
    expect(stage()?.getAttribute("title")).toContain("no unstaged changes");

    // An in-flight run disables the button (the shared runInProgress gate)
    // AND removes the row-level add affordance (the same gate).
    await selectItemRow(body, controller, context, "REQ0002");
    body.runInProgress = "Doorstop: validate";
    await flushMicro(body);
    expect(stage()?.disabled).toBe(true);
    expect(
      body.shadowRoot?.querySelector('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-add'),
    ).toBeNull();
    body.runInProgress = undefined;
    await flushMicro(body);

    stage()?.click();
    await flushMicro(body);
    expect(backend).toHaveBeenCalledWith(DOORSTOP_GIT_STAGE_OPERATION, { paths: ["reqs/REQ0002.yml"] });
    expect(controller.lastRun).toMatchObject({ op: "git-stage", status: "ok", title: "Git: stage REQ0002" });
  });

  it("suppresses per-item git UI when the status files list is truncated at the server cap", async () => {
    // The matching item sits INSIDE the first 200 entries; the extra dirty
    // count proves paths past the cap exist. Without truncation handling this
    // row would show a "changed" chip and an add affordance.
    const files: DoorstopGitStatusFile[] = [
      gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"),
      ...Array.from({ length: DOORSTOP_GIT_STATUS_FILES_MAX - 1 }, (_, index) =>
        gitStatusFile(`other/file${String(index)}.yml`, "unmodified", "modified"),
      ),
    ];
    const backend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? Promise.resolve(makeGitStatusResponse({ dirty: DOORSTOP_GIT_STATUS_FILES_MAX + 1, files }))
        : Promise.resolve(makeRunResponse()),
    );
    const { body, controller, context } = await mountGitBody(backend);
    // The strip's counts stay honest...
    expect(body.shadowRoot?.querySelector(".doorstop-git-status-text")?.textContent).toContain(
      `${String(DOORSTOP_GIT_STATUS_FILES_MAX + 1)} dirty`,
    );
    // ...but no row claims a state while unreported paths exist.
    const chips = body.shadowRoot?.querySelector('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-chips')?.textContent ?? "";
    expect(chips).not.toContain("changed");
    expect(body.shadowRoot?.querySelector(".doorstop-item-add")).toBeNull();

    // The palette Stage is suppressed too (not merely disabled). NB: this
    // is the GATE removing the button (`readyGitStatus()` → undefined when
    // truncated); the in-flight test below is the GUARD disabling it in
    // place (`runInProgress !== undefined`) while the status stays ready.
    // The two look contradictory out of context but are independent.
    await selectItemRow(body, controller, context, "REQ0002");
    // Positive control: the palette rendered (Review is backend-independent);
    // both git buttons are absent, not merely disabled.
    expect(body.shadowRoot?.querySelector(".doorstop-review")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-item-stage")).toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-item-unstage")).toBeNull();
  });

  it("re-fetches and re-renders the chips after a successful per-item stage", async () => {
    let staged = false;
    const backend = vi.fn((operation: string) => {
      if (operation === DOORSTOP_GIT_STATUS_OPERATION) {
        return Promise.resolve(
          makeGitStatusResponse({
            staged: staged ? 1 : 0,
            dirty: 1,
            files: [
              staged
                ? gitStatusFile("reqs/REQ0002.yml", "modified", "unmodified")
                : gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"),
            ],
          }),
        );
      }
      if (operation === DOORSTOP_GIT_STAGE_OPERATION) {
        staged = true;
        return Promise.resolve({ status: "staged", staged: 1 });
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountGitBody(backend);
    const chips = () =>
      body.shadowRoot?.querySelector('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-chips')?.textContent ?? "";
    expect(chips()).toContain("changed");

    body.shadowRoot
      ?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-add')
      ?.click();
    await flushMicro(body);
    // The success invalidated the cached view; mirroring the cleared view
    // lets the element's orphan guard refetch the updated status.
    bindBody(body, controller, context);
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);

    expect(chips()).toContain("staged");
    expect(chips()).not.toContain("changed");
  });
});

describe("DoorstopPanelBodyElement (per-item git unstaging: row minus + palette Unstage)", () => {
  const statusBackend = (
    response: () => DoorstopGitStatusResponse,
    onUnstage: () => unknown = () => ({ status: "unstaged", unstaged: 1 }),
  ): Mock =>
    vi.fn((operation: string) => {
      if (operation === DOORSTOP_GIT_STATUS_OPERATION) return Promise.resolve(response());
      if (operation === DOORSTOP_GIT_UNSTAGE_OPERATION) return Promise.resolve(onUnstage());
      return Promise.resolve(makeRunResponse());
    });

  it("prefers the minus icon when the index (X) column is dirty — minus wins on 'MM'", async () => {
    const backend = statusBackend(() =>
      makeGitStatusResponse({
        staged: 2,
        dirty: 1,
        files: [
          gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"), // ' M' → plus
          gitStatusFile("tests/TST001.yml", "modified", "unmodified"), // 'M ' → minus
          gitStatusFile("tests/TST002.yml", "modified", "modified"), // 'MM' → minus
        ],
      }),
    );
    const { body } = await mountGitBody(backend);
    const span = (uid: string) =>
      body.shadowRoot?.querySelector<HTMLElement>(`.doorstop-item-row[data-uid="${uid}"] .doorstop-item-add`);

    expect(span("REQ0002")?.getAttribute("title")).toBe("git add reqs/REQ0002.yml");
    expect(span("TST001")?.getAttribute("title")).toBe("git reset tests/TST001.yml");
    // The requested UX: a staged-then-edited item shows the minus (the
    // palette Stage button remains the keyboard-reachable stage path).
    expect(span("TST002")?.getAttribute("title")).toBe("git reset tests/TST002.yml");

    // The minus icon is the plus circle WITHOUT its vertical bar: the plus
    // svg carries two <path> children, the minus exactly one.
    expect(span("REQ0002")?.querySelectorAll("path")).toHaveLength(2);
    expect(span("TST001")?.querySelectorAll("path")).toHaveLength(1);
  });

  it("hides the row minus during an in-flight run and under a truncated status", async () => {
    const backend = statusBackend(() =>
      makeGitStatusResponse({
        staged: 1,
        dirty: 1,
        files: [gitStatusFile("tests/TST001.yml", "modified", "unmodified")],
      }),
    );
    const { body } = await mountGitBody(backend);
    const minus = () =>
      body.shadowRoot?.querySelector('.doorstop-item-row[data-uid="TST001"] .doorstop-item-add');
    expect(minus()).not.toBeNull();

    body.runInProgress = "Doorstop: validate";
    await flushMicro(body);
    expect(minus()).toBeNull();
    body.runInProgress = undefined;
    await flushMicro(body);

    // Truncation suppresses EVERY per-item git affordance, minus included
    // (an unstage against unreported paths would act on stale path data).
    const files: DoorstopGitStatusFile[] = [
      gitStatusFile("tests/TST001.yml", "modified", "unmodified"),
      ...Array.from({ length: DOORSTOP_GIT_STATUS_FILES_MAX - 1 }, (_, index) =>
        gitStatusFile(`other/file${String(index)}.yml`, "unmodified", "modified"),
      ),
    ];
    const truncated = await mountGitBody(
      statusBackend(() =>
        makeGitStatusResponse({ staged: 1, dirty: DOORSTOP_GIT_STATUS_FILES_MAX + 1, files }),
      ),
    );
    expect(truncated.body.shadowRoot?.querySelector(".doorstop-item-add")).toBeNull();
    await selectItemRow(truncated.body, truncated.controller, truncated.context, "TST001");
    expect(truncated.body.shadowRoot?.querySelector(".doorstop-item-unstage")).toBeNull();
  });

  it("renders the palette Stage and Unstage independently, disabled per X/Y state and during a run", async () => {
    const backend = statusBackend(() =>
      makeGitStatusResponse({
        staged: 2,
        dirty: 2,
        files: [
          gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified"), // stageable only
          gitStatusFile("reqs/REQ0001.yml", "modified", "unmodified"), // unstageable only
          gitStatusFile("tests/TST001.yml", "modified", "modified"), // both
        ],
      }),
    );
    const { body, controller, context } = await mountGitBody(backend);
    const stage = () => body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-item-stage");
    const unstage = () => body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-item-unstage");

    // Y-column dirty only: Stage enabled, Unstage disabled.
    await selectItemRow(body, controller, context, "REQ0002");
    expect(stage()?.disabled).toBe(false);
    expect(unstage()?.disabled).toBe(true);
    expect(unstage()?.getAttribute("title")).toBe("REQ0002 has nothing staged");

    // X-column dirty only: Unstage enabled, Stage disabled.
    await selectItemRow(body, controller, context, "REQ0001");
    expect(stage()?.disabled).toBe(true);
    expect(unstage()?.disabled).toBe(false);
    expect(unstage()?.getAttribute("title")).toBe("Unstage reqs/REQ0001.yml (git reset)");

    // 'MM': BOTH enabled, independently.
    await selectItemRow(body, controller, context, "TST001");
    expect(stage()?.disabled).toBe(false);
    expect(unstage()?.disabled).toBe(false);

    // An in-flight run disables both (the shared runInProgress gate).
    body.runInProgress = "Doorstop: validate";
    await flushMicro(body);
    expect(stage()?.disabled).toBe(true);
    expect(unstage()?.disabled).toBe(true);
    body.runInProgress = undefined;
    await flushMicro(body);

    // Clicking the palette Unstage sends the per-item request and title.
    unstage()?.click();
    await flushMicro(body);
    expect(backend).toHaveBeenCalledWith(DOORSTOP_GIT_UNSTAGE_OPERATION, {
      paths: ["tests/TST001.yml"],
    });
    expect(controller.lastRun).toMatchObject({
      op: "git-unstage",
      status: "ok",
      title: "Git: unstage TST001",
    });
  });

  it("clicking the row minus sends doorstop.git-unstage with the item path and does not change the selection", async () => {
    const backend = statusBackend(() =>
      makeGitStatusResponse({
        staged: 1,
        dirty: 0,
        files: [gitStatusFile("reqs/REQ0002.yml", "modified", "unmodified")],
      }),
    );
    const { body, controller } = await mountGitBody(backend);
    expect(controller.selectedUid).toBeUndefined();

    body.shadowRoot
      ?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-add')
      ?.click();
    await flushMicro(body);

    expect(backend).toHaveBeenCalledWith(DOORSTOP_GIT_UNSTAGE_OPERATION, {
      paths: ["reqs/REQ0002.yml"],
    });
    expect(controller.lastRun).toMatchObject({
      op: "git-unstage",
      status: "ok",
      title: "Git: unstage REQ0002",
    });
    // stopPropagation: clicking the nested minus never selected the row.
    expect(controller.selectedUid).toBeUndefined();
  });

  it("re-fetches and re-renders after a successful unstage (minus → plus)", async () => {
    let unstaged = false;
    const backend = vi.fn((operation: string) => {
      if (operation === DOORSTOP_GIT_STATUS_OPERATION) {
        return Promise.resolve(
          makeGitStatusResponse({
            staged: unstaged ? 0 : 1,
            dirty: 1,
            files: [
              unstaged
                ? gitStatusFile("reqs/REQ0002.yml", "unmodified", "modified")
                : gitStatusFile("reqs/REQ0002.yml", "modified", "unmodified"),
            ],
          }),
        );
      }
      if (operation === DOORSTOP_GIT_UNSTAGE_OPERATION) {
        unstaged = true;
        return Promise.resolve({ status: "unstaged", unstaged: 1 });
      }
      return Promise.resolve(makeRunResponse());
    });
    const { body, controller, context } = await mountGitBody(backend);
    const span = () =>
      body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0002"] .doorstop-item-add');
    expect(span()?.getAttribute("title")).toBe("git reset reqs/REQ0002.yml");

    span()?.click();
    await flushMicro(body);
    // The success invalidated the cached view; mirroring the cleared view
    // lets the element's orphan guard refetch the updated status.
    bindBody(body, controller, context);
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);

    expect(unstaged).toBe(true);
    expect(span()?.getAttribute("title")).toBe("git add reqs/REQ0002.yml");
  });
});
