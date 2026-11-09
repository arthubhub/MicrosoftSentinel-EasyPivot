import type { Case, IndicatorId, PivotRule, QueryRun, Scenario } from '../types.ts';
import { getCatalog, getRuleById } from './pivot.ts';
import { getCase, getCaseRuns, setCasePlaybook } from './cases.ts';
import { extractResultValues, type ResultValue } from './result-values.ts';
import type { CapturedRowSet } from '../capture/interceptor.ts';
import { log } from './log.ts';

/**
 * Guided playbooks (N4, #32). A scenario is a chain of rules published by the
 * rules repo; the case remembers where the analyst is (`case.playbook`), so
 * the progress survives a reload and follows the case across portals.
 *
 * `step` is the index of the NEXT step to run. Running that step's rule (from
 * the playbook bar or from the rule list) marks it done and moves on; "Skip"
 * moves on without running; "Stop" clears `case.playbook`. When the previous
 * step has a `carry` type, values of that type are suggested from its result.
 */
export type PlaybookState = NonNullable<Case['playbook']>;

export interface PlaybookView {
  readonly scenario: Scenario;
  readonly state: PlaybookState;
  /** undefined once every step is done */
  readonly current?: { readonly index: number; readonly rule: PivotRule };
  /** Type the current step works on (scenario indicator, or the last `carry` before it) */
  readonly type: IndicatorId;
  /** Type to take from the previous step's result, if it declared one */
  readonly carry?: IndicatorId;
  readonly finished: boolean;
}

/** Scenarios whose every rule exists in the current catalog (the others are ignored, see catalog-validate.ts). */
export function listScenarios(type?: IndicatorId): readonly Scenario[] {
  const all = getCatalog().scenarios ?? [];
  return all.filter(
    (sc) =>
      Array.isArray(sc?.steps) &&
      sc.steps.length > 0 &&
      sc.steps.every((st) => typeof st?.ruleId === 'string' && getRuleById(st.ruleId)) &&
      (!type || sc.indicator === type),
  );
}

function scenarioById(id: string): Scenario | undefined {
  return listScenarios().find((sc) => sc.id === id);
}

/** Type in force at step `index`: the scenario's, changed by each `carry` before it. */
function typeAt(scenario: Scenario, index: number): IndicatorId {
  let type = scenario.indicator;
  for (let i = 0; i < index && i < scenario.steps.length; i++) type = scenario.steps[i].carry ?? type;
  return type;
}

export function viewPlaybook(caseId: string | undefined): PlaybookView | undefined {
  if (!caseId) return undefined;
  const state = getCase(caseId)?.playbook;
  if (!state) return undefined;
  const scenario = scenarioById(state.id);
  if (!scenario) return undefined; // scenario gone from the catalog: nothing to show
  const finished = state.step >= scenario.steps.length;
  const rule = finished ? undefined : getRuleById(scenario.steps[state.step].ruleId);
  return {
    scenario,
    state,
    current: rule ? { index: state.step, rule } : undefined,
    type: typeAt(scenario, Math.min(state.step, scenario.steps.length)),
    carry: state.step > 0 ? scenario.steps[state.step - 1].carry : undefined,
    finished,
  };
}

export function startPlaybook(caseId: string, scenarioId: string): boolean {
  if (!scenarioById(scenarioId)) return false;
  const res = setCasePlaybook(caseId, { id: scenarioId, step: 0, done: [], values: {} });
  log.info('playbook: started', { scenario: scenarioId, ok: res.ok });
  return res.ok;
}

export function stopPlaybook(caseId: string): void {
  setCasePlaybook(caseId, undefined);
  log.info('playbook: stopped');
}

/** Move past the current step; `ranRuleId` set = it was run (recorded in `done`), else skipped. */
export function advancePlaybook(caseId: string, ranRuleId?: string): void {
  const view = viewPlaybook(caseId);
  if (!view || view.finished) return;
  const done = ranRuleId ? [...view.state.done, ranRuleId] : view.state.done;
  setCasePlaybook(caseId, { ...view.state, step: view.state.step + 1, done });
  log.info('playbook: step done', { scenario: view.scenario.id, step: view.state.step + 1, ran: !!ranRuleId });
}

/** Called after any rule ran: advances only when it is the current step's rule. */
export function onRuleRan(caseId: string, ruleId: string): void {
  const view = viewPlaybook(caseId);
  if (view?.current && view.current.rule.id === ruleId) advancePlaybook(caseId, ruleId);
}

/**
 * Values of the `carry` type taken from the previous step's result: the
 * in-memory last capture when it is that step's run (raw, all rows), else the
 * latest stored run of that rule in the case (its kept sample).
 */
export function carrySuggestions(caseId: string, last: CapturedRowSet | null): readonly ResultValue[] {
  const view = viewPlaybook(caseId);
  if (!view?.carry || view.state.step === 0) return [];
  const prevRuleId = view.scenario.steps[view.state.step - 1].ruleId;
  let columns: CapturedRowSet['columns'] | undefined;
  let rows: CapturedRowSet['rows'] | undefined;
  let tables: readonly string[] | undefined;
  if (last && last.ruleId === prevRuleId) {
    ({ columns, rows, sourceTables: tables } = last);
  } else {
    const run: QueryRun | undefined = [...getCaseRuns(caseId)]
      .filter((r) => r.ruleId === prevRuleId && (r.rowsSample?.length ?? 0) > 0)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (run) {
      columns = run.columns;
      rows = run.rowsSample;
      tables = run.sourceTables;
    }
  }
  if (!columns || !rows) return [];
  return extractResultValues(columns, rows, { sourceTables: tables }).get(view.carry) ?? [];
}
