import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopItemReference,
  ItemRecord,
  ItemStateKey,
} from "./doorstop-contract.js";
import {
  isValidDoorstopUid,
  type DoorstopCommitOutcome,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusResponse,
} from "./doorstop-backend-contract.js";
import { computeItemStamp } from "./doorstop-state.js";
import type { DoorstopLastRunView } from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "./doorstop-settings.js";

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

/** `null` (a link Doorstop has not stamped yet) renders as "none". */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint === null ? "none" : `${fingerprint.slice(0, 8)}…`;
}

// --- findings view (feature spec §7.2) ---------------------------------------

/** Element-local sub-view (spec §7.2) — the controller has no view concept,
 *  so the toggle is intentionally not mirrored by the host render. */
export type DoorstopPanelView = "items" | "findings";

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

/** Exported so the exact fallback is testable independent of the toolbar. */
export function doorstopPublishTarget(result: DoorstopWorkspaceResult | undefined): string {
  return result?.settings?.publishTarget ?? DEFAULT_OPENDOOR_SETTINGS.publishTarget;
}

/** The commit flag travels only on the BACKEND path; the terminal fallback
 *  does not commit. */
export function doorstopCommitAfterReview(result: DoorstopWorkspaceResult | undefined): boolean {
  return result?.settings?.commitAfterReview ?? DEFAULT_OPENDOOR_SETTINGS.commitAfterReview;
}

/** `op` picks the narrative voice: the two outcome types SHARE the
 *  `clean`/`skipped`/`failed` statuses and are indistinguishable on them —
 *  a stage's `clean` means "nothing to stage", a commit's "nothing staged"
 *  — so the status alone cannot narrate correctly. The outcome is
 *  informational: for a REVIEW run it never flips the run's ok/failed
 *  badge, and on the git runs the run's own `status` already reflects a
 *  `failed` outcome. */
export function commitOutcomeText(op: DoorstopLastRunView["op"], outcome: DoorstopCommitOutcome | DoorstopGitStageResponse): string {
  const gitRun = op === "git-stage" || op === "git-commit";
  switch (outcome.status) {
    case "staged":
      return `staged ${String(outcome.staged ?? 0)} paths`;
    case "committed":
      return gitRun ? `committed ${outcome.sha ?? "<unknown sha>"}` : `commit: ${outcome.sha ?? "<unknown sha>"}`;
    case "clean":
      if (!gitRun) return "commit: clean (already committed)";
      return op === "git-stage" ? "clean — nothing to stage" : "clean — nothing staged";
    case "skipped":
      return gitRun ? "skipped" : "commit: skipped (not a git repository | review failed | deadline)";
    case "failed":
      return gitRun ? `failed — ${outcome.stderr ?? "git step errored"}` : `commit: failed — ${outcome.stderr ?? "git step errored"}`;
  }
}

export function lastRunHasMessage(lastRun: DoorstopLastRunView): boolean {
  return (
    lastRun.stdout !== "" ||
    lastRun.stderr !== "" ||
    (lastRun.errorMessage ?? "") !== "" ||
    lastRun.commit !== undefined
  );
}

/**
 * Zero counts are dropped because git OMITS the zero side of the
 * `[ahead N]` bracket — `ahead`/`behind` are absent at 0, mirrored here.
 * Exported for the Phase F element tests (the `commitOutcomeText` idiom).
 */
export function gitStatusText(response: DoorstopGitStatusResponse): string {
  const parts: string[] = [response.branch === undefined ? "⎇" : `⎇ ${response.branch}`];
  if (response.staged > 0) parts.push(`${String(response.staged)} staged`);
  if (response.dirty > 0) parts.push(`${String(response.dirty)} dirty`);
  if ((response.ahead ?? 0) > 0) parts.push(`↑${String(response.ahead)}`);
  if ((response.behind ?? 0) > 0) parts.push(`↓${String(response.behind)}`);
  return parts.join(" · ");
}

/** Shell-inert alphabet for a publish target (the UID guard's `\w` alphabet
 *  plus `/` for the default `./public`); anything else is shell-quoted by
 *  {@link doorstopPublishCommand}. */
const PUBLISH_TARGET_SAFE_TOKEN = /^[\w./-]+$/;

/** POSIX single-quote argument; the same idiom the host's terminal service
 *  uses when it echoes each runCommand through `$SHELL -lc`. */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The settings validator only guarantees the target is a workspace-relative
 *  PATH (no `..` segment, not absolute); it does NOT guarantee it is
 *  shell-inert, and the host runs the command through a login shell, so an
 *  unquoted metacharacter target from a committed `.pi-web/opendoor.json`
 *  would execute in the workspace terminal. Targets outside the inert
 *  {@link PUBLISH_TARGET_SAFE_TOKEN} alphabet are therefore single-quoted
 *  here, at the command boundary.
 *
 *  `target` may be passed explicitly so a caller that already computed it
 *  (the publish confirm path) keeps the confirm message and the command
 *  provably consistent. */
export function doorstopPublishCommand(
  result: DoorstopWorkspaceResult | undefined,
  target: string = doorstopPublishTarget(result),
): string {
  const argument = PUBLISH_TARGET_SAFE_TOKEN.test(target) ? target : quoteShellArgument(target);
  return `doorstop publish all ${argument}`;
}

/** Aliased by identity so the browser and the server bundle validate
 *  identically — an accepted target is always a shell-safe bare token.
 *  Exported for the contract parity test. */
export const isValidTargetUid = isValidDoorstopUid;

/** An inert fallback when the index is missing an item's document config —
 *  the same fallback the state chain uses, so a missing config must not
 *  silently break stamps. */
export function documentConfigFor(index: DoorstopIndex, item: ItemRecord): DoorstopDocumentConfig {
  return index.byPrefix.get(item.documentPrefix) ?? {
    directoryPath: "",
    configPath: "",
    prefix: item.documentPrefix,
    digits: 0,
    separator: "",
    itemformat: "yaml",
    extra: {},
  };
}

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

export function jsonishText(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export function diffValueText(value: unknown): string {
  return value === undefined ? "—" : jsonishText(value);
}

export function referenceListText(references: readonly DoorstopItemReference[]): string {
  return references
    .map((reference) => {
      const parts = [reference.path];
      if (reference.keyword !== undefined) parts.push(`#${reference.keyword}`);
      if (reference.sha !== undefined) parts.push(`@${reference.sha.slice(0, 8)}`);
      return parts.join(" ");
    })
    .join(", ");
}

export function itemExcerpt(item: ItemRecord): string {
  const header = item.header;
  if (header !== undefined && header !== "") return header;
  const firstLine = (item.text.split("\n")[0] ?? "").trim();
  if (firstLine === "") return "—";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}
