// End-to-end test of the LIVE chain (review task), headless Chromium, real src/ code:
//   npm run harness && node harness/drive.mjs harness/scenarios/e2e-live.mjs
//
// Chain: run -> capture (real fetch patch over a FAKE fetch) -> right-click -> cell context from the
// CAPTURED row -> create case -> pick rule (KQL in editor + snapshot in the active case + pendingRun)
// -> "run" the editor -> run stored in the case and linked by kqlHash -> right-click in THAT result ->
// child snapshot with parentSnapshotId/parentRunId -> case view tree -> reload.
//
// Keeps going after a FAIL; the first break is reported at the end. Screenshot: /tmp/e2e-case-view.png
// Harness limits (see harness/harness.ts "Live-chain mode"): fake fetch, fake Monaco, hand-written grid, and
// "Run" = the blank-line-delimited LAST block of the editor ('cursor') - an assumption about the portal.
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : ''));
  if (!cond) fails.push(name);
};
const info = (msg) => console.log('INFO ' + msg);

const URL_ = '/?capture=1&cellmenu=none&lang=en';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const RULE_ROW = '.shq-pivot-rule-row';
const CLOSE_PANEL = '.shq-pivot-header .shq-popup-close';

export default async ({ page }) => {
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
  const probe = () => page.eval('window.__epProbe()');
  const run = (scope = 'cursor', text) => page.eval(`window.__epRun(${JSON.stringify(scope)}, ${text === undefined ? 'undefined' : JSON.stringify(text)})`);
  const setEditor = (v) => page.eval(`(()=>{document.getElementById('fake-editor').value = ${JSON.stringify(v)}; return 1})()`);
  const editor = () => page.eval(`document.getElementById('fake-editor').value`);
  const toasts = () => page.eval(`[...document.querySelectorAll('.shq-toast')].map(t=>t.textContent)`);
  const ctx = () => page.eval('window.__epCtx');
  const panelOpen = () => page.exists('.shq-pivot');
  const nlog = () => page.logs().length;
  const logsSince = (n) => page.logs().slice(n);
  const caseOf = async (key) => {
    const idx = await J('shq_cases');
    const id = idx?.activeByKey?.[key];
    return { idx, id, body: id ? await J('shq_case_' + id) : null };
  };
  const closePanel = async () => { if (await panelOpen()) { await page.click(CLOSE_PANEL); await page.sleep(200); } };
  const tree = () => page.eval(`[...document.querySelectorAll('.shq-case-view-node')].map(n => ({
    depth: n.dataset.depth,
    col: n.querySelector('.shq-case-view-node-column')?.textContent ?? '',
    value: n.querySelector('.shq-case-view-node-value')?.textContent ?? '',
    rows: n.querySelector('.shq-case-view-rows')?.textContent ?? '' }))`);
  const openCaseView = async () => {
    await closePanel();
    await page.click('.shq-btn'); await page.sleep(500);
    await page.click('.shq-pivot-case-view-btn'); await page.sleep(400);
  };

  // ── Setup: clean origin, then the page with capture on ──
  await page.goto(URL_); await wipe(); await page.goto(URL_);
  const p0 = await probe();
  ok('0  setup: real fetch patch sits on top of the fake fetch (window.fetch !== fake)', p0.fetchIsPatched === true, JSON.stringify(p0));

  // ── 1. initial run ──
  console.log('\n=== 1. initial run ===');
  await setEditor('SigninLogs\n| where TimeGenerated > ago(1d)\n| take 100');
  let r = await run('cursor');
  await page.sleep(900);
  const p1 = await probe();
  ok('1a fake backend answered 200 with 3 rows', r.status === 200 && r.rows === 3, JSON.stringify(r));
  ok('1b capture holds the result (in-memory cache has the run id, 3 rows)', !!p1.cacheRunId && p1.cacheRows === 3, JSON.stringify(p1));
  ok('1c last resolved tenant key is a real sentinel: key, not unknown', /^sentinel:[0-9a-f]{16}$/.test(p1.lastKey ?? ''), String(p1.lastKey));
  const KEY = p1.lastKey;
  const bufIndex = await J('shq_runs_index');
  const buf1 = (await J('shq_runs_' + KEY)) ?? [];
  ok('1d a run exists (no case for the real key yet -> legacy buffer shq_runs_<key>)', buf1.length === 1 && (bufIndex ?? []).includes(KEY), `buffer=${buf1.length} caseId=${buf1[0]?.caseId}`);
  ok('1e the stored run id is the in-memory cache id', buf1[0]?.id === p1.cacheRunId, `${buf1[0]?.id} vs ${p1.cacheRunId}`);
  const idx0 = await J('shq_cases');
  info('cases right after page load (before any key was known): ' + JSON.stringify((idx0?.cases ?? []).map((c) => ({ name: c.name, keys: c.tenantKeys }))) + ' activeByKey=' + JSON.stringify(idx0?.activeByKey));

  // ── 2. right-click a result cell ──
  console.log('\n=== 2. right-click -> cell context ===');
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(700);
  ok('2a Pivot panel opened', await panelOpen());
  const c2 = await ctx();
  ok("2b cell context source === 'capture'", c2?.source === 'capture', JSON.stringify({ source: c2?.source, runId: c2?.runId }));
  ok('2c cell context runId === the run captured in step 1', !!c2?.runId && c2.runId === buf1[0]?.id, `${c2?.runId} vs ${buf1[0]?.id}`);
  ok('2d context row is the FULL captured row (7 columns)', Object.keys(c2?.row ?? {}).length === 7, String(Object.keys(c2?.row ?? {}).length));
  ok('2e panel value field = clicked value', (await page.eval(`document.querySelector('.shq-pivot input[placeholder="Value to pivot on"]')?.value`)) === '203.0.113.17');

  // ── 3. case bar: create a case through the UI ──
  console.log('\n=== 3. case bar ===');
  const barBefore = await page.text('.shq-pivot-case-bar');
  info('case bar before: ' + JSON.stringify(barBefore));
  const act0 = (await J('shq_cases'))?.activeByKey?.[KEY];
  ok('3a no active case yet for the real key', act0 === undefined, String(act0));
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(700);
  const cs3 = await caseOf(KEY);
  ok('3b a case became active for the real key', !!cs3.id, String(cs3.id));
  const entry3 = cs3.idx?.cases?.find((c) => c.id === cs3.id);
  ok('3c that case covers the real key', !!entry3 && entry3.tenantKeys.includes(KEY), JSON.stringify(entry3?.tenantKeys));
  ok('3d case bar shows it as active', /Active case/i.test((await page.text('.shq-pivot-case-bar')) ?? ''), await page.text('.shq-pivot-case-bar'));
  const CASE = cs3.id;

  // ── 4. pick a rule ──
  console.log('\n=== 4. pick a rule (inject + snapshot + pendingRun) ===');
  const edBefore = await editor();
  const l4 = nlog();
  await page.click(RULE_ROW); await page.sleep(900);
  const edAfter = await editor();
  const header = /^\/\/ \[([A-Za-z0-9_-]+)\]/m.exec(edAfter.slice(edBefore.length))?.[1];
  ok('4a KQL landed in the fake editor (appended below the initial query, with a // [RULE-ID] header)', edAfter.startsWith(edBefore) && !!header, 'ruleId=' + header);
  const cs4 = await caseOf(KEY);
  const snaps4 = cs4.body?.snapshots ?? [];
  ok('4b exactly 1 snapshot in the ACTIVE CASE body', snaps4.length === 1, String(snaps4.length));
  const SNAP_A = snaps4[0];
  ok('4c snapshot.caseId = active case, no parent (root), 1 step with the rule id', SNAP_A?.caseId === CASE && !SNAP_A?.parentSnapshotId && SNAP_A?.steps?.length === 1 && SNAP_A.steps[0].ruleId === header,
    JSON.stringify({ caseId: SNAP_A?.caseId === CASE, parent: SNAP_A?.parentSnapshotId, steps: SNAP_A?.steps?.map((s) => s.ruleId) }));
  const legacy = await J('shq_pivot_snapshots');
  ok('4d NOT written to legacy shq_pivot_snapshots', legacy === null || (Array.isArray(legacy) && legacy.length === 0), JSON.stringify(legacy)?.slice(0, 80));
  ok('4e pendingRun registered (store logged it)', logsSince(l4).some((l) => l.includes('capture/store: pendingRun registered')));
  ok('4f panel closed after the pivot', !(await panelOpen()));
  info('toasts: ' + JSON.stringify(await toasts()));

  // ── 5. run the editor ──
  console.log('\n=== 5. run the injected query ===');
  const l5 = nlog();
  r = await run('cursor'); await page.sleep(900);
  const cs5 = await caseOf(KEY);
  const runs5 = cs5.body?.runs ?? [];
  const RUN_A = runs5.find((x) => x.snapshotId === SNAP_A?.id);
  ok('5a a NEW run is stored in the case body, linked to the step-4 snapshot', !!RUN_A, `runs in case=${runs5.length}`);
  ok('5b run.caseId = the real case id (not "unassigned")', RUN_A?.caseId === CASE, String(RUN_A?.caseId));
  ok('5c run.ruleId = the rule picked', RUN_A?.ruleId === header, String(RUN_A?.ruleId));
  ok('5d run.tenantKey = real key, rowCount 3, status ok', RUN_A?.tenantKey === KEY && RUN_A?.rowCount === 3 && RUN_A?.status === 'ok', JSON.stringify({ k: RUN_A?.tenantKey === KEY, rows: RUN_A?.rowCount, st: RUN_A?.status }));
  const snapA5 = (cs5.body?.snapshots ?? []).find((s) => s.id === SNAP_A?.id);
  ok("5e snapshot.runIds contains the run", !!RUN_A && (snapA5?.runIds ?? []).includes(RUN_A.id), JSON.stringify(snapA5?.runIds));
  ok('5f log: QueryRun linked to pending pivot', logsSince(l5).some((l) => l.includes('QueryRun linked to pending pivot')));
  const buf5 = (await J('shq_runs_' + KEY)) ?? [];
  ok('5g legacy buffer NOT fed again while a case is active (still only the step-1 run)', buf5.length === 1, String(buf5.length));
  ok('5h kqlHash of the run is 64 hex (full SHA-256)', /^[0-9a-f]{64}$/.test(RUN_A?.kqlHash ?? ''));

  // ── 6. right-click in the NEW result, pick a rule: child snapshot ──
  console.log('\n=== 6. right-click in the linked result -> child ===');
  const p6 = await probe();
  ok('6a capture cache now holds the step-5 run', p6.cacheRunId === RUN_A?.id, `${p6.cacheRunId} vs ${RUN_A?.id}`);
  await page.rightClick(CELL(0, 'AccountUpn')); await page.sleep(700);
  const c6 = await ctx();
  ok("6b cell context source 'capture', runId = step-5 run", c6?.source === 'capture' && c6?.runId === RUN_A?.id, JSON.stringify({ source: c6?.source, runId: c6?.runId }));
  await page.click(RULE_ROW); await page.sleep(900);
  const cs6 = await caseOf(KEY);
  const snaps6 = cs6.body?.snapshots ?? [];
  const SNAP_B = snaps6.find((s) => s.id !== SNAP_A?.id);
  ok('6c case has 2 snapshots', snaps6.length === 2, String(snaps6.length));
  ok('6d new snapshot.parentSnapshotId = step-4 snapshot', SNAP_B?.parentSnapshotId === SNAP_A?.id, String(SNAP_B?.parentSnapshotId));
  ok('6e new snapshot.parentRunId = step-5 run', SNAP_B?.parentRunId === RUN_A?.id, String(SNAP_B?.parentRunId));
  const headerB = /^\/\/ \[([A-Za-z0-9_-]+)\]/m.exec((await editor()).split('\n\n').pop())?.[1];
  info('child rule id = ' + headerB);
  // run the child's query so it gets a result too
  r = await run('cursor'); await page.sleep(900);
  const cs6b = await caseOf(KEY);
  const RUN_B = (cs6b.body?.runs ?? []).find((x) => x.snapshotId === SNAP_B?.id);
  ok('6f running the child query links its run to the child snapshot', !!RUN_B && RUN_B.ruleId === headerB && (cs6b.body.snapshots.find((s) => s.id === SNAP_B?.id)?.runIds ?? []).includes(RUN_B.id),
    JSON.stringify({ ruleId: RUN_B?.ruleId, snap: RUN_B?.snapshotId === SNAP_B?.id }));

  // ── 7. case view ──
  console.log('\n=== 7. case view tree ===');
  await openCaseView();
  ok('7a case view open', await page.exists('.shq-case-view'));
  let t7 = await tree();
  info('tree: ' + JSON.stringify(t7));
  ok('7b 2 nodes: parent at depth 0, child at depth 1 directly after it', t7.length === 2 && t7[0].depth === '0' && t7[1].depth === '1', JSON.stringify(t7.map((n) => n.depth)));
  ok('7c parent = RemoteIP node, child = AccountUpn node', t7[0]?.col === 'RemoteIP' && t7[1]?.col === 'AccountUpn', JSON.stringify(t7.map((n) => n.col)));
  ok('7d both nodes carry a row-count badge (3 rows)', t7.length === 2 && t7.every((n) => /3/.test(n.rows)), JSON.stringify(t7.map((n) => n.rows)));
  await page.shot('/tmp/e2e-case-view-mid.png');

  // ── 8. negative controls ──
  console.log('\n=== 8. negative controls ===');
  await closePanel();
  const snapsBefore8 = (await caseOf(KEY)).body.snapshots.length;
  const runsBefore8 = (await caseOf(KEY)).body.runs.length;
  await setEditor('SecurityEvent\n| take 3'); // never injected by EasyPivot
  const l8 = nlog();
  await run('cursor'); await page.sleep(900);
  const cs8 = await caseOf(KEY);
  const RUN_M = cs8.body.runs[0]; // newest first
  ok('8a manual run IS stored in the case (capture works)', cs8.body.runs.length === runsBefore8 + 1 && RUN_M?.kqlPreview?.startsWith('SecurityEvent'), `runs ${runsBefore8}->${cs8.body.runs.length}`);
  ok('8b ...but NOT linked: no snapshotId, no ruleId', RUN_M?.snapshotId === undefined && RUN_M?.ruleId === undefined, JSON.stringify({ s: RUN_M?.snapshotId, r: RUN_M?.ruleId }));
  ok('8c no snapshot gained a runId from it', cs8.body.snapshots.every((s) => !(s.runIds ?? []).includes(RUN_M?.id)));
  ok('8d snapshot count unchanged', cs8.body.snapshots.length === snapsBefore8);
  ok('8e no "linked to pending pivot" log for the manual run', !logsSince(l8).some((l) => l.includes('linked to pending pivot')));
  await page.rightClick(CELL(1, 'DeviceName')); await page.sleep(700);
  const c8 = await ctx();
  ok("8f right-click in the unlinked result: source 'capture', runId = the manual run", c8?.source === 'capture' && c8?.runId === RUN_M?.id, JSON.stringify({ s: c8?.source, r: c8?.runId === RUN_M?.id }));
  await page.click(RULE_ROW); await page.sleep(900);
  const cs8b = await caseOf(KEY);
  const SNAP_C = cs8b.body.snapshots.find((s) => ![SNAP_A?.id, SNAP_B?.id].includes(s.id));
  ok('8g a third snapshot exists and is a ROOT (no parentSnapshotId / parentRunId)', cs8b.body.snapshots.length === 3 && !!SNAP_C && SNAP_C.parentSnapshotId === undefined && SNAP_C.parentRunId === undefined,
    JSON.stringify({ n: cs8b.body.snapshots.length, p: SNAP_C?.parentSnapshotId, r: SNAP_C?.parentRunId }));

  // ── 9. reload ──
  console.log('\n=== 9. reload ===');
  await page.goto(URL_);
  const p9a = await probe();
  ok('9a after reload capture state is empty (session-only): no key, no cache', p9a.lastKey === null && p9a.cacheRunId === null, JSON.stringify(p9a));
  const stored9 = await caseOf(KEY);
  ok('9b storage still holds the case body (3 snapshots, 3 runs: the step-1 run is in the legacy buffer, not in the case)', stored9.body?.snapshots?.length === 3 && stored9.body?.runs?.length === 3, `${stored9.body?.snapshots?.length}/${stored9.body?.runs?.length}`);
  // 9c: before any query runs on the new page load the key is unknown, nothing is created, and the bar says so
  // (it must NOT say "Non attribué" was created: opening a page and doing nothing creates no case).
  const casesBefore9 = ((await J('shq_cases'))?.cases ?? []).length;
  await page.click('.shq-btn'); await page.sleep(700);
  const bar9pre = (await page.text('.shq-pivot-case-bar')) ?? '';
  info('case bar after reload, BEFORE any query ran: ' + JSON.stringify(bar9pre));
  const idx9pre = await J('shq_cases');
  ok('9c1 reload + panel open + no query: NO case was created (still ' + casesBefore9 + ')', (idx9pre?.cases ?? []).length === casesBefore9 && !(idx9pre?.cases ?? []).some((c) => c.tenantKeys.includes('unknown')) && idx9pre?.activeByKey?.unknown === undefined,
    JSON.stringify({ n: (idx9pre?.cases ?? []).length, unknownActive: idx9pre?.activeByKey?.unknown }));
  ok('9c2 bar wording: "cannot read this tenant" (key unknown), not the real-key wording', /Cannot read this tenant/.test(bar9pre) && !/No case for this tenant yet/.test(bar9pre), bar9pre);
  ok('9c3 no case view button (no active case)', !(await page.exists('.shq-pivot-case-view-btn')));
  // 9d: the analyst re-runs something WITH THE PANEL STILL OPEN; the key becomes known and the bar follows WITHOUT a reload
  await setEditor('SigninLogs | take 1');
  await run('cursor'); await page.sleep(900);
  const p9 = await probe();
  ok('9d after one run the resolved key is the same real key as before the reload', p9.lastKey === KEY, String(p9.lastKey) + ' vs ' + KEY);
  const bar9post = (await page.text('.shq-pivot-case-bar')) ?? '';
  ok('9d2 bar re-resolved by itself (no reload, panel never closed): real key -> the real case is active', /Active case/.test(bar9post) && !/Cannot read this tenant/.test(bar9post), bar9post);
  ok('9d3 the re-resolution created no case either', ((await J('shq_cases'))?.cases ?? []).length === casesBefore9);
  await closePanel();
  await openCaseView();
  const t9 = await tree();
  info('tree after reload + one run: ' + JSON.stringify(t9));
  ok('9e tree is back: 3 nodes, parent depth 0 -> child depth 1, second root depth 0', t9.length === 3 && t9[0].depth === '0' && t9[1].depth === '1' && t9[2].depth === '0', JSON.stringify(t9.map((n) => n.depth)));
  ok('9f badges still there on the parent and the child', /3/.test(t9[0]?.rows ?? '') && /3/.test(t9[1]?.rows ?? ''), JSON.stringify(t9.map((n) => n.rows)));
  await page.shot('/tmp/e2e-case-view.png');
  info('screenshot: /tmp/e2e-case-view.png');

  // ── 10. extra: what if the portal sends the WHOLE editor text instead of the block at the cursor? ──
  console.log('\n=== 10. (extra) run scope "all": whole editor text instead of the cursor block ===');
  await closePanel();
  await setEditor('SigninLogs\n| take 10');
  await page.rightClick(CELL(2, 'RemoteIP')); await page.sleep(700);
  const l10 = nlog();
  await page.click(RULE_ROW); await page.sleep(900);
  const ed10 = await editor();
  info('editor now has ' + ed10.split('\n\n').length + ' blocks');
  const before10 = (await caseOf(KEY)).body;
  const SNAP_D = before10.snapshots[0];
  await run('all'); await page.sleep(900);
  const after10 = (await caseOf(KEY)).body;
  const RUN_D = after10.runs[0];
  ok('10a CHARACTERISATION: a whole-editor-text run is NOT linked (hash over the whole text != hash of the injected block); only valid if the portal runs the cursor block', RUN_D?.snapshotId === undefined && RUN_D?.ruleId === undefined,
    `snapshotId=${RUN_D?.snapshotId} ruleId=${RUN_D?.ruleId}`);
  info('log: ' + JSON.stringify(logsSince(l10).filter((l) => /pendingRun|linked/.test(l))));

  // ── 11. (extra) panel opened from the Pivot button BEFORE any query ran on this page load ──
  console.log('\n=== 11. (extra) button-opened pivot before any capture (key still unknown) ===');
  await closePanel();
  await page.goto(URL_);
  const casesBefore11 = ((await J('shq_cases'))?.cases ?? []).length;
  await page.click('.shq-btn'); await page.sleep(700);
  info('case bar: ' + JSON.stringify(await page.text('.shq-pivot-case-bar')));
  ok('11-pre opening the panel under the unknown key created no case', ((await J('shq_cases'))?.cases ?? []).length === casesBefore11);
  await page.eval(`(()=>{const i=document.querySelector('.shq-pivot input[placeholder="Value to pivot on"]'); i.value='198.51.100.9'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await page.sleep(300);
  await setEditor('SigninLogs | take 5');
  await page.click(RULE_ROW); await page.sleep(900);
  const idx11 = await J('shq_cases');
  const unassigned11 = (idx11?.cases ?? []).filter((c) => c.system === 'unassigned');
  ok('11-lazy the first pivot under the unknown key created exactly ONE "unassigned" system case, covering only unknown',
    unassigned11.length === 1 && (idx11?.cases ?? []).length === casesBefore11 + 1 && JSON.stringify(unassigned11[0]?.tenantKeys) === '["unknown"]' && unassigned11[0]?.name === 'Non attribué',
    JSON.stringify(unassigned11.map((c) => ({ name: c.name, keys: c.tenantKeys, system: c.system }))));
  const unkId = idx11?.activeByKey?.unknown;
  ok('11-lazy2 that case is the active one for unknown', unkId === unassigned11[0]?.id, String(unkId));
  const unkBody = unkId ? await J('shq_case_' + unkId) : null;
  ok('11-lazy3 the pivot snapshot sits in it', (unkBody?.snapshots ?? []).length === 1, String(unkBody?.snapshots?.length));
  const l11 = nlog();
  await run('cursor'); await page.sleep(900);
  const p11 = await probe();
  ok('11-key the key resolved to the real one after the run', /^sentinel:[0-9a-f]{16}$/.test(p11.lastKey ?? '') && p11.lastKey === KEY, String(p11.lastKey));
  const unkBody2 = unkId ? await J('shq_case_' + unkId) : null;
  const realBody2 = (await caseOf(KEY)).body;
  const newest11 = realBody2?.runs?.[0];
  info(`after the run: unknown-case runs=${unkBody2?.runs?.length ?? 0}, unknown-case snapshot.runIds=${JSON.stringify(unkBody2?.snapshots?.[0]?.runIds)}, real-case runs=${realBody2?.runs?.length}`);
  // 11a (was a CHARACTERISATION of the bug): a pivot started under the unknown key and run after the key
  // resolved is stored in the REAL-key case, UNLINKED - never with a snapshotId from another case.
  ok('11a run stored in the real-key case with NO snapshotId and NO ruleId (the snapshot is in another case)',
    !!newest11 && newest11.caseId === CASE && newest11.snapshotId === undefined && newest11.ruleId === undefined,
    JSON.stringify({ caseIsReal: newest11?.caseId === CASE, snapshotId: newest11?.snapshotId, ruleId: newest11?.ruleId }));
  ok('11b the snapshot\'s own case is untouched: no run, no runIds', (unkBody2?.runs ?? []).length === 0 && (unkBody2?.snapshots?.[0]?.runIds ?? []).length === 0 && (unkBody2?.snapshots ?? []).length === 1,
    JSON.stringify({ runs: unkBody2?.runs?.length, runIds: unkBody2?.snapshots?.[0]?.runIds }));
  ok('11c invariant over EVERY case body: each run.snapshotId points to a snapshot of the SAME case', await (async () => {
    const idx = await J('shq_cases');
    for (const c of idx?.cases ?? []) {
      const body = await J('shq_case_' + c.id);
      const ids = new Set((body?.snapshots ?? []).map((x) => x.id));
      for (const r of body?.runs ?? []) if (r.snapshotId !== undefined && !ids.has(r.snapshotId)) return false;
      for (const sn of body?.snapshots ?? []) for (const rid of sn.runIds ?? []) if (!(body?.runs ?? []).some((r) => r.id === rid)) return false;
    }
    return true;
  })());
  ok('11d the drop was logged at info (counts only, no snapshot id)', logsSince(l11).some((l) => /run stored unlinked/.test(l)) && !logsSince(l11).some((l) => /run stored unlinked/.test(l) && l.includes(String(unkBody2?.snapshots?.[0]?.id))));

  // ── Wrap-up: stray warnings/errors, final storage census ──
  console.log('\n=== wrap-up ===');
  const warn = page.logs().filter((l) => /^\[(warning|warn|error)\]/.test(l));
  info('warn/error console lines: ' + (warn.length ? '\n  ' + warn.join('\n  ') : 'none'));
  const finalBuf = (await J('shq_runs_' + KEY)) ?? [];
  info(`legacy buffer shq_runs_<key> holds ${finalBuf.length} run(s) (the step-1 run, captured before a case existed)`);
  const idxF = await J('shq_cases');
  info('final cases: ' + JSON.stringify((idxF?.cases ?? []).map((c) => ({ name: c.name, keys: c.tenantKeys.map((k) => k.slice(0, 14)) }))) + ' activeByKey keys=' + JSON.stringify(Object.keys(idxF?.activeByKey ?? {}).map((k) => k.slice(0, 14))));
  info('first FAIL: ' + (fails[0] ?? 'none'));
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(' | ')}` : '\nALL E2E CHECKS PASSED');
  if (fails.length) throw new Error(`${fails.length} scenario check(s) failed`);
};
