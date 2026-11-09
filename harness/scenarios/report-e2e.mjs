// U4 / A3.2: the report built from a realistic case (chained pivots, results kept, manual queries with two
// identical ones, an error) says WHAT each query was and WHAT it found, masked by default.
//   npm run harness && node harness/drive.mjs harness/scenarios/report-e2e.mjs
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const D = '.shq-report-dialog';

export default async ({ page }) => {
  const getMarkdown = async () => {
    await page.eval(`window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (s) => { window.__clip = s; return Promise.resolve(); } } }); 1`);
    await page.eval(`document.querySelectorAll('${D}-actions .shq-pivot-btn')[0].click(); 1`); await page.sleep(400);
    return (await page.eval('window.__clip')) ?? '';
  };
  for (const lang of ['fr', 'en']) {
    console.log(`\n=== ${lang} ===`);
    await page.goto(`/?lang=${lang}`); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
    await page.click('#btn-seed-report'); await page.goto(`/?lang=${lang}`);
    await page.click('.shq-btn'); await page.sleep(500); await page.click('.shq-pivot-case-view-btn'); await page.sleep(300);
    await page.click('.shq-case-view-header > .shq-case-view-header-row:last-child > .shq-pivot-btn:first-child'); await page.sleep(300);
    const md = await getMarkdown();
    const s7 = md.slice(md.indexOf(lang === 'fr' ? '## 7.' : '## 7.'));
    const manual = lang === 'fr' ? 'Requête manuelle' : 'Manual query';

    // What each query was
    ok(`[${lang}] pivot queries titled "Rule name (ID)"`, /### .+ \(IP-S1\)/.test(s7) && /### .+ \(AC-S1\)/.test(s7));
    ok(`[${lang}] manual queries titled as such`, s7.includes(`### ${manual}`));
    ok(`[${lang}] indicator type printed with the value`, /203\.0\.x\.x.*·/.test(s7) && s7.includes(lang === 'fr' ? 'Compte' : 'Account'));
    ok(`[${lang}] identical manual queries grouped x2`, s7.includes('×2'));
    ok(`[${lang}] failed query shows its error`, s7.includes("Query could not be parsed"));
    // What it found
    ok(`[${lang}] results excerpt tables present`, (s7.match(/^\| --- /gm) ?? []).length >= 3, String((s7.match(/^\| --- /gm) ?? []).length));
    ok(`[${lang}] excerpt capped at 50 rows with a note`, s7.includes(lang === 'fr' ? '50 premières lignes sur 1000' : 'first 50 rows of 1000'));
    ok(`[${lang}] context columns readable (table, app, country)`, s7.includes('`SigninLogs`') && s7.includes('Office 365 Exchange Online') && s7.includes('`NL`'));
    ok(`[${lang}] KQL kept, folded`, s7.includes('<details>') && s7.includes('</details>'));
    // Masked by default
    for (const clear of ['192.0.2.188', 'margaret.oshea', 'ZEPHYR-WKS-0412', 'acme-health', 'Acme Health Group', '7f1d3a44']) {
      ok(`[${lang}] masked report has no "${clear}"`, !md.includes(clear));
    }
    ok(`[${lang}] no custom _CL table anywhere`, !/_CL\b/.test(md));
    ok(`[${lang}] distinct IPs told apart ([1] / [2])`, md.includes('203.0.x.x \\[1\\]') && md.includes('203.0.x.x \\[2\\]'));
    ok(`[${lang}] tree lists the pivots under their node`, /^\s+- IP-S1 .*·/m.test(md));
    ok(`[${lang}] no raw i18n key`, !/\breport\.[a-zA-Z]+/.test(md) && !md.includes('undefined'));

    // Clear mode
    await page.eval(`window.confirm = () => true; 1`);
    await page.click(`${D} input[type=checkbox]`); await page.sleep(200);
    const clear = await getMarkdown();
    ok(`[${lang}] clear report shows the real values`, clear.includes('192.0.2.188') && clear.includes('margaret.oshea@acme-health.example.com'));
    ok(`[${lang}] clear report still drops _CL tables`, !/_CL\b/.test(clear));
  }
  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL REPORT-E2E CHECKS PASSED');
  if (fails.length) throw new Error('report-e2e scenario failed');
};
