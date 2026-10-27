import type { PivotCatalog } from '../types.ts';
import { t } from '../i18n/index.ts';

/**
 * Catalog validation (#11): a remote catalog is untrusted content, so it is
 * checked before it replaces the active one. Pure functions, no DOM.
 *
 * - errors   → the catalog is rejected, the previous one stays in place;
 * - warnings → the catalog is applied, the warnings are shown in the settings.
 *
 * A rule is never dropped from the catalog: an unreachable rule is harmless,
 * a silently removed one is not. Only `locations` entries are sanitized.
 *
 * Messages must stay leak-free (project rules 1 and 2): ids, type names,
 * placeholder names and counts only — never a query, a value, or the name of
 * a custom `_CL` table or of one of its columns (the diagnostic text is meant
 * to be copied out of the browser by the user).
 */

export const SUPPORTED_FORMAT_VERSION = { min: 1, max: 1 } as const;

/** Placeholders `fillQuery()` knows how to substitute */
const KNOWN_PLACEHOLDERS: readonly string[] = ['VALUE', 'T0', 'BEFORE_MIN', 'AFTER_MIN', 'HOST'];

/** `Table.Column`, both parts present */
const LOCATION_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

/** Custom table: excluded everywhere (project rule 2) */
const CUSTOM_TABLE = /_CL$/i;

export interface CatalogReport {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Sanitized catalog (locations cleaned); null when `errors` is non-empty */
  readonly catalog: PivotCatalog | null;
}

const plural = (n: number): string => (n > 1 ? 's' : '');

// ── Format version ──

/**
 * Major part of a `formatVersion` (`1`, `'1'`, `'1.2'`, `1.0` → 1).
 * null = unreadable or not a positive integer major.
 */
function majorVersion(raw: number | string): number | null {
  const m = /^(\d+)(?:\.\d+)*$/.exec(String(raw).trim());
  if (!m) return null;
  const major = Number(m[1]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** An absent formatVersion is legacy 1: no error, no warning. */
function checkFormatVersion(catalog: PivotCatalog, errors: string[]): void {
  const raw = catalog.formatVersion;
  if (raw === undefined || raw === null) return;

  const major = majorVersion(raw);
  if (major === null) {
    errors.push(t('validate.formatVersionInvalid', { version: String(raw) }));
    return;
  }
  if (major < SUPPORTED_FORMAT_VERSION.min || major > SUPPORTED_FORMAT_VERSION.max) {
    errors.push(
      t('validate.formatVersionUnsupported', {
        version: major,
        min: SUPPORTED_FORMAT_VERSION.min,
        max: SUPPORTED_FORMAT_VERSION.max,
      }),
    );
  }
}

// ── Rules ──

/** Unknown `{{PLACEHOLDER}}` tokens of a rule, in order, deduplicated */
function unknownPlaceholders(rule: PivotCatalog['rules'][number]): string[] {
  const found: string[] = [];
  for (const query of [rule.query, rule.queryDefender]) {
    if (typeof query !== 'string') continue;
    for (const m of query.matchAll(/\{\{(\w+)\}\}/g)) {
      const name = m[1];
      if (!KNOWN_PLACEHOLDERS.includes(name) && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

function checkRules(catalog: PivotCatalog, errors: string[], warnings: string[]): void {
  const rules = catalog.rules ?? [];
  if (rules.length === 0) {
    errors.push(t('validate.noRules'));
    return;
  }

  const knownIndicators = new Set(Object.keys(catalog.indicators ?? {}));
  const knownActions = new Set(Object.keys(catalog.actions ?? {}));

  for (const rule of rules) {
    for (const name of unknownPlaceholders(rule)) {
      errors.push(t('validate.unknownPlaceholder', { id: rule.id, name }));
    }

    const indicators = rule.indicators ?? [];
    let known = 0;
    for (const type of indicators) {
      if (knownIndicators.has(type)) known += 1;
      else warnings.push(t('validate.unknownIndicator', { id: rule.id, name: type }));
    }
    if (known === 0) warnings.push(t('validate.noKnownIndicator', { id: rule.id }));

    if (!knownActions.has(rule.action)) {
      warnings.push(t('validate.unknownAction', { id: rule.id, name: rule.action }));
    }
  }
}

// ── Indicator patterns ──

/**
 * Compiled exactly like `compilePatterns()` in core/pivot.ts (.NET inline
 * `(?i)` → the `i` flag), so the validator agrees with the runtime.
 */
function compiles(pattern: string): boolean {
  try {
    if (pattern.startsWith('(?i)')) new RegExp(pattern.slice(4), 'i');
    else new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function checkPatterns(catalog: PivotCatalog, warnings: string[]): void {
  for (const [type, def] of Object.entries(catalog.indicators ?? {})) {
    const patterns = def?.patterns ?? [];
    let ok = 0;
    patterns.forEach((pattern, i) => {
      if (compiles(pattern)) ok += 1;
      else warnings.push(t('validate.badPattern', { type, n: i + 1 }));
    });
    if (ok === 0) warnings.push(t('validate.noPatterns', { type }));
  }
}

// ── Locations (phase 2b) ──

type Locations = NonNullable<PivotCatalog['locations']>;

/**
 * Drop unknown types, malformed entries and custom tables. The `_CL` check
 * runs first so a malformed `_CL` entry is not named either.
 */
function sanitizeLocations(catalog: PivotCatalog, warnings: string[]): Locations | null {
  const locations = catalog.locations;
  if (!locations) return null;

  const knownIndicators = new Set(Object.keys(catalog.indicators ?? {}));
  const clean: Record<string, readonly string[]> = {};

  for (const [type, entries] of Object.entries(locations)) {
    if (!knownIndicators.has(type)) {
      warnings.push(t('validate.unknownLocationType', { type }));
      continue;
    }

    const kept: string[] = [];
    let custom = 0;
    for (const entry of entries ?? []) {
      // Count only: a custom table or column name must never reach a message
      if (CUSTOM_TABLE.test(String(entry).split('.')[0])) {
        custom += 1;
        continue;
      }
      if (!LOCATION_SHAPE.test(entry)) {
        warnings.push(t('validate.badLocation', { type, entry }));
        continue;
      }
      kept.push(entry);
    }
    if (custom > 0) {
      warnings.push(t('validate.locationsCustomTable', { type, n: custom, s: plural(custom) }));
    }
    if (kept.length > 0) clean[type] = kept;
  }

  return clean as Locations;
}

// ── Entry point ──

export function validateCatalog(catalog: PivotCatalog): CatalogReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  checkFormatVersion(catalog, errors);
  checkRules(catalog, errors, warnings);
  checkPatterns(catalog, warnings);
  const locations = sanitizeLocations(catalog, warnings);

  if (errors.length > 0) return { errors, warnings, catalog: null };

  // No `locations`: the input catalog is already clean
  if (!locations) return { errors, warnings, catalog };
  if (Object.keys(locations).length > 0) {
    return { errors, warnings, catalog: { ...catalog, locations } };
  }

  // Nothing left: omit the key altogether
  const { locations: _dropped, ...rest } = catalog;
  return { errors, warnings, catalog: rest as PivotCatalog };
}
