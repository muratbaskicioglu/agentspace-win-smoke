// First-run probe that runs the INSTALLED app's own modules, read from its app.asar.
//
// Run it with the app's own binary in Node mode (ELECTRON_RUN_AS_NODE=1), so the
// code that is measured is the code the installer shipped. No account, no network,
// no window. Everything is written to a throwaway home.
//
// Checks:
//   agy-hook  The app writes the Antigravity (Gemini) hook file for a leader pane.
//             Every hook command in that file is then run the way Antigravity runs it
//             (Windows: ComSpec /c, the same call the app's own later self-test uses;
//             macOS/Linux: /bin/sh -c). A hook "runs" when it exits 0 and the shell
//             did not report "not recognized" / "not found".
//   memory    The app's own memory brake (resourceGovernor): a real sample on this
//             machine, the level it gives with the default thresholds, the agent and
//             pane limits it derives, and a raised threshold, to show the brake trips.
//   agy-signin  (opt-in: --check agy-signin) A pre-signed-in Antigravity: the app's own
//             engineAuthGate runs its one-shot check against a STRICT fake agy
//             (scripts/fakeAgy.cjs: only the real agy 1.4.12 flags; no account, no network).
//             Pass = 'girisli' before, exactly one check, no flag rejected, 'bagli' after.
//             A build whose check sends a flag the real agy rejects (v0.4.9: `-o`) fails here.
//
// Usage:
//   ELECTRON_RUN_AS_NODE=1 <AgentSpace binary> scripts/appProbe.cjs \
//     --app <path to resources/app.asar> --out <dir> [--check agy-hook,memory] [--label <name>]
//
// Exit: 0 every check passed, 1 a check failed, 2 the probe could not measure.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ARGS = (() => {
  const a = { app: null, out: 'app-probe', check: ['agy-hook', 'memory'], label: '' };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i]; const n = v[i + 1];
    if (k === '--app') { a.app = n; i++; }
    else if (k === '--out') { a.out = n; i++; }
    else if (k === '--check') { a.check = String(n || '').split(',').filter(Boolean); i++; }
    else if (k === '--label') { a.label = String(n || ''); i++; }
  }
  return a;
})();
if (!ARGS.app) { console.error('--app required'); process.exit(2); }
for (const c of ARGS.check) {
  if (!['agy-hook', 'memory', 'agy-signin'].includes(c)) { console.error(`unknown check ${c}`); process.exit(2); }
}
fs.mkdirSync(ARGS.out, { recursive: true });

// Before ANY app module loads: pin the app's data root to a throwaway folder.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'as-app-probe-'));
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.AGENTDESK_HOME = HOME;
process.env.AGENTDESK_INSTANCE = 'test';

const app = (rel) => require(path.join(ARGS.app, rel));
const result = {
  label: ARGS.label,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  appVersion: (() => { try { return app('package.json').version; } catch { return null; } })(),
  checks: {},
};

function tail(s, n = 300) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Paths in the output are made relative to the throwaway home, so nothing about the
// machine's user folder is kept.
function scrub(s) {
  return String(s || '').split(BASE).join('<probe>');
}

function collectCommands(node, at, out) {
  if (Array.isArray(node)) { node.forEach((x, i) => collectCommands(x, `${at}[${i}]`, out)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'command' && typeof v === 'string') out.push({ at: `${at}.command`, command: v });
    else collectCommands(v, at ? `${at}.${k}` : k, out);
  }
}

function findFiles(dir, name, out = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

// The pane environment, built like the app builds it for an engine pane: the engine
// itself does not know the app's root (the hook carries --home), and it does not run
// in Node mode. Builds that add a hook wrapper put its folder and variables in here.
function paneEnv() {
  const env = { ...process.env };
  delete env.AGENTDESK_HOME;
  delete env.AGENTDESK_INSTANCE;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runHook(command, stdin, env) {
  const r = process.platform === 'win32'
    ? cp.spawnSync(env.ComSpec || env.COMSPEC || 'cmd.exe', ['/c', command], {
      env, input: stdin, encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    : cp.spawnSync('/bin/sh', ['-c', command], { env, input: stdin, encoding: 'utf8', timeout: 20000 });
  const stderr = String(r.stderr || '');
  const notFound = /is not recognized|cannot find the path|not found|No such file/i.test(stderr);
  return {
    status: r.status,
    error: r.error ? (r.error.code || r.error.message) : null,
    ok: r.status === 0 && !r.error && !notFound,
    stdout: scrub(tail(r.stdout)),
    stderr: scrub(tail(stderr)),
  };
}

function checkAgyHook() {
  const agentRunner = app('agentRunner.js');
  const [leaderRole] = app('leaderRole.cjs').LEADER_SLUGS;
  if (typeof agentRunner.withAgyHooks !== 'function') {
    return { verdict: 'unmeasured', reason: 'withAgyHooks is not exported by this build' };
  }
  const opts = { agentId: 'probe-lead', leaderId: 'probe-lead', role: leaderRole, department: 'probe', disallowSubagent: true };
  const childEnv = paneEnv();
  let argv;
  try {
    // 5th argument: what the app's own spawn passes (older builds ignore it).
    argv = agentRunner.withAgyHooks(['-p', 'PROMPT'], 'antigravity', opts, HOME, { childEnv, fact: {}, log: () => {} });
  } catch (err) {
    return { verdict: 'fail', reason: `hook writer threw: ${scrub(tail(err && err.stack, 600))}` };
  }
  const files = findFiles(HOME, 'hooks.json');
  if (!files.length) return { verdict: 'fail', reason: 'the app wrote no hooks.json', argv: scrub(JSON.stringify(argv)) };
  const hooks = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { return { verdict: 'fail', reason: `hooks.json does not parse: ${err.message}` }; }
    collectCommands(doc, '', hooks);
  }
  if (!hooks.length) return { verdict: 'fail', reason: 'hooks.json has no command' };
  // The same input the app's later self-test sends: an MCP tool call through the guard.
  const toolCall = JSON.stringify({
    toolCall: { name: 'call_mcp_tool', args: { ServerName: 'agentspace_selftest', ToolName: 'agentspace_selftest_ping' } },
  });
  const runs = hooks.map((h) => ({ at: h.at, command: scrub(h.command), ...runHook(h.command, toolCall, childEnv) }));
  const failed = runs.filter((r) => !r.ok);
  return {
    verdict: failed.length ? 'fail' : 'pass',
    hookFiles: files.map(scrub),
    hookCount: runs.length,
    failedCount: failed.length,
    runs,
  };
}

function checkMemory() {
  const gov = app('resourceGovernor.cjs');
  // The app's readers take the command runner as an argument (in the app it runs the
  // commands off the main thread). Here a plain synchronous runner is fine.
  const io = { exec: (file, args) => cp.execFileSync(file, args, { encoding: 'utf8', timeout: 5000 }) };
  const sample = gov.readMemory(io);
  if (!sample) return { verdict: 'unmeasured', reason: 'readMemory returned null' };
  const osPressure = gov.readOsPressure(io);
  const swapUsedMB = gov.readSwapMB(io);
  const full = { ...sample, osPressure, swapUsedMB };
  const level = gov.computeLevel(full, gov.DEFAULTS);
  // A raised threshold (what a user can set in Settings): the brake must trip on this
  // same sample. This is the "fake measurement" arm kept as a unit test in the app repo.
  const raisedWarn = Math.min(95, Math.ceil(sample.freePct) + 5);
  const raised = gov.computeLevel(full, { ...gov.DEFAULTS, warnFreePct: raisedWarn, criticalFreePct: Math.min(raisedWarn, 15) });
  let vmStat = null;
  if (process.platform === 'darwin') {
    try { vmStat = cp.execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8' }); } catch { /* not measured */ }
  }
  const gb = (b) => +(b / 1024 ** 3).toFixed(2);
  return {
    verdict: 'pass',
    totalGB: gb(sample.totalBytes),
    availableGB: gb(sample.availableBytes),
    freePct: sample.freePct,
    osPressure,
    swapUsedMB,
    defaults: { warnFreePct: gov.DEFAULTS.warnFreePct, criticalFreePct: gov.DEFAULTS.criticalFreePct },
    level: level.level,
    reasonCodes: level.reasonCodes,
    agentLimit: typeof gov.deriveAgentLimit === 'function' ? gov.deriveAgentLimit(sample.totalBytes) : null,
    paneCap: typeof gov.derivePaneCap === 'function' ? gov.derivePaneCap(sample.totalBytes) : null,
    raisedThreshold: { warnFreePct: raisedWarn, level: raised.level, reasonCodes: raised.reasonCodes },
    vmStat,
  };
}

async function checkAgySignin() {
  const gate = app('engineAuthGate.cjs');
  if (typeof gate.verifyEngine !== 'function' || typeof gate.decorateStatus !== 'function') {
    return { verdict: 'unmeasured', reason: 'engineAuthGate.verifyEngine/decorateStatus not exported by this build' };
  }
  const FAKE = require('./fakeAgy.cjs');
  const node = process.env.PROBE_NODE || 'node';
  const bin = FAKE.writeFakeAgy(path.join(BASE, 'agy-bin'), node);
  // Control: the fake itself must reject the broken form and accept the real one.
  const self = FAKE.selfTest(bin, { ...process.env, AGY_FAKE_CALLS: path.join(BASE, 'agy-selftest.jsonl') });
  if (!self.pass) return { verdict: 'unmeasured', reason: 'strict fake agy self-test failed (no usable node?)', selfTest: self.arms };
  const calls = path.join(BASE, 'agy-calls.jsonl');
  const env = {
    ...paneEnv(), HOME, USERPROFILE: HOME,
    AGENTSPACE_FAKE_ENGINE_BIN: '1', AGENTSPACE_ENGINE_BIN_ANTIGRAVITY: bin,
    AGY_FAKE_CALLS: calls, AGY_FAKE_MODE: 'ok',
  };
  // The status row the app reads for a signed-in agy before its first check.
  const row = { engine: 'antigravity', installed: true, loggedIn: true, flow: 'external' };
  const deps = { env, statusRow: row, cwd: HOME, probeTimeoutMs: 60000, platform: process.platform };
  if (typeof gate.forgetVerification === 'function') gate.forgetVerification('antigravity');
  const before = gate.decorateStatus(row, deps);
  const res = await gate.verifyEngine('antigravity', deps);
  const after = gate.decorateStatus(row, deps);
  let recs = [];
  try { recs = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.argv0 === '-p'); } catch { /* none */ }
  const flagErrors = recs.map((c) => c.err).filter(Boolean);
  const pass = flagErrors.length === 0 && recs.length === 1
    && before && before.kurulumDurumu === 'girisli'
    && res && res.verified === true
    && after && after.kurulumDurumu === 'bagli' && after.verified === true && !after.verifyError;
  return {
    verdict: pass ? 'pass' : 'fail',
    fakeVersion: FAKE.AGY_VERSION,
    selfTest: self.arms.map((a) => ({ argv: a.argv, code: a.code, first: a.first })),
    checksRun: recs.length,
    sent: recs.map((c) => ({ flags: c.flags, flagError: c.err || null })),
    flagErrors,
    result: res ? { verified: res.verified, error: res.error || null, neden: res.neden || null, satir: scrub(tail(res.satir, 200)) } : null,
    before: before ? before.kurulumDurumu : null,
    after: after ? after.kurulumDurumu : null,
  };
}

(async () => {
let exit = 0;
for (const c of ARGS.check) {
  let r;
  try {
    r = c === 'agy-hook' ? checkAgyHook() : c === 'agy-signin' ? await checkAgySignin() : checkMemory();
  } catch (err) {
    r = { verdict: 'unmeasured', reason: scrub(tail(err && err.stack, 800)) };
  }
  result.checks[c] = r;
  if (r.verdict === 'fail') exit = Math.max(exit, 1);
  else if (r.verdict !== 'pass' && exit === 0) exit = 2;
}
result.exit = exit;
const name = `app-probe${ARGS.label ? `-${ARGS.label}` : ''}.json`;
fs.writeFileSync(path.join(ARGS.out, name), JSON.stringify(result, null, 2));
for (const [c, r] of Object.entries(result.checks)) {
  const extra = c === 'agy-signin'
    ? ` before=${r.before} after=${r.after} checks=${r.checksRun ?? '-'} flagErrors=${JSON.stringify(r.flagErrors || [])} result=${JSON.stringify(r.result || null)}${r.reason ? ` reason=${r.reason}` : ''}`
    : c === 'agy-hook'
    ? ` hooks=${r.hookCount ?? '-'} failed=${r.failedCount ?? '-'}${r.runs ? ` first=${JSON.stringify((r.runs.find((x) => !x.ok) || r.runs[0]).stderr || '')}` : ''}${r.reason ? ` reason=${r.reason}` : ''}`
    : ` total=${r.totalGB}GB free=${r.freePct}% os=${r.osPressure} level=${r.level} agentLimit=${r.agentLimit} paneCap=${r.paneCap} raised(${r.raisedThreshold && r.raisedThreshold.warnFreePct}%)=${r.raisedThreshold && r.raisedThreshold.level}${r.reason ? ` reason=${r.reason}` : ''}`;
  console.log(`app-probe ${c}: ${r.verdict}${extra}`);
}
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(exit);
})();
