// ---------------------------------------------------------------------------
// Opendoor panel navigation (plan Phase C step C2 — browser API v4 deep links):
// the contribution-scoped address-bar query state the host exposes on the
// panel context (`WorkspacePanelContext.navigation`, host-namespaced under the
// panel's runtime id, so these plain key names cannot collide with another
// panel's keys).
//
// The four URL keys and their controller fields:
//
//   uid    → selectedUid            (item detail pane)
//   doc    → selectedDocumentPrefix (document detail pane)
//   filter → stateFilter           (item-list state chip filter)
//   search → search                 (item-list search box)
//
// Writes: the CONTROLLER's selection setters own every write (`selectUid`,
// `selectDocument`, `setStateFilter`, `setSearch` → `navigation.set`), so a
// user interaction pushes one history entry per deliberate selection change
// (search uses `replace` — one keystroke must not spam a history entry per
// character). Reads: `renderDoorstopPanel` applies the query to the
// controller on EVERY render via `applyPanelNavigationQuery` — idempotent
// (values are compared first), so back/forward navigation re-renders the panel
// and the query wins whenever it differs from the controller state, while a
// user interaction (state === query after its own write) is a no-op.
//
// The read side NEVER writes back: applying a query by calling the setters
// would loop (render → set → host render → apply). `applyNavigationQuery` on
// the controller sets the fields directly.
//
// `readPanelNavigationQuery` normalizes the host query shape (values may be
// `string | readonly string[]`): each key maps to its FIRST string value,
// arrays beyond the first entry and non-string values are dropped, and an
// empty string is treated as absent (a `?uid=` key carries no selection).
// Unknown keys are simply not read — the panel owns exactly the four keys
// above; the `file` key (Phase C step C3) is handled by the controller's
// applyNavigationQuery alongside these.
// ---------------------------------------------------------------------------

import type { WorkspacePanelNavigationV1 } from "@jmfederico/pi-web/plugin-api";

/** Deep-link key: the selected item UID (`selectedUid`). */
export const DOORSTOP_NAV_UID = "uid";

/** Deep-link key (plan Phase C step C3): a workspace-relative item-file path
 *  a chat Markdown link opened INTO this panel (`fileOpenQuery` returns
 *  `{ file: path }`; `applyNavigationQuery` resolves the path to its item
 *  and document selection). Unlike the four state keys this one is written
 *  by the HOST's chat link dispatch, never by the panel's own setters — a
 *  deliberate selection change CLEARS it (a stale `file` key must not
 *  override later chip selections on every re-render). */
export const DOORSTOP_NAV_FILE = "file";

/** Deep-link key: the selected document prefix (`selectedDocumentPrefix`). */
export const DOORSTOP_NAV_DOC = "doc";

/** Deep-link key: the item-list state filter (`stateFilter`). */
export const DOORSTOP_NAV_FILTER = "filter";

/** Deep-link key: the item-list search string (`search`). */
export const DOORSTOP_NAV_SEARCH = "search";

/** Normalized single-string view of one host panel-navigation query: each
 *  present key maps to a non-empty first string value. */
export type PanelNavigationQuery = Readonly<Record<string, string>>;

/** Normalize the host's navigation query (values `string | readonly string[]`)
 *  into a plain first-string record. `undefined` navigation yields `{}` —
 *  the panel then simply applies no keys (older hosts without navigation
 *  support keep working). */
export function readPanelNavigationQuery(
  navigation: WorkspacePanelNavigationV1 | undefined,
): PanelNavigationQuery {
  const output: Record<string, string> = {};
  if (navigation === undefined) return output;
  for (const [key, value] of Object.entries(navigation.query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first !== "") output[key] = first;
  }
  return output;
}
