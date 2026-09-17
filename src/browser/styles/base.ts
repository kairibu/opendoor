import { css } from "lit";

/** The body element's global styles: the host box, the shared button/input/code
 *  resets and the muted-text helper. The FIRST fragment so it precedes every
 *  section rule in {@link panelStyles}. */
export const baseStyles = css`
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
`;
