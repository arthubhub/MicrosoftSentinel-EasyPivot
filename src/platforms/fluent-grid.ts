import type { CellContext } from '../types.ts';
import { PIVOT, SELECTORS } from '../config.ts';
import { parseGridTime } from '../core/pivot.ts';
import { log } from '../core/log.ts';
import { getLastCapture } from '../capture/interceptor.ts';
import { matchCapturedRow } from '../capture/match-row.ts';

/**
 * Reading the Defender results grid (Fluent UI v8 DetailsList).
 *
 *   .ms-List
 *   └ [role=row].ms-DetailsRow                                   ← GRID_ROW
 *      ├ [role=gridcell].ms-DetailsRow-cellCheck                   (selection, ignored)
 *      └ [role=gridcell][data-automation-key=<Column>]             ← GRID_CELL
 *         └ span[context-data-property=<Column>]                   ← GRID_VALUE
 *              [context-data-value=<full value>]
 *              [context-data-schema={"name","type","entityName"}]
 *
 * context-data-value is the raw value (untruncated; ISO 8601 for DateTime),
 * so the displayed text is only a fallback. Every column of a rendered row
 * is in the DOM (rows are virtualized, columns are not).
 *
 * The cell menu (« Ajouter X == v », « Copier la valeur… ») is a Fluent UI
 * ContextualMenu rendered in a Callout layer at the end of <body>.
 */

const D = SELECTORS.DEFENDER;

function valueOf(el: Element): string {
  const raw = el.getAttribute('context-data-value');
  if (raw !== null) return raw.trim();
  return (el.textContent ?? '').trim();
}

/**
 * Defender's own declared entity type for this cell (`context-data-schema`,
 * e.g. `{"name":"RemoteIP","type":"IPAddress","entityName":"Ip"}`). Used by
 * `core/detection.ts` (#18). The attribute is JSON written by the page, so a
 * malformed or absent value must not break the rest of the cell read.
 */
function entityNameOf(el: Element): string | undefined {
  const raw = el.getAttribute('context-data-schema');
  if (!raw) return undefined;
  try {
    const schema = JSON.parse(raw) as { entityName?: unknown };
    return typeof schema.entityName === 'string' && schema.entityName ? schema.entityName : undefined;
  } catch {
    return undefined;
  }
}

/** Every cell of the row (column → value) */
function readRow(rowEl: Element): Record<string, string> {
  const row: Record<string, string> = {};
  for (const el of rowEl.querySelectorAll(D.GRID_VALUE)) {
    const col = el.getAttribute('context-data-property') ?? '';
    if (!col || col in row) continue;
    const text = valueOf(el);
    if (text) row[col] = text;
  }
  return row;
}

/** Time as displayed (« 14 oct. 2026 23:53:38 »), for the panel */
function displayedTime(rowEl: Element, col: string): string {
  const el = rowEl.querySelector(`${D.GRID_VALUE}[context-data-property="${CSS.escape(col)}"]`);
  const shown = el?.querySelector('.scc-dateTime');
  return (shown?.getAttribute('title') ?? shown?.textContent ?? '').trim();
}

