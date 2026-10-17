// @vitest-environment node
//
// Unit tests for the paired-server session dispatch (relay
// `opendoor-session-metadata-labels` design §4): the pinned frame shape
// (channel literal asserted against a DUPLICATED expectation, finding F4a),
// the primary-connect vs seed-fallback paths, bridge acceptance/rejection,
// the bounded admission window, and the request-signal abort.

import { describe, expect, it, vi } from "vitest";
import type {
  PiWebHostPiSessionConnection,
  PiWebHostPiSessionEventsV1,
  PiWebHostPiSessionsV1,
  PluginCapability,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  activateDoorstopDispatch,
  createDoorstopDispatch,
  DOORSTOP_DISPATCH_ACCEPT_TIMEOUT_MS,
  PI_SESSION_DISPATCH_CHANNEL,
  requestDoorstopAskAgent,
  type DoorstopDispatch,
  type DoorstopDispatchCapabilities,
} from "./doorstop-dispatch.js";

interface ConnectionHarness {
  connection: PiWebHostPiSessionConnection;
  channels: string[];
  frames: unknown[];
  closeCount: () => number;
}

/** One fake hosted-session connection whose `emit` runs `onEmit` synchronously
 *  (mirroring the host bridge's synchronous receipt). */
function fakeConnection(onEmit: (data: { accept?: unknown }) => void): ConnectionHarness {
  const channels: string[] = [];
  const frames: unknown[] = [];
  let closes = 0;
  const connection: PiWebHostPiSessionConnection = {
    signal: new AbortController().signal,
    on: () => () => undefined,
    emit: (channel, data) => {
      channels.push(channel);
      frames.push(data);
      onEmit(data as { accept?: unknown });
    },
    close: () => {
      closes += 1;
    },
  };
  return { connection, channels, frames, closeCount: () => closes };
}

/** A fake bridge that accepts and resolves with `result`. */
function acceptingConnection(result: unknown): ConnectionHarness {
  return fakeConnection((data) => {
    const accept = data.accept;
    if (typeof accept === "function") (accept as (value: unknown) => void)(Promise.resolve(result));
  });
}

function stubCapabilities(
  overrides: {
    connect?: PiWebHostPiSessionEventsV1["connect"];
    create?: PiWebHostPiSessionsV1["create"];
  } = {},
): DoorstopDispatchCapabilities {
  return {
    sessions: {
      version: 1,
      create: overrides.create ?? (async () => ({ sessionId: "seed-session" })),
      run: async () => {
        throw new Error("the ask-agent dispatch never calls run");
      },
    },
    events: {
      version: 1,
      connect:
        overrides.connect ??
        (async () => {
          throw new Error("connect stub not configured");
        }),
    },
  };
}

function dispatchWith(capabilities: DoorstopDispatchCapabilities): DoorstopDispatch {
  const dispatch = createDoorstopDispatch();
  dispatch.capabilities = capabilities;
  return dispatch;
}

const TARGET = { projectId: "project-1", workspaceId: "workspace-1" } as const;

