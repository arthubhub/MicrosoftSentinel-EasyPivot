import type {
  CellContext,
  IndicatorId,
  PivotRule,
  PivotSnapshot,
  PlatformAdapter,
} from '../types.ts';
import { CSS_PREFIX, DEFAULT_RULES_URL } from '../config.ts';
import {
  ACTION_IDS,
  detectIndicators,
  fillQuery,
  getActionLabel,
  getIndicatorIds,
  getIndicatorLabel,
  getRulesForIndicator,
  indicatorHasHostRules,
  parseDurationMinutes,
  parseGridTime,
} from '../core/pivot.ts';
import {
  getCatalogStatus,
  getRulesUrl,
  onCatalogChange,
  reloadCatalog,
  setRulesUrl,
} from '../core/rules-catalog.ts';
import {
  addStep,
  clearSnapshots,
  getSnapshot,
  listSnapshots,
  recordSnapshot,
} from '../core/investigation.ts';
import { getEditorText, injectQuery, replaceEditorContent } from '../core/editor-bridge.ts';
import { showToast } from './notification.ts';

export interface PivotMenuComponent {
  /** Open on a grid cell context (new event) */
  show(ctx: CellContext, x: number, y: number): void;
  /** Open without a cell: reloads the latest snapshot, if any */
  showHistory(x: number, y: number): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

const P = `${CSS_PREFIX}-pivot`;
const MARGIN = 8;
const MAX_FIELD_CHIPS = 30;

const CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
  '<path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, title?: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

function field(
  label: string,
  modifier: '' | 'wide' | 'grow',
  placeholder: string,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = el('label', `${P}-field${modifier ? ` ${P}-field--${modifier}` : ''}`);
  wrap.appendChild(el('span', `${P}-field-label`, label));
  const input = el('input', `${P}-input`);
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  wrap.appendChild(input);
  return { wrap, input };
}

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

function relativeAge(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function snapshotLabel(s: PivotSnapshot): string {
  const origin = s.originRuleId ? ` · depuis ${s.originRuleId}` : '';
  const col = s.column ? `${s.column} = ` : '';
  const steps = s.steps.length ? ` · ${s.steps.length} pivot${s.steps.length > 1 ? 's' : ''}` : '';
  return `${formatTime(s.createdAt)} · ${col}${short(s.value, 40)}${origin}${steps}`;
}

export function createPivotMenu(platform: PlatformAdapter): PivotMenuComponent {
  // ── State ──
  let visible = false;
  let selected: IndicatorId = 'ip';
  const expanded = new Set<string>();
  let settingsOpen = false;
  /** Event from the last right-click, not journaled until a rule runs */
  let pendingCtx: CellContext | null = null;
  /** Snapshot the panel is working on (null = pendingCtx / manual input) */
  let snapshotId: string | null = null;
  let row: Readonly<Record<string, string>> = {};

  // ── DOM ──
  const overlay = el('div', `${CSS_PREFIX}-popup-overlay`);
  overlay.addEventListener('mousedown', () => hide());

  const panel = el('div', P);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Pivot');
  panel.addEventListener('mousedown', (e) => e.stopPropagation());

  // Header
  const header = el('div', `${P}-header`);
  header.appendChild(el('span', `${P}-title`, 'Pivot'));
  const headerActions = el('div', `${P}-header-actions`);
  const settingsBtn = button(`${CSS_PREFIX}-icon-btn ${P}-settings-btn`, '⚙', 'Paramètres');
  const closeBtn = button(`${CSS_PREFIX}-popup-close`, '', 'Fermer (Échap)');
  closeBtn.innerHTML = '&#10005;';
  closeBtn.addEventListener('click', () => hide());
  headerActions.append(settingsBtn, closeBtn);
  header.appendChild(headerActions);

  // Settings
  const settings = el('div', `${P}-settings`);
  settings.hidden = true;
  const urlField = field('URL du catalogue de règles', 'wide', DEFAULT_RULES_URL);
  const settingsActions = el('div', `${P}-actions`);
  const saveUrlBtn = button(`${P}-btn ${P}-btn--primary`, 'Enregistrer et recharger');
  const defaultUrlBtn = button(`${P}-btn`, 'URL par défaut');
  const clearHistoryBtn = button(`${P}-btn`, "Effacer l'historique");
  settingsActions.append(saveUrlBtn, defaultUrlBtn, clearHistoryBtn);
  const catalogStatus = el('div', `${P}-status`);
  const catalogError = el('div', `${P}-status ${P}-status--error`);
  settings.append(urlField.wrap, settingsActions, catalogStatus, catalogError);

  // Context (investigation journal)
  const context = el('div', `${P}-context`);
  const contextRow = el('div', `${P}-row`);
  const historyWrap = el('label', `${P}-field ${P}-field--grow`);
  historyWrap.appendChild(el('span', `${P}-field-label`, 'Événement'));
  const historySelect = el('select', `${P}-input ${P}-history`);
  historyWrap.appendChild(historySelect);
  const restoreBtn = button(`${P}-btn ${P}-restore`, '↶ Requête source');
  contextRow.append(historyWrap, restoreBtn);
  const fieldsLabel = el('span', `${P}-field-label`, 'Champs de la ligne');
  const fields = el('div', `${P}-fields`);
  const steps = el('div', `${P}-steps`);
  context.append(contextRow, fieldsLabel, fields, steps);

  // Params
  const params = el('div', `${P}-params`);
  const valueField = field('Valeur', 'wide', 'Valeur à pivoter');
  const types = el('div', `${P}-types`);
  const timeRow = el('div', `${P}-row`);
  const t0Field = field('T0 (UTC)', 'grow', 'vide = now()');
  const beforeField = field('Avant', '', 'défaut');
  const afterField = field('Après', '', 'défaut');
  const windowHint = 'Minutes, ou 30m, 24h, 7d. Vide = fenêtre par défaut';
  beforeField.input.title = windowHint;
  afterField.input.title = windowHint;
  timeRow.append(t0Field.wrap, beforeField.wrap, afterField.wrap);
  const hostField = field('Machine (règles Processus / Hash)', 'wide', 'vide = toutes');
  params.append(valueField.wrap, types, timeRow, hostField.wrap);

  // Rules
  const list = el('div', `${P}-list`);

  panel.append(header, settings, context, params, list);

  // ── Rendering ──

  function currentSnapshot(): PivotSnapshot | undefined {
    return snapshotId ? getSnapshot(snapshotId) : undefined;
  }

  function renderTypes(): void {
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
        match
          ? 'La valeur correspond à ce type'
          : 'La valeur ne correspond pas à ce type, pivot possible quand même',
      );
      chip.addEventListener('click', () => {
        selected = id;
        renderTypes();
        renderRules();
      });
      types.appendChild(chip);
    }
    hostField.wrap.hidden = !indicatorHasHostRules(selected);
  }

