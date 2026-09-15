// @vitest-environment node
//
// Layer 2 (node env): backend request handler tests (plan Phase F step 12).
// A fake `ServerPluginActivationContext` supplies a recording `execFile`
// returning canned `ServerPluginExecFileResult`s; every request goes through
// the exported `requestDoorstopBackend` (the only public seam — argv and the
// exec request are observable on the recorded calls). Coverage per plan:
// argv per op (incl. multi-parent clear), invalid input rejected WITHOUT
// exec, exitCode 1 resolves, signal kill resolves killed-shaped, truncation
// flags pass through (not the git throw idiom), ENOENT → "CLI not found",
// per-workspace serialization (second run awaits the first; other workspaces
// proceed), settings honored (lenient fallbacks; timeout clamped to the
// ceiling), cwd verbatim.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonObject,
  JsonValue,
  ProviderRequestContext,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  DOORSTOP_BASELINE_BLOB_MAX,
  DOORSTOP_BASELINE_OPERATION,
  DOORSTOP_GIT_COMMIT_OPERATION,
  DOORSTOP_GIT_STAGE_OPERATION,
  DOORSTOP_GIT_STATUS_FILES_MAX,
  DOORSTOP_GIT_STATUS_OPERATION,
  DOORSTOP_GIT_UNSTAGE_OPERATION,
  DOORSTOP_RUN_OPERATION,
  parseDoorstopBaselineResponse,
  parseDoorstopGitCommitResponse,
  parseDoorstopGitStageResponse,
  parseDoorstopGitStatusResponse,
  parseDoorstopGitUnstageResponse,
  parseDoorstopRunResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import {
  requestDoorstopBackend,
  requestDoorstopBaseline,
  requestDoorstopGitCommit,
  requestDoorstopGitStage,
  requestDoorstopGitStatus,
  requestDoorstopGitUnstage,
} from "./doorstop-backend.js";

/** The host's exact exec result shape a doorstop run usually resolves with. */
const DEFAULT_RESULT: ServerPluginExecFileResult = {
  exitCode: 0,
  signal: null,
  stdout: "doorstop 1.0.0",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

interface FakeContextOptions {
  settings?: JsonObject;
  /** Sequential exec results; the LAST entry repeats for later calls. */
  results?: readonly ServerPluginExecFileResult[];
  /** When set, every execFile call rejects with this error. */
  execError?: unknown;
  /** Custom execFile implementation (bypasses results/execError). */
  execFile?: (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>;
}

interface FakeContext {
  context: ServerPluginActivationContext;
  /** Every execFile request in call order. */
  requests: ServerPluginExecFileRequest[];
}

/** Fake activation context: noop logger, empty settings, recording execFile. */
function createFakeContext(options: FakeContextOptions = {}): FakeContext {
  const requests: ServerPluginExecFileRequest[] = [];
  const context: ServerPluginActivationContext = {
    apiVersion: 1,
    pluginId: "opendoor",
    packageRoot: "/fake/package-root",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    settings: options.settings ?? {},
    signal: new AbortController().signal,
    async execFile(request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult> {
      requests.push(request);
      if (options.execFile !== undefined) return options.execFile(request);
      if (options.execError !== undefined) throw options.execError;
      const results = options.results;
      const selected = results?.[Math.min(requests.length - 1, Math.max(results.length - 1, 0))];
      return selected ?? DEFAULT_RESULT;
    },
  };
  return { context, requests };
}

/** One `doorstop.run` provider request. The workspace path is independent of
 *  the project path so tests can prove `cwd` never derives from the latter.
 *  `input` is widened to `JsonValue` so junk-request cases need no casts. */
function runRequest(
  run: JsonValue,
  options: { workspacePath?: string; projectPath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  const projectPath = options.projectPath ?? workspacePath;
  return {
    project: { id: "project-demo", name: "demo", path: projectPath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_RUN_OPERATION,
    input: run,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** Yield to pending microtasks/event-loop turns (parked execFiles, chained runs). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("argv construction (the exec request shape)", () => {
  it("builds the exact argv per op and forwards the exec request fields", async () => {
    const cases: ReadonlyArray<{ run: DoorstopRunRequest; argv: readonly string[] }> = [
      { run: { op: "validate" }, argv: [] },
      { run: { op: "publish", target: "./public" }, argv: ["publish", "all", "./public"] },
      { run: { op: "review", uid: "REQ0001" }, argv: ["review", "REQ0001"] },
      { run: { op: "clear", uid: "REQ0001", parents: ["TST001", "TST002"] }, argv: ["clear", "REQ0001", "TST001", "TST002"] },
      { run: { op: "edit", uid: "REQ0001" }, argv: ["edit", "REQ0001"] },
      { run: { op: "link", uid: "REQ0001", target: "TST001" }, argv: ["link", "REQ0001", "TST001"] },
      { run: { op: "unlink", uid: "REQ0001", target: "TST-ALPHA" }, argv: ["unlink", "REQ0001", "TST-ALPHA"] },
    ];
    for (const { run, argv } of cases) {
      const { context, requests } = createFakeContext();
      const signal = new AbortController().signal;
      const response = await requestDoorstopBackend(context, runRequest(run, { signal }));
      const execRequest = requests[0];
      expect(execRequest).toBeDefined();
      expect(execRequest?.file).toBe("doorstop");
      expect(execRequest?.args).toEqual([...argv]);
      expect(execRequest?.cwd).toBe("/workspace/demo checkout");
      expect(execRequest?.timeoutMs).toBe(8500);
      expect(execRequest?.unsetEnv).toEqual(["DOORSTOP_HOME", "PYTHONPATH"]);
      // The per-invocation signal is forwarded verbatim (never the activation
      // signal, never retained/replaced).
      expect(execRequest?.signal).toBe(signal);
      // The returned shape passes the strict shared parser and echoes the op.
      expect(parseDoorstopRunResponse(response).op).toBe(run.op);
    }
  });

  it("cwd is the workspace path verbatim, never derived from project.path", async () => {
    const { context, requests } = createFakeContext();
    await requestDoorstopBackend(
      context,
      runRequest({ op: "validate" }, { workspacePath: "/tmp/opendoor fixture/checkout", projectPath: "/tmp/project root" }),
    );
    expect(requests[0]?.cwd).toBe("/tmp/opendoor fixture/checkout");
  });
});

describe("validation happens before exec", () => {
  it("rejects junk requests without ever calling execFile", async () => {
    const badCases: Array<{ run: JsonValue; message: string }> = [
      { run: { op: "clobber" }, message: "Invalid doorstop run op" },
      { run: { op: "review", uid: "rm -rf /" }, message: "Invalid doorstop UID" },
      { run: { op: "publish", target: "../evil" }, message: "Invalid publish target" },
      { run: { op: "publish", target: "-public" }, message: "Invalid publish target" },
      { run: { op: "link", uid: "REQ0001", target: "bad target" }, message: "Invalid doorstop UID" },
    ];
    for (const { run, message } of badCases) {
      const { context, requests } = createFakeContext();
      await expect(requestDoorstopBackend(context, runRequest(run))).rejects.toThrow(message);
      expect(requests).toHaveLength(0);
    }
  });

  it("rejects an unknown top-level operation without exec", async () => {
    const { context, requests } = createFakeContext();
    await expect(
      requestDoorstopBackend(context, runRequest({ op: "validate" }, { operation: "doorstop.purge" })),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });
});

describe("result mapping", () => {
  it("resolves a non-zero exit (validate findings) with the full response shape", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 1, stdout: "", stderr: "1 item failed validation" }],
    });
    const response = await requestDoorstopBackend(context, runRequest({ op: "validate" }));
    expect(requests).toHaveLength(1);
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.op).toBe("validate");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.signal).toBeNull();
    expect(parsed.stderr).toBe("1 item failed validation");
    expect(parsed.stdoutTruncated).toBe(false);
    expect(parsed.durationMs).toEqual(expect.any(Number));
  });

  it("resolves a killed run (signal set, exitCode null) preserving partial output", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: null, signal: "SIGTERM", stdout: "partial output", stderr: "" }],
    });
    const response = await requestDoorstopBackend(context, runRequest({ op: "publish", target: "./public" }));
    expect(requests).toHaveLength(1);
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.op).toBe("publish");
    expect(parsed.exitCode).toBeNull();
    expect(parsed.signal).toBe("SIGTERM");
    expect(parsed.stdout).toBe("partial output");
  });

  it("passes truncation flags through instead of throwing (deliberate deviation from git)", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, stdoutTruncated: true, stderrTruncated: true }],
    });
    const response = await requestDoorstopBackend(context, runRequest({ op: "validate" }));
    expect(requests).toHaveLength(1);
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.stdoutTruncated).toBe(true);
    expect(parsed.stderrTruncated).toBe(true);
  });
});

