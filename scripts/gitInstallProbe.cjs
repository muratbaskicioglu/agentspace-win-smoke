// Git for Windows in the background: does AgentSpace's fixed winget recipe work on a machine WITHOUT Git?
//
// REPO RULE: no app source code here. This script repeats the app's RULE (AS-4656), not its code:
//   detect  — PATH + PATHEXT lookup, a candidate counts only if fs.statSync(p).isFile() (the app's
//             binResolve rule); `git --version` must print a version.
//   winget  — the same lookup for `winget` (an App Execution Alias in WindowsApps — does statSync see it?).
//   install — winget.exe <fixed argv> (no shell, hidden window, 10 min cap):
//             install --id Git.Git -e --source winget --scope user --silent --disable-interactivity
//                     --accept-package-agreements --accept-source-agreements
//   refresh — the running process does not see the installer's PATH change → read HKLM + HKCU
//             Environment\Path with reg.exe (read-only) and merge it into this process's PATH, then detect again.
//
// Arms:
//   clean   — remove the image's preinstalled Git (its own uninstaller, silent) → detection must say "absent".
//   main    — the app's exact argv (user scope) → Git present after the PATH refresh, git.exe under the
//             user profile (no admin rights needed).
//   card    — measured only if `main` fails: the card's line without --scope user / --silent (machine scope).
//   fs      — <home>\.local\bin and the npm global prefix listed before and after: an engine whose
//             "Connect" was not pressed gets nothing.
//
//   node gitInstallProbe.cjs --out <dir>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

const outDir = path.resolve(process.argv[process.argv.indexOf('--out') + 1] || 'git-install');
fs.mkdirSync(outDir, { recursive: true });
const ARGV = Object.freeze(['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--scope', 'user', '--silent',
  '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements']);
const CARD_ARGV = Object.freeze(['install', '--id', 'Git.Git', '-e', '--source', 'winget',
  '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']);
const WINGET_MS = 10 * 60 * 1000;
const ALREADY = new Set([-1978335189, 0x8a15002b, -1978335212, 0x8a150014]);
const NET_RE = /internet|network|download|0x80072ee7|0x80072efd|0x80072f8f|0x8a150008|0x80190194|could not resolve|ENOTFOUND/i;
const lines = [];
const result = { runner: process.env.RUNNER_NAME || null, image: process.env.ImageOS || null, os: os.release(), arms: {} };
const home = os.homedir();
const log = (s) => { const t = `GITWIN ${String(s).split(home).join('<HOME>')}`; console.log(t); lines.push(t); };

const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
const getPath = (env) => env[pathKey(env)] || '';
function setPath(env, v) { for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]; env.Path = v; }
function merge(a, b) {
  const parts = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);
  const out = parts(a);
  const seen = new Set(out.map((x) => x.replace(/\\+$/, '').toLowerCase()));
  for (const x of parts(b)) { const k = x.replace(/\\+$/, '').toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out.join(';');
}

/** The app's rule: PATH + PATHEXT, statSync().isFile(); unexpected fs error = "unknown". */
function resolveBin(name, env) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const errors = [];
  for (const dir of getPath(env).split(';')) {
    const d = dir.replace(/^"|"$/g, '').trim();
    if (!d) continue;
    for (const ext of exts) {
      const p = path.win32.join(d, name + ext);
      try {
        if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.F_OK); return { state: 'present', path: p }; }
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(e.code)) errors.push(`${p}:${e.code}`);
      }
    }
  }
  return errors.length ? { state: 'unknown', errors } : { state: 'absent' };
}

const run = (file, argv, env, timeout = 20000) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile(file, argv, { env, windowsHide: true, timeout, maxBuffer: 16 << 20 }, (err, so, se) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : (err.killed ? null : err.code)) : 0,
    killed: !!(err && err.killed), ms: Date.now() - t0, out: `${so || ''}${se || ''}`,
  }));
});

async function gitState(env) {
  const r = resolveBin('git', env);
  if (r.state !== 'present') return r;
  const v = await run(r.path, ['--version'], env);
  const m = /git version (\S+)/.exec(v.out || '');
  return m ? { state: 'present', path: r.path, version: m[1] } : { state: 'unknown', path: r.path, out: v.out.slice(0, 200) };
}

function regPath(key) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? `%${n}%`) : null;
  } catch { return null; }
}
const registryPath = () => [regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), regPath('HKCU\\Environment')].filter(Boolean).join(';');

function listDir(d) {
  try { return fs.readdirSync(d).sort(); } catch (e) { return `(${e.code})`; }
}
async function fsSnapshot(env) {
  const npm = await run('cmd.exe', ['/d', '/s', '/c', 'npm prefix -g'], env);
  const prefix = (npm.out || '').trim().split(/\r?\n/).pop();
  return {
    localBin: listDir(path.join(home, '.local', 'bin')),
    npmPrefix: prefix ? prefix.split(home).join('<HOME>') : null,
    npmPrefixList: prefix ? listDir(prefix) : null,
    npmModules: prefix ? listDir(path.join(prefix, 'node_modules')) : null,
  };
}

function wingetCode(r) {
  if (r.code === 0 || ALREADY.has(r.code)) return 'ok';
  if (r.killed) return 'timeout';
  if (NET_RE.test(r.out)) return 'net';
  return 'fail';
}

