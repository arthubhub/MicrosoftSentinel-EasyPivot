import { fr, type MessageKey } from './fr.ts';
import { en } from './en.ts';
import { getSetting } from '../core/settings.ts';
import { log } from '../core/log.ts';

/**
 * i18n: both dictionaries are bundled (plan issue #10 — no lazy-load, no
 * fetch). Language is resolved once by `initI18n()` from the `lang` setting
 * (`auto` | `fr` | `en`); `auto` detects from `navigator.language` (anything
 * starting `fr` → French, else English).
 *
 * Call `initI18n()` right after `document.body` is available (W1 start-up
 * order) and before any UI component is created, so every `t()` call after
 * that point sees the resolved language.
 */

export type { MessageKey } from './fr.ts';

type Dict = Record<MessageKey, string>;
type UiLang = 'fr' | 'en';

const DICTS: Record<UiLang, Dict> = { fr, en };

let currentLang: UiLang = 'en';
const warned = new Set<string>();

function detectLang(): UiLang {
  try {
    return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

/** Resolve and cache the active language from the `lang` setting. */
export function initI18n(): void {
  const lang = getSetting('lang');
  currentLang = lang === 'auto' ? detectLang() : lang;
  log.debug(`i18n: setting=${lang} navigator=${navigator.language} -> ${currentLang}`);
}

/** Language the UI resolved to (`initI18n()`), for output that must declare it (the HTML report's `lang`). */
export function getLang(): UiLang {
  return currentLang;
}

export type MessageParams = Record<string, string | number>;

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Translate `key` in the active language, interpolating `{placeholders}`
 * from `params`. Unknown key → the key itself, warned once; never throws.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = DICTS[currentLang][key];
  if (template === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      log.warn(`i18n: unknown key ${key}`);
    }
    return key;
  }
  return interpolate(template, params);
}