describe("exec failure mapping", () => {
  it("maps a spawn ENOENT to the CLI-not-found message", async () => {
    const { context, requests } = createFakeContext({
      execError: Object.assign(new Error("spawn doorstop ENOENT"), { code: "ENOENT" }),
    });
    await expect(requestDoorstopBackend(context, runRequest({ op: "validate" }))).rejects.toThrow(
      /doorstop CLI not found on the sessiond host PATH — configure plugins\.opendoor\.settings\.doorstopPath/,
    );
    expect(requests).toHaveLength(1);
  });

  it("rethrows non-ENOENT exec failures untouched (host-attributed)", async () => {
    const { context, requests } = createFakeContext({
      execError: Object.assign(new Error("spawn doorstop EACCES"), { code: "EACCES" }),
    });
    await expect(requestDoorstopBackend(context, runRequest({ op: "validate" }))).rejects.toThrow("spawn doorstop EACCES");
    expect(requests).toHaveLength(1);
  });
});

describe("per-workspace serialization", () => {
  it("chains concurrent runs per workspace path and lets other workspaces proceed", async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    const { context, requests } = createFakeContext({
      execFile: async (request) => {
        calls += 1;
        if (calls === 1) {
          // Park the FIRST execFile until the test releases it, proving the
          // second same-workspace run waits and the other-workspace run does not.
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return { ...DEFAULT_RESULT, stdout: `run ${String(calls)}` };
      },
    });
    const workspace = "/workspace/demo checkout";
    const signal = new AbortController().signal;
    const first = requestDoorstopBackend(context, runRequest({ op: "validate" }, { workspacePath: workspace, signal }));
    await tick();
    const second = requestDoorstopBackend(context, runRequest({ op: "publish", target: "./public" }, { workspacePath: workspace, signal }));
    await tick();
    expect(calls).toBe(1); // second is queued behind the parked first
    const otherWorkspace = requestDoorstopBackend(context, runRequest({ op: "review", uid: "REQ0001" }, { workspacePath: "/workspace/other" }));
    await tick();
    expect(calls).toBe(2); // different workspace path is NOT serialized
    gates[0]?.();
    const [firstResponse, secondResponse, thirdResponse] = await Promise.all([first, second, otherWorkspace]);
    expect(calls).toBe(3);
    expect(requests).toHaveLength(3);
    expect(parseDoorstopRunResponse(firstResponse).op).toBe("validate");
    expect(parseDoorstopRunResponse(secondResponse).op).toBe("publish");
    expect(parseDoorstopRunResponse(thirdResponse).op).toBe("review");
    // Exec call order proves the chaining: the same-workspace runs are
    // adjacent (second waited for the parked first), and the other-
    // workspace run slipped in between — it was never serialized.
    expect(requests.map((request) => request.cwd)).toEqual([workspace, "/workspace/other", workspace]);
  });
});

describe("settings", () => {
  it("honors configured doorstopPath and timeoutMs", async () => {
    const { context, requests } = createFakeContext({
      settings: { doorstopPath: "/opt/homebrew/bin/doorstop", timeoutMs: 3000 },
    });
    await requestDoorstopBackend(context, runRequest({ op: "validate" }));
    expect(requests[0]?.file).toBe("/opt/homebrew/bin/doorstop");
    expect(requests[0]?.timeoutMs).toBe(3000);
  });

  it("clamps a configured timeoutMs above the ceiling down to the default (shortening is still honored)", async () => {
    const { context, requests } = createFakeContext({ settings: { timeoutMs: 60_000 } });
    await requestDoorstopBackend(context, runRequest({ op: "validate" }));
    expect(requests[0]?.timeoutMs).toBe(8500);
  });

  it("falls back to defaults for malformed settings values (lenient parse)", async () => {
    const { context, requests } = createFakeContext({
      settings: { doorstopPath: 42, timeoutMs: "fast" } as unknown as JsonObject,
    });
    await requestDoorstopBackend(context, runRequest({ op: "validate" }));
    expect(requests[0]?.file).toBe("doorstop");
    expect(requests[0]?.timeoutMs).toBe(8500);
  });
});

// --- review→commit pipeline (plan Phase F step 18) ---------------------------

/** The git plugin's `GIT_*` unset-env list the server forwards (mirrors
 *  GIT_UNSET_ENV_KEYS in doorstop-backend.ts; asserted verbatim here). */
const GIT_UNSET_ENV_EXPECTED = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
];

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One fresh real workspace containing `reqs/REQ0001.yml` — the item-path
 *  walk (uid → file) needs a real file on disk; the git execs stay faked. */
async function fixtureWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opendoor-backend-"));
  await mkdir(join(root, "reqs"));
  await writeFile(join(root, "reqs", "REQ0001.yml"), "uid: REQ0001\ntext: base\nreviewed: abc\n");
  tempRoots.push(root);
  return root;
}

/** One `doorstop.item-baseline` provider request (the run handler's
 *  `runRequest` sibling). `input` is widened to `JsonValue` so junk-request
 *  cases need no casts. */
