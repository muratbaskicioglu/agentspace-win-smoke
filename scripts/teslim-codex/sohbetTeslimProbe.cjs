#!/usr/bin/env node
'use strict';
// SOHBET-TESLIM-WIN10-01 — takım sohbeti mesajı motora BAYT BAYT ne olarak varıyor?
// Yazıcı = ürünün kendisi: officeRoomProtocol.buildPrompt + deliverPrompt({bracketed:'always',a4:true})
// + winConsoleInput.wrapWrite. Kol: yerleşik ConPTY (müşterinin prod yolu) / node-pty conpty.dll (dev yolu).
// Motor: sahte TUI (ham stdin defteri) + gerçek Codex / Claude / OpenCode (SAHTE anahtar, izole ev).
// Oracle: motorun KENDİ defteri (rollout, transcript, yerel yakalayıcıya giden istek gövdesi).
// Ekran yok, gerçek profil yok; sıralı tek pane (yük yok). Çıktı: 'WINTEST st01 {...}' satırları.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EL = process.env.ST01_APP || path.join(ROOT, 'electron');
const app = (rel) => require(path.join(EL, rel));
const pty = app('node_modules/node-pty');
const paneScreen = app('paneScreen.cjs');
const { deliverPrompt } = app('deliverPrompt.cjs');
const proto = app('officeRoomProtocol.cjs');
const agentRunner = app('agentRunner.js');
const engineInstall = app('engineInstall.cjs');
const treeKill = app('platform/ptyTreeKill.cjs');
let winInput = null;
try { winInput = app('platform/winConsoleInput.cjs'); } catch { /* 0.4.8/0.4.9'da yok */ }

const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ETIKET = process.env.ST01_ETIKET || null;
// TESLIM-CODEX-ENTER-01: ST01_FORM=yeni → ürünün oda biçimi (ham ilk satır + yapıştırılmış kurallar).
// ST01_IZ=1 → kutunun zaman çizelgesi; mesaj motora varmadıysa ST01_GEC_ENTER=1 durgun kutuya elle Enter dener.
const FORM = process.env.ST01_FORM || 'eski';
const IZ = process.env.ST01_IZ === '1';
const GEC_ENTER = process.env.ST01_GEC_ENTER === '1';
const say = (o) => console.log('WINTEST st01 ' + JSON.stringify(ETIKET ? { etiket: ETIKET, tekrar_no: Number(process.env.ST01_REP) || 0, ...o } : o));
const FAKE_ANTHROPIC = 'sk-ant-api03-probe-not-a-real-key-000000000000000000000000';
const COLS = 120; const ROWS = 32;

const ARMS = (process.env.ST01_ARMS || 'yerlesik,dll').split(',').filter(Boolean);
const ENGINES = (process.env.ST01_ENGINES || 'fake,codex,claude,opencode').split(',').filter(Boolean);
const ONLY = (process.env.ST01_CASES || '').split(',').filter(Boolean);
const BIN = { codex: process.env.ST01_CODEX_DIR, claude: process.env.ST01_CLAUDE_DIR, opencode: process.env.ST01_OPENCODE_DIR };

