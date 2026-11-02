// ACP turn probe for three engines (Claude Code via claude-agent-acp, Codex via codex-acp, OpenCode `acp`).
// One run = one engine x one mode, fresh throwaway HOME, empty workspace, LOCAL FAKE model server:
//   /v1/messages (Anthropic), /v1/responses (OpenAI Responses, Codex), /v1/chat/completions (OpenCode).
// No real login, no paid call, no secret. Only names, times, counts and booleans are printed.
//
//   node acpProbe.cjs --engine claude|codex|opencode --mode turn|cancel|resume|limit|hooks --prefix <npm prefix>
//                     [--native] [--claude-exe <official claude binary>] [--home <dir>] [--ws <dir>]
//   node acpProbe.cjs --all --prefix-claude <d> --prefix-codex <d> --prefix-opencode <d> --claude-exe <p> --out <dir>
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./launch.cjs');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

if (flag('all')) { runAll(); } else { runOne(); }

// ─────────────────────────────────────────────────────────────────────────────
function runAll() {
  const out = path.resolve(opt('out', 'acp-probe'));
  fs.mkdirSync(out, { recursive: true });
  const engines = (opt('engines', 'claude,codex,opencode')).split(',');
  const modes = (opt('modes', 'turn,cancel,resume,limit')).split(',');
  const rows = [];
  const meta = { os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, platform: process.platform, engines: {} };
  // 1) launch check: naive shim spawn (negative control) + resolved paths + package size.
  for (const e of engines) {
    const prefix = path.resolve(opt(`prefix-${e}`));
    const info = { prefix: '<prefix>' };
    try { const r = L.fromPackageJson(e, prefix); info.packageJson = { how: r.how, script: path.relative(prefix, r.args[0]), version: r.version }; } catch (err) { info.packageJson = { error: err.message }; }
    const nat = L.nativeBinary(e, prefix); if (nat) info.native = nat.missing ? { missing: path.relative(prefix, nat.missing) } : { how: nat.how, bin: path.relative(prefix, nat.cmd) };
    const sh = L.shimTarget(e, prefix); info.shim = { file: path.relative(prefix, sh.shim), exists: sh.exists, target: sh.target && path.relative(prefix, sh.target), viaNode: sh.viaNode };
    if (sh.exists) {
      const r = spawnSync(sh.shim, ['--help'], { shell: false, timeout: 15000, encoding: 'utf8' });
      info.naiveShimSpawn = r.error ? { error: r.error.code || r.error.message } : { status: r.status, out: (r.stdout || '').length };
    }
    // sizes: whole node_modules; native executables (MZ/ELF/Mach-O: embedded engine binaries) vs the rest
    const sz = L.sizeSplit(path.join(prefix, 'node_modules'));
    info.size = { totalMB: mb(sz.total), nativeBinaryMB: mb(sz.native), withoutNativeMB: mb(sz.total - sz.native), nativeFiles: sz.files.filter((f) => f.bytes > 1048576).map((f) => `${f.rel} ${mb(f.bytes)} MB`) };
    meta.engines[e] = info;
    console.log('LAUNCH', e, JSON.stringify(info));
  }
  // 2) the matrix, each cell once.
  for (const e of engines) {
    for (const m of modes) {
      if (m === 'hooks' && e !== 'claude') continue;
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `acp-${e}-${m}-`));
      const home = path.join(work, 'home'); const ws = path.join(work, 'ws');
      fs.mkdirSync(home); fs.mkdirSync(ws);
      const a = [__filename, '--engine', e, '--mode', m, '--prefix', path.resolve(opt(`prefix-${e}`)), '--home', home, '--ws', ws];
      if (opt('claude-exe')) a.push('--claude-exe', opt('claude-exe'));
      if (e === 'opencode' && flag('native')) a.push('--native');
      const t = Date.now();
      const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 120000, env: process.env, maxBuffer: 32 << 20 });
      const txt = (r.stdout || '') + (r.stderr ? `\n--- stderr (last 30 lines)\n${r.stderr.split('\n').slice(-30).join('\n')}` : '') + (r.error ? `\nSPAWN_ERROR ${r.error.code || r.error.message}` : '');
      fs.writeFileSync(path.join(out, `${e}-${m}.txt`), maskPaths(txt, [work, os.homedir(), os.tmpdir()]));
      const sm = (r.stdout || '').split('\n').find((l) => l.startsWith('SUMMARY '));
      const s = sm ? JSON.parse(sm.slice(8)) : { error: r.error ? (r.error.code || r.error.message) : `exit ${r.status}, no summary` };
      s.engine = e; s.mode = m; s.wallMs = Date.now() - t; s.exit = r.status;
      rows.push(s);
      console.log('CELL', e, m, JSON.stringify(s));
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* windows may hold files a moment */ }
    }
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ meta, rows }, null, 2));
  console.log('WROTE', path.join(out, 'summary.json'));
}
function mb(n) { return Math.round(n / 1048576 * 10) / 10; }
function maskPaths(s, list) {
  let o = s;
  for (const p of list.filter(Boolean).sort((x, y) => y.length - x.length)) {
    for (const v of [p, p.replace(/\\/g, '\\\\'), p.replace(/\\/g, '/')]) o = o.split(v).join('<dir>');
  }
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
function runOne() {
  const ENGINE = opt('engine');
  const MODE = opt('mode', 'turn');
  const PREFIX = path.resolve(opt('prefix'));
  const HOME = opt('home') || fs.mkdtempSync(path.join(os.tmpdir(), 'acp-home-'));
  const WS = opt('ws') || fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws-'));
  const MCP = path.join(__dirname, 'mcpEcho.cjs');
  const HOOKREC = path.join(__dirname, 'hookRec.cjs');
  const HOOK_LOG = path.join(HOME, 'hooks.jsonl');
  const SYS_MARK = 'ACP_SYS_MARKER_7731';
  const MD_MARK = 'ACP_CLAUDEMD_MARKER_4410';
  const T0 = Date.now();
  const ms = () => String(Date.now() - T0).padStart(5, ' ');
  const out = (...a) => console.log(ms(), ...a);
  const S = { engine: ENGINE, mode: MODE };

  // ── fake model server ─────────────────────────────────────────────────────
  const reqLog = [];
  let mainTurns = 0;
  let onMainStreamDelayed = null; // cancel mode: fires 300 ms after the model stream for the tool call started
  const sawSystem = { sys: false, md: false };
  const isPing = (n) => typeof n === 'string' && /(^|[_/])ping$/.test(n) && /probe/.test(n);
  const sseRaw = (res, chunks, delay, named) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const w = (c) => { if (!res.writableEnded) res.write(named ? `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n` : `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`); };
    w(chunks[0]);
    setTimeout(() => { chunks.slice(1).forEach(w); if (!res.writableEnded) res.end(); }, delay || 0);
  };
  function anthropicEvents(content, stop) {
    const ev = [{ type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }];
    content.forEach((c, i) => {
      if (c.type === 'text') { ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } }); }
      else { ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }); }
      ev.push({ type: 'content_block_stop', index: i });
    });
    ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: 'message_stop' });
    return ev;
  }
  function responsesEvents(item) {
    const usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 19 };
    const ev = [{ type: 'response.created', response: { id: 'resp_fake' } }];
    if (item.type === 'message') {
      ev.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_fake', content: [] } });
      ev.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_fake', delta: item.content[0].text });
    }
    ev.push({ type: 'response.output_item.done', output_index: 0, item });
    ev.push({ type: 'response.completed', response: { id: 'resp_fake', usage } });
    return ev;
  }
  function chatChunks(kind, toolName) {
    const base = { id: 'chatcmpl_fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-model' };
    const c = (delta, finish) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish || null }] });
    if (kind === 'tool') {
      return [c({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_probe${mainTurns}`, type: 'function', function: { name: toolName, arguments: '' } }] }), c({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ msg: 'merhaba' }) } }] }), c({}, 'tool_calls'), { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }, '[DONE]'];
    }
    return [c({ role: 'assistant', content: '' }), c({ content: kind }), c({}, 'stop'), { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }, '[DONE]'];
  }
  function toolNames(j) {
    const names = [];
    for (const t of j.tools || []) {
      if (t.name) names.push(t.name);
      if (t.function && t.function.name) names.push(t.function.name);
      if (Array.isArray(t.tools)) for (const s of t.tools) names.push(`${t.name || ''}/${s.name}`); // Responses API namespace (Codex MCP)
    }
    return names;
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* */ }
      const url = req.url.split('?')[0];
      const names = toolNames(j);
      const ping = names.find(isPing);
      const flat = body;
      if (process.env.PROBE_DEBUG_TOOLS) for (const t of j.tools || []) if (/probe/.test(JSON.stringify(t))) console.log('DEBUG_TOOL', JSON.stringify(t).slice(0, 600));
      if (flat.includes(SYS_MARK)) sawSystem.sys = true;
      if (flat.includes(MD_MARK)) sawSystem.md = true;
      let kind = '404';
      const api = url.endsWith('/messages') ? 'anthropic' : url.endsWith('/responses') ? 'responses' : url.endsWith('/chat/completions') ? 'chat' : null;
      if (req.method === 'POST' && api && !url.includes('count_tokens')) {
        const hasToolResult = api === 'anthropic' ? flat.includes('"tool_result"') : api === 'responses' ? /"type":"(function_call_output|mcp_tool_call_output|custom_tool_call_output)"/.test(flat) : /"role":"tool"/.test(flat);
        if (ping && MODE === 'limit') {
          kind = '429';
          const reset = Math.floor(Date.now() / 1000) + 3600;
          const h = { 'content-type': 'application/json', 'retry-after': '3600' };
          if (api === 'anthropic') Object.assign(h, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset), 'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
          else Object.assign(h, { 'x-ratelimit-reset-requests': '3600s', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-window-minutes': '300' });
          res.writeHead(429, h);
          res.end(JSON.stringify(api === 'anthropic' ? { type: 'error', error: { type: 'rate_limit_error', message: 'probe: rate limited' } } : { error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'probe: rate limited' } }));
        } else {
          const callTool = ping && !hasToolResult && MODE !== 'resume2';
          const delay = callTool && MODE === 'cancel' ? 6000 : 0;
          if (delay && onMainStreamDelayed) { const f = onMainStreamDelayed; onMainStreamDelayed = null; setTimeout(f, 300); }
          if (callTool) mainTurns++;
          kind = callTool ? `tool(${ping})` : ping ? 'text(PROBE_OK)' : 'text(aux)';
          const text = ping ? 'PROBE_OK' : (api === 'chat' ? 'Probe' : 'ok');
          if (api === 'anthropic') {
            const content = callTool ? [{ type: 'tool_use', id: `toolu_probe${mainTurns}`, name: ping, input: { msg: 'merhaba' } }] : [{ type: 'text', text }];
            const stop = callTool ? 'tool_use' : 'end_turn';
            if (j.stream) sseRaw(res, anthropicEvents(content, stop), delay, true);
            else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-fake', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } })); }
          } else if (api === 'responses') {
            const ns = ping && ping.includes('/') ? ping.split('/') : null;
            const item = callTool ? { type: 'function_call', id: `fc_probe${mainTurns}`, call_id: `call_probe${mainTurns}`, ...(ns ? { namespace: ns[0], name: ns[1] } : { name: ping }), arguments: JSON.stringify({ msg: 'merhaba' }) } : { type: 'message', role: 'assistant', id: 'msg_fake', content: [{ type: 'output_text', text, annotations: [] }] };
            sseRaw(res, responsesEvents(item), delay, true);
          } else {
            if (j.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })); }
            else sseRaw(res, chatChunks(callTool ? 'tool' : text, ping), delay, false);
          }
        }
      } else if (url.includes('count_tokens')) {
        kind = 'count_tokens'; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":12}');
      } else if (req.method === 'GET' && url.endsWith('/models')) {
        kind = 'models'; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'probe' }], models: [] }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"probe"}}');
      }
      reqLog.push(`${req.method} ${url} -> ${kind}${j.stream ? ' stream' : ''} tools=${names.length}${ping ? ` [${ping}]` : names.length ? ` (no ping: ${names.slice(0, 40).join(',')})` : ''}`);
    });
  });

  // ── engine config (throwaway HOME only) ────────────────────────────────────
  function engineEnv(port) {
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'), XDG_CACHE_HOME: path.join(HOME, '.cache'), XDG_STATE_HOME: path.join(HOME, '.local', 'state') };
    if (process.platform === 'win32') { env.APPDATA = path.join(HOME, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(HOME, 'AppData', 'Local'); fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true }); }
    for (const k of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|CLAUDE|CODEX|OPENCODE)_/.test(k)) delete env[k];
    if (ENGINE === 'claude') {
      Object.assign(env, { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'sk-ant-probe-fake', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false' });
      if (opt('claude-exe')) env.CLAUDE_CODE_EXECUTABLE = opt('claude-exe');
      if (MODE === 'limit') env.CLAUDE_CODE_MAX_RETRIES = '0';
      if (MODE === 'hooks') {
        const dir = path.join(HOME, '.claude'); fs.mkdirSync(dir, { recursive: true });
        const cmd = (ev) => [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOKREC}" ${ev}` }] }];
        const hooks = {};
        for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'PermissionRequest', 'SessionEnd']) hooks[ev] = ev.endsWith('ToolUse') || ev === 'PermissionRequest' ? [{ matcher: '.*', ...cmd(ev)[0] }] : cmd(ev);
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks }, null, 2));
        fs.writeFileSync(path.join(WS, 'CLAUDE.md'), `# Probe\n${MD_MARK}\n`);
        env.PROBE_HOOK_LOG = HOOK_LOG;
      }
    } else if (ENGINE === 'codex') {
      const ch = path.join(HOME, '.codex'); fs.mkdirSync(ch, { recursive: true });
      env.CODEX_HOME = ch; env.PROBE_FAKE_OPENAI_KEY = 'sk-probe-fake';
      fs.writeFileSync(path.join(ch, 'config.toml'), [
        'model = "fake-model"', 'model_provider = "probe"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
        '[analytics]', 'enabled = false', '[otel]', 'exporter = "none"',
        '[model_providers.probe]', 'name = "Probe"', `base_url = "${base}/v1"`, 'env_key = "PROBE_FAKE_OPENAI_KEY"', 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
      ].join('\n'));
    } else if (ENGINE === 'opencode') {
      Object.assign(env, { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_SHARE: '1', PROBE_FAKE_OPENAI_KEY: 'sk-probe-fake' });
      const cfg = { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', model: 'probe/fake-model', small_model: 'probe/fake-model', provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'Probe', options: { baseURL: `${base}/v1`, apiKey: '{env:PROBE_FAKE_OPENAI_KEY}' }, models: { 'fake-model': { name: 'Fake', tool_call: true, limit: { context: 100000, output: 4096 } } } } }, permission: { '*': 'ask' } };
      const f = path.join(HOME, 'opencode.json'); fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); env.OPENCODE_CONFIG = f;
    }
    return env;
  }
  function launch() {
    if (ENGINE === 'opencode' && flag('native')) { const n = L.nativeBinary(ENGINE, PREFIX); if (n && !n.missing) return n; }
    return L.fromPackageJson(ENGINE, PREFIX);
  }

  // ── ACP client (stdio, newline-delimited JSON-RPC) ─────────────────────────
  function startAgent(env, tag) {
    const l = launch();
    const p = spawn(l.cmd, l.args, { cwd: WS, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    out(tag, 'SPAWN', JSON.stringify({ how: l.how, pid: !!p.pid }));
    const a = { p, stderr: '', counts: {}, pending: {}, id: 0, buf: '', perm: 0, texts: [], toolDone: 0, exited: null };
    p.on('error', (e) => { out(tag, 'SPAWN_ERROR', e.code || e.message); });
    p.on('exit', (c, sig) => { a.exited = c != null ? c : sig; });
    p.stderr.on('data', (d) => { a.stderr += d; });
    a.send = (method, params) => new Promise((r) => { const i = ++a.id; a.pending[i] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
    a.notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    const reply = (rid, result) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, result }) + '\n');
    p.stdout.on('data', (d) => {
      a.buf += d; let n;
      while ((n = a.buf.indexOf('\n')) >= 0) {
        const line = a.buf.slice(0, n); a.buf = a.buf.slice(n + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && a.pending[m.id] && !m.method) { a.pending[m.id](m); delete a.pending[m.id]; continue; }
        if (m.method === 'session/request_permission') {
          a.perm++;
          const opts = (m.params.options || []).map((o) => `${o.optionId}:${o.kind}`);
          out(tag, 'AGENT→CLIENT request session/request_permission', JSON.stringify({ tool: m.params.toolCall && m.params.toolCall.title, options: opts }));
          const allow = (m.params.options || []).find((o) => o.kind === 'allow_once') || m.params.options[0];
          reply(m.id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
          out(tag, 'CLIENT→AGENT reply', `selected ${allow.optionId}`);
          continue;
        }
        if (m.method && m.id != null) { out(tag, 'AGENT→CLIENT request', m.method, '(not supported → error)'); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by probe' } }) + '\n'); continue; }
        if (m.method === 'session/update') {
          const u = m.params.update || {};
          const k = u.sessionUpdate;
          a.counts[k] = (a.counts[k] || 0) + 1;
          let detail = '';
          if (k === 'agent_message_chunk' || k === 'agent_thought_chunk' || k === 'user_message_chunk') { const tx = u.content && u.content.text; detail = JSON.stringify(tx && tx.slice(0, 120)); if (k === 'agent_message_chunk' && tx) a.texts.push(tx); }
          else if (k === 'tool_call' || k === 'tool_call_update') { detail = JSON.stringify({ id: u.toolCallId && 'var', title: u.title, kind: u.kind, status: u.status }); if (u.status === 'completed') a.toolDone++; }
          else if (k === 'usage_update') detail = JSON.stringify({ used: u.used, size: u.size, meta: u._meta ? Object.keys(u._meta) : undefined });
          else if (k === 'available_commands_update') detail = `${(u.availableCommands || []).length} commands`;
          else if (k === 'current_mode_update') detail = u.currentModeId;
          else detail = JSON.stringify(u).slice(0, 220);
          out(tag, 'NOTIFY session/update', k, detail);
        } else if (m.method) {
          out(tag, 'NOTIFY', m.method, JSON.stringify(m.params).slice(0, 300));
        }
      }
    });
    return a;
  }

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    out('ENGINE', ENGINE, 'MODE', MODE, 'FAKE_API', `127.0.0.1:${port}`, 'OS', process.platform, os.release());
    const env = engineEnv(port);
    const agents = [];
    const kill = setTimeout(() => { out('TIMEOUT'); S.timeout = true; fin(2); }, 100000);
    function fin(code) {
      clearTimeout(kill);
      out('FAKE_API_REQUESTS', reqLog.length);
      reqLog.forEach((l) => console.log('      ', l));
      agents.forEach((a, i) => {
        out(`UPDATE_COUNTS#${i + 1}`, JSON.stringify(a.counts));
        const errLines = a.stderr.split('\n').filter((l) => /error|429|rate|limit|fail|warn/i.test(l)).slice(0, 8);
        if (errLines.length) { out(`STDERR#${i + 1} (first related lines)`); errLines.forEach((l) => console.log('      ', l.slice(0, 240))); }
        try { a.p.kill(); } catch { /* */ }
      });
      if (MODE === 'hooks') {
        let lines = [];
        try { lines = fs.readFileSync(HOOK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
        out('HOOK_LOG', lines.length);
        lines.forEach((r) => console.log('      ', JSON.stringify({ ...r, t: r.t - T0 })));
        S.hooks = [...new Set(lines.map((r) => r.event || r.arg))];
        S.systemPromptAppend = sawSystem.sys; S.claudeMd = sawSystem.md;
      }
      S.apiRequests = reqLog.length;
      console.log('SUMMARY ' + JSON.stringify(S));
      server.close();
      setTimeout(() => process.exit(code), 300);
    }
    const mcpServers = [{ name: 'probe', command: process.execPath, args: [MCP], env: [] }];
    async function handshake(a, tag) {
      const t = Date.now();
      const init = await Promise.race([a.send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'acp-probe', version: '0.0.1' } }), new Promise((r) => setTimeout(() => r({ error: { message: 'initialize timeout 30 s' } }), 30000))]);
      const ir = init.result || {};
      const dt = Date.now() - t;
      out(tag, 'INIT', `${dt} ms`, JSON.stringify({ protocolVersion: ir.protocolVersion, agent: ir.agentInfo, loadSession: ir.agentCapabilities && ir.agentCapabilities.loadSession, sessionCaps: ir.agentCapabilities && ir.agentCapabilities.sessionCapabilities ? Object.keys(ir.agentCapabilities.sessionCapabilities) : undefined, authMethods: (ir.authMethods || []).map((x) => x.id), error: init.error && init.error.message }));
      return { dt, ir, error: init.error };
    }
    async function prompt(a, tag, sessionId, text, limitMs) {
      const t = Date.now();
      out(tag, 'CLIENT→AGENT session/prompt', JSON.stringify(text));
      let guard;
      const pr = await Promise.race([a.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }), new Promise((r) => { guard = setTimeout(() => r({ guard: true }), limitMs || 60000); })]);
      clearTimeout(guard);
      const dt = Date.now() - t;
      if (pr.guard) { out(tag, 'PROMPT_NO_RESULT', `${dt} ms`); return { dt, guard: true }; }
      out(tag, 'PROMPT_RESULT', `${dt} ms`, JSON.stringify(pr.result ? { stopReason: pr.result.stopReason, usage: pr.result.usage ? 'yes' : 'no', meta: pr.result._meta ? Object.keys(pr.result._meta) : undefined } : { error: pr.error }).slice(0, 500));
      return { dt, pr };
    }
    try {
      const a = startAgent(env, '[1]'); agents.push(a);
      const h = await handshake(a, '[1]');
      S.initMs = h.dt; S.agent = h.ir.agentInfo && `${h.ir.agentInfo.name} ${h.ir.agentInfo.version}`; S.loadSessionCap = !!(h.ir.agentCapabilities && h.ir.agentCapabilities.loadSession);
      if (h.error) { S.error = `initialize: ${h.error.message}`; return fin(1); }
      let t = Date.now();
      const newParams = { cwd: WS, mcpServers };
      if (MODE === 'hooks') newParams.systemPrompt = { mode: 'append', content: [{ type: 'text', text: `Probe note: ${SYS_MARK}` }] };
      const ses = await a.send('session/new', newParams);
      const sr = ses.result || {};
      S.sessionNewMs = Date.now() - t;
      if (!sr.sessionId) { out('SESSION_NEW ERROR', JSON.stringify(ses.error)); S.error = `session/new: ${ses.error && ses.error.message}`; return fin(1); }
      out('[1]', 'SESSION_NEW', `${S.sessionNewMs} ms`, JSON.stringify({ sessionId: 'yes', modes: sr.modes && sr.modes.availableModes && sr.modes.availableModes.map((m) => m.id), currentMode: sr.modes && sr.modes.currentModeId, configOptions: (sr.configOptions || []).map((c) => c.id) }));
      // Codex's default ACP mode is "agent" (auto review: a model call decides approvals). The host picks the
      // mode that sends approvals to the client instead, like the other two engines.
      const modeIds = (sr.modes && sr.modes.availableModes || []).map((m) => m.id);
      if (ENGINE === 'codex' && modeIds.includes('workspace-write')) {
        const sm = await a.send('session/set_mode', { sessionId: sr.sessionId, modeId: 'workspace-write' });
        S.setMode = sm.error ? `error ${sm.error.message}` : 'workspace-write';
        out('[1]', 'SET_MODE workspace-write', JSON.stringify(sm.error ? { error: sm.error.message } : { ok: true }));
      }
      let cancelAt = 0;
      if (MODE === 'cancel') onMainStreamDelayed = () => { cancelAt = Date.now(); out('[1]', 'CLIENT→AGENT notify session/cancel (model stream in flight 300 ms)'); a.notify('session/cancel', { sessionId: sr.sessionId }); };
      let limitCancelAt = 0;
      const limitWait = MODE === 'limit' ? 20000 : 60000;
      let r1 = await prompt(a, '[1]', sr.sessionId, 'probe aracını çağır ve PROBE_OK yaz', limitWait);
      if (r1.guard && MODE === 'limit') {
        // The engine keeps retrying on its own: the host must be able to stop it.
        limitCancelAt = Date.now(); out('[1]', 'CLIENT→AGENT notify session/cancel (limit: no result in 20 s)'); a.notify('session/cancel', { sessionId: sr.sessionId });
        const late = await Promise.race([new Promise((r) => { const i = a.id; const orig = a.pending[i]; a.pending[i] = (m) => { if (orig) orig(m); r(m); }; }), new Promise((r) => setTimeout(() => r(null), 10000))]);
        S.limitCancelMs = late ? Date.now() - limitCancelAt : null;
        if (late) { out('[1]', 'PROMPT_RESULT (after cancel)', `${S.limitCancelMs} ms`, JSON.stringify(late.result ? { stopReason: late.result.stopReason } : { error: late.error }).slice(0, 400)); r1 = { dt: Date.now() - limitCancelAt, pr: late }; }
      }
      S.promptMs = r1.dt;
      const res1 = r1.pr && r1.pr.result; const err1 = r1.pr && r1.pr.error;
      S.stopReason = res1 ? res1.stopReason : err1 ? `error ${err1.code}` : 'none';
      if (err1) { S.errorMessage = String(err1.message || '').slice(0, 160); S.errorData = err1.data ? JSON.stringify(err1.data).slice(0, 200) : undefined; }
      if (res1 && res1._meta) S.resultMeta = Object.keys(res1._meta);
      S.permissionAsked = a.perm; S.toolCompleted = a.toolDone; S.probeOk = a.texts.join('').includes('PROBE_OK');
      if (cancelAt) S.cancelToResultMs = Date.now() - cancelAt;
      if (MODE === 'limit') S.limitText = a.texts.join('').slice(0, 160);
      if (MODE !== 'resume') { try { const l = await Promise.race([a.send('session/list', {}), new Promise((r) => setTimeout(() => r({ error: { message: 'timeout' } }), 5000))]); S.sessionList = l.result ? (l.result.sessions || []).length : `error ${l.error && l.error.message}`; } catch { /* */ } }
      if (MODE === 'resume') {
        a.p.kill(); out('[1]', 'ADAPTER PROCESS KILLED (restart simulation)');
        await new Promise((r) => setTimeout(r, 800));
        const b = startAgent(env, '[2]'); agents.push(b);
        const h2 = await handshake(b, '[2]');
        S.init2Ms = h2.dt;
        t = Date.now();
        const ld = await Promise.race([b.send('session/load', { sessionId: sr.sessionId, cwd: WS, mcpServers }), new Promise((r) => setTimeout(() => r({ error: { message: 'session/load timeout 30 s' } }), 30000))]);
        S.loadMs = Date.now() - t; S.loadOk = !!ld.result; if (ld.error) S.loadError = String(ld.error.message).slice(0, 160);
        S.replayed = { ...b.counts };
        out('[2]', 'SESSION_LOAD', `${S.loadMs} ms`, JSON.stringify(ld.result ? { ok: true, keys: Object.keys(ld.result) } : { error: ld.error }).slice(0, 300));
        if (ld.result) { const r2 = await prompt(b, '[2]', sr.sessionId, 'devam: tekrar PROBE_OK yaz'); S.prompt2Ms = r2.dt; S.stopReason2 = r2.pr && r2.pr.result ? r2.pr.result.stopReason : r2.pr && r2.pr.error ? `error ${r2.pr.error.code}` : 'none'; }
      }
      if (MODE === 'hooks') await new Promise((r) => setTimeout(r, 1500));
      fin(0);
    } catch (e) { out('PROBE_ERROR', e && e.message); S.error = e && e.message; fin(1); }
  });
}
