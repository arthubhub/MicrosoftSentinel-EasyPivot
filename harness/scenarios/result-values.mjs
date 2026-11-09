// U3 / A3.1: "Values of the last result" chips -> pick one -> child event of the pivot that produced the result.
//   npm run harness && node harness/drive.mjs harness/scenarios/result-values.mjs
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };

const URL_ = '/?capture=1&cellmenu=none&lang=en';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const CLOSE = '.shq-pivot-header .shq-popup-close';

export default async ({ page }) => {
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const body = async (key) => { const id = (await J('shq_cases'))?.activeByKey?.[key]; return id ? await J('shq_case_' + id) : null; };
  const groups = () => page.eval(`[...document.querySelectorAll('.shq-pivot-result-group')].map(g=>[g.querySelector('.shq-pivot-result-type').textContent, [...g.querySelectorAll('.shq-pivot-result-chip')].map(c=>c.textContent)])`);
  await page.goto(URL_); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`); await page.goto(URL_);
  await page.eval(`(()=>{document.getElementById('fake-editor').value='SigninLogs | take 3'; return 1})()`);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  const KEY = (await page.eval('window.__epProbe()')).lastKey;

  console.log('\n=== manual result: chips grouped by type, clicked value excluded ===');
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);
  const g1 = await groups();
  console.log(JSON.stringify(g1));
  const ipGroup = g1.find(([t]) => /IP/i.test(t));
  ok('1a an IP group exists', !!ipGroup);
  ok('1b the right-clicked value is not suggested', !(ipGroup?.[1] ?? []).some((c) => c.startsWith('203.0.113.17')));
  ok('1c a device group exists (DeviceName column)', g1.some(([t]) => /Device|Machine/i.test(t)));
  ok('1d no timestamp or hash column suggested as IP/device', !JSON.stringify(g1).includes('2026-10-26'));

  console.log('\n=== create a case, pivot, run: the result is linked to the snapshot ===');
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(900);
  await page.click('.shq-pivot-rule-row'); await page.sleep(900);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  const b1 = await body(KEY);
  const parent = b1?.snapshots?.[0];
  ok('2a pivot run stored and linked', (b1?.runs ?? []).some((r) => r.snapshotId === parent?.id));

  console.log('\n=== pick a value from that result: child snapshot ===');
  await page.click('.shq-btn'); await page.sleep(700);
  const g2 = await groups();
  ok('3a chips shown when opening from the button', g2.length > 0, JSON.stringify(g2.map(([t, c]) => `${t}:${c.length}`)));
  const before = (await body(KEY))?.snapshots?.length ?? 0;
  const picked = await page.eval(`(()=>{const c=document.querySelector('.shq-pivot-result-chip'); const v=c.textContent; c.click(); return v})()`);
  await page.sleep(900);
  const b2 = await body(KEY);
  const child = b2?.snapshots?.[0];
  const pickedValue = picked.split(' · ')[0];
  ok('3b value field takes the picked value', (await page.eval(`document.querySelector('.shq-pivot input[placeholder="Value to pivot on"]').value`)) === pickedValue, picked);
  ok('3c a new snapshot entered the history', (b2?.snapshots?.length ?? 0) === before + 1, `${before} -> ${b2?.snapshots?.length}`);
  ok('3d it is a child of the pivot that produced the result', !!child?.parentSnapshotId && child.parentSnapshotId === parent?.id, `${child?.parentSnapshotId} vs ${parent?.id}`);

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL RESULT-VALUES CHECKS PASSED');
  if (fails.length) throw new Error('result-values scenario failed');
};
