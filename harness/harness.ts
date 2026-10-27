/**
 * Rendering harness — a fake portal page, so the panel can be LOOKED AT
 * without Tampermonkey, a tenant, or any network access.
 *
 * ── What this is for ──
 * Everything in phases 1-5 has been verified statically: npm run check, i18n
 * parity, and pure-function tests. None of the DOM has ever been rendered, and
 * the manual checklist is ~28 items long. This harness closes the cheapest part
 * of that gap: it catches a panel that throws on open, a section that renders
 * blank, a missing label, an `undefined` in the UI, a broken layout, a dead
 * button. Open `harness/index.html` in a browser and click.
 *
 * ── What it does NOT prove ──
 * The grid markup here is a hand-written imitation built from the selectors in
 * `src/config.ts`. It is NOT the real Sentinel AG Grid or Defender Fluent DOM.
 * So a pass here says "the panel renders and the code paths run"; it does NOT
 * say the real portal selectors still match, that Monaco behaves, that SPA
 * navigation works, or that capture sees a real request. Those still need a
 * real session. Treat a green harness as "nothing is grossly broken", not as
 * the manual checklist being done.
 *
 * ── Why a separate entry instead of loading dist/ ──
 * `detectPlatform()` keys off the hostname, so the shipped bundle will not
 * start on a `file://` page. Rather than add a dev-only override to production
 * code, this entry imports the same components directly and runs the same
 * start-up order as `main.ts`. Nothing under `src/` was changed for it.
 */

import { sentinelAdapter } from '../src/platforms/sentinel.ts';
import { defenderAdapter } from '../src/platforms/defender.ts';
import { initI18n } from '../src/i18n/index.ts';
import { initTheme } from '../src/styles/theme.ts';
import { injectStyles } from '../src/styles/index.ts';
import { initCatalog } from '../src/core/rules-catalog.ts';
import { createPivotTrigger } from '../src/ui/pivot-trigger.ts';
import { createButton } from '../src/ui/button.ts';
import { recordSnapshot } from '../src/core/investigation.ts';
import { addClient } from '../src/core/clients.ts';
import {
  addStepToSnapshot,
  appendLiveRunToCase,
  closeCase,
  createCase,
  pinRowToSnapshot,
  recordSnapshotInCase,
  setCaseNotes,
  setSnapshotNote,
} from '../src/core/cases.ts';
import { setSetting } from '../src/core/settings.ts';
import { installCapture, onCaptureResult } from '../src/capture/interceptor.ts';
import { sentinelProfile } from '../src/capture/profiles/sentinel.ts';
import { defenderProfile } from '../src/capture/profiles/defender.ts';
import { onQueryCaptured } from '../src/core/health.ts';
import { getLastResolvedTenantKey } from '../src/capture/store.ts';
import { getLastCapture } from '../src/capture/interceptor.ts';
import { UNKNOWN_KEY } from '../src/core/tenant.ts';
import type { CellContext, PlatformAdapter, PlatformId, QueryRun } from '../src/types.ts';

// ── GM_* storage, backed by localStorage so a reload keeps state ──

const PREFIX = 'ep-harness:';
(window as unknown as Record<string, unknown>).GM_getValue = (key: string, fallback: unknown) => {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? fallback : raw;
};
(window as unknown as Record<string, unknown>).GM_setValue = (key: string, value: unknown) => {
  localStorage.setItem(PREFIX + key, String(value));
};
(window as unknown as Record<string, unknown>).GM_deleteValue = (key: string) => {
  localStorage.removeItem(PREFIX + key);
};
// The catalogue download goes through GM_xmlhttpRequest; fail it so the script
// falls back to its bundled copy rather than hanging on a network it has not got.
(window as unknown as Record<string, unknown>).GM_xmlhttpRequest = (details: {
  onerror?: (r: unknown) => void;
}) => {
  details.onerror?.({ status: 0, statusText: 'harness: no network', responseText: '' });
};