(async () => {
  const env = { ...process.env };
  let failed = 0;
  const check = (name, cond, extra = '') => { log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` · ${extra}` : ''}`); if (!cond) failed += 1; };

  // fs before (Connect was never pressed for any engine)
  result.fsBefore = await fsSnapshot(env);
  log(`fs before ${JSON.stringify(result.fsBefore)}`);

  // clean: remove the image's Git with its own uninstaller
  const pre = await gitState(env);
  log(`git on image: ${JSON.stringify(pre)}`);
  const unins = 'C:\\Program Files\\Git\\unins000.exe';
  if (fs.existsSync(unins)) {
    const u = await run(unins, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], env, 5 * 60 * 1000);
    log(`uninstall image Git code=${u.code} ms=${u.ms}`);
    for (let i = 0; i < 30 && fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe'); i += 1) await new Promise((r) => setTimeout(r, 2000));
  }
  // Any other git.exe left on PATH (tool caches) is dropped from THIS process's PATH only.
  for (let i = 0; i < 5; i += 1) {
    const r = resolveBin('git', env);
    if (r.state !== 'present') break;
    log(`drop leftover PATH dir ${path.win32.dirname(r.path)}`);
    setPath(env, getPath(env).split(';').filter((x) => x.replace(/\\+$/, '').toLowerCase() !== path.win32.dirname(r.path).toLowerCase()).join(';'));
  }
  const clean = await gitState(env);
  result.arms.clean = clean;
  check('clean: detection says Git is absent', clean.state === 'absent', JSON.stringify(clean));

  // winget lookup with the app's rule, plus raw facts about the alias
  const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
  let aliasStat = null;
  try { const s = fs.statSync(alias); aliasStat = { isFile: s.isFile(), size: s.size }; } catch (e) { aliasStat = { error: e.code }; }
  let aliasLstat = null;
  try { const s = fs.lstatSync(alias); aliasLstat = { isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink() }; } catch (e) { aliasLstat = { error: e.code }; }
  const winget = resolveBin('winget', env);
  result.winget = { resolve: winget, alias: { exists: fs.existsSync(alias), stat: aliasStat, lstat: aliasLstat, onPath: getPath(env).toLowerCase().includes('windowsapps') } };
  log(`winget ${JSON.stringify(result.winget)}`);
  check('winget: the app rule (PATH + statSync.isFile) finds winget', winget.state === 'present', JSON.stringify(winget));
  if (winget.state !== 'present') throw new Error('winget not found by the app rule');
  const wv = await run(winget.path, ['--version'], env);
  log(`winget --version ${wv.out.trim()}`);

  // main: the app's exact argv
  const m = await run(winget.path, [...ARGV], env, WINGET_MS);
  const mCode = wingetCode(m);
  log(`main winget code=${m.code} result=${mCode} ms=${m.ms}`);
  log(`main winget tail: ${m.out.replace(/[\r\n]+/g, ' | ').replace(/[^\x20-\x7e|]/g, '').slice(-600)}`);
  if (mCode === 'ok') setPath(env, merge(getPath(env), registryPath()));
  const after = await gitState(env);
  result.arms.main = { winget: { code: m.code, result: mCode, ms: m.ms }, git: after };
  check('main: winget user-scope install exit ok', mCode === 'ok', String(m.code));
  check('main: after the registry PATH refresh Git is present with a version', after.state === 'present' && !!after.version, JSON.stringify(after));
  check('main: git.exe is under the user profile (user scope, no admin)', after.state === 'present' && after.path.toLowerCase().startsWith(home.toLowerCase()), after.path || '');
  const bash = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe');
  result.arms.main.gitBash = fs.existsSync(bash);
  check('main: Git Bash present where Claude Code looks (%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe)', fs.existsSync(bash));
  const hkcu = regPath('HKCU\\Environment') || '';
  check('main: the installer wrote the user PATH (HKCU)', /programs\\git\\cmd/i.test(hkcu), hkcu.split(home).join('<HOME>').slice(0, 200));

  // card: only if main failed — is the card's machine-scope line any better?
  if (mCode !== 'ok') {
    const c = await run(winget.path, [...CARD_ARGV], env, WINGET_MS);
    setPath(env, merge(getPath(env), registryPath()));
    result.arms.card = { winget: { code: c.code, result: wingetCode(c), ms: c.ms }, git: await gitState(env) };
    log(`card arm ${JSON.stringify(result.arms.card)}`);
  }

  // fs after
  result.fsAfter = await fsSnapshot(env);
  log(`fs after ${JSON.stringify(result.fsAfter)}`);
  check('fs: <home>\\.local\\bin unchanged (no engine installed)', JSON.stringify(result.fsBefore.localBin) === JSON.stringify(result.fsAfter.localBin));
  check('fs: npm global prefix unchanged (no engine installed)', JSON.stringify(result.fsBefore.npmModules) === JSON.stringify(result.fsAfter.npmModules));

  result.failed = failed;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1).split(home).join('<HOME>'));
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), `${lines.join('\n')}\n`);
  log(failed ? `${failed} FAIL` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  log(`ERROR ${e && e.message}`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1).split(home).join('<HOME>'));
  fs.writeFileSync(path.join(outDir, 'evidence.txt'), `${lines.join('\n')}\n`);
  process.exit(2);
});
