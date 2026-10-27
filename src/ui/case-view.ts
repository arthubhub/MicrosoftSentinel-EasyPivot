import type { Case, PivotSnapshot } from '../types.ts';
import { CASES, CSS_PREFIX } from '../config.ts';
import { buildCaseExport } from '../core/case-export.ts';
import { getCase, getCaseSnapshots, closeCase, setCaseNotes, setSnapshotNote, unpinRow } from '../core/cases.ts';
import { getClient } from '../core/clients.ts';
import { buildTree, type TreeNode } from '../core/graph.ts';
import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { caseDisplayName } from './case-name.ts';
import { showToast } from './notification.ts';
import { openReportDialog } from './report-dialog.ts';
import { P, el, button, downloadJson } from './panel/shared.ts';

/**
 * Case view (N3, phase 5e-2): the right-hand side panel showing the ACTIVE
 * case - header, the event tree from `core/graph.ts`, a note per event and a
 * global note. Thin on purpose: every read and write goes through
 * `core/cases.ts` / `core/graph.ts`; this module only renders and dispatches.
 *
 * HOSTILE DATA: values, columns, notes, case and client names come from the
 * portal or from imported files. Everything below is built with
 * `createElement` + `textContent` / `.value` - there is no `innerHTML` and no
 * HTML string built from data anywhere in this file.
 *
 * RE-RENDERING: `refresh()` repaints the whole view (<= 200 nodes). It is
 * skipped while a textarea of this view has focus, so a repaint can never
 * eat what the analyst is typing; notes are saved on blur and the few things
 * that change after a save (note icon) are updated in place.
 */

const V = `${CSS_PREFIX}-case-view`;
/** Matches `width` in styles/case-view.css.ts; `ui/pivot-menu.ts` keeps the Pivot panel clear of it. */
export const CASE_VIEW_WIDTH = 420;
/** Deeper levels keep the same indent so a long chain does not push the labels off-screen. */
const MAX_INDENT_DEPTH = 8;

export interface CaseViewOptions {
  /** Id of the active case, or undefined when there is none (re-read on every paint) */
  readonly getCaseId: () => string | undefined;
  /** Snapshot currently loaded in the Pivot panel, to highlight it */
  readonly getSelectedSnapshotId: () => string | null;
  /** A node was clicked: load that snapshot into the Pivot panel */
  readonly onSelectSnapshot: (snapshotId: string) => void;
  /** The case was closed from here: the case bar and the Pivot panel must repaint */
  readonly onCaseChanged: () => void;
  /** Called after the view opens or closes, so the Pivot panel can make room */
  readonly onVisibilityChange: () => void;
}

export interface CaseViewComponent {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** Repaints when visible; never throws */
  refresh(): void;
  destroy(): void;
}

