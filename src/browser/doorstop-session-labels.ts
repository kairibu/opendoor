// ---------------------------------------------------------------------------
// Opendoor session-list row labels (relay `opendoor-session-metadata-labels`
// design §3): the browser `SessionLabelContributionV5` that renders a compact
// row indicator for every conversation carrying the public `opendoor`
// namespace metadata, linking back into the Requirements tab on the row's
// own machine/workspace.
//
// Contract discipline (released browser API v4, held unchanged on v5):
//   - `items(context)` is SYNCHRONOUS and side-effect-free: it only parses
//     the detached row snapshot's public metadata and builds one render item.
//     `context.navigate` is called from the click handler, NEVER from
//     `items()`.
//   - The context carries a detached `session` snapshot for unselected and
//     archived rows, so the label works with no live Pi connection. It reads
//     `metadata` only — never a transcript or private conversation data.
//   - `parseDoorstopSessionMetadata` is the tolerance boundary: absent
//     metadata (older hosts), foreign namespaces, junk, and future schemas
//     all yield no item, so the contribution stays inert.
//   - An inner render item is required (not a `link` item): `link` items need
//     an absolute http/https/mailto/tel href, while the reopen target is an
//     internal `PluginNavigate` destination.
//
// `doorstopReopenDestination` reuses the panel's existing `uid` deep-link key
// (`doorstop-panel-navigation.ts`), so the reopened Requirements tab lands on
// the item detail pane; it passes no navigation options, so the host's
// defaults apply (complete replacement destination + push history).
// ---------------------------------------------------------------------------

import { html, type TemplateResult } from "lit";
import type {
  PluginNavigationDestination,
  SessionLabelContextV5,
  SessionLabelContributionV5,
  SessionLabelItem,
  Workspace,
} from "@jmfederico/pi-web/plugin-api";
import {
  OPENDOOR_SESSION_METADATA_NAMESPACE,
  parseDoorstopSessionMetadata,
} from "../doorstop-session-metadata.js";
import { DOORSTOP_NAV_UID } from "./doorstop-panel-navigation.js";

const DOORSTOP_PANEL_LOCAL_ID = "workspace.doorstop";

/** The label contribution id (host-unique only as a local id within this
 *  plugin; ordering is explicit so it sits with the other compact row
 *  indicators). */
export const DOORSTOP_SESSION_LABEL_ID = "doorstop.review";

/**
 * Build the opendoor session-label contribution. `runtimePluginId` qualifies
 * the Requirements panel tool id the label navigates back to, exactly as the
 * panel contribution does.
 */
export function createDoorstopSessionLabel(runtimePluginId: string): SessionLabelContributionV5 {
  const panelId = `${runtimePluginId}:${DOORSTOP_PANEL_LOCAL_ID}`;
  return {
    id: DOORSTOP_SESSION_LABEL_ID,
    order: 10,
    items: (context) => sessionLabelItems(context, panelId),
  };
}

/**
 * One pure synchronous pass over a session row's public metadata: one render
 * item for a valid opendoor payload, otherwise nothing. Exported for tests.
 */
export function sessionLabelItems(context: SessionLabelContextV5, panelId: string): SessionLabelItem[] {
  const value = context.session.metadata?.[OPENDOOR_SESSION_METADATA_NAMESPACE];
  const metadata = parseDoorstopSessionMetadata(value);
  if (metadata === undefined) return [];
  const firstUid = metadata.uids[0];
  if (firstUid === undefined) return [];
  const rest = metadata.uids.length - 1;
  const text = rest === 0 ? firstUid : `${firstUid} +${String(rest)}`;
  const target = doorstopReopenDestination(context.machine.id, context.workspace, panelId, firstUid);
  return [
    {
      type: "render",
      render: (): TemplateResult =>
        html`<a
          class="doorstop-session-label"
          href="#"
          title=${`Open ${metadata.uids.join(", ")} in Requirements`}
          @click=${(event: Event): void => {
            // The label is the row's own affordance: one navigation, no row
            // selection, no URL-hash jump.
            event.preventDefault();
            event.stopPropagation();
            void context.navigate(target);
          }}
        >${text}</a>`,
    },
  ];
}

/**
 * The reopen destination for one labeled row: the row's machine and
 * workspace, the Requirements panel tool, and the first UID as the panel's
 * `uid` deep-link key. Exported so tests pin the exact shape without a
 * rendered label.
 */
export function doorstopReopenDestination(
  machineId: string,
  workspace: Workspace,
  panelId: string,
  uid: string,
): PluginNavigationDestination {
  return {
    machineId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    view: "workspace",
    tool: panelId,
    query: { [DOORSTOP_NAV_UID]: uid },
  };
}
