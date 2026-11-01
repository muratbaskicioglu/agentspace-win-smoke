'use strict';
// Engine-path probe for the INSTALLED AgentSpace app.
//
// Runs with the app's own binary in Node mode (ELECTRON_RUN_AS_NODE=1) and loads the
// app's OWN modules from resources/app.asar, so what is measured is the shipped code,
// not a copy of it. No account, no login, no secrets: engines run with a throwaway
// home and a fake API key; nothing is sent to a model (the fake key is rejected).
//
//   AgentSpace.exe engineProbe.cjs --app <dir with agentRunner.js> --out <dir>
//     [--codex <label>=<bin dir>,...] [--opencode <label>=<bin dir>,...] [--only a,b]
//
// Scenarios (each prints one OK/FAIL line and writes <out>/<id>.json):
//   tree      pane closed with node-pty kill() (control) vs the app's tree kill
//   storm     engine that dies at startup, real exit codes fed to the app's spawn fuse
//   chars     which characters reach a raw-mode TUI through the pty (no engine involved)
//   codex     real Codex TUI: empty input box read by the app's reader, then typed text
//   opencode  real OpenCode pane with the app's own argv/env: alive after 25 s? leftovers?
//   claude    real Claude Code pane built like the app's main process: alive? what did it print?
//   ocreader  idle OpenCode input box (wide + narrow): what does the app's own reader say?
//             Also saves the raw pty stream (<id>.raw.vt) and the per-row wrap flags (<id>.wrap.json)
//             so the same screen can be replayed later through the reader.
//   ocdeliver idle NARROW OpenCode pane: does the app's own delivery gate (agentxDeliver.paneStateOf)
//             let a job through, and does the app's own writer (deliverPrompt) put it in the input
//             box? Enter is NOT sent (it would reach a model): the Enter key write is swallowed.
//   cldeliver idle Claude Code pane (fresh / after /model / after a typed line, several widths):
//             does the app's own delivery gate read it idle, and does the app's writer put a job in?
//   agyping   Antigravity sign-in check with a FAKE agy binary (no account, nothing reaches Google):
//             the app's own engineAuthGate runs its one-shot check, then the app's own status row
//             (decorateStatus) is read. Measured: exactly one check per click, the reason class,
//             the engine's own line with the home folder / e-mail / token masked (made-up names
//             only), the same row for settings and setup, and "signed in" -> "connected" on success.
//
// --overlay <dir> --overlay-files a.cjs,b.cjs: load those app modules from <dir> instead of the
// app (used by a private test run to compare a fix with the shipped code; never used here).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const ARGS = (() => {
  const a = { app: null, out: 'engine-probe', codex: [], opencode: [], claude: [], only: null, overlay: null, overlayFiles: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i]; const n = v[i + 1];
    if (k === '--app') { a.app = n; i++; }
    else if (k === '--out') { a.out = n; i++; }
    else if (k === '--codex') { a.codex = parsePairs(n); i++; }
    else if (k === '--opencode') { a.opencode = parsePairs(n); i++; }
    else if (k === '--claude') { a.claude = parsePairs(n); i++; }
    else if (k === '--only') { a.only = n.split(','); i++; }
    else if (k === '--overlay') { a.overlay = n; i++; }
    else if (k === '--overlay-files') { a.overlayFiles = n.split(',').filter(Boolean); i++; }
  }
  return a;
})();
function parsePairs(s) {
  return String(s || '').split(',').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { label: p.slice(0, i), dir: p.slice(i + 1) };
  });
}
if (!ARGS.app) { console.error('--app required'); process.exit(2); }
fs.mkdirSync(ARGS.out, { recursive: true });

