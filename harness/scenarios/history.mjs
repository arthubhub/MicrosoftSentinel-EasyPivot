// U1: a right-clicked event enters the case history when the Pivot panel opens, without running a rule.
//   npm run harness && node harness/drive.mjs harness/scenarios/history.mjs
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : ''));
  if (!cond) fails.push(name);
};

const URL_ = '/?capture=1&cellmenu=none&lang=en';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const CLOSE_PANEL = '.shq-pivot-header .shq-popup-close';

export default async ({ page }) => {
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
  const probe = () => page.eval('window.__epProbe()');
  const run = (scope = 'cursor') => page.eval(`window.__epRun(${JSON.stringify(scope)})`);
  const setEditor = (v) => page.eval(`(()=>{document.getElementById('fake-editor').value = ${JSON.stringify(v)}; return 1})()`);
  const panelOpen = () => page.exists('.shq-pivot');
  const closePanel = async () => { if (await panelOpen()) { await page.click(CLOSE_PANEL); await page.sleep(200); } };
  const snaps = async (key) => {
    const idx = await J('shq_cases');
    const id = idx?.activeByKey?.[key];
    return id ? ((await J('shq_case_' + id))?.snapshots ?? []) : [];
  };

  await page.goto(URL_); await wipe(); await page.goto(URL_);
  await setEditor('SigninLogs\n| take 100');
  await run('cursor'); await page.sleep(900);
  const KEY = (await probe()).lastKey;

  console.log('\n=== no case yet: nothing is created by opening the panel ===');
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(700);
  ok('1a panel open', await panelOpen());
  ok('1b no case created by the right-click', !(await J('shq_cases'))?.activeByKey?.[KEY]);

  console.log('\n=== create a case, then right-click another cell ===');
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(900);
  let s = await snaps(KEY);
  ok('1c creating the case files the event the panel was showing', s.length === 1 && s[0]?.column === 'RemoteIP', JSON.stringify(s.map((x) => x.column)));
  await closePanel();
  await page.rightClick(CELL(1, 'AccountUpn')); await page.sleep(900);
  s = await snaps(KEY);
  ok('2a snapshot recorded without running a rule', s.length === 2, String(s.length));
  ok('2b it is the right-clicked value, no step yet', s[0]?.column === 'AccountUpn' && (s[0]?.steps ?? []).length === 0,
    JSON.stringify({ col: s[0]?.column, steps: s[0]?.steps?.length }));
  const caseViewBtn = await page.exists('.shq-pivot-case-view-btn');
  ok('2c case bar still offers the case view', caseViewBtn);

  console.log('\n=== same cell again: no duplicate ===');
  await closePanel();
  await page.rightClick(CELL(1, 'AccountUpn')); await page.sleep(900);
  s = await snaps(KEY);
  ok('3a still two snapshots', s.length === 2, String(s.length));

  console.log('\n=== run a rule on it: the same snapshot gets the step ===');
  await page.click('.shq-pivot-rule-row'); await page.sleep(900);
  s = await snaps(KEY);
  ok('4a still two snapshots', s.length === 2, String(s.length));
  const acc = s.find((x) => x.column === 'AccountUpn');
  ok('4b one step on the AccountUpn snapshot', (acc?.steps ?? []).length === 1, String(acc?.steps?.length));

  console.log('\n=== another cell: second snapshot, visible in the case view ===');
  await page.rightClick(CELL(2, 'DeviceName')); await page.sleep(900);
  s = await snaps(KEY);
  ok('5a three snapshots', s.length === 3, String(s.length));
  await page.click('.shq-pivot-case-view-btn'); await page.sleep(400);
  const nodes = await page.eval(`document.querySelectorAll('.shq-case-view-node').length`);
  ok('5b case view lists 3 nodes', nodes === 3, String(nodes));

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL HISTORY CHECKS PASSED');
  if (fails.length) throw new Error('history scenario failed');
};
