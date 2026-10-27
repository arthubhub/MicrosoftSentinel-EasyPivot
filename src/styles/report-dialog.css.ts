import { CSS_PREFIX } from '../config.ts';

const D = `${CSS_PREFIX}-report-dialog`;

/** Report dialog (N3, 5f). Depends on pivot.css (`-pivot-btn`, `-pivot-ti-checkbox`). */
export const reportDialogStyles = `
  .${D}-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000001;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px;
    color: var(--colorTextPrimary, #292827);
  }

  .${D} {
    width: 460px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    background: var(--colorContainerBackgroudFloating, #fff);
    border: 1px solid var(--colorContainerBorderPrimary, #e1dfdd);
    border-radius: 4px;
    box-shadow: var(--shadowLevel3, 0 8px 24px rgba(0,0,0,.28));
  }

  .${D} button {
    min-width: 0 !important;
    min-height: 0 !important;
  }

  .${D}-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .${D}-check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    cursor: pointer;
  }

  .${D}-notice {
    margin: 0;
    padding: 8px 10px;
    border-left: 3px solid var(--colorTextSecondary, #646464);
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .${D}-notice--masked {
    border-left-color: #c19c00;
    background: #fff8e1;
    color: #3b2f00;
  }

  .${D}-hint {
    margin: 0;
    color: var(--colorTextSecondary, #646464);
  }

  .${D}-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
`;
