// @vitest-environment node
//
// Layer 2 (node env): server plugin factory tests (plan Phase F step 13).
// Real fs via `fs.mkdtemp` — no mocking needed: probe claims a temp dir that
// contains `.doorstop.yml` and passes everything else (never rejecting), list
// returns exactly one main workspace with a stable key and the absolute
// project path, the returned provider is frozen and exposes the `request`
// seam, and the default export has the paired server-plugin shape.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  JsonValue,
  ProjectInput,
  ProviderRequestContext,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";
import plugin, { createDoorstopWorkspaceProvider } from "./server-plugin.js";
import {
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopBaselineResponse,
  parseDoorstopGitCommitResponse,
  parseDoorstopGitStageResponse,
  parseDoorstopGitStatusResponse,
  parseDoorstopGitUnstageResponse,
  parseDoorstopRunResponse,
} from "./doorstop-backend-contract.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One fresh temp root per fixture: a labeled subdirectory for the project,
 *  only the root is registered for cleanup. */
async function fixtureDirectory(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opendoor-server-plugin-"));
  const dir = join(root, label);
  await mkdir(dir);
  tempRoots.push(root);
  return dir;
}

function projectFor(path: string): ProjectInput {
  return { id: "project-demo", name: "demo", path };
}

/** Minimal activation context — probe/list/request never touch execFile here. */
function contextFor(): ServerPluginActivationContext {
  return {
    apiVersion: 1,
    pluginId: "opendoor",
    packageRoot: "/fake/package-root",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    settings: {},
    signal: new AbortController().signal,
    execFile: async () => {
      throw new Error("server-plugin tests must never exec the CLI");
    },
  };
}

