// ---------------------------------------------------------------------------
// Browser entry point for the opendoor plugin. Pure wiring: the default
// export matches the host's load-time expectations (see
// src/client/src/plugins/external.ts parsePluginModule) and passes the
// activation context into the contributions factory, exactly like the
// info/git browser entries and OpenSE. All logic lives in
// doorstop-contributions.ts (+ the reviewed panel/model/state modules); no
// `context.backend` fallback path exists because browser-only plugins never
// have one (feature spec §9.6). Host imports are type-only.
// ---------------------------------------------------------------------------

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createOpendoorBrowserContributions } from "./doorstop-contributions.js";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Opendoor",
  activate: ({ runtimePluginId, html, svg }) => ({
    contributions: createOpendoorBrowserContributions(runtimePluginId, html, svg),
  }),
};

export default plugin;
