// #33 / B4.2: a discovery (*-S9) result lists the locations the rules do not read; "Propose" previews the
// allowlisted fields; the GitHub link carries nothing else; _CL tables never appear; reported gaps disappear.
//   npm run harness && node harness/drive.mjs harness/scenarios/coverage.mjs
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const URL_ = '/?capture=1&cellmenu=none&lang=fr';
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;

export default async ({ page }) => {
  await page.goto(URL_); await page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`); await page.goto(URL_);
  await page.eval(`(()=>{ window.__epRows = [
    { Table: 'SigninLogs', Column: 'IPAddress', Path: 'IPAddress', Status: 'Lu par les règles', ExactRows: '12' },
    { Table: 'AZFWNetworkRule', Column: 'SourceIp', Path: 'SourceIp', Status: 'Non lu par les règles', ExactRows: '3' },
    { Table: 'Corp_Proxy_CL', Column: 'src_ip', Path: 'src_ip', Status: 'Non lu par les règles', ExactRows: '40' },
    { Table: 'CloudAppEvents', Column: 'RawEventData', Path: "RawEventData['ClientIP']", Status: 'Colonne lue, chemin JSON à vérifier', ExactRows: '7' },
  ]; document.getElementById('fake-editor').value = '// [IP-S9] Découverte\\nunion *'; return 1 })()`);
  await page.eval(`window.__epRun('cursor')`); await page.sleep(900);
  await page.rightClick(CELL(1, 'Table')); await page.sleep(900);

  const text = (await page.text('.shq-pivot-coverage')) ?? '';
  console.log(text.replace(/\s+/g, ' ').slice(0, 300));
  ok('1 coverage block shown for a discovery result', await page.eval(`!document.querySelector('.shq-pivot-coverage').hidden`));
  ok('2 typed from the IP-S9 rule', /Adresse IP/.test(text));
  ok('3 unread column listed', text.includes('AZFWNetworkRule.SourceIp'));
  ok('4 JSON path to check listed', text.includes('CloudAppEvents.RawEventData'));
  ok('5 read column not listed', !text.includes('SigninLogs.IPAddress'));
  ok('6 custom _CL table never listed', !/_CL/.test(text));

  await page.eval(`[...document.querySelectorAll('.shq-pivot-coverage-row')].find(r=>r.textContent.includes('AZFW')).querySelector('button').click(); 1`); await page.sleep(200);
  const href = await page.eval(`document.querySelector('.shq-pivot-coverage-preview a').href`);
  const u = new URL(href);
  const keys = [...u.searchParams.keys()].sort().join(',');
  ok('7 link goes to the rules repo issue form', u.origin + u.pathname === 'https://github.com/arthubhub/MSSentinel-PivotRules/issues/new');
  ok('8 only allowlisted parameters', keys === 'catalog_version,column,indicator,platform,table,template,title' || keys === 'column,indicator,platform,table,template,title', keys);
  ok('9 no value, count or tenant in the link', !/203\.|ExactRows|=3\b|sentinel%3A|workspace/i.test(href), href);
  ok('10 link opens in a new tab without opener', await page.eval(`(()=>{const a=document.querySelector('.shq-pivot-coverage-preview a'); return a.target==='_blank' && a.rel.includes('noopener')})()`));

  // Follow the link without leaving the page: swallow the navigation, keep the click handler
  await page.eval(`(()=>{const a=document.querySelector('.shq-pivot-coverage-preview a'); a.addEventListener('click', (e)=>e.preventDefault()); a.click(); return 1})()`); await page.sleep(300);
  const after = (await page.text('.shq-pivot-coverage')) ?? '';
  ok('11 a reported gap is no longer proposed', !after.includes('AZFWNetworkRule.SourceIp') && after.includes('CloudAppEvents.RawEventData'));
  const stored = await page.eval(`localStorage.getItem('ep-harness:shq_coverage_reported')`);
  ok('12 the reported list holds type|table|column only', stored === JSON.stringify(['ip|azfwnetworkrule|sourceip']), stored);

  console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(' | ')}` : '\nALL COVERAGE CHECKS PASSED');
  if (fails.length) throw new Error('coverage scenario failed');
};
