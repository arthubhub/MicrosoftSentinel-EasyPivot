import type { ParsedColumn, RunSummary } from '../types.ts';

/**
 * Pure summary of a captured result (N1: "nombre de lignes, première/dernière
 * date, 5 valeurs les plus fréquentes par colonne utile, répartition par
 * `Type`/`SourceTable`"). No DOM, no storage, no network - a single forward
 * pass over `rows` (project rule: pure functions live in `src/core`/here so
 * they can be checked by hand in the console).
 *
 * `rowCount` itself is NOT part of `RunSummary` (see the Annexes): it is
 * `result.rows.length`, already a field of `QueryRun`, so it is not
 * duplicated here.
 *
 * ── Which columns are "useful" for `topValues`, and why ──
 * Computing a frequency table for every column of a 200 000-row result is
 * both slow (one Map per column, one insert per cell) and pointless: most
 * columns are either free text (CommandLine, Message, RawEventData - no
 * two rows share a value, so "top 5" is meaningless) or so high-cardinality
 * (GUIDs, timestamps) that a frequency table never settles into anything
 * useful before memory/time are wasted building it. Importantly, `summary`
 * is the thing retention keeps the LONGEST (it survives sample purging per
 * `capture/store.ts`), so a `topValues` entry holding a raw customer value
 * must itself stay small and bounded - it must not become its own
 * data-retention problem.
 *
 * The rule applied here, in order:
 *   1. Only "dimension-like" declared types are considered at all:
 *      string / int / long / bool / guid. `datetime` is excluded (handled
 *      separately by `firstSeen`/`lastSeen`); `real`/`double` are excluded
 *      (continuous, not categorical); `dynamic`/`object` are excluded (the
 *      sample already keeps them as a truncated string elsewhere - nested
 *      JSON has no useful "top value" semantics).
 *   2. At most `MAX_TOPVALUES_COLUMNS` columns are tracked at all (in
 *      column order), so a very wide result cannot blow up memory before a
 *      single row is read.
 *   3. While scanning, a column is ABANDONED (dropped from tracking, for
 *      the rest of this run) the moment either: (a) one of its values is
 *      longer than `MAX_VALUE_LEN_FOR_TRACKING` characters - a sign of free
 *      text, where "top 5" is meaningless and where retaining the value
 *      long-term is exactly the risk flagged above; or (b) its running
 *      distinct-value count would exceed `MAX_DISTINCT_PER_COLUMN` - a sign
 *      the column is effectively unique per row (a GUID, a timestamp) and
 *      will never produce a meaningful top-5. Both checks are O(1) per
 *      cell, so the whole pass stays O(rows × usefulColumns).
 *   4. Each value actually kept in the final `topValues` is truncated to
 *      `MAX_VALUE_CHARS_OUTPUT` (200) - tighter than the sample's 2 000,
 *      on purpose, because this copy is retained far longer.
 *   5. `Type`/`SourceTable` are handled separately as `bySource` (N1 names
 *      them explicitly) and are excluded from `topValues` to avoid showing
 *      the same distribution twice.
 */

// ── Tuning constants (summary-internal: nothing outside this file needs them) ──

const USEFUL_TYPES = new Set(['string', 'int', 'long', 'bool', 'boolean', 'guid']);
const MAX_TOPVALUES_COLUMNS = 20;
const MAX_DISTINCT_PER_COLUMN = 500;
/** A single value longer than this marks its column as free text, not a dimension. */
const MAX_VALUE_LEN_FOR_TRACKING = 200;
/** Output truncation - tighter than the sample's 2 000 chars, see file header. */
const MAX_VALUE_CHARS_OUTPUT = 200;
const TOP_N = 5;

const TIME_COLUMN_PRIORITY = ['TimeGenerated', 'Timestamp', 'TimeCreated', 'EventTime'];
const SOURCE_COLUMN_CANDIDATES = ['Type', 'SourceTable'];

// ── Column selection ──