// ── Live-chain mode (`?capture=1`): fake fetch + real capture patch ──
//
// Off by default so every existing scenario is untouched. When on, mirrors
// main.ts's start-up: `unsafeWindow` is the real window (so the interceptor
// patches THE fetch the page calls), a fake `fetch` answers the Sentinel query
// endpoint with a Gabarit-shaped body built from ROWS, then `installCapture()`
// wraps it exactly as it would wrap the portal's own. See scenarios/e2e-live.mjs.

const QS = new URLSearchParams(location.search);
const CAPTURE_MODE = QS.get('capture') === '1';

// Defined further down; hoisted so the fake fetch can use it.
function responseFromRows(rows: readonly Record<string, string>[]): unknown {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return {
    tables: [{
      name: 'PrimaryResult',
      columns: cols.map((name) => ({ name, type: name === 'TimeGenerated' ? 'datetime' : name === 'EventID' ? 'int' : 'string' })),
      rows: rows.map((r) => cols.map((c) => (c === 'EventID' ? Number(r[c]) : r[c]))),
    }],
    dataSources: [{ tables: ['SigninLogs'] }],
    statistics: { query: { queryHash: 'harness-fake-hash', executionTime: 0.01 } },
  };
}

const HARNESS_WS_PATH =
  '/v1/subscriptions/00000000-aaaa-bbbb-cccc-000000000001/resourceGroups/rg-harness/providers/Microsoft.OperationalInsights/workspaces/ws-harness/query';

