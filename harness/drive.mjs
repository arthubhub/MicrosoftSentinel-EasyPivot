// Headless-Chromium driver for the rendering harness (no Playwright needed).
//
//   npm run harness && node harness/drive.mjs <scenario.mjs>
//
// A scenario default-exports `async ({ page, log }) => {...}`. `page` has:
//   goto(url), eval(expr), click(selector), rightClick(selector), shot(path),
//   sleep(ms), text(selector), exists(selector), errors() (uncaught + console.error)
// Needs a chrome-headless-shell binary (Playwright's cache is searched) and
// serves harness/ on a local port itself, because module scripts do not load
// from file://. This proves "the panel renders and the code paths run" - it is
// NOT the real Sentinel/Defender DOM (see harness/harness.ts).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) throw new Error('no chrome: set CHROME_BIN');
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse();
  for (const d of dirs) {
    const sub = readdirSync(join(root, d)).find((s) => s.startsWith('chrome-headless-shell'));
    const bin = sub && join(root, d, sub, 'chrome-headless-shell');
    if (bin && existsSync(bin)) return bin;
  }
  throw new Error('no chrome-headless-shell found: set CHROME_BIN');
}

const server = createServer((req, res) => {
  const path = join(HERE, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!path.startsWith(HERE) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const PORT = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1400,1000', '--user-data-dir=/tmp/ep-chrome-' + PORT, 'about:blank'], { stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('chrome did not start');
}

const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const problems = [];
const logs = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') problems.push('UNCAUGHT: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
  if (d.method === 'Runtime.consoleAPICalled') {
    const text = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${d.params.type}] ${text}`);
    if (d.params.type === 'error') problems.push('console.error: ' + text);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable'); await send('Page.enable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval failed: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
const mouse = async (selector, button) => {
  const box = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (!box) throw new Error('no element: ' + selector);
  const b = { x: box.x, y: box.y, button, clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b });
  await sleep(250);
};

const page = {
  goto: async (path) => { await send('Page.navigate', { url: base + path }); await sleep(1500); },
  eval: evalJs,
  click: (s) => mouse(s, 'left'),
  rightClick: (s) => mouse(s, 'right'),
  sleep,
  text: (s) => evalJs(`document.querySelector(${JSON.stringify(s)})?.innerText ?? null`),
  exists: (s) => evalJs(`!!document.querySelector(${JSON.stringify(s)})`),
  errors: () => [...problems],
  logs: () => [...logs],
  shot: async (path) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  },
};

let code = 0;
try {
  const scenario = (await import(pathToFileURL(process.argv[2]).href)).default;
  await scenario({ page, log: console.log });
} catch (e) { console.error('SCENARIO FAILED:', e.message); code = 1; }
console.log(problems.length ? `\n${problems.length} problem(s):\n  ` + problems.join('\n  ') : '\nno uncaught errors, no console.error');
if (problems.length) code = 1;
ws.close(); chrome.kill(); server.close();
process.exit(code);
