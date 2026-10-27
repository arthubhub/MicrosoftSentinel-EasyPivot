import type { PivotSnapshot, QueryRun, TenantKey } from '../types.ts';
import { STORAGE_KEYS } from '../config.ts';
import { getJson, setJson, deleteKey } from './storage.ts';
import { listSnapshots } from './investigation.ts';
import { getKnownTenantKeys, getRuns } from '../capture/store.ts';
import {
  appendRunToCase,
  appendSnapshotToCase,
  createCase,
  getCaseIndexEntries,
  getCaseRuns,
  getCaseSnapshots,
  MIGRATION_CASE_NAME,
  systemKindOf,
} from './cases.ts';
import { UNKNOWN_KEY } from './tenant.ts';
import { log } from './log.ts';

/**
 * One-time migration of the pre-cases journal into `core/cases.ts` (N2
 * "Migration", rule 8). This is the only phase-5 point that touches data
 * the user already has, so the whole module is written around ONE
 * invariant: **the old keys (`shq_pivot_snapshots`, every
 * `shq_runs_<tenantKey>`, `shq_runs_index`) are never written to by
 * anything in here.** Every function below either only READS them
 * (`listSnapshots`, `getKnownTenantKeys`, `getRuns` — all pre-existing,
 * read-only accessors already exported by `core/investigation.ts` and
 * `capture/store.ts`) or, for `deleteOldHistory()` alone, deletes them
 * outright — and that one function is reachable ONLY from the Settings
 * "Supprimer l'ancien historique" button, after the user clicks it AND
 * after the migration below is confirmed (`shq_migration_v2` set).
 *
 * DESTINATION CASE(S) — the subtle part: `shq_pivot_snapshots` has no
 * tenant key at all (it predates `core/tenant.ts`), so every snapshot goes
 * into ONE catch-all case, `MIGRATION_CASE_NAME`, keyed `unknown` exactly
 * as N2's migration paragraph specifies. `shq_runs_<tenantKey>`, however,
 * already carries a REAL resolved `TenantKey` per buffer (phase 4 already
 * hashes it before storing) — dumping all of those into the same
 * `unknown`-keyed case would make them INVISIBLE through 5b's own
 * partitioning (`listCasesInScope`/`isCaseInScope` only match a case whose
 * `tenantKeys` includes the key being viewed) the moment the user looks at
 * that real tenant again: exactly the "migration succeeds but the user
 * sees nothing" failure this item calls out. So runs are routed to ONE
 * MIGRATION CASE PER DISTINCT REAL TENANT KEY instead (`findOrCreateCase`
 * below, keyed by that real key) — a run whose key happens to be `unknown`
 * (capture never resolved a resourceId/tid) still lands in the one
 * snapshot catch-all case, since `unknown` IS that case's key.
 *
 * IDEMPOTENCY: `shq_migration_v2` is the primary guard (a second call is a
 * no-op). For the "flag absent but a previous run got partway through"
 * case, every copy step also dedupes by id against what the destination
 * case ALREADY holds (`getCaseSnapshots`/`getCaseRuns`) before appending,
 * and the destination case itself is found-or-created by a stable
 * `(name, tenantKeys)` match rather than created unconditionally — so a
 * retry converges instead of duplicating. This is also exactly why the
 * flag is written LAST, after every copy succeeded: a throw anywhere above
 * that line leaves the flag unset, the (possibly partial) destination
 * case(s) already deduped against, and the old keys completely untouched —
 * the next call just picks up where the last one stopped.
 *
 * LOGGING: ids and counts only, per the project's logging convention —
 * never a tenant key (even hashed), a case name or a snapshot/run value.
 */

// ── The migration's catch-all / per-key case name ──
//
// `MIGRATION_CASE_NAME` ('Historique avant cas') lives in `core/cases.ts` next
// to `systemKindOf()`: it is STORED data kept in French as older versions wrote
// it. The new case also carries `system: 'migration'`, and the UI displays a
// translated label through `ui/case-name.ts` (the stored name is not changed).
export { MIGRATION_CASE_NAME };

// ── Migration flag (`shq_migration_v2`) ──

interface MigrationFlag {
  readonly confirmedAt: number;
}

function readFlag(): MigrationFlag | null {
  const raw = getJson<unknown>(STORAGE_KEYS.MIGRATION_V2, null);
  if (typeof raw !== 'object' || raw === null) return null;
  const confirmedAt = (raw as Record<string, unknown>).confirmedAt;
  return typeof confirmedAt === 'number' ? { confirmedAt } : null;
}

function writeFlag(): void {
  setJson(STORAGE_KEYS.MIGRATION_V2, { confirmedAt: Date.now() });
}

/** True once the copy below has fully succeeded at least once. */
export function isMigrationConfirmed(): boolean {
  return readFlag() !== null;
}

/** `undefined` before the first successful migration. */
export function getMigrationConfirmedAt(): number | undefined {
  return readFlag()?.confirmedAt;
}

// ── Old-data probes (read-only) ──

export function hasOldSnapshots(): boolean {
  return listSnapshots().length > 0;
}

