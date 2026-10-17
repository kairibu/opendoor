# opendoor — feature spec

`opendoor` is a paired PI WEB plugin that surfaces Doorstop requirements in
the workspace (Requirements panel, item state, CLI actions). The repository
README summarises the plugin; this file carries the focused feature specs.
The sections referenced from the README (§5 architecture, §6 requirements
state model, §7–§8 UI/actions) predate this file and are documented in the
README and the module headers under `src/`; the section below is the
authoritative spec for the public session-metadata / session-list row-label
pairing.

## Session metadata and session-list row labels

The flagship pairing for PI WEB 1.202610.x: a review conversation started
from the Requirements panel publishes namespaced public metadata with the
conversation, and the session list renders a compact row indicator that
reopens the Requirements tab on that item — including for unselected and
archived rows, and with no live Pi connection.

### Start review session

On a **paired** install only (the workspace is opendoor-owned with an active
peer backend), the item palette's **Ask agent** menu gains one entry,
**Start review session**. It differs from the existing composer-insert
entries (Explain / Fix suspect links / Draft child requirement / Review
readiness), which never change:

1. The browser sends the new peer operation
   **`doorstop.ask-agent`** with the item UID, the composed review prompt
   (`reviewReadinessPrompt(item, children)`), and — when the panel has a
   live conversation selected in that same workspace — that exact
   conversation id.
2. The paired server resolves the workspace authority from the request
   context, then either connects to the supplied live conversation or
   publishes a promptless seed conversation and connects to it (a refused
   primary connection falls back to the seed once).
3. The server emits the host's own session-dispatch frame
   (`pi-web:session-dispatch:v1`) with the prompt and the public metadata
   pre-seeded. The host's builtin bridge spawns an independent conversation
   in a workspace of the same registered project (the same delegation rules
   as `spawn_session`; the conversation belongs to the user once published).
4. The server answers `{ dispatched: true, sessionId? }`; the panel
   navigates to the spawned chat when the id arrived inside the bounded
   admission window, and otherwise simply waits — the new row announces
   itself and its label appears via the host's `session.created` event.

Unpaired installs (or older hosts) hide the entry entirely; the
composer-insert entries keep working. If dispatch is rejected (delegation
tools disabled, project-scope refusal), the panel shows the server message
on its existing error line and the composer-insert entries remain the
fallback.

### Metadata schema

Namespace **`opendoor`** under the host's public `SessionUiMetadata`
(persisted as the `pi-web.session-ui-metadata` custom entry, so it survives
reopen and archive). Schema 1 payload:

| Key | Type | Rule |
| --- | --- | --- |
| `schema` | number | exactly `1`; a future value parses to nothing |
| `op` | string | enum, currently only `"review"` |
| `uids` | string[] | 1..8 non-empty Doorstop UIDs, each ≤ 32 characters |

Only deliberately public data is published: the op enum and item UIDs —
identifiers already public in panel URLs and the UI. No item text, file
paths, CLI output, git identities, or settings. The server build is strict
(rejects junk before a session is touched); the browser parse is tolerant
(absent/foreign/junk/future data renders nothing), and the label renderer
treats every UID as untrusted (safe-token pattern + length bound, enum
whitelist) before it reaches a template.

### Reopen link

A row carrying valid `opendoor` metadata renders `${firstUid} +n` (the `+n`
suffix omitted for a single UID) with the full UID list as its tooltip.
Clicking it calls the label context's `navigate` with a complete destination
on the **row's** machine and workspace, `view: "workspace"`, the qualified
Requirements panel tool, and the panel's existing `uid` deep-link key — so
the reopened tab lands on the item detail pane. The label is built entirely
from the row's detached public metadata snapshot; it reads no transcript or
private conversation data.

### Capability floor and degradation

The paired dispatch path requires a **1.202610.x session daemon**
(`requires: [PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY]`). On an older daemon the opendoor
server module does not start: the workspace falls back to the terminal path
(unchanged) and the session labels stay inert (no metadata is ever
published). On any host, absent/malformed metadata renders no label — older
browser hosts that do not support session labels simply ignore the
contribution. A sessiond restart is required to load the server-side change.
