import type { IndicatorId, ParsedColumn, PlatformId } from '../types.ts';
import { COVERAGE, STORAGE_KEYS } from '../config.ts';
import { getJson, setJson } from './storage.ts';

/**
 * Discovery → missing-coverage issue (#33, N5). Pure except for the small
 * "already reported" list. Reads the result of a `*-S9` discovery rule
 * (columns Table, Column, Path, Status): a location whose Status says the
 * rules do not read it is a gap.
 *
 * ── What may leave the browser ──
 * The issue URL is built from an ALLOWLIST of five fields: indicator type,
 * table, column, platform, catalog version. Never a value, a row count, a
 * tenant, a workspace, a client or a case name. Custom `_CL` tables are
 * dropped at every step (project rule 2). Nothing is sent: the user opens a
 * prefilled GitHub form in a new tab and submits it with their own account.
 */
export interface CoverageGap {
  readonly table: string;
  readonly column: string;
  /** JSON path inside the column when the value sits in a dynamic field ('' = the column itself) */
  readonly path: string;
  /** true: no rule reads the column; false: the column is read but not this JSON path */
  readonly unread: boolean;
}

const CUSTOM_TABLE = /_CL$/i;
/** Table and column names only: letters, digits, underscore (a JSON path is not sent) */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function col(columns: readonly ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}

/** True when the result looks like a discovery (`*-S9`) result. */
export function isDiscoveryResult(columns: readonly ParsedColumn[]): boolean {
  return col(columns, 'Table') >= 0 && col(columns, 'Column') >= 0 && col(columns, 'Status') >= 0;
}

export function findCoverageGaps(columns: readonly ParsedColumn[], rows: readonly (readonly unknown[])[]): CoverageGap[] {
  const iT = col(columns, 'Table');
  const iC = col(columns, 'Column');
  const iP = col(columns, 'Path');
  const iS = col(columns, 'Status');
  if (iT < 0 || iC < 0 || iS < 0) return [];
  const seen = new Set<string>();
  const gaps: CoverageGap[] = [];
  for (const row of rows) {
    const table = String(row[iT] ?? '').trim();
    const column = String(row[iC] ?? '').trim();
    const status = String(row[iS] ?? '');
    const path = iP >= 0 ? String(row[iP] ?? '').trim() : '';
    if (!SAFE_NAME.test(table) || !SAFE_NAME.test(column) || CUSTOM_TABLE.test(table)) continue;
    // "Non lu par les règles" (unread) or "Colonne lue, chemin JSON à vérifier" (path): anything not "read"
    const unread = /non lu|not read/i.test(status);
    const pathToCheck = /chemin|path/i.test(status);
    if (!unread && !pathToCheck) continue;
    const key = `${table}|${column}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({ table, column, path: path === column ? '' : path, unread });
  }
  // Unread columns first: they are the real gaps
  return gaps.sort((a, b) => Number(b.unread) - Number(a.unread) || a.table.localeCompare(b.table)).slice(0, COVERAGE.MAX_GAPS);
}

// ── Already reported (local only, no value) ──

const reportKey = (type: IndicatorId, gap: Pick<CoverageGap, 'table' | 'column'>): string =>
  `${type}|${gap.table}|${gap.column}`.toLowerCase();

export function isReported(type: IndicatorId, gap: Pick<CoverageGap, 'table' | 'column'>): boolean {
  return getJson<string[]>(STORAGE_KEYS.COVERAGE_REPORTED, []).includes(reportKey(type, gap));
}

export function markReported(type: IndicatorId, gap: Pick<CoverageGap, 'table' | 'column'>): void {
  const list = getJson<string[]>(STORAGE_KEYS.COVERAGE_REPORTED, []);
  const key = reportKey(type, gap);
  if (!list.includes(key)) setJson(STORAGE_KEYS.COVERAGE_REPORTED, [...list, key].slice(-500));
}

// ── Issue URL (allowlist) ──

export interface CoverageIssue {
  readonly title: string;
  /** The exact fields sent, for the preview */
  readonly fields: readonly (readonly [name: string, value: string])[];
  readonly url: string;
}

/** `null` when a field is not safe to send (custom table, odd name) or the URL would be too long. */
export function buildCoverageIssue(
  type: IndicatorId,
  gap: Pick<CoverageGap, 'table' | 'column'>,
  platform: PlatformId,
  catalogVersion: string,
): CoverageIssue | null {
  if (!SAFE_NAME.test(gap.table) || !SAFE_NAME.test(gap.column) || CUSTOM_TABLE.test(gap.table)) return null;
  const version = /^[0-9A-Za-z.+-]{1,32}$/.test(catalogVersion) ? catalogVersion : '';
  const title = `[COVERAGE] ${type} : ${gap.table}.${gap.column}`;
  const fields: [string, string][] = [
    ['indicator', type],
    ['table', gap.table],
    ['column', gap.column],
    ['platform', platform],
    ['catalog_version', version],
  ];
  const params = new URLSearchParams({ template: COVERAGE.TEMPLATE, title });
  for (const [k, v] of fields) if (v) params.set(k, v);
  const url = `${COVERAGE.ISSUE_NEW_URL}?${params.toString()}`;
  return url.length <= COVERAGE.MAX_URL_CHARS ? { title, fields, url } : null;
}
