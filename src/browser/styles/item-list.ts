import { css } from "lit";

/** Item-list styles: the viewer/split shell, the list and its rows, the
 *  configured-attribute column, the per-row git affordance and the shared state
 *  chips — plus {@link findingsStyles} (the findings view and the empty states,
 *  which sit after the palette in the source order). */
export const itemListStyles = css`
        /* --- viewer (regions 2 + 3; the filters row and split stack) --- */
        .doorstop-viewer {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .doorstop-standalone {
          margin: 14px;
        }

        .doorstop-error {
          margin: 8px;
          border: 1px solid var(--pi-danger);
          border-radius: 7px;
          color: var(--pi-danger);
          padding: 8px;
        }

        .doorstop-diagnostics {
          position: sticky;
          top: 0;
          z-index: 1;
          background: var(--pi-bg);
          border-bottom: 1px solid var(--pi-border);
          padding: 6px;
          display: grid;
          gap: 5px;
        }

        .doorstop-diagnostic {
          display: flex;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 5px 7px;
        }

        .doorstop-diagnostic.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-diagnostic.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
        }

        .doorstop-severity {
          flex: 0 0 auto;
          padding: 0 6px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
        }

        .doorstop-diagnostic.doorstop-error .doorstop-severity {
          background: var(--pi-danger);
          color: var(--pi-bg);
        }

        .doorstop-diagnostic.doorstop-warning .doorstop-severity {
          background: var(--pi-warning);
          color: var(--pi-bg);
        }

        .doorstop-diagnostic-copy {
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 5px;
        }

        .doorstop-split {
          flex: 1 1 auto;
          min-height: 0;
          display: grid;
          grid-template-rows: minmax(110px, 40%) minmax(0, 1fr);
        }

        .doorstop-list,
        .doorstop-detail-pane {
          min-height: 0;
        }

        .doorstop-list {
          border-bottom: 1px solid var(--pi-border-muted);
          overflow: auto;
          display: flex;
          flex-direction: column;
        }

        .doorstop-detail-pane {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .doorstop-detail-pane .doorstop-detail {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
        }

        .doorstop-items {
          padding: 6px;
          display: grid;
          gap: 1px;
        }

        .doorstop-item-row {
          display: grid;
          grid-template-columns: max-content max-content minmax(0, 1fr) max-content;
          gap: 8px;
          align-items: baseline;
          width: 100%;
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 4px 6px;
        }

        .doorstop-item-row:hover,
        .doorstop-item-row.is-selected {
          background: var(--pi-selection-bg);
        }

        .doorstop-item-level {
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-item-summary {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--pi-text-secondary);
        }

        /* A fifth column exists only when showAdditionalAttribute configures
           at least one name; otherwise the default rows keep the original
           4-column track (and its single 8px summary→chips gap). */
        .doorstop-items.has-item-attrs .doorstop-item-row {
          grid-template-columns: max-content max-content minmax(0, 1fr) minmax(0, max-content) max-content;
        }

        /* The configured key: value attribute pairs (settings field
           showAdditionalAttribute). The column collapses to zero when the row
           renders nothing here (no configured attribute the item has). The
           max-width bounds a pathologically long value so it cannot starve
           the summary's fr track before the ellipsis kicks in. */
        .doorstop-item-attrs {
          min-width: 0;
          max-width: 40ch;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--pi-muted);
          font-size: 11px;
        }

        .doorstop-item-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          justify-content: flex-end;
        }

        /* The per-row "git add"/"git reset" affordance. It is a pointer-only
           <span> (aria-hidden, no role) because the row IS a <button> and a
           nested <button> would be hoisted out by the HTML parser; the
           keyboard path is the region-4 Stage/Unstage buttons. The same class
           hosts both directions: the plus (git add) icon and the unstage
           minus (git reset) icon, chosen by {@link itemUnstageable} /
           {@link itemStageable} precedence.

           The per-row "insert UID into the agent prompt" arrow shares the
           pointer-only <span> contract and this visual box; it keeps a
           distinct class because the +/reset icon and the arrow stay
           independently evolvable. */
        .doorstop-item-add,
        .doorstop-item-insert {
          display: inline-flex;
          align-items: center;
          align-self: center;
          flex: 0 0 auto;
          padding: 0 2px;
          border-radius: 4px;
          color: var(--pi-muted);
          cursor: pointer;
        }

        .doorstop-item-add:hover,
        .doorstop-item-insert:hover {
          color: var(--pi-text);
        }

        /* --- state chips (item rows + detail head) --- */
        .doorstop-chip {
          border-radius: 999px;
          padding: 0 7px;
          font-size: 11px;
          white-space: nowrap;
        }

        .doorstop-chip-muted {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-chip-warning {
          border: 1px solid var(--pi-warning);
          color: var(--pi-warning);
        }

        .doorstop-chip-danger {
          border: 1px solid var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-chip-ok {
          border: 1px solid var(--pi-success-border);
          color: var(--pi-success);
        }
`;

/** The findings view (spec §7.2) and the shared empty states, split out of
 *  {@link itemListStyles} only to keep the section file navigable. It comes
 *  AFTER the detail-pane/palette fragments in {@link panelStyles}, exactly as
 *  it does in the source file. */
export const findingsStyles = css`
        /* --- findings view (spec §7.2) --- */
        .doorstop-findings-view {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 10px 12px;
          display: grid;
          gap: 8px;
          align-content: start;
        }

        .doorstop-findings-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px 10px;
        }

        .doorstop-findings-counts {
          font-size: 12px;
          font-weight: 600;
        }

        .doorstop-findings-note {
          font-size: 11px;
        }

        .doorstop-findings-list {
          display: grid;
          gap: 3px;
        }

        .doorstop-finding-row {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 5px 8px;
        }

        .doorstop-finding-row.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-finding-row.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
        }

        .doorstop-finding-row.doorstop-info {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-row .doorstop-severity {
          background: var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-row.doorstop-error .doorstop-severity {
          background: var(--pi-danger);
          color: var(--pi-bg);
        }

        .doorstop-finding-row.doorstop-warning .doorstop-severity {
          background: var(--pi-warning);
          color: var(--pi-bg);
        }

        .doorstop-finding-uid {
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: inherit;
          padding: 0;
          font-weight: 600;
        }

        .doorstop-finding-uid:hover {
          text-decoration: underline;
          cursor: pointer;
        }

        .doorstop-finding-message {
          min-width: 0;
          overflow-wrap: anywhere;
        }

        /* --- empty states --- */
        .doorstop-empty {
          margin: 10px 12px;
          border: 1px dashed var(--pi-border-muted);
          border-radius: 8px;
          color: var(--pi-muted);
          padding: 12px;
          overflow: auto;
        }

        .doorstop-empty p {
          margin: 0;
        }

        .doorstop-empty .doorstop-muted {
          margin-top: 6px;
        }
`;
