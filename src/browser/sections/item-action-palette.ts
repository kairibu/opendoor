/**
 * Section module for the Doorstop panel body element: Item action palette: review/clear/stage/link actions and the Ask-agent menu.
 *
 * Free render functions and handlers.  All state lives in the coordinator
 * (`../doorstop-panel-element.ts`), whose surface this module sees through the
 * narrow `DoorstopPanelSectionsApi` interface (type-only import, so the runtime
 * dependency stays one-way: coordinator -> sections).
 */

import { html, nothing, type TemplateResult } from "lit";
import { ref, type Ref } from "lit/directives/ref.js";
import { gitStageIconSvg, gitUnstageIconSvg } from "../doorstop-panel-icons.js";
import { draftChildRequirementPrompt, explainItemPrompt, fixSuspectLinksPrompt, reviewReadinessPrompt } from "../doorstop-prompts.js";
import type { DoorstopPanelSectionsApi } from "../doorstop-panel-section-host.js";
import { type DoorstopIndex, type ItemRecord } from "../../doorstop-contract.js";
import { doorstopCommitAfterReview, firstChildDocumentPrefix, gitStatusFileFor, itemStageable, itemUnstageable, isValidTargetUid, suspectParentItems } from "../doorstop-panel-view-model.js";

export function renderItemActionPalette(host: DoorstopPanelSectionsApi): TemplateResult | typeof nothing {
  if (host.view !== "items") return nothing;
  const result = host.result;
  if (result === undefined || result.index.documents.length === 0) return nothing;
  const item = host.selectedItem();
  if (item === undefined) {
    return html`
      <section class="doorstop-action-palette" aria-label="Item actions">
        <span class="doorstop-muted doorstop-palette-placeholder">Select an item…</span>
      </section>
    `;
  }
  const suspects = suspectParentItems(item, result.index);
  return html`
    <section class="doorstop-action-palette" aria-label="Item actions">
      ${renderActionRow(host, item, result.index, suspects)}
    </section>
  `;
}

export function renderActionRow(
  host: DoorstopPanelSectionsApi,
  item: ItemRecord,
  index: DoorstopIndex,
  suspects: readonly ItemRecord[],
): TemplateResult {
  const reviewed = item.stateKeys.includes("reviewed");
  const suspectUids = suspects.length > 0 ? suspects.map((parent) => parent.uid) : [];
  // ONE ready-check for both the buttons and their stageable/
  // unstageable predicates; `readyGitStatus` already owns the
  // paired/ready/untruncated gate, so the chip row and the palette
  // buttons can never disagree.
  const gitStatus = host.readyGitStatus();
  const gitFile = gitStatus === undefined ? undefined : gitStatusFileFor(gitStatus, item.path);
  const stageable = itemStageable(gitFile);
  const unstageable = itemUnstageable(gitFile);
  return html`
    <button
      type="button"
      class="doorstop-review"
      ?disabled=${reviewed || host.runInProgress !== undefined}
      title=${reviewed
        ? `${item.uid} is already reviewed against its current fingerprint`
        : `Mark ${item.uid} reviewed`}
      @click=${() => { reviewItem(host, item); }}
    >Approve</button>
    <button
      type="button"
      class="doorstop-clear"
      ?disabled=${suspects.length === 0 || host.runInProgress !== undefined}
      title=${suspects.length === 0
        ? `No suspect links to clear`
        : `Re-record the parent fingerprints of ${item.uid}`}
      @click=${() => { clearSuspects(host, item, suspectUids); }}
    >Clear suspect links</button>
    ${gitStatus === undefined
      ? nothing
      : html`<button
          type="button"
          class="doorstop-item-stage"
          ?disabled=${host.runInProgress !== undefined || !stageable}
          title=${stageable
            ? `Stage ${item.path}`
            : `${item.uid} has no unstaged changes — commit next`}
          @click=${() => { host.stageItem(item); }}
        >${gitStageIconSvg}Stage</button>
        <button
          type="button"
          class="doorstop-item-unstage"
          ?disabled=${host.runInProgress !== undefined || !unstageable}
          title=${unstageable
            ? `Unstage ${item.path} (git reset)`
            : `${item.uid} has nothing staged`}
          @click=${() => { host.unstageItem(item); }}
        >${gitUnstageIconSvg}Unstage</button>`}
    <div class="doorstop-op">
      <input
        type="text"
        class="doorstop-target-input"
        data-op="link"
        placeholder="parent UID"
        ${ref(host.linkInputRef)}
        @keydown=${(event: Event) => onTargetKeydown(host, event as KeyboardEvent)}
      />
      <button type="button" class="doorstop-link" title=${`doorstop link ${item.uid} <target>`} ?disabled=${host.runInProgress !== undefined} @click=${() => { runTargetOp(host, "link", host.linkInputRef, item); }}>Link</button>
    </div>
    ${host.targetError === undefined ? nothing : html`<span class="doorstop-op-error" role="alert">${host.targetError}</span>`}
    ${renderAskMenu(host, item, index, suspects)}
  `;
}

