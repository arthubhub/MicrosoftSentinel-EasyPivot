import { CSS_PREFIX, DEFAULT_RULES_URL } from '../../config.ts';
import { getCatalogStatus } from '../../core/rules-catalog.ts';
import { t } from '../../i18n/index.ts';
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
}

export function createSettingsView(): SettingsView {
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
  settings.append(urlField.wrap, settingsActions, catalogStatus, catalogError, catalogWarnings);

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
  };
}