const TR = 'Şu işi bugün çözelim: müşterinin ödeme ekranındaki güncelleme çalışmıyor, ığüşöç İĞÜŞÖÇ harfleri doğru görünsün ve sonuçları bana yaz. ';
const CASES = {
  kisa: { body: 'Merhaba, durum nedir?' },
  turkce: { body: 'Çok güzel, şöyle yapalım: İĞÜŞÖÇ ığüşöç tamam mı?' },
  uzun300: { body: TR.repeat(3).trim() },
  uzun5k: { body: TR.repeat(36).trim() },
  coksatir: { body: 'Birinci satır: ödeme\nİkinci satır: güncelleme\nÜçüncü satır: tamam' },
  onay: { body: 'Evet, onayladım', answering: 'Bu değişikliği yayına alalım mı?' },
  // Geçici çözüm ölçümü: müşteri sohbet yerine terminale ELLE yazsa metin sağlam mı?
  emoji: { body: 'Harika 🚀 tamam ✓ — devam → bitti…' },
  // Bitiş okuması (AS-3908): sahte model `DONE:st1` der, ürünün okuyucusu motorun ham çizimini okur.
  bitis: { body: 'bitis sinavi', klavye: true, yanit: 'DONE:st1' },
  // Gerçek iş: önce metin, son satırda işaret.
  bitisuzun: { body: 'bitis sinavi uzun', klavye: true, yanit: 'Is tamam, rapor yazildi.\n\nDegisen dosya: a.txt\nKalan is yok.\n\nDONE:st1' },
  klavye: { body: `Çok güzel, şöyle yapalım: İĞÜŞÖÇ ığüşöç ödeme güncelleme — tamam mı? ${TR}`, klavye: true },
};
const TEAM = [{ id: 'lider', name: 'Lider', role: 'lead', engine: 'codex' }, { id: 'a', name: 'Ayşe', role: 'Frontend', engine: 'codex' }];
const MARKS = '·—⛔…“”‘’→✓€🚀';

function promptFor(caseId, mark) {
  if (CASES[caseId].klavye) return CASES[caseId].body.trim();
  const c = CASES[caseId];
  const p = proto.buildPrompt({ body: c.body, answering: c.answering, selfLeader: true, bossLabel: 'Patron', team: TEAM, lang: 'tr',
    ...(FORM === 'yeni' ? { split: true, keepLines: !IS_WIN } : {}) });
  return `${p} ${proto.tagText(`${caseId}${mark}`.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase())}`;
}
const norm = (s) => String(s || '').replace(/\r\n?/g, '\n').trim();
// Claude yapıştırmayı `<pasted_content id="x">\n…\n</pasted_content id="x">` ile sarar (Mac'te de böyle).
// Sarma motorun kendi işaretidir, kayıp sayılmaz; karşılaştırma İÇERİK üzerinde yapılır, `sarma` satırda kalır.
const PASTE_WRAP = /^<pasted_content id="([^"]+)">\n([\s\S]*)\n<\/pasted_content id="\1">$/;
function compare(sentRaw, msgs) {
  const sent = norm(sentRaw);
  let sarma = 0;
  const got = msgs.map(norm).map((g) => { const m = PASTE_WRAP.exec(g); if (m) sarma += 1; return m ? m[2] : g; });
  const all = got.join('\n');
  const one = got.length === 1 ? got[0] : all;
  let at = 0; while (at < one.length && one[at] === sent[at]) at++;
  const noMarks = (s) => [...s].filter((ch) => !MARKS.includes(ch)).join('').replace(/\s+/g, ' ').trim();
  return {
    tam_ayni: got.length === 1 && got[0] === sent,
    sarma,
    mesaj_sayisi: got.length,
    gonderilen: [...sent].length,
    varan: [...one].length,
    bas_tamam: one.startsWith(sent.slice(0, 40)),
    kuyruk_tamam: one.endsWith(sent.slice(-30)),
    isaretsiz_ayni: noMarks(one) === noMarks(sent),
    kayip_isaret: [...new Set([...sent].filter((ch) => MARKS.includes(ch) && !one.includes(ch)))].join(''),
    ilk_fark: one === sent ? null : { at, gon: sent.slice(Math.max(0, at - 25), at + 45), var: one.slice(Math.max(0, at - 25), at + 45) },
    bas: one.slice(0, 70),
    kuyruk: one.slice(-50),
  };
}

function walk(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
function jsonl(file) {
  const r = [];
  let body = ''; try { body = fs.readFileSync(file, 'utf8'); } catch { return r; }
  for (const l of body.split('\n')) { if (!l.trim()) continue; try { r.push(JSON.parse(l)); } catch { /* yarım satır */ } }
  return r;
}
// Motorun defterindeki KULLANICI mesajları, sırayla.
const ORACLE = {
  // Codex başlık üretimi için ek istek atar: motorun kendi metni, teslim değil.
  codex: (h) => h.captured.filter((t) => !/^Generate a concise, single-line task title/.test(t)),
  claude: (h) => walk(path.join(h.home, '.claude', 'projects')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => jsonl(f))
    .filter((e) => e.type === 'user' && e.message && !e.isMeta && !e.toolUseResult).map((e) => {
      const c = e.message.content;
      return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('') : '';
    }).filter(Boolean),
  opencode: (h) => h.captured.slice(),
};

// Motorların akış biçimleri: yalnız düz metin cevap.
function sseFor(url, text) {
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  if (/\/messages/.test(url)) {
    const usage = { input_tokens: 1, output_tokens: 1 };
    return [
      { type: 'message_start', message: { id: 'msg_st01', type: 'message', role: 'assistant', model: 'claude-st01', content: [], stop_reason: null, stop_sequence: null, usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(ev).join('');
  }
  if (/\/responses/.test(url)) {
    return [
      { type: 'response.created', response: { id: 'r_st01' } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm_st01', content: [{ type: 'output_text', text }] } },
      { type: 'response.completed', response: { id: 'r_st01', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ].map(ev).join('');
  }
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
}

function capture() {
  const got = [];
  const state = { yanit: null };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const list = Array.isArray(j.messages) ? j.messages : Array.isArray(j.input) ? j.input : [];
        const ms = list.filter((m) => m && m.role === 'user');
        const last = ms[ms.length - 1];
        if (last) {
          const c = last.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : '';
          if (t && got[got.length - 1] !== t) got.push(t);
        }
      } catch { /* gövde değil */ }
      if (!state.yanit) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"st01 probe","type":"invalid_request_error"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseFor(req.url, state.yanit));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ got, port: srv.address().port, stop: () => srv.close(), set yanit(v) { state.yanit = v; } })));
}

function homeFor(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `st01-${tag}-`));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  return { home, work };
}
function envFor(home, binDir, extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^(GITHUB_|ACTIONS_|RUNNER_)/.test(k)) delete env[k];
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  env.PATH = `${binDir}${path.delimiter}${env.PATH || env.Path || ''}`;
  if (IS_WIN) { env.Path = env.PATH; env.USERPROFILE = home; } else env.HOME = home;
  env.AGENTDESK_HOME = path.join(home, '.agentdesk');
  return { ...env, ...extra };
}
function withAppHome(home, fn) {
  const keys = { USERPROFILE: home, HOME: home, AGENTDESK_HOME: path.join(home, '.agentdesk') };
  const saved = Object.keys(keys).map((k) => [k, process.env[k]]);
  Object.assign(process.env, keys);
  try { return fn(); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// `urun`: kipi ürünün kendi hükmü seçer (o sürümün conptyOption'ı, gerçek işletim sistemi, prod kanalı).
function armOptions(armId, engine) {
  if (armId === 'dll') return { useConptyDll: true };
  if (armId !== 'urun') return {};
  const v = app('platform/conptyOption.cjs').conptyDllVerdict({ channel: process.env.ST01_CHANNEL || 'prod', engine });
  if (!armOptions.said) { armOptions.said = true; say({ asama: 'hukum', motor: engine, neden: v.reason, secenek: v.options }); }
  return v.options;
}
function spawnPane(file, argv, cwd, env, armId, engine) {
  const c = pty.spawn(file, argv, {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env,
    ...(IS_WIN ? { useConpty: true, ...armOptions(armId, engine) } : {}),
  });
  const screen = paneScreen.createPaneScreen({ cols: COLS, rows: ROWS, scrollback: 500 });
  const s = { c, screen, exit: null, startedAt: Date.now(), raw2004: false, parca: [] };
  c.onData((d) => { s.parca.push(d); if (d.includes('\x1b[?2004h')) s.raw2004 = true; try { screen.write(d); } catch { /* */ } });
  c.onExit((e) => { s.exit = e.exitCode; });
  return s;
}
function killPane(s) {
  try { treeKill.killPaneTreesSync([s.c]); } catch { /* */ }
  try { s.c.kill(); } catch { /* */ }
  try { s.screen.dispose(); } catch { /* */ }
}
const live = (s) => s.screen.liveLines().join('\n');
const composer = (s) => s.screen.composerLines().join('\n');
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return !!fn();
}
async function quiet(s, busyRe, ms, needMs) {
  let since = 0;
  return waitFor(() => {
    if (s.exit !== null) return true;
    if (busyRe.test(s.screen.liveLines().slice(-10).join('\n'))) { since = 0; return false; }
    if (!since) since = Date.now();
    return Date.now() - since > needMs;
  }, ms, 400);
}

// Elle yazma: tuş başına bir yazım, sonda Enter. Ürünün tuş yolu da aynı pencere yazıcısından geçer.
async function typeLikeHuman(s, engine, text) {
  const wrapped = { write: (d) => s.c.write(d) };
  if (winInput) winInput.wrapWrite(wrapped, { engine, platform: process.platform });
  for (const ch of text) { wrapped.write(ch); await sleep(12); }
  await sleep(600);
  wrapped.write('\r');
  return { makbuz: 'elle', sebep: 'klavye' };
}
async function deliver(s, engine, text) {
  const wrapped = { write: (d) => s.c.write(d) };
  if (winInput) winInput.wrapWrite(wrapped, { engine, platform: process.platform });
  // Ürünle aynı sıra (main.js spawnTui): önce wrapWrite, üstüne wrapPasteFlatten. Motor kapsamı modülün kararı.
  if (FORM === 'yeni' && winInput && winInput.wrapPasteFlatten) winInput.wrapPasteFlatten(wrapped, { engine, platform: process.platform, conptyDll: false });
  const writes = [];
  const t0 = Date.now();
  const iz = [];
  let son = null;
  const orneklem = IZ ? setInterval(() => {
    let c = ''; try { c = composer(s); } catch { return; }
    if (c === son) return;
    son = c;
    if (iz.length < 400) iz.push({ t: Date.now() - t0, n: [...c].length, kuyruk: c.split('\n').filter((l) => l.trim()).slice(-3, -2).join('').trim().slice(-48) });
  }, 40) : null;
  const io = {
    readPaneBuffer: () => composer(s),
    writePane: (_i, d) => { writes.push(d.length); if (IZ) iz.push({ t: Date.now() - t0, yaz: d === '\r' ? 'ENTER' : d.length }); wrapped.write(d); return true; },
    sleep, now: () => Date.now(), livePaneCount: () => 1,
    bracketedPasteMode: () => { try { return s.screen.term.modes.bracketedPasteMode === true; } catch { return null; } },
    log: () => {},
  };
  const mode2004 = io.bracketedPasteMode();
  const res = await deliverPrompt('p', text, { mode: 'auto', label: 'st01', bracketed: 'always', a4: true, engine, ...(FORM === 'yeni' ? { rawFirstLine: true } : {}) }, io);
  if (IZ) iz.push({ t: Date.now() - t0, hukum: res.outcome });
  return { makbuz: res.outcome, sebep: res.reason, enter: res.enters, tekrar: res.retries, gozlem: res.observations, geri_cevrildi: res.retryRefused, bosluk: res.gapMs, mode2004, ekran2004: s.raw2004,
    _iz: iz, _dur: () => { if (orneklem) clearInterval(orneklem); }, _t0: t0 };
}

// Mesaj motora varmadıysa: kutu durgunlaşınca YALNIZ Enter. Düzeltmenin dayanağı bu ölçümdür.
async function gecEnter(s, engine, h, before) {
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    let onceki = composer(s); let durgun = Date.now();
    while (Date.now() - durgun < 1500 && Date.now() - t0 < 15000) {
      await sleep(100);
      const c = composer(s);
      if (c !== onceki) { onceki = c; durgun = Date.now(); }
    }
    const kutuOnce = onceki.split('\n').filter((l) => l.trim()).slice(-3, -2).join('').trim().slice(-60);
    s.c.write('\r');
    const ulasti = await waitFor(() => ORACLE[engine](h).length > before, 8000, 200);
    out.push({ deneme: i + 1, bekleme_ms: Date.now() - t0, kutu_once: kutuOnce, ulasti });
    if (ulasti) break;
  }
  return out;
}

