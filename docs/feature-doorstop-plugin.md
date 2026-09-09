# Feature: `opendoor` — a Doorstop requirements-management plugin for PI WEB

Status: proposal / feature description
Prior art: `../opense-package` (OpenSE SysML plugin), PI WEB bundled `git` and `workspace-tasks` plugins

## 1. Summary

`opendoor` is a PI WEB plugin that surfaces [Doorstop](https://github.com/doorstop-dev/doorstop)
requirements stored in the workspace alongside the code they trace to. It adds a
**Requirements** workspace tab that presents the Doorstop document tree, its items,
and each item's state — active/normative, reviewed vs. unreviewed changes, and
(suspect) links — plus panel and palette actions that trigger Doorstop's
operations: **validate**, **publish**, **create/add items**, **link/unlink**,
**clear suspect links**, and **review**.

Because PI WEB is an agent harness, the plugin's second half is **agent
integration**: every item carries one-click prompts ("explain this requirement",
"fix suspect links", "draft the missing child requirement") that insert
requirement context into the session prompt editor, so the AI agent can read,
critique, and repair the requirements with the same tooling it uses for code.

## 2. Background

### Doorstop

Doorstop stores requirements in version control next to source code:

- Each linkable item is one YAML file (`REQ001.yml`, default format) or a
  markdown file with YAML frontmatter (`REQ001.md`, `itemformat: markdown`).
  The UID is the file name without extension.
- A directory of items plus a `.doorstop.yml` forms a **document** (prefix,
  digits, separator, parent prefix, defaults, publish/reviewed attribute config).
- Documents referencing each other via `parent:` in `.doorstop.yml` form the
  **tree** (e.g. `REQ ← [TST ← [HLT], LLT]`).
- Key item attributes: `active`, `derived`, `normative`, `level`, `header`,
  `text`, `links` (list of parent UID → fingerprint), `references`/`ref`
  (external file references), `reviewed` (the item's fingerprint at last
  review), plus arbitrary extended attributes.
- **State concepts the plugin must present:**
  - *Reviewed / unreviewed changes*: an item's current fingerprint (SHA256 over
    UID, text, ref, references, link UIDs, configured extended reviewed
    attributes, URL-safe Base64) compared to the stored `reviewed` value.
  - *Suspect links*: a link records the parent item's fingerprint at review
    time; if the parent's current fingerprint differs, the link is suspect —
    the parent changed since the child last agreed with it.
  - *Traceability warnings* (from `doorstop` validation): item with no links
    from a child document, normative non-derived item with no links, empty
    text, skipped/duplicate levels, inactive/non-normative link targets,
    unknown link UIDs, missing external references, link cycles.
- **Operations** (all available as CLI commands, runnable via `doorstop …` in
  the workspace): `create`, `add`, `edit`, `link`, `unlink`, `clear` (clear
  suspect links by re-recording the parent fingerprint), `review` (mark item
  reviewed by storing its current fingerprint), `reorder`, `import`, `export`,
  `publish` (HTML/LaTeX/Markdown/Text), and plain `doorstop` = validate the
  tree. Doorstop also offers a Python API and a `doorstop-server` web app, but
  the CLI is the lowest-friction integration surface for a plugin.

### PI WEB plugin capabilities used

PI WEB browser plugins (API v2) provide exactly the surfaces this feature
needs:

- `workspacePanels` — a **Requirements** tab next to Files/Terminal/Git.
- `actions` — action-palette entries with shortcuts.
- `context.files` — `readFile` / `listFiles` for discovery and parsing of
  `.doorstop.yml` and item files entirely in the browser.
- `context.terminal.runCommand()` — run `doorstop` CLI commands in a workspace
  terminal with visible output (the same pattern the bundled
  **Workspace Tasks** plugin uses for `npm run dev`-style commands).
- `context.prompt.insertText()` — push requirement context into the agent
  prompt editor.
- `host.requestRender()`, `onInvalidate`, `badge` — async loading and
  invalidation, as established by OpenSE.

### Prior art: OpenSE (`../opense-package`)

OpenSE already proves the shape this plugin follows; `opendoor` copies its
architecture with different discovery/parsing:

- Browser entry `pi-web-plugin.ts` default-exports the `PiWebPlugin` descriptor
  (`apiVersion: 2`); a contributions factory returns actions + one workspace
  panel.
