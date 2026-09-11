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
  DOORSTOP_RUN_OPERATION,
  parseDoorstopBaselineResponse,
  parseDoorstopRunResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import { requestDoorstopBackend, requestDoorstopBaseline } from "./doorstop-backend.js";

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
});