const FAKE_TUI = `
const fs=require('fs');const log=process.argv[1];
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[H> ');
process.stdin.on('data',(d)=>{fs.appendFileSync(log,JSON.stringify(d)+'\\n');});
setInterval(()=>{},1<<30);`;
async function fakeEngine(armId) {
  const { home, work } = homeFor('fake');
  for (const caseId of Object.keys(CASES).filter((k) => !ONLY.length || ONLY.includes(k))) {
    const log = path.join(home, `${caseId}.jsonl`); fs.writeFileSync(log, '');
    const env = { ...process.env };
    const s = spawnPane(process.execPath, ['-e', FAKE_TUI, log], work, env, armId);
    await waitFor(() => s.raw2004 || s.exit !== null, 8000, 50);
    await sleep(400);
    const text = promptFor(caseId, `${armId}f`);
    const d = await deliver(s, 'codex', text);
    await sleep(2000);
    const chunks = jsonl(log);
    const got = chunks.join('');
    const body = got.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, '');
    const sent = text;
    say({ motor: 'sahte', kol: armId, vaka: caseId, ...d,
      parca: chunks.length, enbuyuk_parca: Math.max(0, ...chunks.map((c) => c.length)),
      isaret200: got.includes('\x1b[200~'), isaret201: got.includes('\x1b[201~'),
      ...compare(sent, [body]) });
    killPane(s); await sleep(300);
  }
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}

