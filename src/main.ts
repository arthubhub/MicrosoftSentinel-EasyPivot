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
    } else {
      ensureButtonPlaced();
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
  // Set first: a failure below is logged once, not retried on every mutation
  injected = true;

  try {
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
  } catch (err) {
    console.error('[EasyPivot] UI injection failed', err);
    return;
  }

  ensureButtonPlaced();
}

// ── Place button, and put it back when the host page re-renders ──

/**
 * Called on every DOM mutation while on the hunting page. The host bar is
 * React-rendered: a re-render can drop our node, so it is re-inserted as soon
 * as it leaves its container. It stays detached until the anchor exists.
 */
function ensureButtonPlaced(): void {
  if (!button || !platform) return;
  const anchor = platform.getButtonAnchor();
  if (!anchor) return;
  const el = button.element;
  if (el.parentElement === anchor.container) return;
  if (anchor.after) anchor.after.after(el);
  else anchor.container.appendChild(el);
}

function removeUI(): void {
  if (!injected) return;
  injected = false;

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
