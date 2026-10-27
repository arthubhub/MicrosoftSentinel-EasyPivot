import type { IndicatorId } from '../../types.ts';
import {
  detectIndicators,
  getIndicatorIds,
  getIndicatorLabel,
  indicatorHasHostRules,
} from '../../core/pivot.ts';
import { CSS_PREFIX } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import { P, el, button, field } from './shared.ts';

export interface ParamsView {
  readonly root: HTMLDivElement;
  readonly valueField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly t0Field: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly beforeField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly afterField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly hostField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  renderTypes(selected: IndicatorId, onSelect: (id: IndicatorId) => void): void;
}

export function createParamsView(): ParamsView {
  const params = el('div', `${P}-params`);
  const valueField = field(t('panel.params.valueLabel'), 'wide', t('panel.params.valuePlaceholder'));
  const types = el('div', `${P}-types`);
  const timeRow = el('div', `${P}-row`);
  const t0Field = field(t('panel.params.t0Label'), 'grow', t('panel.params.t0Placeholder'));
  const beforeField = field(t('panel.params.beforeLabel'), '', t('common.default'));
  const afterField = field(t('panel.params.afterLabel'), '', t('common.default'));
  const windowHint = t('panel.params.windowHint');
  beforeField.input.title = windowHint;
  afterField.input.title = windowHint;
  timeRow.append(t0Field.wrap, beforeField.wrap, afterField.wrap);
  const hostField = field(t('panel.params.hostLabel'), 'wide', t('panel.params.hostPlaceholder'));
  params.append(valueField.wrap, types, timeRow, hostField.wrap);

  function renderTypes(selected: IndicatorId, onSelect: (id: IndicatorId) => void): void {
    const value = valueField.input.value;
    const matches = new Set(detectIndicators(value));
    types.replaceChildren();
    for (const id of getIndicatorIds()) {
      const match = matches.has(id);
      let cls = `${CSS_PREFIX}-category-chip ${P}-type`;
      if (match) cls += ` ${P}-type--match`;
      if (id === selected) cls += ` ${CSS_PREFIX}-category-chip--active`;
      const chip = button(
        cls,
        getIndicatorLabel(id),
        match ? t('panel.params.typeMatches') : t('panel.params.typeMismatch'),
      );
      chip.addEventListener('click', () => {
        onSelect(id);
      });
      types.appendChild(chip);
    }
    hostField.wrap.hidden = !indicatorHasHostRules(selected);
  }

  return {
    root: params,
    valueField,
    t0Field,
    beforeField,
    afterField,
    hostField,
    renderTypes,
  };
}
