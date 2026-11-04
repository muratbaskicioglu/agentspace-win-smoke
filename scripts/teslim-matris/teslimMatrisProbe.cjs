#!/usr/bin/env node
'use strict';
// TESLIM-MATRIS-01 — sohbet mesajı müşteri yolundan motora bayt bayt nasıl varıyor?
//
// KOD ÜRÜNÜN KENDİSİ: paketin içinden officeRoom.say → agentxDeliver.deliverConfirmed → deliverPrompt
// → winConsoleInput.wrapWrite → node-pty. Yalnız main.js'in ince yapıştırıcısı burada yeniden kurulur
// (pane defteri, ekran okuma, makine metni damgası). Pencere kodu (TeamChatFeed) burada YOK; kapsamı rapor yazar.
//
// HÜKÜM OLÇÜDEN: gönderilen = io.deliver'a giren metin; alınan = motorun KENDİ defteri
// (gerçek CLI'nin yerel yakalayıcıya attığı istek gövdesi, Claude'da oturum defteri, sahte TUI'de ham stdin).
// Ürün makbuzu yalnız yanında yazılır, hükme girmez.
//
// Ortam: TM_APP (agentRunner.js'in olduğu kök) · TM_OUT (ham/ dizini) · TM_MOTORLAR · TM_GIRISLER · TM_MESAJLAR
// TM_TEKRAR · TM_POZITIF=0|1 · TM_CODEX_DIR/TM_CLAUDE_DIR/TM_OPENCODE_DIR · TM_SURUM · TM_KULVAR
// Çıktı: <TM_OUT>/ham-<kulvar>-<surum>-<motor>.jsonl (atım başına tek satır, ham bayt dahil).

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const K = require('./katalog.cjs');

const EL = process.env.TM_APP;
if (!EL) { console.error('TM_APP gerekli'); process.exit(2); }
const OUT = process.env.TM_OUT || process.cwd();
const SURUM = process.env.TM_SURUM || 'yerel';
const KULVAR = process.env.TM_KULVAR || `${process.platform}-${os.arch()}`;
const TEKRAR = Number(process.env.TM_TEKRAR || K.TEKRAR);
const liste = (ad, tumu) => (process.env[ad] ? process.env[ad].split(',').filter(Boolean) : tumu);
const MOTORLAR = liste('TM_MOTORLAR', Object.keys(K.MOTORLAR));
const GIRISLER = liste('TM_GIRISLER', Object.keys(K.GIRISLER));
const MESAJLAR = liste('TM_MESAJLAR', Object.keys(K.MESAJLAR));
const POZITIF = process.env.TM_POZITIF === '1';
const BIN = { codex: process.env.TM_CODEX_DIR, claude: process.env.TM_CLAUDE_DIR, opencode: process.env.TM_OPENCODE_DIR };

const IS_WIN = process.platform === 'win32';
const COLS = 120; const ROWS = 32;
const SAHTE_ANAHTAR = 'sk-ant-api03-probe-not-a-real-key-000000000000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => console.log(`TM ${JSON.stringify(o)}`);
const hamDosya = (motor) => path.join(OUT, `ham-${KULVAR}-${SURUM}-${motor}.jsonl`);
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

function surucu() {
  fs.mkdirSync(OUT, { recursive: true });
  const hucreler = K.hucreler(MOTORLAR).filter((h) => GIRISLER.includes(h.giris) && MESAJLAR.includes(h.mesaj));
  say({ asama: 'surucu', surum: SURUM, kulvar: KULVAR, platform: process.platform, release: os.release(), arch: os.arch(), hucre: hucreler.length, tekrar: TEKRAR, pozitif: POZITIF });
  for (const h of hucreler) {
    const t0 = Date.now();
    // Her hücre ayrı süreç: node-pty kapanışta süreci düşürebiliyor (0xC0000374); bir hücrenin çöküşü ötekini götürmesin.
    const r = cp.spawnSync(process.execPath, [__filename], {
      stdio: 'inherit',
      timeout: 20 * 60_000,
      env: { ...process.env, TM_COCUK: h.id },
    });
    if (r.status !== 0) {
      fs.appendFileSync(hamDosya(h.motor), `${JSON.stringify({ hucre: h.id, kol: 'ana', gecti: false, sebepler: ['prob_dustu'], cikis: r.status, sinyal: r.signal, surum: SURUM, kulvar: KULVAR })}\n`);
    }
    say({ asama: 'hucre', hucre: h.id, sn: Math.round((Date.now() - t0) / 1000), cikis: r.status });
  }
}

// ── yerel yakalayıcı: gerçek CLI'nin modele sandığı yer ──
function yakalayici() {
  const got = [];
  const srv = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const list = Array.isArray(j.messages) ? j.messages : Array.isArray(j.input) ? j.input : [];
        const ms = list.filter((m) => m && m.role === 'user');
        const last = ms[ms.length - 1];
        if (last) {
          const c = last.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : '';
          if (t && got[got.length - 1] !== t) got.push(t);
        }
      } catch { /* gövde değil */ }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"tm probe","type":"invalid_request_error"}}');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ got, port: srv.address().port, stop: () => srv.close() })));
}

function evAc(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${tag}-`));
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  return { home, work };
}
function ortam(home, binDir, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GITHUB_|ACTIONS_|RUNNER_|TM_|ELECTRON_RUN_AS_NODE)/.test(k)) delete env[k];
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || env.Path || ''}`;
  if (IS_WIN) { env.Path = env.PATH; env.USERPROFILE = home; } else env.HOME = home;
  env.AGENTDESK_HOME = path.join(home, '.agentdesk');
  return { ...env, ...extra };
}
function dolas(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) dolas(p, out); else out.push(p); }
  return out;
}
function jsonl(file) {
  const r = []; let body = ''; try { body = fs.readFileSync(file, 'utf8'); } catch { return r; }
  for (const l of body.split('\n')) { if (!l.trim()) continue; try { r.push(JSON.parse(l)); } catch { /* yarım satır */ } }
  return r;
}

const GERCEK = {
  codex: {
    kur(cap) {
      const h = evAc('cx');
      h.codexHome = path.join(h.home, '.codex'); fs.mkdirSync(h.codexHome);
      fs.writeFileSync(path.join(h.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-probe-not-a-real-key' }));
      fs.writeFileSync(path.join(h.codexHome, 'config.toml'), [
        'check_for_update_on_startup = false', 'model = "tm-m"', 'model_provider = "tm"', '',
        '[model_providers.tm]', 'name = "tm"', `base_url = "http://127.0.0.1:${cap.port}/v1"`, 'wire_api = "responses"',
        'requires_openai_auth = false', 'stream_max_retries = 0', 'request_max_retries = 0', '',
        `[projects.${JSON.stringify(h.work)}]`, 'trust_level = "trusted"', '',
      ].join('\n'));
      h.env = ortam(h.home, BIN.codex, { CODEX_HOME: h.codexHome });
      return h;
    },
    // Codex başlık üretimi için ek istek atar: motorun kendi metni, teslim değil.
    defter: (h, cap) => cap.got.filter((t) => !/^Generate a concise, single-line task title/.test(t)),
    hazir: /Ask Codex|›\s/, mesgul: /esc to interrupt/, sessiz: 4000,
  },
  claude: {
    kur(cap) {
      const h = evAc('cl');
      fs.writeFileSync(path.join(h.home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [SAHTE_ANAHTAR.slice(-20)], rejected: [] } }));
      h.env = ortam(h.home, BIN.claude, { ANTHROPIC_API_KEY: SAHTE_ANAHTAR, ANTHROPIC_BASE_URL: `http://127.0.0.1:${cap.port}`, DISABLE_AUTOUPDATER: '1' });
      return h;
    },
    defter: (h) => dolas(path.join(h.home, '.claude', 'projects')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => jsonl(f))
      .filter((e) => e.type === 'user' && e.message && !e.isMeta && !e.toolUseResult).map((e) => {
        const c = e.message.content;
        return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('') : '';
      }).filter(Boolean),
    hazir: /❯|Try "|for shortcuts/, mesgul: /esc to interrupt/, sessiz: 3000,
  },
  opencode: {
    kur(cap) {
      const h = evAc('oc');
      h.env = ortam(h.home, BIN.opencode, { OPENCODE_DISABLE_AUTOUPDATE: '1' });
      h.provider = { provider: { tm: { npm: '@ai-sdk/openai-compatible', name: 'tm', options: { baseURL: `http://127.0.0.1:${cap.port}/v1`, apiKey: 'x' }, models: { m: { name: 'm' } } } }, model: 'tm/m' };
      return h;
    },
    defter: (h, cap) => cap.got.slice(),
    hazir: /Ask anything|ctrl\+p|tab\s+agents?|ctrl\+x/i, mesgul: /esc interrupt|esc to interrupt/, sessiz: 4000,
  },
};

async function bekle(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return !!fn();
}

async function cocuk(hucreId) {
  const [motor, giris, mesaj] = hucreId.split('|');
  const app = (rel) => require(path.join(EL, rel));
  const pty = app('node_modules/node-pty');
  const paneScreen = app('paneScreen.cjs');
  const { deliverPrompt } = app('deliverPrompt.cjs');
  const { createAgentxDeliver } = app('agentxDeliver.cjs');
  const { ghostContextOf } = app('leaderComposer.cjs');
  const room = app('officeRoom.cjs');
  const deliveryCard = app('deliveryCard.cjs');
  let winInput = null;
  try { winInput = app('platform/winConsoleInput.cjs'); } catch { /* eski sürümde yok */ }
  const treeKill = (() => { try { return app('platform/ptyTreeKill.cjs'); } catch { return null; } })();

  const G = K.GIRISLER[giris];
  const M = K.MESAJLAR[mesaj];
  const agentId = G.rol === 'lider' ? 'tm-lider' : 'tm-ayse';
  const DEPT = 'cekirdek';
  const ROSTER = [
    { id: 'tm-lider', match: 'lider', label: 'Lider', department: DEPT, role: 'lead' },
    { id: 'tm-ayse', match: 'ayşe', label: 'Ayşe', department: DEPT, role: 'Frontend' },
  ];
  const LEDGER = [{
    delegationId: 'd1', subtaskId: 's1', agentId: 'tm-ayse', jobId: 'TM-1', taskCode: 'TM-1',
    evidencePath: '/is/docs/agent-results/TM-1-ayse.md', status: 'done',
    dispatchedAt: Date.now() - 120_000, settledAt: Date.now() - 60_000, verification: { durum: 'dogrulandi' }, workTree: { path: '/is' },
  }];

  const cap = await yakalayici();
  const SAHTE = motor === 'antigravity';
  let defter;
  function paneAc() {
    let h; let file; let argv; let env;
    if (SAHTE) {
      h = evAc('sahte');
      h.log = path.join(h.home, 'tui.jsonl');
      fs.writeFileSync(h.log, '');
      file = process.execPath;
      argv = [path.join(__dirname, 'sahteTui.cjs'), h.log];
      env = { ...process.env };
      delete env.TM_COCUK;
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      defter = () => jsonl(h.log).filter((e) => typeof e.mesaj === 'string').map((e) => e.mesaj);
    } else {
      const def = GERCEK[motor];
      const agentRunner = app('agentRunner.js');
      const engineInstall = app('engineInstall.cjs');
      h = def.kur(cap);
      const saved = ['USERPROFILE', 'HOME', 'AGENTDESK_HOME'].map((k) => [k, process.env[k]]);
      Object.assign(process.env, { USERPROFILE: h.home, HOME: h.home, AGENTDESK_HOME: path.join(h.home, '.agentdesk') });
      let plan;
      try {
        plan = agentRunner.buildSpawn({ command: motor, agentId, cwd: h.work, disallowSubagent: true }, h.env, EL, {});
        if (plan && plan.trust && plan.trust.pending) agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env);
      } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
      const bin = engineInstall.resolveBinary(plan.file, plan.env);
      if (!bin) throw new Error(`${motor} ikilisi yok`);
      const target = IS_WIN ? (() => { const t = engineInstall.execArgs(bin, plan.argv); return { file: t.file, argv: t.commandLine || t.argv }; })() : { file: bin, argv: plan.argv };
      file = target.file; argv = target.argv;
      env = { ...plan.env, ...(motor === 'codex' ? { CODEX_HOME: h.codexHome } : {}) };
      if (h.provider) {
        let cfg = {}; try { cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}'); } catch { /* */ }
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...cfg, ...h.provider });
      }
      defter = () => def.defter(h, cap);
    }
    const child = pty.spawn(file, argv, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: h.work, env, ...(IS_WIN ? { useConpty: true } : {}) });
    const screen = paneScreen.createPaneScreen({ cols: COLS, rows: ROWS, scrollback: 500 });
    const p = { h, child, screen, cikis: null, bytes: 0, lastDataAt: 0, entry: {} };
    child.onData((d) => { p.bytes += d.length; p.lastDataAt = Date.now(); try { screen.write(d); } catch { /* */ } });
    child.onExit((e) => { p.cikis = e.exitCode; });
    // main.js:6341 ile aynı: motor Windows'ta yazma kodlayıcısını taşır.
    if (winInput) winInput.wrapWrite(child, { engine: SAHTE ? 'antigravity' : motor, platform: process.platform });
    return p;
  }
  function paneKapat(p) {
    if (!p) return;
    try { if (treeKill) treeKill.killPaneTreesSync([p.child]); } catch { /* */ }
    try { p.child.kill(); } catch { /* */ }
    try { p.screen.dispose(); } catch { /* */ }
  }
  const canli = (p) => p.screen.liveLines().join('\n');
  const kutu = (p) => p.screen.composerLines().join('\n');
  async function hazirla(p) {
    if (SAHTE) { await bekle(() => /ctrl\+x/.test(canli(p)) || p.cikis !== null, 8000, 50); await sleep(300); return p.cikis === null; }
    const def = GERCEK[motor];
    const ok = await bekle(() => def.hazir.test(canli(p)) || p.cikis !== null, 90_000, 400);
    await bekle(() => def.mesgul.test(canli(p)) || p.cikis !== null, 6000, 250);
    await sessiz(p);
    return ok && p.cikis === null;
  }
  async function sessiz(p, ms = 60_000) {
    if (SAHTE) return;
    const def = GERCEK[motor];
    let since = 0;
    await bekle(() => {
      if (p.cikis !== null) return true;
      if (def.mesgul.test(p.screen.liveLines().slice(-10).join('\n'))) { since = 0; return false; }
      if (!since) since = Date.now();
      return Date.now() - since > def.sessiz;
    }, ms, 400);
  }

  // Bir gönderim: oda + teslim zinciri o atım için kurulur (defter boş, açık soru temiz).
  async function atim(p, kol, sabotaj) {
    const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-oda-'));
    const onceki = defter().length;
    const yazilan = [];
    let enterYutuldu = 0;
    const entry = p.entry;
    const dio = {
      readPaneBuffer: () => kutu(p),
      writePane: (_id, data) => {
        let d = data;
        if (sabotaj === 'bayt' && typeof d === 'string' && d.length > 1 && /[^\r\n]/.test(d)) {
          // Pozitif kontrol: görünür metnin ORTASINDAN tek karakter düşür. Yakalanmazsa hücre kanıt değildir.
          const i = Math.floor(d.length / 2);
          d = d.slice(0, i) + d.slice(i + 1);
        }
        if (sabotaj === 'enter' && typeof d === 'string' && /^\r+$/.test(d)) { enterYutuldu += 1; return true; }
        if (typeof d === 'string' && /[^\r\n]/.test(d)) { entry.lastMachineTextAt = Date.now(); entry.lastMachineText = d; }
        yazilan.push(typeof d === 'string' ? d.length : 0);
        p.child.write(d);
        return true;
      },
      sleep,
      now: () => Date.now(),
      livePaneCount: () => 1,
      bracketedPasteMode: () => { try { return p.screen.term.modes.bracketedPasteMode === true; } catch { return null; } },
      log: () => {},
    };
    const makbuzlar = [];
    const agentx = createAgentxDeliver({
      listPanes: () => [{ paneId: 'pane-1', agentId, department: DEPT, bytes: p.bytes, buffer: kutu(p), lastDataAt: p.lastDataAt }],
      readPaneBuffer: () => kutu(p),
      deliver: (paneId, text, opts) => deliverPrompt(paneId, text, opts, dio),
      paneEngine: () => (SAHTE ? 'antigravity' : motor),
      transcriptHas: () => null,
      ghostContext: () => ghostContextOf(entry),
      emit: (r) => makbuzlar.push(r),
      sleep,
      now: () => Date.now(),
      log: () => {},
    });
    let gonderilen = null;
    if (M.acikSoru) {
      room.saveState({
        version: room.STORE_VERSION,
        messages: [{ id: 'q1', at: Date.now() - 5000, who: room.WHO.AGENT, agentId, team: DEPT, text: M.acikSoru, kind: 'question', awaiting: true }],
      }, ev);
    }
    const oda = room.createOfficeRoom({
      homedir: ev,
      listPanes: () => [{ paneId: 'pane-1', agentId, exited: false, department: DEPT }],
      readPaneScreen: () => canli(p),
      deliver: (req) => { gonderilen = req.text; return agentx.deliverConfirmed(req); },
      ledger: () => LEDGER,
      config: { replyPollMs: 500, replyBudgetMs: 1000 },
      sleep,
      log: () => {},
    });
    const t0 = Date.now();
    const istek = {
      text: G.metin(M.govde),
      ...(G.kaynak ? { source: G.kaynak } : {}),
      ctx: G.kaynak === 'mobile' ? { aliases: ROSTER, activeDepartment: DEPT } : { aliases: ROSTER, departments: [{ id: DEPT, label: 'Çekirdek' }], activeDepartment: DEPT },
      bossLabel: 'Patron',
      ...(G.duzeltme ? { revision: { deliveryId: deliveryCard.listDeliveries({ records: LEDGER, messages: [] })[0].deliveryId } } : {}),
    };
    let sonuc = null; let hata = null;
    try { sonuc = await oda.say(istek); } catch (e) { hata = String(e && e.message).slice(0, 200); }
    if (gonderilen) await bekle(() => defter().length > onceki, sabotaj === 'enter' ? 8000 : 25_000, 300);
    await sleep(SAHTE ? 300 : 1500);
    const alinan = defter().slice(onceki);
    const hukum = K.atimHukmu({ govde: M.govde, gonderilen, alinan });
    const makbuz = makbuzlar.length ? makbuzlar[makbuzlar.length - 1] : null;
    const satir = {
      surum: SURUM, kulvar: KULVAR, hucre: hucreId, motor, giris, mesaj, rol: G.rol, kol, sabotaj: sabotaj || null,
      ...hukum,
      urun: { ok: sonuc ? sonuc.ok === true : null, tur: sonuc ? sonuc.kind || null : null, makbuz: makbuz && makbuz.state, hata },
      yazim: yazilan, enter_yutuldu: enterYutuldu, sn: Math.round((Date.now() - t0) / 100) / 10,
      gonderilen_sha: gonderilen == null ? null : sha(K.normal(gonderilen)),
      alinan_sha: alinan.map((a) => sha(K.normal(a))),
      kutu_sonra: kutu(p).split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 200),
      // Ham bayt: yalnız sabit prob metni taşır, kişisel veri yok.
      gonderilen, alinan,
      ...(hukum.gecti ? {} : { ekran: p.screen.liveLines().filter((l) => l.trim()).slice(-12).map((l) => l.trimEnd().slice(0, 110)).join(' ¦ ').replace(/[A-Za-z]:\\[^\s]*/g, '<yol>').replace(/\/(Users|home|private|var|tmp)\/[^\s]*/g, '<yol>') }),
    };
    fs.appendFileSync(hamDosya(motor), `${JSON.stringify(satir)}\n`);
    try { oda.stop(); } catch { /* */ }
    try { fs.rmSync(ev, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
    return hukum;
  }

  let pane = paneAc();
  let acildi = await hazirla(pane);
  const yeniden = async () => { paneKapat(pane); await sleep(500); pane = paneAc(); acildi = await hazirla(pane); };
  for (let i = 0; i < TEKRAR; i++) {
    if (!acildi || pane.cikis !== null) await yeniden();
    if (!acildi) {
      fs.appendFileSync(hamDosya(motor), `${JSON.stringify({ surum: SURUM, kulvar: KULVAR, hucre: hucreId, motor, giris, mesaj, kol: 'ana', gecti: false, sebepler: ['motor_acilmadi'], cikis: pane.cikis, ekran: canli(pane).slice(-400) })}\n`);
      break;
    }
    const hk = await atim(pane, 'ana', null);
    await sessiz(pane);
    // Geçmeyen atımın kutuda bıraktığı metin sonrakini kirletmesin: temiz pane ile sür.
    if (!hk.gecti) await yeniden();
  }
  if (POZITIF && acildi) {
    for (const sabotaj of ['bayt', 'enter']) {
      await yeniden();
      if (!acildi) break;
      await atim(pane, 'pozitif', sabotaj);
    }
  }
  paneKapat(pane);
  cap.stop();
  await sleep(200);
  process.exit(0);
}

process.on('unhandledRejection', (e) => { console.error(e); process.exit(3); });
if (process.env.TM_COCUK) cocuk(process.env.TM_COCUK).catch((e) => { console.error(e); process.exit(3); });
else surucu();
