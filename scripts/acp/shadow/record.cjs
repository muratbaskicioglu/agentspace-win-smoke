'use strict';
// ACP-FAZ1-GOLGE-01 (AS-4584) — GÖLGE KAYDEDİCİ: 10 senaryoyu iki yoldan sürer, ham olayları kaydeder.
//
//   ekran kolu  : resmî Claude Code (etkileşimli TUI) node-pty içinde; istem köşeli yapıştırma + Enter
//                 (bugünkü deliverPrompt'un yazım biçimi), izin/soru menüsüne Enter, iptalde Esc.
//   acp kolu    : claude-agent-acp + aynı resmî Claude Code (CLAUDE_CODE_EXECUTABLE); istem session/prompt,
//                 izin/soru cevabı JSON-RPC, iptal session/cancel.
//   iki kol da  : aynı sahte model (oracle), aynı kancalar (--settings / _meta.claudeCode.options.settings),
//                 aynı 2,5 sn "insan" gecikmesi, aynı yalıtılmış HOME.
//
// Bu dosya UYGULAMA KODU İÇERMEZ (public Windows test reposunda da koşar). Kararlar burada VERİLMEZ:
// `decide.cjs` kaydı ürünün kendi okuyucularından (ekran) ve çeviricisinden (ACP) geçirir.
// `--acp-client gate` (yalnız geliştirme makinesi) ACP kolunu ürünün acpGate'iyle sürer ve kapının
// canlı kararını da kaydeder (yeniden oynatma == canlı kontrolü).
//
// Kullanım:
//   node record.cjs --out <dir> --claude-exe <claude> --adapter-prefix <dir> --pty <node-pty dizini>
//                   [--arms screen,acp] [--only S01,S03] [--acp-client plain|gate --gate <acpGate.cjs>]
//
// GİZLİLİK: kayıtta yalnız yapay senaryo metni, yalıtılmış geçici klasör (maskeli) ve ms var.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createFakeModel } = require('./fakeModel.cjs');
const { SCENARIOS } = require('./scenarios.cjs');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', path.join(__dirname, 'out')));
const CLAUDE = opt('claude-exe');
const PREFIX = opt('adapter-prefix');
const PTY = opt('pty');
const ARMS = opt('arms', 'screen,acp').split(',');
const ONLY = opt('only') ? opt('only').split(',') : null;
const ACP_CLIENT = opt('acp-client', 'plain');
const GATE = opt('gate');
const HUMAN_MS = Number(opt('human-ms', '2500'));
const COLS = 120; const ROWS = 40;
const KEY = 'sk-ant-shadow-fake-not-real-0000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CLAUDE || !fs.existsSync(CLAUDE)) throw new Error('--claude-exe gerekli (resmî Claude Code)');
fs.mkdirSync(OUT, { recursive: true });

