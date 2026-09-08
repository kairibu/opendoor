# opendoor — a Doorstop requirements-management plugin for PI WEB

`opendoor` is a browser-only PI WEB plugin that surfaces
[Doorstop](https://github.com/doorstop-dev/doorstop) requirements stored in
the workspace next to the code they trace to: a **Requirements** workspace tab
with the document tree, per-item state (reviewed/unreviewed changes, suspect
links), validation findings, and one-click `doorstop` CLI actions (validate,
publish, add/link/unlink, clear suspect links, review), plus agent prompts
that insert requirement context into the session.

Full feature spec: [`docs/feature-doorstop-plugin.md`](docs/feature-doorstop-plugin.md)
(§5 architecture, §6 requirements state model, §7–§8 UI/actions).

## Status

The full browser plugin is wired and green: the shared contract module
(`src/doorstop-contract.ts`), the discovery / model / state / panel modules,
and the real plugin entry — all unit-tested, including the integration glue
(`src/doorstop-contributions.test.ts` covers the contribution shape, the
panel render mirroring, and the status label's async-cache choreography;
`src/pi-web-plugin.test.ts` covers the host-facing entry).
`src/pi-web-plugin.ts` is the thin browser entry (apiVersion 2, name
`Opendoor`) that delegates to `createOpendoorBrowserContributions` in
`src/doorstop-contributions.ts`, which contributes:

- **panel** `workspace.doorstop` (title **Requirements**, order 60) — the Lit
  body element `<pi-web-opendoor-panel-body>`, driven by the per-workspace
  controller registry (`src/doorstop-panel.ts`): document tree, item list
  with state chips, item detail pane (links in/out, references, extended
  attributes, per-item actions), findings sub-view, ask-agent menu;
- **actions** `view.doorstop` (mod+7) and `workspace.refresh-doorstop`
  (mod+shift+d);
- **label** `doorstop-status` — the informational requirement-health counts
  (async-cache idiom, feature spec §7.4).

Validate and Publish are panel toolbar buttons (palette actions have no
terminal helper); Publish runs `doorstop publish all <target>` where the
target comes from the workspace settings file.

The shared types + function-signature contracts live in
`src/doorstop-contract.ts`; later modules import these and must not redefine
them.

## Workspace settings (`.pi-web/opendoor.json`)

Optional per-workspace configuration, read by the plugin on every load
(missing file → defaults; malformed or invalid values → warning diagnostics
in the panel + defaults). Browser-only plugins cannot use pi-web's
`plugins.<id>.settings` config (that is captured for server entries only),
so this file plays the same role `.pi-web/tasks.json` plays for the bundled
workspace-tasks plugin:

```json
{
  "version": 1,
  "publish": { "target": "./public" },
  "discovery": { "excludedDirectories": ["published", "vendor"] }
}
```

- `publish.target` — path passed to `doorstop publish all`. Must be a safe
  workspace-relative path (no `..`, no absolute, no drive prefix). It is
  shell-quoted at the command boundary when it contains characters outside
  the inert `\w./-` alphabet.
- `discovery.excludedDirectories` — additional directory names the
  `.doorstop.yml` walk never enters (merged with the built-in
  `.git`/`node_modules` skips, max 16 names).

## Using the panel

- **Items / Findings toggle** in the toolbar. Findings lists all
  plugin-computed findings and diagnostics (error > warning > info); a
  finding's UID navigates back to the item. Findings are informational —
  run the toolbar **Run validation** button for the authoritative
  `doorstop` output in a workspace terminal.
- **State chips** per item (feature spec §6): inactive, non-normative,
  reviewed / unreviewed changes, suspect links, no child links, no links,
  unknown link, missing reference.
- **Item actions** (detail pane): Review (`doorstop review UID`), Clear
  suspect links (`doorstop clear UID [parents…]`), Edit (`doorstop edit
  UID`), Link/Unlink via inline UID input (validated against the Doorstop
  UID grammar; shell metacharacters rejected).
- **Ask the agent** menu: inserts ready-made prompts (explain, fix suspect
  links, draft child requirement, review readiness) into the session prompt
  editor using the item's paths and state (feature spec §7.3).
- Fingerprints and the requirement state are recomputed in the browser from
  the YAML files; everything mutating goes through the visible `doorstop`
  CLI in a workspace terminal, so all effects stay auditable in git.

## Commands

```sh
npm install        # install dependencies
npm test           # vitest (unit tests under src/**/*.test.ts)
npm run typecheck  # tsc --noEmit (strict)
npm run build      # esbuild bundle → dist/ (also copies package.json manifest)
npm run dev        # watch mode build
```

## Installing the plugin locally (id `opendoor`)

```sh
npm run build
ln -s "$(pwd)/dist" ~/.pi-web/plugins/opendoor
```

Then reload the PI WEB page and verify the plugin is discovered:

```sh
curl -s http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

The manifest should list an `opendoor` plugin entry (`piWeb.plugins` id
`opendoor` in `dist/package.json`).