function baselineRequest(
  baseline: JsonValue,
  options: { workspacePath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  return {
    project: { id: "project-demo", name: "demo", path: workspacePath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_BASELINE_OPERATION,
    input: baseline,
    signal: options.signal ?? new AbortController().signal,
  };
}

describe("review→commit pipeline (review + commit: true)", () => {
  it("runs the exact review→git argv sequence with the pinned commit message", async () => {
    const workspace = await fixtureWorkspace();
    const signal = new AbortController().signal;
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT }, // doorstop review REQ0001
        { ...DEFAULT_RESULT, stdout: "true" }, // rev-parse --is-inside-work-tree
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml" }, // status
        { ...DEFAULT_RESULT }, // add
        { ...DEFAULT_RESULT }, // commit
        { ...DEFAULT_RESULT, stdout: "abc1234\n" }, // rev-parse --short HEAD
      ],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace, signal }),
    );
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.op).toBe("review");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.commit).toEqual({ status: "committed", sha: "abc1234" });
    // Exact argv sequence (plan step 18): review uid → rev-parse → status →
    // add → commit with the PINNED conforming message → rev-parse --short.
    // Every pathspec is literalized (`:(literal)`) so the matched set can
    // never widen beyond the one item file.
    expect(requests.map((request) => request.args)).toEqual([
      ["review", "REQ0001"],
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "--", ":(literal)reqs/REQ0001.yml"],
      ["add", "--", ":(literal)reqs/REQ0001.yml"],
      // Message format pinned: the item-baseline grep anchors on exactly
      // `^doorstop: review <uid>$`.
      ["commit", "-m", "doorstop: review REQ0001", "--", ":(literal)reqs/REQ0001.yml"],
      ["rev-parse", "--short", "HEAD"],
    ]);
    // doorstop execs use doorstopPath, git execs use gitPath; both get the
    // deadline-budget-bounded timeout and forward the per-invocation signal;
    // git runs with the GIT_* hygiene env.
    expect(requests.map((request) => request.file)).toEqual(["doorstop", "git", "git", "git", "git", "git"]);
    expect(requests[1]?.timeoutMs).toBe(8500);
    expect(requests[1]?.unsetEnv).toEqual(GIT_UNSET_ENV_EXPECTED);
    expect(requests.every((request) => request.signal === signal)).toBe(true);
  });

  it("reports clean (no add/commit) when the item file has no working-tree change", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "" }, // empty porcelain output → clean
      ],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["review", "REQ0001"],
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "--", ":(literal)reqs/REQ0001.yml"],
    ]);
  });

  it("skips (never commits) when the workspace is not inside a git repository", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT },
        {
          ...DEFAULT_RESULT,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        },
      ],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "skipped" });
    expect(requests.map((request) => request.args)).toEqual([
      ["review", "REQ0001"],
      ["rev-parse", "--is-inside-work-tree"],
    ]);
  });

  it("skips when rev-parse succeeds but outputs nothing (not a repository)", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT }, { ...DEFAULT_RESULT, stdout: "" }],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(2);
  });

  it("skips when rev-parse prints exit-0 'false' (bare repo / inside .git)", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT }, { ...DEFAULT_RESULT, stdout: "false\n" }],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "skipped" });
    // The work-tree check consults the stdout VALUE ("false" with exit 0),
    // not just emptiness — otherwise the NEXT git step would surface
    // `failed` instead of the plan's `skipped`.
    expect(requests).toHaveLength(2);
  });

  it("never runs git when the review failed (exit ≠ 0) — outcome skipped, attached", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 1, stdout: "", stderr: "1 item failed review" }],
    });
    const response = await requestDoorstopBackend(context, runRequest({ op: "review", uid: "REQ0001", commit: true }));
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.commit).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual(["review", "REQ0001"]);
  });

  it("never runs git when the review was killed — outcome skipped", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: null, signal: "SIGTERM", stdout: "partial" }],
    });
    const response = await requestDoorstopBackend(context, runRequest({ op: "review", uid: "REQ0001", commit: true }));
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1);
  });

  it("leaves the response without a commit field when the request has no commit flag", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext();
    const response = await requestDoorstopBackend(context, runRequest({ op: "review", uid: "REQ0001" }, { workspacePath: workspace }));
    const parsed = parseDoorstopRunResponse(response);
    expect("commit" in parsed).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("ignores a commit: true on a non-review op — no git execs, no commit field", async () => {
    const { context, requests } = createFakeContext();
    const response = await requestDoorstopBackend(context, runRequest({ op: "validate", commit: true }));
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.op).toBe("validate");
    expect("commit" in parsed).toBe(false);
    // The request's stray `commit` is dropped by the strict parser and the
    // backend gate (`run.op === "review" && run.commit === true`) — only
    // the doorstop exec ran, git never started.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual([]);
  });

  it("resolves with status failed and a bounded stderr excerpt when a git step errors", async () => {
    const workspace = await fixtureWorkspace();
    const hugeStderr = "fatal: pre-commit hook failed\n".repeat(200);
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml" },
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT, exitCode: 1, stderr: hugeStderr }, // commit fails
      ],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    const parsed = parseDoorstopRunResponse(response);
    // The review succeeded and its result stands — the commit failure is
    // narration, pinned as status failed + bounded stderr excerpt (~2 KiB).
    expect(parsed.exitCode).toBe(0);
    expect(parsed.commit?.status).toBe("failed");
    expect(parsed.commit?.stderr).toBeDefined();
    expect(parsed.commit?.stderr?.length ?? 0).toBeLessThan(hugeStderr.length);
    expect(parsed.commit?.stderr?.length ?? 0).toBeLessThanOrEqual(2048 + 40);
    expect(requests.map((request) => request.args)).toEqual([
      ["review", "REQ0001"],
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "--", ":(literal)reqs/REQ0001.yml"],
      ["add", "--", ":(literal)reqs/REQ0001.yml"],
      ["commit", "-m", "doorstop: review REQ0001", "--", ":(literal)reqs/REQ0001.yml"],
    ]);
  });

  it("maps a missing git binary to status failed with the git-not-found message", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      execFile: async (request) => {
        // Only git spawns fail: the doorstop review still succeeds.
        if (request.file === "git") throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
        return DEFAULT_RESULT;
      },
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    const parsed = parseDoorstopRunResponse(response);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.commit?.status).toBe("failed");
    expect(parsed.commit?.stderr).toMatch(
      /git not found on the sessiond host PATH — configure plugins\.opendoor\.settings\.gitPath/,
    );
    expect(requests.map((request) => request.file)).toEqual(["doorstop", "git"]);
  });

  it("skips the git phase when the review consumed the deadline budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { context, requests } = createFakeContext({
        execFile: async () => {
          // The review exec consumes the whole 9.5 s pipeline budget before
          // resolving; every following git step must be skipped.
          vi.setSystemTime(new Date(Date.now() + 10_000));
          return DEFAULT_RESULT;
        },
      });
      const response = await requestDoorstopBackend(
        context,
        runRequest({ op: "review", uid: "REQ0001", commit: true }),
      );
      expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "skipped" });
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the configured gitPath for every git exec (doorstop stays on doorstopPath)", async () => {
    const workspace = await fixtureWorkspace();
    const { context, requests } = createFakeContext({
      settings: { doorstopPath: "/opt/doorstop/bin/doorstop", gitPath: "/usr/local/bin/git", timeoutMs: 3000 },
      results: [
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml" },
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT },
        { ...DEFAULT_RESULT, stdout: "abc1234\n" },
      ],
    });
    const response = await requestDoorstopBackend(
      context,
      runRequest({ op: "review", uid: "REQ0001", commit: true }, { workspacePath: workspace }),
    );
    expect(parseDoorstopRunResponse(response).commit).toEqual({ status: "committed", sha: "abc1234" });
    expect(requests.map((request) => request.file)).toEqual([
      "/opt/doorstop/bin/doorstop",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
    ]);
    // git execs share the settings timeout, bounded by the pipeline budget.
    expect(requests[1]?.timeoutMs).toBe(3000);
  });
});

