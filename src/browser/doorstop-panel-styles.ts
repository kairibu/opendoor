import { css } from "lit";
import { baseStyles } from "./styles/base.js";
import { projectActionsStyles } from "./styles/project-actions.js";
import { itemListStyles, findingsStyles } from "./styles/item-list.js";
import { detailPaneStyles } from "./styles/detail-pane.js";
import { itemActionPaletteStyles } from "./styles/item-action-palette.js";
import { statusBarStyles } from "./styles/status-bar.js";

/** The body element's styles: one concatenation of the per-section `css`
 *  fragments (in the ORIGINAL source order — base, project actions, item list,
 *  detail pane, item action palette, findings/empty, status bar), so the
 *  rendered CSS is byte-identical to the single template this replaced. */
export const panelStyles = css`${baseStyles}${projectActionsStyles}${itemListStyles}${detailPaneStyles}${itemActionPaletteStyles}${findingsStyles}${statusBarStyles}`;
