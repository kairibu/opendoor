// @vitest-environment happy-dom
//
// Browser-entry test for the opendoor plugin (integration chain F), mirroring
// OpenSE's pi-web-plugin.test.ts and the git entry-test pattern: activate the
// bundled entry's default export with the activation context the host
// actually supplies (parsePluginModule → activate), then assert the returned
// contributions carry the always-visible Requirements panel, the two
// unconditional actions, and the informational status label — and that the
// actions reach the host navigation/refresh entry points with the
// runtime-qualified panel id. Structural wiring only; the render/load
// behavior is covered by doorstop-panel.test.ts /
// doorstop-panel-element.test.ts / doorstop-contributions.test.ts.

import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContextV5, WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";
import { doorstopWorkspace, fakeCatalog, runtimeContext } from "../test-fixtures.js";

describe("bundled opendoor browser entry", () => {
  it("exports the host-expected plugin shape and contributes panel, actions, and label", async () => {
    expect(plugin.apiVersion).toBe(5);
    expect(plugin.name).toBe("Opendoor");
    expect(typeof plugin.activate).toBe("function");

    const contributions = await activate("opendoor");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected opendoor workspace panel");
    const label = contributions.workspaceLabels?.[0];
    if (label === undefined) throw new Error("Expected opendoor workspace label");
    const context = panelContext();

    // Browser-only plugin: panel is always visible, never ownership-gated.
    // Plan Phase C step C3 follow-up — order 5, below the bundled Files
    // panel's order 10 (which answers every chat file link unconditionally
    // in the host's first-accepting-panel dispatch): a higher order would
    // silently disable the C3 fileOpenQuery claim. See the guard comment in
    // doorstop-contributions.test.ts.
    expect(panel.id).toBe("workspace.doorstop");
    expect(panel.title).toBe("Requirements");
    expect(panel.order).toBe(5);
    expect(panel.order).toBeLessThan(10);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.(context)).toBe(true);
    expect(typeof panel.onInvalidate).toBe("function");
    expect(typeof panel.render).toBe("function");

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.doorstop", "workspace.refresh-doorstop"]);

    // The informational status label contribution (feature spec §7.4).
    expect(label.id).toBe("doorstop-status");
    expect(label.order).toBe(10);
    expect(typeof label.visible).toBe("function");
    expect(typeof label.items).toBe("function");
  });

  it("wires the two actions to host navigation/refresh with the runtime-qualified panel id", async () => {
    const contributions = await activate("opendoor");
    const goToRequirements = contributions.actions?.find((action) => action.id === "view.doorstop");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-doorstop");
    if (goToRequirements === undefined || refresh === undefined) {
      throw new Error("Expected both opendoor actions");
    }

    expect(goToRequirements.shortcut).toBe("mod+7");
    expect(goToRequirements.group).toBe("Navigation");
    expect(refresh.shortcut).toBe("mod+shift+d");
    expect(refresh.group).toBe("Workspace");
    // Unconditional: no `enabled` gate at all (no provider ownership to gate on).
    expect(goToRequirements.enabled).toBeUndefined();
    expect(refresh.enabled).toBeUndefined();

    const selectWorkspaceTool = vi.fn<PluginRuntimeContextV5["selectWorkspaceTool"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContextV5["refreshWorkspacePanels"]>();
    const runtime = runtimeContext({ selectWorkspaceTool, refreshWorkspacePanels });

    await goToRequirements.run(runtime);
    expect(selectWorkspaceTool).toHaveBeenCalledWith("opendoor:workspace.doorstop");

    await refresh.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("opendoor:workspace.doorstop");
  });
});

// Plan §2.1 (decision D1, reasoned in doorstop-markdown.ts): the plugin
// DECLARES the host markdown-rendering capability, resolves it in `start()`,
// and the panel wiring mirrors the resolved renderer onto the body element.
describe("host markdown rendering (plan §2.1)", () => {
  it("declares pi-web/markdown-rendering@1 — the plugin's effective host floor", () => {
    const requirement = plugin.requires?.find(({ id }) => id === "markdown-rendering");
    if (requirement === undefined) throw new Error("Expected the markdown-rendering requirement");
    expect(requirement.pluginId).toBe("pi-web");
    expect(requirement.version).toBe(1);
    // The requirement is exactly the plugin's whole requirement list: no
    // other capability is declared, so nothing else can raise the floor.
    expect(plugin.requires).toHaveLength(1);

    // parse() is the host-boundary guard: a mismatched capability value must
    // fail loudly at resolve time, never produce a render call on `undefined`.
    expect(() => requirement.parse({})).toThrow(/markdown rendering/i);
    expect(() => requirement.parse({ render: "nope" })).toThrow(/markdown rendering/i);
    const renderer = { render: () => html`<span></span>` };
    expect(requirement.parse(renderer)).toBe(renderer);
  });

  it("resolves the renderer in start() and binds it onto the panel body element", async () => {
    const activation = await activatePlugin("opendoor");
    const requirement = plugin.requires?.[0];
    if (requirement === undefined) throw new Error("Expected the markdown-rendering requirement");
    const renderer = { render: () => html`<span></span>` };
    const requested: string[] = [];

    expect(typeof activation.start).toBe("function");
    await activation.start?.({
      signal: new AbortController().signal,
      capabilities: {
        resolve: <Value,>(capability: { id: string; parse: (value: unknown) => Value }) => {
          requested.push(capability.id);
          return capability.parse(renderer);
        },
      },
    });
    expect(requested).toEqual(["markdown-rendering"]);

    // The panel render function closed over the holder BEFORE start(), so this
    // proves the late binding: the render issued after start() carries the
    // resolved renderer, which is what the detail pane's item body uses.
    const panel = activation.contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected opendoor workspace panel");
    const template = panel.render(panelContext());
    expect(template.values).toContain(renderer);
  });
});

async function activate(runtimePluginId: string) {
  const activation = await activatePlugin(runtimePluginId);
  return activation.contributions;
}

async function activatePlugin(runtimePluginId: string) {
  return await plugin.activate({
    apiVersion: 5,
    pluginId: "opendoor",
    runtimePluginId,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  });
}

function panelContext(workspace = doorstopWorkspace, machineId = "local"): WorkspacePanelContextV5 {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    // v5 context surface: the fake catalog (and absent backend) is inert —
    // the plugin never consults either; see fakeCatalog in test-fixtures.
    catalog: fakeCatalog(machineId),
    workspace,
    state: {
      selectedWorkspace: workspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "workspace",
    },
    // pi-web 1.202610.3 made `navigate` required on `WorkspacePanelContext`;
    // the plugin never calls it, so a no-op stub satisfies the contract.
    navigate: async () => undefined,
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}
