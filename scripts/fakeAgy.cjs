'use strict';
// STRICT fake Antigravity CLI (agy) for the probes. No account, no network, nothing reaches Google.
//
// It accepts ONLY the flags the real agy 1.4.12 accepts (its own `agy --help`, measured on
// 2026-11-01) and answers an unknown flag the way the real one does: the line
// "flags provided but not defined: -o", then the usage text, exit 2.
// A lenient fake (anything after -p is fine) let a release ship `-o text`, which the real agy
// rejects on every machine (ARASTIRMA-KURULUM2-03). This fake makes that a red probe.
//
// Every call is appended to $AGY_FAKE_CALLS as one JSON line:
//   { at, argv0, flags: [flag names in order], err: <flag error or null> }
// The prompt text itself is not saved.
//
// Modes ($AGY_FAKE_MODE) for a valid print call: ok -> "OK" exit 0; os-error -> Node's own ENOENT
// for the credentials file under the home, exit 1; lines -> $AGY_FAKE_LINES on stderr, exit 1.
const fs = require('node:fs');
const path = require('node:path');

const AGY_VERSION = '1.4.12';
// Flags that take a value (next argument or --flag=value).
const VALUE_FLAGS = ['add-dir', 'agent', 'conversation', 'effort', 'input-format', 'json-schema', 'log-file', 'mode', 'model', 'output-format', 'print-timeout', 'project', 'settings', 'p', 'print', 'prompt', 'i', 'prompt-interactive'];
// Flags without a value.
const BOOL_FLAGS = ['c', 'continue', 'dangerously-skip-permissions', 'disable-slash-commands', 'new-project', 'remote-control', 'sandbox', 'version', 'v', 'h', 'help'];
const SUBCOMMANDS = ['agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update'];
const OUTPUT_FORMATS = ['text', 'json', 'stream-json'];
const PRINT_FLAGS = ['p', 'print', 'prompt'];

// Parse argv the way Go's flag package does: -x and --x are the same flag, parsing stops at
// the first non-flag argument or "--". Returns { flags: [{name, value}], err, rest }.
function parseArgv(argv) {
  const flags = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--') { i++; break; }
    if (!a.startsWith('-') || a === '-') break;
    const body = a.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const shown = a.slice(0, a.length - (eq >= 0 ? body.length - eq : 0));
    if (VALUE_FLAGS.includes(name)) {
      let value;
      if (eq >= 0) value = body.slice(eq + 1);
      else if (i + 1 < argv.length) value = String(argv[++i]);
      else return { flags, err: `flag needs an argument: ${shown}`, rest: [] };
      if (name === 'output-format' && !OUTPUT_FORMATS.includes(value)) {
        return { flags, err: `invalid value "${value}" for flag ${shown}: must be one of text, json, stream-json`, rest: [] };
      }
      flags.push({ name, value });
    } else if (BOOL_FLAGS.includes(name)) {
      flags.push({ name, value: true });
    } else {
      return { flags, err: `flags provided but not defined: ${shown}`, rest: [] };
    }
  }
  return { flags, err: null, rest: argv.slice(i).map(String) };
}

const USAGE = ['Usage of agy:',
  ...VALUE_FLAGS.concat(BOOL_FLAGS).filter((f) => !['v', 'h', 'help', 'version'].includes(f)).map((f) => `  ${f.length === 1 ? '-' : '--'}${f}`),
  '', 'Available subcommands:', ...SUBCOMMANDS.map((s) => `  ${s}`)];

