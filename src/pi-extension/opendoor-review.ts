// ---------------------------------------------------------------------------
// Opendoor review dispatch — the Pi-extension half of the "Start review
// session" flow (relay `opendoor-dispatch-redesign` design §1): a minuscule Pi
// extension that registers `/opendoor-review <UID> [instruction…]` and starts
// an independent review conversation through PI WEB's OWN session-dispatch
// bridge.
//
// Why an extension rather than the server entry: the host rejects any
// workspace-provider-contributing server entry that (transitively) requires a
// late host capability (the provider-cycle rule in
// `pi-web/src/server/plugins/serverPluginRuntime.ts`), so the capability-driven
// dispatch could never be resolved from `src/server-plugin.ts`. A trusted Pi
// extension is subject to no such rule and talks to the same builtin bridge
// over the documented in-process channel, by construction immune to the
// capability cycle.
//
// Discipline:
//   - ZERO runtime imports. `ExtensionAPI` is a TYPE-only import from
//     `@earendil-works/pi-coding-agent` (erased at build); the metadata
//     builder is imported by relative path from the same package (inlined by
//     the bundle), so the shipped `dist/pi-extension/index.js` is
//     self-contained and never reaches into the host's internals.
//   - The dispatch channel literal is HOST-INTERNAL (not exported from the
//     released extension or server contracts). It is pinned here with this
//     comment and asserted by tests against a duplicated expectation — the
//     same discipline the retiring `src/doorstop-dispatch.ts` used. Drift in a
//     future host release is a charter intervention signal, never an
//     improvisation site.
//   - Every outcome is reported into the INITIATING conversation via
//     `pi.sendMessage` (a displayed custom message): success, a rejected
//     dispatch (delegation disabled, project-scope refusal, oversized prompt),
//     a malformed command, or a host without the bridge. The handler never
//     throws for an expected failure, so nothing depends on Pi's
//     extension-error path and no outcome is swallowed.
//   - The published metadata is the SHIPPED `{schema: 1, op: "review", uids}`
//     payload under the `opendoor` namespace (the same contract the shipped
//     session-row label renders); the strict builder is the single validation
//     source, so this module introduces no second UID grammar.
//
// Form (review-leg2 S1, resolved): when the caller supplies instructions after
// the UID — the panel's insert always does — those words ARE the spawned
// prompt, verbatim; the built-in review instruction is used only when the
// command carries a bare UID. This keeps a manually typed
// `/opendoor-review REQ0001` self-sufficient without composing the panel's
// review instruction a second time.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildDoorstopSessionMetadata,
  OPENDOOR_SESSION_METADATA_NAMESPACE,
} from "../doorstop-session-metadata.js";

/**
 * The host's in-process extension dispatch channel. Pinned literal: it is
 * emitted by the host's builtin per-session dispatch bridge
 * (`dist/server/sessions/extensionSessionDispatch.js`) and by the host's own
 * relays extension (`dist/pi-packages/relays/extensions`), but it is not
 * exported from any released contract. A change in a future host release
 * surfaces here as a rejected dispatch (no listener ⇒ no `accept` call), which
 * is the charter's intervention signal.
 */
export const PI_WEB_SESSION_DISPATCH_CHANNEL = "pi-web:session-dispatch:v1";

/** The registered Pi command (invoked as `/opendoor-review …`). */
export const OPENDOOR_REVIEW_COMMAND = "opendoor-review";

/** `customType` of the displayed message this extension reports outcomes
 *  through (rendered in the initiating conversation's transcript). */
export const OPENDOOR_REVIEW_MESSAGE_CUSTOM_TYPE = "opendoor-review-dispatch";

/** Session-name prefix; with the host's 60-character `name` bound and the
 *  32-character UID bound this can never overflow (`"Doorstop review "` is 16
 *  characters, so the name is ≤ 48). */
export const OPENDOOR_REVIEW_SESSION_NAME_PREFIX = "Doorstop review ";

/** One parsed `/opendoor-review` invocation: the item UID and the caller's
 *  remaining words (the panel's item-context instruction, or a user's own
 *  text). `notes` is `""` when the command carried only a UID. */
export interface DoorstopReviewCommandArgs {
  readonly uid: string;
  readonly notes: string;
}

/** The built-in instruction used only for a bare `/opendoor-review <uid>`:
 *  the panel's inserted instruction (see `composeReviewCommand`) is richer and
 *  becomes the prompt verbatim when present. */
