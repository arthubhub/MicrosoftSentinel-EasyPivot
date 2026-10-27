import type { IndicatorId, PivotCatalog } from '../types.ts';
import { detectIndicators, getCatalog, getIndicatorIds, matchesPattern } from './pivot.ts';
import { preNormalize } from './normalize.ts';

/**
 * Cell detection (#18, phase 3a): given a grid cell's raw value, its column
 * name and (on Defender) its declared Entity type, decide which indicator
 * types it could be a pivot value for, most trusted first.
 *
 * ── Precedence, and why it is NOT a straight reading of either plan line ──
 * PLAN-DEV.md's W2 step 3 says "locations du catalogue, puis entityName
 * Defender, puis regex" (locations first); the step-0 findings about
 * Defender's Entity say "Il passe en premier dans la détection" (Entity
 * first). Both are true of DIFFERENT SUBSETS of `locations`, so neither
 * sentence alone is the rule. The actual precedence is by TRUST, not by
 * source:
 *
 *   1. `locations` CONFIRMED tier  — a human-written rule comparison (the
 *      Kusto language service resolving what a real rule actually compares
 *      a column to). Highest trust: a person looked at this.
 *   2. Defender `entityName`       — declared by the platform itself and
 *      surveyed on real tenants (step 0). More trustworthy than a bare
 *      column-name guess, but it is still Microsoft's own heuristic, not a
 *      human decision about THIS catalogue — so it sits below tier 1.
 *   3. `locations` UNCERTAIN tier  — a column-NAME pattern (`*Ip`, `*Upn`…),
 *      never promoted to confirmed by hand. Below Entity.
 *   4. Regex on the value          — fallback only, when nothing above says
 *      anything about this column. This is `detectIndicators()` in
 *      `core/pivot.ts`, `INDICATOR_PRIORITY` and all: untouched, and never
 *      consulted by the three tiers above.
 *
 * So: "locations first" is true of the confirmed tier, and "Entity first"
 * is true relative to the uncertain tier — both plan statements hold, for
 * different halves of `locations`.
 *
 * ── Narrowing by value shape (mandatory, not an edge case) ──
 * A column can legitimately declare more than one type (a UPN column is
 * both `account` and `email`). Before a candidate from ANY tier above is
 * accepted, the catalogue's OWN regex for that type must match the
 * (pre-normalized) value — `matchesPattern()` in core/pivot.ts. This is what
 * stops `CORP\svcsql` (a service account, or a non-routable on-prem UPN from
 * Defender for Identity's `Identity*` tables — the common case there, not an
 * edge case) from offering e-mail rules just because its column is also
 * known to hold e-mail addresses. It is also the tie-break for the 24
 * columns `locations` claims for more than one type once the table part of
 * `Table.Column` is dropped (see module-level index below): of those, only
 * one (`InitiatingProcessAccountName`: `account` confirmed, `process`
 * uncertain) is settled by tier; the other 23 are same-tier and shape alone
 * decides (e.g. `ComputerIP_Hidden` resolves to `ip` or `device` purely by
 * whether the value parses as one or the other).
 *
 * Pure: no DOM, no storage, no network, no `t()`. Takes the catalogue via
 * `core/pivot.ts`'s `getCatalog()` — the same single source every other pure
 * function here (`getIndicatorIds`, `getRulesForIndicator`…) already reads
 * from, rather than threading a `PivotCatalog` parameter through every call
 * site just for this module.
 */

export type DetectionTier = 'locations-confirmed' | 'entity' | 'locations-uncertain' | 'regex' | 'none';

export interface CellDetection {
  /** Candidate types, most trusted first. Empty = nothing to preselect. */
  readonly candidates: readonly IndicatorId[];
  /** Which tier produced `candidates[0]` (for logging only). */
  readonly tier: DetectionTier;
}

/**
 * Defender `Entity` → EasyPivot indicator (PLAN-DEV.md Annexes). Re-exported
 * here (rather than in `types.ts`, which holds types only) so phase 4's
 * capture profile can reuse the same mapping instead of duplicating it.
 */
export const ENTITY_TO_INDICATOR: Readonly<Record<string, IndicatorId>> = {
  Machine: 'device',
  Ip: 'ip',
  Url: 'url',
  File: 'hash',
  UserSid: 'account', // 'sid' once #16 adds the type
  UserObjectId: 'account',
};

// ── Inverted locations index, memoised per catalogue (not per call) ──

interface ColumnTiers {
  readonly confirmed: ReadonlySet<IndicatorId>;
  readonly uncertain: ReadonlySet<IndicatorId>;
}