function claudeVersion() { try { return cp.execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...cleanEnv(), HOME: os.tmpdir() } }).trim(); } catch (e) { return `?(${String(e.message).slice(0, 60)})`; } }
function adapterVersion() { try { return JSON.parse(fs.readFileSync(path.join(PREFIX, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'), 'utf8')).version; } catch { return null; } }

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE|CLAUDECODE|CODEX|OPENAI|OPENCODE|AGENTSPACE)/i.test(k)) delete env[k];
  return env;
}

/** Bir koşum (senaryo × kol): yalıtılmış HOME, kanca dosyası, kayıt. */
function makeRun(sc, arm) {
  const T0 = Date.now();
  // .native: Windows koşucusunda TEMP 8.3 kısa adla gelir (RUNNER~1); claude uzun adı kullanır.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sg-${sc.id}-${arm}-`)));
  const HOME = path.join(base, 'home');
  const WS = path.join(base, 'ws');
  const CFG = path.join(HOME, '.claude');
  fs.mkdirSync(CFG, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'notlar.txt'), 'gölge kıyas\n');
  const hookLog = path.join(base, 'hooks.jsonl');
  const node = process.execPath.replace(/\\/g, '/');
  const hookRec = path.join(__dirname, 'hookRec.cjs').replace(/\\/g, '/');
  const hook = (ev) => [{ hooks: [{ type: 'command', command: `"${node}" "${hookRec}" ${ev}` }] }];
  const settingsPath = path.join(base, 'shadow-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ skipDangerousModePermissionPrompt: true, hooks: { UserPromptSubmit: hook('UserPromptSubmit'), Stop: hook('Stop'), Notification: hook('Notification') } }, null, 2));
  const cfg = {
    hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.316', theme: 'dark', autoUpdates: false, numStartups: 5,
    bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: {},
  };
  // Klasör güveni: claude projeleri yol anahtarıyla tutar; Windows'ta biçim (\\ ya da /, sürücü harfi
  // büyük/küçük) sürüme göre değişir. Eşleşmezse "Is this a project you trust?" çıkar ve imleç
  // "No, exit" üstündedir — ekran kolu hiç başlamaz. Bütün biçimleri yaz.
  const trust = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] };
  const keys = new Set([WS, WS.replace(/\\/g, '/')]);
  for (const k of [...keys]) if (/^[A-Za-z]:/.test(k)) { keys.add(k[0].toLowerCase() + k.slice(1)); keys.add(k[0].toUpperCase() + k.slice(1)); }
  for (const k of keys) cfg.projects[k] = trust;
  for (const f of [path.join(HOME, '.claude.json'), path.join(CFG, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(cfg));
  const masks = [[base, '<RUN>'], [os.homedir(), '<HOME>']];
  if (process.platform === 'win32') masks.push([base.replace(/\\/g, '/'), '<RUN>'], [base.replace(/\\/g, '\\\\'), '<RUN>']);
  const mask = (s) => { let x = String(s); for (const [a, b] of masks) x = x.split(a).join(b); return x; };
  const rows = [];
  const rec = (o) => rows.push({ t: Date.now() - T0, ...o });
  const env = (port) => {
    const e = cleanEnv();
    Object.assign(e, {
      HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: CFG, TERM: 'xterm-256color',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: KEY,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_RETRIES: '0', SHADOW_HOOK_LOG: hookLog,
    });
    if (process.platform === 'win32') {
      e.APPDATA = path.join(HOME, 'AppData', 'Roaming'); e.LOCALAPPDATA = path.join(HOME, 'AppData', 'Local');
      fs.mkdirSync(e.APPDATA, { recursive: true }); fs.mkdirSync(e.LOCALAPPDATA, { recursive: true });
    }
    return e;
  };
  // Kanca + transcript yoklayıcı (ekran kolunun limit/teslim kaynakları; ACP kolunda bilgi amaçlı).
  const offsets = new Map();
  let hookOff = 0;
  const poll = () => {
    try {
      const s = fs.readFileSync(hookLog, 'utf8');
      if (s.length > hookOff) { for (const l of s.slice(hookOff).split('\n').filter(Boolean)) { const h = JSON.parse(l); rec({ k: 'hook', ev: h.ev, at: h.at - T0 }); } hookOff = s.length; }
    } catch { /* henüz yok */ }
    const pdir = path.join(CFG, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(pdir); } catch { return; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(pdir, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const p = path.join(pdir, d, f);
        let buf;
        try { buf = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const off = offsets.get(p) || 0;
        if (buf.length > off) { const nl = buf.lastIndexOf('\n'); if (nl + 1 > off) { rec({ k: 'transcript', f, d: mask(buf.slice(off, nl + 1)) }); offsets.set(p, nl + 1); } }
      }
    }
  };
  const poller = setInterval(poll, 200);
  const done = (meta) => {
    clearInterval(poller);
    poll();
    const file = path.join(OUT, `${sc.id}-${arm}.jsonl`);
    const head = { k: 'meta', scenario: sc.id, name: sc.name, arm, mode: modeOf(sc), acpClient: arm === 'acp' ? ACP_CLIENT : null, platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cols: COLS, rows: ROWS, humanMs: HUMAN_MS, ...meta };
    fs.writeFileSync(file, [head, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows kilidi */ }
    return file;
  };
  return { T0, HOME, WS, CFG, settingsPath, rec, mask, env, done };
}

/** Model olaylarını bekleme yardımcısı. */
function modelWaiter() {
  const evs = [];
  const waiters = [];
  return {
    push(e) { evs.push(e); for (const w of waiters.slice()) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); } },
    wait(pred, ms) {
      const hit = evs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => { const w = { pred, resolve }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms); });
    },
    since(n) { return evs.slice(n); },
    get length() { return evs.length; },
  };
}

const modeOf = (sc) => sc.mode || 'bypass';