if (CAPTURE_MODE) {
  const w = window as unknown as Record<string, unknown>;
  const QUERY_URL =
    /^https:\/\/api\.loganalytics\.io\/v1\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+\/query(\?|$)/i;
  w.__epFetchLog = [] as string[];
  w.__epFakeFetch = w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && QUERY_URL.test(url)) {
      (w.__epFetchLog as string[]).push(url);
      const rows = (w.__epRows as readonly Record<string, string>[] | undefined) ?? ROWS;
      return new Response(JSON.stringify(responseFromRows(rows)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return Promise.reject(new TypeError('harness: fetch blocked: ' + method + ' ' + url));
  };
  w.unsafeWindow = window; // the interceptor reads this global
  installCapture([sentinelProfile, defenderProfile]);
  // Same wiring as main.ts (N6 "after each captured query"), on the Sentinel adapter.
  onCaptureResult(() => onQueryCaptured(sentinelAdapter));
}

// ── A fake Monaco: enough of the surface that editor-bridge.ts is satisfied ──

function makeFakeMonaco(textarea: HTMLTextAreaElement): unknown {
  const editor = {
    getValue: () => textarea.value,
    setValue: (v: string) => { textarea.value = v; },
    getModel: () => ({
      getLineCount: () => textarea.value.split('\n').length,
      getLineContent: (n: number) => textarea.value.split('\n')[n - 1] ?? '',
      getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
      getValue: () => textarea.value,
      pushEditOperations: (_b: unknown, ops: { text: string }[]) => { textarea.value = ops[0].text; return null; },
    }),
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: () => undefined,
    revealPositionInCenter: () => undefined,
    focus: () => textarea.focus(),
    hasTextFocus: () => document.activeElement === textarea,
    getDomNode: () => textarea,
    onDidFocusEditorText: (fn: () => void) => {
      textarea.addEventListener('focus', fn);
      return { dispose: () => textarea.removeEventListener('focus', fn) };
    },
  };
  return { editor: { getEditors: () => [editor] } };
}

// ── Fake result grids, built from the selectors in src/config.ts ──

interface Row { readonly [column: string]: string }

const ROWS: readonly Row[] = [
  { TimeGenerated: '2026-10-26T09:14:00Z', AccountUpn: 'alice@contoso.com', RemoteIP: '203.0.113.17',
    DeviceName: 'DC01', SHA256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    EventID: '4624', ResultType: 'Success' },
  { TimeGenerated: '2026-10-26T09:15:30Z', AccountUpn: 'svc-sql', RemoteIP: '10.0.0.8',
    DeviceName: 'srv-prod-01.contoso.local', SHA256: 'd41d8cd98f00b204e9800998ecf8427e',
    EventID: '4625', ResultType: 'Failure' },
  { TimeGenerated: '2026-10-26T09:17:02Z', AccountUpn: 'CONTOSO\\bob', RemoteIP: '2001:db8::1',
    DeviceName: 'WKS-042', SHA256: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    EventID: '4648', ResultType: 'Success' },
];
const COLUMNS = Object.keys(ROWS[0]);

function appendSentinelRows(root: Element, rows: readonly Row[], cols: readonly string[]): void {
  rows.forEach((row, i) => {
    const tr = document.createElement('div');
    tr.setAttribute('role', 'row');
    tr.setAttribute('row-index', String(i));
    for (const col of cols) {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('col-id', col);
      cell.textContent = row[col];
      cell.title = row[col];
      tr.appendChild(cell);
    }
    root.appendChild(tr);
  });
}

/** Live-chain mode: swap the result rows in place (header and Run bar untouched, so the injected Pivot button survives). */
function renderSentinelResult(columns: readonly string[], rows: readonly Row[]): void {
  const root = document.querySelector('.logs-results-grid .ag-root');
  if (!root) return;
  root.replaceChildren();
  const header = document.createElement('div');
  header.setAttribute('role', 'row');
  for (const col of columns) {
    const h = document.createElement('div');
    h.setAttribute('role', 'columnheader');
    h.setAttribute('col-id', col);
    h.textContent = col;
    header.appendChild(h);
  }
  root.appendChild(header);
  appendSentinelRows(root, rows, columns);
}

function buildSentinelGrid(host: HTMLElement): void {
  host.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.id = 'DiscoverWrapper';
  const bar = document.createElement('div');
  bar.setAttribute('data-logs-query-controls-bar', '');
  const run = document.createElement('button');
  run.id = 'logs-main-run-button';
  run.textContent = 'Run (fake)';
  run.addEventListener('click', () => {
    if (CAPTURE_MODE) void runEditor('cursor');
    else note('Run button clicked (fake)');
  });
  bar.appendChild(run);

  const grid = document.createElement('div');
  grid.className = 'logs-results-grid';
  const root = document.createElement('div');
  root.className = 'ag-root';

  const header = document.createElement('div');
  header.setAttribute('role', 'row');
  for (const col of COLUMNS) {
    const h = document.createElement('div');
    h.setAttribute('role', 'columnheader');
    h.setAttribute('col-id', col);
    h.textContent = col;
    header.appendChild(h);
  }
  root.appendChild(header);

  appendSentinelRows(root, ROWS, COLUMNS);

  grid.appendChild(root);
  wrapper.append(bar, grid);
  host.appendChild(wrapper);
}

function buildDefenderGrid(host: HTMLElement): void {
  host.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'scc-commandBar';
  const anchor = document.createElement('span');
  anchor.id = 'Join_Queries_Bubble_Advanced_Hunting_Query_Editor';
  const run = document.createElement('button');
  run.id = 'huntingRunQueryButtonId';
  run.textContent = 'Run query (fake)';
  run.addEventListener('click', () => note('Run button clicked (fake)'));
  bar.append(anchor, run);

  const main = document.createElement('div');
  main.className = 'scc-sidePanelPage-mainContent';
  ROWS.forEach((row) => {
    const tr = document.createElement('div');
    tr.setAttribute('role', 'row');
    tr.className = 'ms-DetailsRow';
    for (const col of COLUMNS) {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('data-automation-key', col);
      const span = document.createElement('span');
      span.setAttribute('context-data-property', col);
      span.setAttribute('context-data-value', row[col]);
      // Defender declares an Entity for some columns (step-0 survey); mimic it
      // so 3a's entity tier is exercised, not just the locations tier.
      const entity = col === 'DeviceName' ? 'Machine' : col === 'RemoteIP' ? 'Ip'
        : col === 'SHA256' ? 'File' : null;
      span.setAttribute('context-data-schema', JSON.stringify({ name: col, type: 'String', entityName: entity }));
      span.textContent = row[col];
      cell.appendChild(span);
      tr.appendChild(cell);
    }
    main.appendChild(tr);
  });
  host.append(bar, main);
}

// ── Live-chain "Run": POST the editor text through the (patched) fetch, repaint the grid ──
//
// scope 'all'    = the whole editor text, byte for byte.
// scope 'cursor' = the blank-line-delimited block the cursor is in. The portal
//   runs the block under the cursor, and pivot-menu's append mode leaves the
//   cursor on the LAST line, so the fake treats "cursor" as "last block".
//   (This is an assumption about the portal, see the scenario's report.)

function lastBlock(text: string): string {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).filter((b) => b.trim() !== '');
  return blocks.length ? blocks[blocks.length - 1] : text;
}

