/**
 * Status-bar view-model helper: the commit/stage/unstage outcome narration.
 *
 * Split out of doorstop-panel-view-model.ts (which now re-exports every
 * helper as a barrel, so importers keep the historical path).
 */

import type {
  DoorstopCommitOutcome,
  DoorstopGitStageResponse,
  DoorstopGitUnstageResponse,
} from "../../doorstop-backend-contract.js";
import type { DoorstopLastRunView } from "../doorstop-panel-controller.js";

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
