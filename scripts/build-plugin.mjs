#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build the opendoor pi-web plugin: esbuild-bundle the TypeScript entry from
// src/ into a single dist/pi-web-plugin.js and copy non-TS assets (package.json
// manifest) verbatim.
//
// Adapted from pi-web's scripts/build-plugins.mjs: pi-web bundles each plugin
// entry with esbuild (`bundle: true`, browser/ESM/es2022 — see its buildFile),
// so plugin modules may import npm dependencies (e.g. `lit`) directly: they
// are inlined into the bundle and no host import map is required. This script
// applies the identical esbuild options to this repository's single entry.
//
// Output layout (dist/):
//   package.json            — verbatim copy from the repository root; carries
//                             the piWeb.plugins manifest the pi-web catalog
//                             discovers
//   pi-web-plugin.js        — bundled entry ("// Generated from …"): wiring +
//                             all plugin modules + inlined npm deps
//
// Test files (*.test.ts), the shared test-support module, and .d.ts
// declarations are excluded, exactly like pi-web's build: types are checked
// by `npm run typecheck`, and the plugin loads only the runtime bundle.
//
// Usage: npm run build | npm run dev (--watch)
// ---------------------------------------------------------------------------

import { watch } from "node:fs";
import { copyFile, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const srcDir = resolve(rootDir, "src");
const outDir = resolve(rootDir, "dist");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

const entrySource = resolve(srcDir, "pi-web-plugin.ts");
const entryOutput = resolve(outDir, "pi-web-plugin.js");

if (isDirectExecution()) {
  if (watchMode) {
    await watchAndBuild();
  } else {
    await buildAll();
  }
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  await buildEntry();
  // The plugin manifest lives at the repository root; dist/ needs it verbatim
  // so the pi-web catalog can discover the piWeb.plugins entry.
  await mkdir(outDir, { recursive: true });
  await copyFile(resolve(rootDir, "package.json"), resolve(outDir, "package.json"));
  console.log(`[opendoor] bundled ${relative(cwd, entrySource)} into ${relative(cwd, entryOutput)}`);
}

async function buildEntry() {
  // esbuild options byte-identical to pi-web's buildFile. npm deps (lit, and
  // any vendored bundle the model chain later inlines) are bundled, never
  // external: no host import map is required.
  await build({
    entryPoints: [entrySource],
    outfile: entryOutput,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    banner: { js: `// Generated from ${relative(cwd, entrySource)}. Do not edit directly.` },
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
