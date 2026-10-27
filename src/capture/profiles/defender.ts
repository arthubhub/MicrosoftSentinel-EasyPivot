import type { CaptureProfile, CaptureRequest, ParsedResult } from '../types.ts';
import { extractDefenderTidFromSearch } from '../../core/tenant.ts';
import { log } from '../../core/log.ts';

/**
 * Defender CaptureProfile (N1 "Profils d'après l'étape 0", Gabarit "Format
 * observé"): `POST security.microsoft.com/apiproxy/hunting/
 * huntingQueryExecutorService/queryExecutor/v1/external?useFanOut=false`,
 * KQL = `body.QueryText`, result = `Schema` + `Results`. Every shape below
 * comes from the 21/10 survey table, never guessed.
 *
 * `extractQuery`/`parseResponse` take the full `CaptureRequest` (see
 * `capture/types.ts`'s header for why N1's `(body)` signature is widened
 * here). Unlike Sentinel, Defender's `QueryText`/`StartTime`/`EndTime` all
 * live in the request body `req.body` already carries - nothing is read
 * from `req.url` for those. `req` is still threaded through so
 * `parseResponse` can read `StartTime`/`EndTime` straight from `req.body`
 * instead of a value carried over from the `extractQuery` call, which
 * would reintroduce exactly the kind of call-order-dependent state this
 * widened contract removes (see `sentinel.ts`'s header for the full story).
 *
 * `tenantKey` is the page's `tid` (Gabarit: "`tid` de l'URL de la page").
 * Preferred source: `req.url` - the Defender hunting request is
 * same-origin on `security.microsoft.com`, so if the tenant ever starts
 * appearing in the XHR's own query string this picks it up with no
 * ambient-global read at all. Today's Gabarit survey, however, only
 * records `?useFanOut=false` on this request - `tid` is NOT observed in
 * `req.url`, only in `location.search` (and in headers this profile never
 * reads). So the `req.url` lookup below is a defensive no-op against the
 * current survey, kept for if a future Gabarit update shows otherwise, and
 * `location.search` remains the load-bearing path, guarded by
 * `typeof location !== 'undefined'` so the profile still never throws if
 * it is ever evaluated outside a page (e.g. this phase's fixture tests).
 */

// ── Shared helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Match ──

const QUERY_PATH = '/apiproxy/hunting/huntingQueryExecutorService/queryExecutor/v1/external';

function matchDefender(req: CaptureRequest): boolean {
  if (req.method.toUpperCase() !== 'POST') return false;
  return req.url.pathname === QUERY_PATH;
}

// ── Extract query ──

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** `tid`: tried on the request URL first (same-origin, see file header), then the page URL. */
function readDefenderTid(req: CaptureRequest): string | undefined {
  const fromRequestUrl = extractDefenderTidFromSearch(req.url.search) ?? undefined;
  if (fromRequestUrl) return fromRequestUrl;

  try {
    const pageSearch = typeof location !== 'undefined' ? location.search : '';
    return extractDefenderTidFromSearch(pageSearch) ?? undefined;
  } catch {
    return undefined;
  }
}

function extractQueryDefender(
  req: CaptureRequest,
): { readonly kql: string; readonly timespan?: string; readonly tenantKey?: string } | null {
  try {
    // `QueryText` is duplicated in `EncodedQueryText` (Gabarit), but its
    // encoding is not specified anywhere in the survey - decoding it would
    // be exactly the kind of guess this phase must not make. `QueryText`
    // is preferred per the Gabarit and is the only field read here.
    const body = req.body;
    if (!isRecord(body) || typeof body.QueryText !== 'string') return null;

    return { kql: normalizeLineEndings(body.QueryText), tenantKey: readDefenderTid(req) };
  } catch (err) {
    log.error('capture/defender: extractQuery() failed', err);
    return null;
  }
}

// ── Parse response ──

/** `EnhancedQueryStats.DataSources[].Tables`, flattened and deduped (`ResourceId` is `Xdr` for Defender tables). */
function extractSourceTables(body: Record<string, unknown>): string[] {
  const stats = body.EnhancedQueryStats;
  const dataSources = isRecord(stats) && Array.isArray(stats.DataSources) ? stats.DataSources : [];
  const tables = dataSources.flatMap((d) => (isRecord(d) && Array.isArray(d.Tables) ? d.Tables : []));
  return Array.from(new Set(tables.filter((t): t is string => typeof t === 'string')));
}

function extractQueryHash(body: Record<string, unknown>): string | undefined {
  const stats = body.EnhancedQueryStats;
  const statistics = isRecord(stats) ? stats.Statistics : undefined;
  const hash = isRecord(statistics) ? statistics.QueryHash : undefined;
  return typeof hash === 'string' ? hash : undefined;
}

/** `StartTime`/`EndTime` of the REQUEST that produced this response; `StartTime: null` means "range set in the query". */
function buildTimeRange(requestBody: unknown): ParsedResult['timeRange'] {
  if (!isRecord(requestBody)) return undefined;
  const startTime = typeof requestBody.StartTime === 'string' ? requestBody.StartTime : undefined;
  const endTime = typeof requestBody.EndTime === 'string' ? requestBody.EndTime : undefined;
  if (startTime === undefined && endTime === undefined) return undefined;
  return { start: startTime, end: endTime };
}

function parseResponseDefender(body: unknown, req: CaptureRequest): ParsedResult | null {
  try {
    if (!isRecord(body)) return null;

    const sourceTables = extractSourceTables(body);
    const queryHash = extractQueryHash(body);
    // `req` is this response's own matching request (interceptor.ts passes
    // the same CaptureRequest to extractQuery and parseResponse) - never a
    // different, concurrent request's.
    const timeRange = buildTimeRange(req.body);

    if (typeof body.ErrorMessage === 'string' || typeof body.ErrorCode === 'string') {
      const error = typeof body.ErrorMessage === 'string' ? body.ErrorMessage : body.ErrorCode;
      log.debug('capture/defender: parsed error response', { sourceTables: sourceTables.length });
      return { columns: [], rows: [], truncated: false, error: error as string, sourceTables, queryHash, timeRange };
    }

    const schema = Array.isArray(body.Schema) ? body.Schema : [];
    const columns = schema.map((c) =>
      isRecord(c)
        ? { name: String(c.Name ?? ''), type: String(c.Type ?? ''), entity: typeof c.Entity === 'string' ? c.Entity : undefined }
        : { name: '', type: '' },
    );

    const results = Array.isArray(body.Results) ? body.Results : [];
    // Build each row by column NAME, not by object key order: a Results[]
    // entry missing one column must leave a hole in that exact position,
    // never shift the remaining values into the wrong column.
    const rows = results.map((row) => columns.map((col) => (isRecord(row) ? row[col.name] : undefined)));

    const warning = isRecord(body.Warning) ? body.Warning : undefined;
    const truncated = warning?.WarningCode === 3;
    const warningMessage = typeof warning?.WarningMessage === 'string' ? warning.WarningMessage : undefined;

    log.debug('capture/defender: parsed', {
      rows: rows.length,
      columns: columns.length,
      sourceTables: sourceTables.length,
      truncated,
      error: false,
    });

    return { columns, rows, truncated, warning: warningMessage, sourceTables, queryHash, timeRange };
  } catch (err) {
    log.error('capture/defender: parseResponse() failed', err);
    return null;
  }
}

// ── Profile ──

export const defenderProfile: CaptureProfile = {
  platform: 'defender',
  match: matchDefender,
  extractQuery: extractQueryDefender,
  parseResponse: parseResponseDefender,
};
