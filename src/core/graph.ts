import type { IndicatorId, PivotSnapshot, QueryRun } from '../types.ts';
import { getCaseRuns, getCaseSnapshots } from './cases.ts';
import { log } from './log.ts';

/**
 * Investigation graph (N3, phase 5e-1). Pure logic, no DOM: reads one case's
 * snapshots and runs THROUGH `core/cases.ts` (the only storage dependency)
 * and returns plain data for the case view (5e-2) and the report (5f).
 *
 * Node = snapshot (the event a pivot started from). Edge = pivot: a snapshot
 * is the child of the snapshot whose result it was right-clicked in
 * (`parentSnapshotId`, set by `cases.ts` only on an exact run-id match - see
 * `recordSnapshotInCase`). Nothing here infers a link: a snapshot without a
 * usable `parentSnapshotId` is a root.
 *
 * ROBUSTNESS (stored data is old, imported or hand-edited, so the structure
 * is never trusted):
 *  - orphan `parentSnapshotId` (parent deleted, capped out, never imported)
 *    -> the node becomes a ROOT, it is never dropped;
 *  - self-parent and cycles (A->B->A, longer loops) -> broken explicitly,
 *    see `breakCycles()`: each cycle yields one root (its earliest snapshot),
 *    so every node is reachable and no traversal can loop;
 *  - empty case, unknown case id, snapshots without steps, missing runs,
 *    runs linked to a snapshot that no longer exists -> all just degrade
 *    (`roots: []`, `lastResult: null`, ...), nothing throws.
 */

// ── Result shapes ──

/** Outcome of a run, without any value: counts and flags only. */
export interface RunStatus {
  readonly rows: number;
  readonly truncated: boolean;
  readonly error: boolean;
}

export interface TreeNode {
  readonly snapshotId: string;
  readonly value: string;
  readonly column: string;
  /** ISO 8601 from the grid, '' if unknown */
  readonly t0: string;
  /** Number of pivots launched from this node (= its steps) */
  readonly pivotCount: number;
  /** Latest linked run's outcome; `null` = no linked run (capture off, never run, purged) */
  readonly lastResult: RunStatus | null;
  readonly hasNote: boolean;
  readonly pinnedCount: number;
  /** The run this node was right-clicked in, when it has a parent */
  readonly parentRunId?: string;
  /** Oldest first */
  readonly children: readonly TreeNode[];
}

export interface CaseTree {
  readonly roots: readonly TreeNode[];
}

export interface TimelineEntry {
  readonly at: number;
  readonly snapshotId: string;
  readonly ruleId: string;
  readonly value: string;
  readonly indicator: IndicatorId;
  /** Rows of the run matched to this step; `null` when no run is matched */
  readonly rows: number | null;
  readonly truncated: boolean;
  readonly error: boolean;
}

// ── Helpers ──

function statusOf(run: QueryRun): RunStatus {
  return { rows: run.rowCount, truncated: run.status === 'truncated', error: run.status === 'error' };
}

/** Runs linked to each snapshot, newest first: `run.snapshotId` and `snapshot.runIds` are both honoured. */
function linkedRunsBySnapshot(
  snapshots: readonly PivotSnapshot[],
  runs: readonly QueryRun[],
): Map<string, QueryRun[]> {
  const byId = new Map<string, QueryRun>();
  for (const run of runs) if (!byId.has(run.id)) byId.set(run.id, run);

  const out = new Map<string, QueryRun[]>();
  for (const snap of snapshots) {
    const linked = new Map<string, QueryRun>();
    for (const run of runs) if (run.snapshotId === snap.id) linked.set(run.id, run);
    for (const id of snap.runIds ?? []) {
      const run = byId.get(id);
      if (run) linked.set(run.id, run);
    }
    out.set(snap.id, [...linked.values()].sort((a, b) => b.startedAt - a.startedAt));
  }
  return out;
}

/**
 * Parent of each snapshot, after validation: `null` = root. A parent that is
 * missing, or the node itself, is dropped here; cycles are broken afterwards.
 * Duplicate ids keep the first occurrence only (ids are unique in storage;
 * this just keeps the maps well defined on corrupt data).
 */
function validParents(snapshots: readonly PivotSnapshot[]): Map<string, string | null> {
  const ids = new Set(snapshots.map((s) => s.id));
  const parents = new Map<string, string | null>();
  for (const snap of snapshots) {
    if (parents.has(snap.id)) continue;
    const p = snap.parentSnapshotId;
    parents.set(snap.id, typeof p === 'string' && p !== snap.id && ids.has(p) ? p : null);
  }
  return parents;
}

/**
 * Makes `parents` a forest. Walks up from every node; on meeting a node that
 * is already on the CURRENT path, that stretch is a cycle, and its earliest
 * member (createdAt, then storage order) loses its parent link and becomes a
 * root. One cut per cycle is enough, and each node is walked at most once, so
 * this terminates in O(n) whatever the data looks like.
 */
