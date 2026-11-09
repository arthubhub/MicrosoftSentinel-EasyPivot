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
 *   - never reads a header VALUE, only names (project rule 3) - EXCEPT, when
 *     the opt-in `background.enabled` setting is on (#27), the headers of a
 *     MATCHED querying request, kept in memory only (`replayTemplates`) to
 *     replay that request with another KQL; never stored, logged or exported;
 *   - never mutates the request or the response it observes;
 *   - every hook is wrapped so a throw can never reach the page;
 *   - `capture.enabled = false` means the patch is not installed at all.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Expando carried on the XHR instance between open()/setRequestHeader()/send() ──

interface CaptureInfo {
  method: string;
  url: string;
  /** #27 only (background.enabled): header values set on this XHR, in memory */
  headers?: Record<string, string>;
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
//   - `capture.keepSampleForManual` can be FALSE (opt-out), so a manually-run
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
  /** `// [RULE-ID]` header of the query, when EasyPivot wrote it (#33: a discovery result's type) */
  readonly ruleId?: string;
}

const RULE_ID_HEADER = /^\/\/ \[([A-Za-z0-9_-]+)\]/;

const lastCapture = new Map<PlatformId, CapturedRowSet>();

/** The last captured result for this platform, or `null` if none yet (or cleared). */
export function getLastCapture(platform: PlatformId): CapturedRowSet | null {
  return lastCapture.get(platform) ?? null;
}

/** Forget every cached result. Call on hunting-page teardown (see header above). */
export function clearLastCapture(): void {
  replayTemplates.clear(); // #27: no token outlives the hunting page
  if (lastCapture.size === 0) return;
  lastCapture.clear();
  log.debug('capture: in-memory row cache cleared');
}

function rememberLastCapture(platform: PlatformId, runId: string, result: ParsedResult, kql: string | undefined): void {
  const firstLine = kql?.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  const ruleId = RULE_ID_HEADER.exec(firstLine)?.[1];
  lastCapture.set(platform, {
    runId,
    platform,
    columns: result.columns,
    rows: result.rows,
    sourceTables: result.sourceTables,
    ...(ruleId ? { ruleId } : {}),
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
  resultHandler = onResult;

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
      try {
        const info = this.__shqCapture;
        if (info && backgroundEnabled()) (info.headers ??= {})[String(name)] = String(value);
      } catch {
        /* never let the hook break the real request */
      }
      return origSetHeader.apply(this, [name, value]);
    });
    original.xhr = { open: origOpen, send: origSend, setHeader: origSetHeader };

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
  rememberTemplate(profile, 'xhr', req, info.headers ?? {});

  xhr.addEventListener('loadend', () => {
    try {
      const receivedAt = Date.now();
      const status = xhr.status;
      try {
        rememberRateLimit(profile.platform, xhr.getResponseHeader('x-rate-limit-remaining'));
      } catch {
        /* header not exposed */
      }
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

    original.fetch = origFetch;
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
  const fetchHeaders = (init as { headers?: unknown } | undefined)?.headers;
  const req: CaptureRequest = { url, method, body: parsedBody };
  const profile = matchProfile(req);
  if (!profile) {
    if (debugEnabled()) log.debug(`capture: fetch ${method} ${url.pathname} - no profile matched`);
    return;
  }
  log.debug(`capture: fetch ${method} ${url.pathname} matched '${profile.platform}'`);
  if (backgroundEnabled()) rememberTemplate(profile, 'fetch', req, headersToRecord(fetchHeaders));
  try {
    rememberRateLimit(profile.platform, res.headers.get('x-rate-limit-remaining'));
  } catch {
    /* no headers */
  }

  const status = res.status;
  // Clone before reading - the real response body must stay untouched for the page.
  res
    .clone()
    .text()
    .then((text) => deferParse(() => processMatch(profile, req, status, text, 'fetch', onResult, sentAt, receivedAt)))
    .catch((err: unknown) => log.error('capture: fetch response read failed', err));
}

// ── #27: background context queries (opt-in, `background.enabled`) ──
//
// The last MATCHED querying request per platform is kept in memory as a
// template: URL, method, body and the header values the page set (Sentinel's
// Bearer, Defender's X-XSRF-TOKEN; Defender's session cookies travel by
// themselves, same-origin). Nothing here is persisted, logged or exported; a
// reload forgets it, and every query the analyst runs refreshes it (a stale
// token simply makes the replay fail with 401 until then). The replay goes
// through the ORIGINAL xhr/fetch (not the patched ones), so it never replaces
// the grid's row cache nor counts as a user query; its outcome goes to the
// store like any capture, so it lands in the case and in the report.

interface ReplayTemplate {
  readonly profile: CaptureProfile;
  readonly transport: 'xhr' | 'fetch';
  readonly req: CaptureRequest;
  readonly headers: Readonly<Record<string, string>>;
  readonly at: number;
}

const replayTemplates = new Map<PlatformId, ReplayTemplate>();
const rateRemaining = new Map<PlatformId, number>();
const original: {
  xhr?: { open: (...a: any[]) => any; send: (...a: any[]) => any; setHeader: (...a: any[]) => any };
  fetch?: (...a: any[]) => Promise<Response>;
} = {};
let resultHandler: CaptureResultHandler = defaultOnResult;

/** Defender announces a per-minute budget; a background query is refused below this many left. */
export const MIN_RATE_REMAINING = 5;
const REPLAY_TIMEOUT_MS = 120_000;
/** Headers the browser sets itself (or must not be copied) */
const SKIP_HEADERS = /^(content-length|host|cookie|connection|accept-encoding|origin|referer|user-agent)$/i;

function backgroundEnabled(): boolean {
  try {
    return getSetting('background').enabled === true;
  } catch {
    return false;
  }
}

function headersToRecord(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!h) return out;
    const iter: Iterable<[string, string]> =
      typeof (h as Headers).forEach === 'function' && typeof (h as Headers).entries === 'function'
        ? (h as Headers).entries()
        : Array.isArray(h)
          ? (h as [string, string][])
          : Object.entries(h as Record<string, string>);
    for (const [k, v] of iter) out[String(k)] = String(v);
  } catch {
    /* unreadable headers: no template headers */
  }
  return out;
}

function rememberTemplate(profile: CaptureProfile, transport: 'xhr' | 'fetch', req: CaptureRequest, headers: Record<string, string>): void {
  if (!backgroundEnabled() || !profile.buildReplay) return;
  replayTemplates.set(profile.platform, { profile, transport, req, headers: { ...headers }, at: Date.now() });
  // Names only, never values
  log.debug('capture: replay template refreshed', { platform: profile.platform, transport, headerCount: Object.keys(headers).length });
}

function rememberRateLimit(platform: PlatformId, value: string | null): void {
  if (value === null || value === '') return;
  const n = Number(value);
  if (Number.isFinite(n)) rateRemaining.set(platform, n);
}

export type ReplayAvailability = 'disabled' | 'no-capture' | 'no-template' | 'rate-limited' | 'ok';

export function replayAvailability(platform: PlatformId): ReplayAvailability {
  if (!backgroundEnabled()) return 'disabled';
  if (!installed) return 'no-capture';
  if (!replayTemplates.has(platform)) return 'no-template';
  const left = rateRemaining.get(platform);
  if (left !== undefined && left < MIN_RATE_REMAINING) return 'rate-limited';
  return 'ok';
}

export type ReplayResult =
  | { readonly ok: true; readonly outcome: CaptureOutcome }
  | { readonly ok: false; readonly reason: Exclude<ReplayAvailability, 'ok'> | 'build' | 'network' | 'auth' | 'http' | 'parse'; readonly status?: number; readonly error?: string };

function sendOriginal(t: ReplayTemplate, url: URL, body: string): Promise<{ status: number; text: string; rate: string | null }> {
  if (t.transport === 'fetch' && original.fetch) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.headers)) if (!SKIP_HEADERS.test(k)) headers[k] = v;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REPLAY_TIMEOUT_MS) : null;
    return original
      .fetch.call(pageWindow(), url.href, { method: t.req.method, headers, body, credentials: 'include', ...(ctl ? { signal: ctl.signal } : {}) })
      .then(async (res: Response) => ({ status: res.status, text: await res.text(), rate: res.headers.get('x-rate-limit-remaining') }))
      .finally(() => timer && clearTimeout(timer));
  }
  return new Promise((resolve, reject) => {
    const xo = original.xhr;
    const XHR = pageWindow()?.XMLHttpRequest;
    if (!xo || !XHR) {
      reject(new Error('no xhr'));
      return;
    }
    const xhr: XMLHttpRequest = new XHR();
    xo.open.apply(xhr, [t.req.method, url.href, true]);
    xhr.withCredentials = true;
    xhr.timeout = REPLAY_TIMEOUT_MS;
    for (const [k, v] of Object.entries(t.headers)) if (!SKIP_HEADERS.test(k)) xo.setHeader.apply(xhr, [k, v]);
    xhr.onload = () => {
      let rate: string | null = null;
      try {
        rate = xhr.getResponseHeader('x-rate-limit-remaining');
      } catch {
        /* not exposed */
      }
      resolve({ status: xhr.status, text: typeof xhr.responseText === 'string' ? xhr.responseText : '', rate });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xo.send.apply(xhr, [body]);
  });
}

/**
 * Run `kql` in the background by replaying the page's last querying request
 * (#27). The outcome is handed to the store (case, report) like a capture,
 * and returned so the panel can show it. Never throws.
 */
export async function replayQuery(platform: PlatformId, kql: string): Promise<ReplayResult> {
  const availability = replayAvailability(platform);
  if (availability !== 'ok') return { ok: false, reason: availability };
  const t = replayTemplates.get(platform);
  if (!t?.profile.buildReplay) return { ok: false, reason: 'no-template' };
  let built: { url: URL; body: unknown } | null = null;
  try {
    built = t.profile.buildReplay(t.req, kql);
  } catch {
    built = null;
  }
  if (!built) return { ok: false, reason: 'build' };
  const startedAt = Date.now();
  let res: { status: number; text: string; rate: string | null };
  try {
    res = await sendOriginal(t, built.url, JSON.stringify(built.body));
  } catch (err) {
    log.warn('capture: background query failed (network)', { platform, error: err instanceof Error ? err.message : 'error' });
    return { ok: false, reason: 'network' };
  }
  rememberRateLimit(platform, res.rate);
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
  const req: CaptureRequest = { url: built.url, method: t.req.method, body: built.body };
  let result: ParsedResult | null = null;
  try {
    result = t.profile.parseResponse(safeJsonParse(res.text), req);
  } catch {
    result = null;
  }
  if (!result) return { ok: false, reason: res.status >= 400 ? 'http' : 'parse', status: res.status };
  let query: CaptureOutcome['query'] = null;
  try {
    query = t.profile.extractQuery(req);
  } catch {
    query = null;
  }
  const outcome: CaptureOutcome = {
    profile: t.profile, transport: t.transport, status: res.status, query, result, startedAt,
    durationMs: Math.max(0, Date.now() - startedAt), id: newRunId(),
  };
  try {
    resultHandler(outcome);
  } catch (err) {
    log.error('capture: background outcome handler threw', err);
  }
  log.info('capture: background query done', { platform, status: res.status, rows: result.rows.length, error: !!result.error });
  return { ok: true, outcome };
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
      rememberLastCapture(profile.platform, id, result, query?.kql);
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
