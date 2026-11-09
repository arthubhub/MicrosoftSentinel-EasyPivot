import type { IndicatorId, PivotRule, PivotSnapshot, PivotStep, QueryRun } from '../types.ts';
import { getRuleById } from './pivot.ts';

/**
 * What a captured query was (U4, A1.4): the pivot rule behind it, the value
 * and indicator type it ran on, or "manual" when no pivot launched it.
 * Pure: no DOM, no storage; the rule lookup is injectable for the harness.
 *
 * Linking: a run carries `snapshotId` + `ruleId` when W2 matched it to a
 * pivot. The step is the one of that snapshot with the same rule, launched
 * last before the run started (a rule re-run on the same snapshot with a
 * hand-edited value gives several steps: the closest one wins).
 */
export interface RunInfo {
  readonly origin: 'pivot' | 'manual';
  /** '' for a manual query without a `// [RULE-ID]` header */
  readonly ruleId: string;
  /** Catalog name; falls back to the id; '' when there is no rule */
  readonly ruleName: string;
  /** Value pivoted on ('' when unknown) */
  readonly value: string;
  readonly indicator?: IndicatorId;
  /** Snapshot the run belongs to, if any */
  readonly snapshotId?: string;
}

export type RuleLookup = (id: string) => Pick<PivotRule, 'name'> | undefined;

function stepFor(snapshot: PivotSnapshot, ruleId: string, startedAt: number): PivotStep | undefined {
  let best: PivotStep | undefined;
  for (const step of snapshot.steps) {
    if (step.ruleId !== ruleId) continue;
    // Steps launched after the run started cannot have produced it (2 s clock slack)
    if (step.at > startedAt + 2000) continue;
    if (!best || step.at > best.at) best = step;
  }
  // No step old enough: take any step of that rule rather than nothing
  return best ?? snapshot.steps.find((s) => s.ruleId === ruleId);
}

export function describeRun(
  run: Pick<QueryRun, 'ruleId' | 'snapshotId' | 'startedAt'>,
  snapshots: readonly PivotSnapshot[],
  lookup: RuleLookup = getRuleById,
): RunInfo {
  const ruleId = run.ruleId ?? '';
  const ruleName = ruleId ? (lookup(ruleId)?.name ?? ruleId) : '';
  const snapshot = run.snapshotId ? snapshots.find((s) => s.id === run.snapshotId) : undefined;
  if (!snapshot) {
    // A rule header without a matched pivot (query re-run by hand, or its snapshot was dropped)
    return { origin: ruleId ? 'pivot' : 'manual', ruleId, ruleName, value: '' };
  }
  const step = ruleId ? stepFor(snapshot, ruleId, run.startedAt) : undefined;
  return {
    origin: ruleId ? 'pivot' : 'manual',
    ruleId,
    ruleName,
    value: step?.value ?? snapshot.value,
    indicator: step?.indicator,
    snapshotId: snapshot.id,
  };
}
