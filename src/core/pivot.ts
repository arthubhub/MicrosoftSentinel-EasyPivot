import type {
  IndicatorId,
  PivotActionId,
  PivotCatalog,
  PivotParams,
  PivotRule,
  PlatformId,
} from '../types.ts';
import { PIVOT } from '../config.ts';
import bundledRulesJson from '../../rules/pivot-rules.json';

/**
 * Pure pivot logic: catalog access, indicator detection, query filling,
 * time parsing. Never touches the DOM.
 */

/** Catalog shipped in the bundle: fallback when nothing better is cached */
export const BUNDLED_CATALOG = bundledRulesJson as unknown as PivotCatalog;

let catalog: PivotCatalog = BUNDLED_CATALOG;
let compiledPatterns = compilePatterns(catalog);

export const ACTION_IDS: readonly PivotActionId[] = ['statistics', 'pivot', 'timeline'];

/**
 * Patterns use .NET syntax; JS refuses the inline `(?i)` flag, so it is
 * turned into the `i` flag. Invalid patterns are skipped.
 */
function compilePatterns(c: PivotCatalog): Map<IndicatorId, RegExp[]> {
  const map = new Map<IndicatorId, RegExp[]>();
  for (const [id, def] of Object.entries(c.indicators) as [IndicatorId, { patterns: readonly string[] }][]) {
    const list: RegExp[] = [];
    for (const p of def.patterns ?? []) {
      try {
        list.push(p.startsWith('(?i)') ? new RegExp(p.slice(4), 'i') : new RegExp(p));
      } catch {
        // invalid pattern in a remote catalog: ignore it
      }
    }
    map.set(id, list);
  }
  return map;
}

// ── Catalog ──

export function getCatalog(): PivotCatalog {
  return catalog;
}

export function setCatalog(next: PivotCatalog): void {
  catalog = next;
  compiledPatterns = compilePatterns(next);
}

/** Indicator ids in JSON order (display order of the chips) */
export function getIndicatorIds(): readonly IndicatorId[] {
  return Object.keys(catalog.indicators) as IndicatorId[];
}

export function getIndicatorLabel(id: IndicatorId): string {
  return catalog.indicators[id]?.label ?? id;
}

export function getActionLabel(id: PivotActionId): string {
  return catalog.actions[id]?.label ?? id;
}

/** Rules for an indicator type: v1 first, then by id */
export function getRulesForIndicator(type: IndicatorId): readonly PivotRule[] {
  return catalog.rules
    .filter((r) => r.indicators.includes(type))
    .sort((a, b) => Number(!!b.v1) - Number(!!a.v1) || a.id.localeCompare(b.id));
}

export function getRuleById(id: string): PivotRule | undefined {
  return catalog.rules.find((r) => r.id === id);
}

/** Does any rule of this type use the HOST placeholder? */
export function indicatorHasHostRules(type: IndicatorId): boolean {
  return getRulesForIndicator(type).some((r) => r.placeholders.includes('HOST'));
}

// ── Detection ──

const priorityIndex = (id: IndicatorId): number => {
  const i = (PIVOT.INDICATOR_PRIORITY as readonly string[]).indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/** Every type with a matching pattern, most specific first */
export function detectIndicators(value: string): IndicatorId[] {
  const v = value.trim();
  if (!v) return [];
  const matches: IndicatorId[] = [];
  for (const [id, patterns] of compiledPatterns) {
    if (patterns.some((re) => re.test(v))) matches.push(id);
  }
  return matches.sort((a, b) => priorityIndex(a) - priorityIndex(b));
}

// ── Query filling ──

/**
 * VALUE and HOST go inside KQL verbatim strings (@"…"), where only `"`
 * needs escaping (as `""`). Line breaks and tabs, which a verbatim string
 * cannot hold, are collapsed to a space.
 */
function verbatim(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\t]+/g, ' ').trim().replace(/"/g, '""');
}

function minutes(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '' : String(Math.trunc(n));
}

function isoOrEmpty(t0: string | undefined): string {
  if (!t0) return '';
  const d = new Date(t0);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function fillQuery(rule: PivotRule, params: PivotParams, platform: PlatformId): string {
  const template =
    platform === 'defender' && rule.queryDefender ? rule.queryDefender : rule.query;

  const values: Record<string, string> = {
    VALUE: verbatim(params.value),
    T0: isoOrEmpty(params.t0),
    BEFORE_MIN: minutes(params.beforeMinutes),
    AFTER_MIN: minutes(params.afterMinutes),
    HOST: verbatim(params.host),
  };

  // In the Sentinel editor a blank line separates two queries: « Run » would
  // only execute the block under the cursor, so blank lines are dropped.
  // Comment lines keep their placeholders (« Paramètres : {{VALUE}}, … »).
  return template
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) =>
      line.trimStart().startsWith('//')
        ? line
        : line.replace(/\{\{(VALUE|T0|BEFORE_MIN|AFTER_MIN|HOST)\}\}/g, (_m, key: string) => values[key]),
    )
    .join('\n');
}

// ── Parsing helpers ──

/**
 * '' → undefined (rule default). Minutes, or 30m, 24h, 7d (j accepted).
 * Invalid input → NaN.
 */
export function parseDurationMinutes(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|min|h|d|j)?$/i.exec(t);
  if (!m) return NaN;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = (m[2] ?? 'm').toLowerCase();
  const factor = unit === 'h' ? 60 : unit === 'd' || unit === 'j' ? 1440 : 1;
  return Math.round(n * factor);
}

function monthFirstLocale(): boolean {
  try {
    return navigator.language.toLowerCase() === 'en-us';
  } catch {
    return false;
  }
}

/**
 * Convert the time text shown in the grid to ISO 8601 ('' on failure).
 * `utc` = the column displays UTC (no time zone in the text).
 */
export function parseGridTime(raw: string, utc: boolean): string {
  const s = raw.trim();
  if (!s) return '';

  // ISO-like: 2026-10-08 09:21[:14[.123]] or 2026-10-08T09:21…
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(s)) {
    let iso = s.replace(' ', 'T');
    if (utc && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }

  // d/m/y h:m[:s[.ms]] [AM|PM], separators / . -
  const m =
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,7}))?)?\s*(AM|PM)?$/i.exec(s);
  if (!m) return '';

  const a = Number(m[1]);
  const b = Number(m[2]);
  let day: number;
  let month: number;
  if (a > 12) {
    day = a; month = b;
  } else if (b > 12) {
    month = a; day = b;
  } else if (monthFirstLocale()) {
    month = a; day = b;
  } else {
    day = a; month = b;
  }

  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000;

  let hour = Number(m[4]);
  const ampm = m[8]?.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return '';
  }

  const d = utc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
    : new Date(year, month - 1, day, hour, minute, second, ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
