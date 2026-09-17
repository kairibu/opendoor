// @vitest-environment happy-dom
//
// Element-level tests for the status-bar section (src/browser/sections/status-bar.ts):
// the backend dispatch path and the last-run status bar. Describe blocks moved
// verbatim from doorstop-panel-element.test.ts; shared scaffolding lives in
// ../doorstop-panel-element-test-support.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type DoorstopRunResponse } from "../../doorstop-backend-contract.js";
import { commitOutcomeText, type DoorstopPanelBodyElement } from "../doorstop-panel-elements.js";
import { text } from "../../test-support.js";
import { flushMicro, makeTreeResult, settle } from "../../test-fixtures.js";
import {
  opendoorProvider,
  opendoorNoRequestProvider,
  gitProvider,
  makeEditedItemResult,
  withGitStatusBackend,
  mountBody,
  bindBody,
  makeRunResponse,
  resetElementTestEnvironment,
} from "../doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

describe("DoorstopPanelBodyElement (backend path + last run, Phase D)", () => {
  it("dispatches through the backend and commits lastRun when the opendoor provider owns the workspace", async () => {
    const backend = withGitStatusBackend(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });
    const invalidate = vi.spyOn(controller, "invalidate").mockImplementation(() => Promise.resolve());

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);

    // The structured request went to the backend; the terminal was NOT used;
    // one rescan followed; the in-flight marker cleared. The first backend
    // call is the ONE mount-time `doorstop.git-status` auto-fetch (the
    // strip's first-render fetch, Phase D step 14 — answered with a valid
    // status response via `withGitStatusBackend` so the strip's cached view
    // stays honest); the second is the validate run.
    expect(backend).toHaveBeenCalledTimes(2);
    expect(backend).toHaveBeenCalledWith("doorstop.git-status", {});
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

    // The mirrored status bar renders the badge, duration, and the
    // AUTO-EXPANDED output body (no user interaction needed).
    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    expect(root?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("ok");
    expect(root?.querySelector(".doorstop-last-run-pre")?.textContent).toContain("Validated 4 items.");
  });

  it("maps exit codes and killing signals onto the run status", async () => {
    // exit ≠ 0 → failed (findings are output, not infrastructure errors).
    const backendFailed = withGitStatusBackend(() => Promise.resolve(makeRunResponse({ exitCode: 3 })));
    const failed = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendFailed,
      provider: opendoorProvider,
    });
    failed.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(failed.body);
    expect(failed.controller.lastRun?.status).toBe("failed");
    expect(failed.controller.lastRun?.exitCode).toBe(3);

    // signal !== null → killed (partial output preserved, surfaced not thrown).
    const backendKilled = withGitStatusBackend(() =>
      Promise.resolve(makeRunResponse({ exitCode: null, signal: "SIGTERM", stdout: "partial…" })),
    );
    const killed = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend: backendKilled,
      provider: opendoorProvider,
    });
    killed.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(killed.body);
    expect(killed.controller.lastRun?.status).toBe("killed");
    expect(killed.controller.lastRun?.signal).toBe("SIGTERM");
    bindBody(killed.body, killed.controller, killed.context);
    await flushMicro(killed.body);
    expect(killed.body.shadowRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
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
    await flushMicro(body);

    // The run never wrote to the workspace: no rescan. The server error text
    // is surfaced in the view record; the in-flight marker clears.
    expect(invalidate).not.toHaveBeenCalled();
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(controller.runInProgress).toBeUndefined();
    expect(controller.lastRun?.status).toBe("error");
    expect(controller.lastRun?.errorMessage).toContain("doorstop CLI not found");

    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    // The error run is auto-expanded: the status bar shows the parsed error
    // message without any interaction.
    expect(root?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run")).not.toBeNull();
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
    await flushMicro(git.body);
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
    await flushMicro(noRequest.body);
    expect(noRequest.context.terminal.runCommand).toHaveBeenCalled();
    expect(backendNoRequest).not.toHaveBeenCalled();

    // No backend at all (the default context): terminal path, nothing new.
    const unpaired = await mountBody(() => Promise.resolve(makeTreeResult()));
    unpaired.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(unpaired.body);
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
    await flushMicro(body);
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-clear")?.click();
    await flushMicro(body);
    expect(backend).toHaveBeenCalledWith("doorstop.run", {
      op: "clear",
      uid: "REQ0002",
      parents: ["REQ0001"],
    });

    // Validate carries no arguments.
    backend.mockClear();
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
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
    await flushMicro(body);

    const buttons = [
      root.querySelector<HTMLButtonElement>(".doorstop-validate"),
      root.querySelector<HTMLButtonElement>(".doorstop-publish"),
      root.querySelector<HTMLButtonElement>(".doorstop-review"),
      root.querySelector<HTMLButtonElement>(".doorstop-clear"),
      root.querySelector<HTMLButtonElement>(".doorstop-link"),
    ];
    for (const button of buttons) expect(button?.disabled).toBe(false);

    // A pending run disables every action button synchronously.
    root.querySelector<HTMLElement>(".doorstop-validate")?.click();
    expect(controller.runInProgress).toBe("Doorstop: validate");
    bindBody(body, controller, context);
    await flushMicro(body);
    for (const button of buttons) expect(button?.disabled).toBe(true);

    // Landing the run re-enables them and clears the marker.
    resolveBackend(makeRunResponse());
    await flushMicro(body);
    expect(controller.runInProgress).toBeUndefined();
    bindBody(body, controller, context);
    await flushMicro(body);
    for (const button of buttons) expect(button?.disabled).toBe(false);
  });

  it("keeps the status bar across an invalidate and clears it only on dismiss", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    // Auto-expanded: the output body is present without any user interaction.
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();

    // A rescan (Refresh → invalidate → re-load) must NOT clear the run output.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-refresh")?.click();
    await settle();
    expect(controller.lastRun).toBeDefined();
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();

    // Dismiss clears the run AND collapses the bar (existing clear-run
    // semantics — controller.dismissRun() clears `lastRun`).
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-last-run-dismiss")?.click();
    expect(controller.lastRun).toBeUndefined();
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run-dismiss")).toBeNull();
  });

  it("re-expands the status bar when a NEW run after a Dismiss produces a message", async () => {
    const backend = vi.fn(() => Promise.resolve(makeRunResponse()));
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    // Run 1 → auto-expanded.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();

    // Dismiss → run cleared, bar collapsed-away.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-last-run-dismiss")?.click();
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).toBeNull();

    // Run 2 (a NEW run object with output) re-expands the bar automatically.
    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    expect(body.shadowRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(body.shadowRoot?.querySelector(".doorstop-last-run-pre")?.textContent).toContain(
      "Validated 4 items.",
    );
  });

  it("stays collapsed to its status row when a run has nothing to display", async () => {
    const backend = vi.fn(() =>
      Promise.resolve(makeRunResponse({ stdout: "", stderr: "" })),
    );
    const { body, controller, context } = await mountBody(() => Promise.resolve(makeTreeResult()), {
      backend,
      provider: opendoorProvider,
    });

    body.shadowRoot?.querySelector<HTMLElement>(".doorstop-validate")?.click();
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    // The status row is visible with no output body and no expand control.
    expect(root?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run")).toBeNull();
    expect(root?.querySelector(".doorstop-status-bar [aria-expanded]")).toBeNull();
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("ok");
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
    await flushMicro(body);
    bindBody(body, controller, context);
    await flushMicro(body);
    const root = body.shadowRoot;
    // The status bar row carries the killed badge and meta; the output body
    // auto-expands below it with the truncation notices.
    expect(root?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(root?.querySelector(".doorstop-last-run-status")?.textContent).toBe("killed (timeout)");
    expect(root?.querySelector(".doorstop-last-run-meta")?.textContent).toContain("SIGTERM");
    expect(root?.querySelectorAll(".doorstop-last-run-notice")).toHaveLength(2);
    const sectionText = root?.querySelector(".doorstop-last-run")?.textContent ?? "";
    expect(sectionText).toContain("truncated by the host stream limit");
    expect(sectionText).toContain("partial output");
    expect(sectionText).toContain("partial err");
  });

  it("passes commit: true on Review only when the workspace setting is on (omitted under the default)", async () => {
    // Default setting (off): the review request carries NO commit field.
    const backendOff = withGitStatusBackend((operation: string, input: unknown) => Promise.resolve(makeRunResponse()));
    const off = await mountBody(() => Promise.resolve(makeEditedItemResult()), { backend: backendOff, provider: opendoorProvider });
    off.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(off.body, off.controller, off.context);
    await flushMicro(off.body);
    off.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await flushMicro(off.body);
    expect(backendOff).toHaveBeenCalledWith("doorstop.run", { op: "review", uid: "REQ0003" });
    // The no-`commit` guard is filtered to the `doorstop.run` calls: the
    // mount-time `doorstop.git-status` auto-fetch (Phase D step 14) is call
    // 0, so a bare `calls[0]` would read the git-status `{}` payload and
    // pass trivially. The exact-shape toEqual below carries the real intent.
    const reviewCall = backendOff.mock.calls.find(([operation]) => operation === "doorstop.run");
    expect(reviewCall?.[1]).toEqual({ op: "review", uid: "REQ0003" });
    expect(reviewCall?.[1]).not.toHaveProperty("commit");

    // Setting on: the request carries commit: true.
    const backendOn = withGitStatusBackend((operation: string, input: unknown) => Promise.resolve(makeRunResponse()));
    const on = await mountBody(() => Promise.resolve(makeEditedItemResult()), { backend: backendOn, provider: opendoorProvider });
    on.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(on.body, on.controller, on.context);
    await flushMicro(on.body);
    // Flip the setting on the element's result surface (as a fresh settings
    // load would); bindBody above already mirrored the controller result, so
    // the override is what the Review click reads.
    const onResult = on.body.result;
    if (onResult !== undefined) {
      on.body.result = { ...onResult, settings: { ...onResult.settings, commitAfterReview: true } };
      await flushMicro(on.body);
    }
    on.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await flushMicro(on.body);
    expect(backendOn).toHaveBeenCalledWith("doorstop.run", { op: "review", uid: "REQ0003", commit: true });

    // Backend is the only commit path: with the setting on but NO backend,
    // the terminal command stays the plain `doorstop review <uid>`.
    const terminal = await mountBody(() => Promise.resolve(makeEditedItemResult()));
    terminal.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(terminal.body, terminal.controller, terminal.context);
    await flushMicro(terminal.body);
    if (terminal.body.result !== undefined) {
      terminal.body.result = {
        ...terminal.body.result,
        settings: { ...terminal.body.result.settings, commitAfterReview: true },
      };
      await flushMicro(terminal.body);
    }
    terminal.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await flushMicro(terminal.body);
    expect(terminal.context.terminal.runCommand).toHaveBeenCalledWith({
      title: "Doorstop: review REQ0003",
      command: "doorstop review REQ0003",
      metadata: { "opendoor.op": "review" },
      open: false,
    });
    expect(terminal.context.terminal.runCommand).toHaveBeenCalledTimes(1);
  });

  it("renders the commit outcome line in Last run; a failed commit does not flip the ok badge", async () => {
    const backend = withGitStatusBackend(() =>
      Promise.resolve(
        makeRunResponse({
          op: "review",
          exitCode: 0,
          stdout: "REQ0003 now reviewed.",
          commit: { status: "committed", sha: "abc1234" },
        }),
      ),
    );
    const good = await mountBody(() => Promise.resolve(makeEditedItemResult()), { backend, provider: opendoorProvider });
    good.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(good.body, good.controller, good.context);
    await flushMicro(good.body);
    good.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await flushMicro(good.body);
    bindBody(good.body, good.controller, good.context);
    await flushMicro(good.body);
    const goodRoot = good.body.shadowRoot;
    expect(goodRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(goodRoot?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(goodRoot?.querySelector(".doorstop-last-run-status")?.textContent).toBe("ok");
    expect(goodRoot?.querySelector(".doorstop-last-run-commit")?.textContent).toBe("commit: abc1234");

    // A failed COMMIT is narration: the review succeeded, so the badge stays
    // ok while the line surfaces the bounded git stderr.
    const backendFailed = withGitStatusBackend(() =>
      Promise.resolve(
        makeRunResponse({
          op: "review",
          exitCode: 0,
          stdout: "REQ0003 now reviewed.",
          commit: { status: "failed", stderr: "fatal: not a git repository" },
        }),
      ),
    );
    const failed = await mountBody(() => Promise.resolve(makeEditedItemResult()), { backend: backendFailed, provider: opendoorProvider });
    failed.body.shadowRoot?.querySelector<HTMLElement>('.doorstop-item-row[data-uid="REQ0003"]')?.click();
    bindBody(failed.body, failed.controller, failed.context);
    await flushMicro(failed.body);
    failed.body.shadowRoot?.querySelector<HTMLElement>(".doorstop-review")?.click();
    await flushMicro(failed.body);
    bindBody(failed.body, failed.controller, failed.context);
    await flushMicro(failed.body);
    const failedRoot = failed.body.shadowRoot;
    expect(failedRoot?.querySelector(".doorstop-status-bar")).not.toBeNull();
    expect(failedRoot?.querySelector(".doorstop-last-run")).not.toBeNull();
    expect(failedRoot?.querySelector(".doorstop-last-run-status")?.textContent).toBe("ok");
    expect(failedRoot?.querySelector(".doorstop-last-run-commit")?.textContent).toBe(
      "commit: failed — fatal: not a git repository",
    );
    expect(failed.controller.lastRun?.status).toBe("ok");
  });

  it("maps every commit outcome status to its narration text (pure)", () => {
    // The review→commit pipeline's voice (a review run — `commit: true`).
    expect(commitOutcomeText("review", { status: "committed", sha: "abc1234" })).toBe("commit: abc1234");
    expect(commitOutcomeText("review", { status: "clean" })).toBe("commit: clean (already committed)");
    expect(commitOutcomeText("review", { status: "skipped" })).toBe(
      "commit: skipped (not a git repository | review failed | deadline)",
    );
    expect(commitOutcomeText("review", { status: "failed", stderr: "boom" })).toBe("commit: failed — boom");
    // The git runs' own outcome voice — the shared `clean`/`skipped`/
    // `failed` statuses branch on the OP (the two response types are
    // indistinguishable on those statuses): a stage's `clean` means nothing
    // to stage, a commit's `clean` means nothing staged.
    expect(commitOutcomeText("git-stage", { status: "staged", staged: 3 })).toBe("staged 3 paths");
    expect(commitOutcomeText("git-stage", { status: "clean" })).toBe("clean — nothing to stage");
    expect(commitOutcomeText("git-stage", { status: "skipped" })).toBe("skipped");
    expect(commitOutcomeText("git-stage", { status: "failed", stderr: "boom" })).toBe("failed — boom");
    expect(commitOutcomeText("git-commit", { status: "committed", sha: "abc1234" })).toBe("committed abc1234");
    expect(commitOutcomeText("git-commit", { status: "clean" })).toBe("clean — nothing staged");
    expect(commitOutcomeText("git-commit", { status: "skipped" })).toBe("skipped");
    expect(commitOutcomeText("git-commit", { status: "failed", stderr: "boom" })).toBe("failed — boom");
    // The unstage inverse shares every status with stage/commit except its
    // own `unstaged` (the status-bar switch must know it, or the narration
    // silently renders empty) and its own `clean` voice.
    expect(commitOutcomeText("git-unstage", { status: "unstaged", unstaged: 3 })).toBe("unstaged 3 paths");
    expect(commitOutcomeText("git-unstage", { status: "unstaged", unstaged: 0 })).toBe("unstaged 0 paths");
    expect(commitOutcomeText("git-unstage", { status: "clean" })).toBe("clean — nothing to unstage");
    expect(commitOutcomeText("git-unstage", { status: "skipped" })).toBe("skipped");
    expect(commitOutcomeText("git-unstage", { status: "failed", stderr: "boom" })).toBe("failed — boom");
  });
});
