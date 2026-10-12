import type {
  CellContext,
  IndicatorId,
  PivotSnapshot,
  PivotStep,
  PlatformId,
} from '../types.ts';
import { SNAPSHOTS, STORAGE_KEYS } from '../config.ts';
import { getJson, setJson } from './storage.ts';

/**
 * Investigation journal.
 *
 * Problem: running a pivot query replaces the results grid, so the event the
 * pivot started from (value × T0, the other fields of the row) is lost, and
 * pivoting again used to mean deleting the pivot query and re-running the
 * initial one.
 *
 * A snapshot keeps, for each pivot launched, the row it started from and the
 * editor content that produced that row. The pivot panel can then reload any
 * snapshot (re-pivot on another field or with another rule, no re-run) or
 * put the source query back in the editor.
 *
 * Stored in Tampermonkey storage: survives reloads, stays on this browser.
 */

const ORIGIN_RE = /^\/\/ \[([A-Za-z0-9_-]+)\]/gm;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Rule id of the last compiled pivot query (`// [ID] …`) in the editor text */
export function findOriginRuleId(sourceQuery: string): string {
  let last = '';
  for (const m of sourceQuery.matchAll(ORIGIN_RE)) last = m[1];
  return last;
}

export function listSnapshots(): readonly PivotSnapshot[] {
  const list = getJson<PivotSnapshot[]>(STORAGE_KEYS.SNAPSHOTS, []);
  return Array.isArray(list) ? list : [];
}

function save(list: readonly PivotSnapshot[]): void {
  setJson(STORAGE_KEYS.SNAPSHOTS, list.slice(0, SNAPSHOTS.MAX));
}

export function getSnapshot(id: string): PivotSnapshot | undefined {
  return listSnapshots().find((s) => s.id === id);
}

function sameEvent(a: PivotSnapshot, ctx: CellContext, sourceQuery: string): boolean {
  // Without a grid row (manual input), the value is what identifies the event
  const noRow = Object.keys(ctx.row).length === 0;
  return (
    (!noRow || a.value === ctx.value) &&
    a.sourceQuery === sourceQuery &&
    a.t0 === ctx.t0 &&
    a.host === ctx.host &&
    JSON.stringify(a.row) === JSON.stringify(ctx.row)
  );
}

/**
 * Record the event a pivot starts from (newest first). The same row from the
 * same source query reuses the existing snapshot.
 */
export function recordSnapshot(
  ctx: CellContext,
  sourceQuery: string,
  platform: PlatformId,
): PivotSnapshot {
  const list = listSnapshots();
  const source = sourceQuery.length > SNAPSHOTS.MAX_SOURCE_CHARS ? '' : sourceQuery;

  const existing = list.find((s) => sameEvent(s, ctx, source));
  if (existing) {
    save([existing, ...list.filter((s) => s.id !== existing.id)]);
    return existing;
  }

  const row: Record<string, string> = {};
  for (const [col, val] of Object.entries(ctx.row)) {
    row[col] = truncate(val, SNAPSHOTS.MAX_CELL_CHARS);
  }

  const snapshot: PivotSnapshot = {
    id: newId(),
    createdAt: Date.now(),
    platform,
    value: truncate(ctx.value, SNAPSHOTS.MAX_CELL_CHARS),
    column: ctx.column,
    t0: ctx.t0,
    t0Raw: ctx.t0Raw,
    host: ctx.host,
    row,
    sourceQuery: source,
    originRuleId: findOriginRuleId(source),
    steps: [],
  };
  save([snapshot, ...list]);
  return snapshot;
}

export function addStep(
  snapshotId: string,
  step: { ruleId: string; value: string; indicator: IndicatorId },
): void {
  const list = listSnapshots();
  const full: PivotStep = { at: Date.now(), ...step };
  save(
    list.map((s) => (s.id === snapshotId ? { ...s, steps: [...s.steps, full] } : s)),
  );
}

export function deleteSnapshot(id: string): void {
  save(listSnapshots().filter((s) => s.id !== id));
}

export function clearSnapshots(): void {
  save([]);
}