describe("doorstop.item-baseline handler", () => {
  it("returns { git: false } when the workspace is not a git repository", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, exitCode: 128, stdout: "", stderr: "fatal: not a git repository" },
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    expect(parseDoorstopBaselineResponse(response)).toEqual({ git: false, source: "none", candidates: [] });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
    ]);
  });

  it("returns { git: false } when rev-parse prints exit-0 'false' (bare repo / inside .git)", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, stdout: "false\n\n" }],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    expect(parseDoorstopBaselineResponse(response)).toEqual({ git: false, source: "none", candidates: [] });
    expect(requests).toHaveLength(1); // never reaches the log/show steps
  });

  it("rejects a non-baseline operation before any exec (direct-call guard, mirrors the run handler)", async () => {
    const { context, requests } = createFakeContext();
    await expect(
      requestDoorstopBaseline(context, baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }, { operation: "doorstop.purge" })),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });

  it("returns grep hits newest-first with their blobs (source review-commit)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" }, // rev-parse
        { ...DEFAULT_RESULT, stdout: "sha3\nsha2\nsha1\n" }, // grep log
        { ...DEFAULT_RESULT, stdout: "uid: REQ0001\ntext: newest\n" }, // show sha3
        { ...DEFAULT_RESULT, stdout: "uid: REQ0001\ntext: older\n" }, // show sha2
        { ...DEFAULT_RESULT, stdout: "uid: REQ0001\ntext: oldest\n" }, // show sha1
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.git).toBe(true);
    expect(parsed.source).toBe("review-commit");
    // git log order is newest-first; candidates carry that order verbatim.
    expect(parsed.candidates).toEqual([
      { sha: "sha3", blob: "uid: REQ0001\ntext: newest\n" },
      { sha: "sha2", blob: "uid: REQ0001\ntext: older\n" },
      { sha: "sha1", blob: "uid: REQ0001\ntext: oldest\n" },
    ]);
    // The grep argv pins the GREP_LIMIT cap, the anchored BRE pattern, the
    // %H format, the pathspec separator, and the literal pathspec magic
    // (a crafted `path` can never widen the log beyond this one file).
    expect(requests[1]?.args).toEqual([
      "log",
      "--max-count=20",
      "--grep=^doorstop: review REQ0001$",
      "--format=%H",
      "--",
      ":(literal)reqs/REQ0001.yml",
    ]);
    expect(requests.slice(2).map((request) => request.args)).toEqual([
      ["show", "sha3:reqs/REQ0001.yml"],
      ["show", "sha2:reqs/REQ0001.yml"],
      ["show", "sha1:reqs/REQ0001.yml"],
    ]);
  });

  it("falls back to the generic history walk (capped at 50) when the grep is empty", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "" }, // grep: zero hits
        { ...DEFAULT_RESULT, stdout: "h1\nh2\n" }, // history log
        { ...DEFAULT_RESULT, stdout: "older blob\n" },
        { ...DEFAULT_RESULT, stdout: "oldest blob\n" },
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.git).toBe(true);
    expect(parsed.source).toBe("history");
    // git log order is newest-first; candidates carry that order verbatim.
    expect(parsed.candidates).toEqual([
      { sha: "h1", blob: "older blob\n" },
      { sha: "h2", blob: "oldest blob\n" },
    ]);
    expect(requests[2]?.args).toEqual([
      "log",
      "--max-count=50",
      "--format=%H",
      "--",
      ":(literal)reqs/REQ0001.yml",
    ]);
  });

  it("returns source none with empty candidates when no history exists at all", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "" }, // grep: zero hits
        { ...DEFAULT_RESULT, stdout: "" }, // history: also empty
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    expect(parseDoorstopBaselineResponse(response)).toEqual({ git: true, source: "none", candidates: [] });
    expect(requests).toHaveLength(3);
  });

  it("translates the show tree path via the rev-parse --show-prefix line (nested workspace)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true\nws/\n" }, // rev-parse + prefix
        { ...DEFAULT_RESULT, stdout: "sha1\n" }, // grep log
        { ...DEFAULT_RESULT, stdout: "nested blob\n" }, // show
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.source).toBe("review-commit");
    expect(parsed.candidates).toEqual([{ sha: "sha1", blob: "nested blob\n" }]);
    // The log pathspec stays cwd-relative; the show TREE path is the path
    // translated by the prefix — the two agree below the repo root.
    expect(requests[1]?.args?.[5]).toBe(":(literal)reqs/REQ0001.yml");
    expect(requests[2]?.args).toEqual(["show", "sha1:ws/reqs/REQ0001.yml"]);
  });

  it("degrades to { git: false } when the rev-parse exec itself throws (e.g. missing git binary)", async () => {
    const { context, requests } = createFakeContext({
      execFile: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    // Read-only best-effort: a throwing rev-parse still resolves in the
    // contract shape, exactly like a non-repo checkout.
    expect(parseDoorstopBaselineResponse(response)).toEqual({ git: false, source: "none", candidates: [] });
    expect(requests).toHaveLength(1);
  });

  it("falls back to history when the grep log exec throws (fewer candidates, still resolving)", async () => {
    const { context, requests } = createFakeContext({
      execFile: async (request) => {
        if ((request.args ?? []).some((arg) => arg.startsWith("--grep="))) {
          throw new Error("git log aborted"); // host-attributed, not an exit result
        }
        if (request.args?.[0] === "rev-parse") return { ...DEFAULT_RESULT, stdout: "true" };
        if (request.args?.[1] === "--max-count=50") return { ...DEFAULT_RESULT, stdout: "h1\nh2\n" };
        return { ...DEFAULT_RESULT, stdout: "blob\n" };
      },
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.git).toBe(true);
    expect(parsed.source).toBe("history");
    expect(parsed.candidates).toEqual([
      { sha: "h1", blob: "blob\n" },
      { sha: "h2", blob: "blob\n" },
    ]);
  });

  it("skips a candidate whose show exec is killed (fewer candidates, response still resolves)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "sha1\nsha2\n" },
        // sha1's show is KILLED (never exited, no output): the candidate is
        // skipped — nothing in the read-only fetch is fatal.
        { ...DEFAULT_RESULT, exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" },
        { ...DEFAULT_RESULT, stdout: "sha2 blob\n" },
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.git).toBe(true);
    expect(parsed.source).toBe("review-commit");
    expect(parsed.candidates).toEqual([{ sha: "sha2", blob: "sha2 blob\n" }]);
  });

  it("skips candidate blobs over the 256 KiB cap (never fatal)", async () => {
    const bigBlob = "x".repeat(DOORSTOP_BASELINE_BLOB_MAX + 1);
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "sha1\nsha0\n" },
        { ...DEFAULT_RESULT, stdout: bigBlob }, // oversize → skipped
        { ...DEFAULT_RESULT, stdout: "small blob\n" },
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    const parsed = parseDoorstopBaselineResponse(response);
    expect(parsed.source).toBe("review-commit");
    expect(parsed.candidates).toEqual([{ sha: "sha0", blob: "small blob\n" }]);
  });

  it("rejects an invalid uid or path before any exec", async () => {
    const { context, requests } = createFakeContext();
    await expect(
      requestDoorstopBaseline(context, baselineRequest({ uid: "bad uid", path: "reqs/REQ0001.yml" })),
    ).rejects.toThrow(/Invalid doorstop UID in field: uid/);
    await expect(
      requestDoorstopBaseline(context, baselineRequest({ uid: "REQ0001", path: "../escape.yml" })),
    ).rejects.toThrow(/Invalid doorstop item path/);
    expect(requests).toHaveLength(0);
  });

  it("honors the configured gitPath (and keeps doorstopPath untouched)", async () => {
    const { context, requests } = createFakeContext({
      settings: { gitPath: "/usr/local/bin/git" },
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "sha1\n" },
        { ...DEFAULT_RESULT, stdout: "blob content\n" },
      ],
    });
    const response = await requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }),
    );
    expect(parseDoorstopBaselineResponse(response).source).toBe("review-commit");
    expect(requests.map((request) => request.file)).toEqual(["/usr/local/bin/git", "/usr/local/bin/git", "/usr/local/bin/git"]);
  });
});

describe("cross-operation serialization", () => {
  it("serializes BOTH handlers per workspace path (a baseline waits behind a run; other workspaces proceed)", async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    const { context, requests } = createFakeContext({
      execFile: async (request) => {
        calls += 1;
        if (calls === 1) {
          // Park the FIRST exec (the review run) until the test releases it,
          // proving the same-workspace baseline queues behind it.
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return { ...DEFAULT_RESULT, stdout: request.args?.[0] === "rev-parse" ? "true" : "sha1\n" };
      },
    });
    const workspace = "/workspace/demo checkout";
    const signal = new AbortController().signal;
    const first = requestDoorstopBackend(context, runRequest({ op: "review", uid: "REQ0001" }, { workspacePath: workspace, signal }));
    await tick();
    // Same-workspace baseline queues behind the parked review…
    const second = requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }, { workspacePath: workspace, signal }),
    );
    await tick();
    expect(calls).toBe(1);
    // …while a different workspace proceeds concurrently — its full rev-
    // parse → grep → show baseline runs (3 execs) without waiting.
    const other = requestDoorstopBaseline(
      context,
      baselineRequest({ uid: "REQ0001", path: "reqs/REQ0001.yml" }, { workspacePath: "/workspace/other" }),
    );
    await tick();
    expect(calls).toBe(4);
    gates[0]?.();
    await Promise.all([first, second, other]);
    // Exec order proves the chaining: A's review → (B's baseline slipped
    // in — never serialized) → A's baseline ran only after the review.
    expect(requests.map((request) => request.cwd)).toEqual([
      workspace,
      "/workspace/other",
      "/workspace/other",
      "/workspace/other",
      workspace,
      workspace,
      workspace,
    ]);
  });

  it("serializes the git handlers per workspace path (a status waits behind a parked run; other workspaces proceed)", async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    const { context, requests } = createFakeContext({
      execFile: async (request) => {
        calls += 1;
        if (calls === 1) {
          // Park the FIRST exec (the doorstop run) until the test releases
          // it, proving the same-workspace status queues behind it.
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        const args = request.args ?? [];
        if (args[0] === "rev-parse") return { ...DEFAULT_RESULT, stdout: "true" };
        // The stage's plain porcelain vs the status's v1 -z -b porcelain.
        if (args[0] === "status" && !args.includes("--porcelain=v1")) return { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0" };
        if (args[0] === "status") return { ...DEFAULT_RESULT, stdout: "## main\0 M x.txt\0" };
        if (args[0] === "diff") return { ...DEFAULT_RESULT, exitCode: 1 };
        return DEFAULT_RESULT;
      },
    });
    const workspace = "/workspace/demo checkout";
    const signal = new AbortController().signal;
    const first = requestDoorstopBackend(context, runRequest({ op: "validate" }, { workspacePath: workspace, signal }));
    await tick();
    const second = requestDoorstopGitStatus(context, gitStatusRequest({ workspacePath: workspace, signal }));
    await tick();
    expect(calls).toBe(1); // same-workspace status queues behind the parked run
    // A different workspace proceeds concurrently — its full stage
    // (rev-parse → status → add) runs without waiting.
    const other = requestDoorstopGitStage(
      context,
      gitStageRequest({ paths: ["reqs/REQ0001.yml"] }, { workspacePath: "/workspace/other", signal }),
    );
    await tick();
    expect(calls).toBe(4);
    gates[0]?.();
    const [firstResult, secondResult, otherResult] = await Promise.all([first, second, other]);
    expect(parseDoorstopRunResponse(firstResult).op).toBe("validate");
    expect(parseDoorstopGitStatusResponse(secondResult).git).toBe(true);
    expect(parseDoorstopGitStageResponse(otherResult)).toEqual({ status: "staged", staged: 1 });
    // Exec order proves the chaining: A's parked run → (B's stage slipped
    // in — never serialized) → A's status ran only after the run.
    expect(requests.map((request) => request.cwd)).toEqual([
      workspace,
      "/workspace/other",
      "/workspace/other",
      "/workspace/other",
      workspace,
      workspace,
    ]);
  });
});

// --- git operations trio (plan-add-git-actions.md Phase F step 21) -----------