// Overlay: the listed modules come from --overlay (their own relative requires resolve there);
// packages such as @xterm/headless still come from the app's node_modules (NODE_PATH).
if (ARGS.overlay) {
  process.env.NODE_PATH = [path.join(ARGS.app, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  require('node:module')._initPaths();
}
const fromOverlay = (rel) => !!ARGS.overlay && ARGS.overlayFiles.includes(rel);
const app = (rel) => require(path.join(fromOverlay(rel) ? ARGS.overlay : ARGS.app, rel));
const appOpt = (rel) => { try { return app(rel); } catch (e) { return { loadError: String(e && e.message).slice(0, 300) }; } };
const pty = app('node_modules/node-pty');
const treeKill = app('platform/ptyTreeKill.cjs');
const stormGuard = app('spawnStormGuard.cjs');
const paneScreen = app('paneScreen.cjs');
const composer = app('leaderComposer.cjs');
const paste = app('pastePayload.cjs');
const agentRunner = app('agentRunner.js');
const rollout = app('codexRolloutProbe.cjs');
const restartResume = app('restartResume.cjs');
const engineInstall = app('engineInstall.cjs');

// What the app's main process does after buildSpawn: find the binary on the pane's PATH
// and, on Windows, wrap a .cmd shim the way node-pty needs it.
function paneTarget(plan) {
  const bin = engineInstall.resolveBinary(plan.file, plan.env);
  if (!bin) return null;
  if (IS_WIN) { const t = engineInstall.execArgs(bin, plan.argv); return { file: t.file, argv: t.commandLine || t.argv, bin }; }
  return { file: bin, argv: plan.argv, bin };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(id, pass, metrics) {
  results.push({ id, pass, metrics });
  fs.writeFileSync(path.join(ARGS.out, `${id}.json`), `${JSON.stringify({ id, pass, metrics }, null, 2)}\n`);
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${id} - ${JSON.stringify(metrics).slice(0, 900)}`);
}
// Every scenario gets its own throwaway home: the app's spawn code writes engine
// profiles and plugin files under it, never into the runner's real profile.
function isoHome(tag) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), `asprobe-${tag}-`));
  return h;
}

// ---------- process table (Windows: CIM; POSIX: ps) ----------
function procTable() {
  if (IS_WIN) {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n="Start";e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress';
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
    return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, start: String(p.Start) }));
  }
  const out = cp.execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], start: m[3], name: path.basename(m[4]) } : null;
  }).filter(Boolean);
}
// Windows hands out a dead process's pid again, and the dead process's children keep it
// as their ParentProcessId. A pane whose pid was such a reused pid would "adopt" them
// (run 37971756558: csrss, winlogon, dwm, fontdrvhost were listed and reaped, the runner's
// session died). So a child counts only if it started AFTER its parent.
const startNum = (p) => (IS_WIN ? Number(p.start) : Date.parse(p.start));
function descendants(rootPid, table = procTable()) {
  const root = table.find((p) => p.pid === rootPid);
  const born = new Map([[rootPid, root ? startNum(root) : -Infinity]]);
  const out = []; let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (!born.has(p.ppid) || born.has(p.pid)) continue;
      const t = startNum(p);
      if (!(t >= born.get(p.ppid))) continue;
      born.set(p.pid, t); out.push(p); grew = true;
    }
  }
  return out;
}
// A process counts as left over only if the SAME pid with the SAME start time still
// exists (Windows hands out freed pids again within seconds).
function stillAlive(list, table = procTable()) {
  const now = new Set(table.map((p) => `${p.pid}@${p.start}`));
  return list.filter((p) => now.has(`${p.pid}@${p.start}`));
}
// Second guard: never kill a system process by mistake, whatever the tree says.
const NEVER_REAP = /^(system|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|fontdrvhost|explorer|sihost|ctfmon|runtimebroker|launchd|kernel_task|systemd|init)(\.exe)?$/i;
function reap(list) {
  for (const p of list) {
    if (NEVER_REAP.test(p.name)) { console.log(`skip reaping system process ${p.name} (${p.pid})`); continue; }
    try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

function spawnPane(file, argv, opts = {}) {
  const t = pty.spawn(file, argv, {
    name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32,
    cwd: opts.cwd || os.tmpdir(), env: opts.env || process.env,
    ...(IS_WIN ? { useConpty: true } : {}),
  });
  const screen = paneScreen.createPaneScreen({ cols: opts.cols || 120, rows: opts.rows || 32 });
  const rawCap = opts.rawCap || 400000;
  const state = { t, screen, bytes: 0, exit: null, startedAt: Date.now(), raw: '', rawCapped: false };
  t.onData((d) => {
    state.bytes += d.length;
    if (state.raw.length < rawCap) state.raw += d; else state.rawCapped = true;
    try { screen.write(d); } catch { /* reader fault */ }
  });
  t.onExit((e) => { state.exit = { code: e.exitCode, signal: e.signal || 0, ms: Date.now() - state.startedAt }; });
  return state;
}
const composerText = (s) => s.screen.composerLines().join('\n');
const liveText = (s) => s.screen.liveLines().join('\n');
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return !!fn();
}
// Only the bottom of the screen is kept (the input box and its footer): that is all the
// reader looks at, and the rest is the app's own first prompt, which is not needed here.
const KEEP_ROWS = 15;
const tailRows = (t) => t.split('\n').slice(-KEEP_ROWS).join('\n');
function saveScreen(name, s) {
  fs.writeFileSync(path.join(ARGS.out, `${name}.screen.txt`), `${tailRows(liveText(s))}\n`);
  fs.writeFileSync(path.join(ARGS.out, `${name}.composer.txt`), `${tailRows(composerText(s))}\n`);
}

// ---------- tree ----------
async function scenarioTree() {
  for (const arm of ['control-pty-kill', 'app-tree-kill']) {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asprobe-tree-')), 'gc.pid');
    const cmd = IS_WIN
      ? ['powershell.exe', ['-NoProfile', '-Command', `$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 300' -WindowStyle Hidden -PassThru; Set-Content -Path '${pidFile}' -Value $p.Id; Write-Host READY; Start-Sleep -Seconds 300`]]
      : ['/bin/sh', ['-c', `sleep 300 & echo $! > '${pidFile}'; echo READY; sleep 300`]];
    const s = spawnPane(cmd[0], cmd[1]);
    await waitFor(() => s.raw.includes('READY'), 30000);
    await sleep(800);
    const before = descendants(s.t.pid);
    if (arm === 'control-pty-kill') s.t.kill(); else treeKill.killPaneTreesSync([s.t]);
    await waitFor(() => s.exit, 10000);
    await sleep(3000);
    const left = stillAlive(before);
    report(`tree-${arm}`, arm === 'control-pty-kill' ? true : left.length === 0, {
      expect: arm === 'control-pty-kill' ? 'measured only (on Windows the grandchild is expected to survive)' : 'leftover 0',
      descendants_before: before.map((p) => p.name), leftover: left.map((p) => p.name), leftover_count: left.length,
      pty_exit: s.exit,
    });
    reap(left);
  }
}

// ---------- storm ----------
async function scenarioStorm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asprobe-storm-'));
  let file; let argv;
  if (IS_WIN) {
    file = path.join(dir, 'dies-at-start.cmd');
    fs.writeFileSync(file, '@echo off\r\necho engine could not start 1>&2\r\nexit /b 1\r\n');
    file = 'cmd.exe'; argv = ['/d', '/c', path.join(dir, 'dies-at-start.cmd')];
  } else { file = '/bin/sh'; argv = ['-c', 'echo engine could not start >&2; exit 1']; }
  const guard = stormGuard.createSpawnStormGuard();
  const opts = { agentId: 'probe-worker', command: 'codex', disallowSubagent: true };
  const rounds = [];
  for (let i = 1; i <= 5; i++) {
    const verdict = guard.check(opts);
    if (!verdict.ok) { rounds.push({ round: i, spawned: false, blocked: verdict.code, deaths: verdict.deaths }); continue; }
    const s = spawnPane(file, argv);
    await waitFor(() => s.exit, 15000);
    const e = s.exit || { code: null, signal: 0, ms: -1 };
    guard.noteExit({ agentId: opts.agentId, engine: opts.command, exitCode: e.code, signal: e.signal, msSinceSpawn: e.ms, disallowSubagent: true });
    rounds.push({ round: i, spawned: true, exit_code: e.code, signal: e.signal, ms: e.ms, counts_as_startup_death: stormGuard.countsAsStartupDeath({ exitCode: e.code, signal: e.signal, msSinceSpawn: e.ms }) });
  }
  const spawned = rounds.filter((r) => r.spawned).length;
  report('storm-fuse-trips', spawned === stormGuard.TRIP_AFTER && rounds.slice(spawned).every((r) => r.blocked === 'ERR_SPAWN_STORM'), { trip_after: stormGuard.TRIP_AFTER, rounds });

  // Control: a pane WE close (tree kill) must never count as the engine dying.
  const g2 = stormGuard.createSpawnStormGuard();
  const killed = [];
  for (let i = 1; i <= 4; i++) {
    const s = spawnPane(IS_WIN ? 'powershell.exe' : '/bin/sh', IS_WIN ? ['-NoProfile', '-Command', 'Write-Host READY; Start-Sleep -Seconds 60'] : ['-c', 'echo READY; sleep 60']);
    await waitFor(() => s.raw.includes('READY'), 20000);
    treeKill.killPaneTreesSync([s.t]);
    await waitFor(() => s.exit, 10000);
    const e = s.exit || { code: null, signal: 0, ms: -1 };
    g2.noteExit({ agentId: opts.agentId, engine: opts.command, exitCode: e.code, signal: e.signal, msSinceSpawn: e.ms, killedBy: 'user', disallowSubagent: true });
    killed.push({ exit_code: e.code, signal: e.signal, ms: e.ms, check_after: g2.check(opts).ok });
  }
  report('storm-closed-panes-not-counted', killed.every((k) => k.check_after === true), { rounds: killed });
}

// ---------- burst ----------
// 512 KB of "X" in one write. The raw pty stream is compared with what the app's own
// screen model (paneScreen, xterm) ends up holding: the stream may carry extra bytes
// (ConPTY repaints), but the terminal content must hold exactly the bytes written.
async function scenarioBurst() {
  const N = 512 * 1024; const cols = 200; const rows = 50;
  const node = process.env.PROBE_NODE || 'node';
  const s = spawnPane(node, ['-e', `process.stdout.write('X'.repeat(${N}) + '\\r\\nDONE\\r\\n')`], { cols, rows });
  // A screen model with room for the whole burst (the app's default keeps 2000 rows).
  const big = paneScreen.createPaneScreen({ cols, rows, scrollback: 10000 });
  let raw = '';
  s.t.onData((d) => { raw += d; big.write(d); });
  await waitFor(() => s.exit && /DONE/.test(raw), 120000, 250);
  await sleep(500);
  const b = big.term.buffer.active;
  let inBuffer = 0;
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) inBuffer += (l.translateToString(true).match(/X/g) || []).length; }
  const rawX = (raw.match(/X/g) || []).length;
  report('burst-512k', inBuffer === N, { expected: N, in_terminal: inBuffer, raw_stream_x: rawX, raw_extra: rawX - N, wrapped_rows: Math.ceil(N / cols), bytes: raw.length, exit: s.exit });
}

// ---------- chars ----------
const PROBE_TEXT = 'Görev · ölçüm — durum ⛔ bitti… “tırnak” ‘tek’ → ✓ ışık ÇĞİÖŞÜ 🚀 end';
async function scenarioChars() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asprobe-chars-'));
  const sink = path.join(dir, 'got.txt');
  const tui = path.join(dir, 'tui.cjs');
  fs.writeFileSync(tui, `
    const fs=require('fs');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
    let got='';process.stdout.write('\\x1b[?2004hREADY\\r\\n');
    process.stdin.on('data',(d)=>{got+=d;fs.writeFileSync(${JSON.stringify(sink)},got);if(got.includes('\\x04'))process.exit(0);});
  `);
  const node = process.env.PROBE_NODE || 'node';
  const out = {};
  for (const mode of ['typed', 'bracketed']) {
    try { fs.unlinkSync(sink); } catch { /* none */ }
    const s = spawnPane(node, [tui]);
    await waitFor(() => s.raw.includes('READY'), 20000);
    const payload = mode === 'typed' ? paste.pastePayload(PROBE_TEXT) : paste.pastePayload(`${PROBE_TEXT}\nline two`, { bracketed: 'always' });
    s.t.write(payload);
    await sleep(1500);
    s.t.write('\x04');
    await waitFor(() => s.exit, 5000);
    let got = ''; try { got = fs.readFileSync(sink, 'utf8'); } catch { /* nothing arrived */ }
    got = got.replace(/\x04$/, '').replace(/\x1b\[20[01]~/g, '');
    const want = mode === 'typed' ? PROBE_TEXT : `${PROBE_TEXT}\nline two`;
    const lost = [...new Set([...want].filter((ch) => !got.includes(ch)))];
    out[mode] = { sent_chars: [...want].length, got_chars: [...got].length, lost, same: got.replace(/\r/g, '\n') === want };
    if (!s.exit) treeKill.killPaneTreesSync([s.t]);
  }
  report('chars-through-pty', out.typed.lost.length === 0 && out.bracketed.lost.length === 0, out);
}

// ---------- codex ----------
function codexHome(tag) {
  const home = isoHome(`codex-${tag}`);
  const ch = path.join(home, '.codex');
  fs.mkdirSync(ch, { recursive: true });
  // Fake key: lets the TUI open its input box without a login screen. Rejected by the
  // server if anything is ever sent, so nothing can be billed.
  fs.writeFileSync(path.join(ch, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-probe-not-a-real-key' }));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  const tomlPath = work.replace(/\\/g, '\\\\');
  fs.writeFileSync(path.join(ch, 'config.toml'), `check_for_update_on_startup = false\n\n[projects."${tomlPath}"]\ntrust_level = "trusted"\n`);
  return { home, codexHome: ch, work };
}
function envFor(home, binDir, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^(GITHUB_|ACTIONS_|RUNNER_)/.test(k)) delete env[k];
  env.PATH = `${binDir}${path.delimiter}${env.PATH || env.Path || ''}`;
  if (IS_WIN) { env.Path = env.PATH; env.USERPROFILE = home; } else env.HOME = home;
  env.AGENTDESK_HOME = path.join(home, '.agentdesk');
  return env;
}
async function scenarioCodex() {
  for (const { label, dir } of ARGS.codex) {
    const h = codexHome(label);
    const env = envFor(h.home, dir, { CODEX_HOME: h.codexHome });
    let plan = null; let planErr = null;
    try { plan = agentRunner.buildSpawn({ command: 'codex', agentId: 'probe-worker', cwd: h.work, disallowSubagent: true }, env, ARGS.app, {}); } catch (e) { planErr = e.message; }
    const target = plan ? paneTarget(plan) : null;
    if (!target) { report(`codex-${label}-spawn`, false, { plan_error: planErr, resolved: null }); continue; }
    const s = spawnPane(target.file, target.argv, { cwd: h.work, env: plan ? { ...plan.env, CODEX_HOME: h.codexHome } : env });
    // Wait for the input box (or give up after 60 s and save whatever is on screen).
    const reached = await waitFor(() => /Ask Codex|›\s/.test(liveText(s)) || s.exit, 60000, 500);
    // The app's spawn argv carries the identity as the first prompt, so Codex starts a
    // turn at once; with the fake key it fails and returns to an empty box. That
    // after-a-turn box is the state the field report is about: wait for it.
    const turnSeen = await waitFor(() => /esc to interrupt|Working/.test(liveText(s)) || s.exit, 20000, 250);
    let quietSince = 0;
    const turnEnded = await waitFor(() => {
      if (s.exit) return true;
      const busy = /esc to interrupt/.test(s.screen.liveLines().slice(-8).join('\n'));
      if (busy) { quietSince = 0; return false; }
      if (!quietSince) quietSince = Date.now();
      return Date.now() - quietSince > 5000;
    }, 150000, 500);
    saveScreen(`codex-${label}-afterturn-raw`, s);
    saveScreen(`codex-${label}-idle`, s);
    const idle = composer.composerDiag(composerText(s), { ignoreRunning: true });
    const idleCodex = composer.composerDiag(composerText(s), { ignoreRunning: true, engine: 'codex' });
    report(`codex-${label}-idle-box`, idle.verdict === 'empty', {
      plan: { file: path.basename(plan.file), bin: path.basename(target.bin), spawn: path.basename(target.file), argc: plan.argv.length },
      box_reached: reached && !s.exit, turn_seen: turnSeen, turn_ended: turnEnded, exit: s.exit,
      verdict: idle.verdict, branch: idle.branch, row: idle.row, verdict_engine_codex: idleCodex.verdict,
      tail: idle.rows,
    });
    if (s.exit) continue;
    // Type the probe text the way the app delivers it (no Enter: nothing is sent).
    s.t.write(paste.pastePayload(PROBE_TEXT));
    await sleep(3000);
    saveScreen(`codex-${label}-typed`, s);
    const typed = composer.composerDiag(composerText(s), { ignoreRunning: true });
    const screen = s.screen.liveLines().slice(-6).join('\n');
    const lost = [...new Set([...PROBE_TEXT].filter((ch) => ch.trim() && !screen.includes(ch)))];
    report(`codex-${label}-typed-text`, typed.verdict === 'text' && lost.length === 0, {
      verdict: typed.verdict, branch: typed.branch, lost_on_screen: lost,
    });
    // Submit (one Enter, as the app does). The fake key makes the request fail with 401,
    // but Codex writes the user message to its own session file first: that file is
    // what the app's delivery check reads, so it shows which characters really arrived.
    const sends = [
      { kind: 'typed', text: `${PROBE_TEXT} mark-p1`, mark: 'mark-p1', typedAlready: true },
      { kind: 'bracketed', text: `Teslim satırı · bir — iki ⛔ üç… dört\n${PROBE_TEXT}\nson satır mark-p2`, mark: 'mark-p2' },
    ];
    for (const send of sends) {
      // Codex treats keys that arrive right before Enter as a paste and turns Enter into a
      // new line; the app waits before its Enter, so the probe does too.
      if (send.typedAlready) { s.t.write(' mark-p1'); await sleep(1500); }
      else {
        await waitFor(() => !/esc to interrupt/.test(s.screen.liveLines().slice(-8).join('\n')), 60000, 500);
        s.t.write(paste.pastePayload(send.text));
        await sleep(2000);
      }
      s.t.write('\r');
      await sleep(1500);
      await waitFor(() => !/esc to interrupt/.test(s.screen.liveLines().slice(-8).join('\n')), 90000, 500);
      await sleep(1500);
      const needle = restartResume.needleOf(send.text);
      const probe = rollout.rolloutContains({ cwd: h.work, startedAt: s.startedAt }, needle, { codexHome: h.codexHome });
      const exact = (() => {
        if (!probe.file) return null;
        const body = fs.readFileSync(probe.file, 'utf8').split('\n').filter((l) => l.includes(send.mark)).join('\n');
        if (!body) return { missing_in_session_file: null, note: 'message with this mark not in session file' };
        const want = [...new Set([...send.text].filter((ch) => ch.trim()))];
        return { missing_in_session_file: want.filter((ch) => !body.includes(ch) && !body.includes(JSON.stringify(ch).slice(1, -1))) };
      })();
      report(`codex-${label}-delivered-${send.kind}`, probe.checked && probe.found && exact && Array.isArray(exact.missing_in_session_file) && exact.missing_in_session_file.length === 0, {
        needle, rollout: { checked: probe.checked, found: probe.found, reason: probe.reason, candidates: probe.candidates }, ...(exact || {}),
      });
    }
    saveScreen(`codex-${label}-after-send`, s);
    const after = composer.composerDiag(composerText(s), { ignoreRunning: true });
    report(`codex-${label}-box-after-send`, after.verdict === 'empty', { verdict: after.verdict, branch: after.branch, row: after.row });
    const before = descendants(s.t.pid);
    treeKill.killPaneTreesSync([s.t]);
    await waitFor(() => s.exit, 10000);
    await sleep(2500);
    const left = stillAlive(before);
    report(`codex-${label}-close`, left.length === 0, { descendants_before: before.map((p) => p.name), leftover: left.map((p) => p.name) });
    reap(left);
  }
}

// OpenCode draws on the alternate screen: dump the ACTIVE buffer.
function dumpActive(s, name) {
  try {
    const b = s.screen.term.buffer.active;
    const rows = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) rows.push(l.translateToString(true)); }
    fs.writeFileSync(path.join(ARGS.out, `${name}.active.txt`), `${b.type}\n${rows.join('\n')}\n`);
  } catch { /* screen model gone */ }
}
// Raw pty stream + per-row wrap flags of the viewport: lets the screen be replayed exactly.
function dumpRawAndWrap(s, name) {
  try { fs.writeFileSync(path.join(ARGS.out, `${name}.raw.vt`), s.raw); } catch { /* disk */ }
  try {
    const b = s.screen.term.buffer.active;
    const rows = [];
    for (let i = b.baseY; i < b.length; i++) { const l = b.getLine(i); if (l) rows.push({ wrapped: !!l.isWrapped, text: l.translateToString(true) }); }
    const wrapped = rows.filter((r) => r.wrapped).length;
    fs.writeFileSync(path.join(ARGS.out, `${name}.wrap.json`), `${JSON.stringify({ type: b.type, cols: s.screen.term.cols, rows: rows.length, wrapped, raw_bytes: s.raw.length, raw_capped: s.rawCapped, lines: rows }, null, 1)}\n`);
    return { rows: rows.length, wrapped, raw_bytes: s.raw.length, raw_capped: s.rawCapped };
  } catch (e) { return { error: String(e && e.message).slice(0, 200) }; }
}

// ---------- opencode-start ----------
// With an external plugin in its config, OpenCode waits for a dependency install into
// its config folder before it loads. Measure: first start in a fresh home, a second
// start in the SAME home, and three panes started at once in another fresh home.
function ocReady(s) { return /Ask anything/.test(activeText(s)); }
function activeText(s) {
  try {
    const b = s.screen.term.buffer.active; const rows = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) rows.push(l.translateToString(true)); }
    return rows.join('\n');
  } catch { return ''; }
}
async function startOc(dir, home, tag, earlyText) {
  const work = path.join(home, `work-${tag}`); fs.mkdirSync(work, { recursive: true });
  const env = envFor(home, dir, {});
  const plan = agentRunner.buildSpawn({ command: 'opencode', agentId: `probe-${tag}`, cwd: work, disallowSubagent: true }, env, ARGS.app, {});
  const target = paneTarget(plan);
  const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env });
  // The app writes a delegated prompt once the pane has printed something and ~9 s have
  // passed. Write the same way at 10 s (no Enter: nothing is sent to a model).
  let early = null;
  if (earlyText) {
    await waitFor(() => s.exit, 10000, 500);
    early = { written_at_ms: Date.now() - s.startedAt, box_ready_then: ocReady(s) };
    if (!s.exit) s.t.write(paste.pastePayload(earlyText));
  }
  const ready = await waitFor(() => ocReady(s) || s.exit, 120000, 500);
  if (early) { await sleep(3000); early.in_box_after_ready = activeText(s).includes(earlyText.split(' ').pop()); dumpActive(s, `opencode-early-${tag}`); }
  return { s, early, plugin: (() => { try { return (JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT || '{}').plugin || []).length; } catch { return null; } })(), readyMs: ready && !s.exit ? Date.now() - s.startedAt : null, exit: s.exit };
}
async function closeOc(list) {
  const before = list.flatMap((x) => (x.s.exit ? [] : descendants(x.s.t.pid)));
  treeKill.killPaneTreesSync(list.map((x) => x.s.t));
  await waitFor(() => list.every((x) => x.s.exit), 10000);
  await sleep(2500);
  const left = stillAlive(before); reap(left);
  return left.map((p) => p.name);
}
async function scenarioOpencodeStart() {
  for (const { label, dir } of ARGS.opencode) {
    const home = isoHome(`ocs-${label}`);
    const first = await startOc(dir, home, 'first', 'Probe teslim metni mark-oc1');
    const left1 = await closeOc([first]);
    const second = await startOc(dir, home, 'second');
    const left2 = await closeOc([second]);
    report(`opencode-${label}-start-first-vs-second`, first.readyMs !== null && second.readyMs !== null && left1.length + left2.length === 0, {
      plugin: first.plugin, first_ready_ms: first.readyMs, early_write: first.early, first_exit: first.exit, second_ready_ms: second.readyMs, second_exit: second.exit, leftover: [...left1, ...left2],
    });
    const home3 = isoHome(`ocp-${label}`);
    const three = await Promise.all([1, 2, 3].map((i) => startOc(dir, home3, `p${i}`)));
    const left3 = await closeOc(three);
    report(`opencode-${label}-start-3-parallel`, three.every((x) => x.readyMs !== null) && left3.length === 0, {
      ready_ms: three.map((x) => x.readyMs), exits: three.map((x) => x.exit), leftover: left3,
    });
  }
}

