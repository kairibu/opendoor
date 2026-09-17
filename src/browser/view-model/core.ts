/**
 * Shared view-model helpers: the element-local view type, the settings
 *  accessors, the publish command builder, the run/last-run predicates, the
 *  per-item git-state vocabulary and the pure item/detail formatters. These are
 *  consumed by the coordinator or by more than one section (and the
 *  project-actions/detail-pane helpers live here too — this split has no
 *  per-section file for those two).
 *
 * Split out of doorstop-panel-view-model.ts (which now re-exports every
 * helper as a barrel, so importers keep the historical path).
 */

import type {
  DoorstopDocumentConfig,
  DoorstopIndex,
  DoorstopItemReference,
  ItemRecord,
} from "../../doorstop-contract.js";
import {
  DOORSTOP_GIT_STATUS_FILES_MAX,
  type DoorstopGitStatusFile,
  type DoorstopGitStatusResponse,
} from "../../doorstop-backend-contract.js";
import type { DoorstopLastRunView } from "../doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "../doorstop-panel.js";
import { DEFAULT_OPENDOOR_SETTINGS } from "../../doorstop-settings.js";

/** `null` (a link Doorstop has not stamped yet) renders as "none". */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint === null ? "none" : `${fingerprint.slice(0, 8)}…`;
}

/** Element-local sub-view (spec §7.2) — the controller has no view concept,
 *  so the toggle is intentionally not mirrored by the host render. */
export type DoorstopPanelView = "items" | "findings";

/** Exported so the exact fallback is testable independent of the toolbar. */
export function doorstopPublishTarget(result: DoorstopWorkspaceResult | undefined): string {
  return result?.settings?.publishTarget ?? DEFAULT_OPENDOOR_SETTINGS.publishTarget;
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