function breakCycles(
  parents: Map<string, string | null>,
  order: ReadonlyMap<string, { readonly createdAt: number; readonly index: number }>,
): number {
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = settled
  let broken = 0;
  for (const start of parents.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let cur: string | null | undefined = start;
    while (cur !== null && cur !== undefined && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = parents.get(cur);
    }
    if (cur !== null && cur !== undefined && state.get(cur) === 1) {
      const members = path.slice(path.indexOf(cur));
      let cut = members[0];
      for (const id of members) {
        const a = order.get(id);
        const b = order.get(cut);
        if (a && b && (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.index < b.index))) cut = id;
      }
      parents.set(cut, null);
      broken++;
    }
    for (const id of path) state.set(id, 2);
  }
  return broken;
}

// ── buildTree ──

/**
 * The case's event tree. Roots and siblings are ordered oldest first
 * (`createdAt`, ties by storage order) so the tree reads like the
 * investigation did.
 */
export function buildTree(caseId: string): CaseTree {
  try {
    const snapshots = getCaseSnapshots(caseId);
    if (snapshots.length === 0) return { roots: [] };
    const runs = getCaseRuns(caseId);
    const linked = linkedRunsBySnapshot(snapshots, runs);

    const parents = validParents(snapshots);
    const order = new Map<string, { createdAt: number; index: number }>();
    snapshots.forEach((s, index) => {
      if (!order.has(s.id)) order.set(s.id, { createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0, index });
    });
    const broken = breakCycles(parents, order);
    if (broken > 0) log.warn('graph: broke parent cycles in stored snapshots', { caseId, cycles: broken });

    // Build every node first, then attach: no recursion anywhere.
    interface MutableNode extends Omit<TreeNode, 'children'> {
      children: TreeNode[];
    }
    const nodes = new Map<string, MutableNode>();
    for (const snap of snapshots) {
      if (nodes.has(snap.id)) continue;
      const latest = linked.get(snap.id)?.[0];
      nodes.set(snap.id, {
        snapshotId: snap.id,
        value: snap.value,
        column: snap.column,
        t0: snap.t0,
        pivotCount: Array.isArray(snap.steps) ? snap.steps.length : 0,
        lastResult: latest ? statusOf(latest) : null,
        hasNote: typeof snap.note === 'string' && snap.note.trim() !== '',
        pinnedCount: Array.isArray(snap.pinnedRows) ? snap.pinnedRows.length : 0,
        ...(parents.get(snap.id) !== null && snap.parentRunId ? { parentRunId: snap.parentRunId } : {}),
        children: [],
      });
    }

    const chronological = [...nodes.keys()].sort((a, b) => {
      const oa = order.get(a);
      const ob = order.get(b);
      if (!oa || !ob) return 0;
      return oa.createdAt - ob.createdAt || oa.index - ob.index;
    });

    const roots: TreeNode[] = [];
    for (const id of chronological) {
      const node = nodes.get(id);
      if (!node) continue;
      const parentId = parents.get(id);
      const parent = parentId ? nodes.get(parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return { roots };
  } catch (err) {
    log.error('graph: buildTree failed', err);
    return { roots: [] };
  }
}

// ── timeline ──

/**
 * Every step of every snapshot, oldest first (ties keep snapshot then step
 * order). A step is paired with a run only through the snapshot link plus the
 * rule id: the first not-yet-used run of THAT snapshot with that `ruleId`
 * whose `startedAt` is not before the step (minus `SLACK_MS`: `autoRun`
 * clicks Run just before the step is recorded). No match -> `rows: null`, so
 * a step whose result was never captured reads as "unknown", not "0".
 */
const SLACK_MS = 5_000;

export function timeline(caseId: string): readonly TimelineEntry[] {
  try {
    const snapshots = getCaseSnapshots(caseId);
    if (snapshots.length === 0) return [];
    const linked = linkedRunsBySnapshot(snapshots, getCaseRuns(caseId));

    const entries: { entry: TimelineEntry; seq: number }[] = [];
    const seen = new Set<string>();
    let seq = 0;
    for (const snap of snapshots) {
      if (seen.has(snap.id)) continue;
      seen.add(snap.id);
      const used = new Set<string>();
      // Oldest run first so the k-th step takes the k-th run.
      const candidates = [...(linked.get(snap.id) ?? [])].reverse();
      const steps = [...(Array.isArray(snap.steps) ? snap.steps : [])].sort((a, b) => a.at - b.at);
      for (const step of steps) {
        const run = candidates.find(
          (r) => !used.has(r.id) && r.ruleId === step.ruleId && r.startedAt >= step.at - SLACK_MS,
        );
        if (run) used.add(run.id);
        entries.push({
          seq: seq++,
          entry: {
            at: step.at,
            snapshotId: snap.id,
            ruleId: step.ruleId,
            value: step.value,
            indicator: step.indicator,
            rows: run ? run.rowCount : null,
            truncated: run ? run.status === 'truncated' : false,
            error: run ? run.status === 'error' : false,
          },
        });
      }
    }
    return entries.sort((a, b) => a.entry.at - b.entry.at || a.seq - b.seq).map((e) => e.entry);
  } catch (err) {
    log.error('graph: timeline failed', err);
    return [];
  }
}
