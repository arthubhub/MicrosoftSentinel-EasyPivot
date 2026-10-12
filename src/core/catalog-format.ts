import type { IndicatorId, PivotActionId, PivotCatalog, PivotRule } from '../types.ts';

/**
 * The rules repo (MSSentinel-PivotRules) publishes two formats:
 * - pivot-rules.json: full catalog (indicators, patterns, windows, reading,
 *   v1, Defender variants) → used as is;
 * - pivot-rules.flat.json: `[{ name, category, description, query }]` →
 *   converted here. Pure functions, no DOM.
 */

interface FlatRule {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly query: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function isFlatCatalog(v: unknown): v is FlatRule[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((r) => {
      const x = r as Record<string, unknown> | null;
      return !!x && isString(x.name) && isString(x.category) && isString(x.query);
    })
  );
}

/** Shape check of a full catalog (remote content is untrusted) */
export function isFullCatalog(v: unknown): v is PivotCatalog {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (!c.indicators || typeof c.indicators !== 'object') return false;
  if (!c.actions || typeof c.actions !== 'object') return false;
  if (!Array.isArray(c.rules) || c.rules.length === 0) return false;

  for (const def of Object.values(c.indicators as Record<string, unknown>)) {
    const d = def as Record<string, unknown> | null;
    if (!d || !isString(d.label) || !isStringArray(d.patterns)) return false;
  }

  return c.rules.every((r: unknown) => {
    const x = r as Record<string, unknown> | null;
    if (!x) return false;
    const w = x.window as Record<string, unknown> | null;
    return (
      isString(x.id) &&
      isString(x.name) &&
      isString(x.action) &&
      isString(x.query) &&
      isStringArray(x.indicators) &&
      isStringArray(x.placeholders) &&
      !!w && isString(w.before) && isString(w.after)
    );
  });
}

function formatWindow(min: number): string {
  if (min === 0) return '0m';
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

/**
 * Default window from the parameter header:
 * `let Before = coalesce(tolong(@"{{BEFORE_MIN}}"), 1440) * 1m; // défaut : 24h`
 * The trailing comment keeps the rule's own label (24h rather than 1d).
 */
function headerDefault(query: string, placeholder: string): { minutes: number; label: string } | undefined {
  const re = new RegExp(`tolong\\(@"\\{\\{${placeholder}\\}\\}"\\),\\s*(\\d+)\\)[^\\n]*?(?://\\s*défaut\\s*:\\s*(\\S+))?\\s*$`, 'm');
  const m = re.exec(query);
  if (!m) return undefined;
  const minutes = Number(m[1]);
  return { minutes, label: m[2] ?? formatWindow(minutes) };
}

function labelToId<T extends string>(defs: Record<T, { label: string }>, label: string): T | undefined {
  const l = label.trim().toLowerCase();
  return (Object.keys(defs) as T[]).find((id) => defs[id].label.toLowerCase() === l);
}

const ACTION_LETTERS: Record<string, PivotActionId> = { S: 'statistics', P: 'pivot', T: 'timeline' };

function convertFlatRule(flat: FlatRule, base: PivotCatalog): PivotRule | null {
  // « [IP-S1] Activité de l'IP par jour »
  const m = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(flat.name);
  if (!m) return null;
  const [, id, name] = m;

  // « Statistics · Adresse IP »
  const [actionLabel = '', indicatorLabel = ''] = flat.category.split('·').map((s) => s.trim());
  const action =
    labelToId(base.actions, actionLabel) ??
    ACTION_LETTERS[/-([SPT])\d+$/i.exec(id)?.[1]?.toUpperCase() ?? ''];
  if (!action) return null;

  // Metadata the flat format drops (extra indicators, v1, reading, tables)
  // comes from the same rule of the base catalog when it exists.
  const known = base.rules.find((r) => r.id === id);
  const indicator = labelToId(base.indicators, indicatorLabel);
  const indicators: IndicatorId[] = known
    ? [...known.indicators]
    : indicator ? [indicator] : [];
  if (indicators.length === 0) return null;

  const before = headerDefault(flat.query, 'BEFORE_MIN') ??
    (known ? { minutes: known.window.beforeMinutes, label: known.window.before } : { minutes: 1440, label: '1d' });
  const after = headerDefault(flat.query, 'AFTER_MIN') ??
    (known ? { minutes: known.window.afterMinutes, label: known.window.after } : { minutes: 1440, label: '1d' });
  const render = [...flat.query.matchAll(/\|\s*render\s+(\w+)/g)].pop()?.[1] ?? 'table';
  const placeholders = [...new Set([...flat.query.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]))];

  return {
    id,
    name,
    category: flat.category,
    indicators,
    action,
    description: flat.description ?? '',
    ...(known?.reading ? { reading: known.reading } : {}),
    ...(known?.v1 ? { v1: true } : {}),
    window: {
      before: before.label,
      after: after.label,
      beforeMinutes: before.minutes,
      afterMinutes: after.minutes,
    },
    render,
    ...(known?.tables ? { tables: known.tables } : {}),
    placeholders,
    query: flat.query,
    // No queryDefender: the flat format has none, and the base one may not match this query
  };
}

/**
 * Turn downloaded JSON into a catalog: full format as is, flat format
 * converted against `base` (indicator patterns, labels, known rules).
 * null = unrecognized content.
 */
export function normalizeCatalog(data: unknown, base: PivotCatalog): PivotCatalog | null {
  if (isFullCatalog(data)) return data;
  if (!isFlatCatalog(data)) return null;

  const rules = data
    .map((r) => convertFlatRule(r, base))
    .filter((r): r is PivotRule => r !== null);
  if (rules.length === 0) return null;

  const version =
    /sentinel-pivot-rules\s+([\w.-]+?)\.?\s/.exec(data[0].query)?.[1] ?? 'flat';

  return { version, indicators: base.indicators, actions: base.actions, rules };
}
