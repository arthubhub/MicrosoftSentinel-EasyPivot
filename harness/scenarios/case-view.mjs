const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };
const BAD = /(caseView|panel\.context|notify|caseBar|settings)\.[a-zA-Z]+|undefined|\[object|NaN/;

export default async ({ page }) => {
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); delete window.__pwned; return 1})()`);
  const open = async () => {
    await page.click('.shq-btn'); await page.sleep(500);
    await page.click('.shq-pivot-case-view-btn'); await page.sleep(300);
  };
  const viewText = () => page.text('.shq-case-view');
  const depthOf = (d) => `.shq-case-view-node[data-depth="${d}"]`;

  for (const lang of ['en', 'fr']) {
    console.log(`\n=== ${lang}: open case ===`);
    await page.goto(`/?lang=${lang}`); await wipe();
    await page.click('#btn-seed-case'); await page.goto(`/?lang=${lang}`);
    await open();
    ok(`[${lang}] view exists`, await page.exists('.shq-case-view'));
    const w = await page.eval(`document.querySelector('.shq-case-view').getBoundingClientRect().width`);
    ok(`[${lang}] width 420`, w === 420, String(w));
    const depths = await page.eval(`[...document.querySelectorAll('.shq-case-view-node')].map(n=>n.dataset.depth).join(',')`);
    console.log('depths in DOM order:', depths);
    ok(`[${lang}] 4 nodes, max depth 2`, depths.split(',').length === 4 && Math.max(...depths.split(',').map(Number)) === 2, depths);
    ok(`[${lang}] depth set is {0,1,2,0}`, [...depths.split(',')].sort().join('') === '0012', depths);
    const nodeTexts = await page.eval(`[...document.querySelectorAll('.shq-case-view-node-row')].map(r=>r.innerText.replace(/\\n+/g,' | '))`);
    console.log(nodeTexts.join('\n'));
    const nodeRow = (valueFrag) => nodeTexts.find((t) => t.includes(valueFrag)) ?? '';
    const A = nodeRow('203.0.113.17'), B = nodeRow('alice@contoso.com'), C = nodeRow('srv-prod-01'), D = nodeRow('WKS-042');
    ok(`[${lang}] A badge 12 rows`, /12 /.test(A));
    ok(`[${lang}] A has note icon`, A.includes('✎'));
    ok(`[${lang}] B 1000 rows + truncated`, /1000 /.test(B) && /(truncated|tronqué)/.test(B));
    ok(`[${lang}] B pin count 1`, B.includes('📌 1'));
    ok(`[${lang}] C 0 rows + error`, /0 /.test(C) && /(error|erreur)/.test(C));
    ok(`[${lang}] D no-result dash, no note`, D.includes('—') && !D.includes('✎'));
    const t = await viewText();
    ok(`[${lang}] no raw key/undefined/[object in view`, !BAD.test(t), (t.match(BAD) || [])[0]);
    ok(`[${lang}] global note shown`, await page.eval(`[...document.querySelectorAll('.shq-case-view textarea')].some(a=>a.value.startsWith('Global note'))`));
    if (lang === 'en') { await page.shot('/tmp/cv-1-open-tree.png'); }
    else await page.shot('/tmp/cv-1-open-tree-fr.png');

    // node click loads the snapshot in the Pivot panel
    await page.click(`${depthOf(1)} .shq-case-view-node-label`); await page.sleep(300);
    const val = await page.eval(`document.querySelector('.shq-pivot-params input.shq-pivot-input').value`);
    ok(`[${lang}] click B -> Pivot value field = alice@contoso.com`, val === 'alice@contoso.com', val);
    const sel = await page.eval(`(()=>{const s=document.querySelector('.shq-pivot-history'); return s.options[s.selectedIndex].text})()`);
    ok(`[${lang}] click B -> Event selector shows B`, sel.includes('alice@contoso.com'), sel);
    ok(`[${lang}] Pivot panel still open`, await page.exists('.shq-pivot'));
    const overlap = await page.eval(`(()=>{const p=document.querySelector('.shq-pivot').getBoundingClientRect(), v=document.querySelector('.shq-case-view').getBoundingClientRect(); return {pr:p.right, vl:v.left}})()`);
    ok(`[${lang}] Pivot panel does not overlap the view`, overlap.pr <= overlap.vl, JSON.stringify(overlap));
    ok(`[${lang}] selected node highlighted`, await page.exists(`${depthOf(1)} .shq-case-view-node-row--selected`));
    ok(`[${lang}] B pivot-panel pin info shows 1`, /1/.test(await page.text('.shq-pivot-pin-info') ?? ''));

    // pin on C
    await page.click(`${depthOf(2)} .shq-case-view-node-label`); await page.sleep(300);
    ok(`[${lang}] pin enabled on C`, await page.eval(`!document.querySelector('.shq-pivot-pin').disabled`));
    ok(`[${lang}] pin info empty on C`, !(await page.eval(`document.querySelector('.shq-pivot-pin-info').offsetParent !== null`)));
    await page.click('.shq-pivot-pin'); await page.sleep(300);
    ok(`[${lang}] pin count in Pivot panel = 1`, /1/.test(await page.text('.shq-pivot-pin-info') ?? ''), await page.text('.shq-pivot-pin-info'));
    const cRow = await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-node-row').innerText.replace(/\\n+/g,' | ')`);
    ok(`[${lang}] C row shows pin 1 in view`, cRow.includes('📌 1'), cRow);
    await page.click('.shq-pivot-pin'); await page.sleep(300);
    const cRow2 = await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-node-row').innerText.replace(/\\n+/g,' | ')`);
    ok(`[${lang}] duplicate pin keeps count 1`, cRow2.includes('📌 1'), cRow2);
    await page.shot(`/tmp/cv-2-after-pin-${lang}.png`);

    // note typed + blur persists
    const NOTE = 'Lateral movement to srv-prod-01 ' + lang;
    await page.eval(`(()=>{const ta=document.querySelector('${depthOf(2)} textarea'); ta.focus(); ta.value=${JSON.stringify(NOTE)}; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.blur(); return 1})()`);
    await page.sleep(200);
    ok(`[${lang}] note icon on C after blur`, (await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-note-icon').hidden`)) === false);
    ok(`[${lang}] saved indicator`, /(Saved|Enregistré)/.test(await page.text(`${depthOf(2)} .shq-case-view-note`) ?? ''));
    const GNOTE = 'Global edited ' + lang;
    await page.eval(`(()=>{const ta=document.querySelector('.shq-case-view-section textarea'); ta.focus(); ta.value=${JSON.stringify(GNOTE)}; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.blur(); return 1})()`);
    await page.sleep(200);
    await page.goto(`/?lang=${lang}`);
    await open();
    await page.click(`${depthOf(2)} .shq-case-view-node-label`); await page.sleep(300);
    const persisted = await page.eval(`document.querySelector('${depthOf(2)} textarea').value`);
    ok(`[${lang}] node note persisted after reload`, persisted === NOTE, persisted);
    const gp = await page.eval(`document.querySelector('.shq-case-view-section textarea').value`);
    ok(`[${lang}] global note persisted after reload`, gp === GNOTE, gp);
    const cRow3 = await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-node-row').innerText.replace(/\\n+/g,' | ')`);
    ok(`[${lang}] note icon + pin persisted after reload`, cRow3.includes('✎') && cRow3.includes('📌 1'), cRow3);
    // clearing a note
    await page.eval(`(()=>{const ta=document.querySelector('${depthOf(2)} textarea'); ta.focus(); ta.value=''; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.blur(); return 1})()`);
    await page.sleep(200);
    ok(`[${lang}] emptied note clears the icon`, (await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-note-icon').hidden`)) === true);
    // unpin
    await page.click(`${depthOf(2)} .shq-case-view-unpin`); await page.sleep(300);
    const cRow4 = await page.eval(`document.querySelector('${depthOf(2)} .shq-case-view-node-row').innerText.replace(/\\n+/g,' | ')`);
    ok(`[${lang}] unpin removes the pin badge`, !cRow4.includes('📌'), cRow4);
    const t2 = await viewText(); const t3 = await page.text('.shq-pivot');
    ok(`[${lang}] no raw key in view / pivot panel after use`, !BAD.test(t2) && !BAD.test(t3), (t2.match(BAD) || t3.match(BAD) || [])[0]);

    // collapse
    await page.click(`${depthOf(1)} .shq-case-view-toggle`); await page.sleep(200);
    const afterCollapse = await page.eval(`document.querySelectorAll('.shq-case-view-node').length`);
    ok(`[${lang}] collapsing B hides C (3 nodes)`, afterCollapse === 3, String(afterCollapse));
    await page.shot(`/tmp/cv-3-collapsed-${lang}.png`);
  }

  // Export + Close, EN, live
  console.log('\n=== export + close ===');
  await page.goto('/?lang=en'); await wipe();
  await page.click('#btn-seed-case'); await page.goto('/?lang=en'); await open();
  await page.eval(`(()=>{window.__dl=null; URL.createObjectURL=(b)=>{window.__blob=b; return 'blob:x'}; HTMLAnchorElement.prototype.click=function(){window.__dl=this.download}; return 1})()`);
  const exportBtn = '.shq-case-view-header .shq-pivot-btn:nth-of-type(2)';
  await page.click(exportBtn); await page.sleep(300);
  const dl = await page.eval(`window.__dl`);
  const json = await page.eval(`window.__blob.text()`);
  ok('export downloaded a file', /^easypivot-case-\d+\.json$/.test(dl ?? ''), dl);
  ok('export masked: no IOC / email / note text', !/alice@contoso|203\.0\.113\.17|Brute force|credential stuffing/.test(json));
  ok('export contains notes as masked ***', json.includes('"note": "***"'));
  await page.eval(`window.confirm=()=>true`);
  await page.eval(`document.querySelectorAll('.shq-case-view-header .shq-pivot-btn')[2].click()`); await page.sleep(600);
  const closedAt = await page.eval(`JSON.parse(localStorage.getItem('ep-harness:shq_cases')).cases.find(c=>c.name==='Incident 42')?.closedAt ?? null`);
  ok('Clôturer persisted closedAt on Incident 42', typeof closedAt === 'number', String(closedAt));
  const titleAfter = await page.text('.shq-case-view-title');
  console.log('view title after closing (case bar re-resolved):', titleAfter);
  ok('after closing, the resolution rule moved the view off the closed case', titleAfter !== 'Incident 42', titleAfter);
  await page.shot('/tmp/cv-6-after-close.png');

  // Closed case made active WITHOUT a case-bar refresh (the only way it can be active: see report)
  console.log('\n=== closed case (active, read-only) ===');
  for (const lang of ['en', 'fr']) {
    await page.goto(`/?lang=${lang}`); await wipe();
    await page.goto(`/?lang=${lang}`);
    await page.click('.shq-btn'); await page.sleep(600);
    // Cases are no longer auto-created on load: provision the unassigned case through the bar's button (old precondition)
    await page.click('.shq-pivot-case-bar .shq-pivot-btn'); await page.sleep(500);
    await page.eval(`document.getElementById('btn-seed-closed').click()`);
    await page.click('.shq-pivot-case-view-btn'); await page.sleep(300);
    ok(`[${lang}] closed: view title is the closed case`, (await page.text('.shq-case-view-title')) === 'Old incident (closed)');
    ok(`[${lang}] closed: status badge`, /(Closed|Clôturé)/.test(await page.text('.shq-case-view-status') ?? ''));
    await page.click(`${depthOf(0)} .shq-case-view-node-label`); await page.sleep(300);
    const states = await page.eval(`[...document.querySelectorAll('.shq-case-view textarea')].map(a=>a.disabled)`);
    ok(`[${lang}] closed: ${states.length} textareas, all disabled`, states.length >= 2 && states.every(Boolean), JSON.stringify(states));
    ok(`[${lang}] closed: reason visible in view`, /(read-only|lecture seule)/.test(await viewText()));
    ok(`[${lang}] closed: pin disabled`, await page.eval(`document.querySelector('.shq-pivot-pin').disabled`));
    const info = await page.text('.shq-pivot-pin-info');
    ok(`[${lang}] closed: pin reason visible`, /(closed|clôturé)/i.test(info ?? ''), info);
    ok(`[${lang}] closed: unpin disabled`, await page.eval(`[...document.querySelectorAll('.shq-case-view-unpin')].length>0 && [...document.querySelectorAll('.shq-case-view-unpin')].every(b=>b.disabled)`));
    ok(`[${lang}] closed: Close case button disabled`, await page.eval(`document.querySelectorAll('.shq-case-view-header .shq-pivot-btn')[2].disabled`));
    ok(`[${lang}] closed: no raw key`, !BAD.test(await viewText()) && !BAD.test(await page.text('.shq-pivot')));
    await page.shot(`/tmp/cv-4-closed-${lang}.png`);
  }
  // Right-click opens the panel on a not-yet-recorded event: pin must be disabled WITH a visible reason
  console.log('\n=== pin without a snapshot ===');
  for (const lang of ['en', 'fr']) {
    await page.goto(`/?lang=${lang}&cellmenu=none`); await wipe();
    await page.goto(`/?lang=${lang}&cellmenu=none`);
    await page.rightClick('[role="gridcell"][col-id="RemoteIP"]'); await page.sleep(600);
    ok(`[${lang}] right-click opened the panel`, await page.exists('.shq-pivot'));
    ok(`[${lang}] pin disabled without a snapshot`, await page.eval(`document.querySelector('.shq-pivot-pin').disabled`));
    const info = await page.text('.shq-pivot-pin-info');
    ok(`[${lang}] pin reason visible`, /(No event recorded|Aucun événement enregistré)/.test(info ?? ''), info);
    await page.shot(`/tmp/cv-7-pin-nosnapshot-${lang}.png`);
  }

  // Hostile
  console.log('\n=== hostile ===');
  await page.goto('/?lang=en'); await wipe();
  await page.click('#btn-seed-hostile'); await page.goto('/?lang=en'); await open();
  await page.click(`${depthOf(0)} .shq-case-view-node-label`); await page.sleep(400);
  const pwned = await page.eval(`typeof window.__pwned`);
  ok('hostile: window.__pwned is undefined', pwned === 'undefined', pwned);
  ok('hostile: no <img>/<script> element created in view or panel', await page.eval(`document.querySelectorAll('.shq-case-view img, .shq-case-view script, .shq-pivot img, .shq-pivot script, .shq-case-view b').length === 0`));
  const vt = await viewText();
  ok('hostile: value shown literally in the tree', vt.includes('<img src=x onerror="window.__pwned=1">'));
  ok('hostile: case name shown literally in header', await page.eval(`document.querySelector('.shq-case-view-title').textContent.includes('<img src=x onerror="window.__pwned=1">')`));
  ok('hostile: client name shown literally', await page.eval(`document.querySelector('.shq-case-view-client').textContent.includes('<b><img src=x onerror="window.__pwned=1">')`));
  ok('hostile: node note literal in textarea', await page.eval(`[...document.querySelectorAll('.shq-case-view textarea')].some(a=>a.value==='<script>window.__pwned=2</script>')`));
  ok('hostile: global note literal in textarea', await page.eval(`[...document.querySelectorAll('.shq-case-view textarea')].some(a=>a.value==='<script>window.__pwned=2</script><img src=x onerror="window.__pwned=1">')`));
  ok('hostile: pinned row literal text', (await page.eval(`document.querySelector('.shq-case-view-pinned-text')?.textContent ?? ''`)).includes('Col=<script>window.__pwned=2</script>'));
  await page.sleep(500);
  ok('hostile: still undefined after settling', (await page.eval(`typeof window.__pwned`)) === 'undefined');
  await page.shot('/tmp/cv-5-hostile.png');

  if (fails.length) throw new Error(fails.length + ' check(s) failed: ' + fails.join(' | '));
  console.log('\nALL CHECKS PASSED');
};
