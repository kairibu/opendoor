// ---------------------------------------------------------------------------
// Host markdown rendering for the detail pane's item body (plan
// plan-piweb-1-202611-1 §2.1, capability `5fb2259` in pi-web 1.202611.1).
//
// The item `text` used to be rendered as ESCAPED text (the v1 discipline
// documented at detail-pane.ts:22). Doorstop item bodies are Markdown, so the
// panel now renders them through the host's own sanitizing renderer instead of
// shipping a parser: `pi-web/markdown-rendering@1` supplies a SYNCHRONOUS,
// visibility-gated, host-cached `render({ machineId, text, … })` that returns a
// Lit `TemplateResult` (see pi-web `src/shared/markdownTypes.ts`). That
// TemplateResult is a structural template object, so embedding it in this
// plugin's own lit shadow tree is exactly the same move the panel already makes
// for host-provided `html` tags (doorstop-contributions.ts).
//
// STYLING BOUNDARY (plan §2.1 review): the rendered document — including the
// sanitized presentation HTML other plugins' markdown extensions contribute —
// lands INLINE in the panel's own node tree, because the host's
// `pi-web-content-rendering-boundary` element deliberately has no shadow root
// (createRenderRoot returns the element). What does NOT come along is styling:
// other plugins' stylesheet contributions and host theme CSS never apply to an
// unregistered root, so host rules such as `.table-scroll` and the `.formatted`
// prose set are absent here. The panel therefore restates every rule its
// documents need in `styles/detail-pane.ts` (.doorstop-text-markdown).
//
// DECISION D1 — how the capability is obtained: DECLARE it in `requires`.
//
//   Option A (chosen): `requires: [DOORSTOP_MARKDOWN_CAPABILITY]` on the
//   browser plugin, resolved in `start()` and handed to the panel wiring.
//   Option B (rejected): keep the contributions path and feature-detect at
//   runtime so hosts in [1.202610.5, 1.202611.0] keep the escaped-text
//   rendering.
//
//   Option B is not merely unattractive, it is IMPOSSIBLE with the public
//   contracts in this release: `PluginCapabilityResolver` has exactly one
//   member, `resolve(capability)`, and it is total — it throws when the
//   capability was not declared (`registry.ts` createCapabilityResolver:
//   "did not declare required capability") and undeclared capabilities are
//   pre-validated at start time by `capabilityResolver()` ("requires inactive
//   capability"). There is no `tryResolve` / optional-resolve variant, and no
//   non-capability host channel carries the renderer. So the only way to get
//   the value is to declare it, and declaring it makes activation hard-fail on
//   any host that does not provide it — the plugin would disappear from the
//   panel list instead of degrading.
//
// CONSEQUENCE (deliberate, documented): the effective host floor for the
// browser plugin rises from 1.202610.5 to **1.202611.1**, because
// `markdown-rendering@1` first exists there. `package.json`
// `peerDependencies` and README §Status are updated to say exactly that — the
// alternative (keeping the old floor claim while hard-requiring a
// 1.202611.1-only capability) would be a false advertisement. The SERVER entry
// is untouched and still loads across the whole supported range.
// ---------------------------------------------------------------------------

import type { MarkdownRenderingCapability, PluginCapability } from "@jmfederico/pi-web/plugin-api";

/**
 * The host markdown renderer as this plugin consumes it. Structurally the
 * public `MarkdownRenderingCapability`, re-stated here only so the panel
 * element and the section API do not have to import from the host package at
 * runtime (host imports stay type-only, as everywhere else in this plugin).
 */
export type DoorstopMarkdownRenderer = MarkdownRenderingCapability;

/**
 * Host capability `{ pluginId: "pi-web", id: "markdown-rendering", version: 1 }`
 * (pi-web 1.202611.1+, `5fb2259`). The `parse` guard mirrors the host's own
 * (`src/client/src/formatting/markdownRendering.ts`): the capability value is
 * frozen but untyped across the API boundary, so a hostile or mismatched host
 * must fail loudly at resolve time instead of producing a render call to
 * `undefined` later.
 */
export const DOORSTOP_MARKDOWN_CAPABILITY: PluginCapability<MarkdownRenderingCapability> = {
  pluginId: "pi-web",
  id: "markdown-rendering",
  version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null || !("render" in value) || typeof value.render !== "function") {
      throw new Error("Markdown rendering capability v1 is unavailable");
    }
    return value as MarkdownRenderingCapability;
  },
};

/**
 * Late-bound holder for the resolved renderer.
 *
 * Ordering forces this indirection: `activate()` runs FIRST and returns the
 * contributions (including the panel render function), while `start()` — the
 * only place `capabilities.resolve` exists — runs after it and before the
 * contributions are published. The factory closes over this holder, `start()`
 * fills it in, and every panel render reads it. By the time any panel render
 * can run, `start()` has succeeded (a failed start rolls the plugin back), so
 * `renderer` is set in production; it stays `undefined` only for a
 * directly-constructed body element (tests) or the hypothetical pre-start
 * render, which the detail pane handles by keeping the old escaped-text
 * discipline.
 */
export interface DoorstopMarkdownHolder {
  renderer: DoorstopMarkdownRenderer | undefined;
}

export function createDoorstopMarkdownHolder(): DoorstopMarkdownHolder {
  return { renderer: undefined };
}