const REAL = {
  codex: {
    start(armId, cap) {
      const h = homeFor(`cx-${armId}`);
      h.captured = cap.got;
      h.codexHome = path.join(h.home, '.codex'); fs.mkdirSync(h.codexHome);
      fs.writeFileSync(path.join(h.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-probe-not-a-real-key' }));
      fs.writeFileSync(path.join(h.codexHome, 'config.toml'), [
        'check_for_update_on_startup = false', 'model = "st01-m"', 'model_provider = "st01"', '',
        '[model_providers.st01]', 'name = "st01"', `base_url = "http://127.0.0.1:${cap.port}/v1"`, 'wire_api = "responses"',
        'requires_openai_auth = false', 'stream_max_retries = 0', 'request_max_retries = 0', '',
        `[projects.${JSON.stringify(h.work)}]`, 'trust_level = "trusted"', '',
      ].join('\n'));
      h.env = envFor(h.home, BIN.codex, { CODEX_HOME: h.codexHome });
      return h;
    },
    ready: /Ask Codex|›\s/, busy: /esc to interrupt/, needQuiet: 4000,
  },
  claude: {
    start(armId, cap) {
      const h = homeFor(`cl-${armId}`);
      fs.writeFileSync(path.join(h.home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [FAKE_ANTHROPIC.slice(-20)], rejected: [] } }));
      h.env = envFor(h.home, BIN.claude, { ANTHROPIC_API_KEY: FAKE_ANTHROPIC, ANTHROPIC_BASE_URL: `http://127.0.0.1:${cap.port}`, DISABLE_AUTOUPDATER: '1' });
      return h;
    },
    // Windows'ta kutu `❯` değil `>`: ilk koşuda 12 vaka bu yüzden "kutu acilmadi" dedi.
    ready: /❯|Try "|for shortcuts|bypass permissions|^\s*>\s*$/m, busy: /esc to interrupt/, needQuiet: 3000,
  },
  opencode: {
    start(armId, cap) {
      const h = homeFor(`oc-${armId}`);
      h.captured = cap.got;
      h.env = envFor(h.home, BIN.opencode, { OPENCODE_DISABLE_AUTOUPDATE: '1' });
      h.provider = { provider: { st01: { npm: '@ai-sdk/openai-compatible', name: 'st01', options: { baseURL: `http://127.0.0.1:${cap.port}/v1`, apiKey: 'x' }, models: { m: { name: 'm' } } } }, model: 'st01/m' };
      return h;
    },
    ready: /Ask anything|ctrl\+p|tab\s+agents?|ctrl\+x/i, busy: /esc interrupt|esc to interrupt/, needQuiet: 4000,
  },
};

