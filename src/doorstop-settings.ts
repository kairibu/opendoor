// ---------------------------------------------------------------------------
// Opendoor workspace settings: reads and validates `.pi-web/opendoor.json`,
// the per-workspace configuration file for the opendoor plugin.
//
// WHY A WORKSPACE FILE INSTEAD OF `plugins.<id>.settings`:
//
//   PI WEB's top-level `plugins.<id>.settings` object is captured "for a
//   server entry only at sessiond startup" (plugins.md §plugin enablement;
//   `ServerPluginActivationContext.settings`). It is part of the SESSION
//   DAEMON's startup snapshot — there is no `settings` on the browser
//   `PluginActivationContext` — and its authoritative copy lives in the
//   machine's PI WEB config, not in the workspace. Opendoor's server entry
//   does receive that object (`ServerPluginActivationContext.settings`) and
//   uses it for host-scoped knobs — which `doorstop` binary to run and the
//   exec timeout (see doorstop-backend.ts) — but it is a session-daemon
//   startup snapshot, not workspace configuration. A settings value that is
//   really about a specific workspace — where the Doorstop publish output
//   goes, which directories the discovery walk
//   should skip — belongs in that workspace, travels with it under version
//   control, and is read through the same `context.files` adapter the rest
//   of the plugin uses. The bundled `workspace-tasks` plugin establishes
//   this exact pattern (`.pi-web/tasks.json` read via `files.readFile`),
//   and opendoor mirrors it: `.pi-web/opendoor.json` is the workspace-local
//   config this plugin reads.
//
// Reading is total and non-throwing, mirroring the discovery idiom: a
// missing file means defaults with no diagnostic (settings are OPTIONAL —
// the plugin works out of the box with no config file at all); a present
// but malformed/out-of-shape file becomes a warning diagnostic and falls
// back to defaults, never throwing. Unknown keys are tolerated silently for
// forward compatibility, EXCEPT a wrong `version` (the version gate is the
// one strict thing: an unrecognized future schema must not be half-read).
//
// Validation:
//
//   - publishTarget: a safe RELATIVE path (the shared contract grammar
//     `isValidPublishTarget`, src/doorstop-backend-contract.ts — no `..`
//     segment, not absolute, no Windows drive-letter prefix, no backslash;
//     trimmed; duplicate and trailing separators are normalized away).
//     Default "./public". An invalid value is warned about and replaced
//     with the default — never used to write outside the workspace.
//     The same rule validates backend publish requests (Phase B), so both
//     sides agree on what a publish target may be.
//   - excludedDirectories: plain directory NAMES (no `/` or `\`
//     separators, no `..`, trimmed), each ≤ 64 chars, deduplicated, capped
//     at 16 entries. Invalid entries are warned about and dropped; the
//     extras beyond the cap are dropped with one warning. The discovery
//     chain merges these with its built-in `.git`/`node_modules` skip set.
// ---------------------------------------------------------------------------

import { isValidPublishTarget } from "./doorstop-backend-contract.js";
import { formatUnknownError, isRecord } from "./doorstop-contract.js";
import type {
  DiscoveryDiagnostic,
  DoorstopFileContent,
  DoorstopFiles,
} from "./doorstop-contract.js";

/** Workspace-relative path of the opendoor settings file (the workspace-tasks
 *  `.pi-web/tasks.json` idiom). */
export const OPENDOOR_SETTINGS_PATH = ".pi-web/opendoor.json";
/** Supported schema version — must be exactly this when present. */
export const OPENDOOR_SETTINGS_VERSION = 1;
/** Default publish target directory (relative to the workspace root). */
export const DEFAULT_PUBLISH_TARGET = "./public";
/** Hard cap on distinct excluded-directory names. */
export const MAX_EXCLUDED_DIRECTORIES = 16;
/** Hard cap on the length of one excluded-directory name. */
export const MAX_EXCLUDED_DIRECTORY_LENGTH = 64;

/** Normalized opendoor workspace settings. */
export interface OpendoorSettings {
  /** Directory the publish action writes to, relative to the workspace root
   *  (default "./public"). Always a safe relative path after validation. */
  publishTarget: string;
  /** Plain directory names the discovery walk skips, merged with the
   *  built-in `.git`/`node_modules` skip set. Validated, deduplicated, and
   *  capped at {@link MAX_EXCLUDED_DIRECTORIES}. */
  excludedDirectories: readonly string[];
}

