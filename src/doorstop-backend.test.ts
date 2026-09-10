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

import { describe, expect, it } from "vitest";
import type {
  JsonObject,
  JsonValue,
  ProviderRequestContext,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  DOORSTOP_RUN_OPERATION,
  parseDoorstopRunResponse,
  type DoorstopRunRequest,
} from "./doorstop-backend-contract.js";
import { requestDoorstopBackend } from "./doorstop-backend.js";

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