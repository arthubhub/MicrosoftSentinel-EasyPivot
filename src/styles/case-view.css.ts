import { CSS_PREFIX } from '../config.ts';

const V = `${CSS_PREFIX}-case-view`;

/** Case view side panel (N3, 5e-2). Depends on popup.css (badges, icon buttons) and pivot.css (`-pivot-btn`). */
export const caseViewStyles = `
  .${V} {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 420px;
    max-width: 100vw;
    z-index: 1000001;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--colorContainerBackgroudFloating, #fff);
    border-left: 1px solid var(--colorContainerBorderPrimary, #e1dfdd);
    box-shadow: var(--shadowLevel3, -4px 0 14px rgba(0,0,0,.14));
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px;
    color: var(--colorTextPrimary, #292827);
    animation: ${CSS_PREFIX}-popup-in 0.15s ease-out;
  }

  /* Neutralize host page CSS (same as the Pivot panel) */
  .${V} button {
    min-width: 0 !important;
    min-height: 0 !important;
  }

  .${V} [hidden] {
    display: none !important;
  }

  /* ── Header ── */

  .${V}-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px;
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    border-bottom: 1px solid var(--colorDividerPrimary, #e1dfdd);
    flex-shrink: 0;
  }

  .${V}-header-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .${V}-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .${V}-client {
    color: var(--colorTextSecondary, #646464);
    overflow-wrap: anywhere;
  }

  .${V}-status {
    flex-shrink: 0;
  }

  .${V}-status--closed {
    color: var(--colorTextSecondary, #646464);
    border-color: var(--colorTextSecondary, #646464);
  }

  /* ── Body ── */

  .${V}-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .${V}-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--colorDividerSecondary, #edebe9);
  }

  .${V}-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--colorTextSecondary, #646464);
  }

  .${V}-readonly {
    padding: 6px 14px;
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    border-bottom: 1px solid var(--colorDividerSecondary, #edebe9);
    color: var(--colorTextSecondary, #646464);
  }

  .${V}-empty {
    padding: 8px 0;
    color: var(--colorTextSecondary, #646464);
  }

  /* ── Notes ── */

  .${V}-note {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .${V}-textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 52px;
    padding: 4px 6px;
    background: var(--colorControlBackground, #fff);
    border: 1px solid var(--colorControlBorder, #8a8886);
    border-radius: 2px;
    color: var(--colorTextPrimary, #292827);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
  }

  .${V}-textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .${V}-note-status {
    min-height: 13px;
    font-size: 10px;
    color: var(--colorTextSecondary, #646464);
  }

  .${V}-note-status--reason {
    font-style: italic;
  }

  /* ── Tree ── */

  .${V}-tree {
    display: flex;
    flex-direction: column;
  }

  .${V}-node {
    --shq-depth: 0;
    padding-left: calc(var(--shq-depth) * 14px);
  }

  .${V}-node-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 2px 4px;
    border-radius: 2px;
  }

  .${V}-node-row:hover {
    background: var(--colorControlBackgroundHover, #f3f2f1);
  }

  .${V}-node-row--selected {
    background: var(--colorContainerBackgroundInfo, #e6f2fb);
  }

  .${V}-toggle {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: none;
    color: var(--colorTextSecondary, #646464);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    display: inline-block;
  }

  .${V}-toggle--leaf {
    cursor: default;
  }

  .${V}-node-label {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 1px 2px;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 12px;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .${V}-node-column {
    font-size: 10px;
    color: var(--colorTextSecondary, #646464);
  }

  .${V}-node-value {
    max-width: 100%;
    font-family: Consolas, Monaco, 'Courier New', monospace;
    overflow-wrap: anywhere;
  }

  .${V}-badges {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 3px;
    flex-shrink: 0;
    max-width: 150px;
  }

  .${V}-rows--none {
    opacity: 0.6;
  }

  .${V}-flag--warn {
    color: #8a4b00;
    border-color: #ca5010;
  }

  .${V}-flag--error {
    color: var(--colorIconError, #a4262c);
    border-color: var(--colorIconError, #a4262c);
  }

  .${V}-pivots,
  .${V}-pin-count,
  .${V}-note-icon {
    font-size: 10px;
    color: var(--colorTextSecondary, #646464);
    white-space: nowrap;
  }

  .${V}-details-toggle {
    width: 20px !important;
    height: 20px !important;
  }

  .${V}-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 2px 0 6px 20px;
    padding: 6px 8px;
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    border-radius: 2px;
  }

  .${V}-pinned {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .${V}-pinned-row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }

  .${V}-pinned-text {
    flex: 1;
    min-width: 0;
    font-family: Consolas, Monaco, 'Courier New', monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .${V}-unpin {
    width: 18px !important;
    height: 18px !important;
    font-size: 11px !important;
  }
`;
