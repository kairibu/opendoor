# opendoor — a Doorstop requirements-management plugin for PI WEB

`opendoor` is a **paired** PI WEB plugin that surfaces
[Doorstop](https://github.com/doorstop-dev/doorstop) requirements stored in
the workspace next to the code they trace to: a **Requirements** workspace tab
with the document tree, per-item state (reviewed/unreviewed changes, suspect
links), validation findings, and one-click `doorstop` CLI actions (validate,
publish, add/link/unlink, clear suspect links, review), plus agent prompts
that insert requirement context into the session. When paired, the plugin's
server entry runs the CLI headlessly and the captured output is displayed in
the panel itself (a **status bar** at the bottom); when unpaired, every action
falls back to the workspace terminal. The paired backend also recovers the
reviewed version of an item file from git history, so the item detail pane
can show a **Changes since review** diff — and Review can optionally record
a pathspec-limited review commit (`commitAfterReview`).

Full feature spec: [`docs/feature-doorstop-plugin.md`](docs/feature-doorstop-plugin.md)
(§5 architecture, §6 requirements state model, §7–§8 UI/actions).

## Status

The plugin is fully wired and green, in two halves:

- **Browser entry** (`src/pi-web-plugin.ts`, apiVersion 2, name `Opendoor`)
  delegates to `createOpendoorBrowserContributions` in
  `src/doorstop-contributions.ts`, which contributes:

  - **panel** `workspace.doorstop` (title **Requirements**, order 60) — the Lit
    body element `<pi-web-opendoor-panel-body>`, driven by the per-workspace
    controller registry (`src/doorstop-panel.ts`): five vertical sections —
    `project-actions` (title, Items/Findings toggle, Refresh / Run validation
    / Publish HTML), `item-list` (filters row + item rows with state chips),
    `item-details` (links in/out, references, extended attributes,
    collapsible **Changes since review** diff), `item-action-palette`
    (Review / Clear suspect links / Edit / Link / Unlink / Ask-agent menu,
    sized to the host prompt footer), and `status-bar` (status badge,
    duration, Dismiss button, and the auto-expanding stdout/stderr of the
    latest CLI run, plus the review-commit outcome line when the review
    requested a commit);
  - **actions** `view.doorstop` (mod+7) and `workspace.refresh-doorstop`
    (mod+shift+d);
  - **label** `doorstop-status` — the informational requirement-health counts
    (async-cache idiom, feature spec §7.4).

- **Server entry** (`src/server-plugin.ts`, default export `PiWebServerPlugin`)
  contributes a workspace provider that claims only projects whose root
  contains a `.doorstop.yml` (cheap `fs.access` probe — everything else stays
  with the bundled Git provider) and serves a two-operation backend:
  `doorstop.run` runs one Doorstop CLI invocation — a review request carrying
  the opt-in `commit: true` flag is followed by a pathspec-limited git commit
  of the item file (`doorstop: review <uid>`) — and the read-only
  `doorstop.item-baseline` recovers the reviewed version of an item file from
  git history. `src/doorstop-backend.ts` validates each request, builds argv
  server-side (the browser never sends shell strings), and runs through the
  host's `execFile()` helper with `cwd` = the workspace path, timeouts
  clamped to 8.5 s (the review+git pipeline shares one deadline budget under
  the host's 10 s callback bound), and per-workspace run serialization.

Dispatch (per action, in `src/doorstop-panel-elements.ts`): when the workspace
is opendoor-owned with an active backend, the action sends a structured
request via `context.backend.request("doorstop.run", …)` (the review-commit
flag rides along when the setting is enabled; the "Changes since review"
section fetches via `context.backend.request("doorstop.item-baseline", …)`)
and the captured output appears in the panel's status bar (auto-expanded);
the panel auto-rescans on completion. When the backend is absent (unpaired
install, or a workspace the provider does not own), the action falls back to
`terminal.runCommand()` with the same shell command, so output stays visible
and auditable in the terminal.

The shared types + function-signature contracts live in
`src/doorstop-contract.ts`; the two backend operation contracts
(`doorstop.run` and `doorstop.item-baseline`) shared by both halves live in
`src/doorstop-backend-contract.ts`. Later modules import these and must not
redefine them.

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
  "discovery": { "excludedDirectories": ["published", "vendor"] },
  "commitAfterReview": false
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
- `commitAfterReview` — opt-in boolean (default `false`): when enabled on a
  paired workspace, the **Review** action's `doorstop review <uid>` is
  followed by a pathspec-limited git commit of the item file with the
  conforming message `doorstop: review <uid>` (git `add` then
  `commit -m … -- <path>` — other staged/unstaged work is left untouched).
  Committing user content is strictly opt-in, and the status bar
  narrates every commit outcome (`commit: <sha>` / `clean` (already
  committed) / `skipped` (not a git repository | item file not found |
  review failed | deadline) / `failed` — `<stderr>`). Under the default,
  Review behaves exactly as before.

## Host settings (`plugins.opendoor.settings`)

Optional, server-side only (requires the paired install and a sessiond
restart to take effect). Parsed leniently; wrong types fall back to defaults:

```json
{ "doorstopPath": "/opt/venv/bin/doorstop", "gitPath": "git", "timeoutMs": 8000 }
```

- `doorstopPath` — the Doorstop CLI binary. Defaults to `"doorstop"` resolved
  on the **sessiond host PATH** (the daemon environment, not your login shell
  — set this when the CLI lives in a venv or is not on the service PATH).
- `gitPath` — the git binary used by the review→commit pipeline and the
  `doorstop.item-baseline` fetch. Defaults to `"git"` resolved on the
  **sessiond host PATH** — set it when git is not on the service PATH (the
  same escape hatch as `doorstopPath`).
- `timeoutMs` — per-run exec timeout in ms. May SHORTEN the 8 500 ms default
  but never exceed it (the host bounds every provider callback at 10 s, so a
  longer doorstop run would be killed by pi-web, not by the plugin). It also
  bounds every git exec of the review→commit pipeline and the baseline fetch,
  which share one deadline budget per callback.

## Using the panel

The right-hand panel body is divided into five vertical sections, top to
bottom:

1. **`project-actions`** — the panel title, the **Items / Findings** toggle,
   and the project-scoped buttons **Refresh**, **Run validation**, and
   **Publish HTML**.
2. **`item-list`** — a filters row (document chips, state filter, search)
   above the item rows.
3. **`item-details`** — the selected item's full detail pane (unchanged).
4. **`item-action-palette`** — the item actions (**Review**, **Clear suspect
   links**, **Edit**, **Unlink**/**Link** + target UID inputs, **Ask agent**
   menu), moved out of the detail pane so the row spans the panel at the same
   height as the center-panel chat prompt footer. A muted "Select an item…"
   placeholder keeps the palette at constant height while nothing is
   selected; the palette is hidden in the Findings view.
5. **`status-bar`** — the run status row (badge, duration, **Dismiss**),
   sized like the center-panel status bar, plus the captured output.

- **Items / Findings toggle** in the project-actions row. Findings lists all
  plugin-computed findings and diagnostics (error > warning > info); a
  finding's UID navigates back to the item. Findings are informational — run
  the **Run validation** button for the authoritative `doorstop` output
  (paired: rendered in the panel's status bar; unpaired: in the workspace
  terminal).
- **Status bar**: after a paired action completes, the bottom bar shows the
  run's status (ok / failed / killed / error) and duration, and the panel
  re-scans automatically. The captured stdout/stderr *auto-expands* whenever
  a run produces a message to show (any output, an error message, or a
  review-commit line) — no interaction needed; a run with nothing to display
  stays collapsed to its status row. **Dismiss** clears the run and collapses
  the bar; the next run with output re-expands it. Runs killed at the exec
  timeout preserve and show partial output; prefer the workspace terminal for
  long publishes. When a review ran with `commitAfterReview` enabled, the bar
  adds a `commit: …` narration line (`commit: <short-sha>` /
  `clean (already committed)` / `skipped (not a git repository | item file
  not found | review failed | deadline)` / `failed — <stderr excerpt>`); a
  failed or skipped commit never changes the run's ok/failed badge.
- **State chips** per item (feature spec §6): inactive, non-normative,
  reviewed / unreviewed changes, suspect links, no child links, no links,
  unknown link, missing reference.
- **Changes since review** (item detail pane, paired installs only): for an
  item with unreviewed changes and a stored `reviewed` fingerprint, a
  collapsed section shows what changed since the last review. Expanding it
  lazily fetches the reviewed version of the item file from git history via
  the `doorstop.item-baseline` backend operation, stamp-matches it against
  the stored fingerprint, and renders a text line diff plus chips for
  `ref`/`references`/link-UID/extended-attribute changes. When no baseline
  can be recovered it says so honestly ("no git history", "could not locate
  the reviewed version — history may have been rewritten"). The
  `doorstop: review <uid>` commit message is the historical anchor that the
  deferred browser-side git parsing of feature spec §12 could not give — the
  recovery runs server-side, where git lives.
- **Item actions** (item-action-palette): Review (`doorstop review UID` — with
  `commitAfterReview` enabled and paired, followed by the pathspec-limited
  review commit), Clear suspect links (`doorstop clear UID [parents…]`),
  Edit (`doorstop edit UID`), Link/Unlink via inline UID input (validated
  against the Doorstop UID grammar; shell metacharacters rejected).
- **Ask the agent** menu: inserts ready-made prompts (explain, fix suspect
  links, draft child requirement, review readiness) into the session prompt
  editor using the item's paths and state (feature spec §7.3).
- Fingerprints and the requirement state are recomputed in the browser from
  the YAML files; everything mutating goes through the visible `doorstop`
  CLI — paired, headlessly via the server entry (output captured in the
  panel), or in a workspace terminal when unpaired — plus, opt-in, the
  narrated pathspec-limited review commit (`commitAfterReview`) — so all
  effects stay auditable in git.

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
