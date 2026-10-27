import type {
  CellContext,
  IndicatorId,
  PivotRule,
  PivotSnapshot,
  PlatformAdapter,
} from '../types.ts';
import { CSS_PREFIX } from '../config.ts';
import { detectForCell } from '../core/detection.ts';
import { fillQuery, parseDurationMinutes, parseGridTime } from '../core/pivot.ts';
import { normalize } from '../core/normalize.ts';
import { getRulesUrl, onCatalogChange, reloadCatalog, setRulesUrl } from '../core/rules-catalog.ts';
import { resolvePlatformVariant } from '../core/settings.ts';
import {
  addStep,
  clearSnapshots,
  getSnapshot,
  listSnapshots,
  recordSnapshot,
} from '../core/investigation.ts';
import { getEditorText, injectQuery, replaceEditorContent } from '../core/editor-bridge.ts';
import { copyDiagnostics, getHealthReport, onHealthChange, refreshHealth } from '../core/health.ts';
import { listRecentRuleIds, recordRecentRule } from '../core/recent-rules.ts';
import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './notification.ts';
import { P, el, button } from './panel/shared.ts';
import { createSettingsView } from './panel/settings-view.ts';
import { createHealthView } from './panel/health-view.ts';
import { createContextView } from './panel/context-view.ts';
import { createParamsView } from './panel/params-view.ts';
import { createRulesView } from './panel/rules-view.ts';

export interface PivotMenuComponent {
  /** Open on a grid cell context (new event) */
  show(ctx: CellContext, x: number, y: number): void;
  /** Open without a cell: reloads the latest snapshot, if any */
  showHistory(x: number, y: number): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

const MARGIN = 8;

export function createPivotMenu(platform: PlatformAdapter): PivotMenuComponent {
  // ── State ──
  let visible = false;
  let selected: IndicatorId = 'ip';
  const expanded = new Set<string>();
  let settingsOpen = false;
  let healthOpen = false;
  /** Event from the last right-click, not journaled until a rule runs */
  let pendingCtx: CellContext | null = null;
  /** Snapshot the panel is working on (null = pendingCtx / manual input) */
  let snapshotId: string | null = null;
  let row: Readonly<Record<string, string>> = {};
  /** Loaded once per panel open (#17), not re-read on every keystroke */
  let recentRuleIds: readonly string[] = [];

  // ── DOM ──
  const overlay = el('div', `${CSS_PREFIX}-popup-overlay`);
  overlay.addEventListener('mousedown', () => hide());

  const panel = el('div', P);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('common.pivot'));
  panel.addEventListener('mousedown', (e) => e.stopPropagation());

  // Header
  const header = el('div', `${P}-header`);
  header.appendChild(el('span', `${P}-title`, t('common.pivot')));
  const headerActions = el('div', `${P}-header-actions`);
  const healthBtn = button(`${CSS_PREFIX}-icon-btn ${P}-health-btn`, '⚕', t('health.title'));
  const settingsBtn = button(`${CSS_PREFIX}-icon-btn ${P}-settings-btn`, '⚙', t('panel.settingsTitle'));
  const closeBtn = button(`${CSS_PREFIX}-popup-close`, '', t('panel.closeTitle'));
  closeBtn.innerHTML = '&#10005;';
  closeBtn.addEventListener('click', () => hide());
  headerActions.append(healthBtn, settingsBtn, closeBtn);
  header.appendChild(headerActions);

  const settingsView = createSettingsView(() => renderTypes());
  const healthView = createHealthView();
  const contextView = createContextView();
  const paramsView = createParamsView();
  const rulesView = createRulesView();

  panel.append(
    header,
    settingsView.root,
    healthView.root,
    contextView.root,
    paramsView.root,
    rulesView.root,
  );

  // ── Rendering ──

  function currentSnapshot(): PivotSnapshot | undefined {
    return snapshotId ? getSnapshot(snapshotId) : undefined;
  }

  function renderTypes(): void {
    paramsView.renderTypes(selected, (id) => {
      selected = id;
      renderTypes();
      renderRules();
    });
  }

  function renderRules(): void {
    rulesView.renderRules(
      selected,
      expanded,
      currentSnapshot(),
      paramsView.valueField.input.value.trim(),
      resolvePlatformVariant(platform.id),
      recentRuleIds,
      runRule,
    );
  }

  function renderContext(): void {
    contextView.renderContext(
      listSnapshots(),
      currentSnapshot(),
      pendingCtx,
      row,
      paramsView.valueField.input.value,
      onFieldChipClick,
    );
  }

