import type {
  Case,
  CellContext,
  IndicatorId,
  PivotRule,
  PivotSnapshot,
  PlatformAdapter,
} from '../types.ts';
import { CASES, CSS_PREFIX } from '../config.ts';
import { detectForCell } from '../core/detection.ts';
import { fillQuery, getRuleById, parseDurationMinutes, parseGridTime } from '../core/pivot.ts';
import { normalize } from '../core/normalize.ts';
import { getRulesUrl, onCatalogChange, reloadCatalog, setRulesUrl } from '../core/rules-catalog.ts';
import { getSetting, resolvePlatformVariant } from '../core/settings.ts';
import { getEditorText, injectQuery, replaceEditorContent } from '../core/editor-bridge.ts';
import { copyDiagnostics, getHealthReport, onHealthChange, refreshHealth } from '../core/health.ts';
import { listRecentRuleIds, recordRecentRule } from '../core/recent-rules.ts';
import { computeKqlHash, registerPendingRun } from '../capture/store.ts';
import { getLastCapture, replayAvailability, replayQuery } from '../capture/interceptor.ts';
import { backgroundReason, createBackgroundView } from './panel/background-view.ts';
import { extractResultValues, type ResultValue } from '../core/result-values.ts';
import {
  addStepToSnapshot,
  checkPivotAllowed,
  ensureUnassignedCase,
  getActiveCaseForKey,
  getCaseSnapshots,
  pinRowToSnapshot,
  recordSnapshotInCase,
} from '../core/cases.ts';
import { UNKNOWN_KEY } from '../core/tenant.ts';
import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { showToast } from './notification.ts';
import { P, el, button } from './panel/shared.ts';
import { createCaseBar } from './case-bar.ts';
import { CASE_VIEW_WIDTH, createCaseView } from './case-view.ts';
import { createSettingsView } from './panel/settings-view.ts';
import { createHealthView } from './panel/health-view.ts';
import { createContextView } from './panel/context-view.ts';
import { createParamsView } from './panel/params-view.ts';
import { createRulesView } from './panel/rules-view.ts';
import { createCoverageView } from './panel/coverage-view.ts';
import { createPlaybookBar } from './panel/playbook-view.ts';
import { advancePlaybook, carrySuggestions, listScenarios, onRuleRan, startPlaybook, stopPlaybook, viewPlaybook } from '../core/playbooks.ts';

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

  // N3 case view (5e-2): a second panel docked on the right. Opened from the
  // case bar below; it lives and dies with this panel (hide() closes it). A
  // node click goes through `loadSnapshot`, the same path as the Event selector.
  const caseView = createCaseView({
    getCaseId: () => activeCase()?.id,
    getSelectedSnapshotId: () => snapshotId,
    onSelectSnapshot: (id) => loadSnapshot(id),
    onCaseChanged: () => {
      void caseBarView.refresh();
      renderContext();
    },
    onVisibilityChange: () => {
      // Keep the Pivot panel clear of the docked view.
      if (visible) position(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
    },
  });

  // N2 "cloisonnement": the case bar is always visible (not toggled like
  // settings/health) - it is the context every pivot below is scoped to.
  // Kicked off here (construction time, before the panel is ever opened)
  // rather than waiting for the first open() - by the time the user
  // actually opens the panel the async resolution has usually already
  // landed, so the "resolving…" placeholder is rarely seen in practice.
  const caseBarView = createCaseBar(platform, {
    onResolved: () => {
      // The active case may have changed (switch, create, other tab): the
      // "Événement" selector lists ITS snapshots, so repaint it, and forget a
      // selected snapshot that belongs to the previous case.
      if (snapshotId && !currentSnapshot()) snapshotId = null;
      if (visible) {
        renderContext();
        renderPlaybook();
      }
      caseView.refresh();
      // U1: a case created/switched while the panel shows a pending event takes that event too
      if (visible && pendingCtx) void journalOnOpen(pendingCtx);
    },
    onOpenCaseView: () => {
      if (caseView.isVisible()) caseView.hide();
      else caseView.show();
    },
  });
  void caseBarView.refresh();
  // `getCurrentKey`/`onCasesChanged` are what the 5d case export/import block
  // in Settings needs: the case bar owns the resolved tenant key, and an
  // imported case changes which case is active, so the bar must re-resolve.
  const settingsView = createSettingsView({
    onTiChange: () => renderTypes(),
    onBackgroundChange: () => renderRules(),
    getCurrentKey: () => caseBarView.getCurrentKey(),
    onCasesChanged: () => void caseBarView.refresh(),
  });
  const healthView = createHealthView();
  const contextView = createContextView();
  const paramsView = createParamsView();
  const rulesView = createRulesView();
  const coverageView = createCoverageView();
  const playbookBar = createPlaybookBar();
  const backgroundView = createBackgroundView();

  panel.append(
    header,
    caseBarView.root,
    settingsView.root,
    healthView.root,
    contextView.root,
    coverageView.root,
    paramsView.root,
    playbookBar.root,
    backgroundView.root,
    rulesView.root,
  );

  // ── Rendering ──

  /** The active case for the current tenant key; undefined until the case bar has resolved a key. */
  function activeCase(): Case | undefined {
    const key = caseBarView.getCurrentKey();
    return key !== undefined ? getActiveCaseForKey(key) : undefined;
  }

  /**
   * Snapshots of the ACTIVE case (5e-1) - the live path no longer reads the
   * legacy `shq_pivot_snapshots` journal. Empty until the case bar has resolved a key.
   */
  function caseSnapshots(): readonly PivotSnapshot[] {
    const active = activeCase();
    return active ? getCaseSnapshots(active.id) : [];
  }

  function currentSnapshot(): PivotSnapshot | undefined {
    return snapshotId ? caseSnapshots().find((s) => s.id === snapshotId) : undefined;
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
      (rule) => void runRule(rule),
      getSetting('background').enabled ? (rule) => void runRule(rule, 'background') : undefined,
    );
  }

  function renderContext(): void {
    contextView.renderContext(
      caseSnapshots(),
      currentSnapshot(),
      pendingCtx,
      row,
      paramsView.valueField.input.value,
      onFieldChipClick,
      activeCase()?.closedAt !== undefined,
    );
  }

  function renderFields(): void {
    contextView.renderFields(row, paramsView.valueField.input.value, onFieldChipClick);
  }

  /** U3: values of the last captured result (in memory, raw), computed once per panel open */
  function renderResultValues(): void {
    const last = getLastCapture(platform.id);
    const values = last
      ? extractResultValues(last.columns, last.rows, {
          sourceTables: last.sourceTables,
          exclude: [paramsView.valueField.input.value],
        })
      : new Map();
    contextView.renderResultValues(values, (v, type) => onResultValuePick(v, type, last?.runId));
    // #33: a discovery (*-S9) result lists the locations the rules do not read
    // The type is the discovery rule's (IP-S9 -> ip), read from the stored run; else the panel's type
    const discoveryType = last?.ruleId ? getRuleById(last.ruleId)?.indicators[0] : undefined;
    coverageView.render(last, discoveryType ?? selected, platform.id);
  }

  /**
   * A value picked from the last result becomes a new event, child of the pivot
   * that produced that result (`resolveParentLink` via `runId`), and enters the
   * history right away (U1). T0 is kept: the analyst stays in the same window.
   */
  function onResultValuePick(v: ResultValue, type: IndicatorId, runId: string | undefined): void {
    const ctx: CellContext = {
      value: v.value,
      column: v.column,
      t0: paramsView.t0Field.input.value.trim(),
      t0Raw: '',
      host: '',
      row: {},
      source: runId ? 'capture' : 'dom',
      ...(runId ? { runId } : {}),
    };
    pendingCtx = ctx;
    snapshotId = null;
    fill(ctx);
    selected = type;
    renderAll();
    void journalOnOpen(ctx);
  }

  function onFieldChipClick(val: string, indicator: IndicatorId): void {
    paramsView.valueField.input.value = val;
    selected = indicator;
    renderAll();
  }

  function renderStatus(): void {
    settingsView.renderStatus();
  }

  /** N4: the case's guided playbook (or "Start a playbook" for the selected type) */
  function renderPlaybook(): void {
    const c = activeCase();
    const model = viewPlaybook(c?.id);
    playbookBar.render({
      model,
      available: listScenarios(selected),
      suggestions: c && model?.carry ? carrySuggestions(c.id, getLastCapture(platform.id)) : [],
      caseWritable: !!c && c.closedAt === undefined,
      onStart: (id) => {
        if (c && startPlaybook(c.id, id)) {
          const first = viewPlaybook(c.id);
          if (first) selected = first.type;
          renderAll();
        }
      },
      onRun: (rule) => {
        const m = viewPlaybook(c?.id);
        if (m) selected = m.type;
        void runRule(rule);
      },
      onSkip: () => {
        if (c) advancePlaybook(c.id);
        const m = viewPlaybook(c?.id);
        if (m) selected = m.type;
        renderAll();
      },
      onStop: () => {
        if (c) stopPlaybook(c.id);
        renderAll();
      },
      onPickValue: (v, type) => onResultValuePick(v, type, getLastCapture(platform.id)?.runId),
    });
  }

  function renderAll(): void {
    renderContext();
    renderTypes();
    renderPlaybook();
    renderRules();
    if (settingsOpen) renderStatus();
    caseView.refresh();
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
    const snap = caseSnapshots().find((x) => x.id === id);
    if (!snap) return;
    snapshotId = snap.id;
    fill(snap);
    renderAll();
  }

  // ── Actions ──

  async function runRule(rule: PivotRule, mode: 'editor' | 'background' = 'editor'): Promise<void> {
    const value = paramsView.valueField.input.value.trim();
    if (!value) {
      showToast(t('notify.emptyValue'), 'error');
      paramsView.valueField.input.focus();
      return;
    }

    // N2 "cloisonnement": a pivot is refused when the active case does not
    // cover the current tenant key - this is the partitioning actually
    // taking effect, not just the banner showing it. `getActiveCaseForKey`
    // re-reads storage fresh (core/cases.ts's own guidance for "W2's pivot
    // guard"), so a case switched from another tab is seen here even if
    // this panel's cached case-bar state has not repainted yet. Fails OPEN
    // (pivot allowed) only if the case bar never managed to resolve ANY key
    // at all (hard constraint: never throw / never permanently lock the
    // panel on an internal resolution error) - a resolved 'unknown' key, by
    // contrast, goes through the guard exactly like any other key.
    await caseBarView.ensureResolved();
    const activeKey = caseBarView.getCurrentKey();
    // 5e-1: the snapshot and its steps are recorded INTO the active case, so a
    // pivot needs one. `activeKey` is only undefined if resolution never ran
    // (it always settles, even on failure, see case-bar.ts) - refuse rather
    // than record into the void.
    let activeCase = activeKey !== undefined ? getActiveCaseForKey(activeKey) : undefined;
    // N2 point 4: an UNREADABLE key still allows the pivot, filed in an unassigned case. That case is created
    // here, lazily - the case bar only resolves (opening a page must not create anything); every other key
    // with no case is refused below and the user decides where its data goes.
    if (activeKey === UNKNOWN_KEY && !activeCase) {
      activeCase = ensureUnassignedCase();
      await caseBarView.refresh();
    }
    if (activeKey === undefined || !activeCase) {
      showToast(t('caseBar.pivotRefused'), 'error');
      return;
    }
    const guard = checkPivotAllowed(activeCase, activeKey);
    if (!guard.allowed) {
      showToast(t('caseBar.pivotRefused'), 'error');
      return;
    }
    // A closed case is read-only (N2): refuse BEFORE the editor is touched, so
    // a pivot is never injected whose snapshot/step could not be recorded.
    if (activeCase.closedAt !== undefined) {
      showToast(t('caseBar.pivotRefusedClosed'), 'error');
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
        source: 'dom', // no right-click behind this snapshot - nothing was captured/grid-read
      };
      const recorded = recordSnapshotInCase(activeCase.id, ctx, getEditorText() ?? '', platform.id);
      if (!recorded.ok) {
        // Closed/removed since the check above (another tab): nothing injected yet.
        showToast(t(recorded.reason === 'closed' ? 'caseBar.pivotRefusedClosed' : 'caseBar.pivotRefused'), 'error');
        return;
      }
      snapshotId = recorded.snapshot.id;
      pendingCtx = null;
    }

    // #27: run without touching the editor - replay of the page's own request
    if (mode === 'background') {
      await runInBackground(rule, kql, normalizedValue, activeCase.id);
      return;
    }

    // Clipboard outcome is only known once the promise settles - never
    // reported as a success before that (bug #4)
    const insertMode = getSetting('insertMode');
    const result = await injectQuery(kql, insertMode);
    log.debug(`pivot-menu: runRule - injectQuery(mode=${insertMode}) -> ${result}`);
    if (result === 'injected') {
      const timeHint = platform.id === 'defender' ? t('notify.timeSelectorHint') : '';
      showToast(t('notify.ruleInjected', { id: rule.id, hint: timeHint }), 'success');
    } else if (result === 'newTabUnsupported') {
      // mode=newTab asked for, honestly not available (single shared Monaco
      // editor, see editor-bridge.ts) - the query DID land, just appended.
      const timeHint = platform.id === 'defender' ? t('notify.timeSelectorHint') : '';
      showToast(t('notify.ruleInjectedNewTabFallback', { id: rule.id, hint: timeHint }), 'info');
    } else if (result === 'clipboard') {
      showToast(t('notify.ruleCopied', { id: rule.id }), 'info');
    } else {
      showToast(t('notify.clipboardDenied'), 'error');
      return;
    }

    // W2 point 8: register the pivot as a pendingRun so the NEXT captured
    // QueryRun (if the user, or autoRun below, clicks Run) links back to
    // this rule and snapshot. Only when the KQL actually reached the editor
    // ('injected' or the degraded 'newTabUnsupported') - on a clipboard
    // fallback there is nothing in the editor to run, so registering would
    // leave a pendingRun that can never be consumed (until its TTL drops it).
    const landedInEditor = result === 'injected' || result === 'newTabUnsupported';
    if (landedInEditor && snapshotId) {
      const kqlHash = await computeKqlHash(kql);
      registerPendingRun({ ruleId: rule.id, snapshotId, kqlHash });
    }

    // N1 level 2 "Insérer + Run": runQuery() itself is a no-op unless the
    // user opted into `autoRun` (project rule 4) - still gated here on
    // `landedInEditor` so a clipboard fallback never clicks Run on whatever
    // query happened to be in the editor before this pivot.
    if (landedInEditor) {
      const runOutcome = platform.runQuery();
      log.debug(`pivot-menu: runRule - platform.runQuery() -> ${runOutcome}`);
    }

    if (snapshotId) {
      const stepResult = addStepToSnapshot(activeCase.id, snapshotId, {
        ruleId: rule.id,
        value: normalizedValue,
        indicator: selected,
      });
      if (!stepResult.ok) log.warn('pivot-menu: step not recorded', { reason: stepResult.reason });
    }
    recordRecentRule(rule.id);
    recentRuleIds = listRecentRuleIds();
    // N4: running the current step's rule (from the bar or the list) moves the playbook on
    onRuleRan(activeCase.id, rule.id);
    hide();
  }

  /**
   * #27 background context query: same snapshot/step/pendingRun as a normal
   * pivot, so the result is linked and lands in the case and the report; the
   * panel stays open and shows it. Never touches the editor.
   */
  async function runInBackground(rule: PivotRule, kql: string, value: string, caseId: string): Promise<void> {
    const availability = replayAvailability(platform.id);
    if (availability !== 'ok') {
      backgroundView.showError(rule, backgroundReason(availability));
      return;
    }
    backgroundView.showPending(rule);
    if (snapshotId) {
      const kqlHash = await computeKqlHash(kql);
      registerPendingRun({ ruleId: rule.id, snapshotId, kqlHash });
      const stepResult = addStepToSnapshot(caseId, snapshotId, { ruleId: rule.id, value, indicator: selected });
      if (!stepResult.ok) log.warn('pivot-menu: background step not recorded', { reason: stepResult.reason });
    }
    const res = await replayQuery(platform.id, kql);
    if (!res.ok) {
      backgroundView.showError(rule, backgroundReason(res.reason, res.status));
      return;
    }
    recordRecentRule(rule.id);
    onRuleRan(caseId, rule.id);
    const r = res.outcome.result;
    const values = r && !r.error ? extractResultValues(r.columns, r.rows, { sourceTables: r.sourceTables, exclude: [value] }) : new Map();
    backgroundView.showResult(rule, res.outcome, values, (v, type) => onResultValuePick(v, type, res.outcome.id));
    caseView.refresh();
    renderPlaybook();
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

  contextView.pinBtn.addEventListener('click', () => {
    const snap = currentSnapshot();
    const active = activeCase();
    if (!snap || !active) return;
    // The snapshot's own stored row, not whatever the panel fields show now.
    const result = pinRowToSnapshot(active.id, snap.id, snap.row);
    if (result.ok) {
      showToast(t(result.added ? 'notify.rowPinned' : 'notify.rowAlreadyPinned', { n: result.count }), result.added ? 'success' : 'info');
    } else if (result.reason === 'limit') {
      showToast(t('notify.pinLimit', { max: CASES.MAX_PINNED_ROWS }), 'error');
    } else if (result.reason === 'closed') {
      showToast(t('caseBar.pivotRefusedClosed'), 'error');
    } else {
      showToast(t('notify.pinFailed'), 'error');
    }
    renderContext();
    caseView.refresh();
  });

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsView.root.hidden = !settingsOpen;
    settingsBtn.classList.toggle(`${P}-settings-btn--open`, settingsOpen);
    if (settingsOpen) {
      settingsView.urlField.input.value = getRulesUrl();
      renderStatus();
      settingsView.renderTi();
      settingsView.renderClients();
      settingsView.renderMigration();
      settingsView.renderCaseTransfer();
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

  // "Effacer l'historique" used to live here as an unconditional
  // `clearSnapshots()` - now superseded by the migration-aware "Supprimer
  // l'ancien historique" in Settings (N2, phase 5c, `core/migration.ts`),
  // which only deletes the OLD pre-cases keys, and only once they are
  // confirmed copied into a case. See `settings-view.ts`'s Migration block.

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
    const reserved = caseView.isVisible() ? CASE_VIEW_WIDTH : 0;
    const maxX = window.innerWidth - rect.width - MARGIN - reserved;
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
    panel.scrollTop = 0; // the panel is the scroll container (U5)
    // Quietly re-resolve on every open (a case/client may have changed in
    // another tab, or in Settings since this panel was last shown) - the
    // bar keeps showing its last known state while this runs, see
    // case-bar.ts's own doc comment on why that does not flicker.
    void caseBarView.refresh();
  }

  /** Read once per open (#17), before renderAll() so renderRules() sees it right away */
  function loadRecentRules(): void {
    recentRuleIds = listRecentRuleIds();
    log.debug(`recent rules: ${recentRuleIds.length} loaded`);
  }

  function show(ctx: CellContext, x: number, y: number): void {
    backgroundView.root.hidden = true;
    pendingCtx = ctx;
    snapshotId = null;
    loadRecentRules();
    fill(ctx);
    renderAll();
    renderResultValues();
    open(x, y);
    void journalOnOpen(ctx);
  }

  /**
   * U1: the right-clicked event enters the case history as soon as the panel
   * opens on it, without running a rule. Only when a pivot would be allowed
   * right now (resolved key, open case covering it): otherwise `pendingCtx`
   * stays and `runRule` records it on the first pivot, as before. Opening the
   * panel never creates a case (not even the unassigned one).
   * Same editor text as `runRule` uses, read before anything is injected, so
   * `sameEvent` dedups a later pivot on the same cell.
   */
  async function journalOnOpen(ctx: CellContext): Promise<void> {
    try {
      const sourceQuery = getEditorText() ?? '';
      await caseBarView.ensureResolved();
      // The user may have right-clicked another cell or picked a snapshot meanwhile
      if (pendingCtx !== ctx || !visible) return;
      const key = caseBarView.getCurrentKey();
      const target = key !== undefined ? getActiveCaseForKey(key) : undefined;
      if (key === undefined || !target || target.closedAt !== undefined) return;
      if (!checkPivotAllowed(target, key).allowed) return;
      const recorded = recordSnapshotInCase(target.id, ctx, sourceQuery, platform.id);
      if (!recorded.ok || pendingCtx !== ctx) return;
      snapshotId = recorded.snapshot.id;
      pendingCtx = null;
      renderContext();
      caseView.refresh();
    } catch (err) {
      // Never block the panel: the first pivot will record the event instead
      log.warn('pivot-menu: journal on open failed', err);
    }
  }

  function showHistory(x: number, y: number): void {
    pendingCtx = null;
    loadRecentRules();
    const latest = caseSnapshots()[0];
    if (latest) {
      snapshotId = latest.id;
      fill(latest);
    } else {
      snapshotId = null;
      fill({ value: '', column: '', t0: '', t0Raw: '', host: '', row: {}, source: 'dom' });
    }
    renderAll();
    renderResultValues();
    open(x, y);
    if (!latest) paramsView.valueField.input.focus();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    document.removeEventListener('keydown', onKeyDown, true);
    caseView.hide();
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
      caseView.destroy();
    },
  };
}
