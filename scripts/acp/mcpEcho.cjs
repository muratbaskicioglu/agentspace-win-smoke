// Smallest stdio MCP server: one tool `ping` (stands in for the app's own MCP servers).
'use strict';
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.on('data', (d) => {
  buf += d; let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0.0.1' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'probe ping', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `pong:${(m.params.arguments || {}).msg || ''}` }] } });
    else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
