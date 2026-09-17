/**
 * Item-list view-model helpers: document chips, state chips, list filtering,
 *  the configured-attribute rows and the row excerpt.
 *
 * Split out of doorstop-panel-view-model.ts (which now re-exports every
 * helper as a barrel, so importers keep the historical path).
 */

import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  ItemRecord,
  ItemStateKey,
} from "../../doorstop-contract.js";
import type { DoorstopWorkspaceResult } from "../doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../../doorstop-settings.js";
import { jsonishText } from "./core.js";

export const EMPTY_WORKSPACE_MESSAGE =
  "This workspace has no Doorstop documents — run `doorstop create REQ ./reqs` in the workspace to start a requirements tree.";

export const ALL_DOCUMENTS_LABEL = "All";

export const STATE_CHIP_LABELS: Record<ItemStateKey, string> = {
  normative: "normative",
  "non-normative": "non-normative",
  inactive: "inactive",
  reviewed: "reviewed",
  unreviewed: "unreviewed",
  "suspect-link": "suspect link",
  "no-child-links": "no child links",
  "no-links": "no links",
  "unknown-link": "unknown link",
  "missing-reference": "missing reference",
};

export type StateChipKind = "muted" | "warning" | "danger";

export function stateChipKind(key: ItemStateKey): StateChipKind {
  switch (key) {
    case "normative":
    case "non-normative":
    case "reviewed":
      return "muted";
    case "unreviewed":
    case "no-child-links":
    case "no-links":
      return "warning";
    case "inactive":
    case "suspect-link":
    case "unknown-link":
    case "missing-reference":
      return "danger";
  }
}

export type DocumentStateDot = "ok" | "unreviewed" | "suspect";

export function dotTitle(dot: DocumentStateDot): string {
  switch (dot) {
    case "ok":
      return "all items reviewed, no suspect links";
    case "unreviewed":
      return "has unreviewed changes";
    case "suspect":
      return "has suspect links";
  }
}

export function documentStateDots(
  document: DoorstopDocumentConfig,
  items: readonly ItemRecord[],
): DocumentStateDot[] {
  const own = items.filter((item) => item.documentPrefix === document.prefix);
  const dots: DocumentStateDot[] = [];
  if (own.length === 0) return dots;
  const hasSuspect = own.some((item) => item.stateKeys.includes("suspect-link"));
  const hasUnreviewed = own.some((item) => item.stateKeys.includes("unreviewed"));
  if (!hasSuspect && !hasUnreviewed) dots.push("ok");
  if (hasUnreviewed) dots.push("unreviewed");
  if (hasSuspect) dots.push("suspect");
  return dots;
}

/** `documentPrefix` `""` (the sentinel `selectDocument("")` writes for the
 *  "All" chip) and `undefined` both mean "all documents". */
export function filteredItems(
  index: DoorstopIndex,
  documentPrefix: string | undefined,
  stateFilter: ItemStateKey | undefined,
  search: string,
): ItemRecord[] {
  const needle = search.trim().toLowerCase();
  return index.items.filter((item) => {
    if (documentPrefix !== undefined && documentPrefix !== "" && item.documentPrefix !== documentPrefix) {
      return false;
    }
    if (stateFilter !== undefined && !item.stateKeys.includes(stateFilter)) return false;
    if (needle !== "" && !`${item.uid} ${item.header ?? ""} ${item.text}`.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

/** The configured attribute NAMES the item-list rows render as `key: value`
 *  pairs, in order. Falls back to the frozen default (none) when the result
 *  or its settings are absent. */
export function doorstopShowAdditionalAttribute(
  result: DoorstopWorkspaceResult | undefined,
): readonly string[] {
  return result?.settings?.showAdditionalAttribute ?? DEFAULT_OPENDOOR_SETTINGS.showAdditionalAttribute;
}

export function itemExcerpt(item: ItemRecord): string {
  const header = item.header;
  if (header !== undefined && header !== "") return header;
  const firstLine = (item.text.split("\n")[0] ?? "").trim();
  if (firstLine === "") return "—";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

/** One configured attribute resolved for one row: the configured key and the
 *  jsonish-rendered value (`text: "…"` keeps its quotes). */
export interface ShownAttribute {
  key: string;
  text: string;
}

/** Resolve the configured attribute NAMES against ONE item, in the configured
 *  order. The loop iterates `keys` — the CONFIGURED array — and never
 *  `item.attributes`, so an unknown key is inert and no unconfigured attribute
 *  can ever leak into a row. `text` is the one modeled key (jsonish-quoted
 *  like any other value) and is skipped when the item body is empty; every
 *  other name is present only when the item has that own extended attribute.
 *  `keys` is read-only and never mutated. */
export function shownAttributeRows(item: ItemRecord, keys: readonly string[]): ShownAttribute[] {
  const rows: ShownAttribute[] = [];
  for (const key of keys) {
    if (key === "text") {
      if (item.text === "") continue;
      rows.push({ key, text: jsonishText(item.text) });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(item.attributes, key)) continue;
    rows.push({ key, text: jsonishText(item.attributes[key]) });
  }
  return rows;
}
