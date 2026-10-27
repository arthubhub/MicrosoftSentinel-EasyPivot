// Settings -> Cases scenario (review item 1): list scoping, archive / delete / export, global deletions (en + fr).
//   npm run harness && node harness/drive.mjs harness/scenarios/settings-cases.mjs
// Screenshots: /tmp/sc-<step>-<lang>.png.  Plain harness page: the tenant key stays `unknown`, so cases covering
// `unknown` are IN scope and the cases of another client (own key + clientId) must never be listed.
const fails = [];
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== '' ? '  [' + String(extra).slice(0, 200) + ']' : '')); if (!cond) fails.push(name); };
const BAD = /\b(settings|caseBar|case)\.[a-zA-Z]+(\.[a-zA-Z]+)?\b|undefined|\[object|NaN/;
const OTHER_KEY = 'sentinel:bbbbbbbbbbbbbbbb';
const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const SECRET_IP = '198.51.100.77';

export default async ({ page }) => {
  const P = 'ep-harness:';
  const raw = (k) => page.eval(`localStorage.getItem(${JSON.stringify(P + k)})`);
  const J = async (k) => JSON.parse((await raw(k)) ?? 'null');
  const put = (k, v) => page.eval(`(()=>{localStorage.setItem(${JSON.stringify(P + k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))}); return 1})()`);
  const storageKeys = () => page.eval(`Object.keys(localStorage).filter(k=>k.startsWith(${JSON.stringify(P)})).map(k=>k.slice(${P.length})).sort()`);
  const dumpAll = async () => JSON.stringify(await Promise.all((await storageKeys()).map(async (k) => [k, await raw(k)])));
  const wipe = () => page.eval(`(()=>{for(const k of Object.keys(localStorage)) localStorage.removeItem(k); delete window.__pwned; return 1})()`);
  const now = Date.now();
  const DAY = 86400000;
  const entry = (id, name, keys, extra = {}) => ({ id, name, tenantKeys: keys, createdAt: now - 20 * DAY, lastAccessAt: now - (extra.age ?? 0), tags: [], ...(extra.rest ?? {}) });
  const snap = (id, value) => ({ id, createdAt: now - DAY, platform: 'sentinel', value, column: 'IPAddress', t0: '', t0Raw: '', host: '', row: { IPAddress: value }, sourceQuery: '', originRuleId: '', steps: [], pinnedRows: [{ IPAddress: value }], note: 'analyst note' });
  const run = (id) => ({ id, caseId: 'x', tenantKey: 'unknown', platform: 'sentinel', kqlHash: 'h' + id, kqlPreview: '', startedAt: now, durationMs: 1, status: 'ok', rowCount: 1, columns: [], sourceTables: [], summary: { rowCount: 1, topValues: {} }, rowsSample: [[SECRET_IP]], lastAccessAt: now });

  const seed = async () => {
    await put('shq_cases', { version: 1, cases: [
      entry('c-open', 'Open case', ['unknown'], { age: 1000 }),
      entry('c-closed', 'Closed case', ['unknown'], { age: 2000, rest: { closedAt: now - 3 * DAY } }),
      entry('c-arch', 'Archived case', ['unknown'], { age: 3000, rest: { archivedAt: now - 2 * DAY } }),
      entry('c-hostile', HOSTILE, ['unknown'], { age: 4000 }),
      entry('c-other-open', 'OTHER CLIENT SECRET', [OTHER_KEY], { age: 500, rest: { clientId: 'cl-other' } }),
      entry('c-other-arch', 'OTHER CLIENT ARCHIVED', [OTHER_KEY], { age: 600, rest: { clientId: 'cl-other', archivedAt: now - DAY } }),
    ], activeByKey: { unknown: 'c-open', [OTHER_KEY]: 'c-other-open' } });
    await put('shq_case_c-open', { notes: 'n', snapshots: [snap('s1', SECRET_IP), snap('s2', '203.0.113.9')], runs: [run('r1')] });
    await put('shq_case_c-closed', { notes: '', snapshots: [snap('s3', '192.0.2.5')], runs: [] });
    await put('shq_case_c-arch', { notes: '', snapshots: [snap('s4', '192.0.2.6')], runs: [run('r2')] });
    await put('shq_case_c-hostile', { notes: '', snapshots: [], runs: [] });
    await put('shq_case_c-other-open', { notes: '', snapshots: [snap('s5', '192.0.2.7')], runs: [run('r3')] });
    await put('shq_case_c-other-arch', { notes: '', snapshots: [], runs: [run('r4')] });
    await put('shq_clients', { version: 1, clients: [{ id: 'cl-other', name: 'Other Client Ltd', defenderTids: [], sentinelWorkspaces: [], createdAt: now }] });
    await put('shq_settings', { retention: { maxBytes: 20000000, days: 30, closedDays: 7 } });
  };
  const stubs = () => page.eval(`(()=>{ window.__confirms=[]; window.__answer=true; window.confirm=(m)=>{window.__confirms.push(m); return window.__answer;};
    window.__blob=null; URL.createObjectURL=(b)=>{window.__blob=b; return 'blob:x'}; HTMLAnchorElement.prototype.click=function(){}; return 1})()`);
  const confirms = () => page.eval('window.__confirms');
  const setAnswer = (v) => page.eval(`window.__answer=${v}`);
  const rows = () => page.eval(`[...document.querySelectorAll('.shq-pivot-cases-row')].map(r=>r.innerText.replace(/\\n+/g,' | '))`);
  const rowNames = () => page.eval(`[...document.querySelectorAll('.shq-pivot-cases-name')].map(r=>r.textContent)`);
  const clickRowBtn = (name, re) => page.eval(`(()=>{ const row=[...document.querySelectorAll('.shq-pivot-cases-row')].find(r=>r.querySelector('.shq-pivot-cases-name').textContent===${JSON.stringify(name)}); const b=[...row.querySelectorAll('button')].find(b=>new RegExp(${JSON.stringify(re)}).test(b.textContent)); b.click(); return !!b })()`);
  const clickBtn = (re) => page.eval(`(()=>{ const b=[...document.querySelectorAll('.shq-pivot-settings button')].find(b=>new RegExp(${JSON.stringify(re)}).test(b.textContent)); if(!b||b.disabled) return false; b.click(); return true })()`);
  const btnText = (re) => page.eval(`(()=>{ const b=[...document.querySelectorAll('.shq-pivot-settings button')].find(b=>new RegExp(${JSON.stringify(re)}).test(b.textContent)); return b ? b.textContent + (b.disabled ? ' [disabled]' : '') : null })()`);
  const scrollToCases = () => page.eval(`(()=>{ const e=document.querySelector('.shq-pivot-cases-row') ?? [...document.querySelectorAll('.shq-pivot-settings button')].find(b=>/Delete ALL|Supprimer TOUS/.test(b.textContent)); e.scrollIntoView({block:'center'}); return 1 })()`);
  const settingsText = async () => (await page.text('.shq-pivot-settings')) ?? '';
  const ids = async () => ((await J('shq_cases'))?.cases ?? []).map((c) => c.id).sort();
  const bar = async () => (await page.text('.shq-pivot-case-bar')) ?? '';
  const openSettings = async (lang) => {
    await page.goto(`/?lang=${lang}`);
    await page.click('.shq-btn'); await page.sleep(700);
    await page.click('.shq-pivot-settings-btn'); await page.sleep(600);
    await stubs();
  };
  const fresh = async (lang) => { await page.goto(`/?lang=${lang}`); await wipe(); await seed(); await openSettings(lang); };

  for (const lang of ['en', 'fr']) {
    const L = `[${lang}]`;
    const R = lang === 'en'
      ? { archive: '^Archive$', del: '^Delete$', exp: 'Export \\(masked\\)', delArch: 'Delete all archived', delAll: 'Delete ALL', open: /^Open case Open|Open · created/, closed: /Closed on/, archived: /Archived on/, irrev: /cannot be undone/i, oldHist: /pre-case history/i, kept: /client registry and settings are kept/i, keptConfirm: /client registry and your settings/i, size: /KB/ }
      : { archive: '^Archiver$', del: '^Supprimer$', exp: 'Exporter \\(masqué\\)', delArch: 'Supprimer tous les cas archivés', delAll: 'Supprimer TOUS', open: /Ouvert · créé/, closed: /Clôturé le/, archived: /Archivé le/, irrev: /irréversible/i, oldHist: /d'avant les cas/i, kept: /référentiel clients et les paramètres sont conservés/i, keptConfirm: /référentiel clients et vos paramètres/i, size: /Ko/ };

    console.log(`\n=== ${lang}: list + scoping ===`);
    await fresh(lang);
    const names = await rowNames();
    console.log('     listed: ' + JSON.stringify(names));
    ok(`${L} lists the 4 in-scope cases (open, closed, archived, hostile) and nothing else`, names.length === 4 && ['Open case', 'Closed case', 'Archived case', HOSTILE].every((n) => names.includes(n)), JSON.stringify(names));
    ok(`${L} another client's case names are NOT displayed anywhere in the panel`, !/OTHER CLIENT/.test((await page.text('.shq-pivot')) ?? ''));
    const rs = await rows();
    const rowOf = (n) => rs.find((r) => r.startsWith(n)) ?? '';
    ok(`${L} open row: open status, 2 events, 1 query, a size`, R.open.test(rowOf('Open case')) && /2 [^|]*1 [^|]*/.test(rowOf('Open case')) && R.size.test(rowOf('Open case')), rowOf('Open case'));
    ok(`${L} closed row shows the closed status with a date`, R.closed.test(rowOf('Closed case')), rowOf('Closed case'));
    ok(`${L} archived row shows the archived status with a date`, R.archived.test(rowOf('Archived case')), rowOf('Archived case'));
    const btns = await page.eval(`[...document.querySelectorAll('.shq-pivot-cases-row')].map(r=>[r.querySelector('.shq-pivot-cases-name').textContent, [...r.querySelectorAll('button')].map(b=>b.textContent)])`);
    ok(`${L} each row has Export + Delete; Archive only on non-archived rows`, btns.every(([n, b]) => b.length === (n === 'Archived case' ? 2 : 3)), JSON.stringify(btns));
    ok(`${L} hostile name rendered as text: no <img> in the panel, window.__pwned undefined`, (await page.eval(`document.querySelectorAll('.shq-pivot img').length`)) === 0 && (await page.eval('typeof window.__pwned')) === 'undefined');
    ok(`${L} global archived button shows a COUNT only (2 archived over all clients)`, /\(2\)/.test((await btnText(R.delArch)) ?? ''), await btnText(R.delArch));
    ok(`${L} no raw i18n key / undefined in settings text`, !BAD.test(await settingsText()), (await settingsText()).match(BAD)?.[0]);
    await scrollToCases(); await page.sleep(200);
    await page.shot(`/tmp/sc-1-list-${lang}.png`);

    console.log(`\n=== ${lang}: cancel changes nothing ===`);
    const before = await dumpAll();
    await setAnswer(false);
    await clickRowBtn('Closed case', R.del); await page.sleep(200);
    await clickBtn(R.delArch); await page.sleep(200);
    await clickBtn(R.delAll); await page.sleep(200);
    const cf = await confirms();
    ok(`${L} the 3 confirms were shown; the case one names the case, its counts and says irreversible`, cf.length === 3 && cf[0].includes('Closed case') && /\b1\b/.test(cf[0]) && R.irrev.test(cf[0]), cf[0]);
    ok(`${L} delete-all confirm states the counts of EVERY client (6 cases, 4 runs in this seed) and what is kept`, /\b6\b/.test(cf[2]) && /\b4\b/.test(cf[2]) && R.keptConfirm.test(cf[2]), cf[2]);
    ok(`${L} cancel on all 3 confirms: the whole storage is byte-identical`, (await dumpAll()) === before);

    console.log(`\n=== ${lang}: archive the active case ===`);
    ok(`${L} precondition: c-open is the remembered active case`, (await J('shq_cases')).activeByKey.unknown === 'c-open');
    const closedBody = await raw('shq_case_c-closed');
    await clickRowBtn('Open case', R.archive); await page.sleep(900);
    const idx1 = await J('shq_cases');
    ok(`${L} c-open now archived`, idx1.cases.find((c) => c.id === 'c-open').archivedAt !== undefined);
    ok(`${L} case bar re-resolved: active pointer no longer c-open`, idx1.activeByKey.unknown !== 'c-open', JSON.stringify(idx1.activeByKey));
    ok(`${L} archived case still listed (stays deletable), other bodies untouched`, (await rowNames()).includes('Open case') && (await raw('shq_case_c-closed')) === closedBody);

    console.log(`\n=== ${lang}: export masked ===`);
    await clickRowBtn('Open case', R.exp); await page.sleep(400);
    const blobText = await page.eval('window.__blob ? window.__blob.text() : null');
    ok(`${L} export produced an easypivot-case file, masked, without the raw IP`, !!blobText && /"format": "easypivot-case"/.test(blobText) && !blobText.includes(SECRET_IP), (blobText ?? 'null').slice(0, 80));
    ok(`${L} export did not touch storage (case still there)`, (await ids()).includes('c-open'));

    console.log(`\n=== ${lang}: delete the (new) active case, accept ===`);
    const activeId = (await J('shq_cases')).activeByKey.unknown;
    const activeName = (await J('shq_cases')).cases.find((c) => c.id === activeId)?.name;
    await setAnswer(true);
    await clickRowBtn(activeName, R.del); await page.sleep(900);
    const idx2 = await J('shq_cases');
    ok(`${L} active case (${activeId}) deleted: index entry and body key gone`, !idx2.cases.some((c) => c.id === activeId) && !(await storageKeys()).includes('shq_case_' + activeId));
    ok(`${L} no activeByKey pointer to it; case bar re-resolved without it`, !Object.values(idx2.activeByKey).includes(activeId) && !(await bar()).includes(activeName), await bar());
    ok(`${L} row gone from the list; other bodies identical`, !(await rowNames()).includes(activeName) && (await raw('shq_case_c-closed')) === closedBody);
    ok(`${L} case bar text has no raw key / undefined`, !BAD.test(await bar()), await bar());

    console.log(`\n=== ${lang}: delete all archived (count only) ===`);
    const before3 = await ids();
    ok(`${L} button count = archived cases of ALL clients (c-open + c-arch + c-other-arch = 3)`, /\(3\)/.test((await btnText(R.delArch)) ?? ''), await btnText(R.delArch));
    await clickBtn(R.delArch); await page.sleep(500);
    const cf3 = (await confirms()).at(-1);
    ok(`${L} confirm states the count (3), never a case name`, /\b3\b/.test(cf3) && !/OTHER|Archived case|Open case/.test(cf3), cf3);
    const after3 = await ids();
    ok(`${L} exactly the 3 archived cases gone; the other client's OPEN case and in-scope open/closed remain`, before3.length - after3.length === 3 && after3.includes('c-other-open') && after3.includes('c-closed') && !after3.includes('c-arch') && !after3.includes('c-other-arch') && !after3.includes('c-open'), JSON.stringify([before3, after3]));
    ok(`${L} archived bodies deleted too (no trace of their seeded run sample ids)`, !(await storageKeys()).some((k) => /shq_case_c-(arch|other-arch|open)$/.test(k)));
    await scrollToCases(); await page.sleep(200);
    await page.shot(`/tmp/sc-2-after-archived-${lang}.png`);

    console.log(`\n=== ${lang}: delete ALL cases and capture data ===`);
    const legacy = snap('old1', 'legacy-value'); delete legacy.note;
    await put('shq_pivot_snapshots', [legacy]);
    await put('shq_runs_unknown', [run('buf1'), run('buf2')]);
    await put('shq_runs_index', ['unknown']);
    await page.click('.shq-pivot-settings-btn'); await page.sleep(150); await page.click('.shq-pivot-settings-btn'); await page.sleep(500); // repaint settings
    const prot = {}; for (const k of ['shq_clients', 'shq_pivot_snapshots', 'shq_settings']) prot[k] = await raw(k);
    await setAnswer(true);
    await clickBtn(R.delAll); await page.sleep(700);
    const cf4 = (await confirms()).at(-1);
    ok(`${L} confirm states 2 cases (c-closed, c-other-open) and 3 runs (1 in a case + 2 in the tenant buffer), keeps clients/settings, and warns the old history stays`, /\b2\b/.test(cf4) && /\b3\b/.test(cf4) && R.keptConfirm.test(cf4) && R.oldHist.test(cf4), cf4);
    const keysAfter = await storageKeys();
    const dumpAllAfter = await dumpAll();
    ok(`${L} no shq_case_* / shq_runs_* key left, index empty`, !keysAfter.some((k) => k.startsWith('shq_case_') || k.startsWith('shq_runs_')) && (await ids()).length === 0 && Object.keys((await J('shq_cases')).activeByKey).length === 0, keysAfter.join());
    ok(`${L} shq_clients, shq_settings, legacy shq_pivot_snapshots byte-identical`, (await raw('shq_clients')) === prot.shq_clients && (await raw('shq_pivot_snapshots')) === prot.shq_pivot_snapshots && (await raw('shq_settings')) === prot.shq_settings);
    ok(`${L} no seeded customer value left anywhere in storage (run samples, snapshot rows, tenant buffer)`, !['198.51.100.77', '203.0.113.9', '192.0.2.', 'buf1', 'analyst note'].some((v) => dumpAllAfter.includes(v)), dumpAllAfter.slice(0, 100));
    const resultText = await settingsText();
    ok(`${L} result line says what was deleted, that clients/settings are kept AND that the old history remains (Migration section)`, R.kept.test(resultText) && R.oldHist.test(resultText), resultText.slice(resultText.indexOf(lang === 'en' ? 'Deleted' : 'cas et') - 5, resultText.indexOf(lang === 'en' ? 'Deleted' : 'cas et') + 250));
    ok(`${L} list is empty with the empty-state text; the delete-all button is disabled`, (await rowNames()).length === 0 && /disabled/.test((await btnText(R.delAll)) ?? ''), await btnText(R.delAll));
    ok(`${L} no raw i18n key / undefined; hostile marker never fired`, !BAD.test(await settingsText()) && (await page.eval('typeof window.__pwned')) === 'undefined');
    ok(`${L} client registry still lists the client`, /Other Client Ltd/.test(await settingsText()));
    await scrollToCases(); await page.sleep(200);
    await page.shot(`/tmp/sc-3-after-all-${lang}.png`);
  }

  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(' | ')}` : '\nALL SETTINGS-CASES CHECKS PASSED');
  if (fails.length) throw new Error(`${fails.length} scenario check(s) failed`);
};
