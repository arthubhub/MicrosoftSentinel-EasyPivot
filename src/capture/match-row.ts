import { PIVOT } from '../config.ts';
import { log } from '../core/log.ts';
import type { CapturedRowSet } from './interceptor.ts';

/**
 * Tier 1 of W2 step 2 (#14): match a DOM-read row against the last captured
 * `QueryRun`'s raw rows. Pure (no DOM, no storage) so it can be checked by
 * hand - takes `CapturedRowSet` (interceptor.ts's in-memory cache) and the
 * DOM row as plain data.
 *
 * ── Why a partial, exact match - never a fuzzy one ──
 * The grid shows formatted/possibly-truncated text; the capture holds raw
 * platform values. Byte-for-byte equality on EVERY column would almost
 * never fire. So the match is partial in WHICH columns it requires (only
 * the "trustworthy" ones - present on both sides, not dynamic/object, not
 * an ignored column), but exact and ALL-OF within that subset - no column
 * is allowed to merely "look close". A wrong row handed to `fillQuery()` is
 * worse than no row (the analyst would never know T0/HOST were wrong), so
 * this function refuses rather than guesses in three situations:
 *   1. fewer than `MIN_TRUSTED_COLUMNS` shared trustworthy columns exist -
 *      a single column (even TimeGenerated) is not enough: many rows
 *      commonly share one timestamp, so a one-column "match" is a
 *      coincidence, not an identification;
 *   2. no captured row agrees on all of them;
 *   3. two or more captured rows agree equally (ambiguous tie) - treated
 *      exactly like "no match", never "pick the first one".
 */

/** Below this many shared, trustworthy columns, tier 1 is not even attempted. */
const MIN_TRUSTED_COLUMNS = 2;

function isDynamicType(type: string | undefined): boolean {
  return typeof type === 'string' && /^(dynamic|object)$/i.test(type);
}

/** `value` -> what `CellContext.row` expects: a plain, displayable string. */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Exact after light formatting normalisation only (trim, strip `,`
 * thousands separators some grids render for numeric columns) - still ALL
 * (not fuzzy/partial credit) once compared.
 */
function scalarEquals(domText: string, raw: unknown): boolean {
  const domNorm = domText.trim();
  if (raw === null || raw === undefined) return domNorm === '';
  const rawStr = stringifyCell(raw).trim();
  if (domNorm === rawStr) return true;
  return domNorm.replace(/,/g, '') === rawStr.replace(/,/g, '');
}

export interface RowMatch {
  /** The FULL captured row, every column the query returned (not just the DOM-visible ones). */
  readonly row: Readonly<Record<string, string>>;
  readonly runId: string;
}

/**
 * `domRow`: the partial row already read from the DOM (column -> displayed
 * text). `captured`: the in-memory cache entry for this platform, or
 * `null` (capture disabled / nothing captured yet / cache cleared on
 * teardown) - in which case this immediately returns `null`, so callers
 * can call it unconditionally without their own null-check.
 */
export function matchCapturedRow(
  domRow: Readonly<Record<string, string>>,
  captured: CapturedRowSet | null,
): RowMatch | null {
  if (!captured || captured.rows.length === 0) return null;

  try {
    const ignored = PIVOT.IGNORED_COLUMNS as readonly string[];
    const typeByName = new Map<string, string>(captured.columns.map((c) => [c.name, c.type]));

    const trustedColumns = Object.keys(domRow).filter((col) => {
      if (!domRow[col]) return false; // empty DOM cell carries no signal
      if (ignored.includes(col)) return false;
      const type = typeByName.get(col);
      if (type === undefined) return false; // the capture never saw this column at all
      if (isDynamicType(type)) return false; // JSON stringifies differently on each side
      return true;
    });

    if (trustedColumns.length < MIN_TRUSTED_COLUMNS) {
      log.debug('capture: tier 1 skipped - not enough trustworthy shared columns', {
        shared: trustedColumns.length,
        required: MIN_TRUSTED_COLUMNS,
      });
      return null;
    }

    const colIndex = new Map<string, number>(captured.columns.map((c, i) => [c.name, i]));
    const matches: number[] = [];
    for (let r = 0; r < captured.rows.length && matches.length < 2; r++) {
      const candidate = captured.rows[r];
      let allMatch = true;
      for (const col of trustedColumns) {
        const idx = colIndex.get(col);
        if (idx === undefined || !scalarEquals(domRow[col], candidate[idx])) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) matches.push(r);
    }

    if (matches.length !== 1) {
      log.debug(
        matches.length === 0
          ? 'capture: tier 1 found no captured row matching the DOM row'
          : 'capture: tier 1 refused - two or more captured rows matched equally (ambiguous)',
        { trustedColumns, candidates: matches.length },
      );
      return null;
    }

    const winner = captured.rows[matches[0]];
    const row: Record<string, string> = {};
    captured.columns.forEach((c, i) => {
      if (!ignored.includes(c.name)) row[c.name] = stringifyCell(winner[i]);
    });

    log.info('capture: tier 1 matched - DOM row resolved against the captured QueryRun', {
      runId: captured.runId,
      trustedColumns,
      totalColumns: captured.columns.length,
    });
    return { row, runId: captured.runId };
  } catch (err) {
    log.error('capture: matchCapturedRow() failed, falling through to tier 2/3', err);
    return null;
  }
}
