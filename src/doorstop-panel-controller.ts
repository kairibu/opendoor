// ---------------------------------------------------------------------------
// Opendoor per-workspace reactive controller (plan §3.2 — mirrors
// OpenseWorkspaceController exactly): one `DoorstopWorkspaceController`
// instance holds the complete UI state of one workspace's Requirements panel
// — load result, loading/stale/error flags, document/state-filter selection,
// the search string, the last doorstop run's view record
// (`lastRun`/`runInProgress`, plan Phase D step 8), and the project-scoped
// git state (the git-status strip view + stage/commit run dispatch,
// plan-add-git-actions.md Phase C) — and pushes every connected state
// mutation to the panel host via the CURRENT workspace context handle
// (`this.context.host.requestRender()`), gated on the controller's own
// connection flag.
//
// This is the formal `ReactiveController` the opendoor panel drives manually
// (deviation 3, copied from opense): the per-workspace map and LRU eviction
// stay in the panel module, which hands controller instances to elements via
// properties (no Context provider).
//
// Late-async-write guarding (§3.2): after every `await`, writes are dropped
// when `host.isConnected` is false. The connection flag is raised by
// `hostConnected()`, lowered by `hostDisconnected()` and by `release()` on
// LRU eviction.
//
// lit is imported type-only: the module carries no runtime framework code, so
// the load job it runs stays pure and the controller is unit-testable with a
// fake host, no DOM required (plan §5). The baseline cache (Phase D step 13)
// does import the pure model/state/diff chains (parse + stamp + semantic
// diff) — no framework code either, so the DOM-free testability holds.
// ---------------------------------------------------------------------------

