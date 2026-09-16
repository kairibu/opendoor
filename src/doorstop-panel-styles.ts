import { css } from "lit";

/** The body element's styles (extracted verbatim from the element class).
 *  Single shared block: the selectors are scoped by the shadow root, and the
 *  region comments (project actions, list filters, item list, …) mirror the
 *  render-method grouping in doorstop-panel-element code. */
export const panelStyles = css`
        :host {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: var(--pi-text);
          background: var(--pi-bg);
          font: 13px system-ui, sans-serif;
        }

        button {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          background: var(--pi-surface);
          color: var(--pi-text);
          padding: 5px 7px;
          cursor: pointer;
        }

        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        input,
        select {
          border: 1px solid var(--pi-border);
          border-radius: 6px;
          background: var(--pi-surface);
          color: var(--pi-text);
          font-size: 12px;
          padding: 4px 6px;
        }

        code {
          border: 1px solid var(--pi-border-muted);
          border-radius: 5px;
          background: var(--pi-bg);
          padding: 1px 4px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }

        .doorstop-muted {
          color: var(--pi-muted);
        }

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
           {@link itemStageable} precedence. */
        .doorstop-item-add {
          display: inline-flex;
          align-items: center;
          align-self: center;
          flex: 0 0 auto;
          padding: 0 2px;
          border-radius: 4px;
          color: var(--pi-muted);
          cursor: pointer;
        }

        .doorstop-item-add:hover {
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

        .doorstop-fingerprint {
          color: var(--pi-muted);
          font-size: 11px;
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

        /* --- item action palette (region 4), sized to the prompt footer --- */
        .doorstop-action-palette {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 12px;
          border-top: 1px solid var(--pi-border);
        }

        .doorstop-action-palette button {
          min-height: 36px;
          padding: 7px 9px;
        }

        /* The Ask-agent dropdown items keep their compact sizing: the parity
           rule above has higher specificity (0,1,1) than the menu-item rule
           (0,1,0), so without this override the popover rows would become
           tall palette buttons. The Unlink/Link buttons inside the op group
           deliberately keep the palette size — they are primary actions in
           the row, not menu rows. */
        .doorstop-action-palette .doorstop-menu-item {
          min-height: auto;
          padding: 5px 8px;
        }

        .doorstop-palette-placeholder {
          min-height: 36px;
          display: inline-flex;
          align-items: center;
        }

        .doorstop-op {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .doorstop-target-input {
          width: 110px;
        }

        .doorstop-op-error {
          color: var(--pi-danger);
          font-size: 12px;
        }

        .doorstop-menu {
          position: relative;
        }

        .doorstop-menu-items {
          position: absolute;
          right: 0;
          bottom: calc(100% + 4px);
          z-index: 3;
          min-width: 180px;
          display: grid;
          gap: 2px;
          padding: 4px;
          border: 1px solid var(--pi-border);
          border-radius: 7px;
          background: var(--pi-surface);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
        }

        .doorstop-menu-item {
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 5px 8px;
        }

        .doorstop-menu-item:hover:not(:disabled) {
          background: var(--pi-selection-bg);
        }

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
