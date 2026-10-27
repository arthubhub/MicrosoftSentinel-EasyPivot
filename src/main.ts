import type { PlatformAdapter } from './types.ts';
import { CSS_PREFIX } from './config.ts';
import { detectPlatform, getPlatformAdapter } from './platforms/index.ts';
import { injectStyles } from './styles/index.ts';
import { initTheme } from './styles/theme.ts';
import { initCatalog } from './core/rules-catalog.ts';
import { getHealthReport, hasFailure, onHealthChange, refreshHealth } from './core/health.ts';
import { teardownActiveEditorTracking } from './core/editor-bridge.ts';
import { log } from './core/log.ts';
import { initI18n } from './i18n/index.ts';
import { createButton, type ButtonComponent } from './ui/button.ts';
import { createPivotTrigger, type PivotTriggerComponent } from './ui/pivot-trigger.ts';

/** Delay before the silent startup health check (N6) */
const STARTUP_HEALTH_DELAY_MS = 5000;

// ── State ──

let platform: PlatformAdapter | null = null;
let button: ButtonComponent | null = null;
let pivotTrigger: PivotTriggerComponent | null = null;
let injected = false;
let healthUnsubscribe: (() => void) | null = null;
let startupHealthTimer: ReturnType<typeof setTimeout> | null = null;

// ── Bootstrap ──

function bootstrap(): void {
  const platformId = detectPlatform();
  if (!platformId) {
    log.debug('no platform matched for', location.host, '- not starting');
    return;
  }

  platform = getPlatformAdapter(platformId);
  log.info(`starting on ${platformId}`, { host: location.host, frame: window === window.top ? 'top' : 'iframe' });

  // Language is resolved before anything renders text (W1 start-up order)
  log.step('initI18n', initI18n);
  log.step('initTheme', initTheme);
  log.step('injectStyles', injectStyles);
  log.step('initCatalog', initCatalog);
  log.step('observeForHuntingPage', observeForHuntingPage);
}

// ── rAF coalescing - a burst of mutations yields at most one pass per frame ──

interface CoalescedSchedule {
  /** Request a pass; no-op while one is already pending for this instance */
  readonly schedule: () => void;
  /** Drop a pending pass, if any - used when the observer is torn down */
  readonly cancel: () => void;
}

function rafCoalesced(fn: () => void): CoalescedSchedule {
  let pendingId: number | null = null;

  return {
    schedule: () => {
      if (pendingId !== null) return;
      pendingId = requestAnimationFrame(() => {
        pendingId = null;
        fn();
      });
    },
    cancel: () => {
      if (pendingId === null) return;
      cancelAnimationFrame(pendingId);
      pendingId = null;
    },
  };
}

// ── MutationObserver - watches for SPA navigation ──

function observeForHuntingPage(): void {
  checkAndInject();

  const { schedule } = rafCoalesced(checkAndInject);
  const observer = new MutationObserver(schedule);

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

  // N6: badge reflects the latest health report as soon as it changes,
  // including a stale report from a previous injection on this same page.
  healthUnsubscribe = onHealthChange(() => {
    button?.setHealthBadge(hasFailure(getHealthReport()));
  });
  button.setHealthBadge(hasFailure(getHealthReport()));

  // Silent startup probe (N6): on demand and post-capture triggers are
  // wired from the panel / core/health.ts's onQueryCaptured.
  const plat = platform;
  startupHealthTimer = setTimeout(() => {
    startupHealthTimer = null;
    if (injected) refreshHealth(plat);
  }, STARTUP_HEALTH_DELAY_MS);
}

// ── Place button, and put it back if the page re-renders its spot ──
// Stops watching once placed (bug #9); re-armed by injectUI on the next
// navigation into the hunting page, since removeUI tears this down fully.

let buttonObserver: MutationObserver | null = null;
let cancelButtonSchedule: (() => void) | null = null;

function placeButton(el: HTMLElement, plat: PlatformAdapter): void {
  const tryPlace = (): boolean => {
    const target = plat.getButtonInjectionTarget();
    if (!target) return false;
    if (el.parentElement !== target) target.appendChild(el);
    return true;
  };

  // Target already there - nothing to observe
  if (tryPlace()) return;

  const { schedule, cancel } = rafCoalesced(() => {
    if (tryPlace()) {
      buttonObserver?.disconnect();
      buttonObserver = null;
      cancelButtonSchedule = null;
    }
  });
  cancelButtonSchedule = cancel;

  buttonObserver = new MutationObserver(schedule);
  buttonObserver.observe(document.body, { childList: true, subtree: true });
}

function removeUI(): void {
  if (!injected) return;
  injected = false;
  log.debug('leaving the hunting page - tearing down the UI');

  cancelButtonSchedule?.();
  cancelButtonSchedule = null;
  buttonObserver?.disconnect();
  buttonObserver = null;

  if (startupHealthTimer !== null) {
    clearTimeout(startupHealthTimer);
    startupHealthTimer = null;
  }
  healthUnsubscribe?.();
  healthUnsubscribe = null;

  // Drop editor focus-tracking subscriptions (#13) before the editor itself
  // may be torn down by the SPA navigation that triggered removeUI.
  teardownActiveEditorTracking();

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