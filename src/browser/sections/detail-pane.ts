/**
 * Section module for the Doorstop panel body element: Detail pane: item fields, links, references, baseline diff and live git actions.
 *
 * Free render functions and handlers.  All state lives in the coordinator
 * (`../doorstop-panel-element.ts`), whose surface this module sees through the
 * narrow `DoorstopPanelSectionsApi` interface (type-only import, so the runtime
 * dependency stays one-way: coordinator -> sections).
 */

import { html, nothing, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { keyed } from "lit/directives/keyed.js";
import { trashIconSvg } from "../doorstop-panel-icons.js";
import type { DoorstopPanelSectionsApi } from "../doorstop-panel-section-host.js";
import { type DoorstopIndex, type ItemRecord, type LinkRecord } from "../../doorstop-contract.js";
import { computeItemStamp } from "../../doorstop-state.js";
import type { DiffLine, ItemFieldDiff } from "../../doorstop-diff.js";
import { type DoorstopBaselineView } from "../doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "../doorstop-panel.js";
import { diffValueText, documentConfigFor, jsonishText, referenceListText, shortFingerprint } from "../doorstop-panel-view-model.js";

// v1 deliberately renders the item text as escaped text — no markdown,
// injection-safe by construction.
export function renderDetail(host: DoorstopPanelSectionsApi, result: DoorstopWorkspaceResult): TemplateResult {
  const selectedUid = host.selectedUid;
  if (selectedUid === undefined) {
    return html`<p class="doorstop-muted doorstop-standalone">Select an item in the list to inspect its details.</p>`;
  }
  const item = result.index.byUid.get(selectedUid);
  // result is always assigned at the end of a load and the controller
  // clears dangling selections after every re-load, so a missing item
  // only means a selection that no longer exists — never a loading race.
  if (item === undefined) {
    return html`<p class="doorstop-muted doorstop-standalone">This item is no longer available — refresh the panel.</p>`;
  }
  const children = result.index.childrenByUid.get(item.uid) ?? [];
  const findings = result.index.findings.filter((finding) => finding.uid === item.uid);
  return html`
    <section class="doorstop-detail" aria-label="Item details">
      <div class="doorstop-detail-head">
        <code class="doorstop-detail-uid">${item.uid}</code>
        <span class="doorstop-level">level ${item.level}</span>
        ${item.header === undefined ? nothing : html`<h3>${item.header}</h3>`}
      </div>
      ${renderFlags(host, item)}
      <div class="doorstop-state-chip-row">
        ${item.stateKeys.map((key) => host.renderStateChip(key))}
      </div>
      <h4 class="doorstop-section-title">Text</h4>
      <p class=${item.text === "" ? "doorstop-text doorstop-text-empty" : "doorstop-text"}>${item.text === "" ? "empty" : item.text}</p>
      ${renderChangesSinceReview(host, item)}
      <h4 class="doorstop-section-title">Parent links</h4>
      ${renderLinksOut(host, item, result.index)}
      <h4 class="doorstop-section-title">Child links</h4>
      ${renderLinksIn(host, item, result.index, children)}
      <h4 class="doorstop-section-title">References</h4>
      ${renderReferences(host, item, result.index)}
      ${Object.entries(item.attributes).length === 0
        ? nothing
        : html`
            <h4 class="doorstop-section-title">Extended attributes</h4>
            <dl class="doorstop-attributes">
              ${Object.entries(item.attributes).map(
                ([key, value]) =>
                  html`<div class="doorstop-attribute"><dt>${key}</dt><dd><code>${jsonishText(value)}</code></dd></div>`,
              )}
            </dl>
          `}
      <h4 class="doorstop-section-title">Findings</h4>
      ${findings.length === 0
        ? html`<p class="doorstop-muted">No local findings for this item.</p>`
        : html`<div class="doorstop-findings" aria-label="Findings for this item">
            ${findings.map((finding) => {
              const kind = finding.severity === "error" ? "doorstop-error" : finding.severity === "warning" ? "doorstop-warning" : "doorstop-info";
              return html`<div class=${`doorstop-finding ${kind}`}><span class="doorstop-finding-severity">${finding.severity}</span><span>${finding.message}</span></div>`;
            })}
          </div>`}
    </section>
  `;
}

export function renderFlags(host: DoorstopPanelSectionsApi, item: ItemRecord): TemplateResult {
  return html`
    <div class="doorstop-flags" aria-label="Item flags">
      <span class=${classMap({ "doorstop-flag": true, "is-inactive": !item.active })}>
        ${item.active ? "active" : "inactive"}
      </span>
      <span class="doorstop-flag">${item.normative ? "normative" : "non-normative"}</span>
      <span class="doorstop-flag">${item.derived ? "derived" : "non-derived"}</span>
    </div>
  `;
}

/** `computeItemStamp(parent, config, false)` is exactly the
 *  link-record stamp the state chain compares against. */
export function renderLinksOut(host: DoorstopPanelSectionsApi, item: ItemRecord, index: DoorstopIndex): TemplateResult {
  if (item.links.length === 0) return html`<p class="doorstop-muted">No parent links.</p>`;
  return html`
    <div class="doorstop-links" aria-label="Parent links">
      ${item.links.map((link) => renderLinkOut(host, item, link, index))}
    </div>
  `;
}

export function renderLinkOut(host: DoorstopPanelSectionsApi, item: ItemRecord, link: LinkRecord, index: DoorstopIndex): TemplateResult {
  // The trash can is pointer-only by design: the known-target row IS a
  // <button>, so a nested <button> would be hoisted out by the HTML
  // parser. A <span> parses fine, but a role="button" that is not
  // keyboard-operable would violate the ARIA contract — and the
  // keyboard path is the palette's Unlink input — so it is hidden from
  // the accessibility tree (`aria-hidden`) and left as a pointer
  // shortcut. `stopPropagation` is mandatory on the known-target row so
  // the click does not also navigate to the link target.
  const remove = html`
    <span
      class="doorstop-link-remove"
      aria-hidden="true"
      title=${`doorstop unlink ${item.uid} ${link.uid}`}
      @click=${(event: Event) => { event.stopPropagation(); unlinkLink(host, item, link.uid); }}
    >${trashIconSvg}</span>
  `;
  const target = index.byUid.get(link.uid);
  if (target === undefined) {
    return html`
      <div class="doorstop-link-row">
        <code>${link.uid}</code>
        <span class="doorstop-chip doorstop-chip-danger">unknown</span>
        <span class="doorstop-fingerprint">not in the index — ${link.fingerprint === null ? "no recorded fingerprint" : `recorded ${shortFingerprint(link.fingerprint)}`}</span>
        ${remove}
      </div>
    `;
  }
  const current = computeItemStamp(target, documentConfigFor(index, target), false);
  const suspect = link.fingerprint !== null && link.fingerprint !== current;
  return html`
    <button
      type="button"
      class="doorstop-link-row"
      data-uid=${link.uid}
      title=${`Open ${link.uid}`}
      @click=${() => { host.controller?.selectUid(link.uid); }}
    >
      <code>${link.uid}</code>
      <span class=${suspect ? "doorstop-chip doorstop-chip-danger" : "doorstop-chip doorstop-chip-ok"}>${suspect ? "suspect" : "ok"}</span>
      <span class="doorstop-fingerprint">recorded ${shortFingerprint(link.fingerprint)} · current ${shortFingerprint(current)}</span>
      ${remove}
    </button>
  `;
}

export function renderLinksIn(
  host: DoorstopPanelSectionsApi,
  item: ItemRecord,
  index: DoorstopIndex,
  children: readonly ItemRecord[],
): TemplateResult {
  if (children.length === 0) {
    return html`<p class="doorstop-muted">No child links.</p>`;
  }
  return html`
    <div class="doorstop-links" aria-label="Child links">
      ${children.map((child) =>
        html`<button type="button" class="doorstop-link-row" data-uid=${child.uid} title=${`Open ${child.uid}`} @click=${() => { host.controller?.selectUid(child.uid); }}>
          <code>${child.uid}</code>
          <span class="doorstop-muted">${child.level}</span>
        </button>`,
      )}
    </div>
  `;
}

export function renderReferences(host: DoorstopPanelSectionsApi, item: ItemRecord, index: DoorstopIndex): TemplateResult {
  const paths: string[] = [];
  if (item.ref !== "") paths.push(item.ref);
  if (item.references !== undefined) {
    for (const reference of item.references) paths.push(reference.path);
  }
  if (paths.length === 0) return html`<p class="doorstop-muted">No file references.</p>`;
  return html`
    <div class="doorstop-links" aria-label="File references">
      ${paths.map((path) => {
        const found = index.knownFilePaths.has(path);
        return html`
          <div class="doorstop-link-row">
            <code>${path}</code>
            ${found ? nothing : html`<span class="doorstop-chip doorstop-chip-danger">not found</span>`}
          </div>
        `;
      })}
    </div>
  `;
}

/**
 * The `<details>` is wrapped in `keyed(item.uid, …)` so a selection
 * switch RE-CREATES the node (fresh, collapsed, with a real `toggle` on
 * expand) instead of Lit reusing the old item's open node — a reused
 * node fires no `toggle`, which would strand the new item on
 * "Loading baseline…". {@link updated} covers the remaining reuse
 * hole (same item re-rendered after its cache key changed).
 */
export function renderChangesSinceReview(host: DoorstopPanelSectionsApi, item: ItemRecord): ReturnType<typeof keyed> | typeof nothing {
  if (!item.stateKeys.includes("unreviewed") || item.reviewed === null) return nothing;
  if (!host.backendActive()) return nothing;
  const view = host.controller?.baselineViewFor(item);
  return keyed(
    item.uid,
    html`
      <details class="doorstop-changes" @toggle=${(event: Event) => onChangesToggle(host, event)}>
        <summary class="doorstop-changes-summary">Changes since review</summary>
        ${view === undefined || view.state === "loading"
          ? html`<p class="doorstop-muted doorstop-changes-notice">Loading baseline…</p>`
          : renderBaselineView(host, view)}
      </details>
    `,
  );
}

export function renderBaselineView(host: DoorstopPanelSectionsApi, view: DoorstopBaselineView): TemplateResult {
  switch (view.state) {
    case "loading":
      return html`<p class="doorstop-muted doorstop-changes-notice">Loading baseline…</p>`;
    case "no-git":
      return html`<p class="doorstop-muted doorstop-changes-notice">No git history — previous version unavailable</p>`;
    case "no-match":
      return html`<p class="doorstop-muted doorstop-changes-notice">Could not locate the reviewed version (history may have been rewritten)</p>`;
    case "error":
      return html`<p class="doorstop-muted doorstop-changes-notice">Baseline unavailable — ${view.errorMessage ?? "request failed"}</p>`;
    case "ready": {
      const diff = view.diff;
      if (diff === undefined) return html`<p class="doorstop-muted doorstop-changes-notice">No changes found.</p>`;
      return renderBaselineDiff(host, view, diff);
    }
  }
}

export function renderBaselineDiff(host: DoorstopPanelSectionsApi, view: DoorstopBaselineView, diff: ItemFieldDiff): TemplateResult {
  return html`
    ${view.source === undefined
      ? nothing
      : html`<p class="doorstop-muted doorstop-changes-source">matched via ${view.source === "review-commit" ? "review commit" : "history walk"}</p>`}
    ${diff.text === undefined
      ? html`<p class="doorstop-muted doorstop-changes-notice">Text changed — too large to render a line diff.</p>`
      : html`<div class="doorstop-diff-lines" role="list" aria-label="Text changes since review">
          ${diff.text.map((line) => renderDiffLine(host, line))}
        </div>`}
    ${diff.ref === undefined ? nothing : renderFieldChange(host, "ref", diff.ref.before, diff.ref.after)}
    ${diff.references === undefined
      ? nothing
      : renderFieldChange(host,
          "references",
          referenceListText(diff.references.before),
          referenceListText(diff.references.after),
        )}
    ${diff.linksAdded.length === 0 && diff.linksRemoved.length === 0
      ? nothing
      : html`<div class="doorstop-field-change">
          <span class="doorstop-field-name">links</span>
          ${diff.linksAdded.map((uid) => html`<code class="doorstop-field-chip doorstop-field-chip-after">+ ${uid}</code>`)}
          ${diff.linksRemoved.map((uid) => html`<code class="doorstop-field-chip doorstop-field-chip-before">− ${uid}</code>`)}
        </div>`}
    ${diff.extended.map((change) => renderFieldChange(host, change.name, change.before, change.after))}
  `;
}

export function renderDiffLine(host: DoorstopPanelSectionsApi, line: DiffLine): TemplateResult {
  const mark = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "";
  return html`
    <div class=${`doorstop-diff-line is-${line.kind}`} role="listitem">
      <span class="doorstop-diff-mark">${mark}</span>
      <span class="doorstop-diff-text">${line.text === "" ? "\u00a0" : line.text}</span>
    </div>
  `;
}

export function renderFieldChange(host: DoorstopPanelSectionsApi, label: string, before: unknown, after: unknown): TemplateResult {
  return html`
    <div class="doorstop-field-change">
      <span class="doorstop-field-name">${label}</span>
      <code class="doorstop-field-chip doorstop-field-chip-before">${diffValueText(before)}</code>
      <span class="doorstop-field-arrow">→</span>
      <code class="doorstop-field-chip doorstop-field-chip-after">${diffValueText(after)}</code>
    </div>
  `;
}

export function onChangesToggle(host: DoorstopPanelSectionsApi, event: Event): void {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  const item = host.selectedItem();
  if (item === undefined) return;
  void host.controller?.requestBaseline(item);
}

/** Unlink one parent from one item — the same `unlink` run the palette's
 *  free-text Unlink button dispatches, but with the target sourced from
 *  the index (`link.uid`) instead of an input. The guard mirrors
 *  {@link stageItem}: a run already in flight must never be overlapped.
 *  There is no `targetError` interaction: an index-sourced UID cannot
 *  fail the free-text validation, and `parseDoorstopRunRequest`
 *  re-validates server-side. */
export function unlinkLink(host: DoorstopPanelSectionsApi, item: ItemRecord, target: string): void {
  const controller = host.controller;
  // Deliberately redundant with the guard inside runDoorstop: keeping the
  // same early-out here as stageItem/unstageItem makes the in-flight
  // contract uniform across every detail-pane action.
  if (controller === undefined || controller.runInProgress !== undefined) return;
  host.runDoorstop(
    "unlink",
    `Doorstop: unlink ${item.uid}`,
    { op: "unlink", uid: item.uid, target },
    `doorstop unlink ${item.uid} ${target}`,
    false,
  );
}
