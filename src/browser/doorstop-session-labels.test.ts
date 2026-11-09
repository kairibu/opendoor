// @vitest-environment node
//
// Unit tests for the browser session-list row label (relay
// `opendoor-session-metadata-labels` design §3): the contribution shape, the
// pure/synchronous/tolerant `items()` behavior, the compact label text, the
// exact reopen destination + click navigation, and (plan-piweb-1-202611 §2.2)
// the session lifecycle buttons — event-handler-only calls, absence tolerance,
// the pure render-side gate, and the archive busy-refusal.

import { describe, expect, it, vi, type Mock } from "vitest";
import type { TemplateResult } from "lit";
import type {
  PluginCatalog,
  PluginSessionLifecycle,
  PluginSessionSnapshot,
  SessionLabelContextV5,
  SessionUiMetadata,
} from "@jmfederico/pi-web/plugin-api";
import {
  buildSessionLifecycleHandlers,
  createDoorstopSessionLabel,
  doorstopReopenDestination,
  doorstopSessionSelection,
  sessionLabelItems,
  sessionLifecycleActions,
} from "./doorstop-session-labels.js";
import { createFakeFiles } from "../test-support.js";
import { doorstopWorkspace, fakeCatalog, flushAll, flushMicro } from "../test-fixtures.js";

const PANEL_ID = "opendoor:workspace.doorstop";
const SELECTION = { projectId: "project-1", workspaceId: "workspace-1", sessionId: "session-1" };

interface LabelContextOptions {
  navigate?: Mock;
  archived?: boolean;
  /** When true, the row snapshot still waits for session creation (archive
   *  must refuse it before touching the catalog). */
  pending?: boolean;
  sessions?: PluginSessionLifecycle;
  /** When set, the context carries a catalog whose `sessions.get` resolves the
   *  given runtime (the field the archive handler's busy gate reads). */
  runtime?: PluginSessionSnapshot["runtime"];
}

function contextWith(metadata: SessionUiMetadata | undefined, options: LabelContextOptions = {}): SessionLabelContextV5 {
  const sessions = options.sessions;
  return {
    machine: { id: "local", name: "local", kind: "local" },
    // v5 context surface: the fake catalog is inert unless a test supplies a
    // runtime — the label reads no catalog data at render time.
    catalog: options.runtime === undefined ? fakeCatalog() : catalogWithRuntime(options.runtime),
    workspace: doorstopWorkspace,
    files: createFakeFiles().files,
    host: { requestRender: vi.fn() },
    session: {
      id: SELECTION.sessionId,
      cwd: doorstopWorkspace.path,
      archived: options.archived ?? false,
      pending: options.pending ?? false,
      // exactOptionalPropertyTypes: only attach the field when present.
      ...(metadata === undefined ? {} : { metadata }),
    },
    navigate: options.navigate ?? vi.fn(),
    // The lifecycle surface is optional: only present when a test supplies
    // one, exactly like an older host that omits it.
    ...(sessions === undefined ? {} : { sessions }),
  };
}

/** A catalog whose `sessions.get` resolves one snapshot with the given
 *  runtime/lifecycle bits (everything else is irrelevant to the label). */
function catalogWithRuntime(runtime: PluginSessionSnapshot["runtime"]): PluginCatalog {
  const base = fakeCatalog();
  return {
    ...base,
    sessions: {
      ...base.sessions,
      get: () =>
        Promise.resolve({
          id: SELECTION.sessionId,
          cwd: doorstopWorkspace.path,
          archived: false,
          created: null,
          modified: null,
          archivedAt: null,
          pinned: false,
          runtime,
        }),
    },
  };
}

interface FakeSessions {
  sessions: PluginSessionLifecycle;
  get: Mock<PluginSessionLifecycle["get"]>;
  pin: Mock<PluginSessionLifecycle["pin"]>;
  unpin: Mock<PluginSessionLifecycle["unpin"]>;
  archive: Mock<PluginSessionLifecycle["archive"]>;
  restore: Mock<PluginSessionLifecycle["restore"]>;
  delete: Mock<PluginSessionLifecycle["delete"]>;
}

