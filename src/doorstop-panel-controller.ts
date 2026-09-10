// ---------------------------------------------------------------------------
// Opendoor per-workspace reactive controller (plan §3.2 — mirrors
// OpenseWorkspaceController exactly): one `DoorstopWorkspaceController`
// instance holds the complete UI state of one workspace's Requirements panel
// — load result, loading/stale/error flags, document/state-filter selection,
// the search string, and the last doorstop run's view record
// (`lastRun`/`runInProgress`, plan Phase D step 8) — and pushes every
// connected state mutation to the panel host via the CURRENT workspace
// context handle (`this.context.host.requestRender()`), gated on the
// controller's own connection flag.
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
// fake host, no DOM required (plan §5).
// ---------------------------------------------------------------------------

import type { ReactiveController } from "lit";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { DoorstopFiles, ItemStateKey } from "./doorstop-contract.js";
import { formatUnknownError } from "./doorstop-contract.js";
import type { DoorstopRunRequest } from "./doorstop-backend-contract.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";

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
 */
export interface DoorstopLastRunView {
  /** The run's op (also the terminal-metadata `opendoor.op` value). */
  op: DoorstopRunRequest["op"];
  /** Human title of the run (button label / terminal title). */
  title: string;
  status: "ok" | "failed" | "killed" | "error";
  /** Process exit code; `null` when the process never exited (killed). */
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

  private readonly loadJob: DoorstopWorkspaceJob;

  /** In-flight load job; re-entrant calls reuse it (no overlapping jobs). */
  private loadRequest: Promise<void> | undefined;

  constructor(host: DoorstopWorkspaceHost, context: WorkspacePanelContext, loadJob: DoorstopWorkspaceJob) {
    this.host = host;
    this.context = context;
    this.loadJob = loadJob;
  }

  /** The workspace panel connected (the activity element calls this from its
   *  connect path). Marks the host connected and kicks the first load; later
   *  loads reuse the in-flight job through the loadRequest guard, so
   *  overlapping jobs never run. */
  hostConnected(): void {
    this.host.isConnected = true;
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
   *  connected workspace (paired or unpaired: the load job is browser-side, so there is no owned-workspace gate). */
  invalidate(): Promise<void> {
    this.stale = this.result !== undefined;
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
