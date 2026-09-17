/**
 * Item-action-palette view-model helpers: the review commit flag, the Link
 *  target guard, suspect-parent resolution and the child-document lookup.
 *
 * Split out of doorstop-panel-view-model.ts (which now re-exports every
 * helper as a barrel, so importers keep the historical path).
 */

import type { DoorstopIndex, ItemRecord } from "../../doorstop-contract.js";
import { isValidDoorstopUid } from "../../doorstop-backend-contract.js";
import { computeItemStamp } from "../../doorstop-state.js";
import type { DoorstopWorkspaceResult } from "../doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../../doorstop-settings.js";
import { documentConfigFor } from "./core.js";

/** The commit flag travels only on the BACKEND path; the terminal fallback
 *  does not commit. */
export function doorstopCommitAfterReview(result: DoorstopWorkspaceResult | undefined): boolean {
  return result?.settings?.commitAfterReview ?? DEFAULT_OPENDOOR_SETTINGS.commitAfterReview;
}

/** Aliased by identity so the browser and the server bundle validate
 *  identically — an accepted target is always a shell-safe bare token.
 *  Exported for the contract parity test. */
export const isValidTargetUid = isValidDoorstopUid;

/** Must stay the exact comparison the state chain uses for the
 *  "suspect-link" chip: recorded `LinkRecord.fingerprint` vs
 *  `computeItemStamp(parent, config, false)`; `null` recordings are never
 *  suspect. */
export function suspectParentItems(item: ItemRecord, index: DoorstopIndex): ItemRecord[] {
  const suspects: ItemRecord[] = [];
  for (const link of item.links) {
    if (link.fingerprint === null) continue;
    const target = index.byUid.get(link.uid);
    if (target === undefined) continue;
    if (link.fingerprint !== computeItemStamp(target, documentConfigFor(index, target), false)) {
      suspects.push(target);
    }
  }
  return suspects;
}

export function firstChildDocumentPrefix(index: DoorstopIndex, item: ItemRecord): string | undefined {
  for (const document of index.documents) {
    if (document.parentPrefix === item.documentPrefix) return document.prefix;
  }
  return undefined;
}