const isFinal = (sc, e, turn) => e.sid === sc.id && e.turn === turn && (e.ev === 'limit_sent' || (e.ev === 'resp_end' && (turn > 1 || e.step === sc.steps.length - 1)));

/** Senaryonun model tarafı ortak akışı: tur gönder → (menü) → (iptal) → bitiş + yerleşme. */
async function driveTurn(sc, turn, mw, run, io) {
  const text = sc.turns[turn - 1];
  await io.send(text);
  const req = await mw.wait((e) => e.ev === 'req' && e.sid === sc.id && e.turn === turn && e.first, 4000);
  if (!req && io.retryEnter) { run.rec({ k: 'drv', ev: 'enter_retry' }); await io.retryEnter(); await mw.wait((e) => e.ev === 'req' && e.sid === sc.id && e.turn === turn && e.first, 8000); }
  if (sc.steps[0].slow && turn === 1) {
    await mw.wait((e) => e.ev === 'resp_start' && e.sid === sc.id, 8000);
    await sleep(1500);
    run.rec({ k: 'drv', ev: 'cancel' });
    await io.cancel();
    await sleep(4000);
    return;
  }
  if (sc.steps[0].tool && turn === 1 && sc.truth.menu) {
    const tu = await mw.wait((e) => e.ev === 'tool_use' && e.sid === sc.id, 15000);
    if (tu && io.answerMenu) {
      await sleep(HUMAN_MS);
      if (!(await mw.wait((e) => e.ev === 'req' && e.sid === sc.id && e.step === 1, 1))) {
        run.rec({ k: 'drv', ev: 'menu_key' }); await io.answerMenu();
        for (let i = 0; i < 2 && !(await mw.wait((e) => e.ev === 'req' && e.sid === sc.id && e.step === 1, 3500)); i++) { run.rec({ k: 'drv', ev: 'menu_key_retry' }); await io.answerMenu(); }
      }
    }
  }
  const fin = await mw.wait((e) => isFinal(sc, e, turn), 45000);
  if (!fin) run.rec({ k: 'drv', ev: 'timeout' });
  await sleep(sc.truth.outcome === 'limit' ? 5000 : 4000);
}

// ───────────────────────── ekran kolu ─────────────────────────

async function screenArm(sc) {
  const pty = require(PTY);
  const run = makeRun(sc, 'screen');
  const mw = modelWaiter();
  const model = createFakeModel({ now: () => Date.now() - run.T0, onEvent: (e) => { run.rec(e); mw.push(e); } });
  const port = await model.start();
  const sid = crypto.randomUUID();
  let p = null; let lastData = 0; let bytes = 0;
  const spawn = (extra) => {
    const perm = modeOf(sc) === 'bypass' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'default'];
    const args = [...perm, '--settings', run.settingsPath, ...extra];
    run.rec({ k: 'drv', ev: 'spawn', args: [...perm, ...extra].map((a) => (a === sid ? '<SID>' : a)) });
    p = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: run.WS, env: run.env(port) });
    bytes = 0;
    p.onData((d) => { lastData = Date.now(); bytes += d.length; run.rec({ k: 'pty', d: run.mask(d) }); });
    p.onExit(({ exitCode, signal }) => run.rec({ k: 'drv', ev: 'exit', code: exitCode, sig: signal || null }));
  };
  const waitReady = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) { if (bytes > 0 && Date.now() - lastData > 1200 && Date.now() - t0 > 2500) break; await sleep(100); }
    run.rec({ k: 'drv', ev: 'ready_wait_done', ms: Date.now() - t0 });
  };
  const io = {
    send: async (text) => {
      run.rec({ k: 'drv', ev: 'send', n: text.length });
      p.write(`\x1b[200~${text}\x1b[201~`);
      await sleep(150);
      run.rec({ k: 'drv', ev: 'enter' });
      p.write('\r');
    },
    retryEnter: async () => { p.write('\r'); },
    answerMenu: async () => { p.write('\r'); },
    cancel: async () => { p.write('\x1b'); },
  };
  try {
    spawn(['--session-id', sid]);
    await waitReady();
    await driveTurn(sc, 1, mw, run, io);
    if (sc.resume) {
      run.rec({ k: 'drv', ev: 'kill' });
      try { p.kill(); } catch { /* */ }
      await sleep(1500);
      spawn(['--resume', sid]);
      await waitReady();
      await driveTurn(sc, 2, mw, run, io);
    }
  } finally {
    try { p.kill(); } catch { /* */ }
    await sleep(800);
    await model.close();
  }
  return run.done({ claude: claudeVersion(), port: null });
}

