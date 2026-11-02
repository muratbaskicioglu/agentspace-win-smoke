'use strict';
// ACP-FAZ1-GOLGE-01 (AS-4584) — SAHTE ANTHROPIC MODELİ + ORACLE. UYGULAMA KODU YOK.
//
// 127.0.0.1'de /v1/messages (SSE) konuşur; senaryo betiğini işaretten (`[SG-Sxx-n]`) seçer.
// Aynı zamanda GERÇEĞİN kaydıdır: istem ne zaman geldi (teslim anı), metin bozulmadan geldi mi,
// geçmişte iki kez var mı (çift teslim), tur ne zaman bitti. Kayıt yalnız senaryo kimliği + ms +
// bayrak tutar; istem metni kayda girmez (zaten yapay).
// Bkz. AS-4600 probu (docs/agent-results/AS-4600-evidence/probe/acpProbe.cjs) — SSE biçimi oradan.

const http = require('node:http');
const { SCENARIOS, HOLD_MS, MARKER_RE } = require('./scenarios.cjs');

const BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

function userTexts(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') { out.push({ text: m.content, toolResult: false }); continue; }
    const parts = Array.isArray(m.content) ? m.content : [];
    out.push({ text: parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n'), toolResult: parts.some((p) => p && p.type === 'tool_result') });
  }
  return out;
}

function sseEvents(content, stop) {
  const ev = [{ type: 'message_start', message: { id: 'msg_shadow', type: 'message', role: 'assistant', model: 'claude-shadow', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }];
  content.forEach((c, i) => {
    if (c.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      const n = c.chunks || 1;
      const size = Math.ceil(c.text.length / n);
      for (let k = 0; k < c.text.length; k += size) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text.slice(k, k + size) }, _gap: c.chunkMs || 0 });
    } else {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    }
    ev.push({ type: 'content_block_stop', index: i });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: 'message_stop' });
  return ev;
}

/**
 * @param {{now:()=>number, onEvent:(e:object)=>void, holdMs?:number}} o
 */