/** One `doorstop.git-status` provider request (the contract's `{}`). */
function gitStatusRequest(
  options: { workspacePath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  return {
    project: { id: "project-demo", name: "demo", path: workspacePath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_GIT_STATUS_OPERATION,
    input: {},
    signal: options.signal ?? new AbortController().signal,
  };
}

/** One `doorstop.git-stage` provider request. `input` is widened to
 *  `JsonValue` so junk-request cases need no casts. */
function gitStageRequest(
  stage: JsonValue,
  options: { workspacePath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  return {
    project: { id: "project-demo", name: "demo", path: workspacePath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_GIT_STAGE_OPERATION,
    input: stage,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** One `doorstop.git-unstage` provider request. `input` is widened to
 *  `JsonValue` so junk-request cases need no casts. */
function gitUnstageRequest(
  unstage: JsonValue,
  options: { workspacePath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  return {
    project: { id: "project-demo", name: "demo", path: workspacePath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_GIT_UNSTAGE_OPERATION,
    input: unstage,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** One `doorstop.git-commit` provider request. `input` is widened to
 *  `JsonValue` so junk-request cases need no casts. */
function gitCommitRequest(
  commit: JsonValue,
  options: { workspacePath?: string; signal?: AbortSignal; operation?: string } = {},
): ProviderRequestContext {
  const workspacePath = options.workspacePath ?? "/workspace/demo checkout";
  return {
    project: { id: "project-demo", name: "demo", path: workspacePath },
    workspace: { key: workspacePath, path: workspacePath, label: "demo", isMain: true },
    operation: options.operation ?? DOORSTOP_GIT_COMMIT_OPERATION,
    input: commit,
    signal: options.signal ?? new AbortController().signal,
  };
}

describe("doorstop.git-status handler", () => {
  it("runs the exact rev-parse + porcelain argv pair and parses the fixture into per-file states and counts", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" }, // rev-parse repo check
        {
          ...DEFAULT_RESULT,
          // -z records: the `## main...origin/main [ahead 1, behind 2]`
          // header, then staged-only (M ), unstaged-only ( M), both
          // columns (MM), and an untracked file (??).
          stdout:
            "## main...origin/main [ahead 1, behind 2]\0" +
            "M  staged.txt\0" +
            " M unstaged.txt\0" +
            "MM both.txt\0" +
            "?? untracked.txt\0",
        },
      ],
    });
    const response = await requestDoorstopGitStatus(context, gitStatusRequest());
    const parsed = parseDoorstopGitStatusResponse(response);
    expect(parsed.git).toBe(true);
    expect(parsed.branch).toBe("main");
    expect(parsed.ahead).toBe(1);
    expect(parsed.behind).toBe(2);
    expect(parsed.files).toEqual([
      { path: "staged.txt", index: "modified", workingTree: "unmodified" },
      { path: "unstaged.txt", index: "unmodified", workingTree: "modified" },
      { path: "both.txt", index: "modified", workingTree: "modified" },
      { path: "untracked.txt", index: "untracked", workingTree: "untracked" },
    ]);
    // `staged` counts the index (X) column only — staged.txt and both.txt;
    // `dirty` counts any non-unmodified state — all four files. The two
    // counts stay distinct (the per-item-staging contract requirement).
    expect(parsed.staged).toBe(2);
    expect(parsed.dirty).toBe(4);
    // Exact argv (plan Phase B step 6); git file + GIT_* hygiene env.
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
      ["status", "--porcelain=v1", "-z", "-b"],
    ]);
    expect(requests[0]?.file).toBe("git");
    expect(requests[0]?.unsetEnv).toEqual(GIT_UNSET_ENV_EXPECTED);
  });

  it("reports no branch on a detached HEAD and no ahead/behind without an upstream", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "## HEAD (no branch)\0" },
      ],
    });
    const parsed = parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest()));
    expect(parsed.git).toBe(true);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.ahead).toBeUndefined();
    expect(parsed.behind).toBeUndefined();
    expect(parsed.files).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("decodes the unborn-branch header and skips a rename's separate source record", async () => {
    const { context } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "## No commits yet on main\0RM renamed.txt\0old.txt\0" },
      ],
    });
    const parsed = parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest()));
    expect(parsed.git).toBe(true);
    expect(parsed.branch).toBe("main");
    // The `old.txt` record is the rename SOURCE path — consumed, never an
    // entry of its own; `RM` maps to index renamed + workingTree modified.
    expect(parsed.files).toEqual([{ path: "renamed.txt", index: "renamed", workingTree: "modified" }]);
    expect(parsed.staged).toBe(1);
    expect(parsed.dirty).toBe(1);
  });

  it("degrades to { git: false } (resolves, never rejects) for a non-repo, a killed exec, and a missing git binary", async () => {
    // Non-repo: rev-parse exits 128.
    const nonRepo = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }],
    });
    expect(
      parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(nonRepo.context, gitStatusRequest())),
    ).toEqual({ git: false, staged: 0, dirty: 0, files: [] });

    // Killed: the rev-parse exec never exits (exitCode null, signal set).
    const killed = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" }],
    });
    expect(
      parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(killed.context, gitStatusRequest())),
    ).toEqual({ git: false, staged: 0, dirty: 0, files: [] });

    // Missing binary: execFile throws ENOENT.
    const missing = createFakeContext({ execError: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) });
    expect(
      parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(missing.context, gitStatusRequest())),
    ).toEqual({ git: false, staged: 0, dirty: 0, files: [] });
  });

  it("caps files at 200 while keeping the counts full-output", async () => {
    const records: string[] = [];
    for (let n = 0; n < 250; n += 1) records.push(`M  file-${String(n).padStart(3, "0")}.txt`);
    const { context } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: `## main\0${records.join("\0")}\0` },
      ],
    });
    const parsed = parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest()));
    expect(parsed.staged).toBe(250);
    expect(parsed.dirty).toBe(250);
    expect(parsed.files).toHaveLength(DOORSTOP_GIT_STATUS_FILES_MAX);
  });

  it("treats rev-parse's exit-0 'false' (bare repo / inside .git) as not-a-repo without touching the porcelain", async () => {
    const { context, requests } = createFakeContext({ results: [{ ...DEFAULT_RESULT, stdout: "false\n" }] });
    expect(
      parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest())),
    ).toEqual({ git: false, staged: 0, dirty: 0, files: [] });
    expect(requests).toHaveLength(1);
  });

  it("accepts the --show-prefix two-line rev-parse output (nested workspace) for the repo check", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true\nreqs/\n" }, // cwd→root prefix on line two
        { ...DEFAULT_RESULT, stdout: "## main\0 M reqs/REQ0001.yml\0" },
      ],
    });
    const parsed = parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest()));
    expect(parsed.git).toBe(true);
    expect(parsed.files).toEqual([{ path: "reqs/REQ0001.yml", index: "unmodified", workingTree: "modified" }]);
  });

  it("decodes a zero-side ahead/behind bracket — git omits the zero side ([ahead 1] alone means behind 0)", async () => {
    const { context } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "## main...origin/main [ahead 1]\0" },
      ],
    });
    const parsed = parseDoorstopGitStatusResponse(await requestDoorstopGitStatus(context, gitStatusRequest()));
    expect(parsed.ahead).toBe(1);
    expect(parsed.behind).toBeUndefined(); // the omitted zero side stays absent
  });

  it("honors the configured gitPath for every git exec of the status", async () => {
    const { context, requests } = createFakeContext({
      settings: { gitPath: "/usr/local/bin/git" },
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "## main\0 M reqs/REQ0001.yml\0" },
      ],
    });
    await requestDoorstopGitStatus(context, gitStatusRequest());
    expect(requests.map((request) => request.file)).toEqual(["/usr/local/bin/git", "/usr/local/bin/git"]);
    expect(requests[0]?.timeoutMs).toBe(8500);
  });

  it("rejects a non-status operation before any exec (direct-call guard, mirrors the run/baseline handlers)", async () => {
    const { context, requests } = createFakeContext();
    await expect(
      requestDoorstopGitStatus(context, gitStatusRequest({ operation: "doorstop.purge" })),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });
});

describe("doorstop.git-stage handler", () => {
  it("runs the exact rev-parse → status → add argv sequence with literalized paths", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0 M reqs/REQ0002.yml\0" },
        { ...DEFAULT_RESULT }, // add
      ],
    });
    const response = await requestDoorstopGitStage(
      context,
      gitStageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }),
    );
    expect(parseDoorstopGitStageResponse(response)).toEqual({ status: "staged", staged: 2 });
    // Every pathspec is literalized (`:(literal)`) so a crafted path can
    // never widen the matched set beyond the Doorstop files.
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml", ":(literal)reqs/REQ0002.yml"],
      ["add", "--", ":(literal)reqs/REQ0001.yml", ":(literal)reqs/REQ0002.yml"],
    ]);
  });

  it("reports clean (no add exec) when every managed path already matches the index/HEAD", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "" },
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }))),
    ).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml"],
    ]);
  });

  it("stages a deleted path via add — porcelain D counted as one changed path", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " D reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT }, // add
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }))),
    ).toEqual({ status: "staged", staged: 1 });
    // The deletion is staged for removal like any other change.
    expect(requests[2]?.args).toEqual(["add", "--", ":(literal)reqs/REQ0001.yml"]);
  });

  it("skips on a non-repo workspace and on an exhausted deadline budget", async () => {
    const nonRepo = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(nonRepo.context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }))),
    ).toEqual({ status: "skipped" });

    // First exec consumes the whole 9.5 s budget → the phase is SKIPPED.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const exhausted = createFakeContext({
        execFile: async () => {
          vi.setSystemTime(new Date(Date.now() + 10_000));
          return DEFAULT_RESULT;
        },
      });
      const response = await requestDoorstopGitStage(exhausted.context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }));
      expect(parseDoorstopGitStageResponse(response)).toEqual({ status: "skipped" });
      expect(exhausted.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses an add failure into status failed with a bounded excerpt (response resolves)", async () => {
    const hugeStderr = "fatal: could not open index\n".repeat(200);
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT, exitCode: 128, stderr: hugeStderr },
      ],
    });
    // Resolves, never rejects — the outcome is narration.
    const response = await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }));
    const parsed = parseDoorstopGitStageResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toBeDefined();
    expect(parsed.stderr?.length ?? 0).toBeLessThan(hugeStderr.length);
    expect(parsed.stderr?.length ?? 0).toBeLessThanOrEqual(2048 + 40);
  });

  it("rejects out-of-grammar requests and a non-stage operation before any exec", async () => {
    const { context, requests } = createFakeContext();
    await expect(requestDoorstopGitStage(context, gitStageRequest({ paths: [] }))).rejects.toThrow(
      /at least one path is required/,
    );
    await expect(requestDoorstopGitStage(context, gitStageRequest({ paths: ["../escape.yml"] }))).rejects.toThrow(
      /Invalid doorstop item path in field: paths/,
    );
    await expect(requestDoorstopGitStage(context, gitStageRequest({}))).rejects.toThrow(/paths must be an array/);
    await expect(
      requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }, { operation: "doorstop.purge" })),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });

  it("honors the configured gitPath for every git exec of the stage", async () => {
    const { context, requests } = createFakeContext({
      settings: { gitPath: "/usr/local/bin/git" },
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }));
    expect(requests.map((request) => request.file)).toEqual([
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
    ]);
    // git execs share the settings timeout, bounded by the pipeline budget.
    expect(requests[0]?.timeoutMs).toBe(8500);
  });

  it("is idempotent across a staged deletion: a second Stage all reports clean with no add exec", async () => {
    // After the first Stage all staged a deletion, porcelain shows `D ` —
    // the path exists in NEITHER the index NOR the worktree, and a bare
    // `git add -- <path>` would abort the WHOLE add with "did not match any
    // files" (verified against real git). The worktree-column selection
    // must skip it: nothing left to stage → clean (the plan's
    // "idempotent, and cheap to repeat" promise).
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "D  reqs/REQ0001.yml\0" },
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }))),
    ).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml"],
    ]);
  });

  it("skips already-staged paths (incl. a staged deletion) and stages the worktree-changed ones in ONE add", async () => {
    // The severity pin: one bad pathspec (the staged deletion) must not
    // sink the whole add — the other requested changes still land, and the
    // narrated count covers only the paths the add actually selected.
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        {
          ...DEFAULT_RESULT,
          // `D ` staged deletion (would fatal a re-add) + ` M` unstaged mod
          // + `MM` both columns + `??` untracked.
          stdout: "D  reqs/REQ0001.yml\0 M reqs/REQ0002.yml\0MM reqs/REQ0003.yml\0?? reqs/REQ0004.yml\0",
        },
        { ...DEFAULT_RESULT }, // add
      ],
    });
    const response = await requestDoorstopGitStage(
      context,
      gitStageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml", "reqs/REQ0003.yml", "reqs/REQ0004.yml"] }),
    );
    expect(parseDoorstopGitStageResponse(response)).toEqual({ status: "staged", staged: 3 });
    // The already-staged deletion is NOT re-added; the add covers exactly
    // the worktree-changed paths.
    expect(requests[2]?.args).toEqual([
      "add",
      "--",
      ":(literal)reqs/REQ0002.yml",
      ":(literal)reqs/REQ0003.yml",
      ":(literal)reqs/REQ0004.yml",
    ]);
  });

  it("stages rename records at the renamed-to path and never re-adds a fully-staged rename", async () => {
    // Fully staged rename (`R ` — via git mv, no further worktree change):
    // nothing to add — the SOURCE path is in neither index nor worktree
    // (re-adding it would fatal), and the `-z` output pairs it as a bare
    // follow-up record that is consumed, never added.
    const staged = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "R  reqs/REQ0002.yml\0reqs/REQ0001.yml\0" }, // new\0old (the record's own path is the NEW one)
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(staged.context, gitStageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }))),
    ).toEqual({ status: "clean" });
    expect(staged.requests).toHaveLength(2); // no add exec

    // Partly staged rename (`RM` — worktree modified after git mv): the
    // worktree side lives at the renamed-to path.
    const partial = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "RM reqs/REQ0002.yml\0reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(partial.context, gitStageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }))),
    ).toEqual({ status: "staged", staged: 1 });
    expect(partial.requests[2]?.args).toEqual(["add", "--", ":(literal)reqs/REQ0002.yml"]);
  });

  it("stages non-ASCII and space-containing paths verbatim (the -z fetch never re-quotes them)", async () => {
    // The reason the stage porcelain is `-z`: plain porcelain would
    // C-escape `reqs/REQ-\303\274rgente.yml` and quote `reqs/my file.yml`
    // (core.quotePath and space quoting), silently dropping both from the
    // add selection; -z prints them verbatim so they map back onto the
    // request paths.
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "?? reqs/REQ-\u00fcrgente.yml\0 M reqs/my file.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ-\u00fcrgente.yml", "reqs/my file.yml"] }))),
    ).toEqual({ status: "staged", staged: 2 });
    expect(requests[2]?.args).toEqual([
      "add",
      "--",
      ":(literal)reqs/REQ-\u00fcrgente.yml",
      ":(literal)reqs/my file.yml",
    ]);
  });

  it("maps a missing git binary to status failed with the git-not-found message (resolves)", async () => {
    const { context, requests } = createFakeContext({
      execFile: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    const response = await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }));
    const parsed = parseDoorstopGitStageResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toMatch(
      /git not found on the sessiond host PATH — configure plugins\.opendoor\.settings\.gitPath/,
    );
    expect(requests).toHaveLength(1);
  });

  it("skips on a bare repo or .git directory (rev-parse prints 'false' with exit 0)", async () => {
    const { context, requests } = createFakeContext({ results: [{ ...DEFAULT_RESULT, stdout: "false\n" }] });
    expect(
      parseDoorstopGitStageResponse(await requestDoorstopGitStage(context, gitStageRequest({ paths: ["reqs/REQ0001.yml"] }))),
    ).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1); // never reaches the porcelain/add steps
  });
});

describe("doorstop.git-unstage handler", () => {
  it("runs the exact rev-parse → status → reset argv sequence and selects only the index (X) column", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        // unstaged-only (` M` — X blank → skip) + staged-only (`M ` → reset).
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0M  reqs/REQ0002.yml\0" },
        { ...DEFAULT_RESULT }, // reset
      ],
    });
    const response = await requestDoorstopGitUnstage(
      context,
      gitUnstageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }),
    );
    expect(parseDoorstopGitUnstageResponse(response)).toEqual({ status: "unstaged", unstaged: 1 });
    // Every pathspec is literalized (`:(literal)`) so a crafted path can
    // never widen the matched set beyond the Doorstop files; only the
    // X-changed path reaches `git reset`.
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml", ":(literal)reqs/REQ0002.yml"],
      ["reset", "-q", "--", ":(literal)reqs/REQ0002.yml"],
    ]);
    expect(requests[0]?.unsetEnv).toEqual(GIT_UNSET_ENV_EXPECTED);
  });

  it("reports clean (no reset exec) when no requested path has an index change", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        // Both records have a BLANK X column (unstaged modification and
        // unstaged deletion): the worktree (Y) column is irrelevant to
        // unstaging, so neither is selected and no reset runs.
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0 D reqs/REQ0002.yml\0" },
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] })),
      ),
    ).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml", ":(literal)reqs/REQ0002.yml"],
    ]);
  });

  it("never selects untracked (??) or unmerged (UU/AA/DD) records: no reset exec, narrated clean", async () => {
    // Untracked/ignored paths are not in the index (reset would be a no-op
    // and the narrated count would lie); an unmerged entry must never be
    // touched server-side (`git reset` silently resolves the conflict).
    for (const record of ["??", "!!", "UU", "AA", "DD"]) {
      const { context, requests } = createFakeContext({
        results: [
          { ...DEFAULT_RESULT, stdout: "true" },
          { ...DEFAULT_RESULT, stdout: `${record} reqs/REQ0001.yml\0` },
        ],
      });
      expect(
        parseDoorstopGitUnstageResponse(
          await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
        ),
        record,
      ).toEqual({ status: "clean" });
      expect(requests.map((request) => request.args), record).toEqual([
        ["rev-parse", "--is-inside-work-tree"],
        ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml"],
      ]);
    }
  });

  it("selects only the staged path of a mixed request (staged M + untracked ??)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "M  reqs/REQ0001.yml\0?? reqs/REQ0002.yml\0" },
        { ...DEFAULT_RESULT }, // reset
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] })),
      ),
    ).toEqual({ status: "unstaged", unstaged: 1 });
    expect(requests[2]?.args).toEqual(["reset", "-q", "--", ":(literal)reqs/REQ0001.yml"]);
  });

  it("resets staged additions (A ) and staged deletions (D ) — the shapes git add would fatal on", async () => {
    const added = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "A  reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(added.context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
      ),
    ).toEqual({ status: "unstaged", unstaged: 1 });
    expect(added.requests[2]?.args).toEqual(["reset", "-q", "--", ":(literal)reqs/REQ0001.yml"]);

    const deleted = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "D  reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(deleted.context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
      ),
    ).toEqual({ status: "unstaged", unstaged: 1 });
    expect(deleted.requests[2]?.args).toEqual(["reset", "-q", "--", ":(literal)reqs/REQ0001.yml"]);
  });

  it("resets a staged rename at the renamed-to path and never selects the bare source record", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        // Fully staged rename: `R  new\0old\0` — the record's own path is
        // the NEW one, the bare old-path record is consumed, never reset.
        { ...DEFAULT_RESULT, stdout: "R  reqs/REQ0002.yml\0reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(
          context,
          gitUnstageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }),
        ),
      ),
    ).toEqual({ status: "unstaged", unstaged: 1 });
    expect(requests[2]?.args).toEqual(["reset", "-q", "--", ":(literal)reqs/REQ0002.yml"]);
  });

  it("resets a staged copy at the copied-to path and never selects the bare source record", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        // Staged copy: `C  new\0old\0` — the same NEW-then-SOURCE record
        // shape as a rename, so the bare source record is consumed too.
        { ...DEFAULT_RESULT, stdout: "C  reqs/REQ0002.yml\0reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(
          context,
          gitUnstageRequest({ paths: ["reqs/REQ0001.yml", "reqs/REQ0002.yml"] }),
        ),
      ),
    ).toEqual({ status: "unstaged", unstaged: 1 });
    expect(requests[2]?.args).toEqual(["reset", "-q", "--", ":(literal)reqs/REQ0002.yml"]);
  });

  it("skips on a non-repo workspace (rev-parse false) and on an exhausted deadline budget", async () => {
    const nonRepo = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(nonRepo.context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
      ),
    ).toEqual({ status: "skipped" });

    // rev-parse prints `false` with exit 0 on a bare repo / .git dir.
    const bare = createFakeContext({ results: [{ ...DEFAULT_RESULT, stdout: "false\n" }] });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(bare.context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
      ),
    ).toEqual({ status: "skipped" });

    // First exec consumes the whole 9.5 s budget → the phase is SKIPPED.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const exhausted = createFakeContext({
        execFile: async () => {
          vi.setSystemTime(new Date(Date.now() + 10_000));
          return DEFAULT_RESULT;
        },
      });
      const response = await requestDoorstopGitUnstage(
        exhausted.context,
        gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] }),
      );
      expect(parseDoorstopGitUnstageResponse(response)).toEqual({ status: "skipped" });
      expect(exhausted.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses a reset failure into status failed with a bounded excerpt (response resolves)", async () => {
    const hugeStderr = "fatal: could not resolve HEAD\n".repeat(200);
    const { context } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "M  reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT, exitCode: 128, stderr: hugeStderr },
      ],
    });
    // Resolves, never rejects — the outcome is narration.
    const response = await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] }));
    const parsed = parseDoorstopGitUnstageResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toBeDefined();
    expect(parsed.stderr?.length ?? 0).toBeLessThan(hugeStderr.length);
    expect(parsed.stderr?.length ?? 0).toBeLessThanOrEqual(2048 + 40);
    // The excerpt is a PREFIX of the git stderr plus the truncation marker —
    // pinning the content, not just the length bound.
    const excerpt = parsed.stderr ?? "";
    const marker = "\n… (stderr truncated)";
    expect(excerpt.endsWith(marker)).toBe(true);
    expect(hugeStderr.startsWith(excerpt.slice(0, -marker.length))).toBe(true);
    expect(excerpt.slice(0, -marker.length).length).toBeGreaterThan(0);
  });

  it("maps a missing git binary to status failed with the git-not-found message (resolves)", async () => {
    const { context, requests } = createFakeContext({
      execFile: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    const response = await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] }));
    const parsed = parseDoorstopGitUnstageResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toMatch(
      /git not found on the sessiond host PATH — configure plugins\.opendoor\.settings\.gitPath/,
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects out-of-grammar requests and a non-unstage operation before any exec", async () => {
    const { context, requests } = createFakeContext();
    await expect(requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: [] }))).rejects.toThrow(
      /at least one path is required/,
    );
    await expect(requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["../escape.yml"] }))).rejects.toThrow(
      /Invalid doorstop item path in field: paths/,
    );
    await expect(requestDoorstopGitUnstage(context, gitUnstageRequest({}))).rejects.toThrow(/paths must be an array/);
    await expect(
      requestDoorstopGitUnstage(
        context,
        gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] }, { operation: "doorstop.purge" }),
      ),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });

  it("honors the configured gitPath for every git exec of the unstage", async () => {
    const { context, requests } = createFakeContext({
      settings: { gitPath: "/usr/local/bin/git" },
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: "M  reqs/REQ0001.yml\0" },
        { ...DEFAULT_RESULT },
      ],
    });
    await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] }));
    expect(requests.map((request) => request.file)).toEqual([
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
    ]);
    // git execs share the settings timeout, bounded by the pipeline budget.
    expect(requests[0]?.timeoutMs).toBe(8500);
  });

  it("unstage is idempotent: a second run over an already-clean index reports clean with no reset exec", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, stdout: " M reqs/REQ0001.yml\0" }, // already unstaged
      ],
    });
    expect(
      parseDoorstopGitUnstageResponse(
        await requestDoorstopGitUnstage(context, gitUnstageRequest({ paths: ["reqs/REQ0001.yml"] })),
      ),
    ).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain", "-z", "--", ":(literal)reqs/REQ0001.yml"],
    ]);
  });
});

