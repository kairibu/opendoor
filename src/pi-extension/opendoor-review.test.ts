// @vitest-environment node
//
// Unit tests for the opendoor Pi extension (relay `opendoor-dispatch-redesign`
// design §5): the `/opendoor-review` argument parsing, the metadata payload
// (equality with the shipped strict builder), the session-name bound, the
// exact bridge frame shape with its SYNCHRONOUS receipt, and every reported
// outcome. Host-independent: the released bridge is not imported; its channel
// literal is pinned by the extension and duplicated here as the test
// expectation (drift detection).

import { describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDoorstopSessionMetadata,
  OPENDOOR_SESSION_METADATA_NAMESPACE,
} from "../doorstop-session-metadata.js";
import extension, {
  defaultReviewInstruction,
  OPENDOOR_REVIEW_COMMAND,
  OPENDOOR_REVIEW_MESSAGE_CUSTOM_TYPE,
  parseReviewCommandArgs,
  PI_WEB_SESSION_DISPATCH_CHANNEL,
  runOpendoorReview,
} from "./opendoor-review.js";

/** The channel literal the released host bridge listens on
 *  (`dist/server/sessions/extensionSessionDispatch.js`). Duplicated on
 *  purpose: if the host ever renames it, this test and the extension comment
 *  are the two places that must change together (the charter's intervention
 *  signal). */
const EXPECTED_CHANNEL = "pi-web:session-dispatch:v1";

interface CapturedFrame {
  readonly input: Record<string, unknown>;
  readonly accept: ((result: unknown) => void) | undefined;
}

interface FakePi {
  readonly pi: ExtensionAPI;
  readonly commands: Map<string, (args: string) => Promise<void>>;
  /** Every string reported through `pi.sendMessage` (content is always a
   *  string here). */
  readonly messages: string[];
  /** Every emitted frame, in order. */
  readonly frames: CapturedFrame[];
  /** The `pi.sendMessage` spy (also the recorder behind `messages`). */
  readonly sendMessage: Mock;
}

/** A stubbed `pi`: command registrations and emitted frames are captured,
 *  `events.emit` forwards to `onEmit` (which decides whether/when to call
 *  `accept`), and `sendMessage` records every reported outcome. */
function createPi(onEmit?: (frame: CapturedFrame) => void): FakePi {
  const commands = new Map<string, (args: string) => Promise<void>>();
  const messages: string[] = [];
  const frames: CapturedFrame[] = [];
  const sendMessage = vi.fn((message: { content?: unknown }) => {
    messages.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  });
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
    events: {
      emit: (_channel: string, data: unknown) => {
        const frame = data as CapturedFrame;
        frames.push(frame);
        onEmit?.(frame);
      },
    },
    sendMessage,
  };
  return { pi: pi as unknown as ExtensionAPI, commands, messages, frames, sendMessage };
}

/** A `pi` stub whose emitter never calls `accept` (a host without the
 *  dispatch bridge). */
function piWithoutBridge(): FakePi {
  return createPi();
}

/** A `pi` stub whose emitter calls `accept` SYNCHRONOUSLY with `result` —
 *  exactly the released bridge's receipt discipline. */
function piWithBridge(result: Promise<unknown>): FakePi {
  return createPi((frame) => { frame.accept?.(result); });
}

describe("extension registration", () => {
  it("registers the /opendoor-review command from the default export", () => {
    const created = createPi();
    extension(created.pi);
    expect([...created.commands.keys()]).toEqual([OPENDOOR_REVIEW_COMMAND]);
  });

  it("pins the host bridge channel literal (drift is an intervention signal)", () => {
    expect(PI_WEB_SESSION_DISPATCH_CHANNEL).toBe(EXPECTED_CHANNEL);
  });
});

describe("parseReviewCommandArgs", () => {
  it("takes the first whitespace-delimited token as the UID and the rest as instructions", () => {
    expect(parseReviewCommandArgs("REQ0001")).toEqual({ uid: "REQ0001", notes: "" });
    expect(parseReviewCommandArgs("  REQ0001  ")).toEqual({ uid: "REQ0001", notes: "" });
    expect(parseReviewCommandArgs("REQ0001\nReview REQ0001 (`reqs/REQ0001.yml`) against its links.")).toEqual({
      uid: "REQ0001",
      notes: "Review REQ0001 (`reqs/REQ0001.yml`) against its links.",
    });
    expect(parseReviewCommandArgs("REQ0001 fix the child links")).toEqual({
      uid: "REQ0001",
      notes: "fix the child links",
    });
  });

  it("rejects a blank command (no UID)", () => {
    expect(parseReviewCommandArgs("")).toBeUndefined();
    expect(parseReviewCommandArgs("   \n ")).toBeUndefined();
  });
});