/** `locations` ignores the table part: CellContext has no table yet (phase 4). */
function columnNameOf(entry: string): string | null {
  const dot = entry.indexOf('.');
  return dot < 0 ? null : entry.slice(dot + 1).toLowerCase();
}

function buildColumnIndex(catalog: PivotCatalog): Map<string, { confirmed: Set<IndicatorId>; uncertain: Set<IndicatorId> }> {
  const index = new Map<string, { confirmed: Set<IndicatorId>; uncertain: Set<IndicatorId> }>();
  const locations = catalog.locations ?? {};
  const confirmedCounts = catalog.locationsConfirmed ?? {};

  for (const [type, entries] of Object.entries(locations) as [IndicatorId, readonly string[] | undefined][]) {
    const list = entries ?? [];
    // Defensive: a sanitized catalogue (core/catalog-validate.ts) may have
    // dropped head entries, which would make the original count overcount.
    const confirmedN = Math.min(confirmedCounts[type] ?? 0, list.length);

    list.forEach((entry, i) => {
      const column = columnNameOf(entry);
      if (!column) return;
      let tiers = index.get(column);
      if (!tiers) {
        tiers = { confirmed: new Set(), uncertain: new Set() };
        index.set(column, tiers);
      }
      if (i < confirmedN) tiers.confirmed.add(type);
      else if (!tiers.confirmed.has(type)) tiers.uncertain.add(type);
    });
  }
  return index;
}

let indexedCatalog: PivotCatalog | null = null;
let columnIndex: ReturnType<typeof buildColumnIndex> | null = null;

/** Rebuilt only when the catalogue reference changes (`setCatalog()`), not on every cell. */
function getColumnIndex(catalog: PivotCatalog): NonNullable<typeof columnIndex> {
  if (columnIndex && indexedCatalog === catalog) return columnIndex;
  columnIndex = buildColumnIndex(catalog);
  indexedCatalog = catalog;
  return columnIndex;
}

// ── Table-aware index (#18, phase 4e) ──
//
// `locations` entries ARE `Table.Column` strings already - `buildColumnIndex`
// above just discards the table part because `CellContext` had no table
// before phase 4. Tier 1 of W2 step 2 (capture/match-row.ts) can now supply
// a captured run's `sourceTables`, so a SECOND index, keyed by the FULL
// `table.column` (lowercased), lets a cell be resolved against the exact
// table it came from instead of every table that happens to share a column
// name. No new data: same `locations`/`locationsConfirmed`, just a
// different key granularity.
//
// Deliberately NOT merged into `buildColumnIndex`'s single pass result:
// keeping two separate maps keeps `detectForCell` honest about exactly
// which one it is consulting (see the "one table, known" branch below),
// rather than one map silently serving both granularities.

function buildTableColumnIndex(catalog: PivotCatalog): Map<string, { confirmed: Set<IndicatorId>; uncertain: Set<IndicatorId> }> {
  const index = new Map<string, { confirmed: Set<IndicatorId>; uncertain: Set<IndicatorId> }>();
  const locations = catalog.locations ?? {};
  const confirmedCounts = catalog.locationsConfirmed ?? {};

  for (const [type, entries] of Object.entries(locations) as [IndicatorId, readonly string[] | undefined][]) {
    const list = entries ?? [];
    const confirmedN = Math.min(confirmedCounts[type] ?? 0, list.length);

    list.forEach((entry, i) => {
      if (entry.indexOf('.') < 0) return; // no table part to index at this granularity
      const key = entry.trim().toLowerCase();
      let tiers = index.get(key);
      if (!tiers) {
        tiers = { confirmed: new Set(), uncertain: new Set() };
        index.set(key, tiers);
      }
      if (i < confirmedN) tiers.confirmed.add(type);
      else if (!tiers.confirmed.has(type)) tiers.uncertain.add(type);
    });
  }
  return index;
}

let indexedTableCatalog: PivotCatalog | null = null;
let tableColumnIndex: ReturnType<typeof buildTableColumnIndex> | null = null;

function getTableColumnIndex(catalog: PivotCatalog): NonNullable<typeof tableColumnIndex> {
  if (tableColumnIndex && indexedTableCatalog === catalog) return tableColumnIndex;
  tableColumnIndex = buildTableColumnIndex(catalog);
  indexedTableCatalog = catalog;
  return tableColumnIndex;
}

// ── Detection ──

