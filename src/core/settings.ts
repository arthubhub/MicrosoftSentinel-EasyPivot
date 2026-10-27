import type { InsertMode, PlatformId, PlatformVariant } from '../types.ts';
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
   * How `injectQuery()` puts the KQL into the editor (W2 step 6, #22). No
   * settings-UI control yet (same precedent as `platformVariant`): set by
   * hand in storage until a later phase decides this needs a toggle.
   */
  readonly insertMode: InsertMode;
  /**
   * Click Run automatically right after a successful injection (N1 level 2
   * "Insérer + Run", #22). Defaults to `false` - project rule 4: capture is
   * passive, no query runs on the user's behalf unless they opt in. Checked
   * inside `PlatformAdapter.runQuery()` itself, not only by its caller.
   */
  readonly autoRun: boolean;
  /**
   * `debug` by default: the script lives inside someone else's SPA, where a
   * broken selector fails silently rather than throwing, and the console is
   * the only place that shows it. Set to `off` to silence it entirely.
   */
  readonly logLevel: LogLevelSetting;
  /**
   * Retention (N1, phase 4c). `days` (default 30) governs how long a
   * `QueryRun`'s SAMPLE survives after its `lastAccessAt` - the run's
   * summary/columns are never deleted by `days` alone, see `capture/store.ts`.
   * `closedDays` (default 7) is read and stored for forward compatibility
   * but has no code path yet: it is defined against `Case.closedAt`, and
   * cases do not exist until phase 5. `maxBytes` (storage probe, N6, and
   * now also the capture store's global cap) is the only field phase 1
   * implemented.
   */
  readonly retention: { readonly maxBytes: number; readonly days: number; readonly closedDays: number };
  /**
   * Threat Intel links (N7, #20). `providers` is the list of enabled
   * provider ids (built-in or custom) — empty by default, so a fresh
   * install shows no link anywhere until the analyst opts in. `custom` is
   * the user's own providers, same shape as the built-ins (see
   * `core/ti-links.ts`), validated (`https://` + `{value}`) by the settings
   * UI before being stored here.
   */
  readonly ti: { readonly providers: readonly string[]; readonly custom: readonly TiProvider[] };
  /**
   * Network capture (N1, phase 4). `enabled` defaults to `true` per the
   * 21/10 decision: capture is on for ALL querying requests, not just the
   * ones EasyPivot injects - that is what makes retention/masking mandatory
   * from phase 4 onward. Setting it to `false` means the patch in
   * `capture/interceptor.ts` is not installed at all on the *next* load
   * (it is read once, at document-start, before the patch runs - toggling
   * it mid-session does not un-patch an already-patched page).
   * `debug` (default `false`) additionally logs every observed request
   * that no profile matched, which `enabled` alone deliberately does not
   * (N1: "aucun profil ne correspond -> rien n'est fait, coût négligeable").
   * `maxRowsSample` (default 200) and `keepSampleForManual` (default
   * `false`) are `capture/store.ts`'s retention knobs (N1 "Rétention et
   * masquage") - a run with no link to a pivot keeps only its summary and
   * columns unless this is `true` or the user pins the result (phase 5).
   */
  readonly capture: {
    readonly enabled: boolean;
    readonly debug: boolean;
    readonly maxRowsSample: number;
    readonly keepSampleForManual: boolean;
    /**
     * Replace digits and letters in STORED values with a consistent random
     * substitution (see capture/sanitize.ts). Off by default: the real values
     * are what make a summary useful for triage. Turn it on to keep customer
     * data out of local storage at the cost of readability.
     */
    readonly sanitizeValues: boolean;
  };
}

const DEFAULTS: Settings = {
  lang: 'auto',
  platformVariant: 'auto',
  insertMode: 'append',
  autoRun: false,
  logLevel: 'debug',
  retention: { maxBytes: 20_000_000, days: 30, closedDays: 7 },
  ti: { providers: [], custom: [] },
  capture: { enabled: true, debug: false, maxRowsSample: 200, keepSampleForManual: false, sanitizeValues: false },
};

/**
 * Merge stored settings over the defaults, ONE LEVEL DEEP.
 *
 * A plain `{ ...DEFAULTS, ...stored }` is wrong here and was actively
 * dangerous: the nested groups (`capture`, `retention`, `ti`) are whole
 * objects, so persisting a partial group REPLACED it and silently dropped its
 * siblings. Storing `{ capture: { debug: true } }` made `capture.enabled`
 * undefined - falsy - which turns capture OFF without anyone asking; storing
 * `{ retention: { days: 5 } }` made `maxBytes` undefined, so the global 20 MB
 * cap stopped being enforced and captured customer data grew unbounded.
 * Found by testing the purge, not by a crash: both failures are silent.
 *
 * One level is enough - no setting group nests further - and it keeps the
 * "add a key without a migration" property: an unknown stored key is carried
 * through untouched, and a missing one falls back to its default.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getSettings(): Settings {
  const stored = getJson<Partial<Settings>>(STORAGE_KEYS.SETTINGS, {});
  const out: Record<string, unknown> = { ...(DEFAULTS as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(stored)) {
    const base = (DEFAULTS as unknown as Record<string, unknown>)[key];
    out[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value;
  }
  return out as unknown as Settings;
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
