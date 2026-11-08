// ---------------------------------------------------------------------------
// Browser entry point for the opendoor plugin. Pure wiring: the default
// export matches the host's load-time expectations (see
// src/client/src/plugins/external.ts parsePluginModule) and passes the
// activation context into the contributions factory, exactly like the
// info/git browser entries and OpenSE. All logic lives in
// doorstop-contributions.ts (+ the reviewed panel/model/state modules). The
// paired server module (server-plugin.ts) is what makes `context.peer`
// present on this package's runtime; the panel dispatches runs through it
// and falls back to the terminal when unpaired (Phase D step 9). Host
// imports are type-only.
//
// Browser plugin API v5 (pi-web 1.202610.8): `apiVersion: 5`, typed as
// `PiWebPluginV5`. The v5 host adds `catalog` (read-only
// project/workspace/session discovery) and a scoped `backend` to the
// panel/action/label callback contexts delivered through the unchanged
// contribution surface (`PiWebPluginV5` is the v4 entrypoint's contributions
// plus the V5 context variants). This entry exposes neither new surface
// yet: the panel keeps reading `context.peer` and the existing ownership
// gate (`context.workspace.provider?.pluginId`) — behavior, rendering and
// fallback paths are unchanged; the migration only upgrades the entry
// contract so v5 contexts arrive when the host dispatches them.
//
// DECISION D1 (plan-piweb-1-202611-1 §2.1): the plugin DECLARES the host's
// `markdown-rendering@1` capability so the detail pane can render item text as
// Markdown. There is no optional-resolve in the public contract (resolve is
// total and undeclared capabilities are rejected before `start`), so the
// declaration hard-raises this plugin's effective host floor to
// **1.202611.1** — the release that introduces the capability. The reasoning,
// the rejected alternative, and the README/peerDependencies consequence are
// documented once in doorstop-markdown.ts; `start()` below is the only place
// the value can be obtained.
// ---------------------------------------------------------------------------

import type { PiWebPluginV5 } from "@jmfederico/pi-web/plugin-api";
import { createOpendoorBrowserContributions } from "./doorstop-contributions.js";
import {
  createDoorstopMarkdownHolder,
  DOORSTOP_MARKDOWN_CAPABILITY,
} from "./doorstop-markdown.js";

/** One holder per activation: `start()` (the only hook that can resolve
 *  capabilities) fills it after `activate()` has already built the panel
 *  contributions, and every panel render reads it through the factory. Kept
 *  per-activation rather than module-level so a re-activation can never leak a
 *  renderer into the previous activation's panel. */
const plugin: PiWebPluginV5 = {
  apiVersion: 5,
  name: "Opendoor",
  requires: [DOORSTOP_MARKDOWN_CAPABILITY],
  activate: ({ runtimePluginId, html, svg }) => {
    const markdown = createDoorstopMarkdownHolder();
    return {
      contributions: createOpendoorBrowserContributions(runtimePluginId, html, svg, markdown),
      start: ({ capabilities }) => {
        markdown.renderer = capabilities.resolve(DOORSTOP_MARKDOWN_CAPABILITY);
      },
    };
  },
};

export default plugin;
