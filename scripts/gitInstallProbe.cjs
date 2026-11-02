// Git for Windows in the background: does AgentSpace's fixed winget recipe work on a machine WITHOUT Git?
//
// REPO RULE: no app source code here. This script repeats the app's RULE (AS-4656), not its code:
//   detect  — PATH + PATHEXT lookup, a candidate counts only if fs.statSync(p).isFile() (the app's
//             binResolve rule); `git --version` must print a version.
//   winget  — the same lookup for `winget`; if it misses, the user's WindowsApps alias checked with lstat
//             (run 41458473318 measured: on windows-2025 the alias exists but statSync says EACCES).
//   install — winget.exe <fixed argv> (no shell, hidden window, 10 min cap):
//             install --id Git.Git -e --source winget --scope user --silent --disable-interactivity
//                     --accept-package-agreements --accept-source-agreements
//   refresh — the running process does not see the installer's PATH change → read HKLM + HKCU
//             Environment\Path with reg.exe (read-only) and merge it into this process's PATH, then detect again.
//
// Arms:
//   clean   — remove the image's preinstalled Git (its own uninstaller, silent) → detection must say "absent".
//   nowinget— windows-2022 has no alias for the runner user: the rule must say "no winget" (the app then shows
//             its repair screen with the official download link). Then App Installer is registered (what every
//             Win10/11 desktop has) and the arms below run.
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
  // Like the app: execFile inside a Promise executor. A synchronous spawn throw is recorded, not fatal.
  try { execFile(file, argv, { env, windowsHide: true, timeout, maxBuffer: 16 << 20 }, (err, so, se) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : (err.killed ? null : err.code)) : 0,
    killed: !!(err && err.killed), ms: Date.now() - t0, out: `${so || ''}${se || ''}`,
  })); } catch (e) { resolve({ code: null, spawnError: String(e && e.message), killed: false, ms: Date.now() - t0, out: '' }); }
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
  log(`after uninstall: C:\\Program Files\\Git exists=${fs.existsSync('C:\\Program Files\\Git')} entries=${JSON.stringify(listDir('C:\\Program Files\\Git'))}`);
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
  /** The app's rule (kurulumGerekenler.wingetYolu): PATH lookup, else the WindowsApps alias via lstat. */
  const wingetRule = () => {
    const r = resolveBin('winget', env);
    if (r.state === 'present') return { path: r.path, via: 'path' };
    try { fs.lstatSync(alias); return { path: alias, via: 'alias-lstat' }; } catch { return null; }
  };
  let winget = wingetRule();
  result.winget = { pathLookup: resolveBin('winget', env), alias: { exists: fs.existsSync(alias), stat: aliasStat, lstat: aliasLstat, onPath: getPath(env).toLowerCase().includes('windowsapps') }, rule: winget };
  log(`winget ${JSON.stringify(result.winget)}`);
  if (!winget) {
    result.arms.nowinget = { rule: null, appResult: { durum: 'hata', adim: 'winget', error: 'git-yok' } };
    log('nowinget: the rule says no winget → app result {durum:hata, adim:winget, error:git-yok} → repair screen (git-eksik)');
    const w = await run('where.exe', ['winget'], env);
    log(`nowinget where.exe: code=${w.code} ${w.out.trim().slice(0, 200)}`);
    const reg = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe; (Get-AppxPackage Microsoft.DesktopAppInstaller).Version'], env, 5 * 60 * 1000);
    log(`parity: register App Installer code=${reg.code} ${reg.out.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    for (let i = 0; i < 15 && !winget; i += 1) { await new Promise((r) => setTimeout(r, 2000)); winget = wingetRule(); }
    if (!winget) {
      // Server 2022 image has no App Installer package at all: install Microsoft's own release (same version
      // as the windows-2025 image, v1.11.510) — the state of a stock Win10/11 desktop.
      const ps = [
        "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
        "$b='https://github.com/microsoft/winget-cli/releases/download/v1.11.510'",
        "$d=Join-Path $env:RUNNER_TEMP 'wg'; New-Item -ItemType Directory -Force $d | Out-Null",
        "Invoke-WebRequest \"$b/DesktopAppInstaller_Dependencies.zip\" -OutFile \"$d\\deps.zip\"",
        "Invoke-WebRequest \"$b/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle\" -OutFile \"$d\\wg.msixbundle\"",
        "Expand-Archive \"$d\\deps.zip\" \"$d\\deps\" -Force",
        "Get-ChildItem \"$d\\deps\\x64\\*.appx\" | ForEach-Object { Add-AppxPackage $_.FullName }",
        "Add-AppxPackage \"$d\\wg.msixbundle\"",
        "(Get-AppxPackage Microsoft.DesktopAppInstaller).Version",
      ].join('; ');
      const inst = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], env, 10 * 60 * 1000);
      log(`parity: official winget release v1.11.510 code=${inst.code} ${inst.out.replace(/\s+/g, ' ').trim().slice(-300)}`);
      for (let i = 0; i < 15 && !winget; i += 1) { await new Promise((r) => setTimeout(r, 2000)); winget = wingetRule(); }
      result.winget.parity = 'official-release-v1.11.510';
    }
    result.winget.afterRegister = winget;
    log(`winget after register ${JSON.stringify(winget)}`);
  }
  check('winget: the app rule finds winget', !!winget, JSON.stringify(winget));
  if (!winget) throw new Error('winget not found by the app rule');
  let wv = await run(winget.path, ['--version'], env);
  if (wv.spawnError) {
    // The app runs execFile inside a Promise executor: this throw rejects deps.run, calis() catches it and
    // the state becomes {durum:hata, error:git-yok} → repair screen (unit test: "spawn atarsa").
    result.arms.aliasSpawn = { error: wv.spawnError, app: { durum: 'hata', error: 'git-yok' } };
    log(`alias spawn failed: ${wv.spawnError} → app result {durum:hata, error:git-yok} → repair screen`);
    const loc = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage Microsoft.DesktopAppInstaller).InstallLocation'], env, 60000);
    const real = path.win32.join(loc.out.trim(), 'winget.exe');
    log(`probe-only: package path ${fs.existsSync(real) ? 'exists' : 'missing'} (not the app path)`);
    winget = { path: real, via: 'package-path-probe-only' };
    wv = await run(winget.path, ['--version'], env);
    if (wv.spawnError) { log(`package path spawn failed too: ${wv.spawnError}`); throw new Error('winget cannot start on this image'); }
  }
  log(`winget --version ${wv.out.trim()} via=${winget.via}`);

  const show = await run(winget.path, ['show', '--id', 'Git.Git', '-e', '--source', 'winget', '--scope', 'user', '--accept-source-agreements', '--disable-interactivity'], env, 120000);
  const showLines = show.out.split(/\r?\n/).filter((l) => /^\s*(Version|Installer|  Installer Type|  Installer Url|  Scope|Found)/i.test(l) || /scope|installer/i.test(l)).map((l) => l.trim()).slice(0, 12);
  result.wingetShow = { code: show.code, lines: showLines };
  log(`winget show --scope user code=${show.code} ${JSON.stringify(showLines)}`);

  // main: the app's exact argv
  const m = await run(winget.path, [...ARGV], env, WINGET_MS);
  const mCode = wingetCode(m);
  log(`main winget code=${m.code} result=${mCode} ms=${m.ms}`);
  const said = m.out.split(/[\r\n]+/).map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter((l) => l.length > 3 && !/^[-\\|/ ]+$/.test(l) && !/^[\d.]+ (KB|MB)/.test(l));
  result.mainSaid = said.slice(0, 15);
  log(`main winget said: ${JSON.stringify(said.slice(0, 15))}`);
  if (mCode === 'ok') setPath(env, merge(getPath(env), registryPath()));
  const after = await gitState(env);
  result.arms.main = { winget: { code: m.code, result: mCode, ms: m.ms }, git: after };
  check('main: winget user-scope install exit ok', mCode === 'ok', String(m.code));
  check('main: after the registry PATH refresh Git is present with a version', after.state === 'present' && !!after.version, JSON.stringify(after));
  const scope = after.state === 'present' && after.path.toLowerCase().startsWith(home.toLowerCase()) ? 'user' : 'machine';
  result.arms.main.scope = scope;
  log(`main: installed scope = ${scope} (${after.path || '-'})`);
  // Claude Code finds Git Bash in either Git for Windows location (the app's gitBashAdaylari list holds both).
  const bashes = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe'];
  const bash = bashes.find((b) => fs.existsSync(b)) || null;
  result.arms.main.gitBash = bash;
  check('main: Git Bash present in a Git for Windows location', !!bash, bash || '');
  const hkcu = regPath('HKCU\\Environment') || '';
  const hklm = regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') || '';
  result.arms.main.pathWritten = { user: /\\git\\cmd/i.test(hkcu), machine: /\\git\\cmd/i.test(hklm) };
  check('main: the installer wrote a registry PATH the refresh reads (HKCU or HKLM)', /\\git\\cmd/i.test(hkcu + ';' + hklm), JSON.stringify(result.arms.main.pathWritten));

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