/** A lifecycle surface whose `get` reports the given live pin state; every op
 *  resolves (or rejects when `hook.reject` names it) and records its calls. */
function fakeSessions(hook: { pinned?: boolean; reject?: "get" | "archive" | "restore" } = {}): FakeSessions {
  const reject = hook.reject;
  const get = vi.fn<PluginSessionLifecycle["get"]>(() =>
    reject === "get"
      ? Promise.reject(new Error("lifecycle get failed"))
      : Promise.resolve({ sessionId: SELECTION.sessionId, pinned: hook.pinned ?? false, archived: false }),
  );
  const pin = vi.fn<PluginSessionLifecycle["pin"]>(() => Promise.resolve());
  const unpin = vi.fn<PluginSessionLifecycle["unpin"]>(() => Promise.resolve());
  const archiveOp = vi.fn<PluginSessionLifecycle["archive"]>(() =>
    reject === "archive" ? Promise.reject(new Error("lifecycle archive failed")) : Promise.resolve(),
  );
  const restoreOp = vi.fn<PluginSessionLifecycle["restore"]>(() =>
    reject === "restore" ? Promise.reject(new Error("lifecycle restore failed")) : Promise.resolve(),
  );
  const del = vi.fn<PluginSessionLifecycle["delete"]>(() => Promise.resolve());
  return {
    sessions: { version: 1, machineId: "local", get, pin, unpin, archive: archiveOp, restore: restoreOp, delete: del },
    get,
    pin,
    unpin,
    archive: archiveOp,
    restore: restoreOp,
    delete: del,
  };
}

// --- render inspection helpers -------------------------------------------------
// The suite is node-env: lifecycle behavior is asserted through the exported
// handlers and the template VALUES lit produces (no DOM needed).

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function allTemplates(template: TemplateResult): TemplateResult[] {
  return [template, ...template.values.flatMap((value) => nestedTemplates(value))];
}

function nestedTemplates(value: unknown): TemplateResult[] {
  if (Array.isArray(value)) return value.flatMap((entry) => nestedTemplates(entry));
  return isTemplateResult(value) ? allTemplates(value) : [];
}

function renderedLabel(context: SessionLabelContextV5): TemplateResult {
  const item = sessionLabelItems(context, PANEL_ID)[0];
  if (item?.type !== "render") throw new Error("expected a render item");
  return item.render();
}

/** Every literal string a rendered label carries, across nested templates. */
function stringValues(template: TemplateResult): string[] {
  return allTemplates(template).flatMap((entry) => entry.values.filter((value): value is string => typeof value === "string"));
}

/** The literal markup (template strings only) a rendered label carries. */
function markup(template: TemplateResult): string {
  return allTemplates(template)
    .map((entry) => entry.strings.join(""))
    .join("");
}

/** The `doorstop-session-label-<action>` class of every rendered button. */
function buttonClasses(template: TemplateResult): string[] {
  return stringValues(template).filter((value) => value.startsWith("doorstop-session-label-"));
}

/** The click handler carried by the button for one lifecycle action. */
function clickHandler(
  template: TemplateResult,
  action: "pin" | "archive" | "restore",
): (event: Event) => void {
  const button = allTemplates(template).find((entry) =>
    entry.values.includes(`doorstop-session-label-${action}`),
  );
  if (button === undefined) throw new Error(`no rendered button for ${action}`);
  // The button template carries exactly one function value (@click); a second
  // listener added to the button would need an index-based lookup here.
  const handler = button.values.find((value): value is (event: Event) => void => typeof value === "function");
  if (handler === undefined) throw new Error(`no click handler for ${action}`);
  return handler;
}