export function hasOldRuns(): boolean {
  return getKnownTenantKeys().some((key) => getRuns(key).length > 0);
}

/** Anything left for the migration to copy, or for "Supprimer l'ancien historique" to remove. */
export function hasOldHistory(): boolean {
  return hasOldSnapshots() || hasOldRuns();
}

// ── Export (rule 8 "propose un export avant") ──

export interface MigrationExport {
  readonly format: 'easypivot-migration-export';
  readonly version: 1;
  readonly exportedAt: number;
  readonly snapshots: readonly PivotSnapshot[];
  /** Hashed TenantKey -> its runs, same "empreintes, jamais les identifiants" rule as a case export (N2). */
  readonly runs: Readonly<Record<string, readonly QueryRun[]>>;
}

/**
 * Read-only snapshot of everything the migration would copy, for the
 * user-initiated JSON download (hard constraint: offered before anything
 * is written, and the download itself is the only route this data leaves
 * the browser by). Degrades to an empty part rather than failing the whole
 * export if one source cannot be read.
 */
export function buildMigrationExport(): MigrationExport {
  let snapshots: readonly PivotSnapshot[] = [];
  try {
    snapshots = listSnapshots();
  } catch (err) {
    log.error('migration: export - could not read old snapshots', err);
  }

  const runs: Record<string, readonly QueryRun[]> = {};
  try {
    for (const key of getKnownTenantKeys()) {
      const list = getRuns(key);
      if (list.length > 0) runs[key] = list;
    }
  } catch (err) {
    log.error('migration: export - could not read old runs', err);
  }

  return { format: 'easypivot-migration-export', version: 1, exportedAt: Date.now(), snapshots, runs };
}

// ── Destination case lookup (stable across retries - see file header) ──

function findOrCreateCase(key: TenantKey): string | null {
  const existing = getCaseIndexEntries().find(
    (c) => systemKindOf(c) === 'migration' && c.tenantKeys.length === 1 && c.tenantKeys[0] === key,
  );
  if (existing) return existing.id;

  const result = createCase({ name: MIGRATION_CASE_NAME, tenantKeys: [key], system: 'migration' });
  if (!result.ok) {
    log.error('migration: could not create the destination case', { reason: result.reason });
    return null;
  }
  return result.case.id;
}

// ── Copy steps (dedupe by id, oldest-first append - see file header) ──

/**
 * Both `listSnapshots()` and `getRuns()` return newest-first, and
 * `appendSnapshotToCase`/`appendRunToCase` each PREPEND. Appending
 * oldest-first here reconstructs the exact original newest-first order in
 * the destination on a clean run; already-present ids (a resumed
 * half-finished run) are skipped rather than re-appended.
 */
function copySnapshots(caseId: string, snapshots: readonly PivotSnapshot[]): number {
  const existingIds = new Set(getCaseSnapshots(caseId).map((s) => s.id));
  let copied = 0;
  for (const snapshot of [...snapshots].reverse()) {
    if (existingIds.has(snapshot.id)) continue;
    const result = appendSnapshotToCase(caseId, snapshot);
    if (result.ok) copied++;
    else log.error('migration: snapshot append refused', { caseId, reason: result.reason });
  }
  return copied;
}

function copyRuns(caseId: string, runs: readonly QueryRun[]): number {
  const existingIds = new Set(getCaseRuns(caseId).map((r) => r.id));
  let copied = 0;
  for (const run of [...runs].reverse()) {
    if (existingIds.has(run.id)) continue;
    const result = appendRunToCase(caseId, run);
    if (result.ok) copied++;
    else log.error('migration: run append refused', { caseId, reason: result.reason });
  }
  return copied;
}

// ── The orchestrator ──

export interface MigrationResult {
  readonly ran: boolean;
  readonly reason?: 'already-migrated' | 'nothing-to-migrate' | 'error';
  readonly caseIds: readonly string[];
  readonly snapshotsCopied: number;
  readonly runsCopied: number;
}

const NOTHING: Omit<MigrationResult, 'reason'> = { ran: false, caseIds: [], snapshotsCopied: 0, runsCopied: 0 };

/**
 * Idempotent entry point, safe to call on every page load (hard
 * constraint 1: never throws into the page). First call with real old
 * data creates/reuses the destination case(s), copies everything not
 * already there, and writes `shq_migration_v2` LAST. Any later call, or
 * one with nothing to migrate, is a cheap no-op. A failure anywhere
 * (caught here) leaves the flag unset and the old keys untouched, so the
 * next call retries from wherever the dedupe-by-id checks say it should.
 */