- Panel UI is Lit custom elements (`<pi-web-…>`) driven by a per-workspace
  controller registry (LRU-bounded, one controller per machine+project+
  workspace key); the host template mirrors controller state into reactive
  element properties.
- Discovery → bounded concurrent file reads → parse → index → outline/report
  is a single in-browser job with `context.files` as the only boundary, which
  makes the whole pipeline unit-testable with a fake files adapter (vitest).
- Build with the exact transpiler settings of pi-web's own plugin build
  (`scripts/build-plugin.mjs`), symlink `dist/` into `~/.pi-web/plugins/`,
  manifest via `piWeb.plugins` in `package.json`.

## 3. Goals

1. Present the workspace's Doorstop tree (documents and items) in a dedicated
   PI WEB workspace tab with per-item state, without leaving the browser page.
2. Make requirement health visible at a glance: workspace-label badge with
   suspect-link / unreviewed-change counts; per-item state chips; a
   validation-findings view mirroring `doorstop`'s INFO/WARNING/ERROR model.
3. Offer one-click **panel actions** for the Doorstop operations that make
   sense in a UI: Validate, Publish, Add item, Link items, Unlink, Clear
   suspect links, Review item — each running the corresponding `doorstop` CLI
   command in a workspace terminal so output, and any VCS effects, stay
   visible and auditable.
4. Support the agent workflow: insert item text, UID, links, and findings into
   the prompt editor with ready-made task prompts.
5. Be a browser-only plugin: no server entry, no workspace-provider claim, no
   session-daemon restart to install or update.

## 4. Non-goals (v1)

- **No in-browser editing of requirement files.** Mutating requirement YAML is
  delegated to the `doorstop` CLI (which handles numbering, fingerprints, and
  formatting) or to the agent via prompts; the panel itself is read-only.
- **No re-implementation of full Doorstop validation.** The plugin computes
  the cheap, display-relevant state (reviewed/suspect) itself for instant UI,
  but *authoritative* validation is `doorstop` run in the terminal. The
  findings view renders CLI output plus plugin-local checks, clearly labeled.
- **No server entry / `backend.request()` backend.** That contract requires
  claiming the workspace as its workspace provider, which would compete with
  bundled Git and change workspace semantics for every project. Not worth it
  for v1 (see §9 Risks).
- **No editing of published output, no ReqIF import/export UI** (CLI covers it).
- **No markdown itemformat in v1** if it proves costly; YAML-format items are
  the baseline, markdown-with-frontmatter items are parsed if present
  (they are cheap: front matter is YAML, header/text come from the body).

## 5. Architecture

```
┌────────────────────────── browser (PI WEB page) ─────────────────────────┐
│ pi-web-plugin.ts      default export { apiVersion: 2, activate }          │
│   └─ contributions: actions + workspacePanels + workspaceLabels           │
│ doorstop-panel.ts      controller registry (per workspace, LRU 8)         │
│   ├─ doorstop-discovery.ts   find .doorstop.yml files (bounded walk)      │
│   ├─ doorstop-model.ts       parse configs + item YAML → tree/index       │
│   ├─ doorstop-state.ts       fingerprints, suspect links, local findings  │
│   ├─ doorstop-prompts.ts     prompt builders for the action palette       │
│   └─ doorstop-elements.ts    Lit elements: tree, item list, detail, run   │
└───────────────────────────────────────────────────────────────────────────┘
        │ context.files (read)                │ context.terminal.runCommand
        ▼                                     ▼
  workspace *.yml/*.md              `doorstop validate|publish|add|link|…`
```

- **Browser-only** (browserRoot + module, no serverModule), id `opendoor`,
  installed as a symlinked local plugin or Pi package like OpenSE.
- Discovery finds every `.doorstop.yml` in the workspace (excluding `.git`,
  `node_modules`, published output dirs), reads each config to learn prefix,
  parent prefix, itemformat, and the document's item directory.
