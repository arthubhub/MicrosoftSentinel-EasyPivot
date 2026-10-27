/**
 * Format-preserving pseudonymisation of captured values (`capture.sanitizeValues`).
 *
 * Capture is on by default for every querying request on the page, and N1 keeps
 * `summary.topValues` for `retention.days` even when the row sample is dropped.
 * That is deliberate - the top values are what make a summary useful for triage
 * - but it means real customer values (UPNs, hostnames, IPs) sit in local
 * storage. This module is the opt-in mitigation: shape in, nonsense out.
 *
 * ── What it does ──
 * A digit becomes another digit, a letter another letter of the same case, and
 * every other character is left alone. So `1.2.3.4` stays dotted-quad shaped,
 * `user@corp.com` keeps its `@` and its dots, and `DC01` stays four characters
 * of the same silhouette. Length and format survive; content does not.
 *
 * ── Why the mapping is CONSISTENT, not per-character random ──
 * The obvious reading of "digits become random" is a fresh random character
 * every time. That would make two identical values sanitise differently, which
 * destroys exactly what the summary is for: `topValues` counts would scatter
 * into singletons, and you could no longer see that one account appears in
 * thirty rows. So the substitution is a fixed table: equal input always gives
 * equal output within a page load, which preserves frequencies, grouping and
 * row-to-row correlation while hiding the content.
 *
 * ── Why the table is regenerated per page load ──
 * It is never persisted. A reload produces a different mapping, so two stored
 * runs from different sessions cannot be lined up against each other, and the
 * table cannot be lifted out of storage to reverse anything. The trade-off is
 * honest: within ONE session this is a substitution cipher, so it resists a
 * casual glance or a screenshot, NOT a determined analyst with frequency
 * tables. It reduces exposure; it is not anonymisation, and nothing here should
 * be treated as safe to publish.
 */

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Fisher-Yates over a copy, using crypto when available. */
function shuffled(alphabet: string): string {
  const chars = [...alphabet];
  const n = chars.length;
  const rand = new Uint32Array(n);
  try {
    crypto.getRandomValues(rand);
  } catch {
    for (let i = 0; i < n; i++) rand[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = n - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── The per-page-load substitution table ──

let table: Map<string, string> | null = null;

function substitution(): Map<string, string> {
  if (table) return table;
  const map = new Map<string, string>();
  for (const [plain, cipher] of [
    [DIGITS, shuffled(DIGITS)],
    [LOWER, shuffled(LOWER)],
    [UPPER, shuffled(UPPER)],
  ] as const) {
    for (let i = 0; i < plain.length; i++) map.set(plain[i], cipher[i]);
  }
  table = map;
  return map;
}

/** Drop the mapping. Only used by tests to make a run reproducible. */
export function resetSanitizer(): void {
  table = null;
}

/**
 * Sanitise one value. Non-strings are returned untouched: a number, a boolean
 * or `null` carries far less than a string does, and rewriting a number would
 * silently corrupt a count the analyst may be reading.
 */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  try {
    const map = substitution();
    let out = '';
    for (const ch of value) out += map.get(ch) ?? ch;
    return out;
  } catch {
    // Never let masking break a capture - but never fall back to the real
    // value either, since the point was to not store it.
    return '';
  }
}

/** Sanitise every cell of a row sample, keeping its shape. */
export function sanitizeRows(
  rows: readonly (readonly unknown[])[],
): readonly (readonly unknown[])[] {
  return rows.map((row) => row.map((cell) => sanitizeValue(cell)));
}

/**
 * Sanitise the KEYS of a `topValues` table, keeping the counts. The counts are
 * the point of the table and reveal nothing on their own; and because the
 * mapping is consistent, two rows that shared a value still share one.
 */
export function sanitizeTopValues(
  topValues: Readonly<Record<string, readonly (readonly [string, number])[]>> | undefined,
): Record<string, [string, number][]> | undefined {
  if (!topValues) return topValues as undefined;
  const out: Record<string, [string, number][]> = {};
  for (const [column, pairs] of Object.entries(topValues)) {
    out[column] = pairs.map(([v, n]): [string, number] => [String(sanitizeValue(v)), n]);
  }
  return out;
}
