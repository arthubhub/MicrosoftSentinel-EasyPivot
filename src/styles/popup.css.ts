import { CSS_PREFIX } from '../config.ts';

/**
 * Shared popup building blocks (inherited from the hunting popup):
 * overlay, close button, chips, badges, icon buttons, empty state and the
 * open animation. pivot.css depends on them: keep both injected together.
 */
export const popupStyles = `
  .${CSS_PREFIX}-popup-overlay {
    position: fixed;
    inset: 0;
    z-index: 999999;
    background: transparent;
  }

  @keyframes ${CSS_PREFIX}-popup-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .${CSS_PREFIX}-popup-close {
    background: none;
    border: none;
    color: var(--colorIconSecondary, #605e5c);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 5px;
    line-height: 1;
    border-radius: 2px;
    transition: color 0.12s, background 0.12s;
  }

  .${CSS_PREFIX}-popup-close:hover {
    color: var(--colorTextPrimary, #292827);
    background: var(--colorControlBackgroundHover, #f3f2f1);
  }

  .${CSS_PREFIX}-category-chip {
    padding: 1px 7px !important;
    font-size: 10px !important;
    font-weight: 500 !important;
    color: var(--colorTextSecondary, #646464) !important;
    background: transparent !important;
    border: 1px solid var(--colorContainerBorderPrimary, #e1dfdd) !important;
    border-radius: 3px !important;
    cursor: pointer !important;
    transition: color 0.12s, background 0.12s, border-color 0.12s !important;
    font-family: inherit !important;
    white-space: nowrap !important;
    flex-shrink: 0 !important;
    line-height: 1.6 !important;
    min-width: 0 !important;
    min-height: 0 !important;
    height: auto !important;
    letter-spacing: 0.01em !important;
    text-transform: none !important;
    outline: none !important;
    box-shadow: none !important;
  }

  .${CSS_PREFIX}-category-chip:focus,
  .${CSS_PREFIX}-category-chip:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }

  .${CSS_PREFIX}-category-chip:hover {
    color: var(--colorTextPrimary, #292827) !important;
    background: var(--colorControlBackgroundHover, #f3f2f1) !important;
    border-color: var(--colorControlBorderSecondary, #c8c6c4) !important;
  }

  .${CSS_PREFIX}-category-chip--active {
    color: var(--colorTextBrand, #0078d4) !important;
    background: var(--colorContainerBackgroundInfo, #e6f2fb) !important;
    border-color: var(--colorControlBorderInfo, #0078d4) !important;
    font-weight: 600 !important;
  }

  .${CSS_PREFIX}-category-chip--active:hover {
    color: var(--colorLinkContrast, #005a9e) !important;
    background: var(--colorButtonBackgroundTertiary, #d0e6f9) !important;
    border-color: var(--colorLinkContrast, #005a9e) !important;
  }

  .${CSS_PREFIX}-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--colorContainerBackgroundSecondary, #f3f2f1);
    color: var(--colorTextSecondary, #646464);
    border: 1px solid var(--colorContainerBorderPrimary, #e1dfdd);
    white-space: nowrap;
  }

  .${CSS_PREFIX}-badge--source {
    background: var(--colorContainerBackgroundInfo, #dae4ff);
    color: var(--colorTextBrand, #0078d4);
    border-color: var(--colorControlBorderInfo, #015cda);
  }

  .${CSS_PREFIX}-icon-btn {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 28px !important;
    height: 28px !important;
    min-width: 0 !important;
    min-height: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 4px !important;
    background: transparent !important;
    color: var(--colorTextDisabled, #a19f9d) !important;
    cursor: pointer !important;
    font-size: 13px !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
    transition: color 0.12s, background 0.12s !important;
    user-select: none !important;
    flex-shrink: 0 !important;
  }

  .${CSS_PREFIX}-icon-btn:hover {
    color: var(--colorTextPrimary, #292827) !important;
    background: var(--colorControlBackgroundHover, rgba(0,0,0,0.05)) !important;
  }

  .${CSS_PREFIX}-icon-btn:focus-visible {
    outline: 2px solid var(--colorControlBorderInfo, #015cda) !important;
    outline-offset: -2px !important;
  }

  .${CSS_PREFIX}-icon-btn--chevron svg {
    display: block !important;
    width: 11px !important;
    height: 11px !important;
    min-width: 11px !important;
    min-height: 11px !important;
    max-width: 11px !important;
    max-height: 11px !important;
    fill: none !important;
    overflow: visible !important;
    flex-shrink: 0 !important;
    transition: transform 0.15s ease !important;
  }

  .${CSS_PREFIX}-icon-btn--chevron-open svg {
    transform: rotate(180deg) !important;
  }

  .${CSS_PREFIX}-empty {
    padding: 24px 14px;
    text-align: center;
    color: var(--colorTextDisabled, #a19f9d);
    font-size: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .${CSS_PREFIX}-icon-btn,
    .${CSS_PREFIX}-icon-btn--chevron svg {
      transition: none !important;
    }
  }
`;
