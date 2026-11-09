// README screenshots (fake portal, fictitious data), one set per language, written to docs/<lang>-*.png.
//   npm run harness && LANG_SHOTS=fr node harness/drive.mjs harness/readme/shots.mjs
// Not a test: not run by roadmap/verify.sh.
import { mkdirSync } from 'node:fs';
const lang = process.env.LANG_SHOTS ?? 'en';
const OUT = new URL('../../docs/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const URL_ = `/?capture=1&cellmenu=none&lang=${lang}`;
const CELL = (row, col) => `[role="row"][row-index="${row}"] [role="gridcell"][col-id="${col}"]`;
const CLOSE = '.shq-pivot-header .shq-popup-close';
const fr = lang === 'fr';

export default async ({ page }) => {
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
  const run = () => page.eval(`window.__epRun('cursor')`);
  const shot = (name, clip) => page.shot(`${OUT}${lang}-${name}.png`, { clip, scale: 2 });
  const closePanel = async () => { if (await page.exists('.shq-pivot')) { await page.click(CLOSE); await page.sleep(200); } };

  // 1. Pivot panel: right-click, case, "Pivot to" filter, values of the result
  await page.goto(URL_); await wipe(); await page.goto(URL_);
  await page.eval(`(()=>{document.getElementById('fake-editor').value='SigninLogs\\n| where ResultType != 0\\n| take 100'; return 1})()`);
  await run(); await page.sleep(900);
  await page.rightClick(CELL(0, 'RemoteIP')); await page.sleep(800);
  await page.click('.shq-pivot-case-bar .shq-pivot-btn--primary'); await page.sleep(900);
  await page.eval(`[...document.querySelectorAll('.shq-pivot-target')].find(b=>/Machine|Device/.test(b.textContent))?.click(); 1`); await page.sleep(300);
  await shot('panel', '.shq-pivot[role=dialog]');

  // 2. Playbook in progress with carried values
  await page.eval(`[...document.querySelectorAll('.shq-pivot-target')][0]?.click(); 1`); await page.sleep(200);
  await page.eval(`(()=>{const s=document.querySelector('.shq-pivot-playbook select'); if(s){s.value='S1';} return 1})()`);
  await page.eval(`[...document.querySelectorAll('.shq-pivot-playbook button')].find(b=>/Démarrer|Start/.test(b.textContent))?.click(); 1`); await page.sleep(400);
  await page.eval(`[...document.querySelectorAll('.shq-pivot-playbook button')].find(b=>/Lancer|Run/.test(b.textContent))?.click(); 1`); await page.sleep(900);
  await page.click('.shq-btn'); await page.sleep(700);
  await page.eval(`[...document.querySelectorAll('.shq-pivot-rule-row')].find(r=>r.textContent.includes('IP-P2'))?.click(); 1`); await page.sleep(900);
  await run(); await page.sleep(900);
  await page.click('.shq-btn'); await page.sleep(700);
  await shot('playbook', '.shq-pivot-playbook');
  await shot('result-values', '.shq-pivot-context');
  await closePanel();

  // 3. Case view + report, on the realistic demo case
  await page.goto(URL_); await wipe();
  await page.click('#btn-seed-report'); await page.goto(URL_);
  await page.click('.shq-btn'); await page.sleep(600);
  await page.click('.shq-pivot-case-view-btn'); await page.sleep(500);
  await shot('case-view', '.shq-case-view-header, .shq-case-view textarea, .shq-case-view-node');
  // Hero: the portal page with the panel and the case view, harness chrome hidden
  await page.eval(`(()=>{const s=document.createElement('style'); s.id='readme-hide'; s.textContent='body > header{display:none !important} aside:not([class*="shq"]), .shq-toast{visibility:hidden !important}'; document.head.appendChild(s); return 1})()`);
  await page.sleep(200);
  await page.shot(`${OUT}${lang}-hero.png`, { clip: { x: 0, y: 0, width: 1400, height: 1000 }, scale: 2 });
  await page.eval(`(document.getElementById('readme-hide')?.remove(), 1)`);
  await page.eval(`window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; 1`);
  await page.click('.shq-case-view-header > .shq-case-view-header-row:last-child > .shq-pivot-btn:first-child'); await page.sleep(400);
  await page.eval(`[...document.querySelectorAll('.shq-report-dialog-actions .shq-pivot-btn')].find(b=>/HTML/.test(b.textContent))?.click(); 1`); await page.sleep(400);
  const html = await page.eval(`window.__blobs.length ? window.__blobs[window.__blobs.length-1].text() : ''`);
  if (html) {
    // Served as a real page (its own CSP applies), then section 7 captured in document coordinates
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const tmp = new URL('./report.tmp.html', import.meta.url).pathname;
    writeFileSync(tmp, html);
    await page.goto('/readme/report.tmp.html'); await page.sleep(500);
    const box = await page.eval(`(()=>{const m=document.querySelector('main').getBoundingClientRect(); const h=[...document.querySelectorAll('h2')].find(x=>x.textContent.startsWith('7.')); return {x:m.left+scrollX, y:(h?h.getBoundingClientRect().top:0)+scrollY-16, width:m.width}})()`);
    await page.shot(`${OUT}${lang}-report.png`, { clip: { x: box.x, y: box.y, width: box.width, height: 1100 }, scale: 2 });
    unlinkSync(tmp);
  }

  // 4. Coverage gaps of a discovery result
  await page.goto(URL_); await wipe(); await page.goto(URL_);
  await page.eval(`(()=>{ window.__epRows = [
    { Table: 'SigninLogs', Column: 'IPAddress', Path: 'IPAddress', Status: 'Lu par les règles' },
    { Table: 'AZFWNetworkRule', Column: 'SourceIp', Path: 'SourceIp', Status: 'Non lu par les règles' },
    { Table: 'CloudAppEvents', Column: 'RawEventData', Path: "RawEventData['ClientIP']", Status: 'Colonne lue, chemin JSON à vérifier' },
    { Table: 'StorageBlobLogs', Column: 'CallerIpAddress', Path: 'CallerIpAddress', Status: 'Non lu par les règles' },
  ]; document.getElementById('fake-editor').value = '// [IP-S9] Discovery\\nunion *'; return 1 })()`);
  await run(); await page.sleep(900);
  await page.rightClick(CELL(1, 'Table')); await page.sleep(900);
  await page.eval(`[...document.querySelectorAll('.shq-pivot-coverage-row')][0]?.querySelector('button').click(); 1`); await page.sleep(300);
  await shot('coverage', '.shq-pivot-coverage');
  console.log(`shots written for ${lang} in ${OUT}`);
};