// ---------- opencode ----------
async function scenarioOpencode() {
  for (const { label, dir } of ARGS.opencode) {
    const arms = [
      { arm: 'app', extra: {} },
      { arm: 'no-plugin', extra: { AGENTSPACE_ENGINE_DONE_SIGNAL: '0' } },
      { arm: 'autoupdate-on', extra: { OPENCODE_DISABLE_AUTOUPDATE: '0' } },
    ].filter((a) => !process.env.PROBE_OC_ARMS || process.env.PROBE_OC_ARMS.split(',').includes(a.arm));
    for (const { arm, extra } of arms) {
      const home = isoHome(`oc-${label}-${arm}`);
      const work = path.join(home, 'work'); fs.mkdirSync(work);
      const env = envFor(home, dir, extra);
      let plan = null; let planErr = null;
      // The app reads its own switches (AGENTSPACE_*) from the app process, not from the
      // pane env: set them here for the duration of buildSpawn only.
      const own = Object.keys(extra).filter((k) => k.startsWith('AGENTSPACE_'));
      const saved = own.map((k) => [k, process.env[k]]);
      for (const k of own) process.env[k] = extra[k];
      try { plan = agentRunner.buildSpawn({ command: 'opencode', agentId: 'probe-worker', cwd: work, disallowSubagent: true }, env, ARGS.app, {}); } catch (e) { planErr = e.message; }
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      if (!plan) { report(`opencode-${label}-${arm}`, false, { plan_error: planErr }); continue; }
      const target = paneTarget(plan);
      if (!target) { report(`opencode-${label}-${arm}`, false, { resolved: null, plan_file: plan.file }); continue; }
      const verBefore = versionOf(dir);
      const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env });
      // Timeline: bytes drawn and child processes (MCP servers) every 5 s for 45 s.
      const timeline = [];
      for (let t = 5; t <= 45 && !s.exit; t += 5) {
        await waitFor(() => s.exit, 5000, 500);
        const kids = s.exit ? [] : descendants(s.t.pid).filter((p) => !/^conhost/i.test(p.name));
        timeline.push({ t, bytes: s.bytes, children: kids.map((p) => p.name) });
        if (t === 10) dumpActive(s, `opencode-${label}-${arm}-t10`);
      }
      // OpenCode's own log (under the throwaway home): which startup step waited.
      try {
        const logDir = path.join(home, '.local', 'share', 'opencode', 'log');
        for (const f of fs.readdirSync(logDir)) {
          const body = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').slice(0, 400).join('\n');
          fs.writeFileSync(path.join(ARGS.out, `opencode-${label}-${arm}.log.txt`), body.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'));
        }
      } catch { /* no log */ }
      saveScreen(`opencode-${label}-${arm}`, s);
      dumpActive(s, `opencode-${label}-${arm}`);
      const alive = !s.exit;
      const before = alive ? descendants(s.t.pid) : [];
      if (alive) treeKill.killPaneTreesSync([s.t]);
      await waitFor(() => s.exit, 10000);
      await sleep(2500);
      const left = stillAlive(before);
      reap(left);
      const cfg = (() => { try { return JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT || '{}'); } catch { return {}; } })();
      report(`opencode-${label}-${arm}`, arm === 'autoupdate-on' ? true : alive && left.length === 0, {
        expect: arm === 'autoupdate-on' ? 'measured only (control arm)' : 'alive at 45 s, leftover 0',
        bin: path.basename(target.bin), spawn: path.basename(target.file), alive_45s: alive, exit_before_45s: alive ? null : s.exit, bytes: s.bytes, timeline,
        env_autoupdate: plan.env.OPENCODE_DISABLE_AUTOUPDATE || null, plugin_in_config: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
        version_before: verBefore, version_after: versionOf(dir),
        descendants_before: before.map((p) => p.name), leftover: left.map((p) => p.name),
      });
    }
  }
}
// ---------- ocreader ----------
// An idle OpenCode pane started the way the app starts it. Once the input box is drawn,
// the app's own input box reader (leaderComposer.composerDiag) says what it sees. The app
// writes a job into a pane only when the reader says 'empty'. Two widths: wide (120) and
// narrow (45 and 36 columns, about a medium and a small pane). No key, no login: OpenCode uses its free default.
async function scenarioOcReader() {
  const widths = (process.env.PROBE_OCR_COLS || '120,45,36').split(',').map(Number).filter((n) => n >= 20 && n <= 300);
  for (const { label, dir } of ARGS.opencode) {
    for (const cols of widths) {
      const id = `ocreader-${label}-c${cols}`;
      const home = isoHome(`ocr-${label}-${cols}`);
      const work = path.join(home, 'work'); fs.mkdirSync(work);
      const env = envFor(home, dir, {});
      let plan = null; let planErr = null;
      try { plan = agentRunner.buildSpawn({ command: 'opencode', agentId: 'probe-reader', cwd: work, disallowSubagent: true }, env, ARGS.app, {}); } catch (e) { planErr = e.message; }
      const target = plan ? paneTarget(plan) : null;
      if (!target) { report(id, false, { plan_error: planErr, resolved: null }); continue; }
      const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env, cols, rows: 32, rawCap: 8 << 20 });
      const drawn = await waitFor(() => ocReady(s) || s.exit, 120000, 500);
      const drawnMs = drawn && !s.exit ? Date.now() - s.startedAt : null;
      await sleep(6000); // the status row (agent, model) settles after the box
      const wrap = dumpRawAndWrap(s, id);
      const live = liveText(s);
      const reads = {};
      for (const [k, o] of [['plain', undefined], ['engine', { engine: 'opencode' }], ['ignoreRunning', { ignoreRunning: true }]]) {
        try { const d = composer.composerDiag(live, o); reads[k] = { verdict: d.verdict, branch: d.branch, row: d.row }; } catch (e) { reads[k] = { error: String(e && e.message).slice(0, 200) }; }
      }
      const ghost = (live.match(/Ask anything[^\n]{0,60}/) || [''])[0];
      saveScreen(id, s);
      dumpActive(s, id);
      const alive = !s.exit;
      const before = alive ? descendants(s.t.pid) : [];
      if (alive) treeKill.killPaneTreesSync([s.t]);
      await waitFor(() => s.exit, 10000);
      await sleep(2000);
      const left = stillAlive(before); reap(left);
      report(id, !!reads.plain && reads.plain.verdict === 'empty', {
        expect: "reader says 'empty' on an idle input box (needed before the app writes a job)",
        version: versionOf(dir), cols, box_drawn_ms: drawnMs, alive_at_read: alive,
        ghost, ghost_has_u2026: ghost.includes('…'), reads, wrap, overlay: ARGS.overlay ? ARGS.overlayFiles : null, leftover: left.map((p) => p.name),
      });
    }
  }
}
// ---------- ocdeliver ----------
// The app writes a job into a pane only when its delivery gate says the pane is idle:
// agentxDeliver.paneStateOf({bytes, buffer}) === 'idle', where buffer is the input box text
// from the pane screen (paneScreen.composerLines). Here: a narrow, idle OpenCode pane, the
// gate is polled for 30 s (the app polls the same way, much longer), and if it opens the app's
// own writer (deliverPrompt) writes a job. The Enter key write is swallowed, so nothing is
// sent to a model; the job must then be visible in the input box.
async function scenarioOcDeliver() {
  const xd = appOpt('agentxDeliver.cjs');
  const dp = appOpt('deliverPrompt.cjs');
  const widths = (process.env.PROBE_OCD_COLS || '45').split(',').map(Number).filter((n) => n >= 20 && n <= 300);
  for (const { label, dir } of ARGS.opencode) {
    for (const cols of widths) {
      const id = `ocdeliver-${label}-c${cols}`;
      if (xd.loadError || dp.loadError || typeof xd.paneStateOf !== 'function' || typeof dp.deliverPrompt !== 'function') {
        report(id, false, { error: 'app delivery modules not loadable', agentxDeliver: xd.loadError || null, deliverPrompt: dp.loadError || null });
        continue;
      }
      const home = isoHome(`ocd-${label}-${cols}`);
      const work = path.join(home, 'work'); fs.mkdirSync(work);
      const env = envFor(home, dir, {});
      let plan = null; let planErr = null;
      try { plan = agentRunner.buildSpawn({ command: 'opencode', agentId: 'probe-deliver', cwd: work, disallowSubagent: true }, env, ARGS.app, {}); } catch (e) { planErr = e.message; }
      const target = plan ? paneTarget(plan) : null;
      if (!target) { report(id, false, { plan_error: planErr, resolved: null }); continue; }
      const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env, cols, rows: 32, rawCap: 8 << 20 });
      const drawn = await waitFor(() => ocReady(s) || s.exit, 120000, 500);
      const drawnMs = drawn && !s.exit ? Date.now() - s.startedAt : null;
      await sleep(6000);
      const gateOf = () => {
        const buffer = composerText(s);
        let state = null; let diag = null;
        try { state = xd.paneStateOf({ bytes: s.bytes, buffer }); } catch (e) { state = `error: ${String(e && e.message).slice(0, 120)}`; }
        try { const d = composer.composerDiag(buffer, { ignoreRunning: true }); diag = { verdict: d.verdict, branch: d.branch }; } catch (e) { diag = { error: String(e && e.message).slice(0, 120) }; }
        return { state, diag };
      };
      let gate = gateOf();
      const gateEnd = Date.now() + 30000;
      while (gate.state !== 'idle' && Date.now() < gateEnd && !s.exit) { await sleep(1000); gate = gateOf(); }
      const before = composerText(s);
      fs.writeFileSync(path.join(ARGS.out, `${id}.before.txt`), `${before}\n`);
      const job = `OCDELIVER probe job ${label} ${cols}`;
      const writes = []; let swallowedEnters = 0; let result = null; let deliverErr = null;
      if (gate.state === 'idle') {
        const io = {
          readPaneBuffer: () => composerText(s),
          writePane: (_id, data) => {
            if (data === '\r' || data === '\r\n') { swallowedEnters += 1; return true; }
            writes.push(data.length); s.t.write(data); return true;
          },
          sleep, now: () => Date.now(), livePaneCount: () => 1, platform: process.platform,
          bracketedPasteMode: () => { const on = s.raw.lastIndexOf('\x1b[?2004h'); return on < 0 ? null : on > s.raw.lastIndexOf('\x1b[?2004l'); },
          log: () => {},
        };
        try {
          result = await Promise.race([
            dp.deliverPrompt(id, job, { mode: 'auto', label: 'probe', bracketed: 'always', a4: true }, io),
            sleep(60000).then(() => ({ outcome: 'probe-timeout' })),
          ]);
        } catch (e) { deliverErr = String(e && e.message).slice(0, 300); }
        await sleep(3000);
      }
      const after = activeText(s);
      fs.writeFileSync(path.join(ARGS.out, `${id}.after.txt`), `${after}\n`);
      const jobOnScreen = after.replace(/\s+/g, ' ').includes(job);
      const wrap = dumpRawAndWrap(s, id);
      dumpActive(s, `${id}-end`);
      const alive = !s.exit;
      const kids = alive ? descendants(s.t.pid) : [];
      if (alive) treeKill.killPaneTreesSync([s.t]);
      await waitFor(() => s.exit, 10000);
      await sleep(2000);
      const left = stillAlive(kids); reap(left);
      report(id, gate.state === 'idle' && writes.length > 0 && jobOnScreen, {
        expect: 'the app\'s gate opens on the idle narrow pane and the app\'s writer puts the job in the input box',
        version: versionOf(dir), cols, box_drawn_ms: drawnMs, alive_at_gate: alive, gate,
        wrote: writes.length > 0, write_sizes: writes, enter_swallowed: swallowedEnters,
        deliver: result ? { outcome: result.outcome, reason: result.reason, wroteText: result.wroteText } : null, deliver_error: deliverErr,
        job_on_screen: jobOnScreen, wrap, overlay: ARGS.overlay ? ARGS.overlayFiles : null, leftover: left.map((p) => p.name),
      });
    }
  }
}
// ---------- claude ----------
// A real Claude Code pane started exactly like the app's main process does: buildSpawn
// with the app's identity-file sink (spawnPromptFile.createSink), then the Windows
// wrapper (engineInstall.execArgs). No login: a FAKE key, pre-approved, so the input box
// opens; nothing reaches a model. Measured: does the pane live 30 s, what did it print
// if it died, and does typed text reach its input box.
const spawnPromptFile = (() => { try { return app('spawnPromptFile.cjs'); } catch { return null; } })();
const FAKE_ANTHROPIC = 'sk-ant-api03-probe-not-a-real-key-000000000000000000000000';
function claudeHome(tag, onboarded) {
  const home = isoHome(`claude-${tag}`);
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  if (onboarded) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [FAKE_ANTHROPIC.slice(-20)], rejected: [] },
    }));
  }
  return { home, work };
}
// The app reads HOME/USERPROFILE and its data root from ITS OWN process while it builds a
// pane (trust file, settings/MCP files, identity file): point them at the throwaway home.
const APP_HOME_KEY = ['AGENT', 'DESK_HOME'].join('');
function appDataDir(home) { return path.join(home, ['.agent', 'desk'].join('')); }
function withAppHome(home, fn) {
  const keys = { USERPROFILE: home, HOME: home, [APP_HOME_KEY]: appDataDir(home) };
  const saved = Object.keys(keys).map((k) => [k, process.env[k]]);
  Object.assign(process.env, keys);
  try { return fn(); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const cleanText = (raw) => raw
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
  .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]/g, '')
  .replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b[=>78DEHMc]/g, '')
  .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-***');
