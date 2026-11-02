// How a host finds and starts an npm-installed ACP agent WITHOUT a shell.
//
// Windows: npm puts `<bin>.cmd` shims in node_modules/.bin. Since the CVE-2024-27980 fix,
// Node refuses to spawn .cmd/.bat with shell:false (EINVAL), and shell:true brings cmd.exe
// quoting back. So the host never starts the shim: it reads the package's own package.json
// `bin` entry and starts `node <script>` itself (same on macOS/Linux). For packages whose
// bin script only forwards to a native binary (opencode-ai), the host may start the native
// binary from the platform package directly and skip one node process.
'use strict';
const fs = require('fs');
const path = require('path');

const ENGINES = {
  claude: { pkg: '@agentclientprotocol/claude-agent-acp', bin: 'claude-agent-acp', args: [] },
  codex: { pkg: '@agentclientprotocol/codex-acp', bin: 'codex-acp', args: [] },
  opencode: { pkg: 'opencode-ai', bin: 'opencode', args: ['acp'], native: { win32: 'opencode-windows-x64/bin/opencode.exe', darwin: `opencode-darwin-${process.arch}/bin/opencode`, linux: `opencode-linux-${process.arch}/bin/opencode` } },
};

function pkgDir(prefix, pkg) { return path.join(prefix, 'node_modules', ...pkg.split('/')); }

// Primary path: package.json `bin` → node <script>.
function fromPackageJson(engine, prefix) {
  const e = ENGINES[engine];
  const dir = pkgDir(prefix, e.pkg);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin && pj.bin[e.bin];
  if (!rel) throw new Error(`no bin ${e.bin} in ${e.pkg}`);
  const script = path.join(dir, rel);
  if (!fs.existsSync(script)) throw new Error(`bin script missing: ${script}`);
  // The bin entry may be a native binary (opencode-ai: postinstall links the platform binary
  // to bin/opencode.exe on every OS). Then start it directly; otherwise node <script>.
  if (isNative(script)) return { how: 'package.json bin → native binary', cmd: script, args: [...e.args], version: pj.version };
  return { how: 'package.json bin → node <script>', cmd: process.execPath, args: [script, ...e.args], version: pj.version };
}

function isNative(file) {
  const b = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 4, 0); } finally { fs.closeSync(fd); }
  const hex = b.toString('hex');
  return hex.startsWith('4d5a') || hex === '7f454c46' || ['cffaedfe', 'cefaedfe', 'cafebabe', 'feedfacf'].includes(hex);
}

// Optional shortcut: the platform package's native binary (opencode only).
function nativeBinary(engine, prefix) {
  const e = ENGINES[engine];
  const rel = e.native && e.native[process.platform];
  if (!rel) return null;
  const p = path.join(prefix, 'node_modules', ...rel.split('/'));
  return fs.existsSync(p) ? { how: 'platform package native binary', cmd: p, args: [...e.args] } : { how: 'platform package native binary', missing: p };
}

// Cross-check: what the npm shim itself points at (Windows .cmd text / POSIX symlink).
function shimTarget(engine, prefix) {
  const e = ENGINES[engine];
  const binDir = path.join(prefix, 'node_modules', '.bin');
  if (process.platform === 'win32') {
    const shim = path.join(binDir, `${e.bin}.cmd`);
    if (!fs.existsSync(shim)) return { shim, exists: false };
    const txt = fs.readFileSync(shim, 'utf8');
    const all = [...txt.matchAll(/"%dp0%\\([^"]+)"/g)].map((m) => m[1]).filter((p) => !/node\.exe$/i.test(p));
    const target = all.length ? path.resolve(binDir, all[all.length - 1]) : null;
    return { shim, exists: true, target, viaNode: /%_prog%/.test(txt) };
  }
  const link = path.join(binDir, e.bin);
  if (!fs.existsSync(link)) return { shim: link, exists: false };
  return { shim: link, exists: true, target: fs.realpathSync(link), viaNode: true };
}

// Bytes on disk under p; a hard-linked file (opencode bin) is counted once.
function dirSize(p, seen = new Set()) {
  let n = 0;
  let st;
  try { st = fs.lstatSync(p, { bigint: true }); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) {
    const key = `${st.dev}:${st.ino}`;
    if (st.ino !== 0n && st.nlink > 1n) { if (seen.has(key)) return 0; seen.add(key); }
    return Number(st.size);
  }
  for (const f of fs.readdirSync(p)) n += dirSize(path.join(p, f), seen);
  return n;
}

// Size split: all files vs native executables (hard links counted once).
function sizeSplit(root) {
  const seen = new Set(); const files = []; let total = 0; let native = 0;
  (function walk(p) {
    let st; try { st = fs.lstatSync(p, { bigint: true }); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    const key = `${st.dev}:${st.ino}`;
    if (st.ino !== 0n && st.nlink > 1n) { if (seen.has(key)) return; seen.add(key); }
    const n = Number(st.size); total += n;
    if (n > 4096) { let nat = false; try { nat = isNative(p); } catch { /* */ } if (nat) { native += n; files.push({ rel: path.relative(root, p).split(path.sep).join('/'), bytes: n }); } }
  })(root);
  return { total, native, files };
}

module.exports = { ENGINES, isNative, sizeSplit, fromPackageJson, nativeBinary, shimTarget, dirSize, pkgDir };
