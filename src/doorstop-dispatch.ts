// ---------------------------------------------------------------------------
// Opendoor session dispatch (relay `opendoor-session-metadata-labels` design
// §1/§4): the paired-server half of the "Start review session" flow. It is
// the only opendoor code that starts a conversation, and it does so through
// the host's OWN dispatch bridge rather than a private session API:
//
//   1. resolve the request's workspace authority from the peer request
//      context (F3 — `request.workspace.projectId`/`.id`; no contract change),
//   2. connect to the panel-selected live conversation in that workspace when
//      the browser supplied one (F1 `sessionId`), else publish a promptless
//      seed conversation via the PI-sessions capability and connect to it; a
//      refused primary connect falls back to the seed path exactly once,
//   3. emit `{ input: { prompt, metadata }, accept }` on the host's dispatch
//      channel — the same frame shape the host's own relays extension emits —
//      so the builtin per-session bridge spawns an independent conversation
//      with the public `opendoor` metadata pre-seeded and the prompt admitted,
//   4. race the bridge's accepted promise against the request signal and a
//      bounded window (well inside the host's 10 s peer deadline), returning
//      `{ dispatched: true, sessionId? }`.
//
// The dispatch channel literal is HOST-INTERNAL (not exported from
// `server-plugin-api`); it is pinned here with this comment and asserted by
// tests against a duplicated expectation. Drift is a charter intervention
// signal, never an improvisation site.
//
// The six paired operations and the peer/terminal gate are untouched: this
// module is reached only from the new `doorstop.ask-agent` routing case.
// ---------------------------------------------------------------------------

import type {
  JsonValue,
  PiWebHostPiSessionConnection,
  PiWebHostPiSessionEventsV1,
  PiWebHostPiSessionsV1,
  ServerPluginCapabilityResolver,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
} from "@jmfederico/pi-web/server-plugin-api";
import type { DoorstopAskAgentRequest, DoorstopAskAgentResponse } from "./doorstop-backend-contract.js";
import {
  buildDoorstopSessionMetadata,
  OPENDOOR_SESSION_METADATA_NAMESPACE,
} from "./doorstop-session-metadata.js";

/**
 * The host's in-process extension dispatch channel. Pinned literal: it is
 * emitted by the host's builtin per-session dispatch bridge and by the
 * host's own relays extension (`dist/pi-packages/relays/extensions`), but it
 * is not exported from the released `server-plugin-api` contract. A change
 * in a future host release surfaces here as a rejected dispatch, which is
 * the charter's intervention signal.
 */
export const PI_SESSION_DISPATCH_CHANNEL = "pi-web:session-dispatch:v1";

/** How long the server waits for the bridge to ADMIT the spawn before it
 *  answers `{ dispatched: true }` without a session id. Spawn admission is
 *  synchronous receipt plus target resolution — far below this — while the
 *  host peer request itself is bounded at 10 s; the agent's work is never
 *  awaited (the spawned session announces itself via `session.created`). */
export const DOORSTOP_DISPATCH_ACCEPT_TIMEOUT_MS = 7000;

/** The capability values `start()` resolves once every declared requirement
 *  is active. */
export interface DoorstopDispatchCapabilities {
  readonly sessions: PiWebHostPiSessionsV1;
  readonly events: PiWebHostPiSessionEventsV1;
}

/** Mutable activation-scoped holder: `activate()` builds it, `start()` fills
 *  in the resolved capabilities, and the peer request handler reads it. */
export interface DoorstopDispatch {
  capabilities: DoorstopDispatchCapabilities | undefined;
}

/** The peer-request-derived workspace authority for one dispatch (F3). */
export interface DoorstopDispatchTarget {
  readonly projectId: string;
  readonly workspaceId: string;
}

/** Create the empty dispatch holder for one server activation. */
export function createDoorstopDispatch(): DoorstopDispatch {
  return { capabilities: undefined };
}

/** Resolve both host capabilities into the holder (called from `start()`). */
export function activateDoorstopDispatch(
  dispatch: DoorstopDispatch,
  resolver: ServerPluginCapabilityResolver,
): void {
  dispatch.capabilities = {
    sessions: resolver.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY),
    events: resolver.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY),
  };
}