async function claudeArm(label, dir, arm, opts) {
  const { home, work } = claudeHome(`${label}-${arm}`, opts.onboarded !== false);
  const env = envFor(home, dir, { ANTHROPIC_API_KEY: FAKE_ANTHROPIC, DISABLE_AUTOUPDATER: '1', ...(opts.env || {}) });
  let plan = null; let planErr = null; let sinkInfo = 'none'; let trustOk = null;
  withAppHome(home, () => {
    let sink = null;
    if (opts.sink !== false && spawnPromptFile) {
      const bin = engineInstall.resolveBinary('claude', env);
      const t0 = Date.now();
      let logged = '';
      sink = spawnPromptFile.createSink({ engine: 'claude', bin, env, home: appDataDir(home), log: (l) => { logged = l.slice(0, 300); } });
      sinkInfo = `${sink ? 'sink' : 'NO sink'} (${Date.now() - t0} ms) ${logged}`;
    }
    try {
      plan = agentRunner.buildSpawn({ command: 'claude', agentId: `probe-${arm}`, cwd: work, disallowSubagent: true, ...(opts.spawn || {}) },
        env, ARGS.app, sink ? { promptFile: sink } : {});
    } catch (e) { planErr = String(e && e.message || e).slice(0, 400); }
    // main.js does this right after buildSpawn (plan.trust.pending → ensureEngineTrusted).
    if (plan && plan.trust && plan.trust.pending && opts.trust !== false) trustOk = agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env);
  });
  if (!plan) return { plan_error: planErr, sink: sinkInfo };
  const trustKeys = (() => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects || {}); } catch { return null; } })();
  const target = paneTarget(plan);
  if (!target) return { resolved: null, plan_file: plan.file, sink: sinkInfo };
  const argvShape = plan.argv.map((a) => (a.startsWith('-') ? a : a.length > 40 ? `<${a.length} ch${/\n/.test(a) ? ', multi-line' : ''}>` : a.replace(/[0-9a-f-]{36}/, '<uuid>')));
  const cmdLine = typeof target.argv === 'string' ? target.argv : target.argv.join(' ');
  const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env, cols: 120, rows: 32 });
  const box = () => /❯|Try "|for shortcuts/.test(liveText(s));
  await waitFor(() => s.exit || box(), opts.waitMs || 30000, 250);
  const boxMs = box() ? Date.now() - s.startedAt : null;
  let typed = null;
  if (!s.exit && opts.type) {
    const needle = `probe${Math.random().toString(36).slice(2, 8)}`;
    s.t.write(`Probe teslim metni ${needle}`);
    await sleep(2500);
    typed = { needle, in_box: liveText(s).includes(needle) };
  }
  await waitFor(() => s.exit, opts.lingerMs || 8000, 250);
  dumpActive(s, `claude-${label}-${arm}`);
  const text = cleanText(s.raw);
  fs.writeFileSync(path.join(ARGS.out, `claude-${label}-${arm}.text.txt`), `${text.slice(0, 6000)}\n`);
  const alive = !s.exit;
  const before = alive ? descendants(s.t.pid) : [];
  if (alive) treeKill.killPaneTreesSync([s.t]);
  await waitFor(() => s.exit, 10000);
  await sleep(1500);
  const left = stillAlive(before); reap(left);
  return {
    sink: sinkInfo, spawn: path.basename(target.file), bin: path.basename(target.bin), argv: argvShape,
    cmdline_chars: cmdLine.length, cmdline_has_newline: /\n/.test(cmdLine),
    trust_written: trustOk, trust_keys_before: trustKeys, trust_keys_after: (() => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects || {}); } catch { return null; } })(),
    trust_dialog: /trust this folder|Quick safety check|Do you trust/i.test(cleanText(s.raw)),
    alive, exit: alive ? null : s.exit, bytes: s.bytes, box_ms: boxMs, typed,
    text_tail: text.replace(/\s+/g, ' ').trim().slice(-700), leftover: left.map((p) => p.name),
  };
}
async function scenarioClaude() {
  const want = process.env.PROBE_CLAUDE_ARMS ? process.env.PROBE_CLAUDE_ARMS.split(',') : null;
  const arms = [
    ['worker', { type: true }],
    ['worker-nosink', { sink: false, type: true }],
    ['worker-fresh-home', { onboarded: false }],
    ['resume-missing', { spawn: { resume: true, sessionId: '11111111-2222-4333-8444-555555555555' } }],
  ].filter(([a]) => !want || want.includes(a));
  for (const { label, dir } of ARGS.claude) {
    for (const [arm, opts] of arms) {
      let r;
      try { r = await claudeArm(label, dir, arm, opts); } catch (e) { r = { error: String(e && e.stack || e).slice(0, 1200) }; }
      // Measured, not judged by the arm: an arm passes when the pane is alive at the end
      // (and typed text reached the box). A death is the finding.
      report(`claude-${label}-${arm}`, !!r.alive && (!r.typed || r.typed.in_box), r);
    }
  }
}

