// Route walk for the bundle-seal check (seal.yml).
//
// Reads the route list from the INSTALLED app's own build manifests (no app code is
// stored in this repo), attaches to the running app over the Chromium DevTools port
// (--remote-debugging-port) and, in the app's real window:
//   1. opens every page (the camera/microphone pages with JavaScript off),
//   2. requests every page again as HTML, RSC, RSC prefetch and every segment prefetch,
//      and every route handler with GET, from inside the page (same origin).
// Then it navigates back to "/". It writes a JSON summary and, with --frames, a PNG
// per page. It does not click anything, sign in or send anything anywhere.
//
// Usage: node scripts/sealNav.cjs --server <standalone/.next/server> --cdp <port> --out <file.json> [--frames <dir>]
// Needs a Node with global fetch + WebSocket (Node 22+, or the app binary with ELECTRON_RUN_AS_NODE=1).
// Exit: 0 walked · 2 could not attach / could not read the manifests
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const A = (() => {
  const a = { server: '', cdp: '', out: 'seal-nav.json', frames: '' };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = new Set(['/hand-detect', '/jarvis-widget', '/agentx-orb']); // pages that ask for camera/microphone
const EXTRA = ['/favicon.ico', '/404', '/500', '/_seal-probe-404', '/_next/static/seal-probe.js'];

function inventory(srv) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(srv, f), 'utf8'));
  const appPaths = read('app-paths-manifest.json');
  const norm = (k) => k.replace(/\/(page|route)$/, '').replace(/\/\([^)]+\)/g, '') || '/';
  const pages = []; const routes = [];
  for (const k of Object.keys(appPaths).sort()) (k.endsWith('/page') ? pages : routes).push(norm(k));
  const fill = (r) => r.replace(/\[\[?\.{0,3}([^\]]+)\]\]?/g, (_m, n) => (n === 'filename' ? 'seal-probe-missing.md' : 'x'));
  const seg = {};
  for (const p of pages) {
    const f = path.join(srv, 'app', `${p === '/' ? 'index' : p.slice(1)}.meta`);
    try { seg[p] = JSON.parse(fs.readFileSync(f, 'utf8')).segmentPaths || []; } catch { seg[p] = []; }
  }
  return { pages, routes, seg, url: Object.fromEntries([...pages, ...routes].map((r) => [r, fill(r)])) };
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const wait = new Map(); const listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
      else if (m.method) for (const l of listeners) l(m);
    };
    ws.onerror = () => reject(new Error(`websocket error ${wsUrl}`));
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; wait.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      once: (method, ms) => new Promise((res) => { const t = setTimeout(() => res(null), ms); const l = (m) => { if (m.method === method) { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); res(m); } }; listeners.push(l); }),
      close: () => ws.close(),
    });
  });
}

async function evalIn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result.value;
}

(async () => {
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') { console.error('needs Node 22+ (global WebSocket + fetch)'); process.exit(2); }
  let inv;
  try { inv = inventory(A.server); } catch (e) { console.error(`manifests not readable: ${e.message}`); process.exit(2); }
  const base = `http://127.0.0.1:${A.cdp}`;
  // The app window is the page that has the app's preload bridge (window.updateApi).
  let c = null; let pageUrl = '';
  const end = Date.now() + 120_000;
  while (!c && Date.now() < end) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      for (const t of list.filter((x) => x.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(x.url))) {
        const cc = await cdpClient(t.webSocketDebuggerUrl);
        const ok = await evalIn(cc, "typeof window.updateApi === 'object'").catch(() => false);
        if (ok) { c = cc; pageUrl = t.url; break; }
        cc.close();
      }
    } catch { /* devtools port not up yet */ }
    if (!c) await sleep(2000);
  }
  if (!c) { console.error('app window not found on the devtools port in 120 s'); process.exit(2); }
  const origin = new URL(pageUrl).origin;
  await c.send('Page.enable');
  const res = { origin: origin.replace(/:\d+$/, ':<port>'), pages: inv.pages.length, routes: inv.routes.length, visits: [], fetch: {}, fetchBad: [] };
  if (A.frames) fs.mkdirSync(A.frames, { recursive: true });

  const go = async (p, jsOff) => {
    if (jsOff) await c.send('Emulation.setScriptExecutionDisabled', { value: true });
    const loaded = c.once('Page.loadEventFired', 45_000);
    const nav = await c.send('Page.navigate', { url: origin + p }).catch((e) => ({ errorText: e.message }));
    const ev = await loaded;
    await sleep(1500);
    const body = await evalIn(c, 'document.body ? document.body.innerText.length : -1').catch(() => -2);
    if (A.frames) {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot) fs.writeFileSync(path.join(A.frames, `page${p === '/' ? '_root' : p.replace(/[^a-z0-9]+/gi, '_')}.png`), Buffer.from(shot.data, 'base64'));
    }
    if (jsOff) await c.send('Emulation.setScriptExecutionDisabled', { value: false });
    return { path: p, js: !jsOff, loaded: !!ev, error: nav.errorText || undefined, bodyLen: body };
  };
  for (const p of inv.pages) res.visits.push(await go(inv.url[p], MEDIA.has(p)));
  for (const p of ['/404', '/500', '/_seal-probe-404']) res.visits.push(await go(p, false));
  await go('/', false);

  const spec = [];
  for (const p of inv.pages) {
    const u = inv.url[p];
    spec.push({ p, k: 'html', u, h: { accept: 'text/html' } }, { p, k: 'rsc', u, h: { rsc: '1' } }, { p, k: 'rsc-prefetch', u, h: { rsc: '1', 'next-router-prefetch': '1' } });
    for (const sp of inv.seg[p]) spec.push({ p, k: 'segment', u, h: { rsc: '1', 'next-router-prefetch': '1', 'next-router-segment-prefetch': sp } });
  }
  for (const r of inv.routes) spec.push({ p: r, k: 'api-get', u: inv.url[r], h: {} });
  for (const u of EXTRA) spec.push({ p: u, k: 'extra', u, h: {} });
  const got = await evalIn(c, `(async (s) => { const out = []; for (const q of s) { try { const r = await fetch(q.u, { headers: q.h, cache: 'no-store' }); await r.arrayBuffer(); out.push({ p: q.p, k: q.k, s: r.status, ct: (r.headers.get('content-type') || '').split(';')[0] }); } catch (e) { out.push({ p: q.p, k: q.k, s: 'ERR ' + e.message }); } } return out; })(${JSON.stringify(spec)})`);
  for (const g of got) {
    const key = `${g.k} ${g.s}`; res.fetch[key] = (res.fetch[key] || 0) + 1;
    if (typeof g.s !== 'number' || g.s >= 500) res.fetchBad.push(g);
  }
  res.requests = got.length;
  c.close();
  fs.writeFileSync(A.out, JSON.stringify(res, null, 2));
  console.log(`walked ${res.visits.length} pages in the app window (${res.visits.filter((v) => !v.js).length} with JavaScript off), ${got.length} requests: ${JSON.stringify(res.fetch)}`);
  process.exit(0);
})().catch((e) => { console.error(`walk failed: ${e.stack || e}`); process.exit(2); });
