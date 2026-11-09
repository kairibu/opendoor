# opendoor — a Doorstop requirements-management plugin for PI WEB

`opendoor` is a PI WEB plugin that surfaces
[Doorstop](https://github.com/doorstop-dev/doorstop) requirements stored in the
workspace in a **Requirements** workspace tab with
the document tree, per-item state (reviewed/unreviewed changes, suspect links),
validation findings and `doorstop` actions, plus agent prompts
that insert requirement context into the session. 
The paired backend also recovers an item file's reviewed version from git for 
the **Changes since review** diff, and Review can opt in to a review commit 
(`commitAfterReview`).

Full feature spec: [`docs/feature-doorstop-plugin.md`](docs/feature-doorstop-plugin.md)
(§5 architecture, §6 requirements state model, §7–§8 UI/actions).

## Installation

Install from npm as a Pi package (requires **pi-web 1.202611.1 or newer**):

```bash
pi install npm:opendoor-plugin
```

or via the UI: **Settings → Pi packages → `npm:opendoor-plugin`**.

After installing, restart `pi-web-sessiond` (server plugins load only on
sessiond restart) and reload the browser tab — the Requirements tab then
appears for any workspace whose root has a `.doorstop.yml`.

## Status

Requires **pi-web 1.202611.1 or newer** (browser and server plugin API v5). 

One package (`opendoor-plugin`) ships the PI WEB plugin (both entries below) 
and the Pi extension (`/opendoor-review`).

- **Browser entry** (`src/browser/pi-web-plugin.ts`, apiVersion 5, name
  `Opendoor`) delegates to `createOpendoorBrowserContributions`
  (`src/browser/doorstop-contributions.ts`): the **panel** `workspace.doorstop`
  (title **Requirements**, order 5 — below the Files panel's order 10 so doorstop
  item links reach its `fileOpenQuery` first, at the cost of the Requirements tab
  preceding Files in the tab order; controller registry in
  `src/browser/doorstop-panel.ts`, sections in **Using the panel**),
  the **actions** `view.doorstop` (mod+7) and `workspace.refresh-doorstop`
  (mod+shift+d), the **label** `doorstop-status` (requirement-health counts,
  feature spec §7.4), and the **session-row label** `doorstop.review` (reopens the
  Requirements tab from a row carrying public `opendoor` metadata, archived rows
  included — feature spec, **Session metadata and session-list row labels**).
- **Server entry** (`src/server-plugin.ts`, apiVersion 5, default export
  `PiWebServerPlugin`) contributes a workspace provider for projects whose root
  has a `.doorstop.yml` (cheap `fs.access` probe; everything else stays with the
  bundled Git provider) and serves six operations: `doorstop.run` (one CLI
  invocation; a review carrying the opt-in `commit: true` flag is followed by a
  pathspec-limited `doorstop: review <uid>` commit), the read-only
  `doorstop.item-baseline` (the reviewed version, from git history), and
  `doorstop.git-status` / `-stage` / `-unstage` / `-commit` (see **Git
  actions**). `src/doorstop-backend.ts` validates each request, builds argv
  server-side (never a browser shell string) and runs it via `execFile()`; see
  its header for timeouts and per-workspace serialization. The entry declares no
  `requires` and no `start()`: the retired `doorstop.ask-agent` dispatch could
  not live there (provider-cycle rule) — see `src/server-plugin.ts`.
- **Pi extension** (`src/pi-extension/opendoor-review.ts`, bundled to
  `dist/pi-extension/index.js`, declared by `pi.extensions`) registers
  `/opendoor-review <UID> [instruction…]`: it publishes the public `opendoor`
  metadata (`{ schema: 1, op: "review", uids }`) and asks PI WEB's per-session
  dispatch bridge to start an independent conversation in the same project (the
  `spawn_session` rules, model/thinking inherited), reporting every outcome in
  the initiating conversation — the pathway **Start review session** drives.

Dispatch (`src/browser/doorstop-panel-element.ts`) uses
`context.peer.request("doorstop.run", …)` (the review-commit flag rides along
when enabled; **Changes since review** uses `doorstop.item-baseline`) with the
output in the auto-expanded status bar, or falls back to `terminal.runCommand()`
with the same shell command when unpaired. Shared types and operation contracts
live in `src/doorstop-contract.ts` and `src/doorstop-backend-contract.ts`.

## Workspace settings (`.pi-web/opendoor.json`)

Optional per-workspace configuration, read on every plugin load (missing file →
defaults; malformed or invalid values → warning diagnostics + defaults). pi-web's
`plugins.<id>.settings` is host-side and reaches only server entries, so this
file plays the role `.pi-web/tasks.json` plays for the bundled workspace-tasks
plugin; server-entry knobs are in **Host settings** below:

```json
{
  "version": 1,
  "publish": { "target": "./public" },
  "discovery": { "excludedDirectories": ["published", "vendor"] },
  "showAdditionalAttribute": ["text", "component"],
  "commitAfterReview": false
}
```

- `publish.target` — path passed to `doorstop publish all`; must be a safe
  workspace-relative path (no `..`, no absolute, no drive prefix, no leading
  `-`). Shell-quoted at the terminal-command boundary when it contains characters
  outside the inert `\w./-` alphabet; on the backend path it is an argv element,
  never a shell string.
- `discovery.excludedDirectories` — additional directory names the
  `.doorstop.yml` walk never enters (merged with the built-in
  `.git`/`node_modules` skips, max 16 names).
- `showAdditionalAttribute` — attribute NAMES rendered in every item-list row as
  `key: value` (values jsonish-quoted, joined with ` · `, in configured order);
  any extended attribute key works, an attribute an item lacks is skipped, and no
  unconfigured attribute ever appears. The modeled `text` is special-cased: the
  body renders raw and unquoted on an indented second line below the row, clamped
  to two lines with an ellipsis (the full body lives in the detail pane), skipped
  when empty. Default `[]` leaves today's rows unchanged. Invalid entries are
  dropped with a warning each, duplicates deduplicated, capped at 16 names;
  unknown keys simply match nothing.
- `commitAfterReview` — opt-in boolean (default `false`): on a paired workspace
  the **Review** action's `doorstop review <uid>` is followed by a
  pathspec-limited commit of the item file with the conforming message
  `doorstop: review <uid>` (git `add` then `commit -m … -- <path>`; other
  staged/unstaged work is untouched). Committing user content is strictly opt-in;
  the status bar narrates every outcome (`commit: <sha>` / `clean` (already
  committed) / `skipped` (not a git repository | item file not found | review
  failed | deadline) / `failed` — `<stderr>`); Review is otherwise unchanged.

## Host settings (`plugins.opendoor.settings`)

Optional, server-side only (needs the paired install and a sessiond restart);
wrong types fall back to defaults:

```json
{ "doorstopPath": "/opt/venv/bin/doorstop", "gitPath": "git", "timeoutMs": 8000 }
```

- `doorstopPath` — the Doorstop CLI binary, default `"doorstop"`, resolved on the
  **sessiond host PATH** (the daemon environment, not your login shell — set it
  when the CLI lives in a venv or is off the service PATH).
- `gitPath` — the git binary for the review→commit pipeline, the
  `doorstop.item-baseline` fetch and the four git actions. Default `"git"` on the
  **sessiond host PATH** — the same escape hatch as `doorstopPath`.
- `timeoutMs` — per-run exec timeout in ms. May SHORTEN the 8 500 ms default but
  never exceed it (the host bounds every provider callback at 10 s, so a longer run
  would be killed by pi-web, not by the plugin). It also bounds every git exec of
  the review→commit pipeline, the `doorstop.item-baseline` fetch and the git
  actions: one deadline budget per callback.

## Using the panel

Five vertical sections, top to bottom: `project-actions` (project heading — root
path, basename shown, full path on hover — the Items/Findings toggle, Refresh, Run
validation, Publish HTML, and on paired installs the Git strip, Stage all and
Commit), `item-list` (filters row above rows showing level, UID, excerpt,
`showAdditionalAttribute` values and state chips), `item-details` (Markdown item
text, links in/out, references, extended attributes, the Changes diff),
`item-action-palette` (Review, Clear suspect links, Link, Ask agent — spanning the
panel at chat-prompt-footer height, with the muted "Select an item…" placeholder,
hidden in the Findings view) and `status-bar` (see below).

- **Items / Findings toggle**: Findings lists plugin-computed findings and
  diagnostics (error > warning > info), and a finding's UID navigates back to the
  item. They are informational — **Run validation** gives the authoritative
  `doorstop` output (paired: status bar; unpaired: terminal).
- **Status bar** (sized like the center-panel one): after a paired action it shows
  status (ok / failed / killed / error) and duration, and the panel re-scans
  automatically. Captured stdout/stderr *auto-expands* whenever there is something
  to show (output, an error, a review-commit line); a run with nothing to display
  stays collapsed. **Dismiss** clears the run and collapses the bar; the next run
  with output re-expands it. Killed runs keep partial output (prefer the terminal
  for long publishes). With `commitAfterReview` on, the bar adds the `commit: …`
  line from **Workspace settings**; a failed or skipped commit never changes the
  run's ok/failed badge.
- **State chips** per item (feature spec §6): inactive, non-normative, reviewed /
  unreviewed changes, suspect links, no child links, no links, unknown link,
  missing reference.
- **Changes since review** (item detail pane, paired installs only): an item with
  unreviewed changes and a stored `reviewed` fingerprint gets a collapsed section;
  expanding it fetches the reviewed item file from git history via
  `doorstop.item-baseline`, stamp-matches it against the fingerprint and renders a
  line diff plus chips for `ref`/`references`/link-UID/extended-attribute changes.
  With no recoverable baseline it says so ("no git history", "could not locate the
  reviewed version — history may have been rewritten"). The `doorstop: review
  <uid>` message is the historical anchor feature spec §12's deferred browser-side
  git parsing could not give; recovery runs server-side.
- **Item actions** (item-action-palette): Review (`doorstop review UID`, plus the
  review commit when `commitAfterReview` is on), Clear suspect links (`doorstop
  clear UID [parents…]`), Edit (`doorstop edit UID`), Link/Unlink via inline UID
  input (Doorstop UID grammar enforced; shell metacharacters rejected), and on
  paired installs Stage / Unstage for the item's own file (`doorstop.git-stage` /
  `doorstop.git-unstage`; see **Git actions**). Each disables independently: Stage
  without unstaged (`Y`) changes, Unstage with nothing staged (`X`), both mid-run.
- **Git actions** (paired only; otherwise every git control is hidden and you
  commit manually):
  - **Git status strip** — compact readout above the item list:
    `⎇ <branch> · <n> staged · <n> dirty · ↑<ahead> ↓<behind>` (zero/absent parts
    omitted, `no git` outside a repository, a retry link on fetch errors).
    Refreshes on panel load, after every run (a stage, unstage or commit
    invalidates the cache) and on click; outside a repository the other git
    controls report `skipped`.
  - **Stage all** — stages every Doorstop-managed file (root `.doorstop.yml`, each
    document config, each item file) via `doorstop.git-stage`. Idempotent: a
    second click over an already-staged set reports `clean — nothing to stage`
    instead of a git error (staged deletions are skipped, not fatal). Disabled
    during a run or with no documents in the loaded index, and only as fresh as
    that index — files created after the last **Refresh** are missed until you
    refresh and stage again.
  - **Unstage (per item)** — a staged item file swaps its row's plus for a
    **minus** and enables **Unstage** in the palette, both via
    `doorstop.git-unstage` (`git reset -q -- :(literal)<path>` server-side). A file
    both staged and further modified (`MM`) still shows the minus; the palette then
    offers Stage and Unstage as two independently-disabled buttons. Unstaging
    restores the index entry but never touches the working tree (a staged addition
    returns to `??`, a staged deletion to an unstaged deletion); it is idempotent
    (`clean — nothing to unstage`) and excludes unmerged paths (`UU`, `AA`, `DD`,
    `DU`, `AU`, `UD`, `UA`), where `git reset` would silently resolve the conflict.
    During a run no minus appears and the palette buttons are disabled; the per-row
    affordance is also suppressed when the status file list is truncated, so stale
    path data is never acted on.
  - **Git commit** — a message input plus **Commit**, served by
    `doorstop.git-commit`. It records **the staged index** (`git commit -m
    <message>`, no pathspec, no add), exactly like the git CLI: unstaged WIP is
    never swept in, files you staged yourself are included, and the strip's
    `staged` count shows what a commit will record. Empty or whitespace-only
    messages are rejected client-side (git would open an editor and hang the exec);
    nothing staged reports `clean — nothing staged`. Outcomes are narrated in the
    status bar (`staged <n> paths` / `committed <sha>` / `clean — nothing to stage`
    / `clean — nothing staged` / `skipped` / `failed — <stderr excerpt>`), including
    a failing pre-commit hook's stderr.
- **Ask the agent** menu: inserts ready-made prompts (explain, fix suspect links,
  draft child requirement, review readiness) into the session prompt editor from
  the item's paths and state (feature spec §7.3). **Start review session**
  composes `/opendoor-review <UID>` plus the item context there and needs no
  paired backend: the extension starts an independent review conversation whose
  row carries a **`firstUid +n` label** reopening the Requirements tab on that
  workspace (unselected and archived rows included, no live Pi connection needed),
  landing on the item detail pane. After the insert the status bar shows a quiet
  `ok` **review dispatch** run row. Without the extension the inserted text is
  still a self-sufficient review instruction, so the review happens in the current
  conversation; a refused dispatch is reported in the chat by the extension (see
  **Session metadata and session-list row labels** in the feature spec).
- Fingerprints and requirement state are recomputed in the browser from the YAML
  files; everything mutating goes through the visible `doorstop` CLI — paired,
  headlessly via the server entry, or in a workspace terminal when unpaired —
  plus, opt-in, the narrated review commit (`commitAfterReview`) — so all effects
  stay auditable in git.


## Commands

```sh
npm install            # install dependencies
npm test               # vitest (unit tests under src/**/*.test.ts)
npm run test:coverage  # v8 coverage report
npm run typecheck      # tsc --noEmit (strict)
npm run build          # esbuild → dist/browser, dist/server, dist/pi-extension
                       # + the dist-root manifest (see the build script header)
npm run dev            # watch build
```

## Installing the plugin locally (id `opendoor`)

The package carries two independently enabled halves: the **PI WEB plugin**
(browser + server entries) and the **Pi extension** (`/opendoor-review`). The
repository-root `package.json` is the npm-package-root manifest, so both halves
come from ONE install through **Settings → Pi packages** (npm name, git/URL or a
local source); the `ln -s dist` route below remains for plugin-only development.

### PI WEB plugin (browser + server entries)

Install the package once — **Settings → Pi packages** with source
`opendoor-plugin` (or this repository's path / git URL) — then enable
**Opendoor** under **Settings → PI WEB plugins**. Plugin-only local build:

```sh
npm run build
ln -s "$(pwd)/dist" ~/.pi-web/plugins/opendoor
```

Then **restart the session daemon** (server entries load at sessiond startup
only; the browser bundle hot-reloads on page reload) and reload the page:

```sh
systemctl --user restart pi-web-sessiond.service
curl -s http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

The manifest should list an `opendoor` entry **with a `backendRevision`** (signing
the paired server module); if it is missing, the server module failed to load
(check the sessiond log) and the plugin works fully via the terminal fallback.

### Review dispatch (Pi extension)

Installing the package loads the extension; enabling the PI WEB plugin is a
separate decision. After installing or updating the package, run `/reload` in
each idle conversation so `/opendoor-review` is registered there (an ordinary
Pi-resource change — no provider restart). The extension needs PI WEB's
session-dispatch bridge (1.202610.x); on an older host it reports "requires PI
WEB's session dispatch bridge" and starts nothing.

