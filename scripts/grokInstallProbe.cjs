// Grok Build CLI on Windows: does the vendor's PowerShell installer work the way AgentSpace runs it,
// and does the sign-in start (up to the login screen, NEVER completed)?
//
// REPO RULE: no app source code here. This script repeats only the PUBLIC vendor command
// (https://x.ai/cli/install.ps1, the Windows path in the Grok Build docs) with the same process
// shape the app uses:
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy ByPass -Command "irm '<url>' | iex"
//   no shell, hidden window, stdin closed, cwd = the (throwaway) user home,
//   env GROK_VERSION=<pinned>, XAI_API_KEY removed.
// Then it checks the identity (`grok --version` must match /^grok \d/) and the pinned version.
//
// NO ACCOUNT, NO KEY, NO PAID CALL. Sign-in arms are time-boxed and their child tree is killed;
// nobody approves them, so the runner never signs in. Sign-in URLs / device codes are masked.
//
// Arms:
//   main    — install with the app's process shape → grok.exe location, identity, pinned version
//   argv    — flags the app passes (--no-auto-update --always-approve --rules --no-subagents) + --version
//   status  — no auth.json after install (the app reads sign-in state from this file only)
//   unsigned— `grok -p hi` without sign-in → must say "Not signed in" (measured, not used by the app)
//   login   — `grok login` (the app's «Bağla» argv): what it prints in 25 s, and whether a browser
//             process appears (does the CLI open the browser itself?)
//   device  — `grok login --device-code` (fallback): does it print a code + URL in 25 s?
//
//   node grokInstallProbe.cjs --out <dir> [--version 1.0.70]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const outDir = arg('--out');
const PIN = arg('--version', '1.0.70');
if (!/^\d+\.\d+\.\d+$/.test(PIN)) throw new Error('bad --version');
fs.mkdirSync(outDir, { recursive: true });
const URL = 'https://x.ai/cli/install.ps1';
const ARGV = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'ByPass', '-Command', `irm '${URL}' | iex`];
const ID_RE = /^grok \d/;
const tmp = process.env.RUNNER_TEMP;
const lines = [];
const mask = (s) => String(s)
  .split(tmp).join('<TMP>')
  .replace(/https?:\/\/[^\s"'<>]+/g, (u) => { try { const x = new globalThis.URL(u); return `${x.origin}${x.pathname}${x.search ? '?<masked>' : ''}`; } catch { return '<url>'; } })
  .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '<CODE>');
const log = (s) => { const t = `GROKWIN ${mask(s)}`; console.log(t); lines.push(t); };

function isoEnv(home, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GROK_|XAI_)/i.test(k)) env[k] = v;
  const local = path.join(home, 'AppData', 'Local');
  const roaming = path.join(home, 'AppData', 'Roaming');
  for (const d of [local, roaming, path.join(local, 'Temp')]) fs.mkdirSync(d, { recursive: true });
  return { ...env, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: roaming, TEMP: path.join(local, 'Temp'), TMP: path.join(local, 'Temp'), ...extra };
}

function runTimed(file, argv, env, cwd, timeoutMs, stdin = 'ignore') {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const c = spawn(file, argv, { env, cwd, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
    c.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    c.stderr.on('data', (d) => { out = (out + d).slice(-8000); });
    c.on('error', (e) => { out += `\nspawn error: ${e.message}`; });
    const timer = setTimeout(() => {
      try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
      resolve({ code: null, timedOut: true, ms: Date.now() - t0, out });
    }, timeoutMs);
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false, ms: Date.now() - t0, out }); });
  });
}

const run = (bin, args, env) => new Promise((resolve) => {
  execFile(bin, args, { env, windowsHide: true, timeout: 20000 }, (err, so, se) => resolve({ err: err ? (err.code ?? err.message) : null, out: `${so || ''}${se || ''}` }));
});

function browserPids() {
  try {
    const o = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process msedge,chrome,firefox -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"]).toString();
    return new Set(o.split(/\s+/).filter(Boolean));
  } catch { return new Set(); }
}

(async () => {
  let ok = true;
  const check = (name, cond, more = '') => { log(`${cond ? 'PASS' : 'FAIL'} ${name}${more ? ` — ${more}` : ''}`); if (!cond) ok = false; };
  const os = execFileSync('powershell.exe', ['-NoProfile', '-Command', '$o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption) build $($o.BuildNumber) arch $env:PROCESSOR_ARCHITECTURE"']).toString().trim();
  log(`os=${os} node=${process.version} pin=${PIN}`);

  // main arm
  const home = path.join(tmp, 'grok-iso-main');
  const env = isoEnv(home, { GROK_VERSION: PIN });
  const exe = path.join(home, '.grok', 'bin', 'grok.exe');
  log(`main before grok.exe=${fs.existsSync(exe)}`);
  const r = await runTimed('powershell.exe', ARGV, env, home, 8 * 60 * 1000);
  log(`main installer exit=${r.code} timedOut=${r.timedOut} sec=${Math.round(r.ms / 1000)}`);
  fs.writeFileSync(path.join(outDir, 'main-installer.txt'), mask(r.out));
  check('installer exit 0', r.code === 0 && !r.timedOut);
  check('grok.exe in <home>\\.grok\\bin (app PATH list: %USERPROFILE%\\.grok\\bin)', fs.existsSync(exe));
  const realProfileExe = path.join(process.env.USERPROFILE || '', '.grok', 'bin', 'grok.exe');
  log(`installer honoured the isolated USERPROFILE=${fs.existsSync(exe)} · runner's real profile has grok.exe=${fs.existsSync(realProfileExe)}`);
  if (fs.existsSync(path.dirname(exe))) log(`bin dir files=${fs.readdirSync(path.dirname(exe)).join(',')}`);
  if (!fs.existsSync(exe)) {
    log('VERDICT FAIL');
    fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n');
    process.exit(1);
  }

  const v = await run(exe, ['--version'], env);
  fs.writeFileSync(path.join(outDir, 'grok-version.txt'), v.out);
  log(`grok --version raw=${JSON.stringify(v.out.trim())} err=${v.err}`);
  check('identity: grok --version matches /^grok \\d/', ID_RE.test(v.out.trim()));
  check(`pinned version ${PIN} installed (GROK_VERSION honoured)`, v.out.includes(`grok ${PIN} `) || v.out.trim() === `grok ${PIN}`);

  // argv arm — flags the app passes, parsed without starting a model turn
  const a = await run(exe, ['--no-auto-update', '--always-approve', '--no-subagents', '--rules', 'x', '--version'], env);
  check('app argv accepted (--no-auto-update --always-approve --no-subagents --rules)', ID_RE.test(a.out.trim()), JSON.stringify(a.out.trim()));
  const bogus = await run(exe, ['--bogus-flag', '--version'], env);
  check('control: unknown flag is rejected', !ID_RE.test(bogus.out.trim()), JSON.stringify(bogus.out.trim().split('\n')[0]));

  // status arm — the app reads only $GROK_HOME/auth.json (default <home>\.grok)
  check('no auth.json after install (app shows "not connected")', !fs.existsSync(path.join(home, '.grok', 'auth.json')));
  log(`.grok entries=${fs.readdirSync(path.join(home, '.grok')).join(',')}`);

  // control: a top-level flag AFTER the subcommand is rejected (why the app must never append
  // defaultArgs to the login argv)
  const lc = await run(exe, ['login', '--no-auto-update', '--help'], env);
  log(`control: \`grok login --no-auto-update\` → ${JSON.stringify(lc.out.trim().split('\n')[0])} err=${lc.err}`);

  // unsigned arm (measured only)
  const u = await runTimed(exe, ['-p', 'hi', '--no-auto-update', '--output-format', 'streaming-messages-json'], env, home, 30000);
  fs.writeFileSync(path.join(outDir, 'unsigned-p.txt'), mask(u.out));
  check('unsigned -p says "Not signed in"', /Not signed in/.test(u.out), `exit=${u.code} timedOut=${u.timedOut}`);

  // login arm — the app's «Bağla» argv EXACTLY (`grok login`, stdio all pipes like the app;
  // top-level flags such as --no-auto-update are rejected after the subcommand — run 41429704312).
  const before = browserPids();
  const l = await runTimed(exe, ['login'], env, home, 25000, 'pipe');
  const after = browserPids();
  const newBrowsers = [...after].filter((p) => !before.has(p)).length;
  fs.writeFileSync(path.join(outDir, 'login.txt'), mask(l.out));
  log(`login exit=${l.code} timedOut=${l.timedOut} sec=${Math.round(l.ms / 1000)} newBrowserProcesses=${newBrowsers}`);
  log(`login output (masked): ${JSON.stringify(mask(l.out).slice(0, 600))}`);
  check('login reached the sign-in screen (prints an auth URL or waits for the browser)', /https?:\/\//.test(l.out) || l.timedOut);
  check('no auth.json after the unapproved login (runner never signed in)', !fs.existsSync(path.join(home, '.grok', 'auth.json')));

  // device-code arm (fallback) — time-boxed, never approved.
  const d = await runTimed(exe, ['login', '--device-auth'], env, home, 25000, 'pipe');
  fs.writeFileSync(path.join(outDir, 'login-device-code.txt'), mask(d.out));
  log(`device-code exit=${d.code} timedOut=${d.timedOut} output (masked): ${JSON.stringify(mask(d.out).slice(0, 600))}`);

  log(ok ? 'VERDICT PASS' : 'VERDICT FAIL');
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => { log(`ERROR ${e && e.stack}`); fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n'); process.exit(1); });
