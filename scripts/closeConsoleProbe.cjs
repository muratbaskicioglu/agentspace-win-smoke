// Close-console probe: runs the INSTALLED app's own spawn code and shows whether a
// console program it starts gets a VISIBLE console window on Windows.
//
// Run it with the app's own binary in Node mode (ELECTRON_RUN_AS_NODE=1), started with
// redirected stdout/stderr. Then the process has NO console, the same as the app's main
// process started from the Start menu. A console program (ping.exe, taskkill.exe,
// cmd.exe) that such a process starts gets a NEW console. Whether that console has a
// window depends only on the spawn options, and that is what each case measures.
// closeConsole.ps1 counts the new windows while the probe runs.
//
// Cases ("published" = the options the installer shipped; "fix" = the same call with
// the change from the fix branch applied, because this repo never holds unreleased builds):
//   watchdog-published  quitFunnel.armExitWatchdog exactly as shipped (cmd.exe ping
//                       watchdog, detached: true). The probe exits after 1.5 s.
//   watchdog-fix        the same call, `detached` removed from the spawn options.
//   watchdog-fix-hang   like watchdog-fix, then the probe blocks its main thread (a hung
//                       main process). The watchdog must end it after about 6 s.
//   taskkill-published  platform/procProbe.terminateTree as shipped, on a dummy child
//                       (taskkill.exe with stdio 'ignore', no windowsHide).
//   taskkill-fix        the same call with the fixed default runner (windowsHide: true).
//   cli-published       an engine CLI status call in the shape engineAuth uses on Windows
//                       (cmd.exe /d /s /c "<shim>", verbatim args), no windowsHide.
//   cli-fix             the same call with windowsHide: true.
//
// Usage:
//   ELECTRON_RUN_AS_NODE=1 <AgentSpace.exe> scripts/closeConsoleProbe.cjs \
//     --app <resources/app.asar> --case <name> --out <file.json>
//
// Exit: 0 the case ran (the window count is closeConsole.ps1's job) | 2 not measured |
//       3 watchdog-fix-hang: the probe was NOT ended by the watchdog within 30 s.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const CASES = ['watchdog-published', 'watchdog-fix', 'watchdog-fix-hang',
  'taskkill-published', 'taskkill-fix', 'cli-published', 'cli-fix'];
const ARGS = (() => {
  const a = { app: null, case: null, out: null };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--app') a.app = v[++i];
    else if (v[i] === '--case') a.case = v[++i];
    else if (v[i] === '--out') a.out = v[++i];
  }
  return a;
})();
if (!ARGS.app || !ARGS.out || !CASES.includes(ARGS.case)) {
  console.error(`usage: --app <app.asar> --case <${CASES.join('|')}> --out <file.json>`);
  process.exit(2);
}

const result = { case: ARGS.case, pid: process.pid, exe: path.basename(process.execPath), started: new Date().toISOString() };
const save = () => fs.writeFileSync(ARGS.out, JSON.stringify(result, null, 2));
const appMod = (rel) => require(path.join(ARGS.app, rel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixOptions = (o) => { const { detached, ...rest } = o; return rest; }; // the fix branch diff

async function runWatchdog(variant) {
  const Q = appMod('quitFunnel.cjs');
  if (typeof Q.armExitWatchdog !== 'function') { result.error = 'armExitWatchdog not exported'; save(); process.exit(2); }
  const seen = [];
  const spawn = (file, args, options) => {
    const opts = variant === 'published' ? options : fixOptions(options);
    seen.push({ file, args, shipped_options: options, used_options: opts });
    return cp.spawn(file, args, opts);
  };
  // Same arguments as main.js armQuitBrake: own pid, QUIT_WATCHDOG_MS = 6000, own exe name.
  const r = Q.armExitWatchdog({}, { platform: 'win32', pid: process.pid, ms: 6000, exeName: path.basename(process.execPath), spawn, log: (m) => { result.log = m; } });
  result.armed = r;
  result.spawn = seen;
  result.armed_at = new Date().toISOString();
  save();
}

async function dummyChild() {
  // A harmless child to end with taskkill: the app binary itself in Node mode, idle.
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true,
  });
  await sleep(1500);
  return child;
}

async function main() {
  switch (ARGS.case) {
    case 'watchdog-published':
      await runWatchdog('published');
      await sleep(1500);
      process.exit(0);
      break;
    case 'watchdog-fix':
      await runWatchdog('fix');
      await sleep(1500);
      process.exit(0);
      break;
    case 'watchdog-fix-hang': {
      await runWatchdog('fix');
      result.hang_from = new Date().toISOString();
      save();
      // Block the main thread like a hung main process: no timers, no I/O, no exit.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      result.hang_survived_30s = true;
      save();
      process.exit(3);
      break;
    }
    case 'taskkill-published':
    case 'taskkill-fix': {
      const P = appMod('platform/procProbe.cjs');
      if (typeof P.terminateTree !== 'function') { result.error = 'terminateTree not exported'; save(); process.exit(2); }
      const child = await dummyChild();
      const deps = { platform: 'win32' };
      if (ARGS.case === 'taskkill-fix') {
        // Fixed default runner (procProbe.defaultTaskkillRun on the fix branch).
        deps.execFile = (file, argv) => cp.execFileSync(file, argv, { stdio: 'ignore', windowsHide: true });
      }
      result.target_pid = child.pid;
      result.terminate = P.terminateTree(child, deps);
      await sleep(800);
      result.target_exit = { code: child.exitCode, signal: child.signalCode };
      save();
      process.exit(0);
      break;
    }
    case 'cli-published':
    case 'cli-fix': {
      // engineAuth on Windows runs an npm .cmd shim through cmd.exe with verbatim args.
      const shimDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cc-shim-'));
      const shim = path.join(shimDir, 'engine.cmd');
      fs.writeFileSync(shim, '@echo off\r\necho {"loggedIn":false}\r\n');
      const opts = { env: process.env, windowsVerbatimArguments: true };
      if (ARGS.case === 'cli-fix') opts.windowsHide = true;
      const out = await new Promise((resolve) => {
        cp.execFile('cmd.exe', ['/d', '/s', '/c', `""${shim}" status"`], opts, (err, stdout) => resolve({ err: err && err.message, stdout: String(stdout || '').trim() }));
      });
      result.options = opts.windowsHide ? { windowsHide: true, windowsVerbatimArguments: true } : { windowsVerbatimArguments: true };
      result.cli = out;
      save();
      await sleep(800);
      process.exit(0);
      break;
    }
    default:
      process.exit(2);
  }
}

main().catch((e) => { result.error = String(e && e.stack || e); save(); process.exit(2); });