// The fake's own main (runs when this file is the agy behind the shim).
function main(argv) {
  const calls = process.env.AGY_FAKE_CALLS;
  const log = (rec) => { if (!calls) return; try { fs.appendFileSync(calls, `${JSON.stringify({ at: Date.now(), ...rec })}\n`); } catch { /* best effort */ } };
  const sub = argv[0] && SUBCOMMANDS.includes(argv[0]) ? argv[0] : null;
  if (sub) {
    log({ argv0: sub, flags: [], err: null });
    if (sub === 'models') { process.stdout.write('gemini-3-pro\n'); return 0; }
    process.stderr.write(`fake agy: subcommand ${sub} not supported\n`);
    return 2;
  }
  const p = parseArgv(argv);
  const names = p.flags.map((f) => f.name);
  const printFlag = p.flags.find((f) => PRINT_FLAGS.includes(f.name));
  // argv0 '-p' for a print call, so older counters (argv0 === '-p') keep working.
  log({ argv0: printFlag ? '-p' : String(argv[0] || ''), flags: names, err: p.err });
  if (p.err) {
    process.stderr.write(`${p.err}\n${USAGE.join('\n')}\n`);
    return 2;
  }
  if (names.includes('version') || names.includes('v')) { process.stdout.write(`${AGY_VERSION}\n`); return 0; }
  if (!printFlag) { process.stderr.write('fake agy: interactive start not supported\n'); return 2; }
  const mode = process.env.AGY_FAKE_MODE;
  if (mode === 'ok') { process.stdout.write('OK\n'); return 0; }
  if (mode === 'os-error') {
    const os = require('node:os');
    try { fs.readFileSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'oauth.json')); } catch (e) { process.stderr.write(`Error: not logged in: ${e.message}\n`); }
    return 1;
  }
  for (const l of JSON.parse(process.env.AGY_FAKE_LINES || '[]')) process.stderr.write(`${l}\n`);
  return 1;
}

// Write the fake into <dir>: a copy of this file + a shim named agy(.cmd), like an npm CLI.
// node = the Node binary the shim runs (a real node, not the app's binary).
function writeFakeAgy(dir, node, isWin = process.platform === 'win32') {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'fake-agy.cjs');
  fs.copyFileSync(__filename, js);
  if (isWin) {
    const cmd = path.join(dir, 'agy.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${node}" "%~dp0fake-agy.cjs" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'agy');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/fake-agy.cjs" "$@"\n`, { mode: 0o755 });
  return sh;
}

// Self-test: the fake must reject the argv a broken release used and accept the real form.
// Returns { pass, arms: [{argv, code, first, want}] }. Runs the fake through its shim.
function selfTest(bin, env) {
  const cp = require('node:child_process');
  const prompt = 'Say OK.';
  const arms = [
    { argv: ['-p', prompt, '-o', 'text'], want: { code: 2, first: 'flags provided but not defined: -o' } },
    { argv: ['-p', prompt, '--output-format', 'text'], want: { code: 0, first: 'OK' } },
    { argv: ['-p', prompt, '--output-format', 'yaml'], want: { code: 2, first: 'invalid value "yaml" for flag --output-format: must be one of text, json, stream-json' } },
    { argv: ['--version'], want: { code: 0, first: AGY_VERSION } },
  ];
  const out = arms.map((a) => {
    const isCmd = /\.cmd$/i.test(bin);
    const r = cp.spawnSync(isCmd ? (process.env.ComSpec || 'cmd.exe') : bin, isCmd ? ['/d', '/s', '/c', `""${bin}" ${a.argv.map((x) => `"${x}"`).join(' ')}"`] : a.argv, { env: { ...env, AGY_FAKE_MODE: 'ok' }, encoding: 'utf8', windowsVerbatimArguments: isCmd, timeout: 30000 });
    const first = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).find((l) => l.trim()) || '';
    return { argv: a.argv.map((x) => (x === prompt ? '<prompt>' : x)), code: r.status, first, want: a.want, ok: r.status === a.want.code && first === a.want.first };
  });
  return { pass: out.every((a) => a.ok), arms: out };
}

module.exports = { AGY_VERSION, VALUE_FLAGS, BOOL_FLAGS, parseArgv, writeFakeAgy, selfTest };

if (require.main === module) process.exit(main(process.argv.slice(2)));
