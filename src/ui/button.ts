import { CSS_PREFIX, SELECTORS } from '../config.ts';
import type { PlatformId } from '../types.ts';

const BUTTON_LABEL = 'EasyPivot';
const BUTTON_TITLE = 'EasyPivot : historique des événements, pivot manuel et paramètres';

export interface ButtonComponent {
  readonly element: HTMLDivElement;
  readonly buttonEl: HTMLButtonElement;
  setOpen(open: boolean): void;
}

/**
 * Creates an inline command bar button.
 *
 * On Defender: uses native Fluent UI v8 `ms-Button--commandBar` classes so the
 * button inherits the page's own styles and looks identical to Run, Save, Share.
 *
 * On Sentinel: uses our custom `shq-btn` CSS since the reactblade iframe has
 * different styling.
 */
export function createButton(onClick: () => void, platformId: PlatformId): ButtonComponent {
  if (platformId === 'defender') {
    return createDefenderButton(onClick);
  }
  return createSentinelButton(onClick);
}

// ── Defender: native Fluent UI v8 markup ──

/**
 * Copy the class name from a reference element, keeping only the base
 * semantic class and the generated hash class (e.g. "ms-Button-label label-554").
 * Strips disabled-specific overrides like rootDisabled-*, is-disabled, etc.
 */
function copyClasses(el: HTMLElement, semanticPrefix: string): string {
  return el.className
    .split(/\s+/)
    .filter((c) =>
      !c.startsWith('is-') &&
      !c.includes('Disabled') &&
      c !== 'scc-listButton' &&
      c !== 'scc-listDropdown',
    )
    .join(' ') || semanticPrefix;
}

/**
 * Find an existing button on the page and steal its generated CSS-in-JS
 * class names so our button inherits the exact same styles: first a
 * neighbour of « Join queries » (where the button goes), then a command bar button.
 */
function getFluentClassMap(): Record<string, string> {
  const map: Record<string, string> = {
    root: 'ms-Button ms-Button--commandBar',
    flexContainer: 'ms-Button-flexContainer',
    textContainer: 'ms-Button-textContainer',
    label: 'ms-Button-label',
  };

  // Prefer an enabled button; fall back to disabled if all are disabled.
  const scope = document.querySelector(SELECTORS.DEFENDER.BUTTON_ANCHOR)?.parentElement;
  const ref =
    scope?.querySelector<HTMLButtonElement>('.ms-Button:not(:disabled)') ??
    document.querySelector<HTMLButtonElement>(
      '.scc-commandBar .ms-Button.ms-Button--commandBar:not(:disabled)',
    ) ??
    document.querySelector<HTMLButtonElement>(
      '.scc-commandBar .ms-Button.ms-Button--commandBar',
    );
  if (!ref) return map;

  map.root = copyClasses(ref, map.root);

  const fc = ref.querySelector<HTMLElement>('.ms-Button-flexContainer');
  if (fc) map.flexContainer = copyClasses(fc, map.flexContainer);

  const tc = ref.querySelector<HTMLElement>('.ms-Button-textContainer');
  if (tc) map.textContainer = copyClasses(tc, map.textContainer);

  const lb = ref.querySelector<HTMLElement>('.ms-Button-label');
  if (lb) map.label = copyClasses(lb, map.label);

  return map;
}

function createDefenderButton(onClick: () => void): ButtonComponent {
  const cls = getFluentClassMap();

  const wrapper = document.createElement('div');
  wrapper.className = `${CSS_PREFIX}-btn-wrap-native`;
  wrapper.setAttribute('role', 'none');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls.root;
  btn.setAttribute('role', 'menuitem');
  btn.setAttribute('data-is-focusable', 'true');
  btn.title = BUTTON_TITLE;
  btn.tabIndex = 0;

  const flexContainer = document.createElement('span');
  flexContainer.className = cls.flexContainer;
  flexContainer.setAttribute('data-automationid', 'splitbuttonprimary');

  const textContainer = document.createElement('span');
  textContainer.className = cls.textContainer;

  const label = document.createElement('span');
  label.className = cls.label;
  label.textContent = BUTTON_LABEL;

  textContainer.appendChild(label);
  flexContainer.appendChild(textContainer);
  btn.appendChild(flexContainer);
  wrapper.appendChild(btn);

  btn.addEventListener('click', onClick);

  return {
    element: wrapper,
    buttonEl: btn,
    setOpen(open: boolean) {
      btn.classList.toggle('is-checked', open);
      btn.title = open ? 'Fermer' : BUTTON_TITLE;
    },
  };
}

// ── Sentinel: custom-styled button ──

function createSentinelButton(onClick: () => void): ButtonComponent {
  const wrapper = document.createElement('div');
  wrapper.className = `${CSS_PREFIX}-btn-wrap`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${CSS_PREFIX}-btn`;
  btn.title = BUTTON_TITLE;

  const labelSpan = document.createElement('span');
  labelSpan.className = `${CSS_PREFIX}-btn-label`;
  labelSpan.textContent = BUTTON_LABEL;

  btn.appendChild(labelSpan);
  wrapper.appendChild(btn);

  btn.addEventListener('click', onClick);

  return {
    element: wrapper,
    buttonEl: btn,
    setOpen(open: boolean) {
      btn.classList.toggle(`${CSS_PREFIX}-btn--open`, open);
      btn.title = open ? 'Fermer' : BUTTON_TITLE;
    },
  };
}