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
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const ARGS = (() => {
  const a = { app: null, out: 'engine-probe', codex: [], opencode: [], only: null };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i]; const n = v[i + 1];
    if (k === '--app') { a.app = n; i++; }
    else if (k === '--out') { a.out = n; i++; }
    else if (k === '--codex') { a.codex = parsePairs(n); i++; }
    else if (k === '--opencode') { a.opencode = parsePairs(n); i++; }
    else if (k === '--only') { a.only = n.split(','); i++; }
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

const app = (rel) => require(path.join(ARGS.app, rel));
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
function descendants(rootPid, table = procTable()) {
  const out = []; const seen = new Set([rootPid]); let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) if (seen.has(p.ppid) && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); grew = true; }
  }
  return out;
}
// A process counts as left over only if the SAME pid with the SAME start time still
// exists (Windows hands out freed pids again within seconds).
function stillAlive(list, table = procTable()) {
  const now = new Set(table.map((p) => `${p.pid}@${p.start}`));
  return list.filter((p) => now.has(`${p.pid}@${p.start}`));
}
function reap(list) { for (const p of list) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }

function spawnPane(file, argv, opts = {}) {
  const t = pty.spawn(file, argv, {
    name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32,
    cwd: opts.cwd || os.tmpdir(), env: opts.env || process.env,
    ...(IS_WIN ? { useConpty: true } : {}),
  });
  const screen = paneScreen.createPaneScreen({ cols: opts.cols || 120, rows: opts.rows || 32 });
  const state = { t, screen, bytes: 0, exit: null, startedAt: Date.now(), raw: '' };
  t.onData((d) => { state.bytes += d.length; if (state.raw.length < 400000) state.raw += d; try { screen.write(d); } catch { /* reader fault */ } });
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
      }
      saveScreen(`opencode-${label}-${arm}`, s);
      // OpenCode draws on the alternate screen: dump the ACTIVE buffer as well.
      try {
        const b = s.screen.term.buffer.active;
        const rows = [];
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) rows.push(l.translateToString(true)); }
        fs.writeFileSync(path.join(ARGS.out, `opencode-${label}-${arm}.active.txt`), `${b.type}\n${rows.join('\n')}\n`);
      } catch { /* screen model gone */ }
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
        bin: path.basename(target.bin), spawn: path.basename(target.file), exit_before_25s: alive ? null : s.exit, bytes: s.bytes,
        env_autoupdate: plan.env.OPENCODE_DISABLE_AUTOUPDATE || null, plugin_in_config: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
        version_before: verBefore, version_after: versionOf(dir),
        descendants_before: before.map((p) => p.name), leftover: left.map((p) => p.name),
      });
    }
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
  const steps = [['tree', scenarioTree], ['storm', scenarioStorm], ['burst', scenarioBurst], ['chars', scenarioChars], ['codex', scenarioCodex], ['opencode', scenarioOpencode]];
  for (const [id, fn] of steps) {
    if (!want(id)) continue;
    try { await fn(); } catch (e) { report(`${id}-crashed`, false, { error: String(e && e.stack || e).slice(0, 1500) }); }
  }
  const failed = results.filter((r) => !r.pass);
  fs.writeFileSync(path.join(ARGS.out, 'summary.json'), `${JSON.stringify({ platform: process.platform, arch: process.arch, versions: process.versions, results }, null, 2)}\n`);
  console.log(failed.length ? `FAILED: ${failed.map((f) => f.id).join(', ')}` : 'ALL OK');
  process.exit(failed.length ? 1 : 0);
})();
