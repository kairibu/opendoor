/**
 * Section module for the Doorstop panel body element: Item list: document/state/search filters, the item rows and the findings view.
 *
 * Free render functions and handlers.  All state lives in the coordinator
 * (`../doorstop-panel-element.ts`), whose surface this module sees through the
 * narrow `DoorstopPanelSectionsApi` interface (type-only import, so the runtime
 * dependency stays one-way: coordinator -> sections).
 */

import { html, nothing, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { gitStageIconSvg, gitUnstageIconSvg, insertPromptIconSvg } from "../doorstop-panel-icons.js";
import type { DoorstopPanelSectionsApi } from "../doorstop-panel-section-host.js";
import { type DoorstopDocumentConfig, type DoorstopIndex, type ItemRecord, type ItemStateKey } from "../../doorstop-contract.js";
import type { DoorstopGitStatusFile } from "../../doorstop-backend-contract.js";
import type { DoorstopWorkspaceResult } from "../doorstop-panel.js";
import { ALL_DOCUMENTS_LABEL, documentStateDots, dotTitle, doorstopShowAdditionalAttribute, EMPTY_WORKSPACE_MESSAGE, filteredItems, FINDINGS_EMPTY_HINT, FINDINGS_EMPTY_MESSAGE, FINDINGS_PLUGIN_LOCAL_NOTE, findingsCountText, findingsViewCounts, findingsViewRows, GIT_CHIP_LABELS, gitChipKind, itemExcerpt, itemGitState, itemStageable, itemUnstageable, shownAttributeRows, STATE_CHIP_LABELS, stateChipKind, type FindingsViewRow } from "../doorstop-panel-view-model.js";
import { renderDetail } from "./detail-pane.js";

export function renderListFilters(host: DoorstopPanelSectionsApi, result: DoorstopWorkspaceResult): TemplateResult {
  return html`
    <section class="doorstop-list-filters">
      <div class="doorstop-docs" role="list" aria-label="Doorstop documents">
        ${renderDocumentChip(host, undefined, result)}
        ${result.index.documents.map((document) => renderDocumentChip(host, document, result))}
      </div>
      <select class="doorstop-state-filter" aria-label="Filter by state" @change=${(event: Event) => onStateFilterChange(host, event)}>
        <option value="" .selected=${host.stateFilter === undefined}>All states</option>
        ${Object.entries(STATE_CHIP_LABELS).map(
          ([key, label]) =>
            html`<option value=${key} .selected=${host.stateFilter === key}>${label}</option>`,
        )}
      </select>
      <input
        class="doorstop-search"
        type="search"
        aria-label="Search items"
        placeholder="Search UID or text"
        .value=${host.search}
        @input=${(event: Event) => onSearchInput(host, event)}
      />
    </section>
  `;
}

export function renderDocumentChip(
  host: DoorstopPanelSectionsApi,
  document: DoorstopDocumentConfig | undefined,
  result: DoorstopWorkspaceResult,
): TemplateResult {
  const prefix = document?.prefix ?? ALL_DOCUMENTS_LABEL;
  const count =
    document === undefined
      ? result.index.items.length
      : result.index.items.filter((item) => item.documentPrefix === document.prefix).length;
  const dots = document === undefined ? [] : documentStateDots(document, result.index.items);
  const selected =
    document === undefined
      ? host.selectedDocumentPrefix === undefined || host.selectedDocumentPrefix === ""
      : host.selectedDocumentPrefix === document.prefix;
  return html`
    <button
      type="button"
      role="listitem"
      class=${classMap({ "doorstop-doc-chip": true, "is-selected": selected })}
      data-prefix=${document?.prefix ?? ""}
      @click=${() => { host.controller?.selectDocument(document?.prefix ?? ""); }}
    >
      ${document?.parentPrefix === undefined ? nothing : html`<span class="doorstop-doc-arrow">← ${document.parentPrefix}</span>`}
      <span class="doorstop-doc-prefix">${prefix}</span>
      <span class="doorstop-doc-count">${String(count)}</span>
      ${dots.map((dot) => html`<span class=${`doorstop-dot doorstop-dot-${dot}`} title=${dotTitle(dot)}></span>`)}
    </button>
  `;
}

export function renderViewer(host: DoorstopPanelSectionsApi): TemplateResult {
  const result = host.result;
  if (result === undefined) {
    return html`<p class="doorstop-muted doorstop-standalone">${host.loading ? "Loading workspace…" : "Run Refresh to scan for Doorstop documents."}</p>`;
  }
  // Rendered in BOTH branches: diagnostics must never be silently
  // dropped — a workspace whose only document failed to parse still
  // shows the strip above the empty state.
  if (host.view === "findings") {
    return renderFindingsView(host, result);
  }
  return html`
    ${renderListFilters(host, result)}
    ${result.index.documents.length === 0
      ? html`
          ${renderDiagnostics(host, result)}
          <section class="doorstop-empty"><p>${EMPTY_WORKSPACE_MESSAGE}</p></section>
        `
      : html`
          <section class="doorstop-split">
            <section class="doorstop-list">
              ${renderDiagnostics(host, result)}
              ${renderItemList(host, result)}
            </section>
            <section class="doorstop-detail-pane">${renderDetail(host, result)}</section>
          </section>
        `}
  `;
}

export function renderItemList(host: DoorstopPanelSectionsApi, result: DoorstopWorkspaceResult): TemplateResult {
  if (result.index.items.length === 0) {
    return html`<p class="doorstop-muted doorstop-standalone">No Doorstop items found (item files may be binary or truncated — see the diagnostics above).</p>`;
  }
  const items = filteredItems(result.index, host.selectedDocumentPrefix, host.stateFilter, host.search);
  if (items.length === 0) {
    return html`<p class="doorstop-muted doorstop-standalone">No items match the current document, state, or search filters.</p>`;
  }
  // One lookup pass for the whole list; each row reads its own path.
  const gitFiles = host.readyGitFiles();
  // The configured attribute NAMES, computed once per list render; the
  // empty default keeps the original 4-column row grid (no stray gap).
  const attributeKeys = doorstopShowAdditionalAttribute(result);
  return html`
    <div
      class=${classMap({ "doorstop-items": true, "has-item-attrs": attributeKeys.length > 0 })}
      role="list"
      aria-label="Doorstop items"
    >
      ${repeat(items, (item) => item.uid, (item) => renderItemRow(host, item, gitFiles, attributeKeys))}
    </div>
  `;
}

export function renderItemRow(
  host: DoorstopPanelSectionsApi,
  item: ItemRecord,
  gitFiles: Map<string, DoorstopGitStatusFile> | undefined,
  attributeKeys: readonly string[],
): TemplateResult {
  const selected = host.selectedUid === item.uid;
  const gitState = itemGitState(gitFiles?.get(item.path));
  const shownAttributes = shownAttributeRows(item, attributeKeys);
  // The per-row add/remove is pointer-only by design: the row IS a
  // <button>, so a nested <button> would be hoisted out by the HTML
  // parser. A <span> parses fine, but a role="button" that is not
  // keyboard-operable would violate the ARIA contract — and the
  // affordance is redundant with the keyboard-reachable region-4
  // Stage/Unstage buttons — so it is hidden from the accessibility
  // tree (`aria-hidden`) and left as a pointer shortcut. One span
  // hosts BOTH directions: the minus (index/X dirty) takes precedence
  // over the plus (worktree/Y dirty) so a `staged-changed` (`MM`) row
  // shows the requested "I staged by mistake" minus, and the palette's
  // Stage button remains the keyboard path for the plus half.
  const stageable = itemStageable(gitFiles?.get(item.path));
  const unstageable = itemUnstageable(gitFiles?.get(item.path));
  // The insert-into-prompt arrow follows the same pointer-only contract (it
  // is aria-hidden, no role, and stops propagation so the row keeps its
  // selection); unlike the git affordance it renders on clean rows too, so a
  // clean row can still send its UID to the prompt. It is gated on the panel
  // context because `insertPrompt` is a silent no-op without one (standalone /
  // unpaired panel) — an ungated arrow would be a dead affordance.
  return html`
    <button
      type="button"
      role="listitem"
      class=${classMap({ "doorstop-item-row": true, "is-selected": selected })}
      data-uid=${item.uid}
      @click=${() => { host.controller?.selectUid(item.uid); }}
    >
      <span class="doorstop-item-level">${item.level}</span>
      <code class="doorstop-item-uid">${item.uid}</code>
      <span class="doorstop-item-summary">${itemExcerpt(item)}</span>
      ${shownAttributes.length === 0
        ? nothing
        : html`<span class="doorstop-item-attrs">${shownAttributes.map((row) => `${row.key}: ${row.text}`).join(" · ")}</span>`}
      <span class="doorstop-item-chips">
        ${item.stateKeys.map((key) => renderStateChip(key))}
        ${gitState === "clean" ? nothing : html`<span class=${`doorstop-chip doorstop-chip-${gitChipKind(gitState)}`}>${GIT_CHIP_LABELS[gitState]}</span>`}
        ${unstageable && host.runInProgress === undefined
          ? html`<span
              class="doorstop-item-add"
              aria-hidden="true"
              title=${`git reset ${item.path}`}
              @click=${(event: Event) => { event.stopPropagation(); host.unstageItem(item); }}
            >${gitUnstageIconSvg}</span>`
          : stageable && host.runInProgress === undefined
            ? html`<span
                class="doorstop-item-add"
                aria-hidden="true"
                title=${`git add ${item.path}`}
                @click=${(event: Event) => { event.stopPropagation(); host.stageItem(item); }}
              >${gitStageIconSvg}</span>`
            : nothing}
        ${host.context === undefined
          ? nothing
          : html`<span
              class="doorstop-item-insert"
              aria-hidden="true"
              title=${`Insert ${item.uid} into the prompt`}
              @click=${(event: Event) => { event.stopPropagation(); host.insertPrompt(item.uid); }}
            >${insertPromptIconSvg}</span>`}
      </span>
    </button>
  `;
}

export function renderStateChip(key: ItemStateKey): TemplateResult {
  const kind = stateChipKind(key);
  return html`<span class=${`doorstop-chip doorstop-chip-${kind}`}>${STATE_CHIP_LABELS[key]}</span>`;
}

export function renderDiagnostics(host: DoorstopPanelSectionsApi, result: DoorstopWorkspaceResult): TemplateResult | typeof nothing {
  if (result.index.diagnostics.length === 0) return nothing;
  return html`
    <section class="doorstop-diagnostics" aria-label="Workspace diagnostics">
      ${result.index.diagnostics.map((diagnostic) => {
        const kind = diagnostic.severity === "error" ? "doorstop-error" : "doorstop-warning";
        return html`
          <div class=${`doorstop-diagnostic ${kind}`}>
            <span class="doorstop-severity">${diagnostic.severity}</span>
            <span class="doorstop-diagnostic-copy">
              ${diagnostic.path === undefined ? nothing : html`<code>${diagnostic.path}</code>`}
              ${diagnostic.message}
            </span>
          </div>
        `;
      })}
    </section>
  `;
}

export function renderFindingsView(host: DoorstopPanelSectionsApi, result: DoorstopWorkspaceResult): TemplateResult {
  const rows = findingsViewRows(result.index);
  const counts = findingsViewCounts(rows);
  return html`
    <section class="doorstop-findings-view" aria-label="Doorstop findings">
      <header class="doorstop-findings-head">
        <span class="doorstop-findings-counts" role="status" aria-label="Finding counts">${findingsCountText(counts)}</span>
        <span class="doorstop-findings-note doorstop-muted">${FINDINGS_PLUGIN_LOCAL_NOTE}</span>
      </header>
      ${rows.length === 0
        ? html`
            <section class="doorstop-empty">
              <p>${FINDINGS_EMPTY_MESSAGE}</p>
              <p class="doorstop-muted">${FINDINGS_EMPTY_HINT}</p>
            </section>
          `
        : html`<div class="doorstop-findings-list" role="list" aria-label="Validation findings">
            ${rows.map((row) => renderFindingRow(host, row, result.index))}
          </div>`}
    </section>
  `;
}

export function renderFindingRow(host: DoorstopPanelSectionsApi, row: FindingsViewRow, index: DoorstopIndex): TemplateResult {
  const kind =
    row.severity === "error" ? "doorstop-error" : row.severity === "warning" ? "doorstop-warning" : "doorstop-info";
  const uid = row.uid;
  const navigable = uid !== undefined && index.byUid.has(uid);
  return html`
    <div class=${`doorstop-finding-row ${kind}`} role="listitem">
      <span class="doorstop-severity">${row.severity}</span>
      ${uid === undefined
        ? nothing
        : navigable
          ? html`<button type="button" class="doorstop-finding-uid" data-uid=${uid} title=${`Show ${uid} in the item list`} @click=${() => { selectFindingTarget(host, uid); }}><code>${uid}</code></button>`
          : html`<code class="doorstop-finding-uid">${uid}</code>`}
      ${row.path === undefined ? nothing : html`<code class="doorstop-finding-path">${row.path}</code>`}
      <span class="doorstop-finding-message">${row.message}</span>
    </div>
  `;
}

export function selectFindingTarget(host: DoorstopPanelSectionsApi, uid: string): void {
  const controller = host.controller;
  if (controller === undefined) return;
  controller.selectDocument("");
  controller.setStateFilter(undefined);
  controller.setSearch("");
  controller.selectUid(uid);
  host.view = "items";
}

export function onStateFilterChange(host: DoorstopPanelSectionsApi, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  host.controller?.setStateFilter(value === "" ? undefined : (value as ItemStateKey));
}

export function onSearchInput(host: DoorstopPanelSectionsApi, event: Event): void {
  host.controller?.setSearch((event.target as HTMLInputElement).value);
}
