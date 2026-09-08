// ---------------------------------------------------------------------------
// Browser entry point for the opendoor plugin.
//
// ⚠ PLACEHOLDER ONLY ⚠ — this is the M0 scaffold slice. This file satisfies
// the host's load-time contract (see src/client/src/plugins/external.ts
// parsePluginModule) so the package builds, typechecks, installs, and the
// pi-web catalog can discover it, but it contributes nothing yet.
//
// A later chain replaces the default export with the real wiring (exactly
// like the OpenSE entry in ../opense-package/src/pi-web-plugin.ts): an
// activate that passes { runtimePluginId, html, svg } into a contributions
// factory producing the Requirements workspace panel, the action-palette
// actions, and the workspace label described in
// docs/feature-doorstop-plugin.md (§7, §8). Nothing below is part of the
// frozen contract (see src/doorstop-contract.ts) except the descriptor
// fields apiVersion/name.
// ---------------------------------------------------------------------------

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Opendoor",
  // PLACEHOLDER: no contributions yet. activate ignores its context on
  // purpose; the real factory lands in a later chain.
  activate: () => ({ contributions: {} }),
};

export default plugin;
