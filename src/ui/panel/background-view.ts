import type { IndicatorId, PivotRule } from '../../types.ts';
import type { CaptureOutcome, ReplayResult } from '../../capture/interceptor.ts';
import type { ResultValue } from '../../core/result-values.ts';
import { CSS_PREFIX } from '../../config.ts';
import { getIndicatorLabel } from '../../core/pivot.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

/** Result of a background context query (#27), shown in the panel: rows, a short preview, values to pivot on. */
export interface BackgroundView {
  readonly root: HTMLDivElement;
  showPending(rule: PivotRule): void;
  showError(rule: PivotRule, message: string): void;
  showResult(
    rule: PivotRule,
    outcome: CaptureOutcome,
    values: ReadonlyMap<IndicatorId, readonly ResultValue[]>,
    onPick: (value: ResultValue, type: IndicatorId) => void,
  ): void;
}

type Reason = Extract<ReplayResult, { ok: false }>['reason'];

/** One message per refusal/failure reason (typed keys, no dynamic i18n key). */
export function backgroundReason(reason: Reason, status?: number): string {
  switch (reason) {
    case 'disabled': return t('background.reason.disabled');
    case 'no-capture': return t('background.reason.noCapture');
    case 'no-template': return t('background.reason.noTemplate');
    case 'rate-limited': return t('background.reason.rateLimited');
    case 'build': return t('background.reason.build');
    case 'network': return t('background.reason.network');
    case 'auth': return t('background.reason.auth');
    case 'http': return t('background.reason.http', { status: status ?? '' });
    default: return t('background.reason.parse');
  }
}

const PREVIEW_ROWS = 10;
const PREVIEW_COLS = 6;

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

export function createBackgroundView(): BackgroundView {
  const root = el('div', `${P}-background`);
  root.hidden = true;

  function header(rule: PivotRule, status: string): HTMLElement {
    const head = el('div', `${P}-row`);
    head.append(el('span', `${P}-field-label`, t('background.title')), el('span', `${P}-background-rule`, `${rule.name} (${rule.id})`),
      el('span', `${CSS_PREFIX}-badge`, status));
    const close = button(`${CSS_PREFIX}-icon-btn`, '✕', t('background.close'));
    close.addEventListener('click', () => {
      root.hidden = true;
      root.replaceChildren();
    });
    head.appendChild(close);
    return head;
  }

  return {
    root,
    showPending(rule) {
      root.hidden = false;
      root.replaceChildren(header(rule, t('background.running')));
    },
    showError(rule, message) {
      root.hidden = false;
      root.replaceChildren(header(rule, t('background.failedBadge')), el('div', `${P}-status ${P}-status--error`, message));
    },
    showResult(rule, outcome, values, onPick) {
      root.hidden = false;
      const r = outcome.result;
      root.replaceChildren(header(rule, r?.error ? t('background.failedBadge') : t('background.rows', { n: r?.rows.length ?? 0 })));
      if (!r) return;
      if (r.error) {
        root.appendChild(el('div', `${P}-status ${P}-status--error`, r.error));
        return;
      }
      if (r.rows.length > 0) {
        const cols = r.columns.slice(0, PREVIEW_COLS);
        const wrap = el('div', `${P}-background-table`);
        const table = el('table', '');
        const thead = el('tr', '');
        for (const c of cols) thead.appendChild(el('th', '', c.name));
        table.appendChild(thead);
        for (const row of r.rows.slice(0, PREVIEW_ROWS)) {
          const tr = el('tr', '');
          cols.forEach((_c, i) => tr.appendChild(el('td', '', cell(row[i]))));
          table.appendChild(tr);
        }
        wrap.appendChild(table);
        root.appendChild(wrap);
      }
      for (const [type, list] of values) {
        const group = el('div', `${P}-result-group`);
        group.appendChild(el('span', `${P}-result-type`, getIndicatorLabel(type)));
        for (const v of list) {
          const chip = button(`${CSS_PREFIX}-category-chip ${P}-field-chip ${P}-result-chip`, `${v.value} · ${v.count}`,
            t('panel.context.resultValueTitle', { value: v.value, column: v.column, n: v.count }));
          chip.addEventListener('click', () => onPick(v, type));
          group.appendChild(chip);
        }
        root.appendChild(group);
      }
      root.appendChild(el('div', `${P}-status`, t('background.savedHint')));
    },
  };
}