// ── Which types the shape test may actually veto ──
// `matchesPattern` is a real format discriminator for these: an e-mail without
// an `@`, or an IP that is not dotted-quad, genuinely is not one.
const STRICT_SHAPE: ReadonlySet<IndicatorId> = new Set<IndicatorId>([
  'email', 'ip', 'url', 'hash', 'application', 'domain',
]);
// For `account`, `device` and `process` the catalogue regex is NOT a
// discriminator, so it must not veto a `locations` assertion. The account
// patterns only accept `user@domain` or `DOMAIN\user`, so a bare SAM name
// (`svc-sql`, `jdoe`) matches neither — vetoing on that made an AccountUpn cell
// holding a service account fall through to the regex tier and come back as
// « Machine ». A wrong preselection on the commonest account shape there is.
// So: a strict type must match its pattern to be kept; a loose type is kept on
// the strength of the column alone.
function keepByShape(id: IndicatorId, value: string): boolean {
  return STRICT_SHAPE.has(id) ? matchesPattern(id, value) : true;
}

/**
 * Candidate types for a grid cell, most trusted first. `column` and
 * `entityName` are matched as declared (case-insensitive for `column`);
 * `value` is pre-normalized internally so a defanged value (`hxxp://…`)
 * still passes the shape test and so callers never have to remember to call
 * `preNormalize()` themselves before detection.
 *
 * `sourceTables` (#18, phase 4e): the captured run's tables, when tier 1 of
 * W2 step 2 resolved this row. Used ONLY when it names EXACTLY ONE table -
 * a `union` over several tables says nothing about which one produced THIS
 * row (nothing in the response ties a row to a source table), so a table is
 * NEVER guessed from a multi-table `sourceTables`: that case, and the
 * zero-table case, both fall back to today's column-name-only index
 * unchanged. When unambiguous, the table-qualified lookup REPLACES the
 * column-only one for this cell (not merged with it) - that is the whole
 * point: a column name that collides across tables with different
 * semantics must stop leaking a wrong type in once the table is known, even
 * if that means this cell now resolves to nothing from `locations`.
 */
export function detectForCell(
  value: string,
  column: string,
  entityName?: string,
  sourceTables?: readonly string[],
): CellDetection {
  const v = preNormalize(value);
  if (!v) return { candidates: [], tier: 'none' };

  const catalog = getCatalog();
  const order = getIndicatorIds(); // catalogue key order; NOT INDICATOR_PRIORITY

  // A known table makes the lookup more precise, but it must never make it
  // WORSE. `locations` holds ~793 Table.Column pairs over 105 tables, so most
  // table/column combinations are simply absent from it - and an earlier
  // version REPLACED the column-only lookup with the table-qualified one, so a
  // miss fell straight through to the regex tier. Measured: `AccountUpn` alone
  // resolved [account, email] at locations-confirmed, while `AccountUpn` with
  // sourceTables ['SigninLogs'] dropped to the regex tier - supplying more
  // information produced a worse answer. So the table-qualified hit is a
  // PREFERENCE, and the column-only index is the fallback beneath it.
  const key = column.trim().toLowerCase();
  let tiers: ColumnTiers | undefined;
  if (sourceTables && sourceTables.length === 1) {
    const fullKey = `${sourceTables[0]}.${column}`.trim().toLowerCase();
    tiers = getTableColumnIndex(catalog).get(fullKey);
  }
  if (!tiers && key) tiers = getColumnIndex(catalog).get(key);

  const confirmed: IndicatorId[] = [];
  const uncertain: IndicatorId[] = [];
  if (tiers) {
    for (const id of order) {
      if (tiers.confirmed.has(id) && keepByShape(id, v)) confirmed.push(id);
    }
    for (const id of order) {
      if (tiers.uncertain.has(id) && keepByShape(id, v)) uncertain.push(id);
    }
  }

  // Entity sits between the two tiers: more trust than a column-name guess,
  // less than a human-verified rule comparison (see module doc above).
  const entityType = entityName ? ENTITY_TO_INDICATOR[entityName] : undefined;
  const entityBucket: IndicatorId[] = [];
  if (entityType && !confirmed.includes(entityType) && matchesPattern(entityType, v)) {
    const idx = uncertain.indexOf(entityType);
    if (idx !== -1) uncertain.splice(idx, 1); // promote, don't duplicate
    entityBucket.push(entityType);
  }

  if (confirmed.length) return { candidates: [...confirmed, ...entityBucket, ...uncertain], tier: 'locations-confirmed' };
  if (entityBucket.length) return { candidates: [...entityBucket, ...uncertain], tier: 'entity' };
  if (uncertain.length) return { candidates: uncertain, tier: 'locations-uncertain' };

  // Step 4, fallback only: INDICATOR_PRIORITY-ordered regex (+ phase-1 stopgap).
  const regexCandidates = detectIndicators(v, column);
  return { candidates: regexCandidates, tier: regexCandidates.length ? 'regex' : 'none' };
}
