import { css } from "lit";

/** Item-action-palette (region 4) styles: the action row, the target input,
 *  the inline op error and the Ask-agent menu. */
export const itemActionPaletteStyles = css`
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
`;
