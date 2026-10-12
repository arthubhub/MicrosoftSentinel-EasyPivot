import type { CellContext, PlatformAdapter } from '../types.ts';
import { CSS_PREFIX, PIVOT } from '../config.ts';
import { detectIndicators, getIndicatorLabel } from '../core/pivot.ts';
import { createPivotMenu, type PivotMenuComponent } from './pivot-menu.ts';

export interface PivotTriggerComponent {
  readonly menu: PivotMenuComponent;
  destroy(): void;
}

const OPTION_CLASS = `${CSS_PREFIX}-pivot-ag-option`;
const SEPARATOR_CLASS = `${CSS_PREFIX}-pivot-ag-option-separator`;

/**
 * Right-click on a results cell → Pivot.
 *
 * Single permanent listener: `contextmenu` in capture phase on document, so
 * the cell (and any selection inside it) is read before the page handlers.
 * - Shift + right-click, or outside the grid: browser menu, nothing else.
 * - cellMenu 'native' (Sentinel): a « Pivot » entry is added to the grid menu.
 * - cellMenu 'none' (Defender, once mapped): the panel opens directly.
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
    if (e.shiftKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`.${CSS_PREFIX}-pivot, .${OPTION_CLASS}`)) return;

    let ctx = platform.readCellContext(target);
    if (!ctx) return;

    const cell = target.closest('[role="gridcell"]') ?? target;
    const selected = selectionInside(cell);
    if (selected) ctx = { ...ctx, value: selected };
    if (!ctx.value) return;

    const { clientX: x, clientY: y } = e;

    if (platform.cellMenu === 'native') {
      waitForContextMenu(ctx, x, y);
    } else {
      e.preventDefault();
      menu.show(ctx, x, y);
    }
  }

  function waitForContextMenu(ctx: CellContext, x: number, y: number): void {
    cancelAnimationFrame(rafId);
    const start = performance.now();
    const tick = (): void => {
      const list = platform.getOpenContextMenu();
      if (list) {
        addPivotItem(list, ctx, x, y);
        return;
      }
      if (performance.now() - start < PIVOT.MENU_WAIT_MS) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  /** Replace (never keep) a previous entry: the context is always the last click's. */
  function addPivotItem(list: HTMLElement, ctx: CellContext, x: number, y: number): void {
    list.querySelectorAll(`.${OPTION_CLASS}, .${SEPARATOR_CLASS}`).forEach((n) => n.remove());

    const type = detectIndicators(ctx.value)[0];
    const label = type ? `Pivot · ${getIndicatorLabel(type)}` : 'Pivot';

    // AG Grid's own markup, to inherit the native rendering
    const item = document.createElement('div');
    item.className = `ag-menu-option ${OPTION_CLASS}`;
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    const parts: [string, string][] = [
      ['ag-menu-option-icon', '⇄'],
      ['ag-menu-option-text', label],
      ['ag-menu-option-shortcut', ''],
      ['ag-menu-option-popup-pointer', ''],
    ];
    for (const [cls, text] of parts) {
      const span = document.createElement('span');
      span.className = `ag-menu-option-part ${cls}`;
      span.textContent = text;
      item.appendChild(span);
    }

    const separator = document.createElement('div');
    separator.className = `ag-menu-separator ${SEPARATOR_CLASS}`;
    separator.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) {
      const part = document.createElement('div');
      part.className = 'ag-menu-separator-part';
      separator.appendChild(part);
    }

    // Otherwise AG Grid sees an outside click and closes its menu first
    item.addEventListener('mousedown', (ev) => ev.stopPropagation());
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeContextMenu(list);
      requestAnimationFrame(() => menu.show(ctx, x, y));
    });

    list.prepend(item, separator);
  }

  /**
   * Escape on the list, then (if still open) a simulated outside mousedown.
   * Fragile by nature: check after each AG Grid update.
   */
  function closeContextMenu(list: HTMLElement): void {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    requestAnimationFrame(() => {
      if (platform.getOpenContextMenu()) {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
    });
  }

  document.addEventListener('contextmenu', onContextMenu, true);

  return {
    menu,
    destroy() {
      cancelAnimationFrame(rafId);
      document.removeEventListener('contextmenu', onContextMenu, true);
      menu.destroy();
    },
  };
}
