'use strict';
// Claude Code kanca kaydı (gölge kıyas): yalnız olay adı + an. Kanca girdisi (stdin) OKUNMAZ/YAZILMAZ.
const fs = require('node:fs');
const f = process.env.SHADOW_HOOK_LOG;
if (f) fs.appendFileSync(f, JSON.stringify({ at: Date.now(), ev: process.argv[2] || '?' }) + '\n');
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 2000);
