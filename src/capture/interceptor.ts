import type { CaptureProfile, CaptureRequest, ParsedResult } from './types.ts';
import type { ParsedColumn, PlatformId } from '../types.ts';
import { getSetting } from '../core/settings.ts';
import { log } from '../core/log.ts';
import { toPage } from './to-page.ts';
import { addRun, newRunId, startRetentionScheduler } from './store.ts';

/**
 * Generic, platform-independent patch of `XMLHttpRequest` and `fetch`
 * (N1 "Déroulé d'une capture"). This module knows nothing about Sentinel or
 * Defender: it only asks each registered CaptureProfile "is this a query
 * execution?" and, if one says yes, defers parsing so a multi-MB response
 * never blocks the grid. Garde-fous (N1), all enforced here:
 *   - never reads a header VALUE, only names (project rule 3);
 *   - never mutates the request or the response it observes;
 *   - every hook is wrapped so a throw can never reach the page;
 *   - `capture.enabled = false` means the patch is not installed at all.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Expando carried on the XHR instance between open()/setRequestHeader()/send() ──

interface CaptureInfo {
  method: string;
  url: string;
}

interface CapturedXhr extends XMLHttpRequest {
  __shqCapture?: CaptureInfo;
}

/** What interceptor.ts hands back once a matched request has been parsed. */
export interface CaptureOutcome {
  readonly profile: CaptureProfile;
  readonly transport: 'xhr' | 'fetch';
  readonly status: number;
  readonly query: { readonly kql: string; readonly timespan?: string; readonly tenantKey?: string } | null;
  readonly result: ParsedResult | null;
  /** `Date.now()` when `send()`/`fetch()` was called - `QueryRun.startedAt` (phase 4c). */
  readonly startedAt: number;
  /** `receivedAt - startedAt`, i.e. time to `loadend`/response resolution - `QueryRun.durationMs`. */
  readonly durationMs: number;
  /**
   * Id this outcome will use if `capture/store.ts` turns it into a
   * `QueryRun` (4e). Generated HERE, synchronously, at match time - not by
   * `store.ts` - so the in-memory row cache below and the persisted
   * `QueryRun` always agree on one id, even though persistence itself is
   * async (tenant-key hashing in `core/tenant.ts`).
   */
  readonly id: string;
}

export type CaptureResultHandler = (outcome: CaptureOutcome) => void;

let installed = false;
let profiles: readonly CaptureProfile[] = [];

// ── 4g: capture health stats (session-only, never persisted) ──
//
// core/health.ts's Capture probe needs to tell apart "nothing seen yet"
// from "seen but not parsed" (N6: fail only on the latter - a profile that
// matches but can't make sense of the response means the portal changed
// shape). Two counters are the minimum needed for that; nothing about a
// request NO profile matched is ever touched here (project rule 1 - that
// traffic is none of our business), only requests `processMatch()` already
// knows a profile recognized. Reset on every fresh page load, like
// `createResultsGridProbe()`'s `everSeen` - there is no persistence here on
// purpose, this describes "since load", not "ever".

let parsedCount = 0;
let unparsedCount = 0;

export interface CaptureStats {
  /** Matched requests that became a `ParsedResult` (query + response understood). */
  readonly parsed: number;
  /** Matched requests that did NOT (profile said yes, `parseResponse` returned null). */
  readonly unparsed: number;
}

export function getCaptureStats(): CaptureStats {
  return { parsed: parsedCount, unparsed: unparsedCount };
}

// ── 4g: "after each captured query" health trigger (N6's third trigger) ──
//
// interceptor.ts has no PlatformAdapter (only a PlatformId per profile), so
// it cannot call core/health.ts's `onQueryCaptured(platform)` itself -
// doing so would also import capture/store.ts -> core/health.ts, a cycle
// the other way (health.ts already reads capture/store.ts and
// capture/interceptor.ts for the two probes below). main.ts holds the
// PlatformAdapter already and imports both sides, so it subscribes here and
// forwards to `onQueryCaptured` - see main.ts's capture wiring.
const captureListeners = new Set<() => void>();

/** Notified once per matched (profile-recognized) request, parsed or not. */
export function onCaptureResult(fn: () => void): () => void {
  captureListeners.add(fn);
  return () => captureListeners.delete(fn);
}

function notifyCaptureListeners(): void {
  for (const fn of captureListeners) {
    try {
      fn();
    } catch (err) {
      log.error('capture: onCaptureResult listener threw', err);
    }
  }
}

