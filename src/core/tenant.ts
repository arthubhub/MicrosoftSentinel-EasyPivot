// ── Tenant keys (N2 "Clés de tenant") ──
//
// Pure, hash-only identification of the current workspace/tenant. The
// plaintext resourceId / tid is NEVER stored or exported by this module —
// only the truncated SHA-256 key leaves it (project rule 1). The single
// exception is the phase-5 client registry, where the user types the
// plaintext value herself for her own lookup; that is out of scope here.
//
// `crypto.subtle.digest` is async, so `sentinelKey` / `defenderKey` return
// Promises. This is intentional rather than a limitation to work around:
// there is no synchronous SHA-256 in the browser without a bundled crypto
// library (forbidden — no new dependency), so the honest API is async.
// Callers resolve the key ONCE per page load or per captured request (it is
// stable for the lifetime of that page: a workspace/tenant does not change
// without a navigation) and keep the resolved string from then on; nothing
// downstream — case lookup, storage keys, store.ts's per-tenant buffers —
// needs to thread a Promise through synchronous code.

// Exported for 4g: the health "tenant key" probe (core/health.ts) needs to
// tell "resolved to a real key" from "resolved to absent" without
// duplicating this literal.
export const UNKNOWN_KEY = 'unknown';

/** True for a key that could not be resolved (no resourceId / tid found). */
export function isUnknownTenantKey(key: string): boolean {
  return key === UNKNOWN_KEY;
}

/** Workspace resourceId segment, as it appears in a captured Sentinel request path. */
const SENTINEL_WORKSPACE_PATH =
  /\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+/i;

// ── Hashing ──

/** SHA-256 of `input`, lowercase hex, truncated to 16 characters (N2). */
async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16);
}

function normalizeResourceId(resourceId: string | null | undefined): string | null {
  const trimmed = resourceId?.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip one or more trailing slashes so a path-derived and a
  // hash-derived resourceId for the same workspace hash identically.
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || null;
}

// ── Tenant keys ──

/**
 * `sentinel:` + SHA-256(resourceId) truncated to 16 hex chars. `resourceId`
 * is lower-cased and has its trailing slash removed before hashing.
 * Missing or empty input -> `'unknown'` (N2 point 4): the pivot stays
 * allowed, routed to an "unassigned" case by phase 5.
 */
export async function sentinelKey(resourceId: string | null | undefined): Promise<string> {
  const normalized = normalizeResourceId(resourceId);
  if (!normalized) return UNKNOWN_KEY;
  return `sentinel:${await sha256Hex16(normalized)}`;
}

/**
 * `defender:` + SHA-256(tid) truncated to 16 hex chars. `tid` is lower-cased
 * before hashing. Missing or empty input -> `'unknown'`.
 */
export async function defenderKey(tid: string | null | undefined): Promise<string> {
  const normalized = tid?.trim().toLowerCase();
  if (!normalized) return UNKNOWN_KEY;
  return `defender:${await sha256Hex16(normalized)}`;
}

// ── Extraction helpers ──
//
// Pure: they take a string the caller already read (a request path, an
// iframe URL hash, `location.search`) and never reach for `location`
// themselves, so they stay testable outside a browser and reusable from
// the capture profiles (phase 4b) without duplicating the parsing.

/**
 * Find `key=value` in a query-like string (a `search` string or a URL hash
 * fragment, with or without its leading `?`/`#`) and decodeURIComponent the
 * value. Returns null if the key is absent, empty, or malformed.
 */
function extractParam(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`(?:^|[?&#])${key}=([^&#]*)`));
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded || null;
  } catch {
    return null;
  }
}

/**
 * Sentinel workspace resourceId, read from the path of a captured request
 * (Gabarit: `.../subscriptions/{sub}/resourceGroups/{rg}/providers/
 * Microsoft.OperationalInsights/workspaces/{ws}/query`). Returns the
 * resourceId itself (without the trailing `/query`), or null if the path
 * does not match.
 */
export function extractSentinelResourceIdFromPath(path: string): string | null {
  const match = path.match(SENTINEL_WORKSPACE_PATH);
  return match ? match[0] : null;
}

/**
 * Sentinel workspace resourceId, read from the iframe URL hash before any
 * request has fired (N2 point 1: "le paramètre `resourceId` du hash de
 * l'URL de l'iframe, décodé avec `decodeURIComponent`").
 *
 * The Gabarit confirms a `resourceId` parameter exists in the hash and must
 * be decodeURIComponent'd, but does not record its exact shape. Azure
 * portal blade hashes commonly use either a query-style pair
 * (`resourceId=<value>`) or a path segment (`.../resourceId/<value>/...`);
 * both are supported here rather than assuming one. See the phase-4 report
 * for this open point.
 */
export function extractSentinelResourceIdFromHash(hash: string): string | null {
  const asQueryParam = extractParam(hash, 'resourceId');
  if (asQueryParam) return asQueryParam;

  const match = hash.match(/\/resourceId\/([^/]+)/i);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded || null;
  } catch {
    return null;
  }
}

/**
 * Defender tenant id, read from `location.search` (N2 point 2: "`tid` de
 * `location.search`").
 */
export function extractDefenderTidFromSearch(search: string): string | null {
  return extractParam(search, 'tid');
}