/** The out-of-the-box settings (no config file, or a file that failed to
 *  parse far enough to contribute any field). Frozen at module load: this
 *  object is handed out by reference on every defaults path, so a consumer
 *  accidentally mutating what it received must not corrupt the shared
 *  default for everyone else. */
export const DEFAULT_OPENDOOR_SETTINGS: Readonly<OpendoorSettings> = Object.freeze({
  publishTarget: DEFAULT_PUBLISH_TARGET,
  excludedDirectories: Object.freeze([]),
});

/** Outcome of reading the workspace settings file. */
export interface OpendoorSettingsResult {
  settings: OpendoorSettings;
  diagnostics: DiscoveryDiagnostic[];
}

/** The real workspace API's missing-file error message (the workspace-tasks
 *  and relay discovery idioms match this exact string). This is the
 *  load-time hot path: the EXACT match is the boundary between the benign
 *  "no settings file" default and a surfaced "Could not read" warning. The
 *  fake in src/test-support.ts (createFakeFiles) mirrors this message
 *  deliberately, and doorstop-settings.test.ts pins the coupling on BOTH
 *  sides (the fake's exact message, plus that a near-miss message like
 *  "Path does not exist: <path>" warns instead of defaulting) so a drift on
 *  either side fails loudly. */
const MISSING_FILE_ERROR = "Path does not exist";

/** Cap how much of a raw settings value is echoed into a diagnostic, so a
 *  hostile (or merely enormous) value cannot balloon a warning into a
 *  multi-megabyte message. */
function truncateEcho(value: string): string {
  const MAX_ECHO_LENGTH = 80;
  return value.length <= MAX_ECHO_LENGTH ? value : `${value.slice(0, MAX_ECHO_LENGTH)}…`;
}

/**
 * Read and validate `.pi-web/opendoor.json` through the injected files
 * adapter. Missing file → defaults with no diagnostic; a present but
 * unreadable/malformed/out-of-shape file → warning diagnostic(s) + defaults.
 * Never throws.
 */
export async function readOpendoorSettings(files: DoorstopFiles): Promise<OpendoorSettingsResult> {
  let file: DoorstopFileContent;
  try {
    file = await files.readFile(OPENDOOR_SETTINGS_PATH);
  } catch (error) {
    // A missing settings file is the normal, supported default state — the
    // plugin works with no config file at all. Any OTHER read failure
    // (permission, I/O) is worth surfacing.
    if (error instanceof Error && error.message === MISSING_FILE_ERROR) {
      return { settings: DEFAULT_OPENDOOR_SETTINGS, diagnostics: [] };
    }
    return {
      settings: DEFAULT_OPENDOOR_SETTINGS,
      diagnostics: [
        {
          severity: "warning",
          path: OPENDOOR_SETTINGS_PATH,
          message: `Could not read ${OPENDOOR_SETTINGS_PATH}: ${formatUnknownError(error)}`,
        },
      ],
    };
  }
  if (file.binary) {
    return {
      settings: DEFAULT_OPENDOOR_SETTINGS,
      diagnostics: [{ severity: "warning", path: OPENDOOR_SETTINGS_PATH, message: `${OPENDOOR_SETTINGS_PATH} must be a text file; using defaults` }],
    };
  }
  if (file.truncated) {
    return {
      settings: DEFAULT_OPENDOOR_SETTINGS,
      diagnostics: [{ severity: "warning", path: OPENDOOR_SETTINGS_PATH, message: `${OPENDOOR_SETTINGS_PATH} is too large and was truncated; using defaults` }],
    };
  }
  return parseOpendoorSettingsText(file.content);
}

/** Parse + validate settings from raw file text. Never throws: malformed JSON
 *  or a wrong shape becomes a warning diagnostic + defaults. */
export function parseOpendoorSettingsText(text: string): OpendoorSettingsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      settings: DEFAULT_OPENDOOR_SETTINGS,
      diagnostics: [
        {
          severity: "warning",
          path: OPENDOOR_SETTINGS_PATH,
          message: `Invalid JSON in ${OPENDOOR_SETTINGS_PATH}: ${formatUnknownError(error)}`,
        },
      ],
    };
  }
  return parseOpendoorSettings(parsed);
}

/** Validate a parsed settings value (the JSON top level). Unknown keys are
 *  tolerated silently for forward compatibility; a wrong `version` is the one
 *  strict gate (an unrecognized future schema must not be half-read). */