  function renderFields(): void {
    contextView.renderFields(row, paramsView.valueField.input.value, onFieldChipClick);
  }

  function onFieldChipClick(val: string, indicator: IndicatorId): void {
    paramsView.valueField.input.value = val;
    selected = indicator;
    renderAll();
  }

  function renderStatus(): void {
    settingsView.renderStatus();
  }

  function renderAll(): void {
    renderContext();
    renderTypes();
    renderRules();
    if (settingsOpen) renderStatus();
  }

  // ── Loading a context into the fields ──

  function fill(c: CellContext): void {
    paramsView.valueField.input.value = c.value;
    paramsView.t0Field.input.value = c.t0;
    paramsView.t0Field.input.title = c.t0Raw
      ? t('panel.params.t0ReadFromGrid', { raw: c.t0Raw })
      : t('panel.params.t0NotFound');
    paramsView.hostField.input.value = c.host;
    paramsView.beforeField.input.value = '';
    paramsView.afterField.input.value = '';
    row = c.row;
    // Not logged here (#18): this runs whenever a context is loaded (show,
    // history pick), not just on the right-click already logged in
    // pivot-trigger.ts's addPivotItem.
    selected = detectForCell(c.value, c.column, c.entityName).candidates[0] ?? selected;
    expanded.clear();
  }

  function loadSnapshot(id: string): void {
    const snap = getSnapshot(id);
    if (!snap) return;
    snapshotId = snap.id;
    fill(snap);
    renderAll();
  }

  // ── Actions ──

  async function runRule(rule: PivotRule): Promise<void> {
    const value = paramsView.valueField.input.value.trim();
    if (!value) {
      showToast(t('notify.emptyValue'), 'error');
      paramsView.valueField.input.focus();
      return;
    }

    const before = parseDurationMinutes(paramsView.beforeField.input.value);
    const after = parseDurationMinutes(paramsView.afterField.input.value);
    if (Number.isNaN(before) || Number.isNaN(after)) {
      showToast(t('notify.invalidWindow'), 'error');
      return;
    }

    // The field is labelled UTC: a date without time zone is read as UTC
    const t0Text = paramsView.t0Field.input.value.trim();
    const t0 = t0Text ? parseGridTime(t0Text, true) : '';
    if (t0Text && !t0) {
      showToast(t('notify.invalidT0'), 'error');
      paramsView.t0Field.input.focus();
      return;
    }

    const host = paramsView.hostField.wrap.hidden ? '' : paramsView.hostField.input.value.trim();
    // Type-aware cleanup (#15) right before the value goes into a query —
    // refang, port/`::ffff:` stripping, hash/domain casing — not earlier,
    // so the panel still shows what the analyst actually typed/clicked.
    const normalizedValue = normalize(value, selected);
    const kql = fillQuery(
      rule,
      { value: normalizedValue, t0, beforeMinutes: before, afterMinutes: after, host },
      platform.id,
    );

    // Journal the event before the editor changes, so its source query is kept
    if (!currentSnapshot()) {
      const ctx: CellContext = pendingCtx ?? {
        value,
        column: '',
        t0,
        t0Raw: '',
        host,
        row: {},
      };
      snapshotId = recordSnapshot(ctx, getEditorText() ?? '', platform.id).id;
      pendingCtx = null;
    }

    // Clipboard outcome is only known once the promise settles - never
    // reported as a success before that (bug #4)
    const result = await injectQuery(kql);
    if (result === 'injected') {
      const timeHint = platform.id === 'defender' ? t('notify.timeSelectorHint') : '';
      showToast(t('notify.ruleInjected', { id: rule.id, hint: timeHint }), 'success');
    } else if (result === 'clipboard') {
      showToast(t('notify.ruleCopied', { id: rule.id }), 'info');
    } else {
      showToast(t('notify.clipboardDenied'), 'error');
      return;
    }

    if (snapshotId) addStep(snapshotId, { ruleId: rule.id, value: normalizedValue, indicator: selected });
    recordRecentRule(rule.id);
    recentRuleIds = listRecentRuleIds();
    hide();
  }

  function restoreSource(): void {
    const snap = currentSnapshot();
    if (!snap?.sourceQuery) return;
    if (replaceEditorContent(snap.sourceQuery)) {
      showToast(t('notify.sourceRestored'), 'success');
      hide();
    } else {
      showToast(t('notify.editorNotFound'), 'error');
    }
  }

  // ── Wiring ──

