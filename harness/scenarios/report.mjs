// Scenario for the report dialog (N3, 5f):  npm run harness && node harness/drive.mjs harness/scenarios/report.mjs
// Screenshots go to /tmp/rp-*.png. Exits non-zero (via drive.mjs) when a check fails.
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); if (!cond) fails.push(name); };

export default async ({ page }) => {
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); return 1})()`);
  const openView = async () => { await page.click('.shq-btn'); await page.sleep(500); await page.click('.shq-pivot-case-view-btn'); await page.sleep(300); };
  const reportBtn = '.shq-case-view-header > .shq-case-view-header-row:last-child > .shq-pivot-btn:first-child';
  const D = '.shq-report-dialog';
  // Capture every Blob handed to URL.createObjectURL (the download path) and every clipboard write.
  const hook = () => page.eval(`(()=>{ window.__blobs = []; const o = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; return 1 })()`);
  const lastBlobText = () => page.eval(`window.__blobs.length ? window.__blobs[window.__blobs.length-1].text() : null`);
  const toasts = () => page.eval(`[...document.querySelectorAll('.shq-toast')].map(t=>t.textContent)`);

  for (const lang of ['en', 'fr']) {
    console.log(`\n=== ${lang}: dialog ===`);
    await page.goto(`/?lang=${lang}`); await wipe();
    await page.click('#btn-seed-report'); await page.goto(`/?lang=${lang}`);
    await hook(); await openView();
    ok(`[${lang}] Report button exists in the case view header`, await page.exists(reportBtn));
    ok(`[${lang}] nothing generated before the click (no dialog, no blob)`, !(await page.exists(D)) && (await page.eval('window.__blobs.length')) === 0);
    await page.click(reportBtn); await page.sleep(300);
    ok(`[${lang}] dialog open`, await page.exists(D));
    ok(`[${lang}] mask checkbox checked by default`, await page.eval(`document.querySelector('${D} input[type=checkbox]').checked`));
    const noticeNeedle = lang === 'en' ? 'Review the notes before sharing' : 'Relire les notes avant de partager';
    const notice = await page.text(`${D}-notice`);
    ok(`[${lang}] pattern-masking notice visible next to the checkbox`, (notice ?? '').includes(noticeNeedle) && await page.eval(`document.querySelector('${D}-notice').offsetParent !== null`), notice?.slice(0, 80));
    const dlgText = await page.text(D);
    ok(`[${lang}] no raw i18n key / undefined in dialog`, !/(reportDialog|report|notify)\.[a-zA-Z.]+|undefined|\[object/.test(dlgText ?? ''), dlgText);
    await page.shot(`/tmp/rp-dialog-${lang}.png`);

    // unticking asks for confirmation; declining keeps it ticked, accepting unticks, and nothing is persisted
    await page.eval(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return false; }; 1`);
    await page.click(`${D} input[type=checkbox]`); await page.sleep(150);
    ok(`[${lang}] declined confirm -> still ticked`, await page.eval(`document.querySelector('${D} input[type=checkbox]').checked`));
    ok(`[${lang}] confirm was asked`, (await page.eval('window.__confirms.length')) === 1);
    await page.eval(`window.confirm = (m) => { window.__confirms.push(m); return true; }; 1`);
    await page.click(`${D} input[type=checkbox]`); await page.sleep(150);
    ok(`[${lang}] accepted confirm -> unticked`, !(await page.eval(`document.querySelector('${D} input[type=checkbox]').checked`)));
    ok(`[${lang}] notice switches to the clear-text one`, !(await page.text(`${D}-notice`) ?? '').includes(noticeNeedle));
    await page.shot(`/tmp/rp-dialog-unticked-${lang}.png`);
    const stored = await page.eval(`localStorage.getItem('ep-harness:shq_settings')`);
    ok(`[${lang}] checkbox state NOT written back to settings`, !/"report"/.test(stored ?? '') || /"redact":true/.test(stored ?? ''), stored);
    await page.click(`${D} input[type=checkbox]`); await page.sleep(100); // re-tick: no confirm needed
    ok(`[${lang}] re-ticked without confirm`, (await page.eval('window.__confirms.length')) === 2 && await page.eval(`document.querySelector('${D} input[type=checkbox]').checked`));

    // Copy, real clipboard first (headless: expect either success or the honest failure toast)
    const actionBtns = `${D}-actions .shq-pivot-btn`;
    await page.eval(`document.querySelectorAll('${actionBtns}')[0].click(); 1`); await page.sleep(500);
    const t1 = (await toasts()).join(' | ');
    const copiedWord = lang === 'en' ? /copied to the clipboard/ : /copié dans le presse-papiers/;
    const deniedWord = lang === 'en' ? /Clipboard access denied/ : /Accès au presse-papiers refusé/;
    ok(`[${lang}] real clipboard: success toast OR honest denial toast (got: ${t1})`, copiedWord.test(t1) || deniedWord.test(t1));
    console.log(`     (real headless clipboard outcome: ${copiedWord.test(t1) ? 'copied' : 'denied'})`);
    // Copy again with a stubbed clipboard to see the text the button sends
    await page.eval(`window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (s) => { window.__clip = s; return Promise.resolve(); } } }); 1`);
    await page.eval(`document.querySelectorAll('${actionBtns}')[0].click(); 1`); await page.sleep(400);
    const clip = await page.eval('window.__clip');
    ok(`[${lang}] stubbed clipboard received Markdown`, typeof clip === 'string' && clip.startsWith('# '));
    ok(`[${lang}] clipboard text masked (no real value)`, !/margaret|oshea|192\.0\.2\.188|ZEPHYR|acme|lindqvist|198\.51\.100\.77|PRIVATE-SERVER/i.test(clip ?? ''), (clip ?? '').slice(0, 60));
    ok(`[${lang}] clipboard text has the 7 sections`, [1, 2, 3, 4, 5, 6, 7].every((n) => new RegExp(`^## ${n}\\. `, 'm').test(clip ?? '')));
    ok(`[${lang}] success toast after the stubbed copy`, copiedWord.test((await toasts()).join(' | ')));
    // Denied path with a rejecting clipboard
    await page.eval(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('NotAllowed')) } }); document.querySelectorAll('.shq-toast').forEach(t=>t.remove()); document.querySelectorAll('${actionBtns}')[0].click(); 1`);
    await page.sleep(400);
    ok(`[${lang}] rejecting clipboard -> error toast, no success toast`, deniedWord.test((await toasts()).join(' | ')) && !copiedWord.test((await toasts()).join(' | ')), (await toasts()).join(' | '));

    // Download HTML (masked), then LOAD it
    await page.eval(`document.querySelectorAll('${actionBtns}')[1].click(); 1`); await page.sleep(400);
    const html = await lastBlobText();
    ok(`[${lang}] download produced an HTML blob`, typeof html === 'string' && html.startsWith('<!doctype html>'));
    ok(`[${lang}] blob is text/html`, (await page.eval('window.__blobs[window.__blobs.length-1].type')) === 'text/html');
    ok(`[${lang}] downloaded HTML masked`, !/margaret|oshea|192\.0\.2\.188|ZEPHYR|acme|lindqvist|198\.51\.100\.77|PRIVATE-SERVER/i.test(html ?? ''));
    ok(`[${lang}] downloaded HTML has CSP, no script`, /Content-Security-Policy/.test(html) && !/<script/i.test(html));
    await page.eval(`window.__html = window.__blobs[window.__blobs.length-1]; location.href = URL.createObjectURL(window.__html); 1`); await page.sleep(800);
    ok(`[${lang}] report document loaded`, (await page.eval('document.querySelectorAll("h2").length')) === 7, String(await page.eval('document.title')));
    ok(`[${lang}] rendered: no script/img/svg/iframe/link/a element`, (await page.eval(`document.querySelectorAll('script,img,svg,iframe,link,object,embed,a,base,form').length`)) === 0);
    await page.shot(`/tmp/rp-html-masked-${lang}.png`);
    await page.eval(`window.scrollTo(0, 99999); 1`); await page.sleep(200);
    await page.shot(`/tmp/rp-html-masked-${lang}-bottom.png`);
  }

  // ── hostile data, through the real UI path, unmasked (the worst case) and masked ──
  console.log('\n=== hostile data ===');
  for (const masked of [false, true]) {
    await page.goto('/?lang=en'); await wipe();
    await page.click('#btn-seed-hostile'); await page.goto('/?lang=en');
    await hook(); await openView();
    ok(`[hostile] case view itself did not run anything`, (await page.eval('window.__pwned')) === undefined);
    await page.click(reportBtn); await page.sleep(300);
    if (!masked) { await page.eval(`window.confirm = () => true; 1`); await page.click(`${D} input[type=checkbox]`); await page.sleep(150); }
    ok(`[hostile ${masked ? 'masked' : 'clear'}] checkbox state as intended`, (await page.eval(`document.querySelector('${D} input[type=checkbox]').checked`)) === masked);
    await page.eval(`document.querySelectorAll('${D}-actions .shq-pivot-btn')[1].click(); 1`); await page.sleep(400);
    const html = await lastBlobText();
    ok(`[hostile ${masked ? 'masked' : 'clear'}] html built`, typeof html === 'string' && html.length > 1000);
    ok(`[hostile ${masked ? 'masked' : 'clear'}] clear mode really contains the hostile text (escaped)`, masked || html.includes('&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;'));
    // variant A: as generated; variant B: CSP meta stripped (proves the escaping alone is enough)
    for (const variant of ['with CSP', 'CSP stripped']) {
      const doc = variant === 'with CSP' ? html : html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      await page.eval(`window.__doc = ${JSON.stringify(doc)}; 1`);
      await page.eval(`location.href = URL.createObjectURL(new Blob([window.__doc], { type: 'text/html' })); 1`); await page.sleep(800);
      const tag = `[hostile ${masked ? 'masked' : 'clear'}, ${variant}]`;
      ok(`${tag} loaded`, (await page.eval('document.querySelectorAll("h2").length')) === 7);
      ok(`${tag} window.__pwned undefined`, (await page.eval('typeof window.__pwned')) === 'undefined');
      ok(`${tag} no img/script/svg/iframe/link/object/embed/a/base/form element`, (await page.eval(`document.querySelectorAll('img,script,svg,iframe,link,object,embed,a,base,form').length`)) === 0);
      ok(`${tag} no element carries an on* attribute`, (await page.eval(`[...document.querySelectorAll('*')].every(e => [...e.attributes].every(a => !/^on/i.test(a.name)))`)));
      if (!masked) ok(`${tag} hostile strings visible as TEXT`, await page.eval(`document.body.innerText.includes('<img src=x onerror="window.__pwned=1">') && document.body.innerText.includes('<script>window.__pwned=2</script>')`));
      if (variant === 'with CSP') await page.shot(`/tmp/rp-html-hostile-${masked ? 'masked' : 'clear'}.png`);
    }
    // Markdown from the same case through the stubbed clipboard
    await page.goto('/?lang=en'); await wipe();
    await page.click('#btn-seed-hostile'); await page.goto('/?lang=en'); await openView();
    await page.click(reportBtn); await page.sleep(300);
    if (!masked) { await page.eval(`window.confirm = () => true; 1`); await page.click(`${D} input[type=checkbox]`); await page.sleep(150); }
    await page.eval(`window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (s) => { window.__clip = s; return Promise.resolve(); } } }); document.querySelectorAll('${D}-actions .shq-pivot-btn')[0].click(); 1`); await page.sleep(400);
    const md = await page.eval('window.__clip');
    const noFence = (md ?? '').replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, '');
    const raw = ['<img', '<script', '<svg', '](javascript:', '[click]', '![x]('];
    ok(`[hostile ${masked ? 'masked' : 'clear'}] markdown outside KQL fences has none of ${raw.join(' ')}`, raw.every((r) => !noFence.includes(r)), raw.filter((r) => noFence.includes(r)).join(','));
  }

  // Negative control: the same detection MUST fire on a deliberately unsafe document, or the checks above prove nothing.
  await page.goto('/?lang=en');
  await page.eval(`location.href = URL.createObjectURL(new Blob(['<!doctype html><body><img src=x onerror="window.__pwned=1"></body>'], { type: 'text/html' })); 1`); await page.sleep(800);
  ok('[control] an unsafe document IS detected (img element present, __pwned set)',
    (await page.eval(`document.querySelectorAll('img').length`)) === 1 && (await page.eval('window.__pwned')) === 1);

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL SCENARIO CHECKS PASSED');
  if (fails.length) throw new Error(`${fails.length} scenario check(s) failed`);
};
