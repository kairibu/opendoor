/**
 * Findings-view view-model helpers (spec §7.2): the merged row shape, the
 *  severity sort and the header counts.
 *
 * Split out of doorstop-panel-view-model.ts (which now re-exports every
 * helper as a barrel, so importers keep the historical path).
 */

import type { DoorstopIndex } from "../../doorstop-contract.js";

export const FINDINGS_EMPTY_MESSAGE = "No findings — the tree is clean.";

export const FINDINGS_EMPTY_HINT =
  "Findings are plugin-local; run `doorstop` validation in the terminal for the authoritative check.";

export const FINDINGS_PLUGIN_LOCAL_NOTE =
  "plugin-local findings — `doorstop` validation in the terminal is authoritative";

/** Merged shape over the index's findings and discovery diagnostics, which
 *  already carry exactly these fields structurally. */
export interface FindingsViewRow {
  severity: "error" | "warning" | "info";
  uid?: string;
  path?: string;
  message: string;
}

const FINDING_SEVERITY_RANK: Record<FindingsViewRow["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function findingsViewRows(index: DoorstopIndex): FindingsViewRow[] {
  const rows: FindingsViewRow[] = [...index.findings, ...index.diagnostics];
  return rows.sort((a, b) => FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity]);
}

export interface FindingsViewCounts {
  errors: number;
  warnings: number;
  info: number;
}

export function findingsViewCounts(rows: readonly FindingsViewRow[]): FindingsViewCounts {
  const counts: FindingsViewCounts = { errors: 0, warnings: 0, info: 0 };
  for (const row of rows) {
    if (row.severity === "error") counts.errors += 1;
    else if (row.severity === "warning") counts.warnings += 1;
    else counts.info += 1;
  }
  return counts;
}

export function findingsCountText(counts: FindingsViewCounts): string {
  const errors = counts.errors === 1 ? "1 error" : `${String(counts.errors)} errors`;
  const warnings = counts.warnings === 1 ? "1 warning" : `${String(counts.warnings)} warnings`;
  return `${errors} · ${warnings} · ${String(counts.info)} info`;
}
