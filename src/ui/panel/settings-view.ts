import type { IndicatorId } from '../../types.ts';
import { CSS_PREFIX, DEFAULT_RULES_URL } from '../../config.ts';
import { getCatalogStatus } from '../../core/rules-catalog.ts';
import { getIndicatorIds, getIndicatorLabel } from '../../core/pivot.ts';
import { BUILTIN_TI_PROVIDERS, isValidTiTemplate, type TiProvider } from '../../core/ti-links.ts';
import { getSetting, setSetting } from '../../core/settings.ts';
import { estimateStoreBytes, purgeNow } from '../../capture/store.ts';
import { log } from '../../core/log.ts';
import { t } from '../../i18n/index.ts';
import { showToast } from '../notification.ts';
import { P, el, button, field } from './shared.ts';

function relativeAge(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return t('settings.ageNow');
  if (min < 60) return t('settings.ageMinutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('settings.ageHours', { n: h });
  return t('settings.ageDays', { n: Math.round(h / 24) });
}

export interface SettingsView {
  readonly root: HTMLDivElement;
  readonly urlField: { wrap: HTMLLabelElement; input: HTMLInputElement };
  readonly saveUrlBtn: HTMLButtonElement;
  readonly defaultUrlBtn: HTMLButtonElement;
  readonly clearHistoryBtn: HTMLButtonElement;
  readonly catalogStatus: HTMLDivElement;
  readonly catalogError: HTMLDivElement;
  readonly catalogWarnings: HTMLDivElement;
  renderStatus(): void;
  /** Rebuilds the provider checkboxes and custom-provider list from current settings. */
  renderTi(): void;
}

/** Generated client-side only, never sent anywhere: just a stable key for `ti.providers`. */
function newCustomId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `onTiChange` lets the caller refresh anything else that depends on
 * `ti.providers`/`ti.custom` (the links shown under the Value field in
 * `params-view.ts`) right when a checkbox is toggled here, instead of
 * waiting for the panel to be reopened.
 */
export function createSettingsView(onTiChange?: () => void): SettingsView {
  // Settings
  const settings = el('div', `${P}-settings`);
  settings.hidden = true;
  const urlField = field(t('settings.rulesUrlLabel'), 'wide', DEFAULT_RULES_URL);
  const settingsActions = el('div', `${P}-actions`);
  const saveUrlBtn = button(`${P}-btn ${P}-btn--primary`, t('settings.saveReload'));
  const defaultUrlBtn = button(`${P}-btn`, t('settings.defaultUrl'));
  const clearHistoryBtn = button(`${P}-btn`, t('settings.clearHistory'));
  settingsActions.append(saveUrlBtn, defaultUrlBtn, clearHistoryBtn);
  const catalogStatus = el('div', `${P}-status`);
  const catalogError = el('div', `${P}-status ${P}-status--error`);
  const catalogWarnings = el('div', `${P}-status`);

  // ── Capture storage (N1 "Bouton « Purger maintenant » et indicateur de
  // taille"). Scoped to "everything" (`estimateStoreBytes('all')`): the
  // active tenant key is resolved asynchronously elsewhere (core/tenant.ts)
  // and not available synchronously here - per-tenant purge stays available
  // from `capture/store.ts`'s own API for a future, more granular UI
  // (phase 5, once a case bar exists to say which tenant is "current"). The
  // logic (what to drop, in what order) lives entirely in store.ts; this is
  // only a button + a status line. ──
  // ── capture.sanitizeValues: the opt-in mitigation for N1 keeping
  // summary.topValues (real customer values) for retention.days even when the
  // row sample is dropped. Masking happens at STORE time in capture/store.ts,
  // so toggling this affects runs captured from now on, not ones already
  // stored - said so in the hint text rather than implying a retroactive wipe. ──
  const sanitizeRow = el('div', `${P}-ti-provider-row`);
  const sanitizeBox = el('input', `${P}-ti-checkbox`);
  sanitizeBox.type = 'checkbox';
  sanitizeBox.checked = getSetting('capture').sanitizeValues;
  sanitizeBox.addEventListener('change', () => {
    const capture = getSetting('capture');
    setSetting('capture', { ...capture, sanitizeValues: sanitizeBox.checked });
    log.debug('capture: sanitizeValues toggled', { enabled: sanitizeBox.checked });
    renderPurgeStatus();
  });
  const sanitizeLabel = el('label', `${P}-ti-provider-label`);
  sanitizeLabel.append(sanitizeBox, document.createTextNode(t('settings.sanitize.label')));
  sanitizeRow.appendChild(sanitizeLabel);
  const sanitizeHint = el('div', `${P}-status`, t('settings.sanitize.hint'));

  const purgeTitle = el('span', `${P}-field-label`, t('settings.purge.title'));
  const purgeStatus = el('div', `${P}-status`);
  const purgeBtn = button(`${P}-btn`, t('settings.purge.button'));
  const purgeRow = el('div', `${P}-actions`);
  purgeRow.append(purgeBtn);

  function renderPurgeStatus(): void {
    const mb = estimateStoreBytes('all') / 1_000_000;
    purgeStatus.textContent = t('settings.purge.size', { mb: mb.toFixed(2) });
  }
  renderPurgeStatus();

  purgeBtn.addEventListener('click', () => {
    try {
      const report = purgeNow('all');
      log.debug('capture/store: manual purge from settings', report);
      const mb = estimateStoreBytes('all') / 1_000_000;
      purgeStatus.textContent = t('settings.purge.done', {
        samples: report.samplesDroppedByAge + report.samplesDroppedByBytes,
        runs: report.runsDroppedByBytes,
        mb: mb.toFixed(2),
      });
    } catch (err) {
      log.error('settings: purge now failed', err);
      renderPurgeStatus();
    }
  });

  // ── Threat Intel providers (N7, #20) — all disabled by default ──
  const tiTitle = el('span', `${P}-field-label`, t('settings.ti.title'));
  const tiProvidersList = el('div', `${P}-ti-providers`);
  const customLabelInput = el('input', `${P}-input`);
  customLabelInput.type = 'text';
  customLabelInput.placeholder = t('settings.ti.customLabelPlaceholder');
  const customTypeSelect = el('select', `${P}-input`);
  for (const id of getIndicatorIds()) {
    const opt = el('option', undefined, getIndicatorLabel(id));
    opt.value = id;
    customTypeSelect.appendChild(opt);
  }
  const customTemplateInput = el('input', `${P}-input`);
  customTemplateInput.type = 'text';
  customTemplateInput.placeholder = t('settings.ti.customTemplatePlaceholder');
  const addCustomBtn = button(`${P}-btn`, t('settings.ti.addCustom'));
  const tiAddRow = el('div', `${P}-ti-add`);
  tiAddRow.append(customLabelInput, customTypeSelect, customTemplateInput, addCustomBtn);

  settings.append(
    urlField.wrap,
    settingsActions,
    catalogStatus,
    catalogError,
    catalogWarnings,
    purgeTitle,
    purgeStatus,
    purgeRow, sanitizeRow, sanitizeHint,
    tiTitle,
    tiProvidersList,
    tiAddRow,
  );

  /** `true` <-> `false` is the only direction that triggers the consent toast (N7). */
  function setProviderEnabled(id: string, enable: boolean): void {
    const ti = getSetting('ti');
    const already = ti.providers.includes(id);
    if (enable === already) return;
    const providers = enable ? [...ti.providers, id] : ti.providers.filter((p) => p !== id);
    setSetting('ti', { ...ti, providers });
    log.debug('ti: provider toggled', { id, enable });
    if (enable) showToast(t('settings.ti.consentWarning'), 'info');
    renderTi();
    onTiChange?.();
  }

  function removeCustomProvider(id: string): void {
    const ti = getSetting('ti');
    setSetting('ti', {
      providers: ti.providers.filter((p) => p !== id),
      custom: ti.custom.filter((p) => p.id !== id),
    });
    renderTi();
    onTiChange?.();
  }

  function addCustomProvider(): void {
    const label = customLabelInput.value.trim();
    const type = customTypeSelect.value as IndicatorId;
    const template = customTemplateInput.value.trim();

    if (!label || !template) return;
    if (!template.startsWith('https://')) {
      showToast(t('settings.ti.invalidScheme'), 'error');
      return;
    }
    if (!template.includes('{value}')) {
      showToast(t('settings.ti.invalidPlaceholder'), 'error');
      return;
    }
    // Belt-and-braces: isValidTiTemplate() is the single source of truth core/ti-links.ts
    // relies on too, so a provider that passes here is one buildTiLinks() will also accept.
    if (!isValidTiTemplate(template)) {
      showToast(t('settings.ti.invalidScheme'), 'error');
      return;
    }

    const provider: TiProvider = { id: newCustomId(), label, templates: { [type]: template } };
    const ti = getSetting('ti');
    setSetting('ti', { ...ti, custom: [...ti.custom, provider] });
    customLabelInput.value = '';
    customTemplateInput.value = '';
    renderTi();
  }

  addCustomBtn.addEventListener('click', addCustomProvider);

  function renderProviderRow(provider: TiProvider, removable: boolean): HTMLDivElement {
    const row = el('div', removable ? `${P}-ti-custom-row` : `${P}-ti-provider-row`);
    const ti = getSetting('ti');
    const checkbox = el('input', `${P}-ti-checkbox`);
    checkbox.type = 'checkbox';
    checkbox.checked = ti.providers.includes(provider.id);
    checkbox.addEventListener('change', () => setProviderEnabled(provider.id, checkbox.checked));
    const labelWrap = el('label', `${P}-ti-provider-label`);
    labelWrap.append(checkbox, document.createTextNode(provider.label));
    row.appendChild(labelWrap);
    if (removable) {
      const removeBtn = button(`${P}-btn`, '✕', t('settings.ti.removeCustom'));
      removeBtn.addEventListener('click', () => removeCustomProvider(provider.id));
      row.appendChild(removeBtn);
    }
    return row;
  }

  function renderTi(): void {
    const ti = getSetting('ti');
    tiProvidersList.replaceChildren();
    for (const provider of BUILTIN_TI_PROVIDERS) {
      tiProvidersList.appendChild(renderProviderRow(provider, false));
    }
    for (const provider of ti.custom) {
      tiProvidersList.appendChild(renderProviderRow(provider, true));
    }
  }

  function renderStatus(): void {
    const st = getCatalogStatus();
    const source =
      st.source === 'bundled'
        ? t('settings.sourceBundled')
        : st.source === 'cache'
          ? t('settings.sourceCache', { age: relativeAge(st.fetchedAt) })
          : t('settings.sourceRemote', { age: relativeAge(st.fetchedAt) });
    catalogStatus.textContent = t('settings.catalogStatus', {
      version: st.version,
      count: st.ruleCount,
      source,
    });
    catalogError.textContent = st.error ? t('settings.downloadFailed', { error: st.error }) : '';
    catalogError.hidden = !st.error;

    // Non-blocking catalog problems: one line each, as plain text
    catalogWarnings.textContent = '';
    if (st.warnings.length > 0) {
      catalogWarnings.appendChild(el('div', undefined, t('settings.catalogWarningsLabel')));
      for (const w of st.warnings) catalogWarnings.appendChild(el('div', undefined, w));
    }
    catalogWarnings.hidden = st.warnings.length === 0;
  }

  return {
    root: settings,
    urlField,
    saveUrlBtn,
    defaultUrlBtn,
    clearHistoryBtn,
    catalogStatus,
    catalogError,
    catalogWarnings,
    renderStatus,
    renderTi,
  };
}
