import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopItemReference,
  ItemRecord,
  ItemStateKey,
} from "./doorstop-contract.js";
import {
  DOORSTOP_GIT_STATUS_FILES_MAX,
  isValidDoorstopUid,
  type DoorstopCommitOutcome,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
  type DoorstopGitUnstageResponse,
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

/** `op` picks the narrative voice: the outcome types SHARE the
 *  `clean`/`skipped`/`failed` statuses and are indistinguishable on them —
 *  a stage's `clean` means "nothing to stage", an unstage's "nothing to
 *  unstage", a commit's "nothing staged" — so the status alone cannot
 *  narrate correctly. The outcome is informational: for a REVIEW run it
 *  never flips the run's ok/failed badge, and on the git runs the run's own
 *  `status` already reflects a `failed` outcome. */
export function commitOutcomeText(
  op: DoorstopLastRunView["op"],
  outcome: DoorstopCommitOutcome | DoorstopGitStageResponse | DoorstopGitUnstageResponse,
): string {
  const gitRun = op === "git-stage" || op === "git-commit" || op === "git-unstage";
  switch (outcome.status) {
    case "staged":
      return `staged ${String(outcome.staged ?? 0)} paths`;
    case "unstaged":
      return `unstaged ${String(outcome.unstaged ?? 0)} paths`;
    case "committed":
      return gitRun ? `committed ${outcome.sha ?? "<unknown sha>"}` : `commit: ${outcome.sha ?? "<unknown sha>"}`;
    case "clean":
      if (!gitRun) return "commit: clean (already committed)";
      if (op === "git-stage") return "clean — nothing to stage";
      if (op === "git-unstage") return "clean — nothing to unstage";
      return "clean — nothing staged";
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

/** The per-item git-state chip vocabulary, derived at RENDER time from
 *  `gitStatusView.response.files`. Deliberately NOT an `ItemStateKey`:
 *  keeping git state out of `computeItemStates()` means the state filter
 *  dropdown and `STATE_KEY_ORDER` stay untouched. */
export type ItemGitState =
  | "clean"
  | "staged"
  | "changed"
  | "staged-changed"
  | "untracked"
  | "conflicted";

/** One path→file lookup pass per list render (the status response's `files`
 *  array is already capped server-side; a Map keeps every row lookup O(1)). */
export function gitStatusFilesByPath(
  response: DoorstopGitStatusResponse,
): Map<string, DoorstopGitStatusFile> {
  const byPath = new Map<string, DoorstopGitStatusFile>();
  for (const file of response.files) byPath.set(file.path, file);
  return byPath;
}

/** Single-path lookup against the status response's `files` array — for the
 *  action row, which renders ONE item and need not build the whole Map. */
export function gitStatusFileFor(
  response: DoorstopGitStatusResponse,
  path: string,
): DoorstopGitStatusFile | undefined {
  return response.files.find((file) => file.path === path);
}

/** True when the server capped the status response's `files` array. `dirty`
 *  is counted from the FULL porcelain output while `files` holds only the
 *  first {@link DOORSTOP_GIT_STATUS_FILES_MAX} entries, so a `dirty` count
 *  above the list means paths past the cap are unreported. Per-item git UI
 *  must then be suppressed: an unreported path would otherwise render
 *  "clean" (no chip) with a Stage button claiming it has no unstaged
 *  changes, contradicting the strip's honest counts. */
export function gitStatusFilesTruncated(response: DoorstopGitStatusResponse): boolean {
  return (
    response.files.length === DOORSTOP_GIT_STATUS_FILES_MAX &&
    response.dirty > response.files.length
  );
}

/** Map one porcelain XY pair (`index`/X = staged, `workingTree`/Y = unstaged)
 *  onto the row's chip state. `file` is `undefined` when porcelain omitted
 *  the path (unmodified); `ignored` files are treated as clean because they
 *  are never stageable without `-f` (the server's `git add` would fail). An
 *  `untracked` pair (`??`) is its own state; a conflict stays stageable —
 *  `git add` on a resolved path is exactly how a conflict is marked
 *  resolved. */
export function itemGitState(file: DoorstopGitStatusFile | undefined): ItemGitState {
  if (file === undefined) return "clean";
  const { index, workingTree } = file;
  if (workingTree === "ignored") return "clean";
  if (index === "unmodified" && workingTree === "unmodified") return "clean";
  if (index === "untracked" && workingTree === "untracked") return "untracked";
  if (index === "conflicted" || workingTree === "conflicted") return "conflicted";
  if (index !== "unmodified" && workingTree !== "unmodified") return "staged-changed";
  if (index !== "unmodified") return "staged";
  return "changed";
}

/** Chip text per git state; `clean` is empty because the caller skips the
 *  chip entirely (only non-clean rows render one). */
export const GIT_CHIP_LABELS: Record<ItemGitState, string> = {
  clean: "",
  staged: "staged",
  changed: "changed",
  "staged-changed": "staged + changed",
  untracked: "untracked",
  conflicted: "conflict",
};

/** Reuse the existing chip palette (`.doorstop-chip-{ok,warning,danger,muted}`)
 *  — no git-specific colors. */
export function gitChipKind(state: ItemGitState): "ok" | "warning" | "danger" | "muted" {
  switch (state) {
    case "staged":
      return "ok";
    case "changed":
    case "staged-changed":
      return "warning";
    case "conflicted":
      return "danger";
    case "untracked":
    case "clean":
      return "muted";
  }
}

/** True when `git add <path>` would stage a working-tree change: the Y
 *  column is neither `unmodified` (already staged — the server skips these
 *  to avoid the "did not match any files" fatal) nor `ignored`. An absent
 *  entry (omitted from porcelain) is not stageable either. */
export function itemStageable(file: DoorstopGitStatusFile | undefined): boolean {
  if (file === undefined) return false;
  return file.workingTree !== "unmodified" && file.workingTree !== "ignored";
}

/** True when `git reset -- <path>` would restore the path's index entry: the
 *  X column (index/staged) is dirty. This is the exact MIRROR of
 *  {@link itemStageable}, but on the X column instead of Y. `unmodified`
 *  (nothing staged), `untracked` (`??` is never in the index), and `ignored`
 *  are excluded; every unmerged shape is excluded too, in agreement with the
 *  server's `unstageResetTargets`: an X of `conflicted` (the `U*` shapes —
 *  `UU`/`UD`/`UA`), a Y of `conflicted` (the `*U` shapes — `UU`/`DU`/`AU`),
 *  and the both-sides-added/deleted pairs (`AA`/`DD`, where X and Y are both
 *  `added` or both `deleted`). `git reset` on any of those would silently
 *  resolve the conflict (or otherwise act on an unmerged pair) in the index,
 *  which the user must not trigger from a one-click Unstage — the server
 *  excludes them too, as defense-in-depth. An absent entry (omitted from
 *  porcelain) is not unstageable either. */
export function itemUnstageable(file: DoorstopGitStatusFile | undefined): boolean {
  if (file === undefined) return false;
  const { index, workingTree } = file;
  if (index === "unmodified" || index === "untracked" || index === "ignored") return false;
  if (index === "conflicted" || workingTree === "conflicted") return false;
  if ((index === "added" || index === "deleted") && index === workingTree) return false;
  return true;
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
