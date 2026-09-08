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

This is the **M0 scaffold / frozen-contract slice**. The package skeleton and
the shared contract module (`src/doorstop-contract.ts`) are in place and
green; the discovery / model / state / panel modules and the real plugin
entry are built by later milestone chains on top of this contract. The
current `src/pi-web-plugin.ts` is a **placeholder** that contributes nothing
yet.

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

Then reload the PI WEB page and verify via
`/pi-web-plugins/manifest.json`. (Symlinking is done by a later milestone
chain, not the scaffold.)
