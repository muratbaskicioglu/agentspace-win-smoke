// Starts the subscription sign-in of the engine CLIs with the INSTALLED app's own
// engineAuth module (read from its app.asar), on a throwaway home:
//   status before → start the sign-in flow → does the CLI hand over a browser address
//   (and, for the code flow, ask for the code)? → cancel → status after.
// It never completes a sign-in (no account), never types a code.
//
//   ELECTRON_RUN_AS_NODE=1 <AgentSpace binary> scripts/engineLoginProbe.cjs \
//     --app <resources/app.asar> --out <dir> [--engines claude,codex]
// Exit: 0 measured, 2 could not measure.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const A = { app: null, out: 'engine-login', engines: ['claude', 'codex'] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]; const n = process.argv[i + 1];
  if (k === '--app') { A.app = n; i++; }
  else if (k === '--out') { A.out = n; i++; }
  else if (k === '--engines') { A.engines = String(n || '').split(',').filter(Boolean); i++; }
}
if (!A.app) { console.error('--app required'); process.exit(2); }
fs.mkdirSync(A.out, { recursive: true });

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'as-engine-login-'));
process.env.AGENTDESK_HOME = path.join(BASE, 'agentdesk');
process.env.AGENTDESK_INSTANCE = 'test';
fs.mkdirSync(process.env.AGENTDESK_HOME, { recursive: true });

const engineAuth = require(path.join(A.app, 'engineAuth.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep only scheme://host/path and the NAMES of the query parameters.
function shape(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname} ?${[...u.searchParams.keys()].join('&')}`; }
  catch { return url ? '<not a url>' : null; }
}

async function one(engine) {
  const r = { engine, available: engineAuth.authEngines().some((e) => (e.engine || e.id || e) === engine) };
  try { r.statusBefore = await engineAuth.readStatus(engine, {}); } catch (e) { r.statusBefore = { error: String(e.message) }; }
  const states = [];
  let s;
  try {
    s = engineAuth.startLogin(engine, { log: (l) => states.push(String(l).slice(0, 200)), loginTimeoutMs: 90000 });
  } catch (e) { r.start = `throws: ${e.message}`; return r; }
  let snap = s.snapshot();
  for (let i = 0; i < 60; i++) {
    snap = s.snapshot();
    if (['error', 'done', 'cancelled'].includes(snap.state)) break;
    if (snap.url && (!snap.needsCode || snap.state === 'awaiting-code')) break;
    await sleep(1000);
  }
  r.flow = { state: snap.state, needsCode: snap.needsCode, url: shape(snap.url), error: snap.error, errorDetail: snap.errorDetail ? String(snap.errorDetail).slice(0, 200) : null };
  r.cancel = s.cancel();
  await sleep(1500);
  r.transitions = states;
  try { r.statusAfter = await engineAuth.readStatus(engine, {}); } catch (e) { r.statusAfter = { error: String(e.message) }; }
  return r;
}

(async () => {
  const out = { platform: process.platform, arch: process.arch, engines: [] };
  for (const e of A.engines) {
    const r = await one(e);
    out.engines.push(r);
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(A.out, 'engine-login.json'), JSON.stringify(out, null, 2));
  fs.rmSync(BASE, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
