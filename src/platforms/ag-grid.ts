import type { CellContext } from '../types.ts';
import { PIVOT, SELECTORS } from '../config.ts';
import { parseGridTime } from '../core/pivot.ts';

/**
 * Reading the Sentinel results grid (AG Grid).
 *
 *   la-ag-grid
 *   └ .logs-results-grid .ag-root[role=grid]                ← GRID_ROOT
 *      ├ [role=columnheader][col-id=TimeGenerated]  « TimeGenerated [UTC] »
 *      └ [role=row][row-index=N]   (one row is split between the pinned
 *          └ [role=gridcell][col-id=<Column>][title=<full value>]  and center containers)
 *
 * Limit: AG Grid virtualizes columns. An off-screen column has no cell in the
 * DOM, so T0, HOST or row fields can be missing; the panel stays editable.
 */

const S = SELECTORS.SENTINEL;
const IGNORED = PIVOT.IGNORED_COLUMNS as readonly string[];

/** Full (untruncated) cell value */
function cellText(cell: Element): string {
  const title = cell.getAttribute('title');
  if (title) return title.trim();
  // Grouped cells (e.g. TimeGenerated) also display a counter: read the value only
  const group = cell.querySelector('.ag-group-value');
  if (group?.textContent) return group.textContent.trim();
  const value = cell.querySelector('.ag-cell-value');
  return (value?.textContent ?? cell.textContent ?? '').trim();
}

function rowSelector(rowIndex: string): string {
  return `[role="row"][row-index="${CSS.escape(rowIndex)}"]`;
}

/**
 * Search from the grid root, not from the row element: one logical row is
 * spread across several containers (pinned left, center, pinned right).
 */
function findRowCell(
  grid: Element,
  rowIndex: string,
  cols: readonly string[],
): { col: string; cell: Element } | null {
  for (const col of cols) {
    const cell = grid.querySelector(
      `${rowSelector(rowIndex)} [role="gridcell"][col-id="${CSS.escape(col)}"]`,
    );
    if (cell) return { col, cell };
  }
  return null;
}

/** Every rendered cell of the row (column → value) */
function readRow(grid: Element, rowIndex: string): Record<string, string> {
  const row: Record<string, string> = {};
  for (const cell of grid.querySelectorAll(`${rowSelector(rowIndex)} ${S.GRID_CELL}`)) {
    const col = cell.getAttribute('col-id') ?? '';
    if (!col || IGNORED.includes(col) || col in row) continue;
    const text = cellText(cell);
    if (text) row[col] = text;
  }
  return row;
}

/** Header « [UTC] » or no indication → UTC; « [Local Time] » → local */
function isUtcColumn(grid: Element, col: string): boolean {
  const header = grid.querySelector(`[role="columnheader"][col-id="${CSS.escape(col)}"]`);
  const text = header?.textContent ?? '';
  return !/local/i.test(text);
}

export function readAgGridCellContext(target: Element): CellContext | null {
  const cell = target.closest(S.GRID_CELL);
  if (!cell) return null;
  const grid = cell.closest(S.GRID_ROOT);
  if (!grid) return null;

  const column = cell.getAttribute('col-id') ?? '';
  if (!column || IGNORED.includes(column)) return null;

  const value = cellText(cell);
  const rowIndex = cell.closest(S.GRID_ROW)?.getAttribute('row-index') ?? '';

  let t0 = '';
  let t0Raw = '';
  let host = '';
  let row: Record<string, string> = {};

  if (rowIndex) {
    const time = findRowCell(grid, rowIndex, PIVOT.TIME_COLUMNS);
    if (time) {
      t0Raw = cellText(time.cell);
      t0 = parseGridTime(t0Raw, isUtcColumn(grid, time.col));
    }
    const hostCell = findRowCell(grid, rowIndex, PIVOT.HOST_COLUMNS);
    if (hostCell) host = cellText(hostCell.cell);
    row = readRow(grid, rowIndex);
  }

  return { value, column, t0, t0Raw, host, row };
}

export function getOpenAgGridContextMenu(): HTMLElement | null {
  if (!document.querySelector(S.CONTEXT_MENU_OPEN)) return null;
  return document.querySelector<HTMLElement>(S.CONTEXT_MENU_LIST);
}
