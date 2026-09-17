/**
 * Section module for the Doorstop panel body element: Status bar: the last run's outcome, its auto-expanded output and its dismiss action.
 *
 * Free render functions and handlers.  All state lives in the coordinator
 * (`../doorstop-panel-element.ts`), whose surface this module sees through the
 * narrow `DoorstopPanelSectionsApi` interface (type-only import, so the runtime
 * dependency stays one-way: coordinator -> sections).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { DoorstopPanelSectionsApi } from "../doorstop-panel-section-host.js";
import { type DoorstopLastRunView } from "../doorstop-panel-controller.js";
import { commitOutcomeText } from "../doorstop-panel-view-model.js";

/**
 * Expansion is CONTENT-DRIVEN (see `willUpdate`); there is no manual
 * expand/collapse toggle.
 */
export function renderStatusBar(host: DoorstopPanelSectionsApi): TemplateResult | typeof nothing {
  const lastRun = host.lastRun;
  if (lastRun === undefined) return nothing;
  const statusLabel = lastRun.status === "killed" ? "killed (timeout)" : lastRun.status;
  const detailParts: string[] = [lastRun.title, `${String(lastRun.durationMs)} ms`];
  if (lastRun.exitCode !== null && (lastRun.status === "failed" || lastRun.status === "killed")) {
    detailParts.push(`exit ${String(lastRun.exitCode)}`);
  }
  if (lastRun.signal !== null) detailParts.push(lastRun.signal);
  return html`
    <section class="doorstop-status-bar" aria-label="Last run">
      <div class="doorstop-status-bar-row">
        <span class=${`doorstop-last-run-status is-${lastRun.status}`}>${statusLabel}</span>
        <span class="doorstop-last-run-meta">${detailParts.join(" · ")}</span>
        <button
          type="button"
          class="doorstop-last-run-dismiss"
          title="Dismiss the last run output"
          @click=${() => onDismissRun(host)}
        >Dismiss</button>
      </div>
      ${host.statusExpanded ? renderStatusBarBody(host, lastRun) : nothing}
    </section>
  `;
}

export function renderStatusBarBody(host: DoorstopPanelSectionsApi, lastRun: DoorstopLastRunView): TemplateResult {
  return html`
    <div class="doorstop-last-run">
      ${lastRun.commit === undefined
        ? nothing
        : html`<p class="doorstop-last-run-commit doorstop-muted">${commitOutcomeText(lastRun.op, lastRun.commit)}</p>`}
      ${lastRun.status === "error"
        ? html`<pre class="doorstop-last-run-pre">${lastRun.errorMessage ?? ""}</pre>`
        : nothing}
      ${lastRun.stdout === ""
        ? nothing
        : html`
            <pre class="doorstop-last-run-pre">${lastRun.stdout}</pre>
            ${lastRun.stdoutTruncated
              ? html`<p class="doorstop-last-run-notice">stdout truncated by the host stream limit (2 MiB) — output not fully captured</p>`
              : nothing}
          `}
      ${lastRun.stderr === ""
        ? nothing
        : html`
            <pre class="doorstop-last-run-pre">${lastRun.stderr}</pre>
            ${lastRun.stderrTruncated
              ? html`<p class="doorstop-last-run-notice">stderr truncated by the host stream limit (2 MiB) — output not fully captured</p>`
              : nothing}
          `}
      ${lastRun.stdout === "" && lastRun.stderr === "" && lastRun.status !== "error"
        ? html`<p class="doorstop-last-run-notice">No output captured.</p>`
        : nothing}
    </div>
  `;
}

export function onDismissRun(host: DoorstopPanelSectionsApi): void {
  host.statusExpanded = false;
  host.controller?.dismissRun();
}