describe("createDoorstopWorkspaceProvider", () => {
  it("claims a project with .doorstop.yml and passes without one (never rejects)", async () => {
    const claimed = await fixtureDirectory("doorstop project");
    await writeFile(join(claimed, ".doorstop.yml"), "settings:\n  digits: 4\n");
    const passed = await fixtureDirectory("plain project");
    // A nonexistent project path (readdir ENOENT) must also pass, not reject.
    const gone = join(claimed, "does-not-exist");

    const provider = createDoorstopWorkspaceProvider(contextFor());
    const signal = new AbortController().signal;
    await expect(provider.probe(projectFor(claimed), signal)).resolves.toBe("claim");
    await expect(provider.probe(projectFor(passed), signal)).resolves.toBe("pass");
    await expect(provider.probe(projectFor(gone), signal)).resolves.toBe("pass");
  });

  it("claims nested markers — the reqs/.doorstop.yml idiom — and skips .git/node_modules", async () => {
    const provider = createDoorstopWorkspaceProvider(contextFor());
    const signal = new AbortController().signal;

    // The real-world shape: documents live in subdirectories.
    const nested = await fixtureDirectory("nested project");
    await mkdir(join(nested, "reqs"));
    await writeFile(join(nested, "reqs", ".doorstop.yml"), "settings:\n  digits: 4\n");
    await expect(provider.probe(projectFor(nested), signal)).resolves.toBe("claim");

    // Skip names are never entered — a marker inside them does not claim.
    const vendor = await fixtureDirectory("vendor project");
    await mkdir(join(vendor, "node_modules", "somepkg"), { recursive: true });
    await writeFile(join(vendor, "node_modules", "somepkg", ".doorstop.yml"), "settings:\n");
    await expect(provider.probe(projectFor(vendor), signal)).resolves.toBe("pass");

    // Depth bound: a marker below PROBE_MAX_DEPTH levels stays invisible.
    const deep = await fixtureDirectory("deep project");
    const deepMarker = join(deep, "a", "b", "c", "d");
    await mkdir(deepMarker, { recursive: true });
    await writeFile(join(deepMarker, ".doorstop.yml"), "settings:\n");
    await expect(provider.probe(projectFor(deep), signal)).resolves.toBe("pass");

    // Exactly at the depth bound is still visible (a = 1 … c = 3).
    const edge = await fixtureDirectory("edge project");
    const edgeMarker = join(edge, "a", "b", "c");
    await mkdir(edgeMarker, { recursive: true });
    await writeFile(join(edgeMarker, ".doorstop.yml"), "settings:\n");
    await expect(provider.probe(projectFor(edge), signal)).resolves.toBe("claim");

    // An aborted signal ends the walk as "not found" (never rejects).
    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.probe(projectFor(nested), aborted.signal)).resolves.toBe("pass");
  });

  it("lists exactly one main workspace with a stable key and the absolute project path", async () => {
    const dir = await fixtureDirectory("demo project");
    const provider = createDoorstopWorkspaceProvider(contextFor());
    const signal = new AbortController().signal;

    const workspaces = await provider.list(projectFor(dir), signal);
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    if (workspace === undefined) throw new Error("list must return exactly one workspace");
    expect(workspace).toEqual({
      key: dir,
      path: dir,
      label: "demo",
      isMain: true,
      publicMetadata: { doorstop: true },
    });
    expect(isAbsolute(workspace.path)).toBe(true);
    expect(isAbsolute(workspace.key)).toBe(true);

    // Stable key across calls (the host derives the public workspace id).
    const again = await provider.list(projectFor(dir), signal);
    expect(again[0]?.key).toBe(dir);
    expect(again[0]?.key).toBe(workspace.key);
  });

  it("returns a frozen primary-tier provider exposing the request seam", () => {
    const provider: WorkspaceProvider = createDoorstopWorkspaceProvider(contextFor());
    expect(Object.isFrozen(provider)).toBe(true);
    expect(typeof provider.request).toBe("function");
    // Primary tier: `fallback` unset (git is the fallback provider).
    expect(provider.fallback).toBeUndefined();
    // Main-only workspaces are not removable: no prepareRemove in v1.
    expect(provider.prepareRemove).toBeUndefined();
  });

  it("dispatches all six operations to their handlers; anything else errors", async () => {
    const requests: ServerPluginExecFileRequest[] = [];
    /** The host's exact exec result shape every canned answer starts from. */
    const RESULT: ServerPluginExecFileResult = {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    const context = {
      ...contextFor(),
      execFile: async (request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult> => {
        requests.push(request);
        const args = request.args ?? [];
        // rev-parse answers "true"; log/show and the commit's rev-parse
        // --short produce a blob/sha; the shared plain `-z` porcelain reports
        // one path changed in BOTH columns (`MM`): the stage handler selects
        // it by its worktree (Y) column and the unstage handler selects it by
        // its index (X) column, so a single canned record routes both
        // operations through their own selection rule; the status's v1 -z -b
        // porcelain reports branch + one path; diff --cached --quiet reports
        // staged changes (exit 1).
        if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return { ...RESULT, stdout: "true" };
        if (args[0] === "rev-parse") return { ...RESULT, stdout: "sha1\n" };
        if (args[0] === "status" && !args.includes("--porcelain=v1")) return { ...RESULT, stdout: "MM reqs/REQ0001.yml\0" };
        if (args[0] === "status") return { ...RESULT, stdout: "## main\0 M reqs/REQ0001.yml\0" };
        if (args[0] === "diff") return { ...RESULT, exitCode: 1 };
        return { ...RESULT, stdout: "sha1\n" };
      },
    };
    const provider = createDoorstopWorkspaceProvider(context);
    const signal = new AbortController().signal;
    const requestFor = (operation: string, input: JsonValue): ProviderRequestContext => ({
      project: projectFor("/workspace/demo checkout"),
      workspace: { key: "/workspace/demo checkout", path: "/workspace/demo checkout", label: "demo", isMain: true },
      operation,
      input,
      signal,
    });

    // `doorstop.item-baseline` routes to the baseline handler (read-only git fetch).
    const baseline = await provider.request?.(requestFor(DOORSTOP_BASELINE_OPERATION, { uid: "REQ0001", path: "reqs/REQ0001.yml" }));
    expect(parseDoorstopBaselineResponse(baseline)).toEqual({
      git: true,
      source: "review-commit",
      candidates: [{ sha: "sha1", blob: "sha1\n" }],
    });

    // `doorstop.git-status` routes to the read-only status handler.
    const status = await provider.request?.(requestFor(DOORSTOP_GIT_STATUS_OPERATION, {}));
    expect(parseDoorstopGitStatusResponse(status).branch).toBe("main");
    expect(parseDoorstopGitStatusResponse(status).files).toEqual([
      { path: "reqs/REQ0001.yml", index: "unmodified", workingTree: "modified" },
    ]);

    // `doorstop.git-stage` routes to the Stage-all handler (rev-parse → status → add).
    const stage = await provider.request?.(requestFor(DOORSTOP_GIT_STAGE_OPERATION, { paths: ["reqs/REQ0001.yml"] }));
    expect(parseDoorstopGitStageResponse(stage)).toEqual({ status: "staged", staged: 1 });

    // `doorstop.git-unstage` routes to the Unstage handler
    // (rev-parse → status → reset). The shared plain-porcelain record is
    // changed in BOTH columns (`MM`), so the unstage handler selects it by
    // its index (X) column, issues the reset, and narrates `unstaged` (a
    // misrouted stage response would fail the unstage parser's status enum).
    const unstage = await provider.request?.(requestFor(DOORSTOP_GIT_UNSTAGE_OPERATION, { paths: ["reqs/REQ0001.yml"] }));
    expect(parseDoorstopGitUnstageResponse(unstage)).toEqual({ status: "unstaged", unstaged: 1 });
    // The reset really crossed the provider boundary (not just the narration).
    expect(requests.filter((request) => request.args?.[0] === "reset").map((request) => request.args)).toEqual([
      ["reset", "-q", "--", ":(literal)reqs/REQ0001.yml"],
    ]);

    // `doorstop.git-commit` routes to the Commit handler (rev-parse → diff → commit → sha).
    const commit = await provider.request?.(requestFor(DOORSTOP_GIT_COMMIT_OPERATION, { message: "docs" }));
    expect(parseDoorstopGitCommitResponse(commit)).toEqual({ status: "committed", sha: "sha1" });

    // `doorstop.run` still routes to the run handler (doorstop exec only).
    const run = await provider.request?.(requestFor(DOORSTOP_RUN_OPERATION, { op: "validate" }));
    expect(parseDoorstopRunResponse(run).op).toBe("validate");

    // Anything else → the existing unsupported-operation error.
    await expect(provider.request?.(requestFor("doorstop.purge", null))).rejects.toThrow(
      "opendoor: unsupported workspace backend operation: doorstop.purge",
    );
  });
});

describe("default export", () => {
  it("is the paired server plugin shape (apiVersion 1, name, activate)", async () => {
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.name).toBe("Opendoor");
    const activation = await plugin.activate(contextFor());
    const provider = activation.workspaceProvider;
    expect(provider).toBeDefined();
    expect(typeof provider?.probe).toBe("function");
    expect(typeof provider?.list).toBe("function");
    expect(typeof provider?.request).toBe("function");
    expect(Object.isFrozen(provider)).toBe(true);
  });
});
