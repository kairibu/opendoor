# Implementation Plan: Opendoor Paired Server Plugin ("Option 2")

Add a paired pi-web server module to the opendoor plugin (same package, same `id: "opendoor"`) that runs Doorstop CLI commands headlessly via the host-owned `context.execFile()` helper behind a `backend.request("doorstop.run", …)` operation, displays the captured stdout/stderr/exit status in the Requirements panel, refreshes the pane afterwards, and falls back to the existing `terminal.runCommand()` path whenever the backend is unavailable.

---

## Architecture Overview

### Responsibilities

| Side | Module | Responsibility |
|---|---|---|
| Browser entry (v2) | `src/pi-web-plugin.ts` → contributions → panel elements/controller | Renders the panel; dispatches each Doorstop action either through `context.backend.request("doorstop.run", input)` (paired, opendoor owns the workspace) or through `terminal.runCommand()` (unpaired fallback); renders captured output in a new "Last run" section; invalidates/rescans after a run. |
| Server module (v1) | `src/server-plugin.ts` → `src/doorstop-backend.ts` | A `WorkspaceProvider` that (a) claims only projects containing `.doorstop.yml`, (b) lists a single main workspace (the project directory), (c) handles `request()` by validating the browser input, mapping it to an **argv array** (no shell, no quoting), running the Doorstop CLI via `context.execFile()` with `cwd = request.workspace.path`, and returning a JSON result. |
| Shared contract | `src/doorstop-backend-contract.ts` | Operation name, request/response TypeScript types, runtime parse validators, and the UID/target grammars — imported by **both** bundles (git-plugin idiom: `pi-web-plugins/git/browser/git-contract.ts`). |

### Dispatch chain (why the deadlines matter)

```
panel button → context.backend.request("doorstop.run", input)
  → POST /api/plugin-backends/opendoor/projects/…/workspaces/…/doorstop.run
  → sessiond registry: owner re-resolution (probe+list), revision check, input clone ≤ 256 KiB
  → provider.request() callback, hard-bounded to 10 s
      → context.execFile({ file, args, cwd: workspace.path, timeoutMs, signal })
  → JSON response ≤ 8 MiB → browser parse → controller.lastRun → requestRender → invalidate()
```

- Every provider callback (`probe`, `list`, `request`) is individually bounded to **10 s**; the outer dispatch is 25 s. Therefore `execFile.timeoutMs` must be set to **~8 500 ms**, not the host max of 30 s, so opendoor returns its own structured result (with output) instead of the whole request being aborted by the host.
- `backend` is only present on `WorkspacePanelContext` when the manifest carries `backendRevision` (server module active + healthy in sessiond). The browser must additionally gate on `context.workspace.provider?.pluginId === "opendoor"` and `provider.capabilities.request !== false` (git-panel idiom), because the host re-resolves ownership at dispatch and rejects `409 owner-mismatch` / `409 stale-plugin-revision`.

### Operation contract (single operation, server-side argv building)

One operation keeps the dispatch path simple and ensures the **server** — not the browser — owns argv construction (the browser never sends shell strings or raw argv).

```ts
// src/doorstop-backend-contract.ts
export const OPENDOOR_PLUGIN_ID = "opendoor";
export const DOORSTOP_RUN_OPERATION = "doorstop.run";   // matches ^[a-z][a-z0-9.-]*$

export type DoorstopRunRequest =
  | { op: "validate" }
  | { op: "publish"; target: string }                    // workspace-relative path, pre-validated
  | { op: "review"; uid: string }
  | { op: "clear"; uid: string; parents: readonly string[] }
  | { op: "edit"; uid: string }
  | { op: "link"; uid: string; target: string }
  | { op: "unlink"; uid: string; target: string };

export interface DoorstopRunResponse {
  op: DoorstopRunRequest["op"];
  exitCode: number | null;
  signal: string | null;            // non-null ⇒ killed (timeout/abort) — surfaced, not thrown
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;         // 2 MiB/stream host bound; shown as a notice, not an error
  stderrTruncated: boolean;
  durationMs: number;               // measured around execFile
}
```

Server-side argv map (mirrors today's command builders in `doorstop-panel-elements.ts`):

| op | argv |
|---|---|
| `validate` | `["--version"]`-less: `[]` (today's bare `"doorstop"`) |
| `publish` | `["publish", "all", target]` |
| `review` | `["review", uid]` |
| `clear` | `["clear", uid, …parents]` |
| `edit` | `["edit", uid]` |
| `link` / `unlink` | `[op, uid, target]` |

Error taxonomy → `backend.request()` rejections (thrown `Error`s, message truncated to 2 048 chars by sessiond):

| Condition | Behavior |
|---|---|
| Malformed input (unknown op, invalid UID/target grammar) | throw `opendoor: invalid …` **before** exec |
| `doorstop` binary not resolvable (spawn ENOENT) | throw `opendoor: doorstop CLI not found on the sessiond host PATH — configure plugins.opendoor.settings.doorstopPath` |
| CLI ran, any exit code (incl. validate's exit 1) | **resolve** with `DoorstopRunResponse` — findings are output, not an infrastructure error |
| Killed by timeout/abort (`signal !== null`) | resolve with response (partial output preserved); browser renders "killed (timeout)" |
| Truncated streams | resolve with truncation flags set; browser renders a notice (deliberately *not* the git throw-on-truncation idiom — display wants partial content) |
| Provider callback aborted by host (10 s dispatch bound) | request rejects with the host's attributed error; nothing opendoor can do |

### Ownership trade-off (the known §9 tension, decided)

Adding a server entry makes opendoor a workspace provider; `backend.request()` only works for workspaces **its own provider owns**. Decision: opendoor is a **primary-tier** provider (`fallback` unset) whose `probe` returns `"claim"` **only** when `<project.path>/.doorstop.yml` exists (checked with `node:fs/promises` — cheap, no execFile); everything else returns `"pass"` and stays on the fallback Git provider. Consequence (documented, accepted for now): doorstop projects lose the Git fallback provider's backend features (git status/diff) for that project; non-doorstop projects are unaffected. This is exactly the trade-off opendoor's feature spec §9 risk #6 anticipated.

---

## Plan

### Phase A — shared contract

1. **Create `src/doorstop-backend-contract.ts`** (new): constants `OPENDOOR_PLUGIN_ID`, `DOORSTOP_RUN_OPERATION`; the `DoorstopRunRequest` / `DoorstopRunResponse` types above; runtime validators `parseDoorstopRunResponse(value: unknown): DoorstopRunResponse` and `parseDoorstopRunRequest(value: unknown): DoorstopRunRequest` (git-contract style: structural, no host imports); port the UID grammar from `doorstop-panel-elements.ts` (`isValidTargetUid`, currently private) and the publish-target path rule from the settings chain as exported `isValidDoorstopUid` / `isValidPublishTarget` so both sides validate identically. No runtime imports from `@jmfederico/pi-web` (type-only at most) so the module compiles into both bundles and runs in both vitest environments.

### Phase B — server module

2. **Create `src/doorstop-backend.ts`** (new): `export async function requestDoorstopBackend(context: ServerPluginActivationContext, request: ProviderRequestContext): Promise<JsonValue>`.
   - Parse `request.input` with the contract validator; throw before exec on any validation failure.
   - Internal `runDoorstop(context, cwd, args, signal)` wrapper around `context.execFile`: `file` = `settings.doorstopPath ?? "doorstop"`, `args`, `cwd: request.workspace.path` (absolute, host-validated — never derived from `project.path`), `timeoutMs: settings.timeoutMs ?? 8_500` (headroom under the 10 s callback bound), `signal: request.signal` (forward the per-invocation signal, never retain it), `unsetEnv: ["DOORSTOP_HOME", "PYTHONPATH", …]` (hygiene, git `GIT_*` idiom).
   - Per-workspace serialization: an activation-scoped `Map<string, Promise<void>>` keyed by `workspace.path` chains concurrent `request()` calls so two doorstop runs (e.g. publish + validate) never overlap in one checkout.
   - Measure `durationMs`, map the `ServerPluginExecFileResult` to `DoorstopRunResponse`, return it as `JsonValue`.
   - Parse `context.settings` leniently: `{ doorstopPath?: string, timeoutMs?: number }` (host-side `plugins.opendoor.settings`, server-only).

3. **Create `src/server-plugin.ts`** (new): default-export `PiWebServerPlugin` — `apiVersion: 1`, `name: "Opendoor"`, `activate(context)` returns `{ workspaceProvider: createDoorstopWorkspaceProvider(context) }`. Export `createDoorstopWorkspaceProvider(context)` for testability (git idiom):
   - `probe(project, signal)`: `fs.access(path.join(project.path, ".doorstop.yml"))` → `"claim"`, `ENOENT`/any failure → `"pass"`; wrap in try/catch so probe never rejects (a rejected probe becomes a degraded project). Cheap — no `execFile`.
   - `list(project, signal)`: single workspace `{ key: project.path, path: project.path, label: project.name, isMain: true, publicMetadata: { doorstop: true } }` (stable key, absolute path, unique label, exactly one `isMain`).
   - `request: (r) => requestDoorstopBackend(context, r)` — presence of this method is what enables the browser `backend`.
   - Omit `prepareRemove` (main-only workspaces are not removable linked workspaces) and `start`/`stop`; consider a `health()` later — deliberately omitted in v1 to avoid a bounded health probe executing the CLI.
   - Import everything from `@jmfederico/pi-web/server-plugin-api` **type-only**; Node runtime imports limited to `node:path`, `node:fs/promises`.

### Phase C — packaging, build, config

4. **`package.json`**: change the manifest entry to the paired form with a narrow browser root (server bundle must not live under `browserRoot`):
   ```json
   "piWeb": { "plugins": [ { "id": "opendoor", "browserRoot": "browser",
                             "module": "browser/pi-web-plugin.js", "serverModule": "server-plugin.js" } ] }
   ```
   Update `main` to `dist/browser/pi-web-plugin.js`; keep `"type": "module"` (required for a `.js` `serverModule`); keep `machineSpecific` at its default `true`; bump the `@jmfederico/pi-web` peer minimum only if the pinned `>=1.202608` lacks the `/server-plugin-api` export (verify during step 13).
5. **`scripts/build-plugin.mjs`**: emit **two** bundles — browser entry as today but `outfile: dist/browser/pi-web-plugin.js` (mkdir first), and a second `build({ entryPoints: [src/server-plugin.ts], outfile: dist/server-plugin.js, platform: "node", format: "esm", target: "es2022", bundle: true })`; keep the verbatim `package.json` copy; cover both outputs in the log and in `--watch` (watch already scans `src/`).
6. **`tsconfig.json`**: verify the server files typecheck under the existing strict config (`@types/node` is already a devDependency; type-only `server-plugin-api` import needs the subpath to resolve under the current `moduleResolution` — adjust `types`/`paths` only if step 13 shows a resolution failure).
7. **`.gitignore`**: confirm `dist/` is ignored (the new `dist/browser/` and `dist/server-plugin.js` artifacts must not be committed; add if missing).

### Phase D — browser integration

8. **`src/doorstop-panel-controller.ts`**: add state — `lastRun: DoorstopLastRunView | undefined` (view record: `{ op, title, status: "ok" | "failed" | "killed" | "error", exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated, durationMs, at: number, errorMessage?: string }`), `runInProgress: string | undefined` (the op title, for button disabling), plus small mutators that guard on `host.isConnected` and call `requestUpdate()`. `lastRun` must **survive** `invalidate()`/`load()` (it is run output, independent of the rescan) and be cleared only by a dismiss or a new run. On LRU eviction it dies with the controller — acceptable.
9. **`src/doorstop-panel-elements.ts`** — replace `runDoorstop()` (lines 1944–1969) with a dispatcher + two paths:
   - `runDoorstop(op, title, input: DoorstopRunRequest, terminalCommand: string, open: boolean)`:
     - **Backend path** when `context.backend !== undefined && context.workspace.provider?.pluginId === OPENDOOR_PLUGIN_ID && context.workspace.provider?.capabilities?.request !== false`: set `runInProgress`, `await context.backend.request(DOORSTOP_RUN_OPERATION, input)`, parse via `parseDoorstopRunResponse`, map to a `DoorstopLastRunView` (`status`: exit 0 → ok, exit ≠ 0 → failed, `signal !== null` → killed), commit to `controller.lastRun`, `void controller.invalidate()`, clear `runInProgress`. On rejection: `lastRun = { status: "error", errorMessage }` (parse server error text), clear `runInProgress`, no invalidate.
     - **Terminal fallback path**: exactly today's behavior — `terminal.runCommand({ title, command: terminalCommand, metadata: { "opendoor.op": op }, open })` then rescan on `handle.completed`. Keep `doorstopPublishCommand`/`quoteShellArgument`/UID guarding untouched for this path.
   - Update the six call sites (`onValidateClick`, `onPublishClick`, `reviewItem`, `clearSuspects`, `editItem`, `runTargetOp`) to pass both the structured input and the terminal command string.
   - Render: a "Last run" section (status badge, duration, dismiss button, `<pre>` with `stdout`/`stderr` pre-wrap, truncation and killed notices) driven by `controller.lastRun`; disable action buttons while `controller.runInProgress !== undefined`. Mirror the new properties in `renderDoorstopPanel` (step 10).
   - Note: the browser never needs shell quoting on the backend path — argv is built server-side.
10. **`src/doorstop-contributions.ts`**: mirror `lastRun`/`runInProgress` into the body element's properties in `renderDoorstopPanel`; keep `visible: () => true` (the panel remains useful unpaired). Refresh the header comments that assert "browser-only plugin / no backend" — they are now stale.

### Phase E — docs

11. **`README.md`** and **`docs/feature-doorstop-plugin.md`**: update §2 (capabilities used: server plugin, workspace provider, `backend.request`, `execFile`), §4/§9 (replace the "no server entry" non-goal with the decision + the Git-fallback ownership trade-off), §5 (architecture diagram gains the sessiond half), §10 (paired packaging, `browserRoot` change, build/restart/reload procedure, `plugins.opendoor.settings` `{ doorstopPath, timeoutMs }`), and add a "Run output" section describing the Last run pane and the terminal fallback.

### Phase F — tests (existing vitest setup, `include: ["src/**/*.test.ts"]`)

12. **`src/doorstop-backend.test.ts`** (new): inject a fake `ServerPluginActivationContext` (recording `execFile` returning canned `ServerPluginExecFileResult`s, noop logger, `settings: {}`, fresh `AbortSignal`). Cover: argv built per op (incl. multi-parent `clear`); invalid UID/target/unknown-op rejected **without** exec; `exitCode: 1` resolves (validate findings); `signal: "SIGTERM"` resolves with killed-shaped response; truncation flags passed through; ENOENT mapped to the "CLI not found" message; per-workspace serialization (second call awaits the first); `settings.doorstopPath`/`timeoutMs` honored; `cwd` forwarded verbatim.
13. **`src/server-plugin.test.ts`** (new): probe claims a temp dir containing `.doorstop.yml` and passes without it (real fs via `fs.mkdtemp` — no mocking needed); list returns one main workspace with stable key/absolute path; returned provider is frozen and exposes `request`; default export shape (`apiVersion: 1`, `name`, `activate`). If vitest's global happy-dom environment interferes, add `// @vitest-environment node` pragmas to the two server test files — server modules import no DOM code, so this is purely environmental.
14. **`src/doorstop-backend-contract.test.ts`** (new): `parseDoorstopRunResponse` accepts the server's exact output and rejects junk; UID/target validators agree with the element-level guards (parity test against the ported grammar).
15. **Extend `src/doorstop-panel-controller.test.ts` / `doorstop-panel-elements.test.ts` / `doorstop-panel.test.ts`**: fake `WorkspacePanelContext` gains `backend` (resolve with a canned response) and `workspace.provider = { pluginId: "opendoor", capabilities: {} }` — assert: backend path is chosen when available and gated on provider id/capabilities; terminal path used when `backend === undefined` or provider is `git`; `lastRun` committed with correct `status` and `invalidate()` called once; rejection produces `status: "error"` without invalidate; `runInProgress` disables buttons and clears; `lastRun` survives a reload/invalidate; dismiss works. Reuse `createFakeFiles()` for the rescan side.

### Phase G — rollout

16. Build (`npm run build`), typecheck, test; then `systemctl --user restart pi-web-sessiond.service` and reload the browser tab (server entries load at sessiond startup only; no hot reload). Verify: `/pi-web-plugins/manifest.json` now carries `backendRevision` for opendoor; the Requirements panel shows captured output on Validate on a fixture doorstop project; a non-doorstop project still shows Git-owned behavior; unpaired rollback = rebuild with the manifest's `serverModule` removed and restart — the terminal fallback keeps everything working throughout.

---

## Files to Modify

- `package.json` — paired manifest (`browserRoot: "browser"`, `module: "browser/pi-web-plugin.js"`, `serverModule: "server-plugin.js"`), `main` update, possible peer bump.
- `scripts/build-plugin.mjs` — second esbuild bundle (node platform) + browser output relocation; watch/log updates.
- `src/doorstop-panel-elements.ts` — `runDoorstop()` split into backend/terminal dispatcher, backend-path input construction, Last run rendering, button gating; header comment updates.
- `src/doorstop-panel-controller.ts` — `lastRun` / `runInProgress` state + guarded mutators (surviving invalidation).
- `src/doorstop-contributions.ts` — mirror new controller fields in `renderDoorstopPanel`; stale "browser-only" comments.
- `tsconfig.json` — only if server-entry type resolution needs adjustment (verify first).
- `.gitignore` — confirm/ensure `dist/` ignored.
- `README.md`, `docs/feature-doorstop-plugin.md` — pairing, ownership trade-off, settings, restart procedure, run-output UX.
- `src/doorstop-panel-controller.test.ts`, `src/doorstop-panel-elements.test.ts`, `src/doorstop-panel.test.ts` — backend-path and lastRun coverage.

## New Files

- `src/doorstop-backend-contract.ts` — shared operation name, request/response types, parse validators, UID/target grammars (both bundles).
- `src/server-plugin.ts` — Node entry: `PiWebServerPlugin` default export + `createDoorstopWorkspaceProvider()` (probe/list/request).
- `src/doorstop-backend.ts` — `requestDoorstopBackend()`: input validation, argv builders, execFile wrapper, serialization, response mapping, settings parsing.
- `src/doorstop-backend.test.ts`, `src/server-plugin.test.ts`, `src/doorstop-backend-contract.test.ts` — server/contract test suites.

## Risks & Open Questions

- **Ownership claim suppresses Git fallback on doorstop projects** — the §9 trade-off made real: git status/diff backend features stop working where opendoor claims. Mitigated by the narrow `.doorstop.yml` probe; revisit if pi-web later supports non-owning backends. *Open question: should probe additionally require the `doorstop` binary to resolve (degrade gracefully to Git when the CLI is missing on the service host), at the cost of an exec in every project probe?*
- **10 s provider-callback ceiling**: large `doorstop publish`/validate runs will hit the ~8.5 s exec timeout and surface as "killed (timeout)" with partial output. Terminal fallback stays available for long runs. *Open question: keep a dedicated "run in terminal" secondary affordance even when paired?*
- **`doorstop` may not be on sessiond's service PATH** (inherits daemon env, not the login shell): documented `settings.doorstopPath` escape hatch; clear ENOENT error message.
- **No streaming, final-result only**: output appears only after process close; 2 MiB/stream truncation is surfaced as a notice rather than an error (deliberate deviation from the git throw idiom).
- **No hot reload**: every server-side change requires rebuild + sessiond restart + tab reload; browser may show `409 stale-plugin-revision` until reload.
- **Concurrency**: doorstop runs serialized per workspace path inside the provider; cross-workspace runs remain concurrent (safe — different checkouts).
- **`main` field / external references** to `dist/pi-web-plugin.js` break with the browserRoot move — update `main` and check README install instructions (`ln -s …/dist` is unchanged).
- **Peer dependency floor**: confirm `@jmfederico/pi-web/server-plugin-api` exists at `>=1.202608` before shipping; bump if not.
- **Run identification metadata**: `"opendoor.op"` metadata continues to identify terminal-fallback runs; backend runs are identified by `controller.lastRun` (no terminal run exists) — no host-side metadata contract needed.
