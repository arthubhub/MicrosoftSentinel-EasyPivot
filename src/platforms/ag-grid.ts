import type { CellContext } from '../types.ts';
import { PIVOT, SELECTORS } from '../config.ts';
import { parseGridTime } from '../core/pivot.ts';
import { log } from '../core/log.ts';
import { getLastCapture } from '../capture/interceptor.ts';
import { matchCapturedRow, stringifyCell } from '../capture/match-row.ts';

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

/**
 * Tier 2 of W2 step 2 (#14): AG Grid's own row data, bypassing the
 * virtualized DOM entirely (the limit this function exists to work around
 * - see the file header). AG Grid does not expose a stable, documented way
 * to reach its `GridApi` from the DOM alone; this is a best-effort,
 * duck-typed scan for an object that LOOKS like one (has
 * `getDisplayedRowAtIndex`), walking a few ancestors from the grid root
 * and checking their own enumerable properties (plus one level of `.api`/
 * `.gridApi` nesting, a common wrapper shape).
 *
 * **Not verified against a live grid this session** (no browser available):
 * if Sentinel's AG Grid instance is not reachable this way, this always
 * returns `null` and tier 3 (DOM, below) takes over - exactly the
 * capture-disabled/empty behaviour, so a wrong guess here can only ever
 * fall through, never corrupt a result (constraint: no DOM-tier
 * regression). Confirm in a real session and fix the lookup if it never
 * fires in practice.
 */
function findGridApi(root: Element): { getDisplayedRowAtIndex(i: number): { data?: unknown } | null } | null {
  type MaybeApi = { getDisplayedRowAtIndex?: unknown };
  const looksLikeApi = (v: unknown): v is { getDisplayedRowAtIndex(i: number): { data?: unknown } | null } =>
    typeof v === 'object' && v !== null && typeof (v as MaybeApi).getDisplayedRowAtIndex === 'function';

  let el: Element | null = root;
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    const own = el as unknown as Record<string, unknown>;
    for (const key of Object.keys(own)) {
      const candidate = own[key];
      if (looksLikeApi(candidate)) return candidate;
      if (candidate && typeof candidate === 'object') {
        const nested = (candidate as Record<string, unknown>).api ?? (candidate as Record<string, unknown>).gridApi;
        if (looksLikeApi(nested)) return nested;
      }
    }
  }
  return null;
}

function readAgGridRowData(grid: Element, rowIndex: string): Record<string, string> | null {
  try {
    const api = findGridApi(grid);
    if (!api) return null;
    const idx = Number(rowIndex);
    if (!Number.isFinite(idx)) return null;
    const node = api.getDisplayedRowAtIndex(idx);
    const data = node?.data;
    if (!data || typeof data !== 'object') return null;

    const row: Record<string, string> = {};
    for (const [col, v] of Object.entries(data as Record<string, unknown>)) {
      if (IGNORED.includes(col)) continue;
      const text = stringifyCell(v);
      if (text) row[col] = text;
    }
    return Object.keys(row).length ? row : null;
  } catch (err) {
    log.error('ag-grid: readAgGridRowData() (tier 2) failed, falling through to DOM', err);
    return null;
  }
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
  let source: CellContext['source'] = 'dom';
  let runId: string | undefined;

  if (rowIndex) {
    const time = findRowCell(grid, rowIndex, PIVOT.TIME_COLUMNS);
    if (time) {
      t0Raw = cellText(time.cell);
      t0 = parseGridTime(t0Raw, isUtcColumn(grid, time.col));
    }
    const hostCell = findRowCell(grid, rowIndex, PIVOT.HOST_COLUMNS);
    if (hostCell) host = cellText(hostCell.cell);
    row = readRow(grid, rowIndex);

    // Tier 1 (#14): the last captured QueryRun, matched by trustworthy cells.
    const match = matchCapturedRow(row, getLastCapture('sentinel'));
    if (match) {
      row = match.row;
      source = 'capture';
      runId = match.runId;
    } else {
      // Tier 2 (#14): AG Grid's own (unvirtualized) row data.
      const gridRow = readAgGridRowData(grid, rowIndex);
      if (gridRow) {
        row = gridRow;
        source = 'grid';
      }
    }

    // Recompute T0/HOST from the fuller row once tier 1/2 supplied one - a
    // column off-screen in the DOM (virtualized) may now be present. `t0Raw`
    // (display text) is left as the DOM found it either way: it documents
    // what was ON SCREEN, which tier 1/2 does not change. Falls back to
    // whatever tier 3 already computed above if parsing the fuller value
    // fails - never downgrades a working DOM read to nothing.
    if (source !== 'dom') {
      const fullTimeCol = PIVOT.TIME_COLUMNS.find((c) => row[c]);
      if (fullTimeCol) {
        const parsed = parseGridTime(row[fullTimeCol], true);
        if (parsed) t0 = parsed;
      }
      const fullHostCol = PIVOT.HOST_COLUMNS.find((c) => row[c]);
      if (fullHostCol) host = row[fullHostCol];
    }

    log.debug('ag-grid: row read', { column, source, runId, rowFields: Object.keys(row).length });
  }

  return { value, column, t0, t0Raw, host, row, source, runId };
}

export function getOpenAgGridContextMenu(): HTMLElement | null {
  if (!document.querySelector(S.CONTEXT_MENU_OPEN)) return null;
  return document.querySelector<HTMLElement>(S.CONTEXT_MENU_LIST);
}

/** Pivot entry with AG Grid's own markup, to inherit the native rendering */
export function addAgGridMenuItem(list: HTMLElement, label: string, onSelect: () => void): void {
  const item = document.createElement('div');
  item.className = `ag-menu-option ${PIVOT.MENU_ITEM_CLASS}`;
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
  separator.className = `ag-menu-separator ${PIVOT.MENU_SEPARATOR_CLASS}`;
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
    onSelect();
  });

  list.prepend(item, separator);
}

/**
 * Escape on the list, then (if still open) a simulated outside mousedown.
 * Fragile by nature: check after each AG Grid update.
 */
export function closeAgGridContextMenu(list: HTMLElement): void {
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  requestAnimationFrame(() => {
    if (getOpenAgGridContextMenu()) {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  });
}