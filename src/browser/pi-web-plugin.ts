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
// Browser plugin API v4 (pi-web 1.202609.1): `apiVersion: 4`. The v4 host
// removed the old `context.backend` surface and the provider
// `capabilities.request` field; the peer (`context.peer`) is now the exact
// revision-paired path to this package's own active server entry, decoupled
// from workspace ownership.
// ---------------------------------------------------------------------------

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createOpendoorBrowserContributions } from "./doorstop-contributions.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Opendoor",
  activate: ({ runtimePluginId, html, svg }) => ({
    contributions: createOpendoorBrowserContributions(runtimePluginId, html, svg),
  }),
};

export default plugin;