describe("runOpendoorReview", () => {
  it("emits the exact bridge frame with the shipped metadata payload and a synchronous receipt", async () => {
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "session-1", cwd: "/workspace/demo" }));
    await runOpendoorReview(pi, "REQ0001");

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("frame");
    expect(Object.keys(frame.input).sort()).toEqual(["metadata", "name", "prompt"]);
    expect(frame.input["name"]).toBe("Doorstop review REQ0001");
    expect(frame.input["prompt"]).toBe(defaultReviewInstruction("REQ0001"));
    expect(frame.input["metadata"]).toEqual({
      [OPENDOOR_SESSION_METADATA_NAMESPACE]: buildDoorstopSessionMetadata("review", ["REQ0001"]),
    });
    expect(typeof frame.accept).toBe("function");
  });

  it("uses caller instructions verbatim instead of composing the built-in instruction twice (S1)", async () => {
    const notes = "Review REQ0002 (`reqs/REQ0002.yml`) against its child links and references.";
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runOpendoorReview(pi, `REQ0002\n${notes}`);
    expect(frames[0]?.input["prompt"]).toBe(notes);
  });

  it("treats a trailing newline after the UID as empty instructions", async () => {
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runOpendoorReview(pi, "REQ0001\n");
    expect(frames[0]?.input["prompt"]).toBe(defaultReviewInstruction("REQ0001"));
  });

  it("keeps the session name inside the host's 60-character bound at the UID limit", async () => {
    const uid = "A".repeat(32);
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runOpendoorReview(pi, uid);
    const name = frames[0]?.input["name"];
    expect(typeof name).toBe("string");
    expect((name as string).length).toBeLessThanOrEqual(60);
  });

  it("reports a blank command as usage without emitting a frame", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await runOpendoorReview(pi, "   ");
    expect(frames).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Usage: /opendoor-review");
  });

  it("rejects a UID outside the shipped safe-token rule without emitting a frame", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await runOpendoorReview(pi, "bad!uid");
    expect(frames).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Invalid doorstop session metadata UID");
  });

  it("rejects an over-long UID through the same strict builder", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await runOpendoorReview(pi, "R".repeat(33));
    expect(frames).toHaveLength(0);
    expect(messages[0]).toContain("Invalid doorstop session metadata UID");
  });

  it("resolves (never throws) and reports when the host has no dispatch bridge", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await expect(runOpendoorReview(pi, "REQ0001")).resolves.toBeUndefined();
    // The frame was still emitted — the bridge's absence is only observable
    // through `accept` never being called.
    expect(frames).toHaveLength(1);
    expect(messages[0]).toContain("requires PI WEB's session dispatch bridge");
  });

  it("reports a rejected accepted-promise verbatim", async () => {
    const { pi, messages } = piWithBridge(
      Promise.reject(new Error("Session dispatch is disabled for this session")),
    );
    await expect(runOpendoorReview(pi, "REQ0001")).resolves.toBeUndefined();
    expect(messages[0]).toContain("was not started");
    expect(messages[0]).toContain("Session dispatch is disabled for this session");
  });

  it("reports success with the spawned session id", async () => {
    const { pi, messages } = piWithBridge(Promise.resolve({ sessionId: "session-9", cwd: "/workspace/demo" }));
    await runOpendoorReview(pi, "REQ0001");
    expect(messages[0]).toContain("Started an independent Doorstop review session for REQ0001");
    expect(messages[0]).toContain("session-9");
  });

  it("reports success without inventing a session id when the result is bare", async () => {
    const { pi, messages } = piWithBridge(Promise.resolve(undefined));
    await runOpendoorReview(pi, "REQ0001");
    expect(messages[0]).toContain("Started an independent Doorstop review session for REQ0001");
    expect(messages[0]).not.toContain("(session");
  });

  it("reports non-Error rejections without producing an empty message", async () => {
    const { pi, messages } = piWithBridge(Promise.reject("boom"));
    await runOpendoorReview(pi, "REQ0001");
    expect(messages[0]).toContain("boom");
  });

  it("reports through a displayed custom message so the outcome renders in the transcript", async () => {
    const fake = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runOpendoorReview(fake.pi, "REQ0001");
    expect(fake.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: OPENDOOR_REVIEW_MESSAGE_CUSTOM_TYPE, display: true }),
    );
  });
});
