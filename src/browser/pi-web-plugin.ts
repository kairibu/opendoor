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
// ---------------------------------------------------------------------------

import type { PiWebPluginV5 } from "@jmfederico/pi-web/plugin-api";
import { createOpendoorBrowserContributions } from "./doorstop-contributions.js";

const plugin: PiWebPluginV5 = {
  apiVersion: 5,
  name: "Opendoor",
  activate: ({ runtimePluginId, html, svg }) => ({
    contributions: createOpendoorBrowserContributions(runtimePluginId, html, svg),
  }),
};

export default plugin;