  function ruleMeta(rule: PivotRule): string {
    const parts = [rule.id, `−${rule.window.before} / +${rule.window.after}`];
    if (rule.render && rule.render !== 'table') parts.push(rule.render);
    return parts.join(' · ');
  }

  function renderRule(rule: PivotRule, ran: ReadonlySet<string>): HTMLElement {
    const item = el('div', `${P}-rule`);

    const rowEl = el('div', `${P}-rule-row`);
    rowEl.title = 'Injecter la requête dans l\'éditeur';
    const body = el('div', `${P}-rule-body`);
    const name = el('div', `${P}-rule-name`);
    name.appendChild(el('span', '', rule.name));
    if (rule.v1) name.appendChild(el('span', `${CSS_PREFIX}-badge ${CSS_PREFIX}-badge--source`, 'v1'));
    if (ran.has(rule.id)) {
      const badge = el('span', `${CSS_PREFIX}-badge ${P}-badge--ran`, '✓ lancée');
      badge.title = 'Déjà lancée sur cette valeur depuis cet événement';
      name.appendChild(badge);
    }
    body.append(name, el('div', `${P}-rule-meta`, ruleMeta(rule)));

    const chevron = button(`${CSS_PREFIX}-icon-btn ${CSS_PREFIX}-icon-btn--chevron`, '', 'Détails');
    chevron.innerHTML = CHEVRON_SVG;

    const details = el('div', `${P}-rule-details`);
    details.appendChild(el('p', `${P}-rule-desc`, rule.description));
    const reading: [keyof NonNullable<PivotRule['reading']>, string][] = [
      ['decisive', 'Tranche : '],
      ['context', 'Oriente : '],
      ['noise', 'Bruit : '],
    ];
    for (const [key, label] of reading) {
      const text = rule.reading?.[key];
      if (!text) continue;
      const line = el('div', `${P}-reading ${P}-reading--${key}`);
      line.append(el('strong', '', label), document.createTextNode(text));
      details.appendChild(line);
    }

    const setOpen = (open: boolean): void => {
      details.hidden = !open;
      chevron.classList.toggle(`${CSS_PREFIX}-icon-btn--chevron-open`, open);
    };
    setOpen(expanded.has(rule.id));

    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded.has(rule.id)) expanded.delete(rule.id);
      else expanded.add(rule.id);
      setOpen(expanded.has(rule.id));
    });
    rowEl.addEventListener('click', () => runRule(rule));

    rowEl.append(body, chevron);
    item.append(rowEl, details);
    return item;
  }

  function renderRules(): void {
    list.replaceChildren();
    const rules = getRulesForIndicator(selected);
    if (rules.length === 0) {
      list.appendChild(el('div', `${CSS_PREFIX}-empty`, 'Aucune règle pour ce type'));
      return;
    }

    const value = valueField.input.value.trim();
    const ran = new Set(
      (currentSnapshot()?.steps ?? []).filter((s) => s.value === value).map((s) => s.ruleId),
    );

    for (const action of ACTION_IDS) {
      const group = rules.filter((r) => r.action === action);
      if (group.length === 0) continue;
      const section = el('div', `${P}-section`);
      section.appendChild(
        el('div', `${P}-section-title ${P}-section-title--${action}`, getActionLabel(action)),
      );
      for (const rule of group) section.appendChild(renderRule(rule, ran));
      list.appendChild(section);
    }
  }

  function renderContext(): void {
    const snapshots = listSnapshots();
    const snap = currentSnapshot();

    historySelect.replaceChildren();
    if (pendingCtx && !snap) {
      const opt = el('option', '', `Clic actuel · ${pendingCtx.column} = ${short(pendingCtx.value, 40)}`);
      opt.value = '';
      historySelect.appendChild(opt);
    } else if (!snap) {
      const opt = el('option', '', snapshots.length ? '— Choisir un événement —' : 'Aucun événement enregistré');
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
        ? 'Requête source non enregistrée (éditeur vide ou trop volumineux)'
        : "Remet dans l'éditeur la requête qui avait produit cet événement (Ctrl+Z pour annuler)";

    renderFields();

    steps.replaceChildren();
    if (snap?.steps.length) {
      steps.appendChild(el('span', `${P}-field-label`, 'Pivots lancés : '));
      steps.appendChild(
        document.createTextNode(
          snap.steps.map((s) => `${s.ruleId} (${short(s.value, 24)})`).join(' · '),
        ),
      );
    }

    context.hidden = snapshots.length === 0 && !pendingCtx;
  }

  function renderFields(): void {
    fields.replaceChildren();
    const current = valueField.input.value.trim();
    let count = 0;
    for (const [col, val] of Object.entries(row)) {
      if (count >= MAX_FIELD_CHIPS) break;
      const detected = detectIndicators(val);
      if (detected.length === 0) continue;
      count++;
      let cls = `${CSS_PREFIX}-category-chip ${P}-field-chip`;
      if (val === current) cls += ` ${CSS_PREFIX}-category-chip--active`;
      const chip = button(cls, `${col} : ${short(val, 32)}`, `${val}\n(${detected.map(getIndicatorLabel).join(', ')})`);
      chip.addEventListener('click', () => {
        valueField.input.value = val;
        selected = detected[0];
        renderAll();
      });
      fields.appendChild(chip);
    }
    fieldsLabel.hidden = count === 0;
    fields.hidden = count === 0;
  }

  function renderStatus(): void {
    const st = getCatalogStatus();
    const source =
      st.source === 'bundled'
        ? 'intégré au script'
        : st.source === 'cache'
          ? `cache (${relativeAge(st.fetchedAt)})`
          : `téléchargé (${relativeAge(st.fetchedAt)})`;
    catalogStatus.textContent = `Catalogue v${st.version} · ${st.ruleCount} règles · ${source}`;
    catalogError.textContent = st.error ? `Échec du téléchargement : ${st.error}` : '';
    catalogError.hidden = !st.error;
  }

  function renderAll(): void {
    renderContext();
    renderTypes();
    renderRules();
    if (settingsOpen) renderStatus();
  }

  // ── Loading a context into the fields ──

  function fill(c: CellContext): void {
    valueField.input.value = c.value;
    t0Field.input.value = c.t0;
    t0Field.input.title = c.t0Raw ? `Lu dans la grille : ${c.t0Raw}` : 'Heure de la ligne introuvable';
    hostField.input.value = c.host;
    beforeField.input.value = '';
    afterField.input.value = '';
    row = c.row;
    selected = detectIndicators(c.value)[0] ?? selected;
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

  function runRule(rule: PivotRule): void {
    const value = valueField.input.value.trim();
    if (!value) {
      showToast('Valeur vide', 'error');
      valueField.input.focus();
      return;
    }

    const before = parseDurationMinutes(beforeField.input.value);
    const after = parseDurationMinutes(afterField.input.value);
    if (Number.isNaN(before) || Number.isNaN(after)) {
      showToast('Fenêtre invalide : minutes, ou 30m, 24h, 7d', 'error');
      return;
    }

    // The field is labelled UTC: a date without time zone is read as UTC
    const t0Text = t0Field.input.value.trim();
    const t0 = t0Text ? parseGridTime(t0Text, true) : '';
    if (t0Text && !t0) {
      showToast('T0 invalide : format ISO attendu (2026-10-08T09:21:14Z)', 'error');
      t0Field.input.focus();
      return;
    }

    const host = hostField.wrap.hidden ? '' : hostField.input.value.trim();
    const kql = fillQuery(rule, { value, t0, beforeMinutes: before, afterMinutes: after, host }, platform.id);

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

    const result = injectQuery(kql);
    if (result === 'injected') {
      const timeHint = platform.id === 'defender' ? ' Sélecteur de temps : « Set in query »' : '';
      showToast(`${rule.id} injectée.${timeHint}`, 'success');
    } else if (result === 'clipboard') {
      showToast(`${rule.id} copiée dans le presse-papier`, 'info');
    } else {
      showToast("Impossible d'injecter la requête", 'error');
      return;
    }

    if (snapshotId) addStep(snapshotId, { ruleId: rule.id, value, indicator: selected });
    hide();
  }

  function restoreSource(): void {
    const snap = currentSnapshot();
    if (!snap?.sourceQuery) return;
    if (replaceEditorContent(snap.sourceQuery)) {
      showToast('Requête source restaurée (Ctrl+Z pour annuler)', 'success');
      hide();
    } else {
      showToast('Éditeur introuvable', 'error');
    }
  }

  // ── Wiring ──

  valueField.input.addEventListener('input', () => {
    renderTypes();
    renderFields();
  });

  historySelect.addEventListener('change', () => {
    if (historySelect.value) {
      loadSnapshot(historySelect.value);
    } else if (pendingCtx) {
      snapshotId = null;
      fill(pendingCtx);
      renderAll();
    }
  });

  restoreBtn.addEventListener('click', restoreSource);

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settings.hidden = !settingsOpen;
    settingsBtn.classList.toggle(`${P}-settings-btn--open`, settingsOpen);
    if (settingsOpen) {
      urlField.input.value = getRulesUrl();
      renderStatus();
    }
  });

  const reload = (url: string): void => {
    setRulesUrl(url);
    urlField.input.value = getRulesUrl();
    saveUrlBtn.disabled = true;
    catalogStatus.textContent = 'Téléchargement…';
    void reloadCatalog().then((st) => {
      saveUrlBtn.disabled = false;
      if (st.error) showToast('Catalogue non téléchargé, version précédente conservée', 'error');
      else showToast(`Catalogue v${st.version} chargé (${st.ruleCount} règles)`, 'success');
    });
  };
  saveUrlBtn.addEventListener('click', () => reload(urlField.input.value));
  defaultUrlBtn.addEventListener('click', () => reload(''));

  clearHistoryBtn.addEventListener('click', () => {
    clearSnapshots();
    snapshotId = null;
    renderContext();
    renderRules();
    showToast('Historique des événements effacé', 'info');
  });

  const unsubscribe = onCatalogChange(() => {
    if (!visible) return;
    renderTypes();
    renderRules();
    if (settingsOpen) renderStatus();
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
    list.scrollTop = 0;
  }

  function show(ctx: CellContext, x: number, y: number): void {
    pendingCtx = ctx;
    snapshotId = null;
    fill(ctx);
    renderAll();
    open(x, y);
  }

  function showHistory(x: number, y: number): void {
    pendingCtx = null;
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
    if (!latest) valueField.input.focus();
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
      unsubscribe();
    },
  };
}
