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
  controller registry (`src/doorstop-panel.ts`);
- **actions** `view.doorstop` (mod+7) and `workspace.refresh-doorstop`
  (mod+shift+d);
- **label** `doorstop-status` — the informational requirement-health counts
  (async-cache idiom, feature spec §7.4).

The frozen shared types + function-signature contracts live in
`src/doorstop-contract.ts`; later modules import these and must not redefine
them.

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