/**
 * Dispatch one review session for `request` (design §4). Resolves with the
 * `doorstop.ask-agent` response; rejects with the effective error when the
 * capabilities are not active, the seed conversation cannot be published,
 * the bridge is unavailable, or the bridge's own validation rejects the
 * spawn (delegation disabled, project-scope refusal) — the panel surfaces
 * that message verbatim and offers the composer-insert fallback. There is no
 * retry loop.
 */
export async function requestDoorstopAskAgent(
  dispatch: DoorstopDispatch,
  target: DoorstopDispatchTarget,
  request: DoorstopAskAgentRequest,
  signal: AbortSignal,
): Promise<JsonValue> {
  signal.throwIfAborted();
  const capabilities = dispatch.capabilities;
  if (capabilities === undefined) {
    throw new Error("opendoor: session dispatch capabilities are not active on this server");
  }
  // The only data that becomes public: the op enum and the item UID (design
  // §2 secrets policy). Built here so an invalid UID fails before any
  // session is touched.
  const metadata = {
    [OPENDOOR_SESSION_METADATA_NAMESPACE]: buildDoorstopSessionMetadata("review", [request.uid]),
  };
  const connection = await connectDoorstopDispatch(capabilities, target, request.sessionId);
  try {
    return await emitDoorstopDispatch(connection, { prompt: request.prompt, metadata }, signal);
  } finally {
    // Idempotent; detaches listeners without stopping the spawned
    // conversation or the connection's own lifetime.
    connection.close();
  }
}

/**
 * Connect to the panel-selected conversation when one was supplied, else
 * publish a promptless seed conversation and connect to it. A refused
 * primary connect (session gone/archived, wrong workspace, still
 * initializing) falls back to the seed path exactly once — never a retry
 * loop against the user's live conversation.
 */
async function connectDoorstopDispatch(
  capabilities: DoorstopDispatchCapabilities,
  target: DoorstopDispatchTarget,
  sessionId: string | undefined,
): Promise<PiWebHostPiSessionConnection> {
  if (sessionId !== undefined) {
    try {
      return await capabilities.events.connect({ ...target, sessionId });
    } catch {
      // Accepted fallback: publish the seed conversation below.
    }
  }
  const seed = await capabilities.sessions.create(target);
  return await capabilities.events.connect({ ...target, sessionId: seed.sessionId });
}

/** The frame input the host's dispatch bridge parses (its allowed keys are
 *  exactly prompt/cwd/name/metadata/model/thinkingLevel). */
interface DoorstopDispatchFrameInput {
  readonly prompt: string;
  readonly metadata: unknown;
}

/**
 * Emit one dispatch frame and settle on the FIRST of: the bridge's accepted
 * promise (success or rejection), the request signal abort, or the bounded
 * admission window. The frame's `accept` callback is invoked synchronously
 * by the bridge when it is listening, so a missing `accept` after `emit`
 * returns means no bridge handled the frame.
 */
function emitDoorstopDispatch(
  connection: PiWebHostPiSessionConnection,
  input: DoorstopDispatchFrameInput,
  signal: AbortSignal,
): Promise<JsonValue> {
  return new Promise<JsonValue>((resolve, reject) => {
    let accepted: Promise<unknown> | undefined;
    const accept = (result: unknown): void => {
      accepted = Promise.resolve(result);
    };
    try {
      connection.emit(PI_SESSION_DISPATCH_CHANNEL, { input, accept });
    } catch (error) {
      reject(error);
      return;
    }
    if (accepted === undefined) {
      reject(new Error("opendoor: no live session dispatch bridge accepted the request"));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new Error("opendoor: session dispatch request aborted"));
      });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      // The frame was emitted; the bridge may still admit the spawn. Answer
      // without a session id — the row label appears when `session.created`
      // lands, and the panel never awaits agent completion.
      finish(() => {
        resolve({ dispatched: true } satisfies DoorstopAskAgentResponse);
      });
    }, DOORSTOP_DISPATCH_ACCEPT_TIMEOUT_MS);
    accepted.then(
      (result: unknown) => {
        const sessionId = spawnedSessionId(result);
        finish(() => {
          resolve(
            (sessionId === undefined
              ? { dispatched: true }
              : { dispatched: true, sessionId }) satisfies DoorstopAskAgentResponse,
          );
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error);
        });
      },
    );
  });
}

/** Extract the spawned session id from the bridge's spawn result, tolerating
 *  any other shape (the response then omits `sessionId`). */
function spawnedSessionId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const sessionId = (value as Record<string, unknown>)["sessionId"];
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
}
