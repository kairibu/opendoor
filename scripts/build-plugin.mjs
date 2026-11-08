#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build the opendoor package: esbuild-bundle the browser entry from
// src/browser/pi-web-plugin.ts into dist/browser/pi-web-plugin.js, the paired
// server entry from src/server-plugin.ts into dist/server-plugin.js, and the
// Pi extension from src/pi-extension/opendoor-review.ts into
// dist/pi-extension/index.js, then write the INSTALLED-root plugin manifest
// into dist/package.json.
//
// Adapted from pi-web's scripts/build-plugins.mjs: pi-web bundles each plugin
// entry with esbuild (`bundle: true`, browser/ESM/es2022 — see its buildFile),
// so plugin modules may import npm dependencies (e.g. `lit`) directly: they
// are inlined into the bundle and no host import map is required. This script
// applies the identical esbuild options to this repository's entries (browser
// bundle: browser platform; server bundle: node platform — the type-only
// `@jmfederico/pi-web/server-plugin-api` imports erase at build time; extension
// bundle: node platform — its type-only `@earendil-works/pi-coding-agent`
// import erases and its relative metadata import is inlined, so the shipped
// extension is self-contained).
//
// TWO INSTALL ROOTS, ONE PACKAGE (relay `opendoor-dispatch-redesign` M1). The
// repository-root package.json is the NPM-PACKAGE manifest: its `piWeb.plugins`
// paths and its `pi.extensions` entry are PACKAGE-ROOT-relative, which is what
// PI WEB's catalog (`dist/server/piWebPluginCatalog.js`: `packageRoot = realpath(root)`,
// `resolve(packageRoot, path)`) and Pi's package manager both resolve them
// against when the package is installed from npm or a local source through
// **Settings → Pi packages**. The generated dist/package.json is the
// PLUGIN-ROOT manifest for the legacy local development install, where dist/
// itself IS the installed plugin directory (`ln -s …/dist
// ~/.pi-web/plugins/opendoor`): its paths are dist-relative and it carries NO
// `pi.extensions` entry (pointing a package-root-relative path at the dist
// root would double-prefix `dist/`). A manifest is therefore always correct
// for the root it is read from; `main` is rewritten too, retiring the old
// verbatim-copy quirk where it pointed at a nonexistent dist/dist/… path.
//
// Output layout (dist/):
//   package.json             — GENERATED plugin-root manifest (see above)
//   browser/pi-web-plugin.js — bundled browser entry ("// Generated from …"):
//                             wiring + all plugin modules + inlined npm deps
//   server-plugin.js         — bundled Node ESM server entry (workspace
//                             provider + doorstop.run backend); sits OUTSIDE
//                             browser/ so it is never browser-public
//   pi-extension/index.js    — bundled Node ESM Pi extension entry
//                             (`/opendoor-review` session dispatch)
//
// The narrow `browserRoot: "dist/browser"` (root manifest) / `"browser"`
// (dist manifest) keeps the server module, extension, source, and package
// metadata out of the plugin asset routes (pi-web docs: "a sibling server
// module … return[s] not found through plugin asset routes").
//
// Test files (*.test.ts), the shared test-support module, and .d.ts
// declarations are excluded, exactly like pi-web's build: types are checked
// by `npm run typecheck`, and the plugin loads only the runtime bundles.
//
// Usage: npm run build | npm run dev (--watch)
// ---------------------------------------------------------------------------

import { watch } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const srcDir = resolve(rootDir, "src");
const outDir = resolve(rootDir, "dist");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

const browserEntrySource = resolve(srcDir, "browser", "pi-web-plugin.ts");
const browserEntryOutput = resolve(outDir, "browser", "pi-web-plugin.js");
const serverEntrySource = resolve(srcDir, "server-plugin.ts");
const serverEntryOutput = resolve(outDir, "server-plugin.js");
const extensionEntrySource = resolve(srcDir, "pi-extension", "opendoor-review.ts");
const extensionEntryOutput = resolve(outDir, "pi-extension", "index.js");

if (isDirectExecution()) {
  if (watchMode) {
    await watchAndBuild();
  } else {
    await buildAll();
  }
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  // The browser module must live under its declared `browserRoot` ("browser"
  // in the dist manifest) as a real package directory the catalog can
  // traverse; ensure it exists before esbuild writes the bundle into it.
  await mkdir(dirname(browserEntryOutput), { recursive: true });
  await mkdir(dirname(extensionEntryOutput), { recursive: true });
  await buildBrowserEntry();
  await buildServerEntry();
  await buildExtensionEntry();
  // The plugin-root manifest lives in dist/ and is GENERATED (never copied
  // verbatim): the root manifest is npm-package-root-relative, the dist
  // manifest is dist-root-relative, and the extension entry belongs only to
  // the former — see the module header (M1). Keep dist/ minimal (only these
  // four files/dirs): the host's plugin revision scan budgets the whole
  // installed package (docs/plugins.md: 4096 entries / 16 MiB), so no
  // sourcemaps, caches, or other build artifacts may land here.
  await writeDistManifest();
  console.log(`[opendoor] bundled ${relative(cwd, browserEntrySource)} into ${relative(cwd, browserEntryOutput)}`);
  console.log(`[opendoor] bundled ${relative(cwd, serverEntrySource)} into ${relative(cwd, serverEntryOutput)}`);
  console.log(`[opendoor] bundled ${relative(cwd, extensionEntrySource)} into ${relative(cwd, extensionEntryOutput)}`);
}