function fakeEvent(): Event {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
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
    const context = contextWith(payload("REQ0001"), { navigate });
    const first = sessionLabelItems(context, PANEL_ID);
    const second = sessionLabelItems(context, PANEL_ID);
    expect(navigate).not.toHaveBeenCalled();
    expect(first).not.toBe(second);
    expect(first[0]?.type).toBe("render");
  });

  it("navigates to the Requirements panel on the row's workspace when clicked", () => {
    const navigate = vi.fn();
    const context = contextWith(payload("REQ0001", "REQ0002"), { navigate });
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

describe("session row lifecycle (plan-piweb-1-202611 §2.2)", () => {
  it("builds the machine-local selection from the row's workspace and session", () => {
    expect(doorstopSessionSelection(contextWith(payload("REQ0001")))).toEqual(SELECTION);
  });

  it("stays side-effect-free with a lifecycle surface present: neither items() nor render() calls a sessions method", () => {
    const fake = fakeSessions();
    const context = contextWith(payload("REQ0001"), { sessions: fake.sessions, runtime: "idle" });
    const items = sessionLabelItems(context, PANEL_ID);
    expect(items).toHaveLength(1);
    renderedLabel(context);
    for (const spy of [fake.get, fake.pin, fake.unpin, fake.archive, fake.restore, fake.delete]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("renders only the reopen link when the host omits sessions (older host)", () => {
    const context = contextWith(payload("REQ0001"));
    const template = renderedLabel(context);
    expect(sessionLifecycleActions(context)).toEqual([]);
    expect(markup(template)).toContain("<a");
    expect(markup(template)).not.toContain("<button");
    expect(buttonClasses(template)).toEqual([]);
  });

  it("offers pin + archive on active rows and pin + restore on archived rows, never archive and restore together", () => {
    const sessions = fakeSessions().sessions;
    const active = contextWith(payload("REQ0001"), { sessions });
    expect(sessionLifecycleActions(active)).toEqual(["pin", "archive"]);
    const activeTemplate = renderedLabel(active);
    expect(buttonClasses(activeTemplate)).toEqual(["doorstop-session-label-pin", "doorstop-session-label-archive"]);
    expect(markup(activeTemplate).match(/<button/gu) ?? []).toHaveLength(2);
    expect(markup(activeTemplate).match(/type="button"/gu) ?? []).toHaveLength(2);
    const activeStrings = stringValues(activeTemplate);
    expect(activeStrings).toContain("Pin");
    expect(activeStrings).toContain("Archive");
    expect(activeStrings).toContain("Toggle pin (protects this review session from cleanup)");

    const archived = contextWith(payload("REQ0001"), { sessions, archived: true });
    expect(sessionLifecycleActions(archived)).toEqual(["pin", "restore"]);
    const archivedTemplate = renderedLabel(archived);
    expect(buttonClasses(archivedTemplate)).toEqual(["doorstop-session-label-pin", "doorstop-session-label-restore"]);
    expect(markup(archivedTemplate).match(/<button/gu) ?? []).toHaveLength(2);
    expect(stringValues(archivedTemplate)).toContain("Restore");
  });

  it("toggles the pin from the live state: unpinned rows pin, pinned rows unpin", async () => {
    const unpinned = fakeSessions({ pinned: false });
    const activeContext = contextWith(payload("REQ0001"), { sessions: unpinned.sessions });
    clickHandler(renderedLabel(activeContext), "pin")(fakeEvent());
    await flushMicro();
    expect(unpinned.get).toHaveBeenCalledWith(SELECTION);
    expect(unpinned.pin).toHaveBeenCalledWith(SELECTION);
    expect(unpinned.unpin).not.toHaveBeenCalled();

    const pinned = fakeSessions({ pinned: true });
    const archivedContext = contextWith(payload("REQ0001"), { sessions: pinned.sessions, archived: true });
    clickHandler(renderedLabel(archivedContext), "pin")(fakeEvent());
    await flushMicro();
    expect(pinned.get).toHaveBeenCalledWith(SELECTION);
    expect(pinned.unpin).toHaveBeenCalledWith(SELECTION);
    expect(pinned.pin).not.toHaveBeenCalled();
  });

  it("refuses to archive a busy or pending session, and archives idle/not-hosted ones with the exact selection", async () => {
    const busy = fakeSessions();
    const busyContext = contextWith(payload("REQ0001"), { sessions: busy.sessions, runtime: "busy" });
    const busyHandler = clickHandler(renderedLabel(busyContext), "archive");
    expect(() => {
      busyHandler(fakeEvent());
    }).not.toThrow();
    await flushMicro();
    expect(busy.archive).not.toHaveBeenCalled();

    // A row still waiting for session creation is refused before the catalog
    // read, whatever the snapshot would say.
    const pending = fakeSessions();
    const pendingContext = contextWith(payload("REQ0001"), { sessions: pending.sessions, runtime: "idle", pending: true });
    clickHandler(renderedLabel(pendingContext), "archive")(fakeEvent());
    await flushMicro();
    expect(pending.archive).not.toHaveBeenCalled();

    for (const runtime of ["idle", "not-hosted"] as const) {
      const fake = fakeSessions();
      const context = contextWith(payload("REQ0001"), { sessions: fake.sessions, runtime });
      clickHandler(renderedLabel(context), "archive")(fakeEvent());
      await flushMicro();
      expect(fake.archive).toHaveBeenCalledWith(SELECTION);
    }
  });

  it("refuses to archive when the catalog snapshot is unreadable, without an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const fake = fakeSessions();
      // No `runtime` option: the context keeps the fixture catalog, whose
      // `sessions.get` rejects. "Cannot prove idle" must archive nothing.
      const context = contextWith(payload("REQ0001"), { sessions: fake.sessions });
      const event = fakeEvent();
      expect(() => {
        clickHandler(renderedLabel(context), "archive")(event);
      }).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
      await flushAll();
      expect(fake.archive).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("restores an archived row with the exact selection and never archives", async () => {
    const fake = fakeSessions();
    const navigate = vi.fn();
    const context = contextWith(payload("REQ0001"), { sessions: fake.sessions, archived: true, navigate });
    clickHandler(renderedLabel(context), "restore")(fakeEvent());
    await flushMicro();
    expect(fake.restore).toHaveBeenCalledWith(SELECTION);
    expect(fake.archive).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("swallows lifecycle failures, leaves no unhandled rejection, and never navigates or pins", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const navigate = vi.fn();
      const failingArchive = fakeSessions({ reject: "archive" });
      const archiveContext = contextWith(payload("REQ0001"), {
        navigate,
        sessions: failingArchive.sessions,
        runtime: "idle",
      });
      expect(() => {
        clickHandler(renderedLabel(archiveContext), "archive")(fakeEvent());
      }).not.toThrow();

      const failingGet = fakeSessions({ reject: "get" });
      const pinContext = contextWith(payload("REQ0001"), { navigate, sessions: failingGet.sessions });
      expect(() => {
        clickHandler(renderedLabel(pinContext), "pin")(fakeEvent());
      }).not.toThrow();

      const failingRestore = fakeSessions({ reject: "restore" });
      const restoreContext = contextWith(payload("REQ0001"), {
        navigate,
        sessions: failingRestore.sessions,
        archived: true,
      });
      expect(() => {
        clickHandler(renderedLabel(restoreContext), "restore")(fakeEvent());
      }).not.toThrow();

      await flushAll();
      expect(rejections).toEqual([]);
      expect(failingGet.pin).not.toHaveBeenCalled();
      expect(failingGet.unpin).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("makes every lifecycle click inert row-wise: default prevented, propagation stopped, no navigation", async () => {
    const fake = fakeSessions();
    const navigate = vi.fn();
    const active = renderedLabel(contextWith(payload("REQ0001"), { navigate, sessions: fake.sessions }));
    const archived = renderedLabel(
      contextWith(payload("REQ0001"), { navigate, sessions: fake.sessions, archived: true }),
    );
    const clicks: Array<[TemplateResult, "pin" | "archive" | "restore"]> = [
      [active, "pin"],
      [active, "archive"],
      [archived, "restore"],
    ];
    for (const [template, match] of clicks) {
      const event = fakeEvent();
      clickHandler(template, match)(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
    await flushMicro();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("buildSessionLifecycleHandlers exposes one synchronous handler per action", () => {
    const fake = fakeSessions();
    const handlers = buildSessionLifecycleHandlers(contextWith(payload("REQ0001"), { sessions: fake.sessions }), fake.sessions);
    for (const action of ["pin", "archive", "restore"] as const) expect(typeof handlers[action]).toBe("function");
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
