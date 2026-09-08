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
// doorstop-panel-elements.test.ts / doorstop-contributions.test.ts.

import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContext, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const doorstopWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/repo",
  label: "main",
  isMain: true,
};

describe("bundled opendoor browser entry", () => {
  it("exports the host-expected plugin shape and contributes panel, actions, and label", () => {
    expect(plugin.apiVersion).toBe(2);
    expect(plugin.name).toBe("Opendoor");
    expect(typeof plugin.activate).toBe("function");

    const contributions = activate("opendoor");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected opendoor workspace panel");
    const label = contributions.workspaceLabels?.[0];
    if (label === undefined) throw new Error("Expected opendoor workspace label");
    const context = panelContext();

    // Browser-only plugin: panel is always visible, never ownership-gated.
    expect(panel.id).toBe("workspace.doorstop");
    expect(panel.title).toBe("Requirements");
    expect(panel.order).toBe(60);
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
    const contributions = activate("opendoor");
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

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>();
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });

    await goToRequirements.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("opendoor:workspace.doorstop");

    await refresh.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("opendoor:workspace.doorstop");
  });
});

function activate(runtimePluginId: string) {
  return plugin.activate({ apiVersion: 2, pluginId: "opendoor", runtimePluginId, html, svg }).contributions;
}

function panelContext(workspace = doorstopWorkspace, machineId = "local"): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: {
      selectedWorkspace: workspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
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

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: {
      selectedWorkspace: doorstopWorkspace,
      workspaceTool: "opendoor:workspace.doorstop",
      mainView: "opendoor:workspace.doorstop",
    },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}
