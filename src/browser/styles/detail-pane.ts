import { css } from "lit";

/** Detail-pane (region 3) styles: fields, flags, links, references,
 *  extended attributes, per-item findings and the changes-since-review diff. */
export const detailPaneStyles = css`
        /* --- detail pane (region 3) --- */
        .doorstop-detail {
          padding: 12px;
          display: grid;
          gap: 10px;
          align-content: start;
        }

        .doorstop-detail-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 8px;
        }

        .doorstop-detail-head h3 {
          margin: 0;
          font-size: 15px;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .doorstop-level {
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-flags {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .doorstop-flag {
          border: 1px solid var(--pi-border-muted);
          border-radius: 999px;
          color: var(--pi-muted);
          padding: 0 7px;
          font-size: 11px;
        }

        .doorstop-flag.is-inactive {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
        }

        .doorstop-state-chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        /* --- changes since review (Phase D step 14) --- */
        .doorstop-changes {
          border: 1px solid var(--pi-border-muted);
          border-radius: 7px;
          padding: 6px 10px;
        }

        .doorstop-changes-summary {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          cursor: pointer;
          user-select: none;
        }

        .doorstop-changes-summary::-webkit-details-marker {
          color: var(--pi-muted);
        }

        .doorstop-changes-notice {
          margin: 6px 0 0;
          font-size: 12px;
        }

        .doorstop-changes-source {
          margin: 6px 0 4px;
          font-size: 11px;
        }

        .doorstop-diff-lines {
          display: grid;
          max-height: 180px;
          overflow: auto;
          border: 1px solid var(--pi-border-muted);
          border-radius: 6px;
          margin: 6px 0 8px;
        }

        .doorstop-diff-line {
          display: flex;
          gap: 7px;
          border-bottom: 1px solid var(--pi-border-muted);
          padding: 1px 7px;
          font-family: var(--pi-monospace-family, monospace);
          font-size: 12px;
        }

        .doorstop-diff-line:last-child {
          border-bottom: 0;
        }

        .doorstop-diff-line.is-added {
          background: color-mix(in srgb, var(--pi-success) 9%, transparent);
        }

        .doorstop-diff-line.is-removed {
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-diff-mark {
          flex: 0 0 auto;
          width: 1em;
          text-align: center;
          user-select: none;
        }

        .doorstop-diff-line.is-added .doorstop-diff-mark {
          color: var(--pi-success);
        }

        .doorstop-diff-line.is-removed .doorstop-diff-mark {
          color: var(--pi-danger);
        }

        .doorstop-diff-line.is-same .doorstop-diff-mark {
          color: var(--pi-muted);
        }

        .doorstop-diff-text {
          min-width: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .doorstop-field-change {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px;
          border-top: 1px solid var(--pi-border-muted);
          padding: 5px 0 0;
          margin-top: 5px;
        }

        .doorstop-field-name {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .doorstop-field-chip {
          border-radius: 5px;
          border: 1px solid var(--pi-border-muted);
          font-size: 12px;
          padding: 1px 6px;
          overflow-wrap: anywhere;
        }

        .doorstop-field-chip-before {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .doorstop-field-chip-after {
          border-color: var(--pi-success-border);
          color: var(--pi-success);
          background: color-mix(in srgb, var(--pi-success) 9%, transparent);
        }

        .doorstop-field-arrow {
          color: var(--pi-muted);
        }

        .doorstop-section-title {
          color: var(--pi-muted);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin: 0;
        }

        .doorstop-text {
          border: 1px solid var(--pi-border-muted);
          border-radius: 7px;
          background: var(--pi-surface);
          padding: 8px 10px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          margin: 0;
        }

        .doorstop-text.doorstop-text-empty {
          color: var(--pi-muted);
          font-style: italic;
        }

        .doorstop-links {
          display: grid;
          gap: 4px;
        }

        .doorstop-link-row {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 7px;
          width: 100%;
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 3px 6px;
        }

        .doorstop-link-row:hover {
          background: var(--pi-selection-bg);
        }

        /* The per-link trash can (pointer-only, see {@link renderLinkOut}):
           right-aligned in the flex row, mirroring .doorstop-item-add. */
        .doorstop-link-remove {
          display: inline-flex;
          align-items: center;
          align-self: center;
          flex: 0 0 auto;
          margin-left: auto;
          color: var(--pi-muted);
          cursor: pointer;
        }

        .doorstop-link-remove:hover {
          color: var(--pi-text);
        }

        .doorstop-fingerprint {
          color: var(--pi-muted);
          font-size: 11px;
          /* The link row wraps, which could push the trash can onto a second
             line on narrow panes. Let the fingerprint shrink and ellipsize
             instead (min-width: 0 lifts the flex min-content floor). */
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .doorstop-attributes {
          margin: 0;
          display: grid;
          gap: 5px;
        }

        .doorstop-attribute {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr);
          gap: 10px;
          align-items: baseline;
        }

        .doorstop-attribute dt {
          color: var(--pi-muted);
          font-size: 12px;
        }

        .doorstop-attribute dd {
          margin: 0;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .doorstop-findings {
          display: grid;
          gap: 4px;
        }

        .doorstop-finding {
          display: flex;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 3px 6px;
        }

        .doorstop-finding.doorstop-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
          color: var(--pi-danger);
        }

        .doorstop-finding.doorstop-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
          color: var(--pi-warning);
        }

        .doorstop-finding.doorstop-info {
          border: 1px solid var(--pi-border-muted);
          color: var(--pi-muted);
        }

        .doorstop-finding-severity {
          flex: 0 0 auto;
          font-size: 11px;
          font-weight: 600;
        }
`;
