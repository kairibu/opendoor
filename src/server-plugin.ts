// ---------------------------------------------------------------------------
// Opendoor server plugin entry (plan Phase B step 3, chain E2 server half):
// the paired `serverModule` (package.json `piWeb.plugins[].serverModule`)
// loaded by the session daemon at startup. Activation exposes ONE workspace
// provider (probe/list only) plus an activation-level `peer` whose `request`
// method is what serves the browser `context.peer` (doorstop.run through
// `requestDoorstopBackend`, the item-baseline fetch, and the four
// project-scoped git operations — status/stage/unstage/commit).
//
// Server plugin API v5 (pi-web 1.202610.8): `apiVersion: 5`, typed as
// `PiWebServerPluginV5`. The provider-level `request` method was already
// removed back in v3, so the six-operation dispatch still lives at the
// activation level. The v5 peer request context
// (`ServerPluginPeerRequestContextV5`) replaced the mandatory
// project/workspace fields with a host-resolved `scope` union
// (`{ kind: "machine" } | { kind: "project"; project } | { kind:
// "workspace"; project; workspace }`); only workspace scope can serve the
// six existing handlers (all execute with `workspace.path` as cwd — see
// doorstop-backend.ts), so `dispatchDoorstopOperation` forwards the
// scope's frozen project/workspace projection into the same legacy-shaped
// handler request and rejects machine/project scopes with the same
// error-message style as the existing unsupported-operation guard. No
// request validation, serialization, per-workspace serialization, timeout,
// or doorstop-backend.ts logic changes. The v5 scopes are NOT wired to
// `backend.forScope` on the browser side (the paired-peer gate stays).
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
// NO LATE CAPABILITIES (permanent, relay `opendoor-dispatch-redesign` design
// §2.2): this entry declares no `requires` and no `start()` — not as an
// interim, but because the review dispatch no longer belongs here at all. The
// host rejects any workspace-provider-contributing entry that (transitively)
// requires a late host capability (`serverPluginRuntime.ts` provider-cycle
// check), so the capability-driven `doorstop.ask-agent` path was unreachable
// by construction and has been RETIRED: the activation-level peer serves
// exactly the six paired backend operations below, and the review dispatch is
// executed by the opendoor Pi extension (`dist/pi-extension/index.js`, source
// `src/pi-extension/opendoor-review.ts`) through the host's own per-session
// dispatch bridge. The metadata module stays: it is now the extension's
// contract producer (relative-path import inside the same package).
// ---------------------------------------------------------------------------

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type {
  JsonValue,
  LegacyServerPluginPeerRequestContext,
  PiWebServerPluginV5,
  ProjectInput,
  ProviderClaim,
  ProviderWorkspace,
  ServerPluginActivationContextV5,
  ServerPluginPeerRequestContextV5,
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
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  DOORSTOP_RUN_OPERATION,
} from "./doorstop-backend-contract.js";

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

const plugin: PiWebServerPluginV5 = {
  apiVersion: 5,
  name: "Opendoor",
  // Permanently no `requires`/`start()` — see the module header: the review
  // dispatch moved to the Pi extension, so this provider-contributing entry
  // never approaches the host's provider-cycle rule (and never declares the
  // host catalog capability, which is prohibited for provider-contributing
  // entries).
  activate(context) {
    return {
      workspaceProvider: createDoorstopWorkspaceProvider(context),
      // v3 onward (unchanged on v5): the six-operation dispatch lives at the
      // activation level, not on the provider (`WorkspaceProvider.request`
      // was removed). The v5 context carries a `scope` union; the dispatch
      // accepts only the workspace scope and rejects the rest.
      peer: {
        request: (request: ServerPluginPeerRequestContextV5) =>
          dispatchDoorstopOperation(context, request),
      },
    };
  },
};

export default plugin;

/** Create the opendoor workspace provider for one activation (testable —
 *  git's `createGitWorkspaceProvider` idiom). The provider is frozen and
 *  exposes only `probe`/`list`: since server plugin API v3 the provider has
 *  no `request` method, so the operation dispatch lives in
 *  {@link dispatchDoorstopOperation} behind the activation-level peer. */
