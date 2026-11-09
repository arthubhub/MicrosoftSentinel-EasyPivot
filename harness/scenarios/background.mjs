// #27 / F5.2: background context queries - off by default, opt-in in Settings, replay of the page's own request
// with the rule's KQL, without touching the editor; result linked in the case; token never stored.
//   npm run harness && node harness/drive.mjs harness/scenarios/background.mjs
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const URL_ = '/?capture=1&cellmenu=none&lang=fr';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const CLOSE = '.shq-pivot-header .shq-popup-close';

export default async ({ page }) => {
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const body = async (key) => { const id = (await J('shq_cases'))?.activeByKey?.[key]; return id ? await J('shq_case_' + id) : null; };
  const editor = () => page.eval(`document.getElementById('fake-editor').value`);
  const run = () => page.eval(`window.__epRun('cursor')`);
  await page.goto(URL_); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`); await page.goto(URL_);
  await page.eval(`(()=>{document.getElementById('fake-editor').value='SigninLogs | take 3'; return 1})()`);
  await run(); await page.sleep(900);
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);
  ok('1 off by default: no ↻ button on rules', (await page.eval(`document.querySelectorAll('.shq-pivot-bg-btn').length`)) === 0);

  console.log('\n=== opt in from Settings ===');
  await page.click('.shq-pivot-settings-btn'); await page.sleep(300);
  await page.eval(`(()=>{const l=[...document.querySelectorAll('.shq-pivot-settings label')].find(x=>x.textContent.includes('arrière-plan')); l.querySelector('input').click(); return 1})()`); await page.sleep(300);
  ok('2a setting stored', (await J('shq_settings'))?.background?.enabled === true);
  await page.click('.shq-pivot-settings-btn'); await page.sleep(200);
  ok('2b ↻ buttons appear on rules', (await page.eval(`document.querySelectorAll('.shq-pivot-bg-btn').length`)) > 0);
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(900);
  await page.eval(`document.querySelector('.shq-pivot-bg-btn').click(); 1`); await page.sleep(600);
  ok('2c before any portal query with the option on: explains to run one first', ((await page.text('.shq-pivot-background')) ?? '').includes("Lancez d'abord une requête"), await page.text('.shq-pivot-background'));

  console.log('\n=== portal query (template), case, background run ===');
  await page.click(CLOSE); await page.sleep(200);
  await run(); await page.sleep(900);
  const KEY = (await page.eval('window.__epProbe()')).lastKey;
  const cacheBefore = (await page.eval('window.__epProbe()')).cacheRunId;
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);
  const ed0 = await editor();
  const calls0 = (await page.eval('window.__epProbe()')).fetchCalls;
  const ruleId = await page.eval(`(()=>{const row=document.querySelector('.shq-pivot-rule-row'); const id=row.querySelector('.shq-pivot-rule-meta').textContent.split(' · ')[0]; row.querySelector('.shq-pivot-bg-btn').click(); return id})()`);
  await page.sleep(1200);
  const txt = (await page.text('.shq-pivot-background')) ?? '';
  console.log(txt.replace(/\s+/g, ' ').slice(0, 200));
  ok('3a panel stays open and shows the background result', (await page.exists('.shq-pivot')) && /3 ligne/.test(txt));
  ok('3b editor untouched', (await editor()) === ed0);
  const last = await page.eval('window.__epLastReq');
  ok('3c exactly one request sent', (await page.eval('window.__epProbe()')).fetchCalls === calls0 + 1);
  ok('3d the request carries the rule KQL', JSON.parse(last.body).query.includes(`[${ruleId}]`), ruleId);
  ok('3e the page auth header was reused', last.headers.authorization === 'Bearer harness-fake-token-123');
  ok('3f UI time range dropped (no timespan in URL)', !/timespan=/.test(last.url), last.url);
  ok('3g grid row cache not replaced', (await page.eval('window.__epProbe()')).cacheRunId === cacheBefore);
  const b = await body(KEY);
  const snap = b?.snapshots?.[0];
  const linked = (b?.runs ?? []).find((r) => r.ruleId === ruleId && r.snapshotId === snap?.id);
  ok('3h result stored in the case, linked to the snapshot', !!linked, JSON.stringify((b?.runs ?? []).map((r) => [r.ruleId, r.snapshotId === snap?.id])));
  ok('3i step recorded on the snapshot', (snap?.steps ?? []).some((s) => s.ruleId === ruleId));
  ok('3j values of the result offered', (await page.eval(`document.querySelectorAll('.shq-pivot-background .shq-pivot-result-chip').length`)) > 0);

  console.log('\n=== secrets ===');
  const all = await page.eval(`Object.keys(localStorage).map(k=>localStorage.getItem(k)).join('\\n')`);
  ok('4 no token anywhere in storage', !all.includes('harness-fake-token') && !/bearer/i.test(all));

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL BACKGROUND CHECKS PASSED');
  if (fails.length) throw new Error('background scenario failed');
};