  paramsView.valueField.input.addEventListener('input', () => {
    renderTypes();
    renderFields();
  });

  contextView.historySelect.addEventListener('change', () => {
    if (contextView.historySelect.value) {
      loadSnapshot(contextView.historySelect.value);
    } else if (pendingCtx) {
      snapshotId = null;
      fill(pendingCtx);
      renderAll();
    }
  });

  contextView.restoreBtn.addEventListener('click', restoreSource);

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsView.root.hidden = !settingsOpen;
    settingsBtn.classList.toggle(`${P}-settings-btn--open`, settingsOpen);
    if (settingsOpen) {
      settingsView.urlField.input.value = getRulesUrl();
      renderStatus();
      settingsView.renderTi();
    }
  });

  healthBtn.addEventListener('click', () => {
    healthOpen = !healthOpen;
    healthView.root.hidden = !healthOpen;
    healthBtn.classList.toggle(`${P}-health-btn--open`, healthOpen);
    if (healthOpen) {
      refreshHealth(platform);
      healthView.renderReport(getHealthReport());
    }
  });

  healthView.refreshBtn.addEventListener('click', () => {
    refreshHealth(platform);
    healthView.renderReport(getHealthReport());
  });

  healthView.copyBtn.addEventListener('click', () => {
    void copyDiagnostics(platform).then((result) => {
      if (result === 'clipboard') showToast(t('notify.diagnosticsCopied'), 'success');
      else showToast(t('notify.diagnosticsCopyFailed'), 'error');
    });
  });

  const reload = (url: string): void => {
    setRulesUrl(url);
    settingsView.urlField.input.value = getRulesUrl();
    settingsView.saveUrlBtn.disabled = true;
    settingsView.catalogStatus.textContent = t('settings.downloading');
    void reloadCatalog().then((st) => {
      settingsView.saveUrlBtn.disabled = false;
      if (st.error) showToast(t('notify.catalogDownloadFailed'), 'error');
      else showToast(t('notify.catalogLoaded', { version: st.version, count: st.ruleCount }), 'success');
    });
  };
  settingsView.saveUrlBtn.addEventListener('click', () => reload(settingsView.urlField.input.value));
  settingsView.defaultUrlBtn.addEventListener('click', () => reload(''));

  settingsView.clearHistoryBtn.addEventListener('click', () => {
    clearSnapshots();
    snapshotId = null;
    renderContext();
    renderRules();
    showToast(t('notify.historyCleared'), 'info');
  });

  const unsubscribeCatalog = onCatalogChange(() => {
    if (!visible) return;
    renderTypes();
    renderRules();
    if (settingsOpen) renderStatus();
  });

  const unsubscribeHealth = onHealthChange(() => {
    if (!visible || !healthOpen) return;
    healthView.renderReport(getHealthReport());
  });

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    hide();
  }

  // ── Show / hide ──

  function position(x: number, y: number): void {
    const rect = panel.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - MARGIN;
    const maxY = window.innerHeight - rect.height - MARGIN;
    panel.style.left = `${Math.max(MARGIN, Math.min(x, maxX))}px`;
    panel.style.top = `${Math.max(MARGIN, Math.min(y, maxY))}px`;
  }

  function open(x: number, y: number): void {
    if (!visible) {
      document.body.append(overlay, panel);
      document.addEventListener('keydown', onKeyDown, true);
      visible = true;
    }
    position(x, y);
    rulesView.resetView();
  }

  /** Read once per open (#17), before renderAll() so renderRules() sees it right away */
  function loadRecentRules(): void {
    recentRuleIds = listRecentRuleIds();
    log.debug(`recent rules: ${recentRuleIds.length} loaded`);
  }

  function show(ctx: CellContext, x: number, y: number): void {
    pendingCtx = ctx;
    snapshotId = null;
    loadRecentRules();
    fill(ctx);
    renderAll();
    open(x, y);
  }

  function showHistory(x: number, y: number): void {
    pendingCtx = null;
    loadRecentRules();
    const latest = listSnapshots()[0];
    if (latest) {
      snapshotId = latest.id;
      fill(latest);
    } else {
      snapshotId = null;
      fill({ value: '', column: '', t0: '', t0Raw: '', host: '', row: {} });
    }
    renderAll();
    open(x, y);
    if (!latest) paramsView.valueField.input.focus();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    panel.remove();
  }

  return {
    show,
    showHistory,
    hide,
    isVisible: () => visible,
    destroy() {
      hide();
      unsubscribeCatalog();
      unsubscribeHealth();
    },
  };
}
