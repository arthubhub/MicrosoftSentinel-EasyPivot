import type { IndicatorId, PivotRule, Scenario } from '../../types.ts';
import type { ResultValue } from '../../core/result-values.ts';
import type { PlaybookView as PlaybookModel } from '../../core/playbooks.ts';
import { CSS_PREFIX } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

/**
 * Playbook bar (N4, #32): "Start a playbook" when scenarios exist for the
 * selected type; once started, "Step n/N: <rule>" with Run / Skip / Stop, and
 * the values of the carried type taken from the previous step's result.
 */
export interface PlaybookBar {
  readonly root: HTMLDivElement;
  render(args: {
    readonly model: PlaybookModel | undefined;
    readonly available: readonly Scenario[];
    readonly suggestions: readonly ResultValue[];
    readonly caseWritable: boolean;
    readonly onStart: (scenarioId: string) => void;
    readonly onRun: (rule: PivotRule) => void;
    readonly onSkip: () => void;
    readonly onStop: () => void;
    readonly onPickValue: (value: ResultValue, type: IndicatorId) => void;
  }): void;
}

export function createPlaybookBar(): PlaybookBar {
  const root = el('div', `${P}-playbook`);
  root.hidden = true;

  const render: PlaybookBar['render'] = (a) => {
    root.replaceChildren();
    const { model } = a;
    if (!model) {
      if (a.available.length === 0 || !a.caseWritable) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const row = el('div', `${P}-row`);
      const select = el('select', `${P}-input ${P}-playbook-select`);
      select.setAttribute('aria-label', t('playbook.choose'));
      for (const sc of a.available) {
        const o = el('option', '', `${sc.name} (${sc.steps.length})`);
        o.value = sc.id;
        o.title = sc.description;
        select.appendChild(o);
      }
      const start = button(`${P}-btn`, t('playbook.start'), t('playbook.startTitle'));
      start.addEventListener('click', () => a.onStart(select.value));
      row.append(el('span', `${P}-field-label`, t('playbook.label')), select, start);
      root.appendChild(row);
      return;
    }

    root.hidden = false;
    const total = model.scenario.steps.length;
    const head = el('div', `${P}-row ${P}-playbook-head`);
    head.appendChild(el('span', `${P}-playbook-name`, model.scenario.name));
    if (model.finished) head.appendChild(el('span', `${CSS_PREFIX}-badge`, t('playbook.finished')));
    else head.appendChild(el('span', `${CSS_PREFIX}-badge`, t('playbook.step', { n: model.state.step + 1, total })));
    const stop = button(`${P}-btn`, model.finished ? t('playbook.close') : t('playbook.stop'));
    stop.addEventListener('click', () => a.onStop());
    head.appendChild(stop);
    root.appendChild(head);

    // Progress: one dot per step (done / skipped / current / to do)
    const dots = el('div', `${P}-playbook-steps`);
    model.scenario.steps.forEach((st, i) => {
      const state = i < model.state.step ? (model.state.done.includes(st.ruleId) ? 'done' : 'skipped') : i === model.state.step ? 'current' : 'todo';
      const d = el('span', `${P}-playbook-dot ${P}-playbook-dot--${state}`, st.ruleId);
      d.title = t(`playbook.dot.${state}`);
      dots.appendChild(d);
    });
    root.appendChild(dots);

    if (model.current) {
      const cur = el('div', `${P}-row`);
      cur.appendChild(el('span', `${P}-playbook-rule`, `${model.current.rule.name} (${model.current.rule.id})`));
      const run = button(`${P}-btn ${P}-btn--primary`, t('playbook.run'), t('playbook.runTitle'));
      run.disabled = !a.caseWritable;
      run.addEventListener('click', () => model.current && a.onRun(model.current.rule));
      const skip = button(`${P}-btn`, t('playbook.skip'));
      skip.disabled = !a.caseWritable;
      skip.addEventListener('click', () => a.onSkip());
      cur.append(run, skip);
      root.appendChild(cur);
    }

    if (model.carry && !model.finished) {
      const carryType = model.carry;
      if (a.suggestions.length) {
        const wrap = el('div', `${P}-result-group`);
        wrap.appendChild(el('span', `${P}-result-type`, t('playbook.carry')));
        for (const v of a.suggestions) {
          const chip = button(`${CSS_PREFIX}-category-chip ${P}-field-chip ${P}-result-chip`, `${v.value} · ${v.count}`,
            t('panel.context.resultValueTitle', { value: v.value, column: v.column, n: v.count }));
          chip.addEventListener('click', () => a.onPickValue(v, carryType));
          wrap.appendChild(chip);
        }
        root.appendChild(wrap);
      } else {
        root.appendChild(el('div', `${P}-status`, t('playbook.carryNone')));
      }
    }
  };

  return { root, render };
}