async function runEditor(scope: 'all' | 'cursor', override?: string): Promise<{ status: number; rows: number; query: string }> {
  const editor = document.getElementById('fake-editor') as HTMLTextAreaElement;
  const query = override ?? (scope === 'all' ? editor.value : lastBlock(editor.value));
  const url = 'https://api.loganalytics.io' + HARNESS_WS_PATH + '?timespan=P1D';
  const res = await window.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, maxRows: 1001 }),
  });
  const body = (await res.json()) as { tables: { columns: { name: string }[]; rows: unknown[][] }[] };
  const primary = body.tables[0];
  const cols = primary.columns.map((c) => c.name);
  const rows = primary.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, String(r[i])])) as Record<string, string>);
  renderSentinelResult(cols, rows);
  note('fake run: ' + rows.length + ' row(s)');
  return { status: res.status, rows: rows.length, query };
}
if (CAPTURE_MODE) {
  (window as unknown as Record<string, unknown>).__epRun = runEditor;
  // Read-only probe of capture's session state (neither is persisted by the product).
  (window as unknown as Record<string, unknown>).__epProbe = () => ({
    lastKey: getLastResolvedTenantKey(),
    cacheRunId: getLastCapture('sentinel')?.runId ?? null,
    cacheRows: getLastCapture('sentinel')?.rows.length ?? 0,
    fetchIsPatched: window.fetch !== (window as unknown as Record<string, unknown>).__epFakeFetch,
    fetchCalls: ((window as unknown as Record<string, unknown>).__epFetchLog as string[]).length,
  });
}

// ── Harness chrome ──

function note(msg: string): void {
  const log = document.getElementById('harness-log');
  if (!log) return;
  const line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  log.prepend(line);
}

let mounted: { destroy(): void } | null = null;

// Harness-only: `?lang=fr|en` writes the real `lang` setting before start-up,
// so both dictionaries can be driven without touching production code.
const langParam = new URLSearchParams(location.search).get('lang');
if (langParam === 'fr' || langParam === 'en') setSetting('lang', langParam);

