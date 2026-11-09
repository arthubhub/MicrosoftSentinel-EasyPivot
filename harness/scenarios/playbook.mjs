// N4 / #32 / B4.1: start a playbook, run its steps, carry a value from a step's result, survive a reload.
//   npm run harness && node harness/drive.mjs harness/scenarios/playbook.mjs
// Needs a catalog with `scenarios` (S1: IP-P6 -> IP-P2 carry account -> AC-S1 -> ...).
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const URL_ = '/?capture=1&cellmenu=none&lang=fr';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const BAR = '.shq-pivot-playbook';

export default async ({ page }) => {
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const pb = async (key) => { const id = (await J('shq_cases'))?.activeByKey?.[key]; return id ? (await J('shq_case_' + id))?.playbook : undefined; };
  const barText = async () => ((await page.text(BAR)) ?? '').replace(/\s+/g, ' ');
  const editor = () => page.eval(`document.getElementById('fake-editor').value`);
  await page.goto(URL_); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`); await page.goto(URL_);
  await page.eval(`(()=>{document.getElementById('fake-editor').value='SigninLogs | take 3'; return 1})()`);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  const KEY = (await page.eval('window.__epProbe()')).lastKey;
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);

  ok('1a no playbook offered without a case', await page.eval(`document.querySelector('${BAR}').hidden`));
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(900);
  ok('1b "Start a playbook" offered for an IP (S1 among the choices)', !(await page.eval(`document.querySelector('${BAR}').hidden`)) && (await page.eval(`[...document.querySelectorAll('${BAR} select option')].some(o=>o.value==='S1')`)), await barText());

  await page.eval(`(()=>{const s=document.querySelector('${BAR} select'); s.value='S1'; return 1})()`);
  await page.eval(`[...document.querySelectorAll('${BAR} button')].find(b=>b.textContent==='Démarrer').click(); 1`); await page.sleep(400);
  let state = await pb(KEY);
  ok('2a started, stored in the case at step 0', state?.id === 'S1' && state.step === 0, JSON.stringify(state));
  ok('2b bar shows "Étape 1/5" and the first rule', (await barText()).includes('Étape 1/5') && (await barText()).includes('IP-P6'), await barText());

  const ed0 = (await editor()).length;
  await page.eval(`[...document.querySelectorAll('${BAR} button')].find(b=>b.textContent==="Lancer l'étape").click(); 1`); await page.sleep(900);
  state = await pb(KEY);
  ok('3a running the step injected IP-P6', (await editor()).slice(ed0).includes('[IP-P6]'));
  ok('3b playbook moved to step 1, IP-P6 done', state?.step === 1 && state.done.includes('IP-P6'), JSON.stringify(state));

  console.log('\n=== step 2 (IP-P2, carry account) from the rule list ===');
  await page.click('.shq-btn'); await page.sleep(700);
  ok('4a bar shows "Étape 2/5"', (await barText()).includes('Étape 2/5'), await barText());
  await page.eval(`[...document.querySelectorAll('.shq-pivot-rule-row')].find(r=>r.textContent.includes('IP-P2')).click(); 1`); await page.sleep(900);
  state = await pb(KEY);
  ok('4b running the step rule from the list also advances', state?.step === 2 && state.done.includes('IP-P2'), JSON.stringify(state));
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900); // the IP-P2 result (fake rows with AccountUpn)

  console.log('\n=== step 3: carried account values ===');
  await page.click('.shq-btn'); await page.sleep(700);
  const t3 = await barText();
  ok('5a bar shows "Étape 3/5" with values to carry', t3.includes('Étape 3/5') && t3.includes("Valeur pour l'étape"), t3);
  const chips = await page.eval(`[...document.querySelectorAll('${BAR} .shq-pivot-result-chip')].map(c=>c.textContent)`);
  ok('5b carried values are accounts from the IP-P2 result', chips.some((c) => c.startsWith('alice@contoso.com')), JSON.stringify(chips));
  await page.eval(`document.querySelector('${BAR} .shq-pivot-result-chip').click(); 1`); await page.sleep(600);
  ok('5c picking one fills the value and selects Compte', (await page.eval(`document.querySelector('.shq-pivot-type.shq-category-chip--active')?.textContent`)) === 'Compte');

  console.log('\n=== skip, reload, stop ===');
  await page.eval(`[...document.querySelectorAll('${BAR} button')].find(b=>b.textContent==='Passer').click(); 1`); await page.sleep(300);
  state = await pb(KEY);
  ok('6a skip moves on without marking done', state?.step === 3 && !state.done.includes('AC-S1'), JSON.stringify(state));
  // After a reload the Sentinel key is known again once a query has been seen (as in the portal)
  await page.goto(URL_); await page.sleep(500);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  await page.click('.shq-btn'); await page.sleep(900);
  ok('6b progress survives a reload ("Étape 4/5")', (await barText()).includes('Étape 4/5'), await barText());
  await page.eval(`[...document.querySelectorAll('${BAR} button')].find(b=>b.textContent==='Arrêter').click(); 1`); await page.sleep(300);
  ok('6c stop clears case.playbook', (await pb(KEY)) === undefined);

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL PLAYBOOK CHECKS PASSED');
  if (fails.length) throw new Error('playbook scenario failed');
};
