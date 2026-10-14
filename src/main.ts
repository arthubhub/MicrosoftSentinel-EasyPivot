import type { PlatformAdapter } from './types.ts';
import { CSS_PREFIX } from './config.ts';
import { detectPlatform, getPlatformAdapter } from './platforms/index.ts';
import { injectStyles } from './styles/index.ts';
import { initTheme } from './styles/theme.ts';
import { initCatalog } from './core/rules-catalog.ts';
import { createButton, type ButtonComponent } from './ui/button.ts';
import { createPivotTrigger, type PivotTriggerComponent } from './ui/pivot-trigger.ts';

// ── State ──

let platform: PlatformAdapter | null = null;
let button: ButtonComponent | null = null;
let pivotTrigger: PivotTriggerComponent | null = null;
let injected = false;

// ── Bootstrap ──

function bootstrap(): void {
  const platformId = detectPlatform();
  if (!platformId) return;

  platform = getPlatformAdapter(platformId);

  initTheme();
  injectStyles();
  initCatalog();
  observeForHuntingPage();
}

// ── MutationObserver - watches for SPA navigation ──

function observeForHuntingPage(): void {
  checkAndInject();

  const observer = new MutationObserver(() => {
    checkAndInject();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function checkAndInject(): void {
  if (!platform) return;

  if (platform.isHuntingPage()) {
    if (!injected) {
      injectUI();
    }
  } else {
    if (injected) {
      removeUI();
    }
  }
}

// ── UI Injection ──

function injectUI(): void {
  if (injected || !platform) return;
  injected = true;

  // The panel lives in the trigger; the button opens it on the journal
  pivotTrigger = createPivotTrigger(platform);
  const menu = pivotTrigger.menu;

  button = createButton(() => {
    if (menu.isVisible()) {
      menu.hide();
      return;
    }
    const rect = button?.buttonEl.getBoundingClientRect();
    menu.showHistory(rect?.left ?? 16, (rect?.bottom ?? 16) + 4);
  }, platform.id);

  placeButton(button.element, platform);
}

// ── Place button, and put it back if the page re-renders its spot ──

let buttonObserver: MutationObserver | null = null;

function placeButton(el: HTMLElement, plat: PlatformAdapter): void {
  const place = (): void => {
    const target = plat.getButtonInjectionTarget();
    if (target && el.parentElement !== target) target.appendChild(el);
  };

  place();

  buttonObserver = new MutationObserver(place);
  buttonObserver.observe(document.body, { childList: true, subtree: true });
}

function removeUI(): void {
  if (!injected) return;
  injected = false;

  buttonObserver?.disconnect();
  buttonObserver = null;

  pivotTrigger?.destroy();
  button?.element.remove();

  pivotTrigger = null;
  button = null;
}

// ── Ensure we don't double-inject ──

function isAlreadyRunning(): boolean {
  return document.getElementById(`${CSS_PREFIX}-styles`) !== null;
}

// ── Entry Point ──

(function main() {
  if (isAlreadyRunning()) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();