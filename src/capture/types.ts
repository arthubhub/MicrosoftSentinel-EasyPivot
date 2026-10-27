import type { PlatformId } from '../types.ts';

// ── Capture contracts (N1 "Capture des requêtes et résultats") ──
//
// Colocated with the capture module rather than in `src/types.ts`: these
// types have no coupling to PlatformAdapter or any other shared interface -
// they are a private contract between interceptor.ts (generic patch) and
// the per-platform profiles (src/capture/profiles/*.ts, store.ts,
// summary.ts). `src/types.ts` stays reserved for types that cross that
// boundary (PlatformAdapter, CellContext, …), matching the existing pattern
// of `core/ti-links.ts` keeping its own `TiProvider` type next to its logic.

/** One intercepted request, as seen by `match()`, `extractQuery()` and `parseResponse()`. */
export interface CaptureRequest {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
}

/**
 * Recognizes one platform's query-execution request and parses its
 * response. `interceptor.ts` owns the generic XHR/fetch patch and has no
 * platform knowledge itself: it only calls into whichever registered
 * profile answers `match()` truthfully. Profiles are deliberately dumb
 * (match / extract / parse, no side effects) so a bug in the generic patch
 * (phase 4a) can never be confused with a bug in a profile's parsing
 * (phase 4b).
 *
 * N1 writes these as `extractQuery(body)` and `parseResponse(body)` - no
 * `req`. That signature is under-specified for N1's OWN data: Sentinel's
 * `timespan` is a URL query parameter (not in the body `extractQuery`
 * would otherwise receive), and its truncation test needs the REQUEST's
 * `maxRows` while looking at the RESPONSE's row count - two different
 * objects with no shared reference once `parseResponse` only takes one of
 * them. `extractQuery` and `parseResponse` both take the full
 * `CaptureRequest` here as a deliberate, documented widening of N1's
 * signature, not a reading error: do not "fix" it back to `(body)`. See
 * `src/capture/profiles/sentinel.ts`'s file header for why the alternative
 * (threading state through module-level variables keyed by call order)
 * was rejected - it depends on `extractQuery`/`parseResponse` never having
 * an `await` between them in `interceptor.ts`, an invariant phase 4c's
 * async tenant-key lookup (`core/tenant.ts`) is expected to break.
 */
export interface CaptureProfile {
  readonly platform: PlatformId;
  /** Is this request a query execution? */
  match(req: CaptureRequest): boolean;
  extractQuery(
    req: CaptureRequest,
  ): { readonly kql: string; readonly timespan?: string; readonly tenantKey?: string } | null;
  /** `responseBody` is the parsed response; `req` is the matching request (for `maxRows`, `timespan`, …). */
  parseResponse(responseBody: unknown, req: CaptureRequest): ParsedResult | null;
}

export interface ParsedResult {
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    /** Defender's declared entity type for this column (N1 "Type d'entité par colonne") */
    readonly entity?: string;
  }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly error?: string;
  /** Tables the query actually read (`dataSources[].tables` / `DataSources[].Tables`) */
  readonly sourceTables: readonly string[];
  /** `statistics.query.queryHash` / `EnhancedQueryStats.Statistics.QueryHash` */
  readonly queryHash?: string;
  /** Truncation/other warning text (e.g. Defender's `Warning.WarningMessage`) */
  readonly warning?: string;
  readonly timeRange?: { readonly start?: string; readonly end?: string; readonly duration?: string };
}
