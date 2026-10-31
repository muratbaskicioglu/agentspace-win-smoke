// Does `codex login` open the system browser BY ITSELF, and does it honour the BROWSER
// environment variable? Measured per platform on a throwaway CODEX_HOME.
// It never completes a sign-in (no account, nobody clicks), and it writes the sign-in
// address only as scheme://host/path plus the NAMES of the query parameters.
//
//   node scripts/codexBrowserProbe.cjs --codex-js <.../@openai/codex/bin/codex.js> \
//     --label <codex version> --out <dir> [--wait 12]
//
// Arms, in this order. Every arm starts with no browser of ours running and ends by
// closing the browsers it started:
//   idle      nothing runs for --wait s                      -> baseline, must be 0 starts
//   logger    BROWSER=<logger script> codex login            -> is the logger called with the
//                                                               address? does a browser start?
//   app-env   the environment the app gives `codex login`:
//               macOS / Linux  BROWSER=/usr/bin/true
//               Windows        BROWSER unset
//   unset     BROWSER unset (macOS / Linux only; on Windows this is app-env)
//   positive  the OS opener on a harmless address (open / xdg-open / start)
//                                                            -> the detector sees a browser start
// Exit: 0 measured, 2 could not measure.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const A = { codexJs: null, label: 'codex', out: 'codex-browser', wait: 12 };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]; const n = process.argv[i + 1];
  if (k === '--codex-js') { A.codexJs = n; i++; }
  else if (k === '--label') { A.label = n; i++; }
  else if (k === '--out') { A.out = n; i++; }
  else if (k === '--wait') { A.wait = Number(n) || 12; i++; }
}
// Fuse: this probe starts real browsers and closes every browser it finds. It must only run
// on a throwaway CI runner, never on a person's computer.
if (process.env.GITHUB_ACTIONS !== 'true') { console.error('refusing to run outside GitHub Actions'); process.exit(2); }
if (!A.codexJs || !fs.existsSync(A.codexJs)) { console.error(`--codex-js missing or not found: ${A.codexJs}`); process.exit(2); }
fs.mkdirSync(A.out, { recursive: true });

const PLAT = process.platform;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSITIVE_URL = 'https://example.com/?agentspace-probe=positive-control';

