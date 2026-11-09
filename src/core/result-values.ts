import type { IndicatorId, ParsedColumn } from '../types.ts';
import { detectForCell } from './detection.ts';

/**
 * Indicator values found in a query result (U3, A3.1; reused by playbooks'
 * `carry`, #32). Pure: no DOM, no storage.
 *
 * Each column gets ONE type, decided on a sample of its cells with the same
 * detection as a right-click (`locations` > Defender `Entity` > regex): a
 * column is typed only when most sampled cells agree, so a free-text column
 * ("Evidence", "Detail") whose cells happen to contain an IP is not. Cells
 * holding a JSON array of strings (`make_set(...)` outputs: Accounts,
 * Machines, SourceIps) count each element. Numeric/time columns are skipped.
 */
export interface ResultValue {
  readonly value: string;
  readonly count: number;
  /** First column the value was seen in */
  readonly column: string;
}

export interface ResultValueOptions {
  /** Rows scanned at most (results can hold 100 000+ rows) */
  readonly maxRows?: number;
  /** Values kept per type, most frequent first */
  readonly perType?: number;
  readonly sourceTables?: readonly string[];
  /** Values not to suggest (case-insensitive), e.g. the value just pivoted on */
  readonly exclude?: readonly string[];
}

const SKIP_TYPES = /^(long|int|int32|int64|real|double|decimal|bool|boolean|sbyte|datetime|timespan|guid)$/i;
const SAMPLE_CELLS = 30;
const AGREEMENT = 0.6;
const MAX_VALUE_LEN = 300;

/** A cell as candidate values: a JSON array of strings gives its elements, anything else itself. */
function cellValues(cell: unknown): string[] {
  if (cell === null || cell === undefined) return [];
  if (Array.isArray(cell)) return cell.filter((x): x is string => typeof x === 'string');
  if (typeof cell !== 'string') return [];
  const s = cell.trim();
  if (!s || s.length > 4000) return [];
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  if (s.startsWith('{')) return [];
  return [s];
}

function columnType(
  column: ParsedColumn,
  index: number,
  rows: readonly (readonly unknown[])[],
  sourceTables: readonly string[] | undefined,
): IndicatorId | undefined {
  if (SKIP_TYPES.test(column.type ?? '')) return undefined;
  const votes = new Map<IndicatorId, number>();
  let sampled = 0;
  for (const row of rows) {
    for (const v of cellValues(row[index])) {
      if (v.length > MAX_VALUE_LEN) continue;
      sampled++;
      const top = detectForCell(v, column.name, column.entity, sourceTables).candidates[0];
      if (top) votes.set(top, (votes.get(top) ?? 0) + 1);
      if (sampled >= SAMPLE_CELLS) break;
    }
    if (sampled >= SAMPLE_CELLS) break;
  }
  if (sampled === 0) return undefined;
  let best: IndicatorId | undefined;
  let bestVotes = 0;
  for (const [type, n] of votes) {
    if (n > bestVotes) {
      best = type;
      bestVotes = n;
    }
  }
  return best && bestVotes / sampled >= AGREEMENT ? best : undefined;
}

export function extractResultValues(
  columns: readonly ParsedColumn[],
  rows: readonly (readonly unknown[])[],
  options: ResultValueOptions = {},
): Map<IndicatorId, ResultValue[]> {
  const out = new Map<IndicatorId, ResultValue[]>();
  try {
    const maxRows = options.maxRows ?? 5000;
    const perType = options.perType ?? 10;
    const exclude = new Set((options.exclude ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
    const scanned = rows.slice(0, maxRows);

    const typed: { index: number; name: string; type: IndicatorId }[] = [];
    columns.forEach((c, index) => {
      const type = columnType(c, index, scanned, options.sourceTables);
      if (type) typed.push({ index, name: c.name, type });
    });
    if (typed.length === 0) return out;

    const counts = new Map<IndicatorId, Map<string, { value: string; count: number; column: string }>>();
    for (const row of scanned) {
      for (const col of typed) {
        for (const raw of cellValues(row[col.index])) {
          const value = raw.trim();
          if (!value || value.length > MAX_VALUE_LEN) continue;
          const key = value.toLowerCase();
          if (exclude.has(key)) continue;
          const byValue = counts.get(col.type) ?? new Map();
          const hit = byValue.get(key);
          if (hit) hit.count++;
          else byValue.set(key, { value, count: 1, column: col.name });
          counts.set(col.type, byValue);
        }
      }
    }
    for (const [type, byValue] of counts) {
      const list = [...byValue.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, perType);
      if (list.length) out.set(type, list);
    }
  } catch {
    // Suggestions only: on any failure, suggest nothing
  }
  return out;
}
