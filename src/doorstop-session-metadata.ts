// ---------------------------------------------------------------------------
// Opendoor public session metadata (plan §2.1 flagship pairing, relay
// `opendoor-session-metadata-labels` design §2): the namespaced
// `SessionUiMetadata` payload opendoor publishes with a dispatched review
// session, and the tolerant parser the browser session-label contribution
// reads it back with.
//
// The host persists this payload verbatim as the public
// `pi-web.session-ui-metadata` custom entry (`version: 1`), so it survives
// reopen and archive, is readable without a live Pi connection, and older
// hosts simply omit the field (labels then render nothing).
//
// Discipline (design §2):
//   - STRICT BUILD (server side): `buildDoorstopSessionMetadata` validates
//     the op enum and the 1..8 UID list and THROWS on junk — the same
//     strictness as the backend contract parsers, so a malformed payload can
//     never be persisted.
//   - TOLERANT PARSE (browser side): `parseDoorstopSessionMetadata` NEVER
//     throws and returns `undefined` for absent/malformed/future-schema/
//     foreign data, so the session-label contribution degrades to nothing
//     on junk rows and older hosts.
//   - SECRETS POLICY: the payload carries ONLY the op enum and Doorstop item
//     UIDs — identifiers already public in panel URLs and the UI. No item
//     text, file paths, CLI output, git identities, or settings. Both sides
//     additionally treat every UID as untrusted (safe-token pattern + length
//     bound) before it can reach a template or the host bridge.
//
// No runtime imports (host-independent, mirrors doorstop-backend-contract.ts)
// so this module bundles into both the browser and server entries.
// ---------------------------------------------------------------------------

/** The public metadata namespace opendoor publishes under. Matches the
 *  host's namespace pattern (`^[a-zA-Z0-9@][a-zA-Z0-9._:/@-]{0,127}$`). */
export const OPENDOOR_SESSION_METADATA_NAMESPACE = "opendoor";

/** The metadata payload version this slice writes; an unknown (future)
 *  schema parses to `undefined` so a newer writer cannot make the label
 *  render stale assumptions. */
export const DOORSTOP_SESSION_METADATA_SCHEMA = 1;

/** Bounds mirrored from the design §2 schema table: 1..8 UIDs, each a
 *  non-empty safe token ≤ 32 characters (Doorstop UIDs are short). */
export const DOORSTOP_SESSION_METADATA_MAX_UIDS = 8;
export const DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH = 32;

/** The recognized op values for schema 1. `"review"` is the ONLY value this
 *  slice writes; additional values are future work (dispatch entries beyond
 *  review stay composer-insert). */
export type DoorstopSessionMetadataOp = "review";

/** The validated, public opendoor session-metadata payload. */
export interface DoorstopSessionMetadata {
  readonly schema: typeof DOORSTOP_SESSION_METADATA_SCHEMA;
  readonly op: DoorstopSessionMetadataOp;
  readonly uids: readonly string[];
}

const DOORSTOP_SESSION_METADATA_OPS = new Set<DoorstopSessionMetadataOp>(["review"]);

/** Safe-token pattern shared by build and parse: rejects whitespace, quotes,
 *  control characters, and every shell/template metacharacter by
 *  construction. `\w` already covers letters, digits, and `_`. */
const DOORSTOP_SESSION_METADATA_UID_PATTERN = /^[\w.-]+$/u;

/** Whether `value` is a UID this schema is willing to publish/render: a
 *  bounded, non-empty safe token. */
function isMetadataUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH &&
    DOORSTOP_SESSION_METADATA_UID_PATTERN.test(value)
  );
}

/**
 * Build one validated public opendoor metadata payload (server side).
 * Throws on junk: an unknown op, a non-array/empty/oversized UID list, or a
 * UID outside the safe-token + length rule. The returned payload contains
 * exactly the three schema keys (secrets policy by construction), and the
 * `uids` array is a fresh copy so frozen/aliased inputs cannot leak aliases
 * into the persisted entry.
 */
export function buildDoorstopSessionMetadata(
  op: DoorstopSessionMetadataOp,
  uids: readonly string[],
): DoorstopSessionMetadata {
  if (!DOORSTOP_SESSION_METADATA_OPS.has(op)) {
    throw new Error(`Unsupported doorstop session metadata op: ${JSON.stringify(op)}`);
  }
  if (uids.length === 0 || uids.length > DOORSTOP_SESSION_METADATA_MAX_UIDS) {
    throw new Error(
      `Doorstop session metadata requires 1..${String(DOORSTOP_SESSION_METADATA_MAX_UIDS)} UIDs`,
    );
  }
  const copied: string[] = [];
  for (const uid of uids) {
    if (!isMetadataUid(uid)) {
      throw new Error(
        `Invalid doorstop session metadata UID (expected a non-empty safe token of at most ` +
          `${String(DOORSTOP_SESSION_METADATA_MAX_UID_LENGTH)} characters)`,
      );
    }
    copied.push(uid);
  }
  return {
    schema: DOORSTOP_SESSION_METADATA_SCHEMA,
    op,
    uids: copied,
  };
}

/**
 * Parse one untrusted opendoor namespace value (browser side). NEVER throws:
 * absent metadata, foreign namespaces, junk shapes, a future schema, an
 * unknown op, and out-of-rule UIDs all return `undefined` — the label then
 * renders nothing, which is the documented older-host/junk-row tolerance.
 * The returned payload is normalized to the three schema keys, so extra keys
 * persisted by a future/hostile writer never reach the label renderer.
 */
export function parseDoorstopSessionMetadata(value: unknown): DoorstopSessionMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["schema"] !== DOORSTOP_SESSION_METADATA_SCHEMA) return undefined;
  const op = record["op"];
  if (typeof op !== "string" || !DOORSTOP_SESSION_METADATA_OPS.has(op as DoorstopSessionMetadataOp)) {
    return undefined;
  }
  const uidsValue = record["uids"];
  if (
    !Array.isArray(uidsValue) ||
    uidsValue.length === 0 ||
    uidsValue.length > DOORSTOP_SESSION_METADATA_MAX_UIDS
  ) {
    return undefined;
  }
  const uids: string[] = [];
  for (const uid of uidsValue) {
    if (!isMetadataUid(uid)) return undefined;
    uids.push(uid);
  }
  return {
    schema: DOORSTOP_SESSION_METADATA_SCHEMA,
    op: op as DoorstopSessionMetadataOp,
    uids,
  };
}