function createFakeModel(o) {
  const now = o.now;
  const emit = (e) => o.onEvent({ t: now(), k: 'model', ...e });
  const holdMs = o.holdMs == null ? HOLD_MS : o.holdMs;
  const seen = new Map(); // `${sid}-${turn}` → {firstAt, reqs}
  let toolSeq = 0;
  const sockets = new Set();

  function writeSse(res, events, onEnd) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let i = 0;
    const next = () => {
      if (res.writableEnded || res.destroyed) return;
      while (i < events.length) {
        const c = events[i++];
        const gap = c._gap || 0;
        const { _gap, ...clean } = c;
        res.write(`event: ${clean.type}\ndata: ${JSON.stringify(clean)}\n\n`);
        if (gap && i < events.length) { setTimeout(next, gap); return; }
      }
      res.end();
      onEnd();
    };
    next();
  }

  function handle(req, res, body) {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":12}'); }
    if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"shadow"}}'); }
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* */ }
    const tools = (j.tools || []).map((t) => t && t.name).filter(Boolean);
    const ut = userTexts(j.messages);
    // Son işaret = şu anki tur. Tüm kullanıcı metinleri taranır (araç dönüşünde son mesaj tool_result'tur).
    let cur = null;
    const counts = {};
    for (const u of ut) for (const m of u.text.matchAll(MARKER_RE)) { cur = { sid: m[1], turn: Number(m[2]) }; const k = `${m[1]}-${m[2]}`; counts[k] = (counts[k] || 0) + 1; }
    const aux = tools.length === 0 || !cur || !BY_ID[cur.sid];
    if (aux) {
      emit({ ev: 'aux', tools: tools.length, stream: !!j.stream });
      const content = [{ type: 'text', text: 'ok' }];
      if (j.stream) return writeSse(res, sseEvents(content, 'end_turn'), () => {});
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_aux', type: 'message', role: 'assistant', model: 'claude-shadow', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }));
    }
    const sc = BY_ID[cur.sid];
    const key = `${cur.sid}-${cur.turn}`;
    const last = ut[ut.length - 1] || { text: '', toolResult: false };
    const step = last.toolResult ? 1 : 0;
    const expected = sc.turns[cur.turn - 1] || '';
    const norm = (s) => String(s).replace(/\r\n?/g, '\n');
    const textOk = ut.some((u) => norm(u.text).includes(norm(expected)));
    const histPrev = cur.turn > 1 ? ut.some((u) => u.text.includes(`[SG-${cur.sid}-${cur.turn - 1}]`)) : null;
    const rec = seen.get(key) || { firstAt: null, reqs: 0 };
    rec.reqs++;
    const first = step === 0 && rec.firstAt == null;
    if (first) rec.firstAt = now();
    seen.set(key, rec);
    emit({ ev: 'req', sid: cur.sid, turn: cur.turn, step, first, textOk, dupInHistory: (counts[key] || 0) > 1, histPrev, tools: tools.length, hasAsk: tools.includes('AskUserQuestion') });

    const spec = cur.turn > 1 ? { text: `Tur ${cur.turn}: ${histPrev ? 'önceki tur hatırlandı' : 'önceki tur YOK'}.` } : (sc.steps[step] || { text: 'Tamam.' });
    const go = () => {
      if (res.destroyed) return;
      if (spec.limit) {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset), 'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'shadow: rate limited' } }));
        return emit({ ev: 'limit_sent', sid: cur.sid, turn: cur.turn });
      }
      emit({ ev: 'resp_start', sid: cur.sid, turn: cur.turn, step });
      if (spec.slow) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const w = (c) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`); };
        w(sseEvents([], 'end_turn')[0]);
        w({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        w({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: spec.slow.text } });
        const started = now();
        const iv = setInterval(() => {
          if (res.destroyed || res.writableEnded) { clearInterval(iv); return; }
          if (now() - started > spec.slow.totalMs) { clearInterval(iv); for (const c of sseEvents([], 'end_turn').slice(1)) w(c); res.end(); emit({ ev: 'resp_end', sid: cur.sid, turn: cur.turn, step }); return; }
          w({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } });
        }, spec.slow.tickMs);
        res.on('close', () => { clearInterval(iv); if (!res.writableEnded) emit({ ev: 'client_abort', sid: cur.sid, turn: cur.turn, step }); });
        return undefined;
      }
      let content; let stop;
      if (spec.tool) { toolSeq++; content = [{ type: 'tool_use', id: `toolu_shadow${toolSeq}`, name: spec.tool.name, input: spec.tool.input }]; stop = 'tool_use'; }
      else { content = [{ type: 'text', text: spec.text, chunks: spec.chunks, chunkMs: spec.chunkMs }]; stop = 'end_turn'; }
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_shadow', type: 'message', role: 'assistant', model: 'claude-shadow', content: content.map(({ chunks, chunkMs, ...c }) => c), stop_reason: stop, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } }));
        return emit({ ev: spec.tool ? 'tool_use' : 'resp_end', sid: cur.sid, turn: cur.turn, step, tool: spec.tool && spec.tool.name });
      }
      writeSse(res, sseEvents(content, stop), () => emit({ ev: spec.tool ? 'tool_use' : 'resp_end', sid: cur.sid, turn: cur.turn, step, tool: spec.tool && spec.tool.name }));
      return undefined;
    };
    if (step === 0 && holdMs) setTimeout(go, holdMs); else go();
    return undefined;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('end', () => { try { handle(req, res, body); } catch (e) { emit({ ev: 'server_error', msg: String(e && e.message).slice(0, 120) }); try { res.writeHead(500); res.end(); } catch { /* */ } } });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return {
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    deliveredAt: (sid, turn) => { const x = seen.get(`${sid}-${turn}`); return x ? x.firstAt : null; },
  };
}

module.exports = { createFakeModel, userTexts };
