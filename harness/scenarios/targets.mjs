// U3: rules show "→ <type>" from the catalog's `targets`, and the "Pivot to" chips filter the list.
//   npm run harness && node harness/drive.mjs harness/scenarios/targets.mjs
// Needs a catalog with `targets` in rules/pivot-rules.json (npm run sync-rules once R3.1 is done).
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };

export default async ({ page }) => {
  const URL_ = '/?capture=1&cellmenu=none&lang=fr';
  const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
  const count = () => page.eval(`document.querySelectorAll('.shq-pivot-rule-row').length`);
  await page.goto(URL_); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`); await page.goto(URL_);
  await page.eval(`(()=>{document.getElementById('fake-editor').value='SigninLogs | take 3'; return 1})()`);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);

  const chips = await page.eval(`[...document.querySelectorAll('.shq-pivot-target')].map(b=>b.textContent)`);
  ok('1 target chips shown, "Tout" first, Machine among them', chips[0] === 'Tout' && chips.some((c) => c.includes('Machine')), JSON.stringify(chips));
  const all = await count();
  const arrows = await page.eval(`[...document.querySelectorAll('.shq-pivot-rule-meta')].filter(m=>m.textContent.includes('→')).length`);
  ok('2 some rule metas carry "→ <type>"', arrows > 0, String(arrows));

  await page.eval(`[...document.querySelectorAll('.shq-pivot-target')].find(b=>b.textContent.includes('Machine')).click(); 1`); await page.sleep(200);
  const onlyDevice = await count();
  const allDevice = await page.eval(`[...document.querySelectorAll('.shq-pivot-rule-meta')].every(m=>/→ .*Machine/.test(m.textContent))`);
  ok('3 "→ Machine" narrows the list to rules leading to a device', onlyDevice > 0 && onlyDevice < all && allDevice, `${onlyDevice}/${all}`);

  await page.eval(`(()=>{const i=document.querySelector('.shq-pivot-search'); i.value='zzzz-nothing'; i.dispatchEvent(new Event('input')); return 1})()`); await page.sleep(150);
  ok('4 search combines with the filter (no match -> 0 rows)', (await count()) === 0);
  await page.eval(`(()=>{const i=document.querySelector('.shq-pivot-search'); i.value='machine'; i.dispatchEvent(new Event('input')); return 1})()`); await page.sleep(150);
  ok('5 searching a target label finds rules', (await count()) > 0, String(await count()));

  await page.click('.shq-pivot-header .shq-popup-close'); await page.sleep(200);
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);
  ok('6 re-opening the panel resets the filter', (await count()) === all, `${await count()}/${all}`);

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL TARGETS CHECKS PASSED');
  if (fails.length) throw new Error('targets scenario failed');
};