// ───────────────────────── ACP kolu ─────────────────────────

function plainAcp(run, env, onAgentRequest) {
  const pj = JSON.parse(fs.readFileSync(path.join(PREFIX, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'), 'utf8'));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin['claude-agent-acp'];
  const script = path.join(PREFIX, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', rel);
  run.rec({ k: 'drv', ev: 'spawn' });
  const child = cp.spawn(process.execPath, [script], { cwd: run.WS, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let buf = ''; let id = 0; const pending = new Map();
  child.stderr.on('data', () => {});
  child.on('exit', (code, sig) => { run.rec({ k: 'drv', ev: 'exit', code, sig: sig || null }); for (const [, p] of pending) p.reject(new Error('exit')); pending.clear(); });
  const write = (m) => { run.rec({ k: 'acp', dir: 'out', m: JSON.parse(run.mask(JSON.stringify(m))) }); try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* */ } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1);
      let m; try { m = JSON.parse(line); } catch { if (line.trim()) run.rec({ k: 'acp_nonjson' }); continue; }
      run.rec({ k: 'acp', dir: 'in', m: JSON.parse(run.mask(JSON.stringify(m))) });
      if (m.id != null && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.reject(Object.assign(new Error(m.error.message), { rpc: m.error })); else p.resolve(m.result); } continue; }
      if (m.id != null && m.method) {
        Promise.resolve(onAgentRequest(m.method, m.params)).then((r) => write(r === undefined ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } } : { jsonrpc: '2.0', id: m.id, result: r }));
      }
    }
  });
  return {
    request: (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); write({ jsonrpc: '2.0', id: i, method, params }); }),
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* */ } },
    exited: () => new Promise((r) => { if (child.exitCode != null || child.signalCode) r(); else child.once('exit', () => r()); }),
  };
}

const CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } };
const allowOnce = (params) => { const o = (params.options || []).find((x) => x.kind === 'allow_once') || (params.options || [])[0]; return { outcome: { outcome: 'selected', optionId: o.optionId } }; };
function answerElicitation(params) {
  const props = (params && params.requestedSchema && params.requestedSchema.properties) || {};
  const content = {};
  for (const [k, v] of Object.entries(props)) {
    const choices = v.oneOf || v.anyOf || (v.items && (v.items.oneOf || v.items.anyOf)) || (v.enum ? v.enum.map((x) => ({ const: x })) : []);
    const first = choices[0] && (choices[0].const != null ? choices[0].const : choices[0].title);
    content[k] = v.type === 'array' ? [first] : first;
  }
  return { action: 'accept', content };
}