export function parseOpendoorSettings(value: unknown): OpendoorSettingsResult {
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (!isRecord(value)) {
    diagnostics.push({
      severity: "warning",
      path: OPENDOOR_SETTINGS_PATH,
      message: `${OPENDOOR_SETTINGS_PATH} must contain a JSON object; using defaults`,
    });
    return { settings: DEFAULT_OPENDOOR_SETTINGS, diagnostics };
  }

  // The version gate: when present it must be exactly the supported version.
  // Everything else is forward-compatible-by-ignoring, but an unknown schema
  // must not be half-read into settings we then act on.
  if (value["version"] !== undefined && value["version"] !== OPENDOOR_SETTINGS_VERSION) {
    diagnostics.push({
      severity: "warning",
      path: OPENDOOR_SETTINGS_PATH,
      message: `${OPENDOOR_SETTINGS_PATH} has an unsupported "version" (${truncateEcho(String(value["version"]))}); using defaults`,
    });
    return { settings: DEFAULT_OPENDOOR_SETTINGS, diagnostics };
  }

  // publishTarget: a safe relative path (shared contract grammar
  // `isValidPublishTarget`), else the default.
  let publishTarget = DEFAULT_PUBLISH_TARGET;
  const rawTarget = value["publishTarget"];
  if (rawTarget !== undefined) {
    const candidate = typeof rawTarget === "string" ? rawTarget.trim() : "";
    if (!isValidPublishTarget(candidate)) {
      diagnostics.push({
        severity: "warning",
        path: OPENDOOR_SETTINGS_PATH,
        message: `${OPENDOOR_SETTINGS_PATH} has an invalid "publishTarget" ("${truncateEcho(String(rawTarget))}"); using default "${DEFAULT_PUBLISH_TARGET}"`,
      });
    } else {
      publishTarget = normalizeRelativePath(candidate);
    }
  }

  // excludedDirectories: an array of plain names, validated/deduped/capped.
  let excludedDirectories: string[] = [];
  const rawExcluded = value["excludedDirectories"];
  if (rawExcluded !== undefined) {
    if (!Array.isArray(rawExcluded)) {
      diagnostics.push({
        severity: "warning",
        path: OPENDOOR_SETTINGS_PATH,
        message: `${OPENDOOR_SETTINGS_PATH} "excludedDirectories" must be an array; using none`,
      });
    } else {
      excludedDirectories = parseExcludedDirectories(rawExcluded, diagnostics);
    }
  }

  return { settings: { publishTarget, excludedDirectories }, diagnostics };
}

/** Validate the excluded-directory names: plain names only (no separators, no
 *  `..`, trimmed), each ≤ {@link MAX_EXCLUDED_DIRECTORY_LENGTH}, deduplicated
 *  and capped at {@link MAX_EXCLUDED_DIRECTORIES}. Invalid entries become
 *  warning diagnostics and are dropped. */
function parseExcludedDirectories(entries: unknown[], diagnostics: DiscoveryDiagnostic[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !isPlainDirectoryName(entry.trim())) {
      diagnostics.push({
        severity: "warning",
        path: OPENDOOR_SETTINGS_PATH,
        message: `${OPENDOOR_SETTINGS_PATH} "excludedDirectories" entry "${truncateEcho(String(entry))}" is not a plain directory name and was dropped`,
      });
      continue;
    }
    const name = entry.trim();
    if (seen.has(name)) continue; // duplicates are deduplicated silently
    if (result.length >= MAX_EXCLUDED_DIRECTORIES) {
      diagnostics.push({
        severity: "warning",
        path: OPENDOOR_SETTINGS_PATH,
        message: `${OPENDOOR_SETTINGS_PATH} "excludedDirectories" has more than ${String(MAX_EXCLUDED_DIRECTORIES)} entries; the rest were ignored`,
      });
      break;
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** Normalize an accepted publish target so a later join stays predictable:
 *  duplicate separators collapse and a trailing separator drops (a leading
 *  `./` is preserved — the default spelling). The acceptance rule itself
 *  lives in the shared contract (`isValidPublishTarget`, imported above) so
 *  the settings chain and the server bundle validate identically. */
function normalizeRelativePath(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** A plain directory name: non-empty, no `/` or `\` separators, no `..`, and
 *  within the length cap. */
function isPlainDirectoryName(name: string): boolean {
  if (name === "") return false;
  if (name === "." || name === "..") return false;
  if (name.length > MAX_EXCLUDED_DIRECTORY_LENGTH) return false;
  return !name.includes("/") && !name.includes("\\") && !name.includes("..");
}