async function openPane(engine, armId, cap) {
  const def = REAL[engine];
  const h = def.start(armId, cap);
  let plan = null;
  withAppHome(h.home, () => {
    plan = agentRunner.buildSpawn({ command: engine, agentId: 'probe-lider', cwd: h.work, disallowSubagent: true }, h.env, EL, {});
    if (plan && plan.trust && plan.trust.pending) agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env);
  });
  const bin = engineInstall.resolveBinary(plan.file, plan.env);
  if (!bin) throw new Error(`${engine} ikilisi bulunamadi`);
  const target = IS_WIN ? (() => { const t = engineInstall.execArgs(bin, plan.argv); return { file: t.file, argv: t.commandLine || t.argv }; })() : { file: bin, argv: plan.argv };
  const env = { ...plan.env, ...(engine === 'codex' ? { CODEX_HOME: h.codexHome } : {}) };
  if (h.provider) {
    let cfg = {}; try { cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}'); } catch { /* */ }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...cfg, ...h.provider });
  }
  // Ürün miras anahtarı siler; sahte modele ulaşmak için yalnız bu probda geri konur.
  if (engine === 'claude') { env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC; env.ANTHROPIC_BASE_URL = h.env.ANTHROPIC_BASE_URL; }
  const s = spawnPane(target.file, target.argv, h.work, env, armId, engine);
  const reached = await waitFor(() => def.ready.test(live(s)) || s.exit !== null, 90000, 400);
  await waitFor(() => def.busy.test(live(s)) || s.exit !== null, 8000, 250);
  await quiet(s, def.busy, 120000, def.needQuiet);
  return { h, s, def, reached };
}

const s_tail = (s) => s.screen.liveLines().filter((l) => l.trim()).slice(-14).map((l) => l.trimEnd().slice(0, 110)).join(' ¦ ').replace(/[A-Za-z]:\\[^\s]*/g, '<yol>');
async function bitisOlc(pane, engine, armId, caseId, cap) {
  const { countDoneMarkers } = app('markerSafe.cjs');
  const yanit = CASES[caseId].yanit;
  cap.yanit = yanit;
  pane.s.parca = [];
  await typeLikeHuman(pane.s, engine, promptFor(caseId, ''));
  const goruldu = await waitFor(() => live(pane.s).includes(yanit.split('\n').pop()), 30000, 300);
  await quiet(pane.s, pane.def.busy, 30000, pane.def.needQuiet);
  await sleep(2000);
  cap.yanit = null;
  const ham = pane.s.parca.join('');
  say({ motor: engine, kol: armId, vaka: caseId, goruldu,
    ham_sayim: countDoneMarkers(ham, 'st1'), parca_sayim: pane.s.parca.reduce((n, p) => n + countDoneMarkers(p, 'st1'), 0),
    ham_boy: ham.length, satir_sonu: (ham.match(/\n/g) || []).length, imlec: (ham.match(/\x1b\[\d+;\d+H/g) || []).length,
    parcalar: pane.s.parca.slice(-60), ekran: s_tail(pane.s) });
}
async function realEngine(engine, armId, cap) {
  let pane = null;
  for (const caseId of Object.keys(CASES).filter((k) => !ONLY.length || ONLY.includes(k))) {
    const t0 = Date.now();
    try {
      if (!pane || pane.s.exit !== null) pane = await openPane(engine, armId, cap);
      if (!pane.reached || pane.s.exit !== null) {
        say({ motor: engine, kol: armId, vaka: caseId, hata: 'kutu acilmadi', cikis: pane.s.exit, ekran: s_tail(pane.s) });
        killPane(pane.s); pane = null; continue;
      }
      if (CASES[caseId].yanit) {
        await bitisOlc(pane, engine, armId, caseId, cap);
        killPane(pane.s); pane = null; await sleep(800);
        continue;
      }
      const before = ORACLE[engine](pane.h);
      const text = promptFor(caseId, `${armId}${engine[0]}`);
      const d = CASES[caseId].klavye ? await typeLikeHuman(pane.s, engine, text) : await deliver(pane.s, engine, text);
      // Uzun metin kutuda bekleyebilir (OpenCode 8 KB): "gelmedi" demeden önce yavaş boyamaya süre tanı.
      const ulasti = await waitFor(() => ORACLE[engine](pane.h).length > before.length, Number(process.env.ST01_WAIT_MS) || 25000, 400);
      await sleep(2500);
      if (d._dur) d._dur();
      const iz = d._iz; delete d._iz; delete d._dur; delete d._t0;
      const kutu = composer(pane.s).split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 200);
      const ekran = s_tail(pane.s);
      const kurtarma = GEC_ENTER && !ulasti ? await gecEnter(pane.s, engine, pane.h, before.length) : undefined;
      if (kurtarma) await sleep(2500);
      const after = ORACLE[engine](pane.h).slice(before.length);
      say({ motor: engine, kol: armId, vaka: caseId, sn: Math.round((Date.now() - t0) / 1000), ...d, ilk_ulasti: ulasti, ...compare(text, after), once: before.length, kutu, ...(kurtarma ? { kurtarma } : {}), ...(after.length === 1 && norm(after[0]) === norm(text) ? {} : { ekran }), ...(iz && (!ulasti || Number(process.env.ST01_REP) <= 2) ? { iz } : {}) });
      await quiet(pane.s, pane.def.busy, 45000, pane.def.needQuiet);
      killPane(pane.s); pane = null; await sleep(800);
    } catch (e) {
      say({ motor: engine, kol: armId, vaka: caseId, hata: String(e && e.message || e).slice(0, 300) });
      if (pane) { killPane(pane.s); pane = null; }
    }
  }
  if (pane) killPane(pane.s);
}

// Sürücü: her (kol, motor, vaka) AYRI node süreci. node-pty kapanışta süreci düşürebildi
// (0xC0000374, ilk koşu); bir vakanın çökmesi ötekileri götürmesin, çöküş de satır olarak görünsün.
if (!process.env.ST01_CHILD) {
  const cp = require('node:child_process');
  say({ asama: 'surucu', platform: process.platform, release: os.release(), node: process.version, arms: ARMS, engines: ENGINES,
    prompt_boyu: Object.fromEntries(Object.keys(CASES).map((k) => [k, Buffer.byteLength(promptFor(k, 'x'), 'utf8')])) });
  for (const engine of ENGINES) {
    for (const armId of ARMS) {
      for (const caseId of Object.keys(CASES).filter((k) => !ONLY.length || ONLY.includes(k))) {
        for (let rep = 1; rep <= (Number(process.env.ST01_REPEAT) || 1); rep += 1) {
          const r = cp.spawnSync(process.execPath, [__filename], {
            stdio: 'inherit', timeout: 300000,
            env: { ...process.env, ST01_CHILD: '1', ST01_ARMS: armId, ST01_ENGINES: engine, ST01_CASES: caseId, ST01_REP: String(rep) },
          });
          if (r.status !== 0) say({ motor: engine, kol: armId, vaka: caseId, cocuk_cikis: r.status, sinyal: r.signal, hata: r.error ? String(r.error.message).slice(0, 200) : null });
        }
      }
    }
  }
  say({ asama: 'bitti' });
  process.exit(0);
}
(async () => {
  const cap = await capture();
  for (const armId of ARMS) {
    for (const engine of ENGINES) {
      if (engine === 'fake') { await fakeEngine(armId); continue; }
      if (!BIN[engine]) { say({ motor: engine, kol: armId, hata: 'ikili dizini verilmedi' }); continue; }
      await realEngine(engine, armId, cap);
    }
  }
  cap.stop();
  process.exit(0);
})().catch((e) => { say({ asama: 'patladi', hata: String(e && e.stack || e).slice(0, 500) }); process.exit(1); });
