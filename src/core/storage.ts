import type { CachedData } from '../types.ts';

// ── JSON values in Tampermonkey storage ──

export function getJson<T>(key: string, fallback: T): T {
  const raw = GM_getValue<string>(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  GM_setValue(key, JSON.stringify(value));
}

// ── Cache entries (data + timestamp; the caller decides what is stale) ──

export function getCacheEntry<T>(key: string): CachedData<T> | null {
  const entry = getJson<CachedData<T> | null>(key, null);
  if (!entry || typeof entry.timestamp !== 'number') return null;
  return entry;
}

export function setCache<T>(key: string, data: T): void {
  const cached: CachedData<T> = { data, timestamp: Date.now() };
  setJson(key, cached);
}

export function deleteKey(key: string): void {
  GM_deleteValue(key);
}