export function runMigrationIfNeeded(options?: {
  readonly force?: boolean;
  /** `false` = leave `shq_pivot_snapshots` out of this run (see `deleteOldHistory`). Default true. */
  readonly snapshots?: boolean;
}): MigrationResult {
  try {
    // `force` re-runs the COPY even once the flag is set. It exists for
    // `deleteOldHistory()`, so that deleting can never destroy an entry that was
    // never copied. Snapshots needed it while the live pivot path still wrote
    // `shq_pivot_snapshots` (real data loss, reproduced in 5c); since 5e-1 only the
    // run buffers `shq_runs_<key>` can still receive uncopied entries, hence the
    // `snapshots: false` option that `deleteOldHistory()` passes.
    // Safe to repeat: findOrCreateCase matches an existing case and every
    // append dedupes by id, so a forced run converges instead of duplicating.
    if (!options?.force && readFlag() !== null) {
      log.debug('migration: already confirmed, nothing to do');
      return { ...NOTHING, reason: 'already-migrated' };
    }

    const oldSnapshots = options?.snapshots === false ? [] : listSnapshots();
    const runsByKey = new Map<TenantKey, readonly QueryRun[]>();
    for (const key of getKnownTenantKeys()) {
      const runs = getRuns(key);
      if (runs.length > 0) runsByKey.set(key, runs);
    }

    if (oldSnapshots.length === 0 && runsByKey.size === 0) {
      log.debug('migration: nothing to migrate');
      return { ...NOTHING, reason: 'nothing-to-migrate' };
    }

    const caseIds = new Set<string>();
    let snapshotsCopied = 0;
    let runsCopied = 0;

    let snapshotCaseId: string | null = null;
    if (oldSnapshots.length > 0) {
      snapshotCaseId = findOrCreateCase(UNKNOWN_KEY);
      if (snapshotCaseId === null) throw new Error('migration: no destination case for the old snapshot journal');
      caseIds.add(snapshotCaseId);
      snapshotsCopied = copySnapshots(snapshotCaseId, oldSnapshots);
    }

    for (const [key, runs] of runsByKey) {
      // The `unknown` buffer, if any, reuses the SAME case the snapshots
      // just went into (both mean "no real tenant known") rather than a
      // second case with an identical key.
      const caseId = key === UNKNOWN_KEY && snapshotCaseId !== null ? snapshotCaseId : findOrCreateCase(key);
      if (caseId === null) {
        log.error('migration: no destination case for one tenant key, its runs are skipped this run');
        continue;
      }
      caseIds.add(caseId);
      runsCopied += copyRuns(caseId, runs);
    }

    writeFlag();
    log.info('migration: completed', { cases: caseIds.size, snapshotsCopied, runsCopied });
    return { ran: true, caseIds: [...caseIds], snapshotsCopied, runsCopied };
  } catch (err) {
    log.error('migration: failed, old keys untouched, will retry on next load', err);
    return { ...NOTHING, reason: 'error' };
  }
}

// ── Destructive step, gated (hard constraint: never automatic) ──

export interface DeleteOldHistoryResult {
  readonly deletedSnapshotsKey: boolean;
  readonly deletedRunKeys: number;
}

/**
 * The ONLY function in this module that deletes anything, and the ONLY
 * caller is the Settings "Supprimer l'ancien historique" button, after an
 * explicit confirmation there. Refuses (no-op) unless the migration is
 * already confirmed — belt-and-braces, so the data this module exists to
 * protect can never be deleted out from under a copy that never finished.
 * Removes `shq_pivot_snapshots`, every `shq_runs_<tenantKey>` and the
 * runs index; `shq_cases`, every `shq_case_<id>` and `shq_migration_v2`
 * itself are never touched.
 */
export function deleteOldHistory(): DeleteOldHistoryResult {
  try {
    if (!isMigrationConfirmed()) {
      log.warn('migration: delete-old-history refused, migration is not confirmed yet');
      return { deletedSnapshotsKey: false, deletedRunKeys: 0 };
    }

    // Catch up RUNS recorded since the first migration BEFORE deleting: the capture fallback
    // still writes `shq_runs_<key>` while no case covers a key, so deleting those buffers
    // would destroy runs that were never copied. Snapshots are deliberately NOT caught up:
    // since 5e-1 nothing writes `shq_pivot_snapshots`, so there is nothing new to save, and
    // re-copying them would resurrect, as a fresh case, history the user already deleted
    // with Settings -> Cases before asking to delete the old history.
    const caughtUp = runMigrationIfNeeded({ force: true, snapshots: false });
    if (caughtUp.snapshotsCopied > 0 || caughtUp.runsCopied > 0) {
      log.info('migration: caught up entries recorded after the first migration, before deleting', {
        snapshotsCopied: caughtUp.snapshotsCopied,
        runsCopied: caughtUp.runsCopied,
      });
    }

    const tenantKeys = getKnownTenantKeys();
    deleteKey(STORAGE_KEYS.SNAPSHOTS);
    for (const key of tenantKeys) deleteKey(`${STORAGE_KEYS.RUNS_PREFIX}${key}`);
    deleteKey(STORAGE_KEYS.RUNS_INDEX);

    log.info('migration: old history deleted', { tenantKeysCleared: tenantKeys.length });
    return { deletedSnapshotsKey: true, deletedRunKeys: tenantKeys.length };
  } catch (err) {
    log.error('migration: delete-old-history failed', err);
    return { deletedSnapshotsKey: false, deletedRunKeys: 0 };
  }
}