// ── 4e: in-memory cache of the last captured result, per platform ──
//
// W2 step 2 (#14) reads the DOM-clicked row from the last captured
// `QueryRun` first. That can NOT be `capture/store.ts`'s persisted store:
//   - `capture.keepSampleForManual` defaults to FALSE, so a manually-run
//     query (the common right-click case) keeps NO `rowsSample` at all in
//     storage - tier 1 would almost never find anything with default
//     settings.
//   - `capture.sanitizeValues` masks `rowsSample` AT STORE TIME (see
//     `store.ts`'s `addRun()`), so even a kept sample could never
//     byte-match a live DOM row, and a lucky match would hand back masked
//     nonsense as "the full row".
// This cache sidesteps both: it is filled right here, from the RAW
// `ParsedResult` this module already holds in `processMatch()`, strictly
// BEFORE `store.ts` ever sees it (masking happens downstream, only on the
// way to persistence). It is never persisted (no storage key, no
// `GM_setValue`), holds only the LAST run per platform (one grid, one page
// - older runs are of no use to a row-matching lookup), and is cleared by
// `clearLastCapture()` so a stale result from a previous page view can
// never be matched against a new page's rows (called from
// `ui/pivot-trigger.ts`'s `destroy()` - the hunting-page UI teardown
// boundary reachable from this phase's files; `main.ts`'s `removeUI()`
// calls it on every SPA navigation away from the hunting page).
export interface CapturedRowSet {
  readonly runId: string;
  readonly platform: PlatformId;
  readonly columns: readonly ParsedColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly sourceTables: readonly string[];
}

const lastCapture = new Map<PlatformId, CapturedRowSet>();

/** The last captured result for this platform, or `null` if none yet (or cleared). */
export function getLastCapture(platform: PlatformId): CapturedRowSet | null {
  return lastCapture.get(platform) ?? null;
}

/** Forget every cached result. Call on hunting-page teardown (see header above). */
export function clearLastCapture(): void {
  if (lastCapture.size === 0) return;
  lastCapture.clear();
  log.debug('capture: in-memory row cache cleared');
}

function rememberLastCapture(platform: PlatformId, runId: string, result: ParsedResult): void {
  lastCapture.set(platform, {
    runId,
    platform,
    columns: result.columns,
    rows: result.rows,
    sourceTables: result.sourceTables,
  });
  log.debug('capture: in-memory row cache updated', { platform, runId, rows: result.rows.length });
}

// ── Page window access (same unsafeWindow fallback as core/editor-bridge.ts) ──

function pageWindow(): any {
  return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
}

