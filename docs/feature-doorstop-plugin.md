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

The item palette's **Ask agent** menu carries one entry, **Start review
session**, alongside the plain composer-insert entries (Explain / Fix suspect
links / Draft child requirement / Review readiness). It needs NO paired
backend: it composes a two-line insert into the session prompt editor.

1. Line 1 is the Pi prompt command **`/opendoor-review <UID>`**, registered
   by the opendoor Pi extension (`src/pi-extension/opendoor-review.ts`, built
   to `dist/pi-extension/index.js` and declared by the package manifest's
   `pi.extensions`).
2. Line 2 is the item-context instruction (the self-sufficient review text
   naming the item's file path and the `doorstop` commands).

Sending the prompt hands the text to the extension's command handler, which
parses the UID from the first whitespace-delimited token, takes the remaining
text as the spawned conversation's instruction (the built-in instruction is
used only for a bare `/opendoor-review <UID>`), builds the public metadata
with the shipped strict builder (`buildDoorstopSessionMetadata("review",
[uid])`), and emits the host's own session-dispatch frame
(`pi-web:session-dispatch:v1`). The host's builtin bridge spawns an
independent conversation in a workspace of the same registered project (the
same delegation rules as `spawn_session`; the conversation belongs to the
user once published) named `Doorstop review <UID>`, with the metadata
persisted as the public session entry.

After a successful insert the panel commits a quiet `ok` **review dispatch**
run record into its existing status bar (op `ask-review`, no exit code, no
output, no commit narration). The spawned row then announces itself through
the host's `session.created` event, so the panel neither navigates nor waits.

Degradation is explicit:

- **No extension installed**: line 2 is a self-sufficient instruction, so the
  agent reading the prompt as ordinary text performs the same review in the
  current conversation; the spawned row simply does not appear.
- **No dispatch bridge** (an older host): the extension reports "requires
  PI WEB's session dispatch bridge" in the initiating conversation and starts
  nothing.
- **A refused dispatch** (delegation tools disabled, project-scope refusal,
  oversized prompt): the bridge's rejection is reported verbatim as a message
  in the initiating conversation. The panel cannot observe it — with the peer
  operation retired there is no machine-readable channel back to the browser —
  so the chat reply is the failure surface, deliberately.

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

The opendoor **server** entry declares no capabilities (`requires`) and no
`start()`; it loads across the plugin's whole supported range. The
capability-driven `doorstop.ask-agent` peer operation it once carried was
unreachable by construction — PI WEB rejects a workspace-provider-contributing
entry that (transitively) requires a late host capability — and has been
retired together with its dispatch module.

The **1.202610.x floor** therefore applies only to the features that need that
release: the public `SessionUiMetadata` entry, the session-list label
contribution, and the per-session extension dispatch bridge. On an older
daemon the server plugin still loads and the panel works fully; the extension
reports the missing bridge in the conversation, no metadata is ever
published, and the labels stay inert. On any host, absent/malformed metadata
renders no label — older browser hosts that do not support session labels
simply ignore the contribution. A sessiond restart (server side) plus
`/reload` in each idle conversation (extension side) is what loads the
change.