// ---------- cldeliver ----------
// The leader's pane is a real Claude Code pane. The app writes a team-chat job into it only
// when its delivery gate reads the pane as idle: agentxDeliver.paneStateOf({bytes, buffer,
// ghost}) === 'idle', buffer = paneScreen.composerLines(). Measured per width and per screen:
//   idle         fresh session, empty input box
//   after-model  the user ran /model and kept the current model (local picker, no model call)
//   after-reply  the user typed a line in the pane itself (the FAKE key is rejected: an error line)
// For each: the gate state (with and without the Windows ghost context the app passes when
// nobody touched the box), the reader's verdict + branch, the bottom rows of the box, the wrap
// flags, and the raw pty stream for replay. On 'idle' the app's own writer (deliverPrompt) puts
// a job in the box; the Enter key write is swallowed, so nothing is sent.
async function scenarioClDeliver() {
  const xd = appOpt('agentxDeliver.cjs');
  const dp = appOpt('deliverPrompt.cjs');
  const widths = (process.env.PROBE_CLD_COLS || '120,60').split(',').map(Number).filter((n) => n >= 20 && n <= 300);
  const wantArms = (process.env.PROBE_CLD_ARMS || 'idle,after-model,after-reply').split(',');
  const wantLabels = process.env.PROBE_CLD_LABELS ? process.env.PROBE_CLD_LABELS.split(',') : null;
  const gateOf = (s) => {
    const buffer = composerText(s);
    const out = {};
    const st = (ghost) => { try { return xd.paneStateOf({ bytes: s.bytes, buffer, ...(ghost ? { ghost } : {}) }); } catch (e) { return `error: ${String(e && e.message).slice(0, 120)}`; } };
    out.state = st(null);
    out.state_ghost = IS_WIN ? st({ machineText: null }) : null;
    const dg = (o) => { try { const d = composer.composerDiag(buffer, o); return { verdict: d.verdict, branch: d.branch, engine: d.engine || null }; } catch (e) { return { error: String(e && e.message).slice(0, 120) }; } };
    out.diag = dg({ ignoreRunning: true });
    out.diag_engine = dg({ ignoreRunning: true, engine: 'claude' });
    out.tail = buffer.split('\n').slice(-8);
    return out;
  };
  for (const { label, dir } of ARGS.claude) {
    if (wantLabels && !wantLabels.includes(label)) continue;
    for (const cols of widths) {
      for (const arm of wantArms) {
        const id = `cldeliver-${label}-c${cols}-${arm}`;
        if (xd.loadError || typeof xd.paneStateOf !== 'function') { report(id, false, { error: 'agentxDeliver not loadable', detail: xd.loadError || null }); continue; }
        const { home, work } = claudeHome(`cld-${label}-${cols}-${arm}`, true);
        const env = envFor(home, dir, { ANTHROPIC_API_KEY: FAKE_ANTHROPIC, DISABLE_AUTOUPDATER: '1' });
        let plan = null; let planErr = null;
        withAppHome(home, () => {
          let sink = null;
          if (spawnPromptFile) { try { sink = spawnPromptFile.createSink({ engine: 'claude', bin: engineInstall.resolveBinary('claude', env), env, home: appDataDir(home), log: () => {} }); } catch { sink = null; } }
          try { plan = agentRunner.buildSpawn({ command: 'claude', agentId: `probe-cld-${arm}`, cwd: work, disallowSubagent: true }, env, ARGS.app, sink ? { promptFile: sink } : {}); } catch (e) { planErr = String(e && e.message || e).slice(0, 300); }
          if (plan && plan.trust && plan.trust.pending) { try { agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env); } catch { /* measured below */ } }
        });
        const target = plan ? paneTarget(plan) : null;
        if (!target) { report(id, false, { plan_error: planErr, resolved: null }); continue; }
        const s = spawnPane(target.file, target.argv, { cwd: work, env: plan.env, cols, rows: 32, rawCap: 8 << 20 });
        const box = () => /❯|Try "|for shortcuts|bypass permissions/.test(liveText(s));
        await waitFor(() => s.exit || box(), 45000, 250);
        const boxMs = box() ? Date.now() - s.startedAt : null;
        await sleep(5000);
        const steps = [];
        if (!s.exit && arm === 'after-model') {
          s.t.write('/model'); await sleep(1200); s.t.write('\r'); await sleep(3000);
          steps.push({ at: 'picker-open', ...gateOf(s) });
          s.t.write('\r'); await sleep(3000);
        } else if (!s.exit && arm === 'after-reply') {
          s.t.write('merhaba'); await sleep(800); s.t.write('\r'); await sleep(12000);
        }
        // Poll the gate like the app does (300 ms, here 20 s: the app's own fresh cap is 9 s).
        let gate = gateOf(s); let firstIdleMs = gate.state === 'idle' ? 0 : null; const t0 = Date.now();
        const seen = new Set([`${gate.state}|${gate.diag.verdict}|${gate.diag.branch}`]);
        while (Date.now() - t0 < 20000 && !s.exit) {
          await sleep(300); const g = gateOf(s);
          seen.add(`${g.state}|${g.diag.verdict}|${g.diag.branch}`);
          if (g.state === 'idle' && firstIdleMs == null) firstIdleMs = Date.now() - t0;
          gate = g;
        }
        fs.writeFileSync(path.join(ARGS.out, `${id}.composer.txt`), `${composerText(s)}\n`);
        fs.writeFileSync(path.join(ARGS.out, `${id}.screen.txt`), `${liveText(s)}\n`);
        let deliver = null; let jobOnScreen = null; let swallowed = 0;
        if (gate.state === 'idle' && arm === 'idle' && !dp.loadError && typeof dp.deliverPrompt === 'function') {
          const job = `CLDELIVER probe job ${label} ${cols}`;
          const io = {
            readPaneBuffer: () => composerText(s),
            writePane: (_id, data) => { if (data === '\r' || data === '\r\n') { swallowed += 1; return true; } s.t.write(data); return true; },
            sleep, now: () => Date.now(), livePaneCount: () => 1, platform: process.platform,
            bracketedPasteMode: () => { const on = s.raw.lastIndexOf('\x1b[?2004h'); return on < 0 ? null : on > s.raw.lastIndexOf('\x1b[?2004l'); },
            log: () => {},
          };
          try {
            const r = await Promise.race([dp.deliverPrompt(id, job, { mode: 'auto', label: 'probe', bracketed: 'always', a4: true }, io), sleep(60000).then(() => ({ outcome: 'probe-timeout' }))]);
            deliver = { outcome: r && r.outcome, reason: r && r.reason };
          } catch (e) { deliver = { error: String(e && e.message).slice(0, 200) }; }
          await sleep(2500);
          jobOnScreen = liveText(s).replace(/\s+/g, ' ').includes(job);
        }
        const wrap = dumpRawAndWrap(s, id);
        const alive = !s.exit;
        const kids = alive ? descendants(s.t.pid) : [];
        if (alive) treeKill.killPaneTreesSync([s.t]);
        await waitFor(() => s.exit, 10000);
        await sleep(1500);
        const left = stillAlive(kids); reap(left);
        report(id, gate.state === 'idle', {
          expect: 'the app\'s delivery gate reads the waiting Claude pane as idle',
          cols, arm, box_ms: boxMs, alive, first_idle_ms: firstIdleMs, final: gate, seen: [...seen], steps,
          deliver, enter_swallowed: swallowed, job_on_screen: jobOnScreen, wrap, overlay: ARGS.overlay ? ARGS.overlayFiles : null,
          leftover: left.map((p) => p.name),
        });
      }
    }
  }
}