function short(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function createCaseView(options: CaseViewOptions): CaseViewComponent {
  let visible = false;
  const collapsed = new Set<string>();
  const detailsOpen = new Set<string>();

  const root = el('aside', V);
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', t('caseView.title'));
  // Same rule as the Pivot panel: clicks inside never reach the page's own handlers.
  root.addEventListener('mousedown', (e) => e.stopPropagation());

  const headerEl = el('div', `${V}-header`);
  const bodyEl = el('div', `${V}-body`);
  root.append(headerEl, bodyEl);

  // ── Helpers ──

  function textareaHasFocus(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && root.contains(active);
  }

  function noteArea(
    initial: string,
    placeholder: string,
    ariaLabel: string,
    readOnly: boolean,
    save: (value: string) => boolean,
  ): HTMLDivElement {
    const wrap = el('div', `${V}-note`);
    const area = el('textarea', `${V}-textarea`);
    area.value = initial;
    area.placeholder = placeholder;
    area.rows = 3;
    area.maxLength = CASES.MAX_NOTE_CHARS;
    area.spellcheck = false;
    area.setAttribute('aria-label', ariaLabel);
    const status = el('span', `${V}-note-status`);
    let lastSaved = initial;

    if (readOnly) {
      area.disabled = true;
      area.title = t('caseView.readOnly');
      wrap.append(area, el('span', `${V}-note-status ${V}-note-status--reason`, t('caseView.readOnly')));
      return wrap;
    }

    area.addEventListener('input', () => {
      status.textContent = '';
    });
    area.addEventListener('blur', () => {
      if (area.value === lastSaved) return;
      if (save(area.value)) {
        lastSaved = area.value;
        status.textContent = t('caseView.saved');
      } else {
        showToast(t('caseView.noteSaveFailed'), 'error');
      }
    });
    wrap.append(area, status);
    return wrap;
  }

  // ── Header ──

  function paintHeader(c: Case | undefined): void {
    headerEl.replaceChildren();
    const top = el('div', `${V}-header-row`);
    top.appendChild(el('span', `${V}-title`, c ? caseDisplayName(c) : t('caseView.title')));
    if (c) {
      const closed = c.closedAt !== undefined;
      top.appendChild(
        el('span', `${CSS_PREFIX}-badge ${V}-status${closed ? ` ${V}-status--closed` : ''}`, closed ? t('caseBar.closedBadge') : t('caseView.statusOpen')),
      );
    }
    const closeBtn = button(`${CSS_PREFIX}-popup-close`, '', t('caseView.closeTitle'));
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => hide());
    top.appendChild(closeBtn);
    headerEl.appendChild(top);
    if (!c) return;

    const closed = c.closedAt !== undefined;
    const client = c.clientId ? getClient(c.clientId) : undefined;
    if (client) headerEl.appendChild(el('div', `${V}-client`, t('caseBar.client', { name: client.name })));

    const actions = el('div', `${V}-header-row`);
    const exportBtn = button(`${P}-btn ${V}-btn`, t('caseView.export'), t('caseView.exportTitle'));
    exportBtn.addEventListener('click', () => doExport(c.id));
    const closeCaseBtn = button(`${P}-btn ${V}-btn`, t('caseView.closeCase'), t('caseView.closeCaseTitle'));
    closeCaseBtn.disabled = closed;
    closeCaseBtn.addEventListener('click', () => doCloseCase(c));
    const reportBtn = button(`${P}-btn ${V}-btn`, t('caseView.report'), t('caseView.reportTitle'));
    reportBtn.addEventListener('click', () => openReportDialog({ caseId: c.id, caseName: caseDisplayName(c), ...(client ? { clientName: client.name } : {}) }));
    actions.append(reportBtn, exportBtn, closeCaseBtn);
    headerEl.appendChild(actions);
  }

  function doExport(caseId: string): void {
    try {
      // Masked, like the default of Settings → Cases: the plain-values export stays there, behind its confirmation.
      const data = buildCaseExport(caseId, { includeValues: false });
      if (!data) {
        showToast(t('settings.caseExport.exportFailed'), 'error');
        return;
      }
      downloadJson(`easypivot-case-${Date.now()}.json`, data);
      showToast(t('settings.caseExport.exportedMasked', { snapshots: data.snapshots.length, runs: data.runs.length }), 'success');
    } catch (err) {
      log.error('case-view: export failed', err);
      showToast(t('settings.caseExport.exportFailed'), 'error');
    }
  }

  function doCloseCase(c: Case): void {
    if (!window.confirm(t('caseView.confirmClose', { name: caseDisplayName(c) }))) return;
    const result = closeCase(c.id);
    if (!result.ok) {
      showToast(t('caseView.closeFailed'), 'error');
      return;
    }
    showToast(t('caseView.closed'), 'info');
    try {
      options.onCaseChanged();
    } catch (err) {
      log.error('case-view: onCaseChanged failed', err);
    }
    paint();
  }

  // ── Tree ──

  function nodeBadges(node: TreeNode): HTMLElement {
    const badges = el('span', `${V}-badges`);
    const r = node.lastResult;
    if (r) {
      badges.appendChild(el('span', `${CSS_PREFIX}-badge ${V}-rows`, t('caseView.rows', { n: r.rows })));
      if (r.truncated) badges.appendChild(el('span', `${CSS_PREFIX}-badge ${V}-flag ${V}-flag--warn`, t('caseView.truncated')));
      if (r.error) badges.appendChild(el('span', `${CSS_PREFIX}-badge ${V}-flag ${V}-flag--error`, t('caseView.error')));
    } else {
      const none = el('span', `${CSS_PREFIX}-badge ${V}-rows ${V}-rows--none`, '—');
      none.title = t('caseView.noResult');
      badges.appendChild(none);
    }
    if (node.pivotCount > 0) badges.appendChild(el('span', `${V}-pivots`, t('caseView.pivots', { n: node.pivotCount })));
    const noteIcon = el('span', `${V}-note-icon`, '✎');
    noteIcon.title = t('caseView.hasNote');
    noteIcon.hidden = !node.hasNote;
    noteIcon.dataset.snapshot = node.snapshotId;
    badges.appendChild(noteIcon);
    if (node.pinnedCount > 0) {
      const pin = el('span', `${V}-pin-count`, `📌 ${node.pinnedCount}`);
      pin.title = t('caseView.pinned', { n: node.pinnedCount });
      badges.appendChild(pin);
    }
    return badges;
  }

  function pinnedList(c: Case, snap: PivotSnapshot, readOnly: boolean): HTMLElement | null {
    const rows = snap.pinnedRows ?? [];
    if (rows.length === 0) return null;
    const box = el('div', `${V}-pinned`);
    box.appendChild(el('div', `${V}-label`, `${t('caseView.pinnedList')} (${rows.length})`));
    rows.forEach((row, index) => {
      const line = el('div', `${V}-pinned-row`);
      const text = Object.entries(row)
        .map(([col, val]) => `${col}=${val}`)
        .join(' · ');
      const span = el('span', `${V}-pinned-text`, short(text, 240));
      span.title = short(text, 2000);
      line.appendChild(span);
      const rm = button(`${CSS_PREFIX}-icon-btn ${V}-unpin`, '✕', t('caseView.unpin'));
      rm.disabled = readOnly;
      rm.addEventListener('click', () => {
        const result = unpinRow(c.id, snap.id, index);
        if (!result.ok) showToast(t('caseView.unpinFailed'), 'error');
        notifyChanged();
      });
      line.appendChild(rm);
      box.appendChild(line);
    });
    return box;
  }

  /** The pivot panel's pin counter depends on this data too, so a change here goes through the host. */
  function notifyChanged(): void {
    try {
      options.onCaseChanged();
    } catch (err) {
      log.error('case-view: onCaseChanged failed', err);
    }
    paint();
  }

  function renderNode(
    parent: HTMLElement,
    node: TreeNode,
    depth: number,
    c: Case,
    snaps: ReadonlyMap<string, PivotSnapshot>,
    selectedId: string | null,
    readOnly: boolean,
  ): void {
    const snap = snaps.get(node.snapshotId);
    const item = el('div', `${V}-node`);
    item.dataset.depth = String(depth);
    item.style.setProperty('--shq-depth', String(Math.min(depth, MAX_INDENT_DEPTH)));

    const row = el('div', `${V}-node-row${node.snapshotId === selectedId ? ` ${V}-node-row--selected` : ''}`);
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.snapshotId);
    if (hasChildren) {
      const toggle = button(`${V}-toggle`, isCollapsed ? '▸' : '▾', isCollapsed ? t('caseView.expand') : t('caseView.collapse'));
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.addEventListener('click', () => {
        if (isCollapsed) collapsed.delete(node.snapshotId);
        else collapsed.add(node.snapshotId);
        paint();
      });
      row.appendChild(toggle);
    } else {
      row.appendChild(el('span', `${V}-toggle ${V}-toggle--leaf`));
    }

    const label = button(`${V}-node-label`, '', t('caseView.loadTitle'));
    if (node.column) label.appendChild(el('span', `${V}-node-column`, node.column));
    label.appendChild(el('span', `${V}-node-value`, short(node.value, 80)));
    label.addEventListener('click', () => {
      detailsOpen.add(node.snapshotId);
      options.onSelectSnapshot(node.snapshotId);
      // The host usually repaints through refresh(); do it here too so the highlight never depends on that.
      paint();
    });
    row.appendChild(label);
    row.appendChild(nodeBadges(node));

    const detailsBtn = button(`${CSS_PREFIX}-icon-btn ${V}-details-toggle`, '…', t('caseView.detailsToggle'));
    detailsBtn.setAttribute('aria-expanded', String(detailsOpen.has(node.snapshotId)));
    detailsBtn.addEventListener('click', () => {
      if (detailsOpen.has(node.snapshotId)) detailsOpen.delete(node.snapshotId);
      else detailsOpen.add(node.snapshotId);
      paint();
    });
    row.appendChild(detailsBtn);
    item.appendChild(row);

    if (detailsOpen.has(node.snapshotId) && snap) {
      const details = el('div', `${V}-details`);
      details.appendChild(el('div', `${V}-label`, t('caseView.nodeNote')));
      const area = noteArea(snap.note ?? '', t('caseView.nodeNotePlaceholder'), t('caseView.nodeNote'), readOnly, (value) => {
        const result = setSnapshotNote(c.id, snap.id, value);
        if (result.ok) {
          // Update the icon in place: a repaint here would swallow the click that caused the blur.
          for (const icon of Array.from(root.querySelectorAll<HTMLElement>(`.${V}-note-icon`))) {
            if (icon.dataset.snapshot === snap.id) icon.hidden = result.cleared;
          }
        }
        return result.ok;
      });
      details.appendChild(area);
      const pinned = pinnedList(c, snap, readOnly);
      if (pinned) details.appendChild(pinned);
      item.appendChild(details);
    }
    parent.appendChild(item);

    if (hasChildren && !isCollapsed) {
      for (const child of node.children) renderNode(parent, child, depth + 1, c, snaps, selectedId, readOnly);
    }
  }

  function paintBody(c: Case): void {
    bodyEl.replaceChildren();
    const readOnly = c.closedAt !== undefined;
    if (readOnly) bodyEl.appendChild(el('div', `${V}-readonly`, t('caseView.readOnly')));

    // Global note
    const noteBox = el('div', `${V}-section`);
    noteBox.appendChild(el('div', `${V}-label`, t('caseView.globalNote')));
    noteBox.appendChild(
      noteArea(c.notes, t('caseView.globalNotePlaceholder'), t('caseView.globalNote'), readOnly, (value) => setCaseNotes(c.id, value).ok),
    );
    bodyEl.appendChild(noteBox);

    // Tree
    const tree = buildTree(c.id);
    const snaps = new Map<string, PivotSnapshot>();
    for (const s of getCaseSnapshots(c.id)) if (!snaps.has(s.id)) snaps.set(s.id, s);
    const treeBox = el('div', `${V}-section`);
    treeBox.appendChild(el('div', `${V}-label`, t('caseView.tree', { n: snaps.size })));
    if (tree.roots.length === 0) {
      treeBox.appendChild(el('div', `${V}-empty`, t('caseView.treeEmpty')));
    } else {
      const list = el('div', `${V}-tree`);
      list.setAttribute('role', 'tree');
      const selectedId = options.getSelectedSnapshotId();
      for (const rootNode of tree.roots) renderNode(list, rootNode, 0, c, snaps, selectedId, readOnly);
      treeBox.appendChild(list);
    }
    bodyEl.appendChild(treeBox);
  }

  function paint(): void {
    try {
      const caseId = options.getCaseId();
      const c = caseId ? getCase(caseId) : undefined;
      paintHeader(c);
      if (!c) {
        bodyEl.replaceChildren(el('div', `${V}-empty`, t('caseView.noCase')));
        return;
      }
      paintBody(c);
    } catch (err) {
      // Never throw into the panel; an empty body beats a broken page.
      log.error('case-view: paint failed', err);
      bodyEl.replaceChildren(el('div', `${V}-empty`, t('caseView.noCase')));
    }
  }

  // ── Show / hide ──

  function show(): void {
    if (visible) return;
    document.body.appendChild(root);
    visible = true;
    paint();
    options.onVisibilityChange();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    root.remove();
    options.onVisibilityChange();
  }

  function refresh(): void {
    if (!visible || textareaHasFocus()) return;
    paint();
  }

  return {
    show,
    hide,
    isVisible: () => visible,
    refresh,
    destroy: () => hide(),
  };
}