import type { ReactiveController } from "lit";
import type { JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { DoorstopDocumentConfig, DoorstopFiles, ItemRecord, ItemStateKey } from "./doorstop-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";
import {
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  parseDoorstopBaselineResponse,
  parseDoorstopGitCommitResponse,
  parseDoorstopGitStageResponse,
  parseDoorstopGitStatusResponse,
  parseDoorstopGitUnstageResponse,
  type DoorstopBaselineCandidate,
  type DoorstopBaselineResponse,
  type DoorstopCommitOutcome,
  type DoorstopGitStageResponse,
  type DoorstopGitStatusResponse,
  type DoorstopGitUnstageResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import { parseDoorstopItem } from "./doorstop-model.js";
import { computeItemStamp } from "./doorstop-state.js";
import { diffItemFields, type ItemFieldDiff } from "./doorstop-diff.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";

/**
 * The op discriminators of the project-scoped git runs (plan Phase C step 12,
 * extended by plan-add-git-actions Phase 4 with the unstage inverse) — the git
 * operations are their OWN backend operations (`doorstop.git-stage` /
 * `doorstop.git-unstage` / `doorstop.git-commit`), NOT `doorstop.run` ops, so
 * the {@link DoorstopLastRunView.op} union widens without touching
 * `DoorstopRunRequest`.
 */
export type DoorstopGitRunOp = "git-stage" | "git-commit" | "git-unstage";

/** The git outcome a git run narrates in its Last-run `commit` field: the
 *  stage response on `git-stage` runs (status `staged`/`clean`/`skipped`/
 *  `failed` + the optional `staged` count), the unstage response on
 *  `git-unstage` runs (`unstaged`/`clean`/`skipped`/`failed` + the optional
 *  `unstaged` count), and the review→commit outcome on `git-commit` runs
 *  (`committed`/`clean`/`skipped`/`failed` + `sha`/`stderr`) — the status
 *  bar's existing outcome rendering switches on the `status` value, so one
 *  union serves all three. */
export type DoorstopGitRunOutcome =
  | DoorstopCommitOutcome
  | DoorstopGitStageResponse
  | DoorstopGitUnstageResponse;

/**
 * The panel's view of the workspace's git status readout (plan Phase C step
 * 10): the async status fetch's state plus, on `"ready"`, the parsed
 * {@link DoorstopGitStatusResponse} the project-actions strip renders. The
 * view is per-workspace (a single snapshot, refreshed on demand and after
 * every `invalidate()`), not per-item like {@link DoorstopBaselineView}.
 */
export type DoorstopGitStatusView =
  | /** The fetch is in flight (the section renders nothing yet — the
     *  label-cache's no-flash idiom). */
  { state: "loading" }
  | /** The workspace is a git repository; `response` holds the parsed
     *  status readout (branch, ahead/behind, staged/dirty counts). */
  { state: "ready"; response: DoorstopGitStatusResponse }
  | /** The workspace is not a git repository (or unpaired — no backend to
     *  ask); the strip renders "no git". */
  { state: "no-git" }
  | /** The request rejected (a bridge/parse hiccup — TRANSIENT: the next
     *  fetch retries; the stale error stays visible for rendering). */
  { state: "error"; errorMessage: string };

/**
 * The panel's view record of one doorstop run (plan Phase D step 8): the
 * controller keeps the MOST RECENT run and renders it in the "Last run"
 * section. Backend-path runs commit this record with the parse
 * `DoorstopRunResponse` mapped onto it (`status`: exit 0 → `"ok"`, exit ≠ 0
 * → `"failed"`, `signal !== null` → `"killed"`); a rejected backend request
 * commits `status: "error"` with the parsed server error text instead.
 * `lastRun` is run OUTPUT — independent of the discovery rescan — so it
 * SURVIVES `invalidate()`/`load()` and is cleared only by `dismissRun()` or
 * the next commit of a new run.
 *
 * The project-scoped git runs (`doorstop.git-stage` / `doorstop.git-unstage` /
 * `doorstop.git-commit`, plan-add-git-actions.md Phase C, extended by its
 * Phase 4) commit this same record: the git outcome (the stage/unstage/commit
 * response) rides in the {@link DoorstopLastRunView.commit} field, so the
 * panel's status bar renders it with the SAME outcome narration it already
 * renders review-commit outcomes with — `status` is
 * `"ok"` when the requested git operation resolved (its outcome —
 * staged/unstaged/committed/clean/skipped — is the `commit` narration),
 * `"failed"`
 * when the git step itself failed, and `"error"` when the bridge request
 * rejected (nothing ran).
 */
export interface DoorstopLastRunView {
  /** The run's op (also the terminal-metadata `opendoor.op` value, doorstop
   *  ops only; the git ops are backend-only and never reach the terminal). */
  op: DoorstopRunRequest["op"] | DoorstopGitRunOp;
  /** Human title of the run (button label / terminal title). */
  title: string;
  status: "ok" | "failed" | "killed" | "error";
  /** Process exit code; `null` when the process never exited (killed — and
   *  always `null` on git stage/commit runs, whose outcome is a response
   *  status, never an exit code). */
  exitCode: number | null;
  /** Killing signal (e.g. "SIGTERM"); `null` for a normal exit. */
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Wall time of the run, in milliseconds. */
  durationMs: number;
  /** Epoch ms the run started (event order / display timestamp). */
  at: number;
  /** `status === "error"` only: the parsed backend rejection message. */
  errorMessage?: string;
  /** Git outcome narration (plan Phase C step 11 / plan-add-git-actions.md
   *  Phase C step 12): on a review run, the post-review commit outcome —
   *  present only when the request carried `commit: true` and the backend
   *  ran the review→commit pipeline (narration, never infrastructure: a
   *  failed / skipped commit leaves the run's `status` — the review itself —
   *  unchanged). On git-stage/git-unstage/git-commit RUNS, the operation's
   *  own parsed response rides here (`staged`/`unstaged`/`clean`/`skipped`/
   *  `failed` + the `staged`/`unstaged` count or `committed` `sha`/`stderr`
   *  excerpt) — the status bar renders it with the same outcome narration. */
  commit?: DoorstopGitRunOutcome;
}

/**
 * The panel's view of one item's "changes since review" baseline (plan
 * Phase D step 13): the async baseline fetch's state plus, on a match, the
 * semantic field diff between the recovered reviewed version and the current
 * item. `baselineViewFor` hands this to the detail pane; a cached view whose
 * KEY no longer matches the item's current state is never returned (the
 * section refetches on the next expand).
 */
export interface DoorstopBaselineView {
  /** "loading" → the fetch is in flight; "no-git" → not a git repository
   *  (or no backend at all); "no-match" → history was rewritten / the
   *  reviewed blob is not among the candidates; "ready" → `diff` is set;
   *  "error" → the request rejected (the bridge/parse failure fallback —
   *  TRANSIENT: the next expand refetches instead of caching the failure). */
  state: "loading" | "no-git" | "no-match" | "ready" | "error";
  /** "ready" only: the diff between the matched baseline and the item. */
  diff?: ItemFieldDiff;
  /** "ready" only: which history source matched (review commit vs walk). */
  source?: DoorstopBaselineResponse["source"];
  /** "error" only: the rejection message. */
  errorMessage?: string;
}

/** One cached baseline view plus the cache key it was fetched under. */
interface DoorstopBaselineCacheEntry {
  key: string;
  view: DoorstopBaselineView;
}

/** One load job: discovery walk → item reads/parse → index → state
 *  computation. Injected into the controller (rather than imported from the
 *  panel module) so this module has no runtime dependency on it and tests can
 *  substitute fakes for rejection/deferred-control cases. */
export type DoorstopWorkspaceJob = (files: DoorstopFiles) => Promise<DoorstopWorkspaceResult>;

/** The connection flag the controller's late-async-write guards read. This
 *  is NOT structurally satisfied by a LitElement: the controller's own
 *  lifecycle methods (`hostConnected`/`hostDisconnected`/`release`) assign
 *  to `isConnected`, so the host must be a mutable flag holder — the panel
 *  module's private `DoorstopPanelHost`. (A real LitElement's `isConnected`
 *  is a read-only getter; the assignment would throw in strict mode.)
 *
 *  `isConnected` is read after every `await` point: false drops the write
 *  (disconnected panel or LRU-evicted workspace, §3.2). Render routing does
 *  not go through the host — the controller's `requestUpdate()` calls
 *  `this.context.host.requestRender()` on the CURRENT context handle, so
 *  re-renders always reach the workspace's fresh `files`/`host` snapshot. */
export interface DoorstopWorkspaceHost {
  /** False once the workspace panel disconnects or the LRU evicts the
   *  workspace; late async writes (load results landing afterwards) are
   *  dropped until the flag is raised again. */
  isConnected: boolean;
}

/**
 * One workspace's Requirements panel state: the fields the render functions
 * read plus the mutations they call. Created and owned by the panel module's
 * per-workspace registry, which evicts instances over the LRU limit and
 * calls `release()`.
 *
 * `implements ReactiveController` is structural only: the panel drives the
 * lifecycle manually (deviation 3) — the activity element calls
 * `hostConnected()`/`hostDisconnected()` and the registry calls `release()`;
 * `addController()` is never invoked and the host is our flag holder, not a
 * lit-managed LitElement. Later-chain elements must keep driving the
 * controller this way rather than assuming real Lit controller semantics.
 */
export class DoorstopWorkspaceController implements ReactiveController {
  /** Connection flag for this workspace's panel (§3.2); the controller
   *  raises/lowers it from its lifecycle methods. */
  readonly host: DoorstopWorkspaceHost;

  /** Workspace panel context. Refreshed by the registry on reuse — the host
   *  may hand out fresh `files` adapters between renders, and a re-load must
   *  see the current one. */
  context: WorkspacePanelContext;

  /** Load result (index + diagnostics + timing); undefined until the first
   *  load. */
  result: DoorstopWorkspaceResult | undefined;

  loading = false;

  error: string | undefined;

  /** Set on onInvalidate; cleared when a fresh load lands. */
  stale = false;

  /** Item UID selected for the item-detail pane. */
  selectedUid: string | undefined;

  /** Document prefix selected for the document-detail pane (navigation). */
  selectedDocumentPrefix: string | undefined;

  /** Active state-filter chip; undefined = all items. */
  stateFilter: ItemStateKey | undefined;

  /** Search filter string; "" = no search filter. */
  search = "";

  /** The most recent doorstop run's view record (plan Phase D step 8),
   *  rendered in the "Last run" section. Deliberately INDEPENDENT of the
   *  rescan: `invalidate()`/`load()` never touch it, and it is cleared only
   *  by `dismissRun()` or a new run's commit — panel reloads keep showing
   *  the last run's output. On LRU eviction it dies with the controller
   *  (accepted — the registry bounds retained states). */
  lastRun: DoorstopLastRunView | undefined;

  /** The title of the doorstop run currently in flight; `undefined` when no
   *  run is pending. The element disables its action buttons while this is
   *  set (a second run must never overlap the one in flight). */
  runInProgress: string | undefined;

  /** The project-actions git status strip's cached view (plan Phase C step
   *  10): `undefined` until the first fetch lands (or after `invalidate()`
   *  clears it — the single cache-clearing point, so a rescan or any run
   *  that may change dirtiness makes the strip refetch on the next
   *  request). Mirror of the fetch state, not of the load: it survives
   *  `load()` and is dropped only by `invalidate()` / LRU eviction — plus
   *  the reconnect-orphan clear in {@link DoorstopWorkspaceController.hostConnected}
   *  (a `loading` placeholder whose fetch finished while disconnected). */
  gitStatusView: DoorstopGitStatusView | undefined;

  /** True while the git status fetch is in flight (mirrored into the body
   *  element properties alongside `gitStatusView`, plan Phase D step 16). */
  gitStatusInFlight = false;

  /** Per-item "changes since review" baseline views (plan Phase D step 13),
   *  keyed by item UID. Each entry remembers the cache KEY it was fetched
   *  under (`reviewed + NUL + currentStamp`), so a re-review or a further
   *  edit invalidates the entry naturally — `baselineViewFor` only returns a
   *  view whose key still matches the item's current state. */
  private readonly baselineViews = new Map<string, DoorstopBaselineCacheEntry>();

  /** In-flight baseline fetches per UID: a second expand while a fetch runs
   *  joins the running promise instead of stacking a duplicate request. */
  private readonly baselineRequests = new Map<string, Promise<void>>();

  /** Bumped on every baseline-cache mutation (fetch start/landing); mirrored
   *  into the body element properties (same pattern as lastRun/runInProgress,
   *  plan step 15) so the host render wiring has a concrete changing value to
   *  bind and re-render the section. */
  baselineVersion = 0;

  /** UID of the item whose baseline fetch is in flight; `undefined` with none
   *  pending (mirrored into the body element). */
  baselineInFlight: string | undefined;

  private readonly loadJob: DoorstopWorkspaceJob;

  /** In-flight load job; re-entrant calls reuse it (no overlapping jobs). */
  private loadRequest: Promise<void> | undefined;

  /** In-flight git status fetch; re-entrant calls join it (the
   *  `requestBaseline` idiom — repeated `requestGitStatus()` calls share one
   *  round-trip instead of stacking duplicates). */
  private gitStatusRequest: Promise<void> | undefined;

  constructor(host: DoorstopWorkspaceHost, context: WorkspacePanelContext, loadJob: DoorstopWorkspaceJob) {
    this.host = host;
    this.context = context;
    this.loadJob = loadJob;
  }

  /** The workspace panel connected (the activity element calls this from its
   *  connect path). Marks the host connected and kicks the first load; later
   *  loads reuse the in-flight job through the loadRequest guard, so
   *  overlapping jobs never run.
   *
   *  Also the git-status strip's RECONNECT SELF-HEAL (plan Phase C step 10):
   *  a fetch that finished while disconnected left its `loading` view
   *  orphaned — the late-write guard dropped the landing, and the fetch's
   *  `finally` already cleared the in-flight marker. Clearing the orphan here
   *  (guard: a `loading` view with NO fetch in flight is always an orphan —
   *  `requestGitStatus` installs its loading view synchronously) means the
   *  element's next `ensureGitStatus` refetches; a reconnect must never
   *  strand the strip on the `⎇ …` placeholder until a manual click. This is
   *  a placeholder recovery, not a data invalidation — `invalidate()` stays
   *  the single cache-clearing point. */
  hostConnected(): void {
    this.host.isConnected = true;
    if (this.gitStatusView?.state === "loading" && !this.gitStatusInFlight) {
      this.gitStatusView = undefined;
      this.requestUpdate();
    }
    if (this.result === undefined && this.loadRequest === undefined) void this.load();
  }

  /** The workspace panel disconnected: `isConnected` drops late async writes
   *  until the workspace reconnects (§3.2). */
  hostDisconnected(): void {
    this.host.isConnected = false;
  }

  /** LRU eviction release (§3.2): the workspace left the registry, so late
   *  async writes drop even if the element stayed connected. Terminal —
   *  re-rendering the workspace creates a fresh controller. */
  release(): void {
    this.host.isConnected = false;
  }

  /** Panel invalidation: re-run discovery + load unconditionally for the
   *  connected workspace (paired or unpaired: the load job is browser-side, so there is no owned-workspace gate).
   *
   *  Also the git status strip's single cache-clearing point (plan Phase C
   *  step 10): a rescan or any run may change the workspace's dirtiness, so
   *  the cached view is dropped here — for FREE for stage and commit, whose
   *  success paths invalidate through this exact method — and the strip
   *  refetches on the element's next request. */
  invalidate(): Promise<void> {
    this.stale = this.result !== undefined;
    this.gitStatusView = undefined;
    this.requestUpdate();
    return this.load();
  }

  load(): Promise<void> {
    // The infinite-retry guard: re-entrant loads (Refresh button spam,
    // invalidate during a run, workspace switch-back) join the running job
    // instead of stacking new ones.
    if (this.loadRequest !== undefined) return this.loadRequest;
    this.loading = true;
    this.error = undefined;
    this.requestUpdate();

    const request = this.loadJob(this.context.files)
      .then((result) => {
        if (!this.host.isConnected) return;
        this.result = result;
        this.stale = false;
        this.error = undefined;
        // A re-load may drop the selected item/document (file removed/edited);
        // clear the dangling selections the same way git clears vanished files.
        this.selectedUid = selectionIn(result, this.stateFilter, this.selectedUid);
        this.selectedDocumentPrefix = documentSelectionIn(result, this.selectedDocumentPrefix);
      })
      .catch((error: unknown) => {
        if (this.host.isConnected) this.error = formatUnknownError(error);
      })
      .finally(() => {
        if (this.loadRequest !== request) return;
        this.loadRequest = undefined;
        this.loading = false;
        this.requestUpdate();
      });
    this.loadRequest = request;
    return request;
  }

  /** Select an item UID for the detail pane. */
  selectUid(uid: string): void {
    this.selectedUid = uid;
    this.requestUpdate();
  }

  /** Select a document by prefix for the document-detail pane. */
  selectDocument(prefix: string): void {
    this.selectedDocumentPrefix = prefix;
    this.requestUpdate();
  }

  setStateFilter(filter: ItemStateKey | undefined): void {
    this.stateFilter = filter;
    // A filtered-out selection would leave a dangling detail pane; drop it.
    if (this.result !== undefined) this.selectedUid = selectionIn(this.result, filter, this.selectedUid);
    this.requestUpdate();
  }

  setSearch(search: string): void {
    this.search = search;
    this.requestUpdate();
  }

  /** Begin a doorstop run: record the op title (element disables action
   *  buttons) and notify. */
  beginRun(title: string): void {
    this.runInProgress = title;
    this.requestUpdate();
  }

  /** Finish a doorstop run (success or rejection): clear the in-flight
   *  marker so the action buttons re-enable. */
  endRun(): void {
    this.runInProgress = undefined;
    this.requestUpdate();
  }

  /** Commit a completed run's view record and notify. Replaces any previous
   *  `lastRun` (a new run clears the old view); nothing else clears it. */
  commitRun(view: DoorstopLastRunView): void {
    this.lastRun = view;
    this.requestUpdate();
  }

  /** Dismiss the last run's view record (the Last-run section's dismiss
   *  button). The only non-run path that clears `lastRun`. */
  dismissRun(): void {
    this.lastRun = undefined;
    this.requestUpdate();
  }

  /** Run the Stage action (plan Phase C step 12): stage every Doorstop-managed
   *  path of the loaded index (the element hands the {@link doorstopPaths}
   *  list in), or — for a per-item stage — exactly one item's path with
   *  `title = "Git: stage <uid>"`. Runs the `doorstop.git-stage` backend
   *  operation through the shared {@link DoorstopWorkspaceController.runGitOperation}
   *  dispatch. */
  async runGitStage(paths: readonly string[], title = "Git: stage all"): Promise<void> {
    await this.runGitOperation(
      "git-stage",
      title,
      DOORSTOP_GIT_STAGE_OPERATION,
      // Fresh object literal — the request shape is validated server-side
      // (`parseDoorstopGitStageRequest`: non-empty, grammar-checked,
      // deduplicated paths).
      { paths },
      parseDoorstopGitStageResponse,
    );
  }

  /** Run the Unstage action (plan-add-git-actions Phase 4): unstage one
   *  item's own staged changes (the element's per-item minus affordance and
   *  palette Unstage button), or — for the (currently unused) all form —
   *  every given path, with `title = "Git: unstage <uid>"` on the per-item
   *  path. Runs the `doorstop.git-unstage` backend operation through the
   *  shared {@link DoorstopWorkspaceController.runGitOperation} dispatch; the
   *  response mirrors {@link DoorstopGitStageResponse} as
   *  `unstaged`/`clean`/`skipped`/`failed`. */
  async runGitUnstage(paths: readonly string[], title = "Git: unstage all"): Promise<void> {
    await this.runGitOperation(
      "git-unstage",
      title,
      DOORSTOP_GIT_UNSTAGE_OPERATION,
      // Fresh object literal — the request shape is validated server-side
      // (`parseDoorstopGitUnstageRequest`: non-empty, grammar-checked,
      // deduplicated paths).
      { paths },
      parseDoorstopGitUnstageResponse,
    );
  }

  /** Run the Git commit action (plan Phase C step 12): commit the staged
   *  index with `message` (NO pathspec, NO add — whatever the index holds).
   *  Runs the `doorstop.git-commit` backend operation through the shared
   *  {@link DoorstopWorkspaceController.runGitOperation} dispatch; the
   *  response reuses {@link DoorstopCommitOutcome} verbatim. */
  async runGitCommit(message: string): Promise<void> {
    await this.runGitOperation(
      "git-commit",
      "Git: commit",
      DOORSTOP_GIT_COMMIT_OPERATION,
      // Fresh object literal — the message is validated server-side
      // (`parseDoorstopGitCommitRequest`: non-blank single line, trimmed).
      { message },
      parseDoorstopGitCommitResponse,
    );
  }

  /**
   * The shared git run dispatch (plan Phase C step 12) — the
   * `runDoorstopBackend` idiom for the project-scoped git operations:
   * `beginRun(title)` → structured backend request → strict response parse →
   * map onto a `DoorstopLastRunView` (`op`: `git-stage`/`git-unstage`/
   * `git-commit`;
   * `status`: `"ok"` when the operation resolved — even when its OUTCOME
   * was skipped/clean, which the `commit` narration carries — `"failed"`
   * when the git step itself failed, `"error"` when the bridge rejected. A
   * git run's `status` NEVER becomes `"killed"`: a host abort during a git
   * exec rejects the bridge request, which maps to `"error"` below — the
   * abort-rethrow taxonomy (the `killed` mapping belongs to the doorstop CLI
   * runs, which observe a signal themselves). Do not "fix" this mapping) →
   * `commitRun` → `invalidate()` on success (a successful stage/unstage/
   * commit changed the workspace — and, since `invalidate()` is the
   * strip's single cache-clearing point, the git-status view is dropped for
   * the element to refetch) → `endRun()` in `finally`. A rejected request
   * commits `status: "error"` with the server error text and does NOT
   * invalidate (nothing ran — the `runDoorstopBackend` contract verbatim).
   * The element's existing `runInProgress` disable covers the new buttons
   * for free.
   */
  private async runGitOperation(
    op: DoorstopGitRunOp,
    title: string,
    backendOperation: string,
    input: JsonValue,
    parseResponse: (value: unknown) => DoorstopGitRunOutcome,
  ): Promise<void> {
    this.beginRun(title);
    const startedAt = Date.now();
    try {
      const backend = this.context.backend;
      if (backend === undefined) {
        // Defensive fallback only — the panel gates the buttons on
        // `backendActive()`, so this branch is reachable solely by direct
        // controller callers (tests, host wiring) on unpaired installs.
        this.commitGitError(op, title, startedAt, "Git actions need the paired opendoor backend");
        return;
      }
      const response = await backend.request(backendOperation, input);
      const parsed = parseResponse(response);
      this.commitRun({
        op,
        title,
        // The git operation itself is the run: a `failed` outcome (git
        // step error — add/reset/commit failure, failing pre-commit hook,
        // missing identity) fails the badge; an `ok` outcome carries its
        // result as the `commit` narration (`staged <n> paths` /
        // `unstaged <n> paths` / `committed <sha>` / `clean` / `skipped`).
        status: parsed.status === "failed" ? "failed" : "ok",
        exitCode: null,
        signal: null,
        stdout: "",
        // The failed outcome's stderr excerpt rides ONLY in the `commit`
        // narration (the expanded status bar body renders it there) — the
        // review→commit pipeline's exact idiom: a failed commit never
        // pollutes the run's own captured stderr.
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        // No server-measured duration on these responses; the client-side
        // wall time around the request is what we have.
        durationMs: Date.now() - startedAt,
        at: startedAt,
        commit: parsed,
      });
      void this.invalidate();
    } catch (error) {
      // No response → nothing ran: commit `status: "error"` and do NOT
      // invalidate (the `runDoorstopBackend` contract verbatim).
      this.commitGitError(op, title, startedAt, formatUnknownError(error));
    } finally {
      this.endRun();
    }
  }

  /** Commit a bridge-rejected (or backend-less) git run view: `status:
   *  "error"`, no server data, nothing invalidated (nothing ran). */
  private commitGitError(op: DoorstopGitRunOp, title: string, startedAt: number, errorMessage: string): void {
    this.commitRun({
      op,
      title,
      status: "error",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      at: startedAt,
      errorMessage,
    });
  }

  /**
   * Synchronous read of the current "changes since review" baseline view for
   * `item`, or `undefined` when nothing was fetched OR the cached entry's key
   * no longer matches the item's current reviewed/stamp state (a re-review or
   * further edit missed naturally — the next expand refetches).
   */
  baselineViewFor(item: ItemRecord): DoorstopBaselineView | undefined {
    const entry = this.baselineViews.get(item.uid);
    if (entry === undefined) return undefined;
    if (entry.key !== baselineKey(item, this.configForItem(item))) return undefined;
    return entry.view;
  }

  /**
   * Request the "changes since review" baseline view for an item (the detail
   * pane's expand handler). A cache hit under the current key returns
   * immediately — EXCEPT a `"loading"` view (the in-flight fetch is joined
   * below, never stacked) and an `"error"` view (a failed request is a
   * TRANSIENT bridge/parse hiccup, not a terminal result — re-expanding
   * retries instead of showing a stale failure forever). A fetch already in
   * flight for the same UID is joined (never stacked). Otherwise the fetch
   * runs through
   * `backend.request(DOORSTOP_BASELINE_OPERATION, { uid, path })`, parses the
   * response with the contract validator, and stamp-walks the returned blobs
   * newest-first (`parseDoorstopItem` + the document's config via
   * `computeItemStamp(item, config, true)`) until one matches
   * `item.reviewed`. The matched blob becomes the diff's "before" side.
   *
   * Follows the run-mutator idiom: state is written unconditionally and the
   * render is requested through {@link requestUpdate}; after every `await`,
   * writes are dropped when the host disconnected (the loading view then
   * self-heals on the next expand, which sees no in-flight request and
   * refetches).
   */
  async requestBaseline(item: ItemRecord): Promise<void> {
    const uid = item.uid;
    const config = this.configForItem(item);
    const key = baselineKey(item, config);
    const cached = this.baselineViews.get(uid);
    // An `"error"` view misses the cache like a `"loading"` one: the failure
    // is transient, so the next expand retries it (the stale error stays
    // VISIBLE for rendering — `baselineViewFor` still returns it — it just
    // no longer short-circuits the fetch). The terminal states (`"no-git"` /
    // `"no-match"` / `"ready"`) are authoritative under the current key.
    if (
      cached !== undefined &&
      cached.key === key &&
      cached.view.state !== "loading" &&
      cached.view.state !== "error"
    ) {
      return;
    }
    const inflight = this.baselineRequests.get(uid);
    if (inflight !== undefined) {
      await inflight;
      return;
    }
    const request = this.fetchBaseline(item, config, key);
    this.baselineRequests.set(uid, request);
    try {
      await request;
    } finally {
      if (this.baselineRequests.get(uid) === request) this.baselineRequests.delete(uid);
    }
  }

  /** The baseline fetch itself: loading view → backend request → validation →
   *  stamp walk → final view. Never throws out of the controller. */
  private async fetchBaseline(
    item: ItemRecord,
    config: DoorstopDocumentConfig,
    key: string,
  ): Promise<void> {
    const uid = item.uid;
    this.baselineViews.set(uid, { key, view: { state: "loading" } });
    this.baselineInFlight = uid;
    this.baselineVersion += 1;
    this.requestUpdate();
    try {
      const backend = this.context.backend;
      if (backend === undefined) {
        // Defensive fallback only — the panel gates the section on
        // `backendActive()`, so this branch is reachable solely by direct
        // controller callers (tests, host wiring) on unpaired installs.
        this.commitBaseline(uid, { key, view: { state: "no-git" } });
        return;
      }
      const response = await backend.request(DOORSTOP_BASELINE_OPERATION, { uid, path: item.path });
      if (!this.host.isConnected) return;
      const parsed = parseDoorstopBaselineResponse(response);
      if (!parsed.git) {
        this.commitBaseline(uid, { key, view: { state: "no-git" } });
        return;
      }
      const matched = matchBaselineCandidate(parsed.candidates, item, config);
      if (matched === undefined) {
        this.commitBaseline(uid, { key, view: { state: "no-match", source: parsed.source } });
        return;
      }
      this.commitBaseline(uid, {
        key,
        view: { state: "ready", source: parsed.source, diff: diffItemFields(matched, item, config) },
      });
    } catch (error) {
      if (!this.host.isConnected) return;
      this.commitBaseline(uid, { key, view: { state: "error", errorMessage: formatUnknownError(error) } });
    } finally {
      // Clear the in-flight marker and notify even on the disconnected-early
      // paths (the cache keeps its loading view; the next expand refetches).
      if (this.baselineInFlight === uid) this.baselineInFlight = undefined;
      this.baselineVersion += 1;
      this.requestUpdate();
    }
  }

  /** Commit one baseline view under its fetch key and notify. */
  private commitBaseline(uid: string, entry: DoorstopBaselineCacheEntry): void {
    this.baselineViews.set(uid, entry);
    this.baselineVersion += 1;
    this.requestUpdate();
  }

  /**
   * Request the project-actions git status readout (plan Phase C step 10).
   * Every call FETCHES (strip click, post-`invalidate()` re-fetch — the
   * rendered `gitStatusView` is the controller's single snapshot, refreshed
   * on demand); a fetch already in flight is joined, never stacked (the
   * `requestBaseline` idiom). The response is parsed strictly
   * (`parseDoorstopGitStatusResponse`) and mapped onto the view: `git:
   * false` → `"no-git"`, otherwise `"ready"`. After every `await`, writes
   * are dropped when the host disconnected OR when the loading view this
   * fetch installed is gone — `invalidate()` may clear the cache while the
   * fetch is in flight (a stage/commit run or a rescan), and a stale
   * pre-invalidate snapshot must never resurrect over the cleared view
   * (the single cache-clearing point guarantee; the strip refetches on the
   * next call, which sees no in-flight request). The view is cached until
   * `invalidate()` clears it — a rescan or any run may change dirtiness,
   * and `invalidate()` is the single cache-clearing point so stage and
   * commit refresh the strip for free through their existing invalidate.
   */
  async requestGitStatus(): Promise<void> {
    // Join an in-flight fetch instead of stacking a duplicate round-trip
    // (the requestBaseline idiom). Unlike the baseline there is NO cache
    // hit short-circuit: every call is an explicit refresh (click /
    // post-invalidate), and the snapshot lives in `gitStatusView` alone.
    if (this.gitStatusRequest !== undefined) {
      await this.gitStatusRequest;
      return;
    }
    const request = this.fetchGitStatus();
    this.gitStatusRequest = request;
    try {
      await request;
    } finally {
      if (this.gitStatusRequest === request) this.gitStatusRequest = undefined;
    }
  }

  /** The git status fetch itself: loading view → backend request → strict
   *  validation → final view. Never throws out of the controller. */
  private async fetchGitStatus(): Promise<void> {
    this.gitStatusView = { state: "loading" };
    this.gitStatusInFlight = true;
    this.requestUpdate();
    try {
      const backend = this.context.backend;
      if (backend === undefined) {
        // Defensive fallback only — the panel gates the strip on
        // `backendActive()`, so this branch is reachable solely by direct
        // controller callers (tests, host wiring) on unpaired installs.
        // No await has happened yet, so the write is safe as-is.
        this.gitStatusView = { state: "no-git" };
        return;
      }
      const response = await backend.request(DOORSTOP_GIT_STATUS_OPERATION, {});
      // The late-write guard, widened: drop the write not only when the
      // host disconnected but whenever the `loading` view THIS fetch
      // installed is gone — `invalidate()` (a rescan or any run, stage and
      // commit included) clears `gitStatusView` to undefined, and an
      // in-flight status fetch must never resurrect a stale pre-run
      // snapshot over the cleared cache. `gitStatusRequest` is undefined
      // again by the time this returns, so the strip refetches on the
      // element's next request.
      if (!this.host.isConnected || this.gitStatusView?.state !== "loading") return;
      const parsed = parseDoorstopGitStatusResponse(response);
      this.gitStatusView = parsed.git ? { state: "ready", response: parsed } : { state: "no-git" };
    } catch (error) {
      if (!this.host.isConnected || this.gitStatusView?.state !== "loading") return;
      this.gitStatusView = { state: "error", errorMessage: formatUnknownError(error) };
    } finally {
      // Clear the in-flight marker and notify even on the disconnected-early
      // paths: the view keeps its loading state for the RECONNECT SELF-HEAL —
      // `hostConnected()` clears the orphaned placeholder and the next
      // request refetches, so a disconnect mid-fetch never strands the strip
      // on `⎇ …` until a manual click.
      if (this.gitStatusInFlight) this.gitStatusInFlight = false;
      this.requestUpdate();
    }
  }

  /** Config of an item's own document — the state chain's `configForItem`
   *  idiom (a missing config must not silently break stamps). The index
   *  always carries it (the item came from that index), so the inert fallback
   *  is defensive only. */
  private configForItem(item: ItemRecord): DoorstopDocumentConfig {
    const config = this.result?.index.byPrefix.get(item.documentPrefix);
    if (config !== undefined) return config;
    return {
      directoryPath: "",
      configPath: "",
      prefix: item.documentPrefix,
      digits: 0,
      separator: "",
      itemformat: "yaml",
      extra: {},
    };
  }

  private requestUpdate(): void {
    // The `isConnected` guard lives HERE, not in the state mutators above:
    // beginRun/endRun/commitRun/dismissRun write their state unconditionally
    // and only skip the render while the host is disconnected, so run output
    // committed just before or during a disconnect survives a switch-back.
    // This is deliberate and differs from `load()`, whose `.then` drops the
    // whole result when disconnected — do not "fix" the mutators to match.
    // Route through the CURRENT context handle (refreshed by the registry on
    // workspace reuse), so re-renders reach the same fresh `host` snapshot
    // the load reads use.
    if (this.host.isConnected) this.context.host.requestRender();
  }
}

/**
 * The per-item baseline cache key (plan Phase D step 13): the item's stored
 * reviewed fingerprint plus its CURRENT stamp. A re-review rewrites
 * `reviewed`; any further edit changes the stamp — either way the key
 * changes, so a stale cached view is never returned.
 */
function baselineKey(item: ItemRecord, config: DoorstopDocumentConfig): string {
  return `${item.reviewed ?? ""}\u0000${computeItemStamp(item, config, true)}`;
}

/**
 * Stamp-walk the baseline candidates NEWEST-first (the backend returns them
 * in that order): parse each blob with the model chain's item parser under
 * the item's document config and recompute the reviewed stamp
 * (`computeItemStamp(item, config, true)`) until one matches
 * `item.reviewed`. Returns the parsed "before" record of the first match, or
 * `undefined` when none matches (history rewritten / the reviewed blob is
 * not recoverable). `parseDoorstopItem` never throws on content problems — a
 * malformed blob yields a default item whose stamp cannot match, so the walk
 * simply continues to the next candidate.
 */
function matchBaselineCandidate(
  candidates: readonly DoorstopBaselineCandidate[],
  item: ItemRecord,
  config: DoorstopDocumentConfig,
): ItemRecord | undefined {
  for (const candidate of candidates) {
    const parsed = parseDoorstopItem(item.path, candidate.blob, config);
    if (computeItemStamp(parsed.item, config, true) === item.reviewed) return parsed.item;
  }
  return undefined;
}

/**
 * Keep `selectedUid` only when the item still exists in the (filtered)
 * result index — the detail pane must never render a vanished item.
 */
function selectionIn(
  result: DoorstopWorkspaceResult,
  filter: ItemStateKey | undefined,
  selectedUid: string | undefined,
): string | undefined {
  if (selectedUid === undefined) return undefined;
  const item = result.index.byUid.get(selectedUid);
  if (item === undefined) return undefined;
  if (filter !== undefined && !item.stateKeys.includes(filter)) return undefined;
  return selectedUid;
}

/** Keep `selectedDocumentPrefix` only when the document still exists. */
function documentSelectionIn(result: DoorstopWorkspaceResult, selected: string | undefined): string | undefined {
  if (selected === undefined) return undefined;
  return result.index.byPrefix.has(selected) ? selected : undefined;
}

/** The workspace-root marker config path, in the discovery file-index path
 *  format. */
const DOORSTOP_ROOT_CONFIG_PATH = ".doorstop.yml";

/**
 * The loaded index's Doorstop-managed workspace-relative paths (plan Phase C
 * step 11) — the path list the Stage all action stages: the root
 * `.doorstop.yml` (when the discovery result carries it — it lives in the
 * discovery file index {@link DoorstopIndex.knownFilePaths}), each
 * document's config file path, and each item's `path`. Pure function over
 * {@link DoorstopWorkspaceResult}, deduplicated (first occurrence order
 * preserved), fully unit-testable without DOM. The result feeds
 * `doorstop.git-stage`'s `paths` — which the request parser validates and
 * deduplicates again server-side, so this helper's own hygiene is a
 * convenience, not a boundary.
 *
 * A NON-root document whose config file could not be read is NOT in the
 * index and its items are not in the result, so its files are unstaged
 * until a successful rescan — inherent to the loaded-index design (the
 * plan accepts index staleness, same as on-disk files created after the
 * last refresh). The ROOT `.doorstop.yml` alone is rescued from
 * `knownFilePaths` because discovery enumerates it even when unreadable
 * (an unreadable root config is skipped with a diagnostic yet still
 * Doorstop-managed); no other config gets that rescue.
 */
export function doorstopPaths(result: DoorstopWorkspaceResult): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  // The root marker, when discovery enumerated it (it may exist without
  // being a document — an unreadable root config is skipped with a
  // diagnostic, yet its file is still Doorstop-managed and stageable).
  if (result.index.knownFilePaths.has(DOORSTOP_ROOT_CONFIG_PATH)) add(DOORSTOP_ROOT_CONFIG_PATH);
  for (const document of result.index.documents) add(document.configPath);
  for (const item of result.index.items) add(item.path);
  return paths;
}