export function renderAskMenu(
  host: DoorstopPanelSectionsApi,
  item: ItemRecord,
  index: DoorstopIndex,
  suspects: readonly ItemRecord[],
): TemplateResult {
  const children = index.childrenByUid.get(item.uid) ?? [];
  const childPrefix = firstChildDocumentPrefix(index, item);
  return html`
    <div class="doorstop-menu">
      <button
        type="button"
        class="doorstop-menu-toggle"
        aria-expanded=${host.askMenuOpen ? "true" : "false"}
        @click=${() => onAskMenuToggle(host)}
      >Ask agent</button>
      ${host.askMenuOpen
        ? html`
            <div class="doorstop-menu-items" role="menu" aria-label="Ask the agent about ${item.uid}">
              <button type="button" role="menuitem" class="doorstop-menu-item doorstop-explain" @click=${() => { host.insertPrompt(explainItemPrompt(item)); }}>Explain</button>
              <button
                type="button"
                role="menuitem"
                class="doorstop-menu-item doorstop-fix-suspects"
                ?disabled=${suspects.length === 0}
                title=${suspects.length === 0 ? "No suspect links — nothing to fix" : `Fix the suspect links of ${item.uid}`}
                @click=${() => { host.insertPrompt(fixSuspectLinksPrompt(item, suspects)); }}
              >Fix suspect links</button>
              <button
                type="button"
                role="menuitem"
                class="doorstop-menu-item doorstop-draft-child"
                ?disabled=${childPrefix === undefined}
                title=${childPrefix === undefined ? "No child document to add to" : `Draft a child item in the ${childPrefix} document`}
                @click=${() => {
                  if (childPrefix !== undefined) host.insertPrompt(draftChildRequirementPrompt(item, childPrefix));
                }}
              >Draft child requirement</button>
              <button type="button" role="menuitem" class="doorstop-menu-item doorstop-review-readiness" @click=${() => { host.insertPrompt(reviewReadinessPrompt(item, children)); }}>Review readiness</button>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function reviewItem(host: DoorstopPanelSectionsApi, item: ItemRecord): void {
  // The commit flag is OMITTED under the default (optional-field
  // idiom) so old servers and in-flight requests across a mixed-version
  // reload window parse the request fine.
  const commit = doorstopCommitAfterReview(host.result);
  host.runDoorstop(
    "review",
    `Doorstop: review ${item.uid}`,
    commit ? { op: "review", uid: item.uid, commit: true } : { op: "review", uid: item.uid },
    `doorstop review ${item.uid}`,
    false,
  );
}

export function clearSuspects(host: DoorstopPanelSectionsApi, item: ItemRecord, suspectUids: readonly string[]): void {
  if (suspectUids.length === 0) return;
  host.runDoorstop(
    "clear",
    "Doorstop: clear suspect links",
    { op: "clear", uid: item.uid, parents: suspectUids },
    `doorstop clear ${item.uid} ${suspectUids.join(" ")}`,
    false,
  );
}

export function runTargetOp(host: DoorstopPanelSectionsApi, op: "link", inputRef: Ref<HTMLInputElement>, item: ItemRecord): void {
  const input = inputRef.value;
  const target = input?.value.trim() ?? "";
  // An unvalidated free-text target could smuggle shell syntax into
  // `doorstop link ${item.uid} ${target}`.
  if (target === "") {
    host.targetError = `Enter a link target UID (e.g. ${item.documentPrefix}0001)`;
    input?.focus();
    return;
  }
  if (!isValidTargetUid(target)) {
    host.targetError = `Invalid link target "${target}" — expected a Doorstop UID like ${item.documentPrefix}0001 (no spaces, quotes, or special characters)`;
    input?.focus();
    return;
  }
  host.targetError = undefined;
  if (input !== undefined) input.value = "";
  host.runDoorstop(
    op,
    `Doorstop: ${op} ${item.uid}`,
    { op, uid: item.uid, target },
    `doorstop ${op} ${item.uid} ${target}`,
    false,
  );
}

export function onTargetKeydown(host: DoorstopPanelSectionsApi, event: KeyboardEvent): void {
  const input = event.target as HTMLInputElement;
  // The palette has exactly one free-text target input (Link); the Unlink
  // button was removed and detail-pane's unlink sources its UID from the
  // index instead of an input.
  if (input.getAttribute("data-op") !== "link") return;
  if (event.key === "Enter") {
    event.preventDefault();
    const item = host.selectedItem();
    if (item !== undefined) runTargetOp(host, "link", host.linkInputRef, item);
  } else if (event.key === "Escape") {
    input.value = "";
  }
}

export function onAskMenuToggle(host: DoorstopPanelSectionsApi): void {
  host.askMenuOpen = !host.askMenuOpen;
}