function pickTimeColumn(columns: readonly ParsedColumn[]): number {
  for (const name of TIME_COLUMN_PRIORITY) {
    const idx = columns.findIndex((c) => c.name === name);
    if (idx !== -1) return idx;
  }
  return columns.findIndex((c) => c.type?.toLowerCase() === 'datetime');
}

function pickSourceColumn(columns: readonly ParsedColumn[]): number {
  for (const name of SOURCE_COLUMN_CANDIDATES) {
    const idx = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Dimension-like columns, bounded to `MAX_TOPVALUES_COLUMNS`, excluding the source column. */
function pickUsefulColumns(columns: readonly ParsedColumn[], excludeIdx: readonly number[]): number[] {
  const idxs: number[] = [];
  for (let i = 0; i < columns.length && idxs.length < MAX_TOPVALUES_COLUMNS; i++) {
    if (excludeIdx.includes(i)) continue;
    const type = columns[i]?.type?.toLowerCase();
    if (type && USEFUL_TYPES.has(type)) idxs.push(i);
  }
  return idxs;
}

// ── Value helpers ──

function parseDateMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value === '') return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function stringifyCell(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function topN(counts: ReadonlyMap<string, number>, n: number): (readonly [string, number])[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) // highest count first, alphabetical tie-break (deterministic)
    .slice(0, n);
}

// ── Entry point ──

export function summarizeRun(columns: readonly ParsedColumn[], rows: readonly (readonly unknown[])[]): RunSummary {
  if (rows.length === 0) return {};

  const timeColIdx = pickTimeColumn(columns);
  const sourceColIdx = pickSourceColumn(columns);
  const usefulColIdx = pickUsefulColumns(columns, [timeColIdx, sourceColIdx]);

  let firstSeenMs: number | undefined;
  let lastSeenMs: number | undefined;
  const bySource = sourceColIdx === -1 ? undefined : new Map<string, number>();
  const trackers = new Map<number, Map<string, number>>();
  for (const idx of usefulColIdx) trackers.set(idx, new Map());

  for (const row of rows) {
    if (timeColIdx !== -1) {
      const ms = parseDateMs(row[timeColIdx]);
      if (ms !== undefined) {
        if (firstSeenMs === undefined || ms < firstSeenMs) firstSeenMs = ms;
        if (lastSeenMs === undefined || ms > lastSeenMs) lastSeenMs = ms;
      }
    }

    if (bySource && sourceColIdx !== -1) {
      const v = row[sourceColIdx];
      if (v !== null && v !== undefined) {
        const key = stringifyCell(v);
        bySource.set(key, (bySource.get(key) ?? 0) + 1);
      }
    }

    for (const [idx, counts] of trackers) {
      const v = row[idx];
      if (v === null || v === undefined) continue;
      const key = stringifyCell(v);
      // Abandon: free-text value seen, or this value would push the column
      // past the distinct-value cap (see file header, rule 3).
      if (key.length > MAX_VALUE_LEN_FOR_TRACKING || (counts.size >= MAX_DISTINCT_PER_COLUMN && !counts.has(key))) {
        trackers.delete(idx);
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const topValues: Record<string, (readonly [string, number])[]> = {};
  for (const [idx, counts] of trackers) {
    if (counts.size === 0) continue;
    const name = columns[idx]?.name ?? `col${idx}`;
    topValues[name] = topN(counts, TOP_N).map(([v, n]) => [truncate(v, MAX_VALUE_CHARS_OUTPUT), n] as const);
  }

  return {
    firstSeen: firstSeenMs !== undefined ? new Date(firstSeenMs).toISOString() : undefined,
    lastSeen: lastSeenMs !== undefined ? new Date(lastSeenMs).toISOString() : undefined,
    bySource: bySource && bySource.size > 0 ? Object.fromEntries(bySource) : undefined,
    topValues: Object.keys(topValues).length > 0 ? topValues : undefined,
  };
}
