// ---------------------------------------------------------------------------
// Opendoor server plugin entry (plan Phase B step 3, chain E2 server half):
// the paired `serverModule` (package.json `piWeb.plugins[].serverModule`)
// loaded by the session daemon at startup. Activation exposes ONE workspace
// provider (probe/list only) plus an activation-level `peer` whose `request`
// method is what serves the browser `context.peer` (doorstop.run through
// `requestDoorstopBackend`, the item-baseline fetch, and the four
// project-scoped git operations — status/stage/unstage/commit).
//
// Server plugin API v3 (pi-web 1.202609.1): `apiVersion: 3`; the old
// provider-level `request` method was REMOVED from `WorkspaceProvider`, so
// the six-operation dispatch was hoisted out of the provider into the
// activation-level `ServerPluginPeer.request(context)`. The peer request
// context (`ServerPluginPeerRequestContext`) carries the same
// project/workspace/operation/input/signal fields the provider request did;
// the peer workspace projection (`ServerPluginPeerWorkspace`) also carries
// `path`, which is the only workspace field the handlers read.
//
// Ownership per plan §"Ownership trade-off": opendoor is a PRIMARY-tier
// provider (no `fallback`) — `probe` claims ONLY when the project contains a
// `.doorstop.yml`, and passes everything else (staying on the fallback Git
// provider). Doorstop trees commonly nest the marker inside document
// subdirectories (`reqs/.doorstop.yml` is the idiom, not the exception), so
// the probe is a BOUNDED SHALLOW WALK (≤ 3 directory levels, ≤ 256 entries,
// `.git`/`node_modules` skipped) rather than a root-only access — still cheap
// node:fs/promises readdirs, no CLI exec (a CLI-backed probe would force a
// doorstop install on every non-doorstop project). `probe` NEVER rejects: a
// rejected probe degrades the project into an errored state, so any failure
// (missing marker, unreadable directory, aborting signal) passes.
//
// Lifecycle surface is deliberately minimal: `prepareRemove` is omitted
// (main-only workspaces are not removable linked workspaces), and `health`
// is deferred (a bounded health probe shouldn't execute the CLI yet).
// Runtime imports are `node:path`/`node:fs/promises` (the plan's constraint — the
// server bundle must stay self-contained); every host TYPE remains type-only so
// the host API never becomes a runtime import of the plugin.
//
// INTERIM (human-approved, relay `opendoor-session-metadata-labels` signal):
// this entry declares NO `requires`/`start()`. The host's server registration
// rejects any workspace-provider-contributing entry that (transitively)
// requires a late host capability (`serverPluginRuntime.ts` provider-cycle
// check), so the session-dispatch capabilities cannot be resolved here on the
// released host. The dispatch scaffolding stays in place (module header of
// doorstop-dispatch.ts) but the holder stays empty and `doorstop.ask-agent`
// rejects with a clear "capabilities are not active" message; the panel keeps
// the composer-insert Ask-agent entries working. The redesigned dispatch
// pathway (Pi package extension) replaces this in a follow-up relay.
// ---------------------------------------------------------------------------

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type {
  JsonValue,
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderWorkspace,
  ServerPluginActivationContext,
  ServerPluginPeerRequestContext,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  requestDoorstopBackend,
  requestDoorstopBaseline,
  requestDoorstopGitCommit,
  requestDoorstopGitStage,
  requestDoorstopGitStatus,
  requestDoorstopGitUnstage,
  unsupportedBackendOperationError,
} from "./doorstop-backend.js";
import {
  DOORSTOP_ASK_AGENT_OPERATION,
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopAskAgentRequest,
} from "./doorstop-backend-contract.js";
import {
  activateDoorstopDispatch,
  createDoorstopDispatch,
  requestDoorstopAskAgent,
  type DoorstopDispatch,
} from "./doorstop-dispatch.js";

/** Marker file whose presence makes a project a doorstop project. */
const DOORSTOP_MARKER_FILE = ".doorstop.yml";

/** Probe walk bounds (see the module header): how deep below the project root
 *  the marker may sit, how many entries may be scanned in total, and which
 *  directory names are never entered (the plugin's built-in discovery skips;
 *  the walk must not descend into huge vendor trees). */
const PROBE_MAX_DEPTH = 3;
const PROBE_MAX_ENTRIES = 256;
const PROBE_SKIP_NAMES = new Set([".git", "node_modules"]);

/** Bounded shallow walk: does `root` contain a `.doorstop.yml` at or below it
 *  (≤ PROBE_MAX_DEPTH levels, ≤ PROBE_MAX_ENTRIES scanned entries)? Never
 *  throws — an unreadable directory is skipped (its subtree is invisible,
 *  which can only make the probe pass, never error), and an aborted signal
 *  ends the walk as "not found". */
