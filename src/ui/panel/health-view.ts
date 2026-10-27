import type { ProbeState } from '../../types.ts';
import { CSS_PREFIX } from '../../config.ts';
import { getProbeLabel, getStateLabel, type HealthReport } from '../../core/health.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

/** N6 diagnostics section (#12): read-only probe list + refresh/copy actions. */

const DOT_CLASS: Record<ProbeState, string> = {
  ok: `${P}-health-dot--ok`,
  warn: `${P}-health-dot--warn`,
  fail: `${P}-health-dot--fail`,
  pending: `${P}-health-dot--pending`,
};

export interface HealthView {
  readonly root: HTMLDivElement;
  readonly refreshBtn: HTMLButtonElement;
  readonly copyBtn: HTMLButtonElement;
  renderReport(report: HealthReport | null): void;
}

export function createHealthView(): HealthView {
  const health = el('div', `${P}-health`);
  health.hidden = true;

  const actions = el('div', `${P}-actions`);
  const refreshBtn = button(`${P}-btn`, t('health.refresh'));
  const copyBtn = button(`${P}-btn`, t('health.copy'));
  actions.append(refreshBtn, copyBtn);

  const list = el('div', `${P}-health-list`);
  health.append(actions, list);

  function renderReport(report: HealthReport | null): void {
    list.replaceChildren();
    if (!report) {
      list.appendChild(el('div', `${CSS_PREFIX}-empty`, t('health.notRun')));
      return;
    }
    for (const probe of report.probes) {
      const row = el('div', `${P}-health-row`);
      const dot = el('span', `${P}-health-dot ${DOT_CLASS[probe.state]}`);
      dot.title = getStateLabel(probe.state);
      const label = el('span', `${P}-health-label`, getProbeLabel(probe.id));
      const message = el('span', `${P}-health-message`, probe.message);
      row.append(dot, label, message);
      list.appendChild(row);
    }
  }

  return { root: health, refreshBtn, copyBtn, renderReport };
}
