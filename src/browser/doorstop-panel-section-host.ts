import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import type { ItemRecord, ItemStateKey } from "../doorstop-contract.js";
import type {
  DoorstopGitStatusFile,
  DoorstopGitStatusResponse,
  DoorstopRunRequest,
} from "../doorstop-backend-contract.js";
import type {
  DoorstopGitStatusView,
  DoorstopLastRunView,
  DoorstopWorkspaceController,
} from "./doorstop-panel-controller.js";
import type { DoorstopWorkspaceResult } from "./doorstop-panel.js";
import type { DoorstopPanelView } from "./doorstop-panel-view-model.js";

/**
 * The narrow section API: the exact slice of the panel element the
 * `sections/*` render functions and handlers may touch.
 *
 * `doorstop-panel-element.ts` is the only implementation. Sections import this
 * interface TYPE-only, so the runtime dependency stays one-way
 * (coordinator → sections); the coordinator imports the section modules and
 * passes itself as the `host` argument.
 */
export interface DoorstopPanelSectionsApi {
  // --- mirrored reactive properties -------------------------------------------
  /** Actions only; rendered inputs arrive via the mirrored properties. */
  controller: DoorstopWorkspaceController | undefined;
  /** Terminal + prompt editor. */
  context: WorkspacePanelContext | undefined;
  result: DoorstopWorkspaceResult | undefined;
  loading: boolean;
  stale: boolean;
  selectedUid: string | undefined;
  selectedDocumentPrefix: string | undefined;
  stateFilter: ItemStateKey | undefined;
  search: string;
  lastRun: DoorstopLastRunView | undefined;
  runInProgress: string | undefined;
  gitStatusView: DoorstopGitStatusView | undefined;
  gitStatusInFlight: boolean;

  // --- element-local state ----------------------------------------------------
  view: DoorstopPanelView;
  statusExpanded: boolean;
  askMenuOpen: boolean;
  targetError: string | undefined;
  gitActionError: string | undefined;
  gitCommitMessage: string;
  confirmSkipped: boolean;

  // --- refs -------------------------------------------------------------------
  readonly linkInputRef: Ref<HTMLInputElement>;
  readonly gitCommitInputRef: Ref<HTMLInputElement>;

  // --- shared actions ---------------------------------------------------------
  selectedItem(): ItemRecord | undefined;
  backendActive(): boolean;
  /** The shared state chip (item rows + detail head); the free renderer lives
   *  in `sections/item-list.ts`, so detail-pane reaches it through the host
   *  instead of importing a sibling section (no runtime section↔section cycle). */
  renderStateChip(key: ItemStateKey): TemplateResult;
  readyGitStatus(): DoorstopGitStatusResponse | undefined;
  readyGitFiles(): Map<string, DoorstopGitStatusFile> | undefined;
  stageItem(item: ItemRecord): void;
  unstageItem(item: ItemRecord): void;
  insertPrompt(text: string): void;
  runDoorstop(
    op: DoorstopRunRequest["op"],
    title: string,
    input: DoorstopRunRequest,
    terminalCommand: string,
    open: boolean,
  ): void;
}
