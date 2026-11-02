// Grok Build CLI on macOS / Linux: the npm install AgentSpace runs, then `grok login` with the
// app's process shape, up to the login screen (NEVER completed).
//
// REPO RULE: no app source code here. This script repeats only PUBLIC commands:
//   npm install -g --prefix <home>/.local @xai-official/grok@<pin>
//   grok login   — no shell, stdio all pipes, cwd = the (throwaway) user home,
//                  BROWSER set (the app sets /usr/bin/true; here a recorder that only logs that
//                  it was called), XAI_API_KEY removed, GROK_HOME unset (default <home>/.grok).
//
// NO ACCOUNT, NO KEY, NO PAID CALL. The login is time-boxed and killed; nobody approves it.
// Sign-in URLs / codes are masked.
//
//   node grokLoginProbePosix.cjs --out <dir> [--version 1.0.70]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const outDir = arg('--out');
const PIN = arg('--version', '1.0.70');
if (!/^\d+\.\d+\.\d+$/.test(PIN)) throw new Error('bad --version');
fs.mkdirSync(outDir, { recursive: true });
const tmp = process.env.RUNNER_TEMP;
const lines = [];
const mask = (s) => String(s)
  .split(tmp).join('<TMP>')
  .replace(/https?:\/\/[^\s"'<>]+/g, (u) => { try { const x = new globalThis.URL(u); return `${x.origin}${x.pathname}${x.search ? '?<masked>' : ''}`; } catch { return '<url>'; } })
  .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '<CODE>');
const log = (s) => { const t = `GROKPOSIX ${mask(s)}`; console.log(t); lines.push(t); };

const home = path.join(tmp, 'grok-iso-posix');
fs.mkdirSync(home, { recursive: true });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(GROK_|XAI_)/i.test(k)) env[k] = v;
const marker = path.join(home, 'browser-called.txt');
const recorder = path.join(home, 'browser-recorder.sh');
fs.writeFileSync(recorder, `#!/bin/sh\necho called >> "${marker}"\n`, { mode: 0o755 });
Object.assign(env, { HOME: home, BROWSER: recorder, npm_config_cache: path.join(home, '.npm') });

function runTimed(file, argv, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const c = spawn(file, argv, { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    c.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    c.stderr.on('data', (d) => { out = (out + d).slice(-8000); });
    c.on('error', (e) => { out += `\nspawn error: ${e.message}`; });
    const timer = setTimeout(() => {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, timedOut: true, ms: Date.now() - t0, out });
    }, timeoutMs);
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut: false, ms: Date.now() - t0, out }); });
  });
}

function browserPids() {
  try {
    const o = execFileSync('ps', ['-axo', 'pid=,comm=']).toString();
    return new Set(o.split('\n').filter((l) => /Safari|Google Chrome|firefox|chrome|msedge/i.test(l)).map((l) => l.trim().split(/\s+/)[0]));
  } catch { return new Set(); }
}

(async () => {
  let ok = true;
  const check = (name, cond, more = '') => { log(`${cond ? 'PASS' : 'FAIL'} ${name}${more ? ` — ${more}` : ''}`); if (!cond) ok = false; };
  log(`os=${process.platform} ${execFileSync('uname', ['-srm']).toString().trim()} node=${process.version} pin=${PIN}`);

  const prefix = path.join(home, '.local');
  const i = await runTimed('npm', ['install', '-g', '--prefix', prefix, `@xai-official/grok@${PIN}`], 8 * 60 * 1000);
  fs.writeFileSync(path.join(outDir, 'npm-install.txt'), mask(i.out));
  log(`npm install exit=${i.code} sec=${Math.round(i.ms / 1000)}`);
  const exe = path.join(prefix, 'bin', 'grok');
  check('npm install exit 0 and <home>/.local/bin/grok exists', i.code === 0 && fs.existsSync(exe));
  if (!fs.existsSync(exe)) { log('VERDICT FAIL'); fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n'); process.exit(1); }

  const v = await runTimed(exe, ['--version'], 20000);
  log(`grok --version raw=${JSON.stringify(v.out.trim())}`);
  check(`identity + pinned version ${PIN}`, /^grok \d/.test(v.out.trim()) && v.out.includes(`grok ${PIN}`));
  check('no auth.json after install', !fs.existsSync(path.join(home, '.grok', 'auth.json')));

  const before = browserPids();
  const l = await runTimed(exe, ['login'], 25000);
  const after = browserPids();
  const newBrowsers = [...after].filter((p) => !before.has(p)).length;
  fs.writeFileSync(path.join(outDir, 'login.txt'), mask(l.out));
  log(`login exit=${l.code} timedOut=${l.timedOut} sec=${Math.round(l.ms / 1000)} BROWSERcalled=${fs.existsSync(marker)} newBrowserProcesses=${newBrowsers}`);
  log(`login output (masked): ${JSON.stringify(mask(l.out).slice(0, 600))}`);
  check('login reached the sign-in screen (prints an auth URL)', /https?:\/\//.test(l.out));
  check('no auth.json after the unapproved login (runner never signed in)', !fs.existsSync(path.join(home, '.grok', 'auth.json')));

  log(ok ? 'VERDICT PASS' : 'VERDICT FAIL');
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => { log(`ERROR ${e && e.stack}`); fs.writeFileSync(path.join(outDir, 'evidence.txt'), lines.join('\n') + '\n'); process.exit(1); });
