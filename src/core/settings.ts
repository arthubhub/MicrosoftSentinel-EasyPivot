import type { PlatformId, PlatformVariant } from '../types.ts';
import type { TiProvider } from './ti-links.ts';
import { STORAGE_KEYS } from '../config.ts';
import { getJson, setJson } from './storage.ts';

/**
 * User settings, stored as a single JSON blob under `shq_settings` (see the
 * Annexes table in docs/PLAN-DEV.md). Phase 1 implements `lang` and
 * `platformVariant`; later phases add `insertMode`, `autoRun`, `capture.*`,
 * `retention.*`, … by growing the `Settings` interface and `DEFAULTS` below
 * — unknown keys already in storage are preserved, missing keys fall back
 * to their default, so no migration is needed when a new setting is added.
 */

export type Lang = 'auto' | 'fr' | 'en';

/** Console verbosity, see core/log.ts. Verbose by default, on purpose. */
export type LogLevelSetting = 'debug' | 'info' | 'warn' | 'error' | 'off';

/** `auto` = derive from the current PlatformId (see `resolvePlatformVariant`) */
export type PlatformVariantSetting = 'auto' | PlatformVariant;

export interface Settings {
  readonly lang: Lang;
  readonly platformVariant: PlatformVariantSetting;
  /**
   * `debug` by default: the script lives inside someone else's SPA, where a
   * broken selector fails silently rather than throwing, and the console is
   * the only place that shows it. Set to `off` to silence it entirely.
   */
  readonly logLevel: LogLevelSetting;
  /**
   * Only `maxBytes` (storage probe, N6) is implemented here; the rest of
   * `retention.*` (days, closedDays) is phase 4/5, see docs/PLAN-DEV.md Annexes.
   */
  readonly retention: { readonly maxBytes: number };
  /**
   * Threat Intel links (N7, #20). `providers` is the list of enabled
   * provider ids (built-in or custom) — empty by default, so a fresh
   * install shows no link anywhere until the analyst opts in. `custom` is
   * the user's own providers, same shape as the built-ins (see
   * `core/ti-links.ts`), validated (`https://` + `{value}`) by the settings
   * UI before being stored here.
   */
  readonly ti: { readonly providers: readonly string[]; readonly custom: readonly TiProvider[] };
}

const DEFAULTS: Settings = {
  lang: 'auto',
  platformVariant: 'auto',
  logLevel: 'debug',
  retention: { maxBytes: 20_000_000 },
  ti: { providers: [], custom: [] },
};

export function getSettings(): Settings {
  const stored = getJson<Partial<Settings>>(STORAGE_KEYS.SETTINGS, {});
  return { ...DEFAULTS, ...stored };
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return getSettings()[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const stored = getJson<Partial<Settings>>(STORAGE_KEYS.SETTINGS, {});
  setJson(STORAGE_KEYS.SETTINGS, { ...stored, [key]: value });
}

/**
 * Resolve the tenant variant for rule filtering (#7). The `platformVariant`
 * setting wins when set; `auto` falls back to a 1:1 mapping from the
 * current `PlatformId`. Detecting `defender-unified` automatically and
 * remembering it per tenant (see PLAN-DEV.md "Point ouvert") is phase 4/5,
 * not implemented here.
 */
export function resolvePlatformVariant(platformId: PlatformId): PlatformVariant {
  const setting = getSetting('platformVariant');
  if (setting !== 'auto') return setting;
  return platformId === 'sentinel' ? 'sentinel' : 'defender';
}