describe("requestDoorstopAskAgent", () => {
  it("emits the pinned frame on the primary connect path (F4a duplicated literal)", async () => {
    const harness = acceptingConnection({ sessionId: "spawned-1" });
    const connect = vi.fn(async () => harness.connection);
    const create = vi.fn(async () => ({ sessionId: "seed-session" }));
    const response = await requestDoorstopAskAgent(
      dispatchWith(stubCapabilities({ connect, create })),
      TARGET,
      { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "live-session" },
      new AbortController().signal,
    );

    expect(response).toEqual({ dispatched: true, sessionId: "spawned-1" });
    // Primary path: the user's live conversation is used; no seed published.
    expect(create).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "live-session",
    });
    // The channel literal is asserted independently of the exported constant
    // (an accidental edit of the pinned constant fails BOTH assertions).
    expect(harness.channels).toEqual(["pi-web:session-dispatch:v1"]);
    expect(harness.channels[0]).toBe(PI_SESSION_DISPATCH_CHANNEL);
    expect(harness.frames).toEqual([
      {
        input: {
          prompt: "Review REQ0001",
          metadata: { opendoor: { schema: 1, op: "review", uids: ["REQ0001"] } },
        },
        accept: expect.any(Function),
      },
    ]);
    expect(harness.closeCount()).toBe(1);
  });

  it("publishes and connects a seed conversation when no session id was supplied", async () => {
    const harness = acceptingConnection({ sessionId: "spawned-2" });
    const connect = vi.fn(async () => harness.connection);
    const create = vi.fn(async () => ({ sessionId: "seed-session" }));
    const response = await requestDoorstopAskAgent(
      dispatchWith(stubCapabilities({ connect, create })),
      TARGET,
      { uid: "TST0002", prompt: "Review TST0002" },
      new AbortController().signal,
    );

    expect(response).toEqual({ dispatched: true, sessionId: "spawned-2" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ projectId: "project-1", workspaceId: "workspace-1" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "seed-session",
    });
  });

  it("falls back to the seed path exactly once when the primary connect is refused", async () => {
    const harness = acceptingConnection({ sessionId: "spawned-3" });
    const connect = vi.fn(
      async (_selection: { projectId: string; workspaceId: string; sessionId: string }) => harness.connection,
    );
    connect.mockRejectedValueOnce(new Error("Selected session is not hosted in this workspace on this machine"));
    const create = vi.fn(async () => ({ sessionId: "seed-session" }));
    const response = await requestDoorstopAskAgent(
      dispatchWith(stubCapabilities({ connect, create })),
      TARGET,
      { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "gone-session" },
      new AbortController().signal,
    );

    expect(response).toEqual({ dispatched: true, sessionId: "spawned-3" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0]?.[0]).toEqual({
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "gone-session",
    });
    expect(connect.mock.calls[1]?.[0]).toEqual({
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "seed-session",
    });
  });

  it("propagates a bridge rejection (delegation disabled) and still closes the connection", async () => {
    const harness = fakeConnection((data) => {
      const accept = data.accept;
      if (typeof accept === "function") {
        (accept as (value: unknown) => void)(
          Promise.reject(new Error("Session dispatch is disabled for this session")),
        );
      }
    });
    const dispatch = dispatchWith(stubCapabilities({ connect: async () => harness.connection }));
    await expect(
      requestDoorstopAskAgent(
        dispatch,
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "live" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Session dispatch is disabled for this session");
    expect(harness.closeCount()).toBe(1);
  });

  it("rejects when no live bridge accepts the frame", async () => {
    const harness = fakeConnection(() => undefined);
    const dispatch = dispatchWith(stubCapabilities({ connect: async () => harness.connection }));
    await expect(
      requestDoorstopAskAgent(
        dispatch,
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "live" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("no live session dispatch bridge accepted the request");
    expect(harness.closeCount()).toBe(1);
  });

  it("answers { dispatched: true } without a session id when admission exceeds the window", async () => {
    vi.useFakeTimers();
    try {
      const harness = fakeConnection((data) => {
        const accept = data.accept;
        if (typeof accept === "function") (accept as (value: unknown) => void)(new Promise(() => undefined));
      });
      const dispatch = dispatchWith(stubCapabilities({ connect: async () => harness.connection }));
      const pending = requestDoorstopAskAgent(
        dispatch,
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "live" },
        new AbortController().signal,
      );
      // Flush connect + emit so the admission timer is actually scheduled.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DOORSTOP_DISPATCH_ACCEPT_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ dispatched: true });
      expect(harness.closeCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the session id when the bridge resolves a non-spawn shape", async () => {
    const harness = acceptingConnection(undefined);
    const dispatch = dispatchWith(stubCapabilities({ connect: async () => harness.connection }));
    await expect(
      requestDoorstopAskAgent(
        dispatch,
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001", sessionId: "live" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ dispatched: true });
  });

  it("rejects when the capabilities were never activated", async () => {
    await expect(
      requestDoorstopAskAgent(
        createDoorstopDispatch(),
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("capabilities are not active");
  });

  it("rejects cleanly on an already-aborted request signal without touching a capability", async () => {
    const connect = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestDoorstopAskAgent(
        dispatchWith(stubCapabilities({ connect })),
        TARGET,
        { uid: "REQ0001", prompt: "Review REQ0001" },
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("activateDoorstopDispatch", () => {
  it("resolves the two declared host capabilities into the holder", () => {
    const sessions = { version: 1 } as PiWebHostPiSessionsV1;
    const events = { version: 1 } as PiWebHostPiSessionEventsV1;
    const dispatch = createDoorstopDispatch();
    activateDoorstopDispatch(dispatch, {
      resolve: <Value>(capability: PluginCapability<Value>): Value => {
        if (capability.id === "pi-sessions") return sessions as Value;
        if (capability.id === "pi-session-events") return events as Value;
        throw new Error("unexpected capability");
      },
    });
    expect(dispatch.capabilities?.sessions).toBe(sessions);
    expect(dispatch.capabilities?.events).toBe(events);
  });
});
