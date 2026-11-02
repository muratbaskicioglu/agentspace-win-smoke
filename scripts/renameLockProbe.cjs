// Windows rename-under-lock probe (AgentSpace KURULUM-ONAR-GUV-02 / AS-4667).
//
// Question: when the app rolls back a folder swap (`node` <-> `node.yedek-<ts>`), and a file inside
// one of those folders is held open (antivirus scan, a running node.exe), what does Windows return,
// does a short 3 x 200 ms retry get past a short lock, and does the rollback order
// (new -> .bozuk, backup -> root, on failure put new back) ever leave the root folder missing?
//
// REPO RULE: this is a test script only. It uses plain Node fs calls and a PowerShell file handle;
// no app source code. Throwaway folders under RUNNER_TEMP (or os.tmpdir()).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const outDir = path.resolve(process.argv[process.argv.indexOf('--out') + 1] || 'rename-lock');
fs.mkdirSync(outDir, { recursive: true });
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
let failures = 0;
const expect = (ok, what) => { if (!ok) failures += 1; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

/** Same retry rule as the app: 3 tries, 200 ms apart, only for lock codes. */
async function renameRetry(a, b) {
  const codes = [];
  for (let i = 0; ; i += 1) {
    try { fs.renameSync(a, b); return { ok: true, tries: i + 1, codes }; } catch (e) {
      codes.push(e.code);
      if (i >= 2 || !LOCK_CODES.has(e.code)) return { ok: false, tries: i + 1, codes };
      await sleep(200);
    }
  }
}

/** Hold `file` open with FileShare.None (antivirus-like) for `ms`; resolves once the handle is open. */
function holdExclusive(file, ms) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$f=[System.IO.File]::Open($env:LOCK_FILE,"Open","ReadWrite","None"); [Console]::Out.WriteLine("LOCKED"); [Console]::Out.Flush(); Start-Sleep -Milliseconds ([int]$env:LOCK_MS); $f.Close()'],
    { env: { ...process.env, LOCK_FILE: file, LOCK_MS: String(ms) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    const done = new Promise((r) => ps.on('close', r));
    ps.stdout.on('data', (d) => { buf += d; if (buf.includes('LOCKED')) resolve({ done }); });
    ps.on('error', reject);
    setTimeout(() => reject(new Error('lock holder did not start')), 20000);
  });
}

function makeTree(base, name, content) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node.exe'), content);
  return dir;
}
const read = (dir) => { try { return fs.readFileSync(path.join(dir, 'node.exe'), 'utf8'); } catch { return null; } };

/** The app's rollback order. */
async function rollback(root, backup, stamp) {
  const broken = `${root}.bozuk-${stamp}`;
  const r1 = await renameRetry(root, broken);
  if (!r1.ok) return { result: 'geri-alma-dustu', step: 'root->bozuk', r1 };
  const r2 = await renameRetry(backup, root);
  if (!r2.ok) {
    const r3 = await renameRetry(broken, root);
    return { result: 'geri-alma-dustu', step: 'yedek->root', r1, r2, r3 };
  }
  try { fs.rmSync(broken, { recursive: true, force: true }); } catch { /* orphan */ }
  return { result: 'geri-alindi', r1, r2 };
}

(async () => {
  const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'rename-lock-'));
  log(`# rename-lock probe · ${os.type()} ${os.release()} · node ${process.version} · ${new Date().toISOString()}`);

  // A) Node's own open handle on a file inside the folder (node opens with share-delete).
  {
    const d = makeTree(base, 'a', 'x');
    const fd = fs.openSync(path.join(d, 'node.exe'), 'r');
    let code = 'renamed';
    try { fs.renameSync(d, `${d}-moved`); } catch (e) { code = e.code; }
    fs.closeSync(fd);
    log(`A node fs.openSync handle inside folder -> folder rename: ${code}`);
  }

  // B) Exclusive handle (FileShare.None) inside the folder: which code?
  {
    const d = makeTree(base, 'b', 'x');
    const h = await holdExclusive(path.join(d, 'node.exe'), 3000);
    let code = 'renamed';
    try { fs.renameSync(d, `${d}-moved`); } catch (e) { code = e.code; }
    log(`B exclusive handle inside folder -> folder rename: ${code}`);
    expect(LOCK_CODES.has(code), `B lock code is one the app retries on (${[...LOCK_CODES].join('/')})`);
    await h.done;
  }

  // C) Short lock (300 ms) on the backup: the app's retry gets through -> geri-alindi.
  {
    const run = path.join(base, 'c');
    const root = makeTree(run, 'node', 'YENI-BOZUK');
    const backup = makeTree(run, 'node.yedek-1', 'ESKI');
    const h = await holdExclusive(path.join(backup, 'node.exe'), 300);
    const r = await rollback(root, backup, 2);
    log(`C short lock on backup: ${JSON.stringify(r)} · root=${read(root)}`);
    expect(r.result === 'geri-alindi' && read(root) === 'ESKI', 'C short lock: retry restores the old folder');
    await h.done;
  }

  // D) Long lock (5 s) on the backup: rollback fails honestly, root still has content, backup kept.
  {
    const run = path.join(base, 'd');
    const root = makeTree(run, 'node', 'YENI-BOZUK');
    const backup = makeTree(run, 'node.yedek-1', 'ESKI');
    const h = await holdExclusive(path.join(backup, 'node.exe'), 5000);
    const r = await rollback(root, backup, 2);
    log(`D long lock on backup: ${JSON.stringify(r)} · root=${read(root)} · backup=${read(backup)}`);
    expect(r.result === 'geri-alma-dustu' && read(root) === 'YENI-BOZUK' && read(backup) === 'ESKI', 'D long lock: geri-alma-dustu, root NOT empty, backup kept');
    await h.done;
  }

  // E) Long lock (5 s) on the NEW folder: the first step fails, nothing moves.
  {
    const run = path.join(base, 'e');
    const root = makeTree(run, 'node', 'YENI-BOZUK');
    const backup = makeTree(run, 'node.yedek-1', 'ESKI');
    const h = await holdExclusive(path.join(root, 'node.exe'), 5000);
    const r = await rollback(root, backup, 2);
    log(`E long lock on root: ${JSON.stringify(r)} · root=${read(root)} · backup=${read(backup)}`);
    expect(r.result === 'geri-alma-dustu' && read(root) === 'YENI-BOZUK' && read(backup) === 'ESKI', 'E long lock on root: geri-alma-dustu, root NOT empty');
    await h.done;
  }

  // F) Control arm: the OLD order (rm root, then rename backup) under the same long lock on backup.
  {
    const run = path.join(base, 'f');
    const root = makeTree(run, 'node', 'YENI-BOZUK');
    const backup = makeTree(run, 'node.yedek-1', 'ESKI');
    const h = await holdExclusive(path.join(backup, 'node.exe'), 3000);
    fs.rmSync(root, { recursive: true, force: true });
    let code = 'renamed';
    try { fs.renameSync(backup, root); } catch (e) { code = e.code; }
    log(`F control (old order: rm root, rename backup) -> ${code} · root exists=${fs.existsSync(root)}`);
    await h.done;
  }

  log(`# result: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`);
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), `${lines.join('\n')}\n`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* runner temp */ }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { log(`ERROR ${e && e.stack}`); fs.writeFileSync(path.join(outDir, 'evidence.txt'), `${lines.join('\n')}\n`); process.exit(2); });