// Keep only scheme://host/path and the NAMES of the query parameters.
function shape(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}${u.search ? ` ?${[...u.searchParams.keys()].join('&')}` : ''}`; }
  catch { return url ? '<not a url>' : null; }
}
const maskText = (t) => String(t || '').replace(/https?:\/\/[^\s'"]+/g, (u) => shape(u.replace(/[.,;:!?)\]}]+$/, '')));

// ── browser process detector ───────────────────────────────────────────────
const BROWSER_RE = {
  darwin: /\/(Safari|Google Chrome|Firefox|firefox|Microsoft Edge|Chromium|Brave Browser)$/,
  linux: /(^|\/)(firefox|firefox-bin|chrome|google-chrome[a-z-]*|chromium[a-z-]*|xdg-open|sensible-browser|x-www-browser|www-browser|gio|kde-open[0-9]*|w3m|lynx|links|elinks|epiphany)( |$)/,
  win32: /^(msedge|chrome|firefox|iexplore|brave)\.exe$/i,
};
function listProcs() {
  if (PLAT === 'win32') {
    const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    return String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => {
      const c = l.split('","').map((s) => s.replace(/^"|"$/g, ''));
      return { pid: Number(c[1]), name: c[0], cmd: c[0] };
    }).filter((p) => p.pid);
  }
  const fmt = PLAT === 'darwin' ? 'pid=,comm=' : 'pid=,args=';
  const r = spawnSync('ps', PLAT === 'darwin' ? ['-axo', fmt] : ['-eo', fmt], { encoding: 'utf8' });
  return String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), name: path.basename(m[2].split(' ')[0]), cmd: m[2] } : null;
  }).filter(Boolean);
}
const isBrowser = (p) => (PLAT === 'win32' ? BROWSER_RE.win32.test(p.name) : BROWSER_RE[PLAT].test(p.cmd));
const browserProcs = () => listProcs().filter(isBrowser).filter((p) => p.pid !== process.pid);

// macOS: tab addresses of Safari / Chrome (only if already running — `tell application`
// would otherwise START the browser and fake a result).
function macTabs(running) {
  const out = {};
  const apps = [['Safari', 'URL of every tab of every window'], ['Google Chrome', 'URL of every tab of every window']];
  for (const [app, q] of apps) {
    if (!running.some((p) => p.cmd.endsWith(`/${app}`))) continue;
    const r = spawnSync('osascript', ['-e', `tell application "${app}" to get ${q}`], { encoding: 'utf8', timeout: 10000 });
    out[app] = r.status === 0
      ? String(r.stdout || '').trim().split(/,\s*/).filter(Boolean).map(shape)
      : { error: (String(r.stderr || '').trim() || `exit ${r.status}`).slice(0, 200) };
  }
  return out;
}

function closeBrowsers(pids) {
  if (!pids.length) return;
  if (PLAT === 'darwin') {
    for (const app of ['Safari', 'Google Chrome', 'Firefox', 'Microsoft Edge']) {
      if (browserProcs().some((p) => p.cmd.endsWith(`/${app}`))) spawnSync('osascript', ['-e', `tell application "${app}" to quit`], { timeout: 10000 });
    }
  }
  for (const pid of pids) {
    try {
      if (PLAT === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
      else process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
}
async function waitNoBrowsers(ms = 8000) {
  const end = Date.now() + ms;
  let left = browserProcs();
  while (left.length && Date.now() < end) { await sleep(500); left = browserProcs(); }
  for (const p of left) { try { if (PLAT === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)]); else process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
  return browserProcs().map((p) => p.name);
}

function screenshot(name) {
  const file = path.join(A.out, `${A.label}-${name}.png`);
  if (PLAT === 'darwin') spawnSync('screencapture', ['-x', file], { timeout: 10000 });
  else if (PLAT === 'linux' && process.env.DISPLAY) spawnSync('import', ['-display', process.env.DISPLAY, '-window', 'root', file], { timeout: 10000 });
  return fs.existsSync(file) && fs.statSync(file).size > 0 ? path.basename(file) : null;
}

// ── one arm ────────────────────────────────────────────────────────────────
function loggerScript(dir, logFile) {
  if (PLAT === 'win32') {
    const f = path.join(dir, 'browser-logger.cmd');
    fs.writeFileSync(f, `@echo off\r\necho %*>>"${logFile}"\r\n`);
    return f;
  }
  const f = path.join(dir, 'browser-logger.sh');
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logFile}'\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (PLAT === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* gone */ }
}

async function arm(name, mode) {
  const r = { arm: name, platform: PLAT, codex: A.label };
  const before = browserProcs();
  r.browsersBefore = before.map((p) => p.name);
  const seen = new Map();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cbp-${name}-`));
  const logFile = path.join(base, 'browser-calls.txt');
  let child = null;
  let out = '';
  const t0 = Date.now();

  if (mode === 'codex') {
    const codexHome = path.join(base, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const env = { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' };
    delete env.BROWSER;
    if (name === 'logger') env.BROWSER = loggerScript(base, logFile);
    if (name === 'app-env' && PLAT !== 'win32') env.BROWSER = '/usr/bin/true';
    r.browserEnv = env.BROWSER ? (name === 'logger' ? '<logger script>' : env.BROWSER) : '<unset>';
    child = spawn(process.execPath, [A.codexJs, 'login'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: PLAT !== 'win32', windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // wait for the sign-in address
    while (Date.now() - t0 < 30000 && !/oauth\/authorize\S*code_challenge/.test(out) && child.exitCode === null) await sleep(100);
    r.authUrlSeenAfterMs = /oauth\/authorize/.test(out) ? Date.now() - t0 : null;
  } else if (mode === 'positive') {
    const cmd = PLAT === 'darwin' ? ['open', [POSITIVE_URL]]
      : PLAT === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', POSITIVE_URL]]
      : ['xdg-open', [POSITIVE_URL]];
    r.opener = `${cmd[0]} ${shape(POSITIVE_URL)}`;
    const o = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    r.openerExit = o.status;
  }

  // watch for browser starts (short-lived ones like xdg-open too)
  const end = Date.now() + A.wait * 1000;
  while (Date.now() < end) {
    for (const p of browserProcs()) if (!before.some((b) => b.pid === p.pid) && !seen.has(p.pid)) seen.set(p.pid, { name: p.name, atMs: Date.now() - t0 });
    await sleep(250);
  }
  r.browserStarts = [...seen.values()];
  r.browserStarted = r.browserStarts.length > 0;
  const nowRunning = browserProcs();
  if (PLAT === 'darwin') r.tabs = macTabs(nowRunning);
  r.frame = screenshot(name);
  r.loggerCalls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(maskText) : [];
  if (child) {
    r.codexStillRunning = child.exitCode === null;
    r.codexOutput = maskText(out).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
    killTree(child);
    await sleep(800);
    r.authJsonCreated = fs.existsSync(path.join(base, 'codex-home', 'auth.json'));
  }
  closeBrowsers(nowRunning.filter((p) => !before.some((b) => b.pid === p.pid)).map((p) => p.pid));
  r.browsersLeftAfterClose = await waitNoBrowsers();
  fs.rmSync(base, { recursive: true, force: true });
  return r;
}

(async () => {
  const res = { platform: PLAT, arch: process.arch, os: os.release(), node: process.version, codex: A.label, arms: [] };
  const v = spawnSync(process.execPath, [A.codexJs, '--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  res.codexVersion = String(v.stdout || v.stderr || '').trim().split('\n')[0];
  if (PLAT === 'darwin') {
    const d = spawnSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'], { encoding: 'utf8' });
    const m = String(d.stdout || '').match(/LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https;/);
    res.defaultHttpsHandler = m ? m[1] : '<not set: system default (Safari)>';
  }
  res.leftoverAtStart = await waitNoBrowsers();
  const plan = [['idle', 'idle'], ['logger', 'codex'], ['app-env', 'codex']];
  if (PLAT !== 'win32') plan.push(['unset', 'codex']);
  plan.push(['positive', 'positive']);
  for (const [name, mode] of plan) {
    const r = await arm(name, mode);
    res.arms.push(r);
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(A.out, `${A.label}.json`), JSON.stringify(res, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
