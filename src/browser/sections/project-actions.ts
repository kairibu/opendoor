/**
 * Section module for the Doorstop panel body element: Project actions: identity, toolbar, git status and commit controls.
 *
 * Free render functions and handlers.  All state lives in the coordinator
 * (`../doorstop-panel-element.ts`), whose surface this module sees through the
 * narrow `DoorstopPanelSectionsApi` interface (type-only import, so the runtime
 * dependency stays one-way: coordinator -> sections).
 */

import { html, nothing, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { ref } from "lit/directives/ref.js";
import { doorstopIconSvg, gitCommitIconSvg, gitStageIconSvg, publishIconSvg, refreshIconSvg, validateIconSvg } from "../doorstop-panel-icons.js";
import type { DoorstopPanelSectionsApi } from "../doorstop-panel-section-host.js";
import { doorstopPaths } from "../doorstop-panel-controller.js";
import { doorstopPublishCommand, doorstopPublishTarget, gitStatusText } from "../doorstop-panel-view-model.js";

export function renderProjectActions(host: DoorstopPanelSectionsApi): TemplateResult {
  const publishTarget = doorstopPublishTarget(host.result);
  const projectPath = host.context?.workspace.path ?? "";
  // The heading is the project path (not a static "Doorstop" label):
  // basename displayed, full path kept as the tooltip.
  const projectLabel = projectPath === "" ? "Doorstop" : projectPath.split("/").filter(Boolean).pop() ?? projectPath;
  return html`
    <section class="doorstop-project-actions">
      <strong class="doorstop-title" title=${projectPath === "" ? nothing : projectPath}>${doorstopIconSvg}${projectLabel}</strong>
      ${renderViewToggle(host)}
      <div class="doorstop-toolbar-actions">
        ${host.stale ? html`<button type="button" class="doorstop-stale" title="Doorstop ran or files changed behind the panel — click to rescan" @click=${() => onRefreshClick(host)}>stale — refresh</button>` : nothing}
        ${host.confirmSkipped ? html`<span class="doorstop-muted doorstop-confirm-skipped" title="No confirmation dialog is available in this environment — publishing proceeded without one">confirmation skipped — publishing</span>` : nothing}
        <button type="button" class="doorstop-refresh" title="Re-read the workspace" @click=${() => onRefreshClick(host)}>${refreshIconSvg}Refresh</button>
        <button type="button" class="doorstop-validate" title="Run \`doorstop\` in the workspace (terminal when unpaired)" ?disabled=${host.runInProgress !== undefined} @click=${() => onValidateClick(host)}>${validateIconSvg}Run validation</button>
        <button type="button" class="doorstop-publish" title=${`Publish the tree to ${publishTarget}`} ?disabled=${host.runInProgress !== undefined} @click=${() => onPublishClick(host)}>${publishIconSvg}Publish HTML</button>
        ${renderGitActions(host)}
      </div>
    </section>
  `;
}

export function renderViewToggle(host: DoorstopPanelSectionsApi): TemplateResult {
  return html`
    <div class="doorstop-view-toggle" role="tablist" aria-label="Requirements panel view">
      <button
        type="button"
        role="tab"
        class=${classMap({
          "doorstop-view-tab": true,
          "doorstop-view-items": true,
          "is-selected": host.view === "items",
        })}
        aria-selected=${host.view === "items" ? "true" : "false"}
        title="Item list and detail"
        @click=${() => { host.view = "items"; }}
      >Items</button>
      <button
        type="button"
        role="tab"
        class=${classMap({
          "doorstop-view-tab": true,
          "doorstop-view-findings": true,
          "is-selected": host.view === "findings",
        })}
        aria-selected=${host.view === "findings" ? "true" : "false"}
        title="Validation findings"
        @click=${() => { host.view = "findings"; }}
      >Findings</button>
    </div>
  `;
}

/**
 * The commit INPUT is disabled while a run is in flight (like the
 * buttons) so a typed-but-never-submitted message cannot be lost when
 * the run's invalidate lands mid-typing.
 */
export function renderGitActions(host: DoorstopPanelSectionsApi): TemplateResult | typeof nothing {
  if (!host.backendActive()) return nothing;
  const hasDocuments = (host.result?.index.documents.length ?? 0) > 0;
  return html`
    ${renderGitStatus(host)}
    <button
      type="button"
      class="doorstop-git-stage"
      title="Stage all Doorstop-managed files (requirements, documents, configs)"
      ?disabled=${host.runInProgress !== undefined || !hasDocuments}
      @click=${() => onGitStageClick(host)}
    >${gitStageIconSvg}Stage all</button>
    <div class="doorstop-git-commit">
      <input
        type="text"
        class="doorstop-git-commit-input"
        placeholder="Commit message"
        aria-label="Git commit message"
        ?disabled=${host.runInProgress !== undefined}
        ${ref(host.gitCommitInputRef)}
        @input=${(event: Event) => onGitCommitInput(host, event)}
        @keydown=${(event: Event) => onGitCommitKeydown(host, event as KeyboardEvent)}
      />
      <button
        type="button"
        class="doorstop-git-commit-button"
        title="Commit the staged index with this message"
        ?disabled=${host.runInProgress !== undefined || host.gitCommitMessage.trim() === ""}
        @click=${() => onGitCommitClick(host)}
      >${gitCommitIconSvg}Commit</button>
      ${host.gitActionError === undefined ? nothing : html`<span class="doorstop-op-error" role="alert">${host.gitActionError}</span>`}
    </div>
  `;
}

export function renderGitStatus(host: DoorstopPanelSectionsApi): TemplateResult | typeof nothing {
  const view = host.gitStatusView;
  if (view === undefined) return nothing;
  const refresh = (): void => { void host.controller?.requestGitStatus(); };
  switch (view.state) {
    case "loading":
      return html`<button
        type="button"
        class="doorstop-git-status"
        title="Refreshing git status…"
        aria-busy=${host.gitStatusInFlight}
        @click=${refresh}
      ><span class="doorstop-git-status-text">⎇ …</span></button>`;
    case "no-git":
      return html`<button type="button" class="doorstop-git-status" title="Not a git repository — click to re-check" aria-busy=${host.gitStatusInFlight} @click=${refresh}><span class="doorstop-git-status-text">no git</span></button>`;
    case "error":
      return html`<button
        type="button"
        class="doorstop-git-status doorstop-git-status-error"
        title=${`Git status unavailable — ${view.errorMessage ?? "request failed"} — click to retry`}
        aria-busy=${host.gitStatusInFlight}
        @click=${refresh}
      ><span class="doorstop-git-status-text">git status error — retry</span></button>`;
    case "ready":
      return html`<button type="button" class="doorstop-git-status" title="Git status — click to refresh" aria-busy=${host.gitStatusInFlight} @click=${refresh}><span class="doorstop-git-status-text">${gitStatusText(view.response)}</span></button>`;
  }
}

export function onRefreshClick(host: DoorstopPanelSectionsApi): void {
  void host.controller?.invalidate();
}

export function onValidateClick(host: DoorstopPanelSectionsApi): void {
  host.runDoorstop("validate", "Doorstop: validate", { op: "validate" }, "doorstop", true);
}

export function onPublishClick(host: DoorstopPanelSectionsApi): void {
  // Publishing writes HTML artifacts across the workspace, so confirm
  // before running when the host exposes a confirm dialog. Sandboxed
  // plugin hosts may not define window.confirm (it silently evaluates
  // false/undefined there), so feature-detect: run publish anyway and
  // surface a muted notice rather than dropping the action.
  const target = doorstopPublishTarget(host.result);
  if (typeof window.confirm === "function") {
    if (!window.confirm(`Publish the Doorstop tree as HTML to ${target} in the workspace terminal?`)) return;
    host.confirmSkipped = false;
  } else {
    host.confirmSkipped = true;
  }
  host.runDoorstop(
    "publish",
    "Doorstop: publish",
    { op: "publish", target },
    doorstopPublishCommand(host.result, target),
    false,
  );
}

export function onGitStageClick(host: DoorstopPanelSectionsApi): void {
  // The button's disabled state covers pointer clicks; this guard
  // covers every call path. An empty path list is DEFENSIVE only (the
  // button is disabled without documents) — surfaced as an inline
  // error, never a silent return.
  const controller = host.controller;
  if (controller === undefined) return;
  if (controller.runInProgress !== undefined) return;
  const result = host.result;
  if (result === undefined) {
    host.gitActionError = "The workspace is not loaded — refresh first";
    return;
  }
  const paths = doorstopPaths(result);
  if (paths.length === 0) {
    host.gitActionError = "Nothing to stage — the workspace has no Doorstop-managed files";
    return;
  }
  host.gitActionError = undefined;
  void controller.runGitStage(paths);
}

export function onGitCommitInput(host: DoorstopPanelSectionsApi, event: Event): void {
  host.gitCommitMessage = (event.target as HTMLInputElement).value;
}

export function onGitCommitClick(host: DoorstopPanelSectionsApi): void {
  gitCommitSubmit(host);
}

export function onGitCommitKeydown(host: DoorstopPanelSectionsApi, event: KeyboardEvent): void {
  const input = host.gitCommitInputRef.value;
  if (input === undefined) return;
  if (event.key === "Enter") {
    event.preventDefault();
    gitCommitSubmit(host);
  } else if (event.key === "Escape") {
    input.value = "";
    host.gitCommitMessage = "";
    host.gitActionError = undefined;
  }
}

/**
 * The browser must never send an empty commit message: the server
 * rejects it, and git with an empty `-m` would hang the exec until the
 * deadline. The input is cleared only on SUCCESS so a `failed` commit
 * (hook stderr, missing identity) keeps the message for a corrected
 * retry.
 */
export function gitCommitSubmit(host: DoorstopPanelSectionsApi): void {
  const controller = host.controller;
  if (controller === undefined) return;
  if (controller.runInProgress !== undefined) return;
  const input = host.gitCommitInputRef.value;
  const message = input?.value.trim() ?? "";
  if (message === "") {
    host.gitActionError = "Enter a commit message";
    input?.focus();
    return;
  }
  host.gitActionError = undefined;
  void controller.runGitCommit(message).then(() => {
    const lastRun = controller.lastRun;
    if (lastRun?.op === "git-commit" && lastRun.status === "ok" && input !== undefined) {
      input.value = "";
      host.gitCommitMessage = "";
    }
  });
}
