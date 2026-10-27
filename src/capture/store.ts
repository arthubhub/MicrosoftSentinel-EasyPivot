import type { PlatformId } from '../types.ts';
import type { ParsedColumn, QueryRun, RunSummary, TenantKey } from '../types.ts';
import type { CaptureOutcome } from './interceptor.ts';
import { CAPTURE_STORE, STORAGE_KEYS } from '../config.ts';
import { getSettings } from '../core/settings.ts';
import { getJson, setJson } from '../core/storage.ts';
import { sentinelKey, defenderKey } from '../core/tenant.ts';
import { log } from '../core/log.ts';
import { summarizeRun } from './summary.ts';
import { sanitizeRows, sanitizeTopValues } from './sanitize.ts';

/**
 * `QueryRun` store (N1 "Rétention et masquage"). Driven entirely by
 * `capture/interceptor.ts`'s result handler - `addRun()` is the only entry
 * point that creates a run, and it is never allowed to throw into the page
 * (project rule: capture is all `try/catch`).
 *
 * Storage: `shq_runs_<tenantKey>`, a circular buffer of the 50 most recent
 * `QueryRun`s. **Provisional**: the Annexes mark this key "avant l'arrivée
 * des cas (phase 4), migrés en phase 5" - phase 5's `core/cases.ts` will
 * move these into `shq_case_<id>` and this module's buffer becomes history.
 *
 * `caseId` placeholder: `UNASSIGNED_CASE_ID` ('unassigned'), matching the
 * convention `core/tenant.ts` already uses for an unresolved tenant
 * ('unknown') and N2's own wording ("routé vers un cas 'non assigné'").
 * No `Case` type exists yet; every run gets this same literal until phase
 * 5's migration assigns real case ids.
 *
 * `core/storage.ts` is the only storage dependency (project constraint);
 * every write goes through `safeSetJson` below so a full quota
 * (`GM_setValue` throwing) can never reach the interceptor's callback.
 */

// ── Placeholder case id (phase 5 migrates this away) ──

export const UNASSIGNED_CASE_ID = 'unassigned';

// ── Storage helpers (never throw - see file header) ──

function runsKey(tenantKey: TenantKey): string {
  return `${STORAGE_KEYS.RUNS_PREFIX}${tenantKey}`;
}

function safeSetJson(key: string, value: unknown): boolean {
  try {
    setJson(key, value);
    return true;
  } catch (err) {
    // GM_setValue can throw on a full quota - the page must survive it
    // (N1 acceptance: capture never breaks the host page).
    log.error(`capture/store: GM_setValue('${key}') failed (storage full?), write dropped`, err);
    return false;
  }
}

function readIndex(): TenantKey[] {
  const list = getJson<TenantKey[]>(STORAGE_KEYS.RUNS_INDEX, []);
  return Array.isArray(list) ? list : [];
}

function rememberTenantKey(tenantKey: TenantKey): void {
  const index = readIndex();
  if (index.includes(tenantKey)) return;
  safeSetJson(STORAGE_KEYS.RUNS_INDEX, [...index, tenantKey]);
}

/** Every tenant key that currently has (or had) a `shq_runs_<tenantKey>` entry. */
export function getKnownTenantKeys(): readonly TenantKey[] {
  return readIndex();
}

function readRuns(tenantKey: TenantKey): QueryRun[] {
  const list = getJson<QueryRun[]>(runsKey(tenantKey), []);
  return Array.isArray(list) ? list : [];
}

function writeRuns(tenantKey: TenantKey, runs: readonly QueryRun[]): void {
  safeSetJson(runsKey(tenantKey), runs);
}

/** All runs for one tenant, most recent first. */
export function getRuns(tenantKey: TenantKey): readonly QueryRun[] {
  return readRuns(tenantKey);
}

// ── IDs ──

/**
 * Exported so `capture/interceptor.ts` can generate a `QueryRun` id
 * SYNCHRONOUSLY at match time (4e) - the in-memory row cache it fills right
 * away and the `QueryRun` `addRun()` below eventually persists (async,
 * after tenant-key hashing) must agree on the same id.
 */
export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── KQL hashing (SHA-256, duplicated from core/tenant.ts's one-liner) ──
//
// `core/tenant.ts` already computes SHA-256 (`sha256Hex16`, truncated to 16
// hex chars for tenant keys) but does not export it, and this phase's
// constraints keep `core/tenant.ts` off-limits to edits. `computeKqlHash`
// below is the same `crypto.subtle.digest('SHA-256', …)` one-liner, kept
// FULL length (64 hex chars, not truncated to 16) since it is used for
// exact-match pivot correlation, not as a storage-key fragment. Exported so
// phase 4f's `pendingRun` registration (see below) can hash the KQL the
// SAME way right after `fillQuery()` produces it.

export async function computeKqlHash(kql: string): Promise<string> {
  const normalized = normalizeKqlForHash(kql);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Line-ending + outer-whitespace normalization, nothing more (no reformatting guess). */
function normalizeKqlForHash(kql: string): string {
  return kql.replace(/\r\n/g, '\n').trim();
}

async function resolveTenantKey(platform: PlatformId, rawTenantKey: string | undefined): Promise<TenantKey> {
  return platform === 'sentinel' ? sentinelKey(rawTenantKey) : defenderKey(rawTenantKey);
}

// ── 4g: last resolved tenant key (session-only), for the synchronous health probe ──
//
// `sentinelKey`/`defenderKey` are async (crypto.subtle); core/health.ts's
// probes are not. `addRun()` below already resolves a `TenantKey` for every
// captured request, so the probe reads the most recent one here instead of
// awaiting its own. Never persisted (no storage key) and `null` until the
// first request is captured - that "not yet known" state is distinct from
// `UNKNOWN_KEY` ("resolved, but no resourceId/tid found").
let lastResolvedTenantKey: TenantKey | null = null;

/** The TenantKey `addRun()` last resolved, or `null` if none has run yet (this load). */
export function getLastResolvedTenantKey(): TenantKey | null {
  return lastResolvedTenantKey;
}

// ── Pivot linkage: `// [RULE-ID]` header + W2's `pendingRun` ──
//
// N1: "le KQL capturé commence par `// [RULE-ID]` ajouté par `fillQuery`".
// Confirmed against the real rule templates (`rules/pivot-rules.json`):
// every rule's `query`/`queryDefender` DOES start with a line of the exact
// shape `// [IP-S0] <description>`, and `fillQuery()` (core/pivot.ts) keeps
// `//`-prefixed lines verbatim - so the header survives into the editor and
// into whatever the page sends. Same convention `core/investigation.ts`'s
// private `ORIGIN_RE` already relies on (`/^\/\/ \[([A-Za-z0-9_-]+)\]/gm`,
// there scanning for the LAST header in multi-query editor text); here only
// the FIRST line of a single captured query is read, so the regex below
// takes the first match, not the last - not imported from there, since
// that regex is private and shaped for a different (multi-query) input.
const RULE_ID_HEADER = /^\/\/ \[([A-Za-z0-9_-]+)\]/;

function parseRuleIdHeader(kql: string): string | undefined {
  const firstLine = kql.split('\n').find((l) => l.trim() !== '');
  if (!firstLine) return undefined;
  return RULE_ID_HEADER.exec(firstLine.trim())?.[1];
}

/**
 * What W2 point 8 is supposed to register right after `injectQuery()`:
 * "enregistrer un `pendingRun { ruleId, snapshotId, kqlHash }` pour relier
 * le prochain résultat capturé au pivot". **Not found anywhere in the
 * codebase** (`grep -rn pendingRun src/` is empty) - W2 point 8 itself is
 * phase 4f, explicitly out of scope here. This registry is the matching
 * HALF of that feature: `registerPendingRun()` is ready for 4f to call
 * (with a `kqlHash` computed via `computeKqlHash()` on the exact text
 * `fillQuery()` produced, before injection), and `addRun()` below already
 * consumes it. Until 4f exists, `pendingRun` just stays `null` forever and
 * every run falls back to header-only linkage (still correct per N1 - see
 * `addRun`'s `isPivotOriginated`).
 */
export interface PendingRun {
  readonly ruleId: string;
  readonly snapshotId: string;
  readonly kqlHash: string;
}

interface PendingRunEntry extends PendingRun {
  readonly registeredAt: number;
}

let pendingRun: PendingRunEntry | null = null;

export function registerPendingRun(pending: PendingRun): void {
  pendingRun = { ...pending, registeredAt: Date.now() };
  log.debug('capture/store: pendingRun registered', { ruleId: pending.ruleId, snapshotId: pending.snapshotId });
}

interface Attachment {
  readonly ruleId?: string;
  readonly snapshotId?: string;
}

/** Consumes `pendingRun` on an exact `kqlHash` match (single-use); falls back to the header alone otherwise. */
function tryAttachPendingRun(headerRuleId: string | undefined, kqlHash: string): Attachment {
  if (!pendingRun) return { ruleId: headerRuleId };

  const age = Date.now() - pendingRun.registeredAt;
  if (age > CAPTURE_STORE.PENDING_RUN_TTL_MS) {
    log.debug('capture/store: pendingRun expired, dropping it unmatched', { ruleId: pendingRun.ruleId, ageMs: age });
    pendingRun = null;
    return { ruleId: headerRuleId };
  }

  if (pendingRun.kqlHash === kqlHash) {
    const matched = pendingRun;
    pendingRun = null; // consumed - a pivot's result links to exactly one run
    log.info('capture/store: QueryRun linked to pending pivot', {
      ruleId: matched.ruleId,
      snapshotId: matched.snapshotId,
    });
    return { ruleId: matched.ruleId, snapshotId: matched.snapshotId };
  }

  // A different query ran while a pivot was pending - leave pendingRun in
  // place (it may still match a later request) and fall back to the header.
  return { ruleId: headerRuleId };
}

// ── Sample building (N1 "Rétention et masquage") ──

function isDynamicType(type: string | undefined): boolean {
  return typeof type === 'string' && /^(dynamic|object)$/i.test(type);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** One cell, sample rules: dynamic/object -> truncated string; string -> truncated; else kept as-is. */
function sampleCell(value: unknown, columnType: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (isDynamicType(columnType)) return truncate(safeStringify(value), CAPTURE_STORE.MAX_SAMPLE_CELL_CHARS);
  if (typeof value === 'string') return truncate(value, CAPTURE_STORE.MAX_SAMPLE_CELL_CHARS);
  return value;
}

function buildSample(
  columns: readonly ParsedColumn[],
  rows: readonly (readonly unknown[])[],
  maxRows: number,
): readonly (readonly unknown[])[] {
  return rows.slice(0, Math.max(0, maxRows)).map((row) => row.map((cell, i) => sampleCell(cell, columns[i]?.type)));
}

// ── addRun: the interceptor's result handler calls this for every match ──

/**
 * Turn a matched capture outcome into a stored `QueryRun`. Never throws
 * (project rule: capture is all `try/catch`) - a failure here is logged and
 * swallowed, `null` is returned, and the page never notices.
 */
export async function addRun(outcome: CaptureOutcome): Promise<QueryRun | null> {
  try {
    const { result, query, profile, startedAt, durationMs, id } = outcome;
    if (!result) {
      log.debug('capture/store: no ParsedResult on this outcome, nothing to store');
      return null;
    }

    const kql = query?.kql ?? '';
    const [tenantKey, kqlHash] = await Promise.all([
      resolveTenantKey(profile.platform, query?.tenantKey),
      computeKqlHash(kql),
    ]);
    lastResolvedTenantKey = tenantKey; // 4g: see getLastResolvedTenantKey()'s doc comment

    const headerRuleId = parseRuleIdHeader(kql);
    const attach = tryAttachPendingRun(headerRuleId, kqlHash);
    // N1 "l'échantillon n'est conservé que pour les requêtes EasyPivot" - a
    // `// [RULE-ID]` header alone (even without a pendingRun match, e.g.
    // because phase 4f does not exist yet) already means this KQL came
    // from `fillQuery()`, i.e. is EasyPivot-originated.
    const isPivotOriginated = headerRuleId !== undefined;

    const settings = getSettings();
    // Pinning (N1 "ou si l'utilisateur épingle le résultat") has no API yet
    // - `PivotSnapshot.pinnedRows` is phase 5 (Annexes). Only the two
    // implementable conditions are checked here.
    const keepSample = isPivotOriginated || settings.capture.keepSampleForManual;

    // `capture.sanitizeValues`: mask BEFORE the run is persisted, never at
    // display time - the point is that the real values never reach storage.
    // Applied to both value-bearing fields: the row sample and the summary's
    // topValues keys. Counts, row totals, dates and column names are untouched.
    const sanitize = settings.capture.sanitizeValues;
    const rawSummary: RunSummary = summarizeRun(result.columns, result.rows);
    const summary: RunSummary = sanitize
      ? { ...rawSummary, topValues: sanitizeTopValues(rawSummary.topValues) }
      : rawSummary;
    const status: QueryRun['status'] = result.error ? 'error' : result.truncated ? 'truncated' : 'ok';
    const now = Date.now();

    const run: QueryRun = {
      // 4e: reuses the id `interceptor.ts` already generated at match time
      // (and already used for the in-memory row cache), not a fresh one -
      // see `CaptureOutcome.id`'s doc comment.
      id,
      caseId: UNASSIGNED_CASE_ID,
      tenantKey,
      platform: profile.platform,
      kqlHash,
      kqlPreview: kql.slice(0, CAPTURE_STORE.KQL_PREVIEW_CHARS),
      ruleId: attach.ruleId,
      snapshotId: attach.snapshotId,
      startedAt,
      durationMs,
      status,
      error: result.error,
      rowCount: result.rows.length,
      columns: result.columns,
      sourceTables: result.sourceTables,
      summary,
      rowsSample: keepSample
        ? (() => {
            const sample = buildSample(result.columns, result.rows, settings.capture.maxRowsSample);
            return sanitize ? sanitizeRows(sample) : sample;
          })()
        : undefined,
      lastAccessAt: now,
    };

    // "Logger la forme d'un run stocké" (hard constraint 5) - shape only,
    // no cell value, no KQL text beyond the already-bounded preview.
    log.info('capture/store: storing QueryRun', {
      id: run.id,
      tenantKey: run.tenantKey,
      platform: run.platform,
      status: run.status,
      rowCount: run.rowCount,
      columns: run.columns.length,
      ruleId: run.ruleId ?? null,
      snapshotId: run.snapshotId ?? null,
      sampleKept: run.rowsSample !== undefined,
      sampleRows: run.rowsSample?.length ?? 0,
    });

    pushRun(tenantKey, run);
    return run;
  } catch (err) {
    log.error('capture/store: addRun() failed, run not stored', err);
    return null;
  }
}

function pushRun(tenantKey: TenantKey, run: QueryRun): void {
  const existing = readRuns(tenantKey);
  const next = [run, ...existing];
  const overflow = next.length - CAPTURE_STORE.MAX_RUNS_PER_TENANT;
  const kept = overflow > 0 ? next.slice(0, CAPTURE_STORE.MAX_RUNS_PER_TENANT) : next;
  if (overflow > 0) {
    log.info(`capture/store: tenant buffer at ${CAPTURE_STORE.MAX_RUNS_PER_TENANT}, dropping ${overflow} oldest run(s)`, {
      tenantKey,
    });
  }
  rememberTenantKey(tenantKey);
  writeRuns(tenantKey, kept);
}

// ── Retention and purge (N1 "Rétention et masquage") ──

export type PurgeScope = 'all' | TenantKey;

export interface PurgeReport {
  readonly tenantsVisited: number;
  readonly samplesDroppedByAge: number;
  readonly samplesDroppedByBytes: number;
  readonly runsDroppedByBytes: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

function msPerDay(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/** Drop `rowsSample` on every run whose `lastAccessAt` is older than `retention.days`. `days = 0` -> every sample. */
function purgeSamplesByAge(runs: readonly QueryRun[], retentionDays: number, now: number): { runs: QueryRun[]; dropped: number } {
  const thresholdMs = msPerDay(retentionDays);
  let dropped = 0;
  const next = runs.map((r) => {
    if (r.rowsSample === undefined) return r;
    const age = now - r.lastAccessAt;
    if (age >= thresholdMs) {
      dropped++;
      log.info('capture/store: purge - dropping sample (age)', {
        id: r.id,
        ruleId: r.ruleId ?? null,
        ageMs: age,
        thresholdMs,
      });
      return { ...r, rowsSample: undefined };
    }
    return r;
  });
  return { runs: next, dropped };
}

function estimateBytes(runs: readonly QueryRun[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(runs)).length;
  } catch {
    return 0;
  }
}

/**
 * Global cap: drop the oldest SAMPLES first (across every known tenant),
 * then the oldest runs NOT LINKED to a pivot, until under `maxBytes` or
 * there is nothing left that is safe to drop (project rule: a pivot-linked
 * run's sample/run itself is never evicted by the byte cap alone).
 */
function purgeByMaxBytes(
  tenants: Map<TenantKey, QueryRun[]>,
  maxBytes: number,
): { samplesDropped: number; runsDropped: number; changed: Set<TenantKey> } {
  const changed = new Set<TenantKey>();
  let samplesDropped = 0;
  let runsDropped = 0;

  const totalBytes = (): number => [...tenants.values()].reduce((sum, runs) => sum + estimateBytes(runs), 0);

  // Pass 1: oldest samples first, anywhere.
  while (totalBytes() > maxBytes) {
    let oldest: { tenantKey: TenantKey; index: number; lastAccessAt: number } | null = null;
    for (const [tenantKey, runs] of tenants) {
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].rowsSample === undefined) continue;
        if (!oldest || runs[i].lastAccessAt < oldest.lastAccessAt) oldest = { tenantKey, index: i, lastAccessAt: runs[i].lastAccessAt };
      }
    }
    if (!oldest) break;
    const runs = tenants.get(oldest.tenantKey);
    if (!runs) break;
    const victim = runs[oldest.index];
    log.info('capture/store: purge - dropping sample (maxBytes)', { id: victim.id, tenantKey: oldest.tenantKey });
    runs[oldest.index] = { ...victim, rowsSample: undefined };
    changed.add(oldest.tenantKey);
    samplesDropped++;
  }

  // Pass 2: oldest unlinked runs (no ruleId), anywhere.
  while (totalBytes() > maxBytes) {
    let oldest: { tenantKey: TenantKey; index: number; lastAccessAt: number } | null = null;
    for (const [tenantKey, runs] of tenants) {
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].ruleId !== undefined) continue; // never evict a pivot-linked run here
        if (!oldest || runs[i].lastAccessAt < oldest.lastAccessAt) oldest = { tenantKey, index: i, lastAccessAt: runs[i].lastAccessAt };
      }
    }
    if (!oldest) {
      log.warn('capture/store: purge - still over maxBytes but nothing left is safe to drop (all runs pivot-linked)');
      break;
    }
    const runs = tenants.get(oldest.tenantKey);
    if (!runs) break;
    const victim = runs[oldest.index];
    log.info('capture/store: purge - dropping unlinked QueryRun (maxBytes)', { id: victim.id, tenantKey: oldest.tenantKey });
    runs.splice(oldest.index, 1);
    changed.add(oldest.tenantKey);
    runsDropped++;
  }

  return { samplesDropped, runsDropped, changed };
}

/**
 * Run retention now. `scope: 'all'` (used by the scheduler and the "purge
 * everything" button) runs the age-based sweep over every known tenant;
 * a specific `TenantKey` (the "purge current tenant" button) scopes the
 * age-based sweep to it. `maxBytes` is a GLOBAL cap either way (N1: "plafond
 * global") so it always sweeps every known tenant, regardless of `scope`.
 */
export function purgeNow(scope: PurgeScope): PurgeReport {
  const settings = getSettings();
  const now = Date.now();
  const allKeys = getKnownTenantKeys();
  const ageSweepKeys = scope === 'all' ? allKeys : [scope];

  const bytesBefore = allKeys.reduce((sum, k) => sum + estimateBytes(readRuns(k)), 0);

  let samplesDroppedByAge = 0;
  for (const tenantKey of ageSweepKeys) {
    const runs = readRuns(tenantKey);
    if (runs.length === 0) continue;
    const { runs: next, dropped } = purgeSamplesByAge(runs, settings.retention.days, now);
    if (dropped > 0) writeRuns(tenantKey, next);
    samplesDroppedByAge += dropped;
  }

  // retention.closedDays (purge a CLOSED case's samples after 7 days) has
  // no code path: it is defined against `Case.closedAt`, and cases do not
  // exist until phase 5's `core/cases.ts`. Nothing to do here - documented,
  // not faked.

  const tenantsMap = new Map<TenantKey, QueryRun[]>(allKeys.map((k) => [k, readRuns(k)] as const));
  const { samplesDropped: samplesDroppedByBytes, runsDropped: runsDroppedByBytes, changed } = purgeByMaxBytes(
    tenantsMap,
    settings.retention.maxBytes,
  );
  for (const tenantKey of changed) {
    const runs = tenantsMap.get(tenantKey);
    if (runs) writeRuns(tenantKey, runs);
  }

  const bytesAfter = allKeys.reduce((sum, k) => sum + estimateBytes(readRuns(k)), 0);

  const report: PurgeReport = {
    tenantsVisited: ageSweepKeys.length,
    samplesDroppedByAge,
    samplesDroppedByBytes,
    runsDroppedByBytes,
    bytesBefore,
    bytesAfter,
  };
  log.info('capture/store: purge complete', { scope, ...report });
  return report;
}

/** Rough JSON-length size, current tenant (`scope`) or everything (`'all'`) - for a size indicator UI. */
export function estimateStoreBytes(scope: PurgeScope): number {
  const keys = scope === 'all' ? getKnownTenantKeys() : [scope];
  return keys.reduce((sum, k) => sum + estimateBytes(readRuns(k)), 0);
}

let schedulerStarted = false;

/**
 * Purge once at startup, then every `CAPTURE_STORE.RETENTION_PURGE_INTERVAL_MS`
 * (N1 "purge au démarrage et une fois par heure"). Idempotent per page load.
 */
export function startRetentionScheduler(): void {
  if (schedulerStarted) {
    log.debug('capture/store: startRetentionScheduler() called again, already running - ignored');
    return;
  }
  schedulerStarted = true;

  try {
    log.step('capture/store: startup purge', () => purgeNow('all'));
  } catch (err) {
    log.error('capture/store: startup purge failed', err);
  }

  setInterval(() => {
    try {
      log.step('capture/store: hourly purge', () => purgeNow('all'));
    } catch (err) {
      log.error('capture/store: hourly purge failed', err);
    }
  }, CAPTURE_STORE.RETENTION_PURGE_INTERVAL_MS);
}