async function probeContainsDoorstopMarker(root: string, signal: AbortSignal): Promise<boolean> {
  // The mutable scan budget lives in a closure cell so the recursive walk
  // stays a pure function of (directory, depth).
  let scanned = 0;
  const walk = async (directory: string, depth: number): Promise<boolean> => {
    if (scanned >= PROBE_MAX_ENTRIES) return false;
    scanned += 1;
    let entries: Dirent[];
    try {
      if (signal.aborted) return false;
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory: its subtree is invisible → not found here.
      return false;
    }
    for (const entry of entries) {
      if (scanned >= PROBE_MAX_ENTRIES) return false;
      scanned += 1;
      if (entry.isFile() && entry.name === DOORSTOP_MARKER_FILE) return true;
      if (entry.isDirectory() && depth < PROBE_MAX_DEPTH && !PROBE_SKIP_NAMES.has(entry.name)) {
        if (await walk(join(directory, entry.name), depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Opendoor",
  // INTERIM: no `requires`/`start()` — see the module header. The dispatch
  // holder deliberately stays empty so `doorstop.ask-agent` rejects with its
  // "capabilities are not active" message instead of failing registration or
  // touching sessions on this provider-contributing entry.
  activate(context) {
    // One activation-scoped dispatch holder. The six existing operations never
    // read it; only `doorstop.ask-agent` would, and its capabilities are
    // intentionally unresolvable here until the dispatch moves off this entry.
    const dispatch = createDoorstopDispatch();
    return {
      workspaceProvider: createDoorstopWorkspaceProvider(context),
      // v3: the six-operation dispatch lives at the activation level, not on
      // the provider (`WorkspaceProvider.request` was removed).
      peer: {
        request: (request: ServerPluginPeerRequestContext) =>
          dispatchDoorstopOperation(context, request, dispatch),
      },
    };
  },
};

export default plugin;

/** Create the opendoor workspace provider for one activation (testable —
 *  git's `createGitWorkspaceProvider` idiom). The provider is frozen and
 *  exposes only `probe`/`list`: server plugin API v3 removed the provider
 *  `request` method, so the operation dispatch lives in
 *  {@link dispatchDoorstopOperation} behind the activation-level peer. */
export function createDoorstopWorkspaceProvider(context: ServerPluginActivationContext): WorkspaceProvider {
  return Object.freeze({
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      try {
        if (await probeContainsDoorstopMarker(project.path, signal)) return "claim";
        return "pass";
      } catch {
        // Unreachable (the walk never throws) — kept as the probe's
        // never-reject backstop: a rejected probe degrades the project.
        return "pass";
      }
    },
    async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      // Opendoor workspaces ARE the project: one main workspace with a stable
      // key (the absolute project path), and the public `doorstop` marker the
      // browser gate checks (`provider?.pluginId === "opendoor"`).
      return [
        {
          key: project.path,
          path: project.path,
          label: project.name,
          isMain: true,
          publicMetadata: { doorstop: true },
        },
      ];
    },
  });
}

/** The activation-level peer request dispatch (plan-add-git-actions.md Phase
 *  B step 9): the six contract operations route to their shared backend
 *  handlers (all six serialize per workspace path and share the deadline
 *  budget inside doorstop-backend.ts); the new `doorstop.ask-agent` operation
 *  routes to the capability-driven session dispatch; every other operation
 *  gets the existing unsupported-operation error — the same message the run
 *  handler's own guard throws. The peer request context is the v3 rename of
 *  the old provider request context (same project/workspace/operation/input/
 *  signal fields), so the six handler bodies are unchanged. */
export function dispatchDoorstopOperation(
  context: ServerPluginActivationContext,
  request: ServerPluginPeerRequestContext,
  dispatch: DoorstopDispatch = createDoorstopDispatch(),
): Promise<JsonValue> {
  switch (request.operation) {
    case DOORSTOP_ASK_AGENT_OPERATION:
      // The one NEW operation (relay design §4). Routed through a helper that
      // turns a malformed request's synchronous parse throw into the same
      // promise rejection every other dispatch failure uses.
      return requestDoorstopAskAgentOperation(dispatch, request);
    case DOORSTOP_RUN_OPERATION:
      return requestDoorstopBackend(context, request);
    case DOORSTOP_BASELINE_OPERATION:
      return requestDoorstopBaseline(context, request);
    case DOORSTOP_GIT_STATUS_OPERATION:
      return requestDoorstopGitStatus(context, request);
    case DOORSTOP_GIT_STAGE_OPERATION:
      return requestDoorstopGitStage(context, request);
    case DOORSTOP_GIT_UNSTAGE_OPERATION:
      return requestDoorstopGitUnstage(context, request);
    case DOORSTOP_GIT_COMMIT_OPERATION:
      return requestDoorstopGitCommit(context, request);
    default:
      // Reject (never throw synchronously): the peer contract returns a
      // promise, and the async handlers' own guard rejects with this same
      // error — one message source, one failure mode.
      return Promise.reject(unsupportedBackendOperationError(request.operation));
  }
}

/** Validate the ask-agent request (synchronously, so a malformed input never
 *  reaches a capability) and dispatch it against the peer request's own
 *  workspace authority (F3: the browser never sends project/workspace ids). */
function requestDoorstopAskAgentOperation(
  dispatch: DoorstopDispatch,
  request: ServerPluginPeerRequestContext,
): Promise<JsonValue> {
  try {
    const input = parseDoorstopAskAgentRequest(request.input);
    return requestDoorstopAskAgent(
      dispatch,
      { projectId: request.workspace.projectId, workspaceId: request.workspace.id },
      input,
      request.signal,
    );
  } catch (error) {
    return Promise.reject(error);
  }
}
