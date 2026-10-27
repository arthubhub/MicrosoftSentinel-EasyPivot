import type { CellContext, IndicatorId, PivotSnapshot } from '../../types.ts';
import { detectForCell } from '../../core/detection.ts';
import { getIndicatorLabel } from '../../core/pivot.ts';
import { CSS_PREFIX } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button } from './shared.ts';

const MAX_FIELD_CHIPS = 30;

function short(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function snapshotLabel(s: PivotSnapshot): string {
  const origin = s.originRuleId ? t('panel.context.originSuffix', { id: s.originRuleId }) : '';
  const col = s.column ? `${s.column} = ` : '';
  const steps = s.steps.length
    ? t('panel.context.stepsSuffix', { n: s.steps.length, s: s.steps.length > 1 ? 's' : '' })
    : '';
  return `${formatTime(s.createdAt)} · ${col}${short(s.value, 40)}${origin}${steps}`;
}

export interface ContextView {
  readonly root: HTMLDivElement;
  readonly historySelect: HTMLSelectElement;
  readonly restoreBtn: HTMLButtonElement;
  renderContext(
    snapshots: readonly PivotSnapshot[],
    snap: PivotSnapshot | undefined,
    pendingCtx: CellContext | null,
    row: Readonly<Record<string, string>>,
    value: string,
    onFieldChipClick: (value: string, indicator: IndicatorId) => void,
  ): void;
  renderFields(
    row: Readonly<Record<string, string>>,
    value: string,
    onFieldChipClick: (value: string, indicator: IndicatorId) => void,
  ): void;
}

export function createContextView(): ContextView {
  // Context (investigation journal)
  const context = el('div', `${P}-context`);
  const contextRow = el('div', `${P}-row`);
  const historyWrap = el('label', `${P}-field ${P}-field--grow`);
  historyWrap.appendChild(el('span', `${P}-field-label`, t('panel.context.eventLabel')));
  const historySelect = el('select', `${P}-input ${P}-history`);
  historyWrap.appendChild(historySelect);
  const restoreBtn = button(`${P}-btn ${P}-restore`, t('panel.context.restoreLabel'));
  contextRow.append(historyWrap, restoreBtn);
  const fieldsLabel = el('span', `${P}-field-label`, t('panel.context.fieldsLabel'));
  const fields = el('div', `${P}-fields`);
  const steps = el('div', `${P}-steps`);
  context.append(contextRow, fieldsLabel, fields, steps);

  function renderContext(
    snapshots: readonly PivotSnapshot[],
    snap: PivotSnapshot | undefined,
    pendingCtx: CellContext | null,
    row: Readonly<Record<string, string>>,
    value: string,
    onFieldChipClick: (value: string, indicator: IndicatorId) => void,
  ): void {
    historySelect.replaceChildren();
    if (pendingCtx && !snap) {
      const opt = el(
        'option',
        '',
        t('panel.context.currentClick', { column: pendingCtx.column, value: short(pendingCtx.value, 40) }),
      );
      opt.value = '';
      historySelect.appendChild(opt);
    } else if (!snap) {
      const opt = el(
        'option',
        '',
        snapshots.length ? t('panel.context.chooseEvent') : t('panel.context.noEvent'),
      );
      opt.value = '';
      historySelect.appendChild(opt);
    }
    for (const s of snapshots) {
      const opt = el('option', '', snapshotLabel(s));
      opt.value = s.id;
      opt.title = s.t0Raw || s.t0;
      historySelect.appendChild(opt);
    }
    historySelect.value = snap?.id ?? '';
    historySelect.disabled = snapshots.length === 0 && !pendingCtx;

    restoreBtn.disabled = !snap?.sourceQuery;
    restoreBtn.title =
      snap && !snap.sourceQuery
        ? t('panel.context.sourceNotSaved')
        : t('panel.context.restoreHint');

    renderFields(row, value, onFieldChipClick);

    steps.replaceChildren();
    if (snap?.steps.length) {
      steps.appendChild(el('span', `${P}-field-label`, t('panel.context.pivotsLaunched')));
      steps.appendChild(
        document.createTextNode(
          snap.steps.map((s) => `${s.ruleId} (${short(s.value, 24)})`).join(' · '),
        ),
      );
    }

    context.hidden = snapshots.length === 0 && !pendingCtx;
  }

  function renderFields(
    row: Readonly<Record<string, string>>,
    value: string,
    onFieldChipClick: (value: string, indicator: IndicatorId) => void,
  ): void {
    fields.replaceChildren();
    const current = value.trim();
    let count = 0;
    for (const [col, val] of Object.entries(row)) {
      if (count >= MAX_FIELD_CHIPS) break;
      // No entityName here: only the originally right-clicked cell carries
      // one, not every field of the row (render loop — not logged, #18).
      const detected = detectForCell(val, col).candidates;
      if (detected.length === 0) continue;
      count++;
      let cls = `${CSS_PREFIX}-category-chip ${P}-field-chip`;
      if (val === current) cls += ` ${CSS_PREFIX}-category-chip--active`;
      const chip = button(cls, `${col} : ${short(val, 32)}`, `${val}\n(${detected.map(getIndicatorLabel).join(', ')})`);
      chip.addEventListener('click', () => {
        onFieldChipClick(val, detected[0]);
      });
      fields.appendChild(chip);
    }
    fieldsLabel.hidden = count === 0;
    fields.hidden = count === 0;
  }

  return { root: context, historySelect, restoreBtn, renderContext, renderFields };
}
