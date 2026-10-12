import { CSS_PREFIX } from '../config.ts';

const P = `${CSS_PREFIX}-pivot`;

/** Pivot panel and AG Grid menu entry. Depends on popup.css (chips, badges, animation). */
export const pivotStyles = `
  /* ── Entry added to the AG Grid context menu ── */

  .${P}-ag-option {
    font-weight: 600;
    cursor: pointer;
  }

  .${P}-ag-option:hover {
    background: var(--ag-row-hover-color, var(--colorControlBackgroundHover, #f3f2f1));
  }

  /* ── Panel ── */

  .${P} {
    position: fixed;
    top: 0;
    left: 0;
    width: 460px;
    max-width: calc(100vw - 16px);
    max-height: min(560px, calc(100vh - 16px));
    background: var(--colorContainerBackgroudFloating, #fff);
    border: 1px solid var(--colorContainerBorderPrimary, #e1dfdd);
    border-radius: 4px;
    box-shadow: var(--shadowLevel3, 0 6.4px 14.4px 0 rgba(0,0,0,.132), 0 1.2px 3.6px 0 rgba(0,0,0,.108));
    z-index: 1000000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px;
    color: var(--colorTextPrimary, #292827);
    animation: ${CSS_PREFIX}-popup-in 0.15s ease-out;
    box-sizing: border-box;
  }

  /* Neutralize host page CSS (Fluent / portal minimum sizes, [hidden] overrides) */
  .${P} button {
    min-width: 0 !important;
    min-height: 0 !important;
  }

  .${P} [hidden] {
    display: none !important;
  }

  /* ── Header ── */

  .${P}-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    border-bottom: 1px solid var(--colorDividerPrimary, #f3f2f1);
    flex-shrink: 0;
  }

  .${P}-title {
    font-size: 13px;
    font-weight: 600;
  }

  .${P}-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .${P}-settings-btn {
    width: 24px !important;
    height: 24px !important;
    font-size: 14px !important;
  }

  .${P}-settings-btn--open {
    color: var(--colorTextBrand, #0078d4) !important;
  }

  /* ── Blocks above the list (settings, context, params) ── */

  .${P}-settings,
  .${P}-context,
  .${P}-params {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--colorDividerSecondary, #edebe9);
    flex-shrink: 0;
  }

  .${P}-settings {
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
  }

  .${P}-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }

  /* ── Fields ── */

  .${P}-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 72px;
    min-width: 0;
  }

  .${P}-field--wide {
    width: auto;
  }

  .${P}-field--grow {
    flex: 1;
    width: auto;
  }

  .${P}-field-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--colorTextSecondary, #646464);
  }

  .${P}-input {
    width: 100%;
    height: 24px;
    padding: 2px 6px;
    background: var(--colorControlBackground, #fff);
    border: 1px solid var(--colorControlBorder, #8a8886);
    border-radius: 2px;
    color: var(--colorTextPrimary, #292827);
    font-family: Consolas, Monaco, 'Courier New', monospace;
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
  }

  .${P}-input::placeholder {
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--colorTextDisabled, #a19f9d);
  }

  .${P}-input:focus {
    border-color: var(--colorControlBorderFocus, #0078d4);
  }

  select.${P}-input {
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    padding: 0 4px;
  }

  /* ── Buttons ── */

  .${P}-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .${P}-btn {
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--colorControlBorder, #8a8886);
    border-radius: 2px;
    background: var(--colorButtonBackgroundSecondary, #fff);
    color: var(--colorTextPrimary, #292827);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .${P}-btn:hover:not(:disabled) {
    background: var(--colorButtonBackgroundSecondaryHover, #f3f2f1);
  }

  .${P}-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .${P}-btn--primary {
    background: var(--colorButtonBackgroundPrimary, #0078d4);
    border-color: var(--colorButtonBackgroundPrimary, #0078d4);
    color: var(--colorButtonForegroundPrimary, #fff);
  }

  .${P}-btn--primary:hover:not(:disabled) {
    background: var(--colorButtonBackgroundPrimaryHover, #106ebe);
  }

  .${P}-status {
    font-size: 11px;
    color: var(--colorTextSecondary, #646464);
    word-break: break-all;
  }

  .${P}-status--error {
    color: var(--colorIconError, #a4262c);
  }

  /* ── Context (investigation journal) ── */

  .${P}-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 64px;
    overflow-y: auto;
  }

  .${P}-field-chip {
    font-family: Consolas, Monaco, 'Courier New', monospace !important;
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
  }

  .${P}-steps {
    font-size: 11px;
    color: var(--colorTextSecondary, #646464);
    line-height: 1.4;
  }

  .${P}-steps:empty {
    display: none;
  }

  /* ── Type chips ── */

  .${P}-types {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .${P}-type--match::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 4px;
    border-radius: 50%;
    background: #107c10;
    vertical-align: middle;
  }

  /* ── Rule list (the only scrolling area) ── */

  .${P}-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .${P}-section-title {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 4px 14px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--colorTextSecondary, #646464);
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    border-left: 3px solid transparent;
  }

  .${P}-section-title--statistics { border-left-color: #8764b8; }
  .${P}-section-title--pivot { border-left-color: #0078d4; }
  .${P}-section-title--timeline { border-left-color: #ca5010; }

  .${P}-rule {
    border-bottom: 1px solid var(--colorDividerSecondary, #edebe9);
  }

  .${P}-rule-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 6px 14px;
    cursor: pointer;
    transition: background 0.1s;
  }

  .${P}-rule-row:hover {
    background: var(--colorControlBackgroundHover, #f3f2f1);
  }

  .${P}-rule-body {
    flex: 1;
    min-width: 0;
  }

  .${P}-rule-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }

  .${P}-rule-name > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .${P}-badge--ran {
    color: #107c10;
    border-color: #107c10;
  }

  .${P}-rule-meta {
    font-size: 10px;
    color: var(--colorTextSecondary, #646464);
    margin-top: 1px;
  }

  .${P}-rule-details {
    padding: 0 14px 8px;
    font-size: 11px;
    line-height: 1.4;
  }

  .${P}-rule-desc {
    margin: 0 0 6px;
  }

  .${P}-reading {
    padding: 1px 0 1px 8px;
    margin-top: 3px;
    border-left: 2px solid transparent;
  }

  .${P}-reading--decisive { border-left-color: #107c10; }
  .${P}-reading--context { border-left-color: #0078d4; }
  .${P}-reading--noise {
    border-left-color: #a19f9d;
    color: var(--colorTextSecondary, #646464);
  }

  @media (prefers-reduced-motion: reduce) {
    .${P} { animation: none; }
    .${P}-rule-row { transition: none; }
  }
`;
