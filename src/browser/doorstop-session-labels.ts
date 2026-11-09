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
// Session lifecycle (plan-piweb-1-202611 §2.2): pin/archive/restore for the
// labelled review session, rendered as two extra small buttons beside the
// reopen link.
//   - Same event-handler-only rule as `navigate`: `items()` never calls
//     `context.sessions` (it only reads the property to decide whether the
//     buttons can exist at all); every lifecycle call happens inside a click
//     handler.
//   - `context.sessions` is OPTIONAL (added in 1.202610.9, omitted by older
//     hosts): absent, the row renders today's reopen link alone — tolerance
//     by absence, exactly like the metadata parser above.
//   - PIN toggles on every labelled row (active and archived): the detached
//     row snapshot carries no `pinned` field, so the handler reads the live
//     state (`sessions.get`) and then calls `pin` or `unpin`.
//   - ARCHIVE renders only on an ACTIVE row (`session.archived === false` —
//     that field IS on the row snapshot, so the render-side gate is pure) and
//     is refused while the session is still `busy`: a running review is not
//     complete. `runtime` ships on the catalog's session snapshot
//     (`PluginSessionSnapshot`), not on the lifecycle state
//     (`PluginSessionLifecycleState` carries only `pinned`/`archived`), so the
//     busy gate reads `catalog.sessions.get` from the same handler. A row
//     still waiting for session creation (`session.pending`) is refused the
//     same way, before that read; and an unreadable catalog snapshot archives
//     nothing (fail-safe: "cannot prove idle").
//   - RESTORE renders only on an archived row.
//   - No double-click guard, by design: two rapid clicks issue two convergent
//     commands (pin/unpin and archive/restore are idempotent up to the host's
//     own semantics), and a second failing call is swallowed like any other.
//     Handlers are rebuilt on every `render()`, so an in-flight flag would not
//     survive a re-render anyway; the host owns the row's lifecycle state.
//   - Lifecycle promises are fire-and-forget (`void` + `.catch`): the label
//     has no feedback channel, and a failed call must never break the reopen
//     link. The host's own row update is the success signal.
//   - Buttons are real `<button type="button">` elements (keyboard
//     accessible; no plugin stylesheet targets host rows, so plain semantic
//     markup is what we ship) whose handlers stop the click, so a lifecycle
//     click never selects the row, follows the reopen link, or navigates.
//
// `doorstopReopenDestination` reuses the panel's existing `uid` deep-link key
// (`doorstop-panel-navigation.ts`), so the reopened Requirements tab lands on
// the item detail pane; it passes no navigation options, so the host's
// defaults apply (complete replacement destination + push history).
// ---------------------------------------------------------------------------

import { html, nothing, type TemplateResult } from "lit";
import type {
  PluginNavigationDestination,
  PluginSessionLifecycle,
  PluginSessionSelection,
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
      render: (): TemplateResult => {
        // Building handlers is pure closure work (no `sessions` call), so the
        // render callback stays free of lifecycle side effects. The absence of
        // `sessions` (older host) removes the buttons, never the link.
        const sessions = context.sessions;
        const handlers = sessions === undefined ? undefined : buildSessionLifecycleHandlers(context, sessions);
        return html`<a
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
          >${text}</a
          >${handlers === undefined ? nothing : sessionLifecycleButtons(context, handlers)}`;
      },
    },
  ];
}

/** The lifecycle actions offered on a labelled review row. */
export type DoorstopSessionLifecycleAction = "pin" | "archive" | "restore";

/** The lifecycle actions the label offers, in render order. Exported so tests
 *  pin the pure render-side gate (and its absence tolerance) without a label.
 *  Reading `context.sessions` is not a lifecycle call — no method is invoked. */
export function sessionLifecycleActions(context: SessionLabelContextV5): DoorstopSessionLifecycleAction[] {
  if (context.sessions === undefined) return [];
  // Archive and restore are mutually exclusive: the archived flag that gates
  // them lives on the detached row snapshot, so this decision is pure.
  return context.session.archived === true ? ["pin", "restore"] : ["pin", "archive"];
}

/** One click handler per action; every handler is synchronous (it starts the
 *  lifecycle call and returns) and every one swallows its own failures. */
export interface DoorstopSessionLifecycleHandlers {
  readonly pin: (event: Event) => void;
  readonly archive: (event: Event) => void;
  readonly restore: (event: Event) => void;
}

/**
 * The machine-local lifecycle target for one labelled row. `sessions` is
 * scoped to `context.machine`, so the selection carries only the project,
 * workspace, and session identity. Exported for tests.
 */
export function doorstopSessionSelection(context: SessionLabelContextV5): PluginSessionSelection {
  return {
    projectId: context.workspace.projectId,
    workspaceId: context.workspace.id,
    sessionId: context.session.id,
  };
}

/**
 * Build the three lifecycle click handlers for one labelled row. Exported so
 * the handlers are testable without rendering: `items()`/`render()` only ever
 * build them, and only the DOM click actually runs one. The caller supplies a
 * present `sessions` (the render side gates on absence first).
 */
export function buildSessionLifecycleHandlers(
  context: SessionLabelContextV5,
  sessions: PluginSessionLifecycle,
): DoorstopSessionLifecycleHandlers {
  const selection = doorstopSessionSelection(context);
  // A lifecycle click is not a row click: no selection, no `#` jump, no
  // reopen navigation.
  const consume = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    pin: (event: Event): void => {
      consume(event);
      // The row snapshot has no `pinned` field: read the live state, then
      // toggle it. One settled chain, so a failing `get` never pins.
      void sessions
        .get(selection)
        .then((state) => (state.pinned ? sessions.unpin(selection) : sessions.pin(selection)))
        .catch(() => undefined);
    },
    archive: (event: Event): void => {
      consume(event);
      // A row still waiting for session creation has nothing complete to
      // archive: refuse before any lifecycle call or catalog read.
      if (context.session.pending) return;
      void (async (): Promise<void> => {
        // Refuse while the review is still running: archival means the review
        // is complete. `runtime` is the catalog snapshot's field (the
        // lifecycle state has none), and an unreadable snapshot is treated as
        // "cannot prove idle", so it archives nothing either.
        const snapshot = await context.catalog.sessions.get(selection);
        if (snapshot.runtime === "busy") return;
        await sessions.archive(selection);
      })().catch(() => undefined);
    },
    restore: (event: Event): void => {
      consume(event);
      void sessions.restore(selection).catch(() => undefined);
    },
  };
}

/** Static copy for the lifecycle buttons (tooltips keep the labels terse). */
const LIFECYCLE_BUTTON_COPY: Record<DoorstopSessionLifecycleAction, { label: string; title: string }> = {
  pin: {
    label: "Pin",
    title: "Toggle pin (protects this review session from cleanup)",
  },
  archive: {
    label: "Archive",
    title: "Archive this review session once its review is no longer running",
  },
  restore: {
    label: "Restore",
    title: "Restore this review session to the list",
  },
};

/** The lifecycle buttons for one labelled row (empty on an older host). */
function sessionLifecycleButtons(
  context: SessionLabelContextV5,
  handlers: DoorstopSessionLifecycleHandlers,
): TemplateResult {
  return html`${sessionLifecycleActions(context).map(
    (action) =>
      // The leading space keeps the inline link/button run legible without a
      // plugin stylesheet.
      html` <button
        type="button"
        class=${`doorstop-session-label-${action}`}
        title=${LIFECYCLE_BUTTON_COPY[action].title}
        @click=${handlers[action]}
      >${LIFECYCLE_BUTTON_COPY[action].label}</button>`,
  )}`;
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
