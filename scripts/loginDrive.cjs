// Drives the sign-in screen of a running AgentSpace window through the DevTools
// protocol, the way a user does it: wait for the "Sign in" button, take a frame, click
// it with a real (trusted) mouse event, wait, take a second frame, report what the
// screen says.
//
// Run with the app's own binary in Node mode (Node 24: global fetch + WebSocket):
//   ELECTRON_RUN_AS_NODE=1 <AgentSpace binary> scripts/loginDrive.cjs \
//     --port 9333 --out <dir> --label <arm> [--wait-after 10000]
//
// No account, no secrets. It never types anything.
// Exit: 0 clicked, 2 could not measure (no window / no button).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const A = { port: 9333, out: 'login-drive', label: 'arm', waitAfter: 10000 };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]; const n = process.argv[i + 1];
  if (k === '--port') { A.port = Number(n); i++; }
  else if (k === '--out') { A.out = n; i++; }
  else if (k === '--label') { A.label = n; i++; }
  else if (k === '--wait-after') { A.waitAfter = Number(n); i++; }
}
fs.mkdirSync(A.out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${A.port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(t.url || ''));
      if (p) return p;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return null;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id; waiting.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

async function main() {
  const out = { label: A.label, steps: [] };
  const note = (step, detail) => { out.steps.push({ step, detail }); console.log(`[${A.label}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
  const done = (code) => { fs.writeFileSync(path.join(A.out, `drive-${A.label}.json`), JSON.stringify(out, null, 2)); process.exit(code); };

  const t = await pageTarget();
  if (!t) { note('target', 'no app page on the DevTools port in 90 s'); return done(2); }
  note('target', t.url.replace(/\?.*$/, ''));
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  const evalJs = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(A.out, name), Buffer.from(r.result.data, 'base64'));
  };

  // The sign-in button: the primary call to action on the gate.
  const FIND = `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /sign in|giriş yap|giris yap/i.test(x.innerText || '') && x.offsetParent);
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { text: b.innerText.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  })()`;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = await evalJs(FIND); if (!btn) await sleep(1000); }
  if (!btn) { await shot(`${A.label}-0-no-button.png`); note('button', 'no sign-in button in 60 s'); return done(2); }
  note('button', btn);

  const warn = await evalJs(`(() => { const w = document.querySelector('[data-testid="muratify-login-secret-warning"]');
    return w ? { backend: w.getAttribute('data-secret-backend'), text: w.innerText.trim() } : null; })()`);
  note('keychain-warning-before-click', warn || 'none');
  await sleep(1500);
  await shot(`${A.label}-1-before-click.png`);

  // A real mouse click (trusted input), not element.click().
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  note('click', `clicked "${btn.text}" at ${Math.round(btn.x)},${Math.round(btn.y)}`);
  await sleep(A.waitAfter);

  const after = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /sign in|giriş yap|giris yap/i.test(x.innerText || ''));
    const card = b ? (b.closest('section, main, [role="dialog"], div') || document.body) : document.body;
    let box = card; for (let i = 0; i < 4 && box.parentElement; i++) box = box.parentElement;
    const txt = (box.innerText || '').replace(/\\s+\\n/g, '\\n').trim();
    return { text: txt.slice(0, 1200), pasteVisible: !!document.querySelector('input[placeholder*="agentspace"], textarea[placeholder*="agentspace"]') };
  })()`);
  note('screen-after-click', after);
  await shot(`${A.label}-2-after-click.png`);
  // The status line under the button: is it inside the window without scrolling?
  const status = await evalJs(`(() => {
    const re = /could not start sign-in|browser opened|giriş başlatılamadı|tarayıcı açıldı/i;
    const el = [...document.querySelectorAll('p, div, span')].filter((x) => re.test(x.innerText || '') && x.children.length === 0)[0]
      || [...document.querySelectorAll('p, div, span')].filter((x) => re.test(x.innerText || '')).pop();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText.trim().slice(0, 160), top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: innerHeight, visibleWithoutScroll: r.top >= 0 && r.bottom <= innerHeight };
  })()`);
  note('note-after-click', status || 'no status line');
  if (status && !status.visibleWithoutScroll) {
    await evalJs(`(() => { const re = /could not start sign-in|browser opened/i;
      const el = [...document.querySelectorAll('p, div, span')].filter((x) => re.test(x.innerText || '')).pop(); if (el) el.scrollIntoView({ block: 'center' }); })()`);
    await sleep(800);
    await shot(`${A.label}-3-note-scrolled.png`);
  }
  c.close();
  return done(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