function mount(platformId: PlatformId): void {
  mounted?.destroy();
  const gridHost = document.getElementById('grid-host') as HTMLElement;
  const editor = document.getElementById('fake-editor') as HTMLTextAreaElement;

  if (platformId === 'sentinel') buildSentinelGrid(gridHost);
  else buildDefenderGrid(gridHost);

  if (!CAPTURE_MODE) (window as unknown as Record<string, unknown>).unsafeWindow = { monaco: makeFakeMonaco(editor) };
  (window as unknown as Record<string, unknown>).monaco = makeFakeMonaco(editor);

  const baseAdapter: PlatformAdapter = platformId === 'sentinel' ? sentinelAdapter : defenderAdapter;
  // Harness-only: `?cellmenu=none` makes a right-click open the panel directly (the fake grid has no native menu).
  const noNativeMenu: PlatformAdapter =
    new URLSearchParams(location.search).get('cellmenu') === 'none' ? { ...baseAdapter, cellMenu: 'none' } : baseAdapter;
  // Live-chain mode: expose the last cell context the adapter built (what the panel was opened with).
  const adapter: PlatformAdapter = CAPTURE_MODE
    ? {
        ...noNativeMenu,
        readCellContext: (target) => {
          const ctx = baseAdapter.readCellContext(target);
          (window as unknown as Record<string, unknown>).__epCtx = ctx;
          return ctx;
        },
      }
    : noNativeMenu;

  // Same order as main.ts's bootstrap (W1), minus the hostname detection.
  initI18n();
  initTheme();
  injectStyles();
  initCatalog();

  // Mirror main.ts's injectUI() exactly: the panel lives INSIDE the trigger,
  // and the button opens that same instance. Creating a menu separately here
  // would mount two panels - the right-click would drive one and the button
  // the other. The typechecker caught that; esbuild had bundled it happily,
  // which is the argument for typechecking this file rather than only building it.
  const trigger = createPivotTrigger(adapter);
  const menu = trigger.menu;

  const button = createButton(() => {
    if (menu.isVisible()) {
      menu.hide();
      return;
    }
    const rect = button.buttonEl.getBoundingClientRect();
    menu.showHistory(rect.left, rect.bottom + 4);
  }, platformId);

  const target = adapter.getButtonInjectionTarget();
  if (target) target.appendChild(button.element);
  else note('WARNING: getButtonInjectionTarget() returned null — the anchor selector did not match');

  mounted = {
    destroy() {
      trigger.destroy();
      button.element.remove();
    },
  };
  note('mounted on ' + platformId + ' — right-click a grid cell');
}

function seed(): void {
  addClient({ name: 'Contoso', defenderTids: ['11111111-2222-3333-4444-555555555555'],
    sentinelWorkspaces: ['/subscriptions/s/resourcegroups/rg/providers/microsoft.operationalinsights/workspaces/contoso'] } as never);
  for (const r of ROWS) {
    recordSnapshot({ value: r.RemoteIP, column: 'RemoteIP', t0: r.TimeGenerated, t0Raw: r.TimeGenerated,
      host: r.DeviceName, row: r, source: 'dom' } as never, '', 'sentinel');
  }
  note('seeded one client and ' + ROWS.length + ' snapshots — reload to see the migration offer');
}

// ── Case-view fixtures (N3, 5e-2) ──
// Written through the real core/cases.ts API so the view renders what the
// product would store. The harness has no tenant in its URL, so the active
// key is UNKNOWN_KEY.

function ctxOf(value: string, column: string, row: Readonly<Record<string, string>>, from?: string): CellContext {
  return { value, column, t0: row.TimeGenerated ?? '', t0Raw: row.TimeGenerated ?? '', host: row.DeviceName ?? '',
    row, source: from ? 'capture' : 'dom', ...(from ? { runId: from } : {}) };
}

function runFor(caseId: string, id: string, snapshotId: string, rows: number, status: QueryRun['status'], at: number): QueryRun {
  return { id, caseId, tenantKey: UNKNOWN_KEY, platform: 'sentinel', kqlHash: 'h-' + id, kqlPreview: '// fixture',
    snapshotId, startedAt: at, durationMs: 120, status, rowCount: rows, columns: [], sourceTables: [],
    summary: { topValues: {} } as never, lastAccessAt: at };
}

/** 3-level tree: A -> B -> C, plus a second root D without result. A has a note, B a pinned row. */
function seedCase(): void {
  const made = createCase({ name: 'Incident 42', tenantKeys: [UNKNOWN_KEY] });
  if (!made.ok) { note('seedCase: ' + made.reason); return; }
  const id = made.case.id;
  const now = Date.now();
  const a = recordSnapshotInCase(id, ctxOf(ROWS[0].RemoteIP, 'RemoteIP', ROWS[0]), '', 'sentinel');
  if (!a.ok) return;
  addStepToSnapshot(id, a.snapshot.id, { ruleId: 'IP-S1', value: ROWS[0].RemoteIP, indicator: 'ip' });
  appendLiveRunToCase(id, runFor(id, 'run-a', a.snapshot.id, 12, 'ok', now - 3000));
  // Distinct rows: the same row from the same source query is the SAME event (sameEvent) and would be deduped.
  const rowB = { ...ROWS[0], Step: 'B' };
  const rowC = { ...ROWS[1], Step: 'C' };
  const b = recordSnapshotInCase(id, ctxOf(ROWS[0].AccountUpn, 'AccountUpn', rowB, 'run-a'), '', 'sentinel');
  if (!b.ok) return;
  addStepToSnapshot(id, b.snapshot.id, { ruleId: 'AC-S1', value: ROWS[0].AccountUpn, indicator: 'account' });
  appendLiveRunToCase(id, runFor(id, 'run-b', b.snapshot.id, 1000, 'truncated', now - 2000));
  const c = recordSnapshotInCase(id, ctxOf(ROWS[1].DeviceName, 'DeviceName', rowC, 'run-b'), '', 'sentinel');
  if (!c.ok) return;
  appendLiveRunToCase(id, runFor(id, 'run-c', c.snapshot.id, 0, 'error', now - 1000));
  recordSnapshotInCase(id, ctxOf(ROWS[2].DeviceName, 'DeviceName', ROWS[2]), '', 'sentinel');
  setSnapshotNote(id, a.snapshot.id, 'Brute force source, confirmed by the SOC.');
  pinRowToSnapshot(id, b.snapshot.id, rowB);
  setCaseNotes(id, 'Global note: suspected credential stuffing.');
  note('seeded open case "Incident 42" (A -> B -> C, plus D) - reload');
}

/** A closed case, made active: textareas and pin must come up disabled. */
function seedClosedCase(): void {
  const made = createCase({ name: 'Old incident (closed)', tenantKeys: [UNKNOWN_KEY] });
  if (!made.ok) return;
  const id = made.case.id;
  const a = recordSnapshotInCase(id, ctxOf(ROWS[1].RemoteIP, 'RemoteIP', ROWS[1]), '', 'sentinel');
  if (!a.ok) return;
  setSnapshotNote(id, a.snapshot.id, 'Closed-case note');
  pinRowToSnapshot(id, a.snapshot.id, ROWS[1]);
  setCaseNotes(id, 'Closed-case global note');
  closeCase(id);
  note('seeded closed case (active) - reload');
}

/** Hostile strings in every field the case view renders: none may execute or be parsed as HTML. */
function seedHostileCase(): void {
  const IMG = '<img src=x onerror="window.__pwned=1">';
  const SCRIPT = '<script>window.__pwned=2</script>';
  const client = addClient({ name: '<b>' + IMG, defenderTids: ['99999999-2222-3333-4444-555555555555'] });
  const made = createCase({ name: IMG + ' case', tenantKeys: [UNKNOWN_KEY], ...(client.ok ? { clientId: client.client.id } : {}) });
  if (!made.ok) return;
  const id = made.case.id;
  const row = { TimeGenerated: '2026-10-26T09:14:00Z', Evil: IMG, Col: SCRIPT };
  const a = recordSnapshotInCase(id, ctxOf(IMG, IMG, row), '', 'sentinel');
  if (!a.ok) return;
  setSnapshotNote(id, a.snapshot.id, SCRIPT);
  pinRowToSnapshot(id, a.snapshot.id, row);
  setCaseNotes(id, SCRIPT + IMG);
  // Report (5f): hostile steps, a value with backticks and a pipe, a hostile KQL run.
  const TICKS = 'tick`one``two```three a|b';
  addStepToSnapshot(id, a.snapshot.id, { ruleId: '"><svg onload=window.__pwned=3>', value: TICKS, indicator: 'process' });
  addStepToSnapshot(id, a.snapshot.id, { ruleId: 'X-S1', value: '[click](javascript:alert(1))', indicator: 'url' });
  pinRowToSnapshot(id, a.snapshot.id, { ...row, Ticks: TICKS, Link: '[click](javascript:alert(1))' });
  appendLiveRunToCase(id, { ...runFor(id, 'run-h', a.snapshot.id, 3, 'ok', Date.now()), ruleId: 'X-S1',
    kqlPreview: `// ${IMG}\nT | where A == "${SCRIPT}" | where B == \`${TICKS}\`` });
  note('seeded hostile case - reload');
}

/** A realistic case for the report dialog: values of every shape, a tree, notes, KQL with literals. */
function seedReportCase(): void {
  const client = addClient({ name: 'Acme Health Group', defenderTids: ['7f1d3a44-92b0-4c6e-8d11-5a3c9e2f0b77'] });
  const made = createCase({ name: 'Acme Health Group - Nightfall', tenantKeys: [UNKNOWN_KEY], ...(client.ok ? { clientId: client.client.id } : {}) });
  if (!made.ok) return;
  const id = made.case.id;
  const now = Date.now();
  const rowA = { TimeGenerated: '2026-10-26T09:14:00Z', AccountUpn: 'margaret.oshea@acme-health.example.com', IPAddress: '192.0.2.188',
    DeviceName: 'ZEPHYR-WKS-0412', EventID: '4624', SHA256: ROWS[0].SHA256 };
  const a = recordSnapshotInCase(id, ctxOf('192.0.2.188', 'IPAddress', rowA), '', 'sentinel');
  if (!a.ok) return;
  addStepToSnapshot(id, a.snapshot.id, { ruleId: 'IP-S1', value: '192.0.2.188', indicator: 'ip' });
  appendLiveRunToCase(id, { ...runFor(id, 'rr-a', a.snapshot.id, 12, 'ok', now - 3000), ruleId: 'IP-S1',
    kqlPreview: '// [IP-S1] Activity of the IP\nlet Value = trim(@"\\s", @"192.0.2.188");\nSigninLogs\n| where DeviceName == "PRIVATE-SERVER-77" | take 10' });
  const b = recordSnapshotInCase(id, ctxOf(rowA.AccountUpn, 'AccountUpn', { ...rowA, Step: 'B' }, 'rr-a'), '', 'sentinel');
  if (!b.ok) return;
  addStepToSnapshot(id, b.snapshot.id, { ruleId: 'AC-S1', value: rowA.AccountUpn, indicator: 'account' });
  appendLiveRunToCase(id, { ...runFor(id, 'rr-b', b.snapshot.id, 1000, 'truncated', now - 2000), ruleId: 'AC-S1' });
  const c = recordSnapshotInCase(id, ctxOf('ZEPHYR-WKS-0412', 'DeviceName', { ...rowA, Step: 'C' }, 'rr-b'), '', 'sentinel');
  if (!c.ok) return;
  addStepToSnapshot(id, c.snapshot.id, { ruleId: 'DM-S1', value: 'ZEPHYR-WKS-0412', indicator: 'device' });
  setCaseNotes(id, 'Credential stuffing from 192.0.2.188 against margaret.oshea@acme-health.example.com, then lateral movement to ZEPHYR-WKS-0412. The CEO mailbox ceo.lindqvist@acme-health.example.com was touched from 198.51.100.77.');
  setSnapshotNote(id, a.snapshot.id, 'Source of the brute force. Also seen on BACKUP-NAS-9 (not a known value of the case).');
  pinRowToSnapshot(id, b.snapshot.id, { ...rowA, Step: 'B' });
  note('seeded report case "Acme Health Group - Nightfall" - reload');
}

function reset(): void {
  for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  note('storage cleared — reload');
}

document.getElementById('btn-sentinel')?.addEventListener('click', () => mount('sentinel'));
document.getElementById('btn-defender')?.addEventListener('click', () => mount('defender'));
document.getElementById('btn-seed')?.addEventListener('click', seed);
document.getElementById('btn-seed-case')?.addEventListener('click', seedCase);
document.getElementById('btn-seed-closed')?.addEventListener('click', seedClosedCase);
document.getElementById('btn-seed-hostile')?.addEventListener('click', seedHostileCase);
document.getElementById('btn-seed-report')?.addEventListener('click', seedReportCase);
document.getElementById('btn-reset')?.addEventListener('click', reset);
window.addEventListener('error', (e) => note('UNCAUGHT ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => note('UNHANDLED REJECTION: ' + String(e.reason)));

mount('sentinel');
