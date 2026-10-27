// Defect B/C scenario: lazy "unassigned" provisioning, bar wording, system-case display names (en/fr).
//   npm run harness && node harness/drive.mjs harness/scenarios/case-names.mjs
// Screenshots: /tmp/cb-<state>-<lang>.png.  Plain harness page (no ?capture=1): the tenant key stays `unknown`.
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const FR_NAMES = /Non attribué|Historique avant cas/;
const RULE_ROW = '.shq-pivot-rule-row';
const REAL = 'sentinel:aaaaaaaaaaaaaaaa';

export default async ({ page }) => {
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
  const J = (key) => page.eval(`JSON.parse(localStorage.getItem('ep-harness:${key}') ?? 'null')`);
  const put = (key, v) => page.eval(`(()=>{localStorage.setItem('ep-harness:${key}', ${JSON.stringify(JSON.stringify(v))}); return 1})()`);
  const caseCount = async () => ((await J('shq_cases'))?.cases ?? []).length;
  const bar = async () => (await page.text('.shq-pivot-case-bar')) ?? '';
  const now = Date.now();
  const entry = (id, name, tenantKeys, extra = {}) => ({ id, name, tenantKeys, createdAt: now, lastAccessAt: now - (extra.age ?? 0), tags: [], ...extra.rest });

  for (const lang of ['en', 'fr']) {
    const L = `[${lang}]`;
    console.log(`\n=== ${lang}: page load + panel open, nothing else ===`);
    await page.goto(`/?lang=${lang}`); await wipe(); await page.goto(`/?lang=${lang}`);
    await page.click('.shq-btn'); await page.sleep(700);
    ok(`${L} load + open panel + do nothing: zero cases in storage`, (await caseCount()) === 0 && (await J('shq_cases'))?.activeByKey?.unknown === undefined, JSON.stringify(await J('shq_cases')));
    const b0 = await bar();
    ok(`${L} bar uses the unreadable-tenant wording`, lang === 'en' ? /Cannot read this tenant/.test(b0) : /Tenant illisible/.test(b0), b0);
    ok(`${L} bar does not use the real-key wording`, !/No case for this tenant yet|Aucun cas pour ce tenant/.test(b0));
    ok(`${L} no raw i18n key / undefined`, !/caseBar\.|case\.system|undefined|\[object/.test(b0), b0);
    await page.shot(`/tmp/cb-unreadable-${lang}.png`);
    // closing and reopening the panel must still create nothing
    await page.click('.shq-pivot-header .shq-popup-close'); await page.sleep(200);
    await page.click('.shq-btn'); await page.sleep(500);
    ok(`${L} reopening the panel still creates nothing`, (await caseCount()) === 0);

    console.log(`\n=== ${lang}: first pivot under the unknown key ===`);
    await page.eval(`(()=>{const i=document.querySelector('.shq-pivot input[placeholder]'); return 1})()`);
    const valSel = lang === 'en' ? '.shq-pivot input[placeholder="Value to pivot on"]' : null;
    // value field: first text input of the params block
    await page.eval(`(()=>{const i=document.querySelector('.shq-pivot-params input.shq-pivot-input'); i.value='198.51.100.9'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    await page.sleep(300);
    await page.click(RULE_ROW); await page.sleep(900);
    const idx1 = await J('shq_cases');
    const sys = (idx1?.cases ?? []).filter((c) => c.system === 'unassigned');
    ok(`${L} exactly one case now, a system 'unassigned' one, covering only unknown, stored name unchanged`,
      (idx1?.cases ?? []).length === 1 && sys.length === 1 && JSON.stringify(sys[0].tenantKeys) === '["unknown"]' && sys[0].name === 'Non attribué', JSON.stringify(idx1?.cases));
    // second pivot reuses it (no second case)
    await page.click('.shq-btn'); await page.sleep(600);
    ok(`${L} panel reopened: still exactly one case`, (await caseCount()) === 1);
    const b1 = await bar();
    ok(`${L} bar shows the active case with a TRANSLATED name`, lang === 'en' ? /Active case: Unassigned/.test(b1) : /Cas actif : Non attribué/.test(b1), b1);
    if (lang === 'en') ok(`${L} visible bar text has no French system name`, !FR_NAMES.test(b1), b1);
    await page.shot(`/tmp/cb-active-system-${lang}.png`);
    await page.click('.shq-pivot-case-view-btn'); await page.sleep(400);
    const title = await page.text('.shq-case-view-title');
    ok(`${L} case view title translated`, lang === 'en' ? title === 'Unassigned' : title === 'Non attribué', title);
    const toast0 = await page.eval(`[...document.querySelectorAll('.shq-toast')].map(t=>t.textContent).join('|')`);
    if (lang === 'en') ok(`${L} toasts have no French system name`, !FR_NAMES.test(toast0), toast0);
    // report: the title uses the display name; the generated Markdown has no French system name in en
    await page.eval(`window.__clip=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:(s)=>{window.__clip=s;return Promise.resolve()}}}); 1`);
    await page.eval(`document.querySelector('.shq-case-view-header .shq-case-view-header-row:last-child .shq-pivot-btn').click(); 1`); await page.sleep(300);
    await page.eval(`document.querySelectorAll('.shq-report-dialog-actions .shq-pivot-btn')[0].click(); 1`); await page.sleep(400);
    const md = await page.eval('window.__clip');
    const firstLines = (md ?? '').split('\n').slice(0, 6).join(' / ');
    ok(`${L} report Markdown title uses the display name`, lang === 'en' ? /Unassigned/.test(md ?? '') && !FR_NAMES.test(md ?? '') : /Non attribué/.test(md ?? ''), firstLines);
    await page.eval(`document.querySelector('.shq-report-dialog-actions .shq-pivot-btn:last-child').click(); 1`); await page.sleep(200);
    // export keeps the STORED name (documented choice)
    await page.eval(`(()=>{window.__blob=null; URL.createObjectURL=(b)=>{window.__blob=b; return 'blob:x'}; HTMLAnchorElement.prototype.click=function(){}; return 1})()`);
    await page.eval(`document.querySelectorAll('.shq-case-view-header .shq-pivot-btn')[1].click(); 1`); await page.sleep(300);
    const exp = await page.eval(`window.__blob ? window.__blob.text() : null`);
    ok(`${L} case export carries the STORED name 'Non attribué' (not translated), no 'system' marker`, !!exp && /"name": "Non attribué"/.test(exp) && !/"system"/.test(exp), (exp ?? '').slice(0, 60));

    console.log(`\n=== ${lang}: legacy stored shapes (no marker) + ordinary lookalike ===`);
    await page.goto(`/?lang=${lang}`); await wipe();
    await put('shq_cases', { version: 1, cases: [
      entry('legacy-unassigned', 'Non attribué', ['unknown']),                      // pre-marker, exact legacy shape
      entry('legacy-migration', 'Historique avant cas', ['unknown'], { age: 1000 }), // pre-marker migration case
      entry('lookalike-multi', 'Non attribué', ['unknown', REAL], { age: 2000 }),   // user-made, covers a real key too -> NOT translated
      entry('ordinary', 'Incident 7', ['unknown'], { age: 3000 }),
    ], activeByKey: { unknown: 'legacy-unassigned' } });
    await put('shq_case_legacy-unassigned', { notes: '', snapshots: [], runs: [] });
    const rawBefore = await page.eval(`localStorage.getItem('ep-harness:shq_cases')`);
    await page.goto(`/?lang=${lang}`);
    await page.click('.shq-btn'); await page.sleep(800);
    const b2 = await bar();
    ok(`${L} legacy 'Non attribué' (no marker) is displayed translated in the bar`, lang === 'en' ? /Active case: Unassigned/.test(b2) : /Cas actif : Non attribué/.test(b2), b2);
    const opts = await page.eval(`[...document.querySelectorAll('.shq-pivot-case-bar select option')].map(o=>o.textContent)`);
    console.log('     switcher options: ' + JSON.stringify(opts));
    if (lang === 'en') {
      ok(`${L} switcher: legacy unassigned -> 'Unassigned', legacy migration -> 'History before cases'`, opts.includes('Unassigned') && opts.includes('History before cases'), JSON.stringify(opts));
      ok(`${L} switcher: the ordinary lookalike 'Non attribué' (covers a real key too) is shown as typed, exactly once`, opts.filter((o) => o === 'Non attribué').length === 1 && opts.includes('Incident 7'), JSON.stringify(opts));
      ok(`${L} migration name never appears in English`, !opts.includes('Historique avant cas'));
    } else {
      ok(`${L} switcher: French labels for both legacy system cases, lookalike literal`, opts.filter((o) => o === 'Non attribué').length === 2 && opts.includes('Historique avant cas'), JSON.stringify(opts));
    }
    ok(`${L} display did not rewrite the stored names (legacy names still French in storage after load + panel open; no marker was added to them)`, (await page.eval(`localStorage.getItem('ep-harness:shq_cases')`)).includes('"name":"Non attribué"') && (await page.eval(`localStorage.getItem('ep-harness:shq_cases')`)).includes('"name":"Historique avant cas"') && !(await page.eval(`localStorage.getItem('ep-harness:shq_cases')`)).includes('"system"'));
    await page.shot(`/tmp/cb-legacy-switcher-${lang}.png`);
    // Settings -> case export list uses the same display names
    await page.click('.shq-pivot-settings-btn'); await page.sleep(500);
    const setOpts = await page.eval(`[...document.querySelectorAll('.shq-pivot-settings select option, .shq-pivot select option')].map(o=>o.textContent)`);
    if (lang === 'en') ok(`${L} Settings case list: no 'Historique avant cas'`, !setOpts.includes('Historique avant cas') && setOpts.includes('History before cases'), JSON.stringify(setOpts));
    else ok(`${L} Settings case list present`, setOpts.includes('Historique avant cas'), JSON.stringify(setOpts));
    await page.click('.shq-pivot-settings-btn'); await page.sleep(200);
    // a rename drops the marker/translation: the user's typed name shows as typed
    // (core-level check lives in the tsx script; here: whole visible panel text in en has no French system name except the lookalike)
    if (lang === 'en') {
      const all = (await page.text('.shq-pivot')) ?? '';
      const hits = (all.match(/Non attribué|Historique avant cas/g) ?? []).length;
      ok(`${L} visible panel text: French system names appear only for the ordinary lookalike (<=1 time: its switcher option)`, hits <= 1, String(hits) + ' ' + all.slice(0, 120));
    }
    void rawBefore;
  }

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(' | ')}` : '\nALL CASE-NAME CHECKS PASSED');
  if (fails.length) throw new Error(`${fails.length} scenario check(s) failed`);
};