async function acpArm(sc) {
  const run = makeRun(sc, 'acp');
  const mw = modelWaiter();
  const model = createFakeModel({ now: () => Date.now() - run.T0, onEvent: (e) => { run.rec(e); mw.push(e); } });
  const port = await model.start();
  const env = { ...run.env(port), CLAUDE_CODE_EXECUTABLE: CLAUDE };
  const human = (f) => (params) => sleep(HUMAN_MS).then(() => f(params));
  const meta = { claudeCode: { options: { settings: run.settingsPath } } };
  let gateMod = null;
  if (ACP_CLIENT === 'gate') gateMod = require(path.resolve(GATE));
  let sessionId = null;
  let cur = null; // {prompt, cancel, kill, exited}

  async function openPlain(load) {
    const c = plainAcp(run, env, (method, params) => (method === 'session/request_permission' ? human(allowOnce)(params) : method === 'elicitation/create' ? human(answerElicitation)(params) : undefined));
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: CAPS, clientInfo: { name: 'agentspace-shadow', version: '0.0.0' } });
    if (load) await c.request('session/load', { sessionId, cwd: run.WS, mcpServers: [], _meta: meta });
    else sessionId = (await c.request('session/new', { cwd: run.WS, mcpServers: [], _meta: meta })).sessionId;
    if (modeOf(sc) === 'bypass') await c.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
    return {
      prompt: (text) => c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then((r) => ({ result: r }), (e) => ({ error: e.rpc || { message: e.message } })),
      cancel: () => c.notify('session/cancel', { sessionId }),
      kill: c.kill, exited: c.exited, live: () => null,
    };
  }
  async function openGate(load) {
    let child = null;
    const spawnTap = (cmd, args, o) => {
      run.rec({ k: 'drv', ev: 'spawn' });
      child = cp.spawn(cmd, args, o);
      const origWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { for (const l of String(chunk).split('\n').filter(Boolean)) { try { run.rec({ k: 'acp', dir: 'out', m: JSON.parse(run.mask(l)) }); } catch { /* */ } } return origWrite(chunk, ...rest); };
      let b = '';
      child.stdout.on('data', (d) => { b += String(d); let n; while ((n = b.indexOf('\n')) >= 0) { const l = b.slice(0, n); b = b.slice(n + 1); try { run.rec({ k: 'acp', dir: 'in', m: JSON.parse(run.mask(l)) }); } catch { if (l.trim()) run.rec({ k: 'acp_nonjson' }); } } });
      child.on('exit', (code, sig) => run.rec({ k: 'drv', ev: 'exit', code, sig: sig || null }));
      return child;
    };
    const g = gateMod.createAcpGate({ engine: 'claude', prefix: PREFIX, cwd: run.WS, env, claudeSettings: run.settingsPath, onPermission: human(gateMod.allowOncePolicy), onQuestion: human(answerElicitation), spawn: spawnTap, permissionMode: modeOf(sc) === 'bypass' ? 'bypass' : undefined });
    if (load) await g.load(sessionId); else sessionId = (await g.open()).sessionId;
    return {
      prompt: (text) => g.prompt(text).then((r) => ({ gate: r })),
      cancel: () => g.cancel(),
      kill: () => g.kill(),
      exited: () => new Promise((r) => { if (!child || child.exitCode != null || child.signalCode) r(); else child.once('exit', () => r()); }),
      live: () => g.decisions(),
    };
  }
  const open = (load) => (ACP_CLIENT === 'gate' ? openGate(load) : openPlain(load));
  let inflight = null;
  const io = {
    send: async (text) => { run.rec({ k: 'drv', ev: 'send', n: text.length }); inflight = cur.prompt(text).then((r) => { run.rec({ k: 'drv', ev: 'prompt_settled', outcome: r.gate ? r.gate.outcome : r.error ? 'error' : r.result && r.result.stopReason }); return r; }); },
    cancel: async () => { cur.cancel(); },
    answerMenu: null, // ACP kolunda cevap onRequest içinde (aynı HUMAN_MS gecikmesiyle)
  };
  try {
    cur = await open(false);
    run.rec({ k: 'drv', ev: 'ready_wait_done', ms: 0 });
    await driveTurn(sc, 1, mw, run, io);
    if (inflight) await Promise.race([inflight, sleep(5000)]);
    const live1 = cur.live();
    if (live1) run.rec({ k: 'live', turn: 1, d: live1 });
    if (sc.resume) {
      run.rec({ k: 'drv', ev: 'kill' });
      cur.kill(); await Promise.race([cur.exited(), sleep(5000)]);
      cur = await open(true);
      run.rec({ k: 'drv', ev: 'ready_wait_done', ms: 0 });
      await driveTurn(sc, 2, mw, run, io);
      if (inflight) await Promise.race([inflight, sleep(5000)]);
      const live2 = cur.live();
      if (live2) run.rec({ k: 'live', turn: 2, d: live2 });
    }
  } finally {
    try { cur && cur.kill(); } catch { /* */ }
    await sleep(500);
    await model.close();
  }
  return run.done({ claude: claudeVersion(), adapter: adapterVersion() });
}

(async () => {
  const list = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id));
  const summary = [];
  for (const sc of list) {
    for (const arm of ARMS) {
      const t0 = Date.now();
      let file = null; let err = null;
      try { file = arm === 'screen' ? await screenArm(sc) : await acpArm(sc); } catch (e) { err = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '); }
      const line = { scenario: sc.id, arm, ms: Date.now() - t0, file: file && path.basename(file), err };
      summary.push(line);
      console.log('SHADOW', JSON.stringify(line));
    }
  }
  fs.writeFileSync(path.join(OUT, 'record-summary.json'), JSON.stringify({ platform: process.platform, release: os.release(), claude: claudeVersion(), adapter: adapterVersion(), acpClient: ACP_CLIENT, runs: summary }, null, 2));
  process.exit(summary.some((s) => s.err) ? 1 : 0);
})();
