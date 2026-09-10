// ---------------------------------------------------------------------------
// Opendoor server plugin entry (plan Phase B step 3, chain E2 server half):
// the paired `serverModule` (package.json `piWeb.plugins[].serverModule`)
// loaded by the session daemon at startup. Activation exposes ONE workspace
// provider; its `request` method is what enables the browser `backend`
// (doorstop.run through `requestDoorstopBackend`).
//
// Ownership per plan §"Ownership trade-off": opendoor is a PRIMARY-tier
// provider (no `fallback`) — `probe` claims ONLY when `<project.path>/
// .doorstop.yml` exists, and passes everything else (staying on the fallback
// Git provider). The claim check is a cheap `node:fs/promises` access — no
// CLI exec on probe (a CLI-backed probe would force a doorstop install on
// every non-doorstop project). `probe` NEVER rejects: a rejected probe
// degrades the project into an errored state, so any failure (missing file,
// unreadable project, aborting signal) passes.
//
// Lifecycle surface is deliberately minimal: `prepareRemove` is omitted
// (main-only workspaces are not removable linked workspaces), and `health`
// is deferred (a bounded health probe shouldn't execute the CLI in v1).
// Runtime imports are limited to `node:path`/`node:fs/promises` (the plan's
// constraint — the server bundle must stay self-contained); everything from
// `@jmfederico/pi-web/server-plugin-api` is TYPE-ONLY so the host API never
// becomes a runtime import of the plugin.
// ---------------------------------------------------------------------------

import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderRequestContext,
  ProviderWorkspace,
  ServerPluginActivationContext,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestDoorstopBackend } from "./doorstop-backend.js";

/** Marker file whose presence makes a project a doorstop project. */
const DOORSTOP_MARKER_FILE = ".doorstop.yml";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Opendoor",
  activate(context) {
    return { workspaceProvider: createDoorstopWorkspaceProvider(context) };
  },
};

export default plugin;

/** Create the opendoor workspace provider for one activation (testable —
 *  git's `createGitWorkspaceProvider` idiom). The provider is frozen and its
 *  `request` routes `doorstop.run` to the shared backend. */
export function createDoorstopWorkspaceProvider(context: ServerPluginActivationContext): WorkspaceProvider {
  return Object.freeze({
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      try {
        await access(join(project.path, DOORSTOP_MARKER_FILE));
        return "claim";
      } catch {
        // Any failure passes — missing marker, unreadable path, aborted
        // signal — so a probe never rejects (never degrades the project).
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
    request: (request: ProviderRequestContext) => requestDoorstopBackend(context, request),
  });
}