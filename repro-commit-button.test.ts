// Throwaway repro: does typing into the commit input enable the Commit button?
import { defineCustomElementOnce } from "@jmfederico/pi-web/plugin-api";
import { DoorstopWorkspaceController } from "./doorstop-panel-controller.js";
import { defineDoorstopPanelElements, doorstopPaths, type DoorstopPanelBodyElement } from "./doorstop-panel-elements.js";
import { bodyElementTag, type DoorstopWorkspaceJob } from "./doorstop-test-support.js";
import { DOORSTOP_GIT_COMMIT_OPERATION, DOORSTOP_GIT_STAGE_OPERATION, DOORSTOP_GIT_STATUS_OPERATION } from "./doorstop-backend-contract.js";
import { vi, expect, it } from "vitest";
import { makeTreeResult, panelContext, settle, flush } from "./doorstop-panel-elements.test.js";

it("typing into the commit input enables the Commit button", async () => {
  defineDoorstopPanelElements();
  const backend = vi.fn((operation: string, _input: unknown) =>
    operation === DOORSTOP_GIT_STATUS_OPERATION
      ? Promise.resolve({ git: true, branch: "main", staged: 1, dirty: 2, files: [] })
      : Promise.resolve({ status: "committed", sha: "abc1234" }),
  );
  const created = panelContext({ backend });
  const controller = new DoorstopWorkspaceController({ isConnected: false }, created.context, makeTreeResult() as unknown as DoorstopWorkspaceJob);
  const body = document.createElement(bodyElementTag) as DoorstopPanelBodyElement;
  document.body.append(body);
  // mirror like bindBody
  body.controller = controller;
  body.context = created.context;
  body.result = controller.result;
  body.loading = controller.loading;
  body.stale = controller.stale;
  body.error = controller.error;
  body.search = controller.search;
  body.lastRun = controller.lastRun;
  body.runInProgress = controller.runInProgress;
  body.baselineVersion = controller.baselineVersion;
  body.baselineInFlight = controller.baselineInFlight;
  body.gitStatusView = controller.gitStatusView;
  body.gitStatusInFlight = controller.gitStatusInFlight;
  await body.updateComplete;
  await settle();
  await flush(body);

  const button = body.shadowRoot?.querySelector<HTMLButtonElement>(".doorstop-git-commit-button");
  const input = body.shadowRoot?.querySelector<HTMLInputElement>(".doorstop-git-commit-input");
  if (!button || !input) throw new Error("commit controls not rendered");
  console.log("initial disabled:", button.disabled);
  console.log("initial runInProgress:", controller.runInProgress, "element:", (body as unknown as { runInProgress: unknown }).runInProgress);

  input.value = "fix REQ003";
  input.dispatchEvent(new Event("input"));
  await body.updateComplete;
  await flush(body);
  console.log("after typing disabled:", button.disabled, "state:", JSON.stringify((body as unknown as { gitCommitMessage: string }).gitCommitMessage));
  it.skip("marker", () => {});
});
