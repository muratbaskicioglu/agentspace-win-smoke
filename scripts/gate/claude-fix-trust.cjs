// Generated from agentdesk electron/agentRunner.js (task/win-cmd-01): isClaudeBypassAccepted..ensureClaudeBypassAccepted, verbatim.
// Only shim: atomicWriteFileSync (the app's platform/atomicWrite.cjs) → mkdir + writeFileSync.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const atomicWriteFileSync = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
/** Pure: `settings` içinde uyarı kabul edilmiş mi? */
function isClaudeBypassAccepted(settings) {
  return !!(settings && typeof settings === 'object' && settings.skipDangerousModePermissionPrompt === true);
}

/** Pure: return a NEW settings object with the bypass warning accepted (merge, no clobber). */
function claudeBypassAcceptPatch(settings) {
  const base = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return { ...base, skipDangerousModePermissionPrompt: true };
}

/** Claude'un kullanıcı ayar dosyası: `$CLAUDE_CONFIG_DIR/settings.json`, yoksa `~/.claude/settings.json`. */
function claudeUserSettingsPath(env, homedir) {
  const dir = env && typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : path.join(homedir || os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/**
 * Best-effort: claude'un "Bypass Permissions mode" uyarısını önceden kabul et. Asla throw
 * etmez: `true` = (artık) kabul edilmiş; `false` = yazılamadı ya da dosya bozuk (ezilmedi) —
 * o durumda teslim kapısı uyarıyı engel sayar ve YAZMAZ (paneReadiness 'bypass-warning').
 */
function ensureClaudeBypassAccepted(env, homedir) {
  try {
    const file = claudeUserSettingsPath(env, homedir);
    let current = {};
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null; // yok → yeni dosya
    }
    if (raw !== null && raw.trim()) {
      try {
        current = JSON.parse(raw);
      } catch {
        return false; // kullanıcının bozuk/yorumlu dosyası: EZME
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    }
    if (isClaudeBypassAccepted(current)) return true;
    atomicWriteFileSync(file, `${JSON.stringify(claudeBypassAcceptPatch(current), null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
module.exports = { isClaudeBypassAccepted, claudeBypassAcceptPatch, claudeUserSettingsPath, ensureClaudeBypassAccepted };
