import type { IndicatorId } from '../../types.ts';
import {
  detectIndicators,
  getIndicatorIds,
  getIndicatorLabel,
  indicatorHasHostRules,
} from '../../core/pivot.ts';
import { BUILTIN_TI_PROVIDERS, buildTiLinks } from '../../core/ti-links.ts';
import { normalize } from '../../core/normalize.ts';
import { getSetting } from '../../core/settings.ts';
import { CSS_PREFIX } from '../../config.ts';
import { log } from '../../core/log.ts';
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

// ── Time window presets (#19) — vocabulary parsed by parseDurationMinutes ──
const PRESETS: readonly { labelKey: 'panel.params.preset1h' | 'panel.params.preset24h' | 'panel.params.preset7d'; duration: string }[] = [
  { labelKey: 'panel.params.preset1h', duration: '1h' },
  { labelKey: 'panel.params.preset24h', duration: '24h' },
  { labelKey: 'panel.params.preset7d', duration: '7d' },
];

export function createParamsView(): ParamsView {
  const params = el('div', `${P}-params`);
  const valueField = field(t('panel.params.valueLabel'), 'wide', t('panel.params.valuePlaceholder'));

  // ── Threat Intel links (N7, #20) — under the Value field, selected type only ──
  // Built purely from `<a href>`: no fetch, no preview, nothing fires before a click.
  const tiLinksWrap = el('div', `${P}-field ${P}-field--wide`);
  tiLinksWrap.appendChild(el('span', `${P}-field-label`, t('panel.params.tiLinksLabel')));
  const tiLinksRow = el('div', `${P}-ti-links`);
  tiLinksWrap.appendChild(tiLinksRow);
  tiLinksWrap.hidden = true;

  const types = el('div', `${P}-types`);
  const timeRow = el('div', `${P}-row`);
  const t0Field = field(t('panel.params.t0Label'), 'grow', t('panel.params.t0Placeholder'));
  const beforeField = field(t('panel.params.beforeLabel'), '', t('common.default'));
  const afterField = field(t('panel.params.afterLabel'), '', t('common.default'));
  const windowHint = t('panel.params.windowHint');
  beforeField.input.title = windowHint;
  afterField.input.title = windowHint;
  timeRow.append(t0Field.wrap, beforeField.wrap, afterField.wrap);

  // Presets just fill Before/After with the same `30m`/`24h`/`7d` vocabulary
  // the fields already accept — the analyst can still edit the result by hand.
  const presetsWrap = el('div', `${P}-field ${P}-field--wide`);
  presetsWrap.appendChild(el('span', `${P}-field-label`, t('panel.params.presetsLabel')));
  const presetsRow = el('div', `${P}-actions ${P}-presets`);
  for (const preset of PRESETS) {
    const presetBtn = button(`${P}-btn`, t(preset.labelKey), t('panel.params.presetTitle'));
    presetBtn.addEventListener('click', () => {
      beforeField.input.value = preset.duration;
      afterField.input.value = preset.duration;
      log.debug('panel: time window preset applied', { duration: preset.duration });
    });
    presetsRow.appendChild(presetBtn);
  }
  presetsWrap.appendChild(presetsRow);

  const hostField = field(t('panel.params.hostLabel'), 'wide', t('panel.params.hostPlaceholder'));
  params.append(valueField.wrap, tiLinksWrap, types, timeRow, presetsWrap, hostField.wrap);

  /**
   * Links for the SELECTED type only, built from the NORMALIZED value (#15)
   * so a defanged `hxxp://evil[.]com` still produces a working link. Reads
   * `ti.providers`/`ti.custom` itself (UI layer, not core) — never on panel
   * open by itself, only as part of renderTypes(), i.e. only after a value
   * or type the analyst already chose.
   */
  function renderTiLinks(selected: IndicatorId): void {
    const raw = valueField.input.value.trim();
    tiLinksRow.replaceChildren();
    if (!raw) {
      tiLinksWrap.hidden = true;
      return;
    }

    const ti = getSetting('ti');
    if (ti.providers.length === 0) {
      tiLinksWrap.hidden = true;
      return;
    }

    const value = normalize(raw, selected);
    const providers = [...BUILTIN_TI_PROVIDERS, ...ti.custom];
    const links = buildTiLinks(providers, ti.providers, value, selected);
    tiLinksWrap.hidden = links.length === 0;
    if (links.length === 0) return;

    // debug only: a TI link embeds the IOC, never log it at info+ (see log.ts convention)
    log.debug('panel: TI links rendered', { type: selected, count: links.length });

    for (const link of links) {
      const a = el('a', `${P}-ti-link`, link.label);
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = t('panel.params.tiLinkTitle', { label: link.label });
      tiLinksRow.appendChild(a);
    }
  }

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
    renderTiLinks(selected);
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
