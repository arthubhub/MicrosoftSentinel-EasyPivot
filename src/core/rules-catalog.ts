import type { PivotCatalog } from '../types.ts';
import {
  CACHE_TTL_MS,
  DEFAULT_RULES_URL,
  RULES_FETCH_TIMEOUT,
  STORAGE_KEYS,
} from '../config.ts';
import { getCacheEntry, setCache, deleteKey } from './storage.ts';
import { BUNDLED_CATALOG, setCatalog, getCatalog } from './pivot.ts';
import { isFullCatalog, normalizeCatalog } from './catalog-format.ts';
import { validateCatalog } from './catalog-validate.ts';
import { log } from './log.ts';
import { t } from '../i18n/index.ts';

/**
 * Pivot rules catalog lifecycle:
 * 1. at startup, the cached catalog for the configured URL is applied
 *    synchronously (else the bundled one stays in place);
 * 2. if the cache is missing or older than CACHE_TTL_MS, the catalog is
 *    downloaded in the background and applied when it arrives;
 * 3. a download that fails or is invalid keeps whatever is in place.
 * Both formats of the rules repo are accepted (see catalog-format.ts), and
 * whatever comes out of it is validated (see catalog-validate.ts): blocking
 * problems reject the catalog, the rest becomes `status.warnings`.
 */

export type CatalogSource = 'bundled' | 'cache' | 'remote';

export interface CatalogStatus {
  readonly source: CatalogSource;
  readonly url: string;
  readonly version: string;
  readonly ruleCount: number;
  /** When the active catalog was downloaded (0 for the bundled one) */
  readonly fetchedAt: number;
  readonly error: string;
  /** Non-blocking problems of the active catalog (shown in the settings) */
  readonly warnings: readonly string[];
}

interface CachedCatalog {
  readonly url: string;
  readonly catalog: PivotCatalog;
}

let status: CatalogStatus = makeStatus('bundled', '', 0, '', []);
let inFlight: Promise<CatalogStatus> | null = null;
const listeners = new Set<() => void>();

function makeStatus(
  source: CatalogSource,
  url: string,
  fetchedAt: number,
  error: string,
  warnings: readonly string[],
): CatalogStatus {
  const c = getCatalog();
  return { source, url, version: c.version, ruleCount: c.rules.length, fetchedAt, error, warnings };
}

function setStatus(next: CatalogStatus): CatalogStatus {
  status = next;
  for (const fn of listeners) fn();
  return status;
}

export function getCatalogStatus(): CatalogStatus {
  return status;
}

/** Called whenever the active catalog or its status changes */
export function onCatalogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Rules URL (user-configurable) ──

export function getRulesUrl(): string {
  const url = GM_getValue<string>(STORAGE_KEYS.RULES_URL, '');
  return url || DEFAULT_RULES_URL;
}

/** '' or the default URL resets to the default */
export function setRulesUrl(url: string): void {
  const u = url.trim();
  if (!u || u === DEFAULT_RULES_URL) deleteKey(STORAGE_KEYS.RULES_URL);
  else GM_setValue(STORAGE_KEYS.RULES_URL, u);
}

// ── Loading ──

function download(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: RULES_FETCH_TIMEOUT,
      headers: { Accept: 'application/json' },
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          reject(new Error(`HTTP ${res.status}`));
          return;
        }
        try {
          resolve(JSON.parse(res.responseText));
        } catch {
          reject(new Error(t('error.invalidJson')));
        }
      },
      onerror: () => reject(new Error(t('error.networkError'))),
      ontimeout: () => reject(new Error(t('error.timeout'))),
    });
  });
}

/**
 * Apply the cached catalog of the configured URL, if any. Synchronous.
 * The cache is validated too: a script update can narrow the supported
 * format range. A rejected cache is kept (the user may downgrade), it is
 * simply not applied — the background refresh then takes over.
 */
function applyCached(): { fresh: boolean } {
  const url = getRulesUrl();
  const entry = getCacheEntry<CachedCatalog>(STORAGE_KEYS.RULES_CACHE);
  if (!entry || entry.data?.url !== url || !isFullCatalog(entry.data.catalog)) {
    return { fresh: false };
  }
  const report = validateCatalog(entry.data.catalog);
  if (!report.catalog) {
    log.warn('catalog: cached copy REJECTED by validation, falling back', report.errors);
    return { fresh: false };
  }
  log.info(`catalog: from cache, v${report.catalog.version}, ${report.catalog.rules.length} rules,`
    + ` ${report.warnings.length} warning(s)`);
  if (report.warnings.length) log.debug('catalog warnings', report.warnings);
  setCatalog(report.catalog);
  setStatus(makeStatus('cache', url, entry.timestamp, '', report.warnings));
  return { fresh: Date.now() - entry.timestamp < CACHE_TTL_MS };
}

/** Download the catalog now. Keeps the active catalog on failure. */
export function refreshCatalog(): Promise<CatalogStatus> {
  if (inFlight) return inFlight;
  const url = getRulesUrl();

  inFlight = download(url)
    .then((data) => {
      const catalog = normalizeCatalog(data, BUNDLED_CATALOG);
      if (!catalog) throw new Error(t('error.unexpectedCatalogFormat'));
      // Blocking problem: reject, the .catch below keeps the active catalog
      const report = validateCatalog(catalog);
      if (!report.catalog) {
        log.warn('catalog: download REJECTED by validation, keeping the active one', report.errors);
        throw new Error(t('error.catalogRejected', { reason: report.errors[0] ?? '' }));
      }
      log.info(`catalog: downloaded, v${report.catalog.version}, ${report.catalog.rules.length} rules,`
        + ` ${report.warnings.length} warning(s)`);
      if (report.warnings.length) log.debug('catalog warnings', report.warnings);
      setCatalog(report.catalog);
      // Stored normalized (full format) and sanitized, whatever was downloaded
      setCache<CachedCatalog>(STORAGE_KEYS.RULES_CACHE, { url, catalog: report.catalog });
      return setStatus(makeStatus('remote', url, Date.now(), '', report.warnings));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return setStatus({ ...status, error: `${url} : ${message}` });
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Startup: cached catalog now, background refresh if stale or missing. */
export function initCatalog(): void {
  const { fresh } = applyCached();
  if (!fresh) void refreshCatalog();
}

/** After a URL change: drop back to the bundle, then download the new URL. */
export function reloadCatalog(): Promise<CatalogStatus> {
  // Not validated: the bundled catalog is ours, checked by the rules repo
  log.info(`catalog: using the bundled copy, v${BUNDLED_CATALOG.version}, ${BUNDLED_CATALOG.rules.length} rules`);
  setCatalog(BUNDLED_CATALOG);
  setStatus(makeStatus('bundled', '', 0, '', []));
  applyCached();
  return refreshCatalog();
}