// ---------- agyping ----------
// Antigravity "signed in -> connected" check, run by the app's own engineAuthGate with a FAKE
// agy binary: a .cmd shim (like an npm-installed CLI) that prints a canned answer to `-p` and
// counts its calls. No account, no network, nothing reaches Google. The app's binary override
// (AGENTSPACE_FAKE_ENGINE_BIN) points the gate at the fake. Each arm has its own made-up home
// (USERPROFILE), so the home folder in the fake's error line is a real Windows path built by
// the OS (os.homedir()), with a space and non-ASCII letters in the user name.
// All names are MADE UP (Ayşe Örnekoğlu, ayse.ornek@example.com); the token is not a real token.
const AGY_ARMS = {
  ok: { user: 'Ayse', lines: null, expect: 'bagli' },
  D0: { user: 'Ayse', home: true, lines: (h) => [`Loading credentials from ${h}\\.gemini\\antigravity-cli\\oauth.json`, `Error: 403 PERMISSION_DENIED: The caller does not have permission (account ayse.ornek@example.com) at ${h}\\.gemini\\antigravity-cli\\oauth.json`], forbid: ['Ayse', 'ayse.ornek@example.com'] },
  D1: { user: 'Ayşe Örnekoğlu', home: true, lines: (h) => [`Error: 403 PERMISSION_DENIED: cannot read ${h}\\.gemini\\antigravity-cli\\oauth.json`], forbid: ['Ayşe', 'Örnekoğlu'] },
  D2: { user: 'Ayşe Örnekoğlu', home: true, lines: (h) => [JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', path: `${h}\\.gemini\\antigravity-cli\\oauth.json` } })], forbid: ['Ayşe', 'Örnekoğlu'] },
  D3: { user: 'Ayse', lines: () => ['\u001b[2K\rConnecting... \rConnecting... ', '\u001b[33mwarning\u001b[0m: telemetry disabled', '\u001b[31mError: 401 UNAUTHENTICATED\u001b[0m Authorization: Bearer ya29.a0AfB_byC9xQ7mZ-ExampleOnly_NotARealToken_4f3e2d1c0b9a8 for Ayse.Ornek+AGY@Example.COM'], forbid: ['ya29.a0AfB_byC9xQ7mZ-ExampleOnly_NotARealToken_4f3e2d1c0b9a8', 'Ayse.Ornek+AGY@Example.COM', 'Ornek+AGY'] },
  // The OS builds the line: Node's own ENOENT message for the credentials file under the home.
  D4: { user: 'Ayşe Örnekoğlu', home: true, lines: 'os-error', forbid: ['Ayşe', 'Örnekoğlu'] },
};
function fakeAgy(dir) {
  const js = path.join(dir, 'fake-agy.js');
  fs.writeFileSync(js, `'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const a = process.argv.slice(2);
try { fs.appendFileSync(process.env.AGY_FAKE_CALLS, JSON.stringify({ at: Date.now(), argv0: a[0] || '' }) + '\\n'); } catch {}
if (a[0] === '--version' || a[0] === '-v') { process.stdout.write('1.1.28\\n'); process.exit(0); }
if (a[0] === 'models') { process.stdout.write('gemini-3-pro\\n'); process.exit(0); }
if (a[0] !== '-p') { process.stderr.write('fake agy: interactive start not supported\\n'); process.exit(2); }
const mode = process.env.AGY_FAKE_MODE;
if (mode === 'ok') { process.stdout.write('OK\\n'); process.exit(0); }
if (mode === 'os-error') {
  try { fs.readFileSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'oauth.json')); }
  catch (e) { process.stderr.write('Error: not logged in: ' + e.message + '\\n'); }
  process.exit(1);
}
for (const l of JSON.parse(process.env.AGY_FAKE_LINES || '[]')) process.stderr.write(l + '\\n');
process.exit(1);
`);
  const node = process.env.PROBE_NODE || 'node';
  if (IS_WIN) {
    const cmd = path.join(dir, 'agy.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${node}" "%~dp0fake-agy.js" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'agy');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/fake-agy.js" "$@"\n`, { mode: 0o755 });
  return sh;
}
async function scenarioAgyPing() {
  const gate = appOpt('engineAuthGate.cjs');
  if (gate.loadError || typeof gate.verifyEngine !== 'function' || typeof gate.decorateStatus !== 'function') {
    report('agyping-load', false, { error: 'engineAuthGate not loadable', loadError: gate.loadError || null });
    return;
  }
  const binDir = isoHome('agy-bin');
  const bin = fakeAgy(binDir);
  for (const [arm, spec] of Object.entries(AGY_ARMS)) {
    const id = `agyping-${arm}`;
    const box = isoHome(`agy-${arm}`);
    const calls = path.join(box, 'calls.jsonl');
    // The fake's home (what os.homedir() returns in it) is this platform's; the canned lines
    // always carry the Windows form, as a Windows engine prints them.
    const home = IS_WIN ? `C:\\Users\\${spec.user}` : `/Users/${spec.user}`;
    const lines = typeof spec.lines === 'function' ? spec.lines(`C:\\Users\\${spec.user}`) : [];
    const env = {
      ...process.env, USERPROFILE: home, HOME: home,
      APPDATA: path.join(box, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(box, 'AppData', 'Local'),
      AGENTSPACE_FAKE_ENGINE_BIN: '1', AGENTSPACE_ENGINE_BIN_ANTIGRAVITY: bin,
      AGY_FAKE_CALLS: calls, AGY_FAKE_MODE: spec.lines === 'os-error' ? 'os-error' : arm === 'ok' ? 'ok' : 'lines',
      AGY_FAKE_LINES: JSON.stringify(lines),
    };
    // The status row the app reads before the check: installed, signed in, not checked yet.
    const row = { engine: 'antigravity', installed: true, loggedIn: true, flow: 'external' };
    const deps = { env, statusRow: row, cwd: box, probeTimeoutMs: 60000, platform: process.platform };
    let before = null; let res = null; let after = null; let after2 = null; let err = null;
    try {
      gate.forgetVerification('antigravity');
      before = gate.decorateStatus(row, deps);
      res = await gate.verifyEngine('antigravity', deps);
      after = gate.decorateStatus(row, deps);
      await sleep(3000); // idle: no new check may start by itself
      after2 = gate.decorateStatus(row, deps);
    } catch (e) { err = String(e && e.stack || e).slice(0, 1200); }
    const nCalls = (() => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).argv0 === '-p').length; } catch { return 0; } })();
    const pick = (o) => (o ? { kurulumDurumu: o.kurulumDurumu, verified: o.verified, verifyUntried: o.verifyUntried, verifyError: o.verifyError, verifyReason: o.verifyReason, verifyDetail: o.verifyDetail } : null);
    const shown = (after && after.verifyDetail) || '';
    const leaked = (spec.forbid || []).filter((w) => shown.includes(w) || (res && String(res.satir || '').includes(w)));
    let pass; let expect;
    if (arm === 'ok') {
      expect = "before 'girisli' (untried), one check, then 'bagli' with no error";
      pass = !err && before && before.kurulumDurumu === 'girisli' && before.verifyUntried === true
        && res && res.verified === true && after && after.kurulumDurumu === 'bagli' && after.verified === true && !after.verifyError && nCalls === 1;
    } else {
      expect = "one check; reason 'ret'; engine line shown with the home folder -> ~ (arms with a path) and e-mail/token masked; settings row == setup row; no new check when idle";
      pass = !err && res && res.verified === false && res.neden === 'ret' && nCalls === 1
        && after && after.verified === false && after.verifyReason === res.neden && after.verifyDetail === res.satir && after.verifyError === res.error
        && !!res.satir && leaked.length === 0 && (!spec.home || /~/.test(res.satir)) && !/\u001b/.test(res.satir)
        && JSON.stringify(pick(after)) === JSON.stringify(pick(after2));
    }
    report(id, !!pass, {
      expect, user_dir: arm === 'ok' ? null : (spec.user.includes(' ') ? 'spaced, non-ASCII' : 'plain'),
      checks_run: nCalls, result: res ? { verified: res.verified, error: res.error, neden: res.neden, satir: res.satir } : null,
      before: pick(before), after: pick(after), after_idle: pick(after2), leaked, error: err,
    });
  }
}

function versionOf(binDir) {
  try {
    const pkg = path.join(binDir, IS_WIN ? '' : '..', 'lib', 'node_modules', 'opencode-ai', 'package.json');
    const alt = path.join(binDir, 'node_modules', 'opencode-ai', 'package.json');
    const f = fs.existsSync(pkg) ? pkg : alt;
    return JSON.parse(fs.readFileSync(f, 'utf8')).version;
  } catch { return null; }
}

(async () => {
  const want = (id) => !ARGS.only || ARGS.only.includes(id);
  const steps = [['tree', scenarioTree], ['storm', scenarioStorm], ['burst', scenarioBurst], ['chars', scenarioChars], ['codex', scenarioCodex], ['opencode', scenarioOpencode], ['ocstart', scenarioOpencodeStart], ['ocreader', scenarioOcReader], ['ocdeliver', scenarioOcDeliver], ['claude', scenarioClaude], ['cldeliver', scenarioClDeliver], ['agyping', scenarioAgyPing]];
  for (const [id, fn] of steps) {
    if (!want(id)) continue;
    try { await fn(); } catch (e) { report(`${id}-crashed`, false, { error: String(e && e.stack || e).slice(0, 1500) }); }
  }
  const failed = results.filter((r) => !r.pass);
  fs.writeFileSync(path.join(ARGS.out, 'summary.json'), `${JSON.stringify({ platform: process.platform, arch: process.arch, versions: process.versions, results }, null, 2)}\n`);
  console.log(failed.length ? `FAILED: ${failed.map((f) => f.id).join(', ')}` : 'ALL OK');
  process.exit(failed.length ? 1 : 0);
})();
