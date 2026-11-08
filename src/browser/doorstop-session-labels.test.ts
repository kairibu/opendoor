// @vitest-environment node
//
// Unit tests for the browser session-list row label (relay
// `opendoor-session-metadata-labels` design §3): the contribution shape, the
// pure/synchronous/tolerant `items()` behavior, the compact label text, and
// the exact reopen destination + click navigation.

import { describe, expect, it, vi } from "vitest";
import type { SessionLabelContextV5, SessionUiMetadata } from "@jmfederico/pi-web/plugin-api";
import {
  createDoorstopSessionLabel,
  doorstopReopenDestination,
  sessionLabelItems,
} from "./doorstop-session-labels.js";
import { createFakeFiles } from "../test-support.js";
import { doorstopWorkspace, fakeCatalog } from "../test-fixtures.js";

const PANEL_ID = "opendoor:workspace.doorstop";

function contextWith(metadata: SessionUiMetadata | undefined, navigate = vi.fn()): SessionLabelContextV5 {
  return {
    machine: { id: "local", name: "local", kind: "local" },
    // v5 context surface: the fake catalog is inert — the label never
    // consults it (see fakeCatalog in test-fixtures).
    catalog: fakeCatalog(),
    workspace: doorstopWorkspace,
    files: createFakeFiles().files,
    host: { requestRender: vi.fn() },
    session: {
      id: "session-1",
      cwd: doorstopWorkspace.path,
      archived: false,
      pending: false,
      // exactOptionalPropertyTypes: only attach the field when present.
      ...(metadata === undefined ? {} : { metadata }),
    },
    navigate,
  };
}

function payload(...uids: string[]): SessionUiMetadata {
  return { opendoor: { schema: 1, op: "review", uids } };
}

describe("createDoorstopSessionLabel", () => {
  it("contributes one synchronous items() callback under the reviewed id/order", () => {
    const label = createDoorstopSessionLabel("opendoor");
    expect(label.id).toBe("doorstop.review");
    expect(label.order).toBe(10);
    expect(typeof label.items).toBe("function");
    // No `visible` gate: absent metadata already yields no items.
    expect(label.visible).toBeUndefined();
  });
});

describe("sessionLabelItems", () => {
  it("renders nothing without metadata, for foreign namespaces, and for junk/future schemas", () => {
    expect(sessionLabelItems(contextWith(undefined), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ other: { schema: 1, op: "review", uids: ["REQ0001"] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opendoor: { schema: 2, op: "review", uids: ["REQ0001"] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opendoor: { schema: 1, op: "review", uids: [] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opendoor: "junk" as never }), PANEL_ID)).toEqual([]);
  });

  it("renders ONE render item with the compact first-UID + count text", () => {
    const single = sessionLabelItems(contextWith(payload("REQ0001")), PANEL_ID);
    expect(single).toHaveLength(1);
    expect(single[0]?.type).toBe("render");

    const many = sessionLabelItems(contextWith(payload("REQ0001", "REQ0002", "REQ0003")), PANEL_ID);
    expect(many).toHaveLength(1);
    const item = many[0];
    if (item?.type !== "render") throw new Error("expected a render item");
    const template = item.render();
    expect(template.values).toContain("REQ0001 +2");
    expect(template.values).toContain("Open REQ0001, REQ0002, REQ0003 in Requirements");
  });

  it("is side-effect-free: items() never navigates and returns fresh arrays", () => {
    const navigate = vi.fn();
    const context = contextWith(payload("REQ0001"), navigate);
    const first = sessionLabelItems(context, PANEL_ID);
    const second = sessionLabelItems(context, PANEL_ID);
    expect(navigate).not.toHaveBeenCalled();
    expect(first).not.toBe(second);
    expect(first[0]?.type).toBe("render");
  });

  it("navigates to the Requirements panel on the row's workspace when clicked", () => {
    const navigate = vi.fn();
    const context = contextWith(payload("REQ0001", "REQ0002"), navigate);
    const items = sessionLabelItems(context, PANEL_ID);
    const item = items[0];
    if (item?.type !== "render") throw new Error("expected a render item");
    const handler = item
      .render()
      .values.find((value): value is (event: Event) => void => typeof value === "function");
    if (handler === undefined) throw new Error("expected a click handler");

    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    // The FIRST UID is the deep-link target; the count suffix is display-only.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      machineId: "local",
      projectId: "project-1",
      workspaceId: "workspace-1",
      view: "workspace",
      tool: PANEL_ID,
      query: { uid: "REQ0001" },
    });
  });
});

describe("doorstopReopenDestination", () => {
  it("builds the exact complete destination using the panel's uid deep-link key", () => {
    expect(doorstopReopenDestination("machine-9", doorstopWorkspace, PANEL_ID, "TST0042")).toEqual({
      machineId: "machine-9",
      projectId: "project-1",
      workspaceId: "workspace-1",
      view: "workspace",
      tool: PANEL_ID,
      query: { uid: "TST0042" },
    });
  });
});