function baseHref(): string | undefined {
  try {
    return typeof location !== 'undefined' ? location.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Default result sink: logs shape only, never raw row values, then hands
 * the outcome to `capture/store.ts` (phase 4c) so it becomes a `QueryRun`.
 * `store.addRun` is async (tenant-key and KQL hashing both are, see
 * `core/tenant.ts`) but this handler stays sync per `CaptureResultHandler` -
 * fire-and-forget, its own errors are caught inside `addRun` and never
 * thrown here (project rule: capture never throws into the page).
 */
const defaultOnResult: CaptureResultHandler = (outcome) => {
  const { profile, transport, status, query, result } = outcome;
  if (!result) {
    log.debug(`capture: ${transport} matched '${profile.platform}' (HTTP ${status}) but produced no ParsedResult`);
    return;
  }
  log.debug(`capture: ${transport} '${profile.platform}' parsed (HTTP ${status})`, {
    rows: result.rows.length,
    truncated: result.truncated,
    error: result.error ?? null,
    warning: result.warning ?? null,
    sourceTables: result.sourceTables,
    hasQuery: query !== null,
    durationMs: outcome.durationMs,
  });
  void addRun(outcome).catch((err: unknown) => log.error('capture: store.addRun() rejected', err));
};

/**
 * Install the capture patch, once per page/frame load (idempotent within a
 * JS context - each navigation into the hunting page gets a fresh one at
 * document-start). No-op if `capture.enabled` is false: the patch is then
 * not installed at all, not merely inert, per N1's acceptance criteria.
 */
export function installCapture(
  capturedProfiles: readonly CaptureProfile[] = [],
  onResult: CaptureResultHandler = defaultOnResult,
): void {
  if (installed) {
    log.debug('capture: installCapture() called again, already installed - ignored');
    return;
  }

  // Retention runs independently of `capture.enabled`: data captured in a
  // previous session must still age out and get purged even if the user
  // has since turned capture off (N1 "Rétention et masquage" has no
  // dependency on `capture.enabled`). Started here, not in main.ts, to keep
  // every capture-store wiring decision in one file.
  try {
    startRetentionScheduler();
  } catch (err) {
    log.error('capture: startRetentionScheduler() failed', err);
  }

  let enabled: boolean;
  try {
    enabled = getSetting('capture').enabled;
  } catch (err) {
    // A broken setting must never prevent the page from loading.
    log.error('capture: could not read capture.enabled, leaving the patch off for this load', err);
    return;
  }
  if (!enabled) {
    log.info('capture: disabled by setting (capture.enabled = false), patch not installed');
    return;
  }

  installed = true;
  profiles = capturedProfiles;

  const w = pageWindow();
  patchXhr(w, onResult);
  patchFetch(w, onResult);

  log.info(
    `capture: installed (${profiles.length} profile(s) registered: ${profiles.map((p) => p.platform).join(', ') || 'none'})`,
  );
}

// ── XHR patch ──

function patchXhr(w: any, onResult: CaptureResultHandler): void {
  try {
    const proto = w?.XMLHttpRequest?.prototype;
    if (!proto) {
      log.warn('capture: no XMLHttpRequest on the page window, xhr capture skipped');
      return;
    }
    const origOpen: (...args: any[]) => any = proto.open;
    const origSend: (...args: any[]) => any = proto.send;
    const origSetHeader: (...args: any[]) => any = proto.setRequestHeader;

    proto.open = toPage(function (this: CapturedXhr, method: string, url: string, ...rest: unknown[]) {
      try {
        this.__shqCapture = { method, url };
      } catch (err) {
        log.error('capture: xhr open() hook failed', err);
      }
      return origOpen.apply(this, [method, url, ...rest]);
    });

    // Patched because N1's "Déroulé d'une capture" lists setRequestHeader among the
    // hooks, but it deliberately records NOTHING in this phase: N1's guardrails say
    // « les en-têtes sont ignorés sauf au niveau 3 (mémoire seulement) ». Collecting
    // names here would be write-only state - nothing in phase 4 reads them, and it
    // would keep a pile of header names alive for every XHR on the page for no
    // benefit. This is the hook point #23 will fill, in memory only, never stored.
    proto.setRequestHeader = toPage(function (this: CapturedXhr, name: string, value: string) {
      return origSetHeader.apply(this, [name, value]);
    });

    proto.send = toPage(function (this: CapturedXhr, body?: unknown) {
      try {
        const info = this.__shqCapture;
        if (info) handleXhrSend(this, info, body, onResult);
      } catch (err) {
        log.error('capture: xhr send() hook failed', err);
      }
      return origSend.apply(this, [body]);
    });

    log.debug('capture: XMLHttpRequest patched (open/send/setRequestHeader)');
  } catch (err) {
    log.error('capture: failed to patch XMLHttpRequest, capture stays off for xhr', err);
  }
}

function handleXhrSend(xhr: CapturedXhr, info: CaptureInfo, body: unknown, onResult: CaptureResultHandler): void {
  const sentAt = Date.now();
  let url: URL;
  try {
    url = new URL(info.url, baseHref());
  } catch {
    return; // malformed URL - never let capture break the real request
  }

  const parsedBody = safeJsonParse(body);
  const req: CaptureRequest = { url, method: info.method, body: parsedBody };
  const profile = matchProfile(req);
  if (!profile) {
    if (debugEnabled()) log.debug(`capture: xhr ${info.method} ${url.pathname} - no profile matched`);
    return;
  }
  log.debug(`capture: xhr ${info.method} ${url.pathname} matched '${profile.platform}'`);

  xhr.addEventListener('loadend', () => {
    try {
      const receivedAt = Date.now();
      const status = xhr.status;
      let responseText = '';
      try {
        responseText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      } catch {
        // .responseText throws when responseType isn't '' or 'text' - leave it empty.
      }
      deferParse(() => processMatch(profile, req, status, responseText, 'xhr', onResult, sentAt, receivedAt));
    } catch (err) {
      log.error('capture: xhr loadend hook failed', err);
    }
  });
}

// ── fetch patch ──

function patchFetch(w: any, onResult: CaptureResultHandler): void {
  try {
    const origFetch: ((...args: any[]) => Promise<Response>) | undefined = w?.fetch;
    if (typeof origFetch !== 'function') {
      log.warn('capture: no fetch on the page window, fetch capture skipped');
      return;
    }

    const patched = async function (this: unknown, input: unknown, init?: { method?: string; body?: unknown }) {
      const sentAt = Date.now();
      // eslint-disable-next-line prefer-rest-params
      const res: Response = await origFetch.apply(this, arguments as unknown as any[]);
      const receivedAt = Date.now();
      try {
        handleFetch(input, init, res, onResult, sentAt, receivedAt);
      } catch (err) {
        log.error('capture: fetch hook failed', err);
      }
      return res;
    };

    w.fetch = toPage(patched);
    log.debug('capture: fetch patched');
  } catch (err) {
    log.error('capture: failed to patch fetch, capture stays off for fetch', err);
  }
}

function handleFetch(
  input: unknown,
  init: { method?: string; body?: unknown } | undefined,
  res: Response,
  onResult: CaptureResultHandler,
  sentAt: number,
  receivedAt: number,
): void {
  const rawUrl = typeof input === 'string' ? input : (input as { url?: string } | undefined)?.url;
  if (!rawUrl) return;

  let url: URL;
  try {
    url = new URL(rawUrl, baseHref());
  } catch {
    return;
  }

  const method = init?.method ?? (input as { method?: string } | undefined)?.method ?? 'GET';
  const parsedBody = safeJsonParse(init?.body);
  const req: CaptureRequest = { url, method, body: parsedBody };
  const profile = matchProfile(req);
  if (!profile) {
    if (debugEnabled()) log.debug(`capture: fetch ${method} ${url.pathname} - no profile matched`);
    return;
  }
  log.debug(`capture: fetch ${method} ${url.pathname} matched '${profile.platform}'`);

  const status = res.status;
  // Clone before reading - the real response body must stay untouched for the page.
  res
    .clone()
    .text()
    .then((text) => deferParse(() => processMatch(profile, req, status, text, 'fetch', onResult, sentAt, receivedAt)))
    .catch((err: unknown) => log.error('capture: fetch response read failed', err));
}

// ── Shared: match, defer, parse ──

function matchProfile(req: CaptureRequest): CaptureProfile | null {
  for (const p of profiles) {
    try {
      if (p.match(req)) return p;
    } catch (err) {
      log.error(`capture: profile '${p.platform}' match() threw, skipping it for this request`, err);
    }
  }
  return null;
}

/** requestIdleCallback with a setTimeout(0) fallback (N1: never block the grid on a huge response). */
function deferParse(fn: () => void): void {
  const run = (): void => {
    try {
      fn();
    } catch (err) {
      log.error('capture: deferred parse failed', err);
    }
  };
  try {
    const ric: ((cb: () => void) => unknown) | undefined =
      typeof requestIdleCallback === 'function' ? requestIdleCallback : undefined;
    if (ric) {
      ric(run);
    } else {
      setTimeout(run, 0);
    }
  } catch {
    run();
  }
}

function processMatch(
  profile: CaptureProfile,
  req: CaptureRequest,
  status: number,
  responseText: string,
  transport: 'xhr' | 'fetch',
  onResult: CaptureResultHandler,
  startedAt: number,
  receivedAt: number,
): void {
  let query: CaptureOutcome['query'] = null;
  try {
    query = profile.extractQuery(req);
  } catch (err) {
    log.error(`capture: profile '${profile.platform}' extractQuery() threw`, err);
  }

  let result: ParsedResult | null = null;
  try {
    const parsedResponseBody = safeJsonParse(responseText);
    result = profile.parseResponse(parsedResponseBody, req);
  } catch (err) {
    log.error(`capture: profile '${profile.platform}' parseResponse() threw`, err);
  }

  // 4g: counted here, once per MATCHED request, regardless of what `onResult`
  // does with it - this is the only signal the health probe needs ("seen" vs
  // "seen but not parsed"), see the counters' doc comment above.
  if (result) parsedCount++;
  else unparsedCount++;

  // One id for both the in-memory row cache (now) and the persisted
  // QueryRun `store.ts#addRun()` creates from this SAME outcome (async,
  // later) - see CaptureOutcome.id's doc comment above.
  const id = newRunId();
  if (result) {
    try {
      rememberLastCapture(profile.platform, id, result);
    } catch (err) {
      log.error('capture: failed to update the in-memory row cache', err);
    }
  }

  try {
    onResult({ profile, transport, status, query, result, startedAt, durationMs: Math.max(0, receivedAt - startedAt), id });
  } catch (err) {
    log.error('capture: onResult handler threw', err);
  }

  // N6 third trigger ("après chaque requête capturée"): fires for every
  // matched request, parsed or not, so the Capture/Grid probes reflect it
  // even when parsing failed (arguably the most important time to refresh).
  notifyCaptureListeners();
}

function safeJsonParse(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== 'string') return undefined; // FormData/Blob/etc - profiles only match JSON bodies (Gabarit)
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function debugEnabled(): boolean {
  try {
    return getSetting('capture').debug;
  } catch {
    return false;
  }
}
