// Claude Code hook recorder: appends one JSON line per hook call to $PROBE_HOOK_LOG.
// Saves only the event name, the keys of the hook input and a few booleans (no prompt text).
'use strict';
const fs = require('fs');
let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(s || '{}'); } catch { /* empty */ }
  const rec = { t: Date.now(), arg: process.argv[2], event: j.hook_event_name, keys: Object.keys(j).sort(), tool: j.tool_name, hasSession: !!j.session_id, hasPrompt: typeof j.prompt === 'string', permissionMode: j.permission_mode };
  try { fs.appendFileSync(process.env.PROBE_HOOK_LOG, JSON.stringify(rec) + '\n'); } catch { /* */ }
  process.exit(0);
});
