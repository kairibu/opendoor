import { css } from "lit";

/** Project-actions (region 1) styles: the toolbar, the document/state/search
 *  filters row, the project-scoped git strip + commit controls and the
 *  Items/Findings view toggle. */
export const projectActionsStyles = css`
        /* --- project actions (region 1) --- */
        .doorstop-project-actions {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--pi-border-muted);
        }

        /* --- list filters (above the item list, inside the viewer) --- */
        .doorstop-list-filters {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border-bottom: 1px solid var(--pi-border-muted);
        }

        .doorstop-title {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        .doorstop-docs {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 5px;
        }

        .doorstop-doc-chip {
          border-radius: 999px;
          padding: 2px 9px;
          font-size: 12px;
        }

        .doorstop-doc-chip.is-selected {
          border-color: var(--pi-accent);
          background: var(--pi-selection-bg);
          color: var(--pi-accent);
        }

        .doorstop-doc-arrow {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-doc-count {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: 0 0 auto;
        }

        .doorstop-dot-ok {
          background: var(--pi-success);
        }

        .doorstop-dot-unreviewed {
          background: var(--pi-warning);
        }

        .doorstop-dot-suspect {
          background: var(--pi-danger);
        }

        .doorstop-toolbar-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          margin-left: auto;
        }

        .doorstop-stale {
          border: 1px solid var(--pi-warning-border);
          border-radius: 999px;
          color: var(--pi-warning);
          padding: 1px 8px;
          font-size: 12px;
        }

        /* --- project-scoped git actions (plan-add-git-actions Phase D step 17) --- */
        .doorstop-git-status {
          /* The muted chip row: single line, ellipsis overflow at the row's
             own cap (the toolbar row wraps, so the chip never squeezes the
             title). The strip is a button — click re-fetches. text-overflow
             lives on the inner .doorstop-git-status-text span, NOT here: it
             only applies to BLOCK containers, and the button is inline-flex
             (the anonymous text flex item would hard-clip at the 240px cap
             with no ellipsis). This rule keeps overflow: hidden as the clip
             fallback and the chip's pill. */
          display: inline-flex;
          align-items: center;
          max-width: 240px;
          overflow: hidden;
          white-space: nowrap;
          border: 1px solid var(--pi-border-muted);
          border-radius: 999px;
          background: transparent;
          color: var(--pi-muted);
          padding: 2px 9px;
          font-size: 12px;
        }

        .doorstop-git-status-text {
          /* The ellipsis clip for the chip's text (see the parent rule): a
             BLOCK element inside the inline-flex button, with min-width: 0
             so it may shrink below its content width (the flexbox default
             min-width: auto would defeat the ellipsis — a flex item never
             overflow-clips below its content). */
          display: block;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .doorstop-git-status:hover:not(:disabled) {
          background: var(--pi-selection-bg);
        }

        .doorstop-git-status-error {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-git-commit {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        .doorstop-git-commit-input {
          /* Sized beside the existing toolbar buttons (the target inputs'
             width idiom) — wide enough for a real commit message, still
             one row in the toolbar. */
          width: 170px;
        }

        /* --- Items / Findings view toggle (spec §7.2) --- */
        .doorstop-view-toggle {
          display: inline-flex;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          overflow: hidden;
          flex: 0 0 auto;
        }

        .doorstop-view-tab {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: var(--pi-muted);
          padding: 3px 10px;
          font-size: 12px;
        }

        .doorstop-view-tab + .doorstop-view-tab {
          border-left: 1px solid var(--pi-border);
        }

        .doorstop-view-tab.is-selected {
          background: var(--pi-selection-bg);
          color: var(--pi-accent);
        }
`;