/** Write the dist-root plugin manifest: the npm-package manifest's identity
 *  fields, the `piWeb.plugins` entries rewritten dist-relative, and no
 *  package-only fields (`pi.extensions`, `scripts`, `devDependencies`, `files`)
 *  that do not apply to an installed plugin directory. */
async function writeDistManifest() {
  const rootManifest = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const plugins = (rootManifest.piWeb?.plugins ?? []).map((entry) => ({
    ...entry,
    ...(entry.browserRoot === undefined ? {} : { browserRoot: stripDistPrefix(entry.browserRoot) }),
    ...(entry.module === undefined ? {} : { module: stripDistPrefix(entry.module) }),
    ...(entry.serverModule === undefined ? {} : { serverModule: stripDistPrefix(entry.serverModule) }),
  }));
  const distManifest = {
    name: rootManifest.name,
    version: rootManifest.version,
    description: rootManifest.description,
    type: rootManifest.type,
    license: rootManifest.license,
    keywords: rootManifest.keywords,
    ...(rootManifest.main === undefined ? {} : { main: stripDistPrefix(rootManifest.main) }),
    piWeb: { plugins },
    // The installed plugin dir is only ever read by PI WEB; the Pi-extension
    // peer is a package-level declaration and stays in the root manifest only.
    peerDependencies: { "@jmfederico/pi-web": rootManifest.peerDependencies["@jmfederico/pi-web"] },
  };
  await writeFile(resolve(outDir, "package.json"), `${JSON.stringify(distManifest, null, 2)}\n`);
}

/** Turn a package-root-relative manifest path into its dist-root equivalent.
 *  The root manifest paths are required to start with `dist/` when read from
 *  the repository root; a path that does not is left untouched so a future
 *  manifest shape fails visibly in the catalog rather than silently here. */
function stripDistPrefix(path) {
  return path.startsWith("dist/") ? path.slice("dist/".length) : path;
}

async function buildBrowserEntry() {
  // esbuild options byte-identical to pi-web's buildFile. npm deps (lit, and
  // any vendored bundle the model chain later inlines) are bundled, never
  // external: no host import map is required.
  await build({
    entryPoints: [browserEntrySource],
    outfile: browserEntryOutput,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    banner: { js: `// Generated from ${relative(cwd, browserEntrySource)}. Do not edit directly.` },
  });
}

async function buildServerEntry() {
  // Node ESM bundle (pi-web's dist/pi-web-plugins/git/server-plugin.js shape):
  // the catalog imports server modules as Node ES modules, so the package's
  // "type": "module" applies (docs: do not rely on typeless-module reparsing).
  // `node:` builtins stay external; everything else (incl. the shared
  // contract and backend) is inlined.
  await build({
    entryPoints: [serverEntrySource],
    outfile: serverEntryOutput,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    banner: { js: `// Generated from ${relative(cwd, serverEntrySource)}. Do not edit directly.` },
  });
}

async function buildExtensionEntry() {
  // Node ESM bundle for Pi's extension loader. The extension's only non-type
  // import is the shared metadata module (same package, same dist tree), so
  // bundling inlines it and leaves ZERO runtime imports: the shipped entry is
  // self-contained and reaches no host internals.
  await build({
    entryPoints: [extensionEntrySource],
    outfile: extensionEntryOutput,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    banner: { js: `// Generated from ${relative(cwd, extensionEntrySource)}. Do not edit directly.` },
  });
}

/** Watch mode listens on src/; the realpath guard keeps a symlinked
 *  subdirectory from fanning out duplicate watchers. */
async function findWatchDirs(dir) {
  const dirs = [];
  const visited = new Set();
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    const realCurrent = await realpath(current).catch(() => undefined);
    if (realCurrent === undefined || visited.has(realCurrent)) continue;
    visited.add(realCurrent);
    dirs.push(current);
    for (const entry of await readDirectory(current)) {
      if (entry.name === "node_modules") continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const linkedRealpath = await realpath(path).catch(() => undefined);
        if (linkedRealpath === undefined) continue;
        const linked = await stat(linkedRealpath).catch(() => undefined);
        if (linked?.isDirectory()) pending.push(linkedRealpath);
        else if (linked?.isFile()) dirs.push(dirname(linkedRealpath));
      }
    }
  }
  return [...new Set(dirs)].sort((left, right) => left.localeCompare(right));
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function watchAndBuild() {
  let watchers = [];
  let timer;
  let building = false;
  let pending = false;

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const refreshWatchers = async () => {
    closeWatchers();
    watchers = (await findWatchDirs(srcDir)).map((dir) => watch(dir, () => scheduleBuild()));
  };

  const runBuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      do {
        pending = false;
        await refreshWatchers();
        await buildAll();
      } while (pending);
    } catch (error) {
      console.error("[opendoor] build failed:", error);
    } finally {
      building = false;
    }
  };

  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(runBuild, 50);
  };

  await runBuild();
  console.log("[opendoor] watching for changes…");
  const shutdown = () => {
    closeWatchers();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive while watching.
  await new Promise(() => {});
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