- Item files are read concurrently (bounded, like OpenSE's discovery walk) and
  parsed with a small YAML-frontmatter/item parser (a vendored minimal YAML
  subset parser or a committed browser bundle — decision point in §9).
- The model index maps UID → item, prefix → document, builds parent/child link
  maps, and computes per-item state (§6).
- Mutating operations run `doorstop …` through `terminal.runCommand()` with a
  title like "Doorstop: add item to REQ"; `open: false` keeps the current view,
  the run handle lets the panel show a spinner and, on completion, trigger
  `onInvalidate`-style re-discovery (poll the handle or re-scan on focus).

## 6. Requirements state model (per item)

| State chip | Meaning | Computed from |
| --- | --- | --- |
| **normative / info** | `normative: true/false` | attribute |
| **inactive** | `active: false` (excluded from validation/publish) | attribute |
| **reviewed** | current fingerprint == `reviewed` | recomputed SHA256 stamp vs. stored value |
| **unreviewed changes** | fingerprint differs (or `reviewed: null`) | same |
| **suspect link(s)** | any link whose recorded parent fingerprint ≠ parent's current fingerprint | cross-item index lookup |
| **no child links** | document has child docs, item has no incoming links | tree index |
| **no links** | normative, non-derived, not top-level, `links: []` | tree index |
| **unknown link** | link target UID not in index | tree index |
| **missing reference** | `ref`/`references` path not found among workspace files | discovery index (best effort; `doorstop validate` is authoritative) |

The fingerprint function must reproduce Doorstop's `Item.stamp()` exactly:
SHA-256 over `[uid, text, ref, references?, link UIDs…, extended reviewed
attrs…]` serialized as Doorstop's `Stamp` does, URL-safe Base64. This is the
one genuinely fiddly piece; it gets fixture tests generated from a real
Doorstop checkout (see §9 Risks).

Suspect-link detection needs **no crypto** beyond that stamp: it is a plain
comparison of the recorded link fingerprint against the linked item's current
stamp, exactly what `doorstop`'s "suspect link" warning does.

## 7. User interface

### 7.1 Workspace tab: **Requirements** (`<runtimePluginId>:workspace.doorstop`)

Layout follows OpenSE/git-panel conventions (`toolbar`, `viewer`, `empty`,
`muted` classes), three regions. Regions 2–3 stack vertically, mirroring the
OpenSE split (item list above, detail below):

1. **Document tree strip** — `REQ ← [TST, LLT]` rendered as chips/breadcrumb;
   selecting a document filters the item list. Document chips show count and
   aggregate state dots (green / suspect / unreviewed).
2. **Item list (top pane)** — items of the selected document in `level` order:
   `level  UID  header/text-excerpt  [state chips]`. Rows are clickable.
   A filter row offers state filters (suspect only, unreviewed only, search
   over UID/text). `badge` on the tab shows the workspace-wide suspect +
   unreviewed counts.
3. **Item detail pane (bottom)** — for the selected item:
   - UID, level, header, full `text` (rendered as sanitized markdown), active/
     normative/derived flags, extended attributes table.
   - **Links out** (parents): UID + suspect/ok state + link fingerprint
     recorded vs. current; clickable to navigate.
   - **Links in** (children): computed reverse links; clickable.
   - **References**: resolved file path (linkable into Files via prompt
     mention or path display), or "not found" state.
   - **Action row** for the item: *Review*, *Clear suspect links*, *Edit*
     (`doorstop edit`), *Unlink…*, plus a prompt-menu (§7.3).
   - **Local findings** for this item (plugin-computed, labeled as such).

Empty states: no `.doorstop.yml` found ("this workspace has no Doorstop
documents — `doorstop create REQ ./reqs` to start"), parse errors per file
attributed and non-fatal, mirroring OpenSE's diagnostics discipline. When a
workspace has no parsed documents but diagnostics exist (e.g. a lone document
whose config fails to parse), the warning strip still renders above the empty
state — diagnostics are never silently dropped.

### 7.2 Validation view

A toggle in the tab (or sub-view) shows **Findings**: the plugin's locally
computed findings list (item, severity, message) with a prominent
**Run `doorstop` validation** button. That button runs plain `doorstop`
(matching the action table in §8; a `--strict` variant can be a later
option) in a workspace terminal; the authoritative CLI output remains in the terminal
(v1 does not scrape it), and the plugin's own findings re-compute afterwards.
Severity coloring follows Doorstop: INFO / WARNING / ERROR.

### 7.3 Agent prompts (distinctive to PI WEB)

Every item detail view has a **Ask the agent** menu that inserts a prepared
prompt into the session prompt editor via `context.prompt.insertText()` +
`focusPrompt()`, e.g.:

- *Explain* — "Read `reqs/srd/REQ002.yml` (doorstop requirement REQ002) and
  explain what it requires and why it links to REQ001."
- *Fix suspect links* — "REQ004 has suspect links to REQ001/REQ002 (the parent
  requirements changed after review). Compare texts and propose updated child
  text, then run `doorstop clear REQ004` …"
- *Draft child requirement* — "Draft a new TST item tracing to REQ003, run
  `doorstop add TST`, link it with `doorstop link TST00X REQ003`, and fill the
  text."
- *Review readiness* — "Check REQ005 against its child links and references
  and tell me if it is ready for `doorstop review`."

Builders live in a pure module (`doorstop-prompts.ts`) like OpenSE's
`opense-prompts.ts` and are unit-tested.

### 7.4 Workspace labels

A compact label (e.g. `REQ 42 · ⚠3 suspect · ✎5 unreviewed`) in the workspace
list / status bar via a `workspaceLabels` contribution, async-cached per the
documented label pattern (synchronous `items()` + `host.requestRender()`).

## 8. Actions

### Palette actions (app-level)

| Action id | Title | Shortcut | Behavior |
| --- | --- | --- | --- |
| `view.doorstop` | Go to Requirements | `mod+7` (collision-checked at implementation time, like OpenSE did) | open the panel |
| `workspace.refresh-doorstop` | Refresh Requirements | `mod+shift+d` | re-run discovery + parse |

Validate and Publish are **panel toolbar buttons**, not palette actions:
palette actions receive `PluginRuntimeContext`, which has no terminal helper,
so they cannot run `doorstop` commands; the panel's `WorkspacePanelContext`
can (and does, via `terminal.runCommand()`).

Item-scoped operations live in the panel (they need a selected item), not the
palette: *Add item* (`doorstop add <PREFIX>`), *Link…* (two-UID picker →
`doorstop link CHILD PARENT`), *Unlink*, *Clear suspect links*
(`doorstop clear UID [PARENT…]`), *Review* (`doorstop review UID`), *Edit*
(`doorstop edit UID`). Each runs in a named workspace terminal via
`terminal.runCommand()` with `metadata: { "opendoor.op": "link" }` so runs are
identifiable; after completion the panel re-scans and re-renders.

`enabled`/`disabledReason` on palette actions hide/disable Doorstop operations
when discovery found no documents, with a reason string ("no Doorstop documents
in this workspace").

## 9. Risks and decisions

1. **Fingerprint fidelity.** The browser stamp must match `Item.stamp()`
   byte-for-byte, including `Text`/`Stamp` normalization and extended-reviewed
   attribute serialization. *Mitigation:* port the ~60-line serialization,
   generate fixtures from the Doorstop test suite (`doorstop/core/tests`
   items), and compare in vitest; surface a "state may be stale" notice when a
   document uses `itemformat: markdown` or exotic extended reviewed attributes
   the parser can't fully model.
2. **YAML parsing in the browser.** Item files use a small YAML subset (block
   scalars, lists, one-level maps) but users can write anything. *Decision
   point:* vendor `js-yaml` as an esbuild bundle (proven, ~40 KB) vs. a
   hand-rolled subset parser. Recommendation: vendor js-yaml; OpenSE already
   established the committed-browser-bundle pattern, and correctness beats
   bundle size here.
3. **Command results are not parsed (v1).** `terminal.runCommand` gives a run
   handle, not structured output; the panel re-scans files after completion
   instead of trusting CLI output. Structured parsing (or a future server
   entry) is deferred.
4. **Stale UI while CLI mutates files.** Terminal runs may change items while
   the panel shows cached state; the controller marks results stale (OpenSE
   already has the stale flag idiom) and invalidates on terminal completion
   and `onInvalidate`.
5. **Shortcut collisions.** `mod+7`/`mod+shift+d` must be checked against the
   current core/git/opense keybinding map at implementation time (documented
   in code comments like OpenSE's risk note).
6. **Not a workspace provider.** A server entry would have to claim the
   project to get `backend.request()`, suppressing fallback Git semantics —
   rejected for v1. If structured backend operations are wanted later (e.g.
   returning validation findings as JSON), the clean path is a *separate*
   provider plugin decision, not a bolt-on.

## 10. Packaging, build, test

Mirror `opense-package` exactly:

- `package.json`: `piWeb.plugins: [{ id: "opendoor", browserRoot: ".",
  module: "pi-web-plugin.js" }]` (the build script copies the root
  `package.json` verbatim into `dist/`, so `browserRoot: "."` refers to the
  dist root at discovery time), dependency `lit`, peerDependency
  `@jmfederico/pi-web`, devDependency for type-only imports of
  `@jmfederico/pi-web/plugin-api`.
- `scripts/build-plugin.mjs` with pi-web's exact transpiler settings →
  `dist/`; `npm run dev` watch; `npm test` (vitest + happy-dom);
  `npm run typecheck`.
- Tests: discovery, model/index, state (incl. fingerprint fixtures), prompts,
  panel elements, plugin entry — the OpenSE test taxonomy.
- Install: `ln -s ./dist ~/.pi-web/plugins/opendoor`, reload page; verify via
  `/pi-web-plugins/manifest.json`.
- Keep package ≤ 4,096 entries / 16 MiB (vendor bundle is the main mass).

## 11. Milestones

Status: **M1–M5 shipped** (265 unit tests green; see the repository README
for what shipped). M6 remains optional future work.
1. **M1 — Skeleton + discovery + tree view.** Plugin loads; documents and
   items listed read-only; empty/error states.
2. **M2 — State engine.** Fingerprints (with fixtures), suspect links,
   reviewed/changed chips, badges, workspace label.
3. **M3 — Terminal actions.** Validate, Publish, Add, Link/Unlink, Clear,
   Review, Edit wired through `terminal.runCommand` with post-run rescan.
4. **M4 — Agent prompts.** Prompt builders + detail-pane menu; prompt tests.
5. **M5 — Polish.** Findings view, filters, markdown itemformat support,
   settings (publish target, excluded dirs), documentation.
6. **M6 (optional) — Git change highlighting.** Overlay working-tree git
   state onto items; see §12.

## 12. Optional: Git-based change highlighting (post-v1)

Status: optional, deferred until after M5. Browser-only, no server entry.

Because a Doorstop UID is its file name, "changed requirement" maps to
"changed file", and git state can be obtained entirely in the browser.

### Detection (worktree vs. index)

1. Read `.git/index` (handle `gitdir:` indirection for worktrees, skip
   extensions; v2/v3 baseline, v4 prefix compression and SHA-256 repos as
   optional extras) — a documented binary format, ~100–150 lines of TS.
2. Hash each working-tree item file with `crypto.subtle`.
3. Compare → per-file state: **unmodified / modified / untracked** (path not
   in index), plus assume-valid/skip-worktree bits honored where cheap.

No zlib and no object database needed. Going deeper (worktree vs. HEAD via
loose/packed refs + native `DecompressionStream('deflate')`) is explicitly
out of scope for M6; vendor isomorphic-git's read paths if ever wanted.

### Semantic overlay on the §6 state model

| Git state | Doorstop state | Presentation |
| --- | --- | --- |
| modified in worktree | `reviewed` fingerprint unchanged | ⚠ "edited, not yet reviewed" — visible *before* running validate |
| modified | fingerprint differs | "edited and unreviewed" (computable without git) |
| untracked | — | "new requirement, not yet committed" |
| modified (parent item) | child links recorded its old fingerprint | child links are *about to become* suspect — highlight children proactively |
| clean | — | no chip |

The last row is the main win: git shows a parent changed *now*, while
suspect-link detection only fires after commit and re-validation. The detail
pane links to the git panel / runs `git diff -- <item path>` in the terminal.

### Boundaries and caveats

- Fingerprints ("changed since last *review*") and git state ("changed since
  last *commit*") answer different questions; both render as clearly labeled
  chips, neither replaces `doorstop` validation.
- The bundled git plugin computes status server-side, but its
  `backend.request()` is bound to its own plugin id — a browser plugin cannot
  borrow it, hence parsing the index ourselves.
- Best-effort edges: assume-unchanged/skip-worktree, worktree-specific
  indexes, `.git` as file; document anything not handled.

## 13. References

- Doorstop: https://github.com/doorstop-dev/doorstop (docs: item/document/tree
  reference, CLI validation/publishing/creation, Python scripting API)
- PI WEB plugin API: `../pi-web/docs/plugins.md` (browser v2, panels, labels,
  files/terminal/prompt helpers, backend contract)
- Prior art: `../opense-package` (plugin skeleton, controller registry, Lit
  panel, build/test tooling)
- Git index format: https://git-scm.com/docs/index-format (M6 detection)