describe("doorstop.git-commit handler", () => {
  it("runs the exact rev-parse → diff --cached → commit → rev-parse --short sequence with NO add and NO pathspec", async () => {
    const signal = new AbortController().signal;
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 1 }, // diff --cached --quiet: staged changes exist
        { ...DEFAULT_RESULT }, // commit
        { ...DEFAULT_RESULT, stdout: "abc1234\n" }, // rev-parse --short HEAD
      ],
    });
    const response = await requestDoorstopGitCommit(context, gitCommitRequest({ message: "Add doorstop docs" }, { signal }));
    expect(parseDoorstopGitCommitResponse(response)).toEqual({ status: "committed", sha: "abc1234" });
    // Exact argv sequence (plan Phase B step 8): the commit records the
    // staged index with NO pathspec and NO add — `--` never appears, `add`
    // never appears.
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--cached", "--quiet"],
      ["commit", "-m", "Add doorstop docs"],
      ["rev-parse", "--short", "HEAD"],
    ]);
    expect(requests.some((request) => request.args?.[0] === "add")).toBe(false);
    expect(requests.some((request) => request.args?.includes("--") ?? false)).toBe(false);
    // Every git exec forwards the per-invocation signal and the GIT_* env.
    expect(requests.every((request) => request.signal === signal)).toBe(true);
    expect(requests[0]?.unsetEnv).toEqual(GIT_UNSET_ENV_EXPECTED);
  });

  it("reports clean (no commit exec) when nothing is staged (diff exit 0)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 0 },
      ],
    });
    expect(
      parseDoorstopGitCommitResponse(await requestDoorstopGitCommit(context, gitCommitRequest({ message: "nothing staged" }))),
    ).toEqual({ status: "clean" });
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--cached", "--quiet"],
    ]);
  });

  it("treats a killed or non-1 diff exit as failed, never clean", async () => {
    // Killed exec: exitCode null — a real interruption, not "nothing staged".
    const killed = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: null, signal: "SIGKILL", stdout: "", stderr: "" },
      ],
    });
    expect(
      parseDoorstopGitCommitResponse(await requestDoorstopGitCommit(killed.context, gitCommitRequest({ message: "killed" }))),
    ).toEqual({ status: "failed", stderr: expect.any(String) });

    // Diff exit 2: a real git error, not "clean".
    const errorExit = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 2, stdout: "", stderr: "fatal: bad revision" },
      ],
    });
    const parsed = parseDoorstopGitCommitResponse(
      await requestDoorstopGitCommit(errorExit.context, gitCommitRequest({ message: "error" })),
    );
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toMatch(/fatal: bad revision/);
  });

  it("skips on a non-repo workspace", async () => {
    const { context, requests } = createFakeContext({
      results: [{ ...DEFAULT_RESULT, exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }],
    });
    expect(
      parseDoorstopGitCommitResponse(await requestDoorstopGitCommit(context, gitCommitRequest({ message: "m" }))),
    ).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1);
  });

  it("surfaces a failing pre-commit hook's stderr in the bounded failed excerpt", async () => {
    const hugeStderr = "# pre-commit hook failed\nlint errors found\n".repeat(200);
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 1 },
        { ...DEFAULT_RESULT, exitCode: 1, stderr: hugeStderr }, // commit rejected by the hook
      ],
    });
    const response = await requestDoorstopGitCommit(context, gitCommitRequest({ message: "docs" }));
    const parsed = parseDoorstopGitCommitResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toBeDefined();
    expect(parsed.stderr?.length ?? 0).toBeLessThan(hugeStderr.length);
    expect(parsed.stderr?.length ?? 0).toBeLessThanOrEqual(2048 + 40);
    expect(requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--cached", "--quiet"],
      ["commit", "-m", "docs"],
    ]);
  });

  it("maps a missing git binary to status failed with the git-not-found message (resolves)", async () => {
    const { context, requests } = createFakeContext({
      execFile: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    const response = await requestDoorstopGitCommit(context, gitCommitRequest({ message: "m" }));
    const parsed = parseDoorstopGitCommitResponse(response);
    expect(parsed.status).toBe("failed");
    expect(parsed.stderr).toMatch(
      /git not found on the sessiond host PATH — configure plugins\.opendoor\.settings\.gitPath/,
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects out-of-grammar messages and a non-commit operation before any exec", async () => {
    const { context, requests } = createFakeContext();
    const badMessages: Array<JsonValue> = [
      { message: "" }, // empty — git would open $EDITOR and hang the exec
      { message: "   " }, // whitespace-only — git aborts after cleanup
      { message: "two\nlines" }, // control characters / multi-line
      { message: "a".repeat(2001) }, // over the 2 000-char cap
      {}, // missing field
    ];
    for (const bad of badMessages) {
      await expect(requestDoorstopGitCommit(context, gitCommitRequest(bad))).rejects.toThrow(
        /(Invalid git commit message|Expected string field: message)/,
      );
    }
    await expect(
      requestDoorstopGitCommit(context, gitCommitRequest({ message: "m" }, { operation: "doorstop.purge" })),
    ).rejects.toThrow(/opendoor: unsupported workspace backend operation: doorstop\.purge/);
    expect(requests).toHaveLength(0);
  });

  it("narrates committed with the bracket sha when rev-parse --short fails after the commit landed", async () => {
    // git commit prints the short sha in its first stdout line; a failing
    // rev-parse after a successful commit must not turn a landed commit
    // into `failed`/`skipped` narration.
    const brackets = [
      "[main abc1234] docs\n", // branch
      "[detached HEAD abc1234] docs\n", // detached HEAD
      "[main (root-commit) abc1234] docs\n", // first commit
    ];
    for (const bracket of brackets) {
      const { context, requests } = createFakeContext({
        results: [
          { ...DEFAULT_RESULT, stdout: "true" },
          { ...DEFAULT_RESULT, exitCode: 1 }, // diff: staged changes
          { ...DEFAULT_RESULT, stdout: bracket }, // commit lands
          { ...DEFAULT_RESULT, exitCode: 1, stderr: "fatal: bad" }, // rev-parse --short FAILS
        ],
      });
      const parsed = parseDoorstopGitCommitResponse(
        await requestDoorstopGitCommit(context, gitCommitRequest({ message: "docs" })),
      );
      expect(parsed).toEqual({ status: "committed", sha: "abc1234" });
      expect(requests[3]?.args).toEqual(["rev-parse", "--short", "HEAD"]);
    }
  });

  it("narrates committed with the bracket sha when the budget dies between commit and rev-parse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const exhausted = createFakeContext({
        execFile: async (request) => {
          const args = request.args ?? [];
          if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return { ...DEFAULT_RESULT, stdout: "true" };
          if (args[0] === "diff") return { ...DEFAULT_RESULT, exitCode: 1 };
          if (args[0] === "commit") {
            vi.setSystemTime(new Date(Date.now() + 10_000)); // exhaust the 9.5 s budget
            return { ...DEFAULT_RESULT, stdout: "[main abc1234] docs\n" };
          }
          return DEFAULT_RESULT;
        },
      });
      const response = await requestDoorstopGitCommit(exhausted.context, gitCommitRequest({ message: "docs" }));
      expect(parseDoorstopGitCommitResponse(response)).toEqual({ status: "committed", sha: "abc1234" });
      // The commit exec is the LAST one — no doomed rev-parse --short run.
      expect(exhausted.requests.map((request) => request.args?.[0])).toEqual(["rev-parse", "diff", "commit"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips when the deadline budget is exhausted before any step runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const exhausted = createFakeContext({
        execFile: async () => {
          vi.setSystemTime(new Date(Date.now() + 10_000));
          return DEFAULT_RESULT;
        },
      });
      const response = await requestDoorstopGitCommit(exhausted.context, gitCommitRequest({ message: "m" }));
      expect(parseDoorstopGitCommitResponse(response)).toEqual({ status: "skipped" });
      expect(exhausted.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips on a bare repo or .git directory (rev-parse prints 'false' with exit 0)", async () => {
    const { context, requests } = createFakeContext({ results: [{ ...DEFAULT_RESULT, stdout: "false\n" }] });
    expect(
      parseDoorstopGitCommitResponse(await requestDoorstopGitCommit(context, gitCommitRequest({ message: "m" }))),
    ).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1);
  });

  it("honors the configured gitPath for every git exec of the commit", async () => {
    const { context, requests } = createFakeContext({
      settings: { gitPath: "/usr/local/bin/git" },
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 1 }, // diff: staged changes
        { ...DEFAULT_RESULT, stdout: "[main abc1234] docs\n" }, // commit
        { ...DEFAULT_RESULT, stdout: "abc1234\n" }, // rev-parse --short
      ],
    });
    await requestDoorstopGitCommit(context, gitCommitRequest({ message: "docs" }));
    expect(requests.map((request) => request.file)).toEqual([
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
      "/usr/local/bin/git",
    ]);
    expect(requests[0]?.timeoutMs).toBe(8500);
  });

  it("trims padding from the message (the element guard trims before sending; the contract agrees both ways)", async () => {
    const { context, requests } = createFakeContext({
      results: [
        { ...DEFAULT_RESULT, stdout: "true" },
        { ...DEFAULT_RESULT, exitCode: 1 },
        { ...DEFAULT_RESULT, stdout: "[main abc1234] padded docs\n" },
        { ...DEFAULT_RESULT, stdout: "abc1234\n" },
      ],
    });
    const parsed = parseDoorstopGitCommitResponse(
      await requestDoorstopGitCommit(context, gitCommitRequest({ message: "  padded docs  " })),
    );
    expect(parsed.status).toBe("committed");
    // git receives the TRIMMED message — committing the padding verbatim
    // would be a contract/element disagreement.
    expect(requests[2]?.args).toEqual(["commit", "-m", "padded docs"]);
  });
});