export function createDoorstopWorkspaceProvider(context: ServerPluginActivationContextV5): WorkspaceProvider {
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
 *  budget inside doorstop-backend.ts); every other operation gets the
 *  existing unsupported-operation error — the same message the run handler's
 *  own guard throws.
 *
 *  v5 scoping (pi-web 1.202610.8): the request context carries a
 *  host-resolved `scope` union instead of mandatory project/workspace. The
 *  six handlers read only `request.workspace.path` (their signatures and
 *  semantics in doorstop-backend.ts are untouched), so only the workspace
 *  scope can be served: its host-resolved `scope.project`/`scope.workspace`
 *  projections are forwarded into the same legacy-shaped handler request
 *  (`ServerPluginPeerRequestContext`, the workspace-only contract the
 *  handlers pin). Machine- and project-scoped peers (for example a
 *  companion extension resolving `backend.forScope({ kind: "project" })`)
 *  reject with the clear sibling of the unsupported-operation message —
 *  style-matched, since both rejections come from the same dispatch.
 *  After the `doorstop.ask-agent` retirement (relay
 *  `opendoor-dispatch-redesign` §2.2) exactly these six operations exist, so
 *  the sessiond op grammar is trivially satisfied. */
export function dispatchDoorstopOperation(
  context: ServerPluginActivationContextV5,
  request: ServerPluginPeerRequestContextV5,
): Promise<JsonValue> {
  // Destructure first so the scope narrows reliably across the switch.
  const { scope, operation, input, signal } = request;
  if (scope.kind !== "workspace") {
    // Reject (never throw synchronously): the peer contract returns a
    // promise, and every rejection below is an async one.
    return Promise.reject(unsupportedPeerScopeError(operation, scope.kind));
  }
  // The frozen v5 host projection satisfies the handlers' workspace-shaped
  // request contract exactly (they read only `workspace.path`).
  const handlerRequest: LegacyServerPluginPeerRequestContext = {
    project: scope.project,
    workspace: scope.workspace,
    operation,
    input,
    signal,
  };
  switch (operation) {
    case DOORSTOP_RUN_OPERATION:
      return requestDoorstopBackend(context, handlerRequest);
    case DOORSTOP_BASELINE_OPERATION:
      return requestDoorstopBaseline(context, handlerRequest);
    case DOORSTOP_GIT_STATUS_OPERATION:
      return requestDoorstopGitStatus(context, handlerRequest);
    case DOORSTOP_GIT_STAGE_OPERATION:
      return requestDoorstopGitStage(context, handlerRequest);
    case DOORSTOP_GIT_UNSTAGE_OPERATION:
      return requestDoorstopGitUnstage(context, handlerRequest);
    case DOORSTOP_GIT_COMMIT_OPERATION:
      return requestDoorstopGitCommit(context, handlerRequest);
    default:
      // Reject (never throw synchronously): the peer contract returns a
      // promise, and the async handlers' own guard rejects with this same
      // error — one message source, one failure mode.
      return Promise.reject(unsupportedBackendOperationError(operation));
  }
}

/** The three fixed v5 scope-kind literals (the `scope` union documented at
 *  the top of this file); the scope-rejection message echoes only these. */
const peerScopeKinds: ReadonlySet<string> = new Set(["machine", "project", "workspace"]);

/** The scope-rejection error for non-workspace v5 peer scopes — the message
 *  sibling of `unsupportedBackendOperationError` (same `opendoor: ` prefix,
 *  same lowercase-phrase style), naming the operation and the kind that
 *  cannot serve it. Exported so the tests pin the exact wording.
 *
 *  Both interpolations are bounds-checked rather than echoed raw: the
 *  operation must be a plain sessiond-style token (`[A-Za-z0-9.-]+`, the
 *  character class every live op id already satisfies — doorstop.run,
 *  doorstop.git-status) and the scope kind must be one of the three fixed
 *  v5 union literals; anything else (malformed ids smuggled through a
 *  custom host, future kinds the message grammar doesn't know) collapses
 *  to the neutral `unknown` placeholder, keeping the message single-line
 *  and punctuation-free under diagnostic-discipline rules. Well-formed
 *  inputs pass through byte-identically, so the pinned assertions hold. */
export function unsupportedPeerScopeError(operation: string, scopeKind: string): Error {
  const op = /^[A-Za-z0-9.-]+$/.test(operation) ? operation : "unknown";
  const kind = peerScopeKinds.has(scopeKind) ? scopeKind : "unknown";
  return new Error(`opendoor: ${op} peer requests require workspace scope (got ${kind})`);
}
