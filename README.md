# opendoor — a Doorstop requirements-management plugin for PI WEB

`opendoor` is a **paired** PI WEB plugin that surfaces
[Doorstop](https://github.com/doorstop-dev/doorstop) requirements stored in
the workspace next to the code they trace to: a **Requirements** workspace tab
with the document tree, per-item state (reviewed/unreviewed changes, suspect
links), validation findings, and one-click `doorstop` CLI actions (validate,
publish, add/link/unlink, clear suspect links, review), plus agent prompts
that insert requirement context into the session. When paired, the plugin's
server entry runs the CLI headlessly and the captured output is displayed in
the panel itself (a **Last run** section); when unpaired, every action falls
back to the workspace terminal.

Full feature spec: [`docs/feature-doorstop-plugin.md`](docs/feature-doorstop-plugin.md)
(§5 architecture, §6 requirements state model, §7–§8 UI/actions).

## Status

The plugin is fully wired and green, in two halves:

- **Browser entry** (`src/pi-web-plugin.ts`, apiVersion 2, name `Opendoor`)
  delegates to `createOpendoorBrowserContributions` in
  `src/doorstop-contributions.ts`, which contributes:

  - **panel** `workspace.doorstop` (title **Requirements**, order 60) — the Lit
    body element `<pi-web-opendoor-panel-body>`, driven by the per-workspace
    controller registry (`src/doorstop-panel.ts`): document tree, item list
    with state chips, item detail pane (links in/out, references, extended
    attributes, per-item actions), findings sub-view, ask-agent menu, and the
    **Last run** section (status badge, duration, dismissable stdout/stderr
    of the latest CLI run);
  - **actions** `view.doorstop` (mod+7) and `workspace.refresh-doorstop`
    (mod+shift+d);
  - **label** `doorstop-status` — the informational requirement-health counts
    (async-cache idiom, feature spec §7.4).

- **Server entry** (`src/server-plugin.ts`, default export `PiWebServerPlugin`)
  contributes a workspace provider that claims only projects whose root
  contains a `.doorstop.yml` (cheap `fs.access` probe — everything else stays
  with the bundled Git provider) and serves a `doorstop.run` backend:
  `src/doorstop-backend.ts` validates the request, builds argv server-side
  (the browser never sends shell strings), and runs the Doorstop CLI through
  the host's `execFile()` helper with `cwd` = the workspace path, a timeout
  clamped to 8.5 s, and per-workspace run serialization.

Dispatch (per action, in `src/doorstop-panel-elements.ts`): when the workspace
is opendoor-owned with an active backend, the action sends a structured
request via `context.backend.request("doorstop.run", …)` and the captured
output appears in the panel's Last run section; the panel auto-rescans on
completion. When the backend is absent (unpaired install, or a workspace the
provider does not own), the action falls back to `terminal.runCommand()` with
the same shell command, so output stays visible and auditable in the
terminal.

The shared types + function-signature contracts live in
`src/doorstop-contract.ts`; the `doorstop.run` operation contract shared by
both halves lives in `src/doorstop-backend-contract.ts`. Later modules import
these and must not redefine them.

## Workspace settings (`.pi-web/opendoor.json`)

Optional per-workspace configuration, read by the plugin on every load
(missing file → defaults; malformed or invalid values → warning diagnostics
in the panel + defaults). Workspace-scoped settings cannot use pi-web's
`plugins.<id>.settings` config (that is host-side and only reaches server
entries), so this file plays the same role `.pi-web/tasks.json` plays for the
bundled workspace-tasks plugin. The *server* entry's host-scoped knobs
(CLI binary path, exec timeout) are configured through
`plugins.opendoor.settings` instead — see **Host settings** below:

```json
{
  "version": 1,
  "publish": { "target": "./public" },
  "discovery": { "excludedDirectories": ["published", "vendor"] }
}
```

- `publish.target` — path passed to `doorstop publish all`. Must be a safe
  workspace-relative path (no `..`, no absolute, no drive prefix, no leading
  `-`). It is shell-quoted at the terminal-command boundary when it contains
  characters outside the inert `\w./-` alphabet; on the backend path the
  target is passed as an argv element, never through a shell.
- `discovery.excludedDirectories` — additional directory names the
  `.doorstop.yml` walk never enters (merged with the built-in
  `.git`/`node_modules` skips, max 16 names).

## Host settings (`plugins.opendoor.settings`)

Optional, server-side only (requires the paired install and a sessiond
restart to take effect). Parsed leniently; wrong types fall back to defaults:

```json
{ "doorstopPath": "/opt/venv/bin/doorstop", "timeoutMs": 8000 }
```

- `doorstopPath` — the Doorstop CLI binary. Defaults to `"doorstop"` resolved
  on the **sessiond host PATH** (the daemon environment, not your login shell
  — set this when the CLI lives in a venv or is not on the service PATH).
- `timeoutMs` — per-run exec timeout in ms. May SHORTEN the 8 500 ms default
  but never exceed it (the host bounds every provider callback at 10 s, so a
  longer doorstop run would be killed by pi-web, not by the plugin).

## Using the panel

- **Items / Findings toggle** in the toolbar. Findings lists all
  plugin-computed findings and diagnostics (error > warning > info); a
  finding's UID navigates back to the item. Findings are informational — run
  the toolbar **Run validation** button for the authoritative `doorstop`
  output (paired: rendered in the panel's Last run section; unpaired: in the
  workspace terminal).
- **Last run** section: after a paired action completes, the pane shows the
  run's status (ok / failed / killed / error), duration, and captured
  stdout/stderr, and the panel re-scans automatically. Runs are killed at the
  exec timeout (partial output preserved and shown); prefer the workspace
  terminal for long publishes.
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
  CLI — paired, headlessly via the server entry (output captured in the
  panel), or in a workspace terminal when unpaired — so all effects stay
  auditable in git.

## Commands

```sh
npm install        # install dependencies
npm test           # vitest (unit tests under src/**/*.test.ts)
npm run typecheck  # tsc --noEmit (strict)
npm run build      # esbuild: dist/browser/pi-web-plugin.js + dist/server-plugin.js
                   # (+ verbatim package.json manifest copy into dist/)
npm run dev        # watch mode build
```

## Installing the plugin locally (id `opendoor`)

```sh
npm run build
ln -s "$(pwd)/dist" ~/.pi-web/plugins/opendoor
```

Then **restart the session daemon** (server entries load at sessiond startup
only; the browser bundle hot-reloads on page reload) and reload the PI WEB
page:

```sh
systemctl --user restart pi-web-sessiond.service
curl -s http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

The manifest should list an `opendoor` plugin entry **with a
`backendRevision`** (signing the paired server module). If `backendRevision`
is missing, the server module failed to load — check the sessiond log; the
plugin still works fully via the terminal fallback.