export function readFluentCellContext(target: Element): CellContext | null {
  const cell = target.closest(D.GRID_CELL);
  if (!cell) return null;
  const valueEl = cell.querySelector(D.GRID_VALUE);
  if (!valueEl) return null;

  const column = valueEl.getAttribute('context-data-property') ?? '';
  if (!column) return null;
  const value = valueOf(valueEl);

  const rowEl = cell.closest(D.GRID_ROW);
  let row: Record<string, string> = rowEl ? readRow(rowEl) : {};
  let source: CellContext['source'] = 'dom';
  let runId: string | undefined;

  // Tier 1 (#14): the last captured QueryRun, matched by trustworthy cells.
  // No tier 2 here: Defender's grid renders every column of a visible row
  // (only ROWS are virtualized, not columns - see file header above), so
  // there is no "off-screen column" problem for a grid-API tier to solve on
  // this platform; a failed tier 1 falls straight through to tier 3 (DOM).
  const match = matchCapturedRow(row, getLastCapture('defender'));
  if (match) {
    row = match.row;
    source = 'capture';
    runId = match.runId;
  }

  let t0 = '';
  let t0Raw = '';
  const timeCol = PIVOT.TIME_COLUMNS.find((c) => row[c]);
  if (timeCol && rowEl) {
    // The raw value carries its zone (…Z): the utc flag only covers values without one
    t0 = parseGridTime(row[timeCol], true);
    // Display text comes from the DOM regardless of which tier supplied
    // `row`: it documents what was ON SCREEN, and tier 1 does not change
    // that. Absent from the DOM (a column tier 1 added that is not even a
    // displayed grid column) -> falls back to the raw value itself.
    t0Raw = displayedTime(rowEl, timeCol) || row[timeCol];
  }

  const hostCol = PIVOT.HOST_COLUMNS.find((c) => row[c]);
  const host = hostCol ? row[hostCol] : '';

  const entityName = entityNameOf(valueEl);

  log.debug('fluent-grid: row read', { column, source, runId, rowFields: Object.keys(row).length });

  return { value, column, t0, t0Raw, host, row, entityName, source, runId };
}

/** The most recently opened cell menu */
export function getOpenFluentContextMenu(): HTMLElement | null {
  const lists = document.querySelectorAll<HTMLElement>(D.CONTEXT_MENU_LIST);
  return lists.length ? lists[lists.length - 1] : null;
}

/** Generated class names of a native element, minus state classes */
function nativeClasses(el: Element | null | undefined, fallback: string): string {
  if (!el) return fallback;
  return (
    el.className
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('is-') && !/Disabled|Checked|Expanded/.test(c))
      .join(' ') || fallback
  );
}

/** Pivot entry with the menu's own markup (classes copied from its first item) */
export function addFluentMenuItem(list: HTMLElement, label: string, onSelect: () => void): void {
  const refLi = list.querySelector(`li.ms-ContextualMenu-item:not(.${PIVOT.MENU_ITEM_CLASS})`);
  const refBtn = refLi?.querySelector('.ms-ContextualMenu-link');
  const refContent = refLi?.querySelector('.ms-ContextualMenu-linkContent');
  const refText = refLi?.querySelector('.ms-ContextualMenu-itemText');

  const li = document.createElement('li');
  li.setAttribute('role', 'presentation');
  li.className = `${nativeClasses(refLi, 'ms-ContextualMenu-item')} ${PIVOT.MENU_ITEM_CLASS}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = nativeClasses(refBtn, 'ms-ContextualMenu-link');
  btn.setAttribute('role', 'menuitem');
  btn.setAttribute('aria-disabled', 'false');
  btn.tabIndex = -1;

  const content = document.createElement('div');
  content.className = nativeClasses(refContent, 'ms-ContextualMenu-linkContent');

  const text = document.createElement('span');
  text.className = nativeClasses(refText, 'ms-ContextualMenu-itemText');
  text.textContent = label;

  content.appendChild(text);
  btn.appendChild(content);
  li.appendChild(btn);

  const separator = document.createElement('li');
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-hidden', 'true');
  separator.className = `ms-ContextualMenu-divider ${PIVOT.MENU_SEPARATOR_CLASS}`;

  // Native events only: stopping them here also keeps them from React (portal)
  btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onSelect();
  });

  list.prepend(li, separator);
}

/**
 * Escape on the menu (Fluent v8 reads keyCode, hence the forced value), then,
 * if still open, a click outside the Callout (its light-dismiss).
 */
export function closeFluentContextMenu(list: HTMLElement): void {
  const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(esc, 'keyCode', { get: () => 27 });
  Object.defineProperty(esc, 'which', { get: () => 27 });
  list.dispatchEvent(esc);
  requestAnimationFrame(() => {
    if (list.isConnected) {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
}