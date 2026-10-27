import type { CaptureProfile, CaptureRequest, ParsedResult } from '../types.ts';
import { extractSentinelResourceIdFromPath } from '../../core/tenant.ts';
import { log } from '../../core/log.ts';

/**
 * Sentinel CaptureProfile (N1 "Profils d'après l'étape 0", Gabarit "Format
 * observé"): `POST api.loganalytics.io/v1/subscriptions/{sub}/
 * resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/
 * {ws}/query`, KQL = `body.query`, result = the `tables[]` entry named
 * `PrimaryResult`. Every shape below comes from the 21/10 survey table,
 * never guessed.
 *
 * `extractQuery` and `parseResponse` both take the full `CaptureRequest`
 * (see `capture/types.ts`'s header comment for why that widens N1's
 * `(body)` signature): `timespan` and the workspace resourceId live in the
 * REQUEST URL, and the truncation test needs the REQUEST's `maxRows`
 * while looking at the RESPONSE's row count. With `req` passed to both
 * calls there is no hidden state to keep in sync - every value is read
 * straight from the `req`/`responseBody` each function already has.
 *
 * (An earlier version of this file threaded `maxRows`/`timespan` through a
 * module-level variable set in `extractQuery` and consumed in
 * `parseResponse`, relying on `interceptor.ts` calling the two
 * synchronously with nothing in between. That held only until phase 4c's
 * tenant-key lookup - `core/tenant.ts`'s `sentinelKey`/`defenderKey` are
 * async - got an `await` inserted between them, which would have silently
 * attributed one request's truncation/timeRange to a different,
 * concurrent request. Widening the contract removes the invariant instead
 * of documenting around it.)
 */

// ── Shared helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Match ──

const QUERY_PATH =
  /^\/v1\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+\/query$/i;

function matchSentinel(req: CaptureRequest): boolean {
  if (req.method.toUpperCase() !== 'POST') return false;
  if (req.url.hostname.toLowerCase() !== 'api.loganalytics.io') return false;
  return QUERY_PATH.test(req.url.pathname);
}

// ── Extract query ──

function extractQuerySentinel(
  req: CaptureRequest,
): { readonly kql: string; readonly timespan?: string; readonly tenantKey?: string } | null {
  try {
    const body = req.body;
    if (!isRecord(body) || typeof body.query !== 'string') return null;

    const timespan = req.url.searchParams.get('timespan') ?? undefined;
    const tenantKey = extractSentinelResourceIdFromPath(req.url.pathname) ?? undefined;

    return { kql: body.query, timespan, tenantKey };
  } catch (err) {
    log.error('capture/sentinel: extractQuery() failed', err);
    return null;
  }
}

// ── Parse response ──

/** Deepest `message` found while walking `error.innererror.innererror...` (Gabarit: "le message le plus profond"). */
function deepestErrorMessage(error: Record<string, unknown>): string | undefined {
  let current: unknown = error;
  let deepest: string | undefined;
  while (isRecord(current)) {
    if (typeof current.message === 'string') deepest = current.message;
    current = current.innererror;
  }
  return deepest;
}

function findPrimaryResult(body: Record<string, unknown>): { readonly columns: unknown[]; readonly rows: unknown[] } | null {
  const tables = Array.isArray(body.tables) ? body.tables : [];
  const primary = tables.find((t) => isRecord(t) && t.name === 'PrimaryResult');
  if (!isRecord(primary)) return null;
  return {
    columns: Array.isArray(primary.columns) ? primary.columns : [],
    rows: Array.isArray(primary.rows) ? primary.rows : [],
  };
}

/** `dataSources[].tables`, flattened and deduped; empty for a table-less query (e.g. `range`), never thrown on. */
function extractSourceTables(body: Record<string, unknown>): string[] {
  const dataSources = Array.isArray(body.dataSources) ? body.dataSources : [];
  const tables = dataSources.flatMap((d) => (isRecord(d) && Array.isArray(d.tables) ? d.tables : []));
  return Array.from(new Set(tables.filter((t): t is string => typeof t === 'string')));
}

function extractQueryHash(body: Record<string, unknown>): string | undefined {
  const statistics = body.statistics;
  const query = isRecord(statistics) ? statistics.query : undefined;
  const hash = isRecord(query) ? query.queryHash : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

/** `PT30M` / `P7D` -> `{ duration }`; `<start>/<end>` -> `{ start, end }`; absent -> undefined (range set in the query). */
function parseTimespan(raw: string | undefined): ParsedResult['timeRange'] {
  if (!raw) return undefined;
  if (raw.includes('/')) {
    const [start, end] = raw.split('/');
    return { start: start || undefined, end: end || undefined };
  }
  return { duration: raw };
}

/** `body.maxRows` of the REQUEST that produced this response, or undefined if absent/not a number. */
function requestMaxRows(requestBody: unknown): number | undefined {
  return isRecord(requestBody) && typeof requestBody.maxRows === 'number' ? requestBody.maxRows : undefined;
}

function parseResponseSentinel(body: unknown, req: CaptureRequest): ParsedResult | null {
  try {
    if (!isRecord(body)) return null;

    const sourceTables = extractSourceTables(body);
    const queryHash = extractQueryHash(body);
    const timeRange = parseTimespan(req.url.searchParams.get('timespan') ?? undefined);

    if (isRecord(body.error)) {
      const error = deepestErrorMessage(body.error) ?? 'unknown error';
      log.debug('capture/sentinel: parsed error response', { sourceTables: sourceTables.length });
      return { columns: [], rows: [], truncated: false, error, sourceTables, queryHash, timeRange };
    }

    // `tables[]` may hold several tables (e.g. a secondary render table) -
    // only `PrimaryResult` is the query's actual result (Gabarit). Missing
    // entirely -> best-effort empty result, not an exception.
    const primary = findPrimaryResult(body);
    const columns = (primary?.columns ?? []).map((c) =>
      isRecord(c) ? { name: String(c.name ?? ''), type: String(c.type ?? '') } : { name: '', type: '' },
    );
    const rows = (primary?.rows ?? []).map((r) => (Array.isArray(r) ? r : []));

    // No dedicated truncation flag: inferred from the +1 the REQUEST asked
    // for (Gabarit "pas de clé dédiée : tronqué si rows.length >= maxRows − 1").
    // `req` is this response's own matching request (interceptor.ts passes
    // the same CaptureRequest to extractQuery and parseResponse) - never a
    // different, concurrent request's.
    const maxRows = requestMaxRows(req.body);
    const truncated = typeof maxRows === 'number' && rows.length >= maxRows - 1;

    log.debug('capture/sentinel: parsed', {
      rows: rows.length,
      columns: columns.length,
      sourceTables: sourceTables.length,
      truncated,
      error: false,
    });

    return { columns, rows, truncated, sourceTables, queryHash, timeRange };
  } catch (err) {
    log.error('capture/sentinel: parseResponse() failed', err);
    return null;
  }
}

// ── Profile ──

export const sentinelProfile: CaptureProfile = {
  platform: 'sentinel',
  match: matchSentinel,
  extractQuery: extractQuerySentinel,
  parseResponse: parseResponseSentinel,
};
