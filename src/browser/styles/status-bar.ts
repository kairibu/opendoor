import { css } from "lit";

/** Status-bar (region 5) styles: the status row, the auto-expanded last-run
 *  output body, its badge/meta and the truncation notices. */
export const statusBarStyles = css`
        /* --- status bar (region 5), sized to the host center status bar --- */
        .doorstop-status-bar {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          min-width: 0;
          /* Cap the whole bar at 38% of the panel (the pre-improvement cap),
             not 38vh: on a short viewport with a tall side panel a viewport
             unit can dwarf the panel. The cap cannot live on the body div
             (.doorstop-last-run) — its containing block (this bar) is
             content-sized, so a percentage max-height there would be treated
             as none — so the bar caps itself and the body shrinks (and
             scrolls) below it. */
          max-height: 38%;
          border-top: 1px solid var(--pi-border);
          background: var(--pi-bg);
          color: var(--pi-muted);
          font: 12px system-ui, sans-serif;
        }

        .doorstop-status-bar-row {
          flex: 0 0 auto; /* the status row never collapses under the body cap */
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          padding: 7px 12px;
          overflow: hidden;
          white-space: nowrap;
        }

        /* The status bar's expanded output body — no card chrome. Shrinks
           (and scrolls) when the bar hits its 38% cap; content-sized
           otherwise. */
        .doorstop-last-run {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 8px 12px 10px;
          border-top: 1px solid var(--pi-border-muted);
        }

        .doorstop-last-run-commit {
          margin: 0 0 6px;
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        .doorstop-last-run-status {
          flex: 0 0 auto; /* the badge label keeps its full width */
          border-radius: 999px;
          padding: 0 7px;
          font-size: 11px;
          white-space: nowrap;
        }

        .doorstop-last-run-status.is-ok {
          border: 1px solid var(--pi-success-border);
          color: var(--pi-success);
        }

        .doorstop-last-run-status.is-failed,
        .doorstop-last-run-status.is-error {
          border: 1px solid var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-last-run-status.is-killed {
          border: 1px solid var(--pi-warning);
          color: var(--pi-warning);
        }

        .doorstop-last-run-meta {
          /* Fills the row's leftover width (plain auto margins would instead
             push Dismiss right and leave the meta at content width), so the
             ellipsis only kicks in where space actually runs out — the run
             title never collapses to nothing while the badge/Dismiss pair
             stays fixed. */
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-last-run-dismiss {
          flex: 0 0 auto;
          /* Buttons do not inherit font; match the bar's 12px system-ui. */
          font: inherit;
        }

        .doorstop-last-run-pre {
          border: 1px solid var(--pi-border-muted);
          border-radius: 6px;
          background: var(--pi-surface);
          color: var(--pi-text);
          padding: 6px 8px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
          max-height: 12em;
          overflow: auto;
          margin: 4px 0 0;
        }

        .doorstop-last-run-notice {
          margin: 4px 0 0;
          color: var(--pi-muted);
          font-size: 11px;
        }
`;
