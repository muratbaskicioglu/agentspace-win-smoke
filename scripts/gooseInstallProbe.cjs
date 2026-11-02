// Goose CLI on Windows: does the vendor's PowerShell installer work the way AgentSpace runs it?
//
// REPO RULE: no app source code here. This script repeats only the PUBLIC vendor command
// (https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1, the "Windows →
// PowerShell" path in the Goose docs) with the same process shape the app uses:
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy ByPass -Command "irm <url> | iex"
//   no shell, hidden window, stdin closed, cwd = the (throwaway) user home,
//   env CONFIGURE=false and GOOSE_BIN_DIR=<home>\.local\bin.
// Then it checks the identity (`goose --help` must match /usage:\s*goose/i) and reads the
// version from `goose --version`.
//
// Arms:
//   main    — the app's process shape → install ok, goose.exe in <home>\.local\bin, identity, version
//   control — same, WITHOUT CONFIGURE=false (the vendor default) → measured only: does the
//             installer stop at `goose configure`? (timebox 120 s, then our own child tree is killed)
//
//   node gooseInstallProbe.cjs --out <dir>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const outDir = process.argv[process.argv.indexOf('--out') + 1];
fs.mkdirSync(outDir, { recursive: true });
const URL = 'https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1';
const ARGV = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'ByPass', '-Command', `irm ${URL} | iex`];
const ID_RE = /usage:\s*goose/i;
const VERSION_RE = /\b(\d+\.\d+\.\d+[\w.-]*)/;
const tmp = process.env.RUNNER_TEMP;
const lines = [];
const log = (s) => { const t = `GOOSEWIN ${s.split(tmp).join('<TMP>')}`; console.log(t); lines.push(t); };

function isoEnv(home, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GOOSE_|CONFIGURE$)/i.test(k)) env[k] = v;
  const local = path.join(home, 'AppData', 'Local');
  const roaming = path.join(home, 'AppData', 'Roaming');
  for (const d of [local, roaming, path.join(local, 'Temp')]) fs.mkdirSync(d, { recursive: true });
  return { ...env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: roaming, TEMP: path.join(local, 'Temp'), TMP: path.join(local, 'Temp'), ...extra };
}

function runInstaller(home, env, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const c = spawn('powershell.exe', ARGV, { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    c.stdout.on('data', (d) => { out = (out + d).slice(-6000); });
    c.stderr.on('data', (d) => { out = (out + d).slice(-6000); });
    const timer = setTimeout(() => {
      try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      resolve({ code: null, timedOut: true, ms: Date.now() - t0, out });
    }, timeoutMs);
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false, ms: Date.now() - t0, out }); });
  });
}

const run = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { windowsHide: true, timeout: 20000 }, (err, so, se) => resolve({ err: err ? (err.code || err.message) : null, out: `${so || ''}${se || ''}` }));
});

(async () => {
  let ok = true;
  const check = (name, cond, more = '') => { log(`${cond ? 'PASS' : 'FAIL'} ${name}${more ? ` — ${more}` : ''}`); if (!cond) ok = false; };
  const os = execFileSync('powershell.exe', ['-NoProfile', '-Command', '$o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption) build $($o.BuildNumber) arch $env:PROCESSOR_ARCHITECTURE"']).toString().trim();
  log(`os=${os} node=${process.version}`);

  // main arm
  const home = path.join(tmp, 'goose-iso-main');
  const env = isoEnv(home, { CONFIGURE: 'false', GOOSE_BIN_DIR: path.join(home, '.local', 'bin') });
  const exe = path.join(home, '.local', 'bin', 'goose.exe');
  log(`main before goose.exe=${fs.existsSync(exe)}`);
  const r = await runInstaller(home, env, 8 * 60 * 1000);
  log(`main installer exit=${r.code} timedOut=${r.timedOut} sec=${Math.round(r.ms / 1000)}`);
  fs.writeFileSync(path.join(outDir, 'main-installer.txt'), r.out.split(tmp).join('<TMP>'));
  check('installer exit 0', r.code === 0 && !r.timedOut);
  check('goose.exe in <home>\\.local\\bin', fs.existsSync(exe));
  check('installer skipped goose configure', /Skipping 'goose configure'/.test(r.out));
  check('no zip left in home (cwd)', !fs.readdirSync(home).some((f) => f.endsWith('.zip')));
  if (fs.existsSync(exe)) {
    const h = await run(exe, ['--help']);
    fs.writeFileSync(path.join(outDir, 'goose-help.txt'), h.out);
    check('identity: goose --help matches /usage:\\s*goose/i', ID_RE.test(h.out), `err=${h.err}`);
    const v = await run(exe, ['--version']);
    fs.writeFileSync(path.join(outDir, 'goose-version.txt'), v.out);
    const m = v.out.match(VERSION_RE);
    log(`goose --version raw=${JSON.stringify(v.out.trim())} err=${v.err}`);
    check('version read from goose --version', !!m, `version=${m ? m[1] : null}`);
    log(`bin dir files=${fs.readdirSync(path.dirname(exe)).join(',')}`);
  }

  // control arm — vendor default (no CONFIGURE=false); measured, not a gate
  const home2 = path.join(tmp, 'goose-iso-control');
  const env2 = isoEnv(home2, { GOOSE_BIN_DIR: path.join(home2, '.local', 'bin') });
  const r2 = await runInstaller(home2, env2, 120 * 1000);
  fs.writeFileSync(path.join(outDir, 'control-installer.txt'), r2.out.split(tmp).join('<TMP>'));
  log(`control (no CONFIGURE=false) exit=${r2.code} timedOut=${r2.timedOut} sec=${Math.round(r2.ms / 1000)} ranConfigure=${/Configuring goose/.test(r2.out)}`);

  log(ok ? 'VERDICT PASS' : 'VERDICT FAIL');
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => { log(`ERROR ${e && e.stack}`); fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n'); process.exit(1); });