export function defaultReviewInstruction(uid: string): string {
  return (
    `Check doorstop requirement ${uid}: run \`doorstop\` in the workspace root, inspect ${uid}'s child ` +
    `links and references, and when it is ready run \`doorstop review ${uid}\`.`
  );
}

/**
 * Parse the command's argument text: the FIRST whitespace-delimited token is
 * the UID, the remainder is the caller's instruction. Returns `undefined` when
 * there is no UID at all (blank command) — the caller reports usage. UID shape
 * is NOT validated here: `buildDoorstopSessionMetadata` is the single strict
 * validator (safe token ≤ 32 characters), so a junk UID is rejected by the
 * shipped contract rather than by a duplicate grammar in this module.
 */
export function parseReviewCommandArgs(args: string): DoorstopReviewCommandArgs | undefined {
  const trimmed = args.trim();
  if (trimmed === "") return undefined;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (match === null) return undefined;
  const uid = match[1] ?? "";
  if (uid === "") return undefined;
  return { uid, notes: (match[2] ?? "").trim() };
}

/**
 * The Pi extension factory: registers the prompt command. The dispatch itself
 * lives in {@link runOpendoorReview}, which tests drive directly.
 */
export default function opendoorReviewExtension(pi: ExtensionAPI): void {
  pi.registerCommand(OPENDOOR_REVIEW_COMMAND, {
    description:
      "Start an independent Doorstop review conversation for a requirement UID (e.g. /opendoor-review REQ0001)",
    handler: async (args) => {
      await runOpendoorReview(pi, args);
    },
  });
}

/**
 * The whole dispatch, invocation-independent (so it is testable against a
 * stubbed `pi`): parse → strict metadata build → emit the bridge frame →
 * await the synchronously accepted promise → report the outcome into the
 * initiating conversation. Never throws for an expected failure.
 */
export async function runOpendoorReview(pi: ExtensionAPI, args: string): Promise<void> {
  const parsed = parseReviewCommandArgs(args);
  if (parsed === undefined) {
    report(
      pi,
      `Usage: /${OPENDOOR_REVIEW_COMMAND} <UID> [instruction…] — the UID is a Doorstop requirement UID.`,
    );
    return;
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = {
      [OPENDOOR_SESSION_METADATA_NAMESPACE]: buildDoorstopSessionMetadata("review", [parsed.uid]),
    };
  } catch (error) {
    report(pi, `Cannot start a Doorstop review session: ${formatError(error)}`);
    return;
  }

  const prompt = parsed.notes === "" ? defaultReviewInstruction(parsed.uid) : parsed.notes;
  const name = `${OPENDOOR_REVIEW_SESSION_NAME_PREFIX}${parsed.uid}`;

  // The bridge calls `accept` SYNCHRONOUSLY with a promise carrying the
  // validation/spawn outcome; awaiting it is how rejections are observed
  // instead of disappearing into the fire-and-forget event bus.
  let accepted: Promise<unknown> | undefined;
  pi.events.emit(PI_WEB_SESSION_DISPATCH_CHANNEL, {
    input: { prompt, name, metadata },
    accept: (result: unknown) => {
      accepted = result instanceof Promise ? result : Promise.resolve(result);
    },
  });

  if (accepted === undefined) {
    report(
      pi,
      "Doorstop review dispatch requires PI WEB's session dispatch bridge. Update PI WEB and restart " +
        "the session daemon when safe; no session was started.",
    );
    return;
  }

  try {
    const result = await accepted;
    report(pi, `Started an independent Doorstop review session for ${parsed.uid}${spawnSuffix(result)}.`);
  } catch (error) {
    report(
      pi,
      `The Doorstop review session for ${parsed.uid} was not started: ${formatError(error)}`,
    );
  }
}

/** Report one outcome as a displayed custom message in the initiating
 *  conversation. Reporting must never mask the dispatch outcome, so a host
 *  that rejects the message call is tolerated silently. */
function report(pi: ExtensionAPI, text: string): void {
  try {
    pi.sendMessage({
      customType: OPENDOOR_REVIEW_MESSAGE_CUSTOM_TYPE,
      content: text,
      display: true,
    });
  } catch {
    // The dispatch already happened (or provably did not); a reporting
    // failure is not a second failure to surface.
  }
}

/** ` (session <id>)` when the accepted result carries a session id, else "". */
function spawnSuffix(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const sessionId = (result as Record<string, unknown>)["sessionId"];
  return typeof sessionId === "string" && sessionId !== "" ? ` (session ${sessionId})` : "";
}

/** Error text for the conversation; never empty. */
function formatError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error);
  return text === "" ? "unknown error" : text;
}
