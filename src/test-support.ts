// ---------------------------------------------------------------------------
// Shared test fixtures for the opendoor test suite (root-level module, excluded
// from the runtime build by scripts/build-plugin.mjs: only reachable from
// *.test.ts).
//
// One in-memory workspace-files fake serves the discovery tests (which need
// call-order tracking) and the panel tests (which need a full
// `WorkspaceFiles` for the host context): the real `context.files` satisfies
// the plugin's minimal `DoorstopFiles` adapter (src/doorstop-contract.ts)
// structurally, and so does this fake.
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import type {
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  WorkspaceFiles,
} from "@jmfederico/pi-web/plugin-api";

export interface FakeFilesOptions {
  trees?: Record<string, FileTreeResponse>;
  /** Directory paths whose listFiles rejects with the given error message. */
  listErrors?: Record<string, string>;
  /** File paths to result content/flags, or an Error to reject with. */
  reads?: Record<string, FileContentResponse | Error>;
}

export interface FakeWorkspaceFiles {
  files: WorkspaceFiles;
  listFiles: ReturnType<typeof vi.fn<WorkspaceFiles["listFiles"]>>;
  readFile: ReturnType<typeof vi.fn<WorkspaceFiles["readFile"]>>;
  /** Every listFiles path in call order (root first, then the walk order). */
  listCalls: string[];
  /** Every readFile path in call order. */
  readCalls: string[];
}

/**
 * In-memory workspace files adapter. Paths absent from `trees`/`reads`
 * reject with exactly "Path does not exist" — the real workspace API's
 * missing-file error message (matching it matters: the settings module
 * treats a read rejection with that exact message as a missing-optional-file
 * default state, not a failure).
 */
export function createFakeFiles(options: FakeFilesOptions = {}): FakeWorkspaceFiles {
  const listCalls: string[] = [];
  const readCalls: string[] = [];
  const listFiles = vi.fn<WorkspaceFiles["listFiles"]>((path: string) => {
    listCalls.push(path);
    const error = options.listErrors?.[path];
    if (error !== undefined) return Promise.reject(new Error(error));
    const tree = options.trees?.[path];
    if (tree === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve(tree);
  });
  const readFile = vi.fn<WorkspaceFiles["readFile"]>((path: string) => {
    readCalls.push(path);
    const read = options.reads?.[path];
    if (read === undefined) return Promise.reject(new Error("Path does not exist"));
    if (read instanceof Error) return Promise.reject(read);
    return Promise.resolve(read);
  });
  return {
    files: {
      listFiles,
      readFile,
      // Unused by the opendoor plugin; present so the fake stays a full WorkspaceFiles.
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    listFiles,
    readFile,
    listCalls,
    readCalls,
  };
}

export function dirEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "directory" };
}

export function fileEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "file" };
}

export function symlinkEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "symlink" };
}

export function tree(entries: FileTreeEntry[], truncated = false): FileTreeResponse {
  return { path: "", entries, scannedAt: "", truncated };
}

export function text(content: string): FileContentResponse {
  return { path: "", content, truncated: false, binary: false, encoding: "utf8", size: 0, modifiedAt: "" };
}
