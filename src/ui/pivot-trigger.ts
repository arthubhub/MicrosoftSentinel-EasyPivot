import type { CellContext, PlatformAdapter } from '../types.ts';
import { log } from '../core/log.ts';
import { CSS_PREFIX, PIVOT } from '../config.ts';
import { detectForCell } from '../core/detection.ts';
import { getIndicatorLabel } from '../core/pivot.ts';
import { recordCellMenuOutcome } from '../core/health.ts';
import { t } from '../i18n/index.ts';
import { createPivotMenu, type PivotMenuComponent } from './pivot-menu.ts';

export interface PivotTriggerComponent {
  readonly menu: PivotMenuComponent;
  destroy(): void;
}

const OPTION_CLASS = PIVOT.MENU_ITEM_CLASS;

/**
 * Click on a results cell → Pivot.
 *
 * Single permanent listener: `contextmenu` in capture phase on document, so
 * the cell (and any selection inside it) is read before the page handlers.
 * - Shift + right-click, or outside the grid: browser menu, nothing else.
 * - cellMenu 'native': a « Pivot » entry is added first in the grid menu
 *   (AG Grid on Sentinel, Fluent UI ContextualMenu on Defender). When the
 *   grid menu also opens on a left click (menuOnClick), `click` is handled too.
 * - cellMenu 'none': the panel opens directly.
 */
export function createPivotTrigger(platform: PlatformAdapter): PivotTriggerComponent {
  const menu = createPivotMenu(platform);
  let rafId = 0;

  function selectionInside(cell: Element): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const { anchorNode, focusNode } = sel;
    if (!anchorNode || !focusNode || !cell.contains(anchorNode) || !cell.contains(focusNode)) return '';
    return sel.toString().trim();
  }

  function onContextMenu(e: MouseEvent): void {
    handleCellEvent(e, true);
  }

  function onClick(e: MouseEvent): void {
    if (e.button !== 0) return;
    handleCellEvent(e, false);
  }

  function handleCellEvent(e: MouseEvent, rightClick: boolean): void {
    if (e.shiftKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`.${CSS_PREFIX}-pivot, .${OPTION_CLASS}`)) return;

    let ctx = platform.readCellContext(target);
    if (!ctx) {
      log.debug('right-click: not a results cell');
      return;
    }

    const cell = target.closest('[role="gridcell"]') ?? target;
    const selected = selectionInside(cell);
    if (selected) ctx = { ...ctx, value: selected };
    if (!ctx.value) return;

    const { clientX: x, clientY: y } = e;

    if (platform.cellMenu === 'native') {
      waitForContextMenu(ctx, x, y);
    } else if (rightClick) {
      e.preventDefault();
      menu.show(ctx, x, y);
    }
  }

  function waitForContextMenu(ctx: CellContext, x: number, y: number): void {
    cancelAnimationFrame(rafId);
    const start = performance.now();
    const tick = (): void => {
      const list = platform.getOpenContextMenu();
      // A list that already holds the entry is the previous click's menu
      if (list && !list.querySelector(`.${OPTION_CLASS}`)) {
        addPivotItem(list, ctx, x, y);
        return;
      }
      if (performance.now() - start < PIVOT.MENU_WAIT_MS) {
        rafId = requestAnimationFrame(tick);
      } else if (list) {
        // Same menu kept open for the new cell: its entry takes the new context
        addPivotItem(list, ctx, x, y);
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  /** Replace (never keep) a previous entry: the context is always the last click's. */
  function addPivotItem(list: HTMLElement, ctx: CellContext, x: number, y: number): void {
    // One detection per right-click (#18): logged here, not inside the pure
    // detectForCell(), which also runs silently inside render loops below.
    const detection = detectForCell(ctx.value, ctx.column, ctx.entityName);
    log.debug('cell detection', {
      column: ctx.column,
      value: ctx.value,
      entityName: ctx.entityName,
      t0: ctx.t0,
      host: ctx.host,
      rowFields: Object.keys(ctx.row).length,
      tier: detection.tier,
      candidates: detection.candidates,
    });
    list
      .querySelectorAll(`.${OPTION_CLASS}, .${PIVOT.MENU_SEPARATOR_CLASS}`)
      .forEach((n) => n.remove());

    const type = detection.candidates[0];
    const label = type ? t('menu.pivotWithType', { label: getIndicatorLabel(type) }) : t('common.pivot');

    // Diagnostic record only (N6 cell-menu probe): behavior is unchanged,
    // `finally` lets a real failure of addContextMenuItem still propagate.
    try {
      platform.addContextMenuItem(list, label, () => {
        platform.closeContextMenu(list);
        requestAnimationFrame(() => menu.show(ctx, x, y));
      });
    } finally {
      recordCellMenuOutcome(list.querySelector(`.${OPTION_CLASS}`) !== null);
    }
  }

  document.addEventListener('contextmenu', onContextMenu, true);
  if (platform.menuOnClick) document.addEventListener('click', onClick, true);

  return {
    menu,
    destroy() {
      cancelAnimationFrame(rafId);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('click', onClick, true);
      menu.destroy();
    },
  };
}