'use strict';
// SIFIRLA-MOTOR-IKILI-01 — AgentSpace-Sifirla.cmd'nin PowerShell gövdesini SAHTE ev klasörlerinde koşturur.
// Gerçek profile dokunmaz: USERPROFILE/APPDATA/LOCALAPPDATA geçici klasöre çevrilir.
// Koşturucu: AS_PWSH (yol) > PATH'te pwsh > Windows'ta powershell. Bulunamazsa test KIRMIZI (atlanmaz).
// macOS'ta: AS_PWSH=<pwsh> perl -e 'alarm 900;exec @ARGV' node --test scripts/hesap-sifirla/sifirla-win.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BETIK = path.join(__dirname, 'AgentSpace-Sifirla.cmd');

function kosturucu() {
  if (process.env.AS_PWSH) return process.env.AS_PWSH;
  for (const ad of ['pwsh', process.platform === 'win32' ? 'powershell' : null].filter(Boolean)) {
    const r = spawnSync(ad, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return ad;
  }
  return null;
}

// Sahte makine: ev kökleri + ürünün ve motorların bıraktığı dosyalar + korunan klasörler.
function sahteMakine() {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'sifirla-win-'));
  const U = path.join(kok, 'U');
  const R = path.join(U, 'AppData', 'Roaming');
  const L = path.join(U, 'AppData', 'Local');
  const dosya = (p, icerik = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, icerik); };
  const yollar = {
    ofis: path.join(U, '.agentdesk', 'settings.json'),
    userData: path.join(R, 'agentdesk-shell', 'Local State'),
    runtime: path.join(R, 'agentdesk-shell', 'runtime', 'node.exe'),
    claude: path.join(U, '.local', 'bin', 'claude.exe'),
    agy: path.join(L, 'agy', 'bin', 'agy.exe'),
    agyStaging: path.join(L, 'antigravity', 'staging', 'agy.exe'),
    ocShim: path.join(R, 'npm', 'opencode.cmd'),
    ocShimSh: path.join(R, 'npm', 'opencode'),
    ocShimPs: path.join(R, 'npm', 'opencode.ps1'),
    ocPaket: path.join(R, 'npm', 'node_modules', 'opencode-ai', 'package.json'),
    ocVeri: path.join(U, '.local', 'share', 'opencode', 'auth.json'),
    ocAyar: path.join(U, '.config', 'opencode', 'opencode.json'),
    gemini: path.join(U, '.gemini', 'antigravity-cli', 'settings.json'),
    // KALMASI gerekenler
    uygulama: path.join(L, 'Programs', 'AgentSpace', 'AgentSpace.exe'),
    kurtarma: path.join(U, 'AgentSpace-Kurtarma', 'yedek.json'),
    baskaNpm: path.join(R, 'npm', 'node_modules', 'baska-paket', 'package.json'),
    baskaNpmShim: path.join(R, 'npm', 'baska.cmd'),
    baskaLocal: path.join(U, '.local', 'share', 'baska', 'x.txt'),
    baskaConfig: path.join(U, '.config', 'baska', 'x.txt'),
  };
  for (const p of Object.values(yollar)) dosya(p);
  return { kok, U, R, L, yollar };
}

function kostur(m, env) {
  const pwsh = kosturucu();
  assert.ok(pwsh, 'PowerShell bulunamadı (AS_PWSH ver) — test ATLANMAZ');
  // .cmd'nin kendi açılış satırıyla AYNI: dosya UTF-8 okunup iex edilir (üst kısım <# … #> yorumu).
  // -File KULLANILMAZ: Windows PowerShell 5.1 BOM'suz dosyayı ANSI okur, Türkçe metin bozulur.
  const r = spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    'iex ([IO.File]::ReadAllText($env:AS_SIFIRLA_DOSYA, [Text.Encoding]::UTF8))'], {
    encoding: 'utf8',
    cwd: m.kok,
    timeout: Number(process.env.AS_SIFIRLA_TEST_SURE_MS) || 120000, // yüklü macOS'ta Get-Process yavaş
    env: {
      ...process.env,
      USERPROFILE: m.U, APPDATA: m.R, LOCALAPPDATA: m.L,
      AS_SIFIRLA_SUREC_ADLARI: 'yok-boyle-bir-surec-sifirla',
      AS_SIFIRLA_BEKLE: '0',
      AS_SIFIRLA_DOSYA: BETIK,
      ...env,
    },
  });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const var_ = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const KALANLAR = ['uygulama', 'kurtarma', 'baskaNpm', 'baskaNpmShim', 'baskaLocal', 'baskaConfig'];
const MOTOR_IKILI = ['agy', 'agyStaging', 'ocShim', 'ocShimSh', 'ocShimPs', 'ocPaket', 'ocVeri', 'ocAyar'];

test('kuru koşum: seçim 2 + onay yok → liste agy + opencode gösterir, HİÇBİR ŞEY silinmez', () => {
  const m = sahteMakine();
  const { rc, out } = kostur(m, { AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'HAYIR' });
  console.log(out);
  assert.equal(rc, 0);
  assert.match(out, /Silinecekler:/);
  for (const parca of [`${path.sep}agy`, 'opencode-ai', 'opencode.cmd', `antigravity${path.sep}staging`]) assert.ok(out.includes(parca), `listede yok: ${parca}`);
  assert.match(out, /Vazgeçildi, hiçbir şey silinmedi/);
  for (const [ad, p] of Object.entries(m.yollar)) assert.ok(var_(p), `kuru koşumda silindi: ${ad}`);
});

test('seçim 2 + SIFIRLA → agy ve npm opencode gider; uygulama, kurtarma, npm klasörü ve başka paketler kalır', () => {
  const m = sahteMakine();
  const { rc, out } = kostur(m, { AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  console.log(out);
  assert.equal(rc, 0, out);
  for (const ad of [...MOTOR_IKILI, 'ofis', 'userData', 'runtime', 'claude', 'gemini']) assert.ok(!var_(m.yollar[ad]), `kaldı: ${ad}`);
  assert.ok(!var_(path.join(m.L, 'agy')), 'agy klasörü kaldı');
  assert.ok(!var_(path.join(m.L, 'antigravity')), 'boş antigravity klasörü kaldı');
  for (const ad of KALANLAR) assert.ok(var_(m.yollar[ad]), `silindi: ${ad}`);
  assert.ok(var_(path.join(m.R, 'npm', 'node_modules')), 'npm\\node_modules silindi');
});

test('seçim 1 → motorlar (agy, opencode, runtime) kalır', () => {
  const m = sahteMakine();
  const { rc, out } = kostur(m, { AS_SIFIRLA_SECIM: '1', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  assert.equal(rc, 0, out);
  assert.ok(!var_(m.yollar.ofis));
  for (const ad of [...MOTOR_IKILI, 'runtime', 'claude', 'gemini', ...KALANLAR]) assert.ok(var_(m.yollar[ad]), `silindi: ${ad}`);
});

test('antigravity klasöründe başka şey varsa üst klasör kalır', () => {
  const m = sahteMakine();
  const baska = path.join(m.L, 'antigravity', 'ide-verisi.txt');
  fs.writeFileSync(baska, 'x');
  const { rc, out } = kostur(m, { AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  assert.equal(rc, 0, out);
  assert.ok(!var_(m.yollar.agyStaging));
  assert.ok(var_(baska), 'antigravity içindeki başka dosya silindi');
});

test('koruma: LOCALAPPDATA kurtarma klasörünün içindeyse betik HİÇBİR ŞEY silmeden durur (3)', () => {
  const m = sahteMakine();
  const L2 = path.join(m.U, 'AgentSpace-Kurtarma', 'Local');
  fs.mkdirSync(path.join(L2, 'agy', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(L2, 'agy', 'bin', 'agy.exe'), 'x');
  const { rc, out } = kostur(m, { LOCALAPPDATA: L2, AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  console.log(out);
  assert.equal(rc, 3, out);
  assert.match(out, /korunan yere değiyor/);
  assert.ok(var_(path.join(L2, 'agy', 'bin', 'agy.exe')));
  for (const [ad, p] of Object.entries(m.yollar)) assert.ok(var_(p), `durması gerekirken silindi: ${ad}`);
});

test('koruma: APPDATA boşsa durur (3), hiçbir şey silinmez', () => {
  const m = sahteMakine();
  const { rc, out } = kostur(m, { APPDATA: '', AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  assert.equal(rc, 3, out);
  for (const [ad, p] of Object.entries(m.yollar)) assert.ok(var_(p), `silindi: ${ad}`);
});

test('bağlantı: node_modules\\opencode-ai başka yere bağlantıysa yalnız bağlantı gider, gösterdiği yer kalır', () => {
  const m = sahteMakine();
  const dis = path.join(m.kok, 'disaridaki-klasor');
  fs.mkdirSync(dis);
  fs.writeFileSync(path.join(dis, 'kalmali.txt'), 'x');
  const link = path.join(m.R, 'npm', 'node_modules', 'opencode-ai');
  fs.rmSync(link, { recursive: true });
  fs.symlinkSync(dis, link, 'junction');
  const { rc, out } = kostur(m, { AS_SIFIRLA_SECIM: '2', AS_SIFIRLA_ONAY: 'SIFIRLA' });
  assert.equal(rc, 0, out);
  assert.ok(!var_(link), 'bağlantı kaldı');
  assert.ok(var_(path.join(dis, 'kalmali.txt')), 'bağlantının gösterdiği klasör silindi');
});

test('depodaki .cmd CRLF baytıyla duruyor (LF\'de cmd.exe bozuluyor)', () => {
  const b = fs.readFileSync(BETIK);
  const lf = b.filter((c, i) => c === 0x0a && b[i - 1] !== 0x0d).length;
  assert.equal(lf, 0, `${lf} satır LF`);
});
