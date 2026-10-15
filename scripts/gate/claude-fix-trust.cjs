// Generated from agentdesk electron/agentRunner.js (task/win-cmd-01 @ 9b1728548): canonicalCwd..ensureClaudeBypassAccepted, verbatim.
// Only shim: atomicWriteFileSync (the app's platform/atomicWrite.cjs) → mkdir + writeFileSync.
// The app runs both writers where main.js writes claude's trust (TRUST_WRITERS.json).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const atomicWriteFileSync = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
function canonicalCwd(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Pure: return a NEW config object with `cwd` marked trusted (merge, no clobber). */
function claudeTrustPatch(config, cwd) {
  const base = config && typeof config === 'object' ? config : {};
  const projects = base.projects && typeof base.projects === 'object' ? base.projects : {};
  const existing = projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {};
  return {
    ...base,
    projects: {
      ...projects,
      [cwd]: { ...existing, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
}

/** True if `cwd` is already marked trusted (lets callers skip a redundant write). */
function isClaudeTrusted(config, cwd) {
  return !!(
    config &&
    config.projects &&
    config.projects[cwd] &&
    config.projects[cwd].hasTrustDialogAccepted === true
  );
}

/**
 * Best-effort: ensure `~/.claude.json` marks `cwd` as trusted so an interactive
 * claude pane opens straight at the prompt (no trust dialog eating the first
 * message). Never throws — returns true if (now) trusted, false on any IO error.
 */
// WIN-CMD-01 — claude'un PROJE ANAHTARI BİÇİMİ. claude 2.1.300 güveni `projects[<anahtar>]`ta
// arar ve anahtarı kendisi üretir: yolu NFC'ye çevirir, Windows'ta TERS BÖLÜLERİ DÜZ BÖLÜYE
// çevirir (`C:/Users/x/proj`; ikiliden okundu, güven kontrolü cwd'den yukarı bu biçimle yürür).
// Ürün yalnız `C:\Users\x\proj` yazıyordu → anahtar Windows'ta HİÇ eşleşmiyor, güven diyaloğu her
// ajan açılışında çıkıyor ve (vurgulu "No, exit") teslim kapısının Enter'ı claude'u kapatıyordu
// (ölçüldü: public Windows koşusu, Sentry açılış ölümlerinin %82'si Windows). POSIX'te iki biçim
// aynıdır → yazım bit-bit değişmez.
function claudeProjectKey(absPath, platform = process.platform) {
  const nfc = typeof absPath === 'string' ? absPath.normalize('NFC') : absPath;
  return platform === 'win32' ? nfc.replace(/\\/g, '/') : nfc;
}

/** Bu cwd için yazılacak güven anahtarları: ürünün eski anahtarı + claude'un kendi biçimi (tekilleştirilmiş). */
function claudeTrustKeys(cwd, platform = process.platform) {
  const key = canonicalCwd(cwd); // ADP-283 — /var/… → /private/var/…
  return [...new Set([key, claudeProjectKey(key, platform)])];
}

function ensureClaudeTrusted(cwd, homedir, platform = process.platform) {
  try {
    const home = homedir || os.homedir();
    const keys = claudeTrustKeys(cwd, platform);
    const cfgPath = path.join(home, '.claude.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      config = {}; // missing/corrupt → start fresh (claude will recreate the rest)
    }
    if (keys.every((k) => isClaudeTrusted(config, k))) return true;
    const next = keys.reduce((cfg, k) => claudeTrustPatch(cfg, k), config);
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false; // degrade: claude shows the dialog, but the pane still works
  }
}

// ---------------------------------------------------------------------------
// WIN-CMD-01 — İKİNCİ AÇILIŞ DİYALOĞU: "Bypass Permissions mode" uyarısı.
// ---------------------------------------------------------------------------
// Ajan pane'leri `--dangerously-skip-permissions` ile açılır. Claude bu kipte, kullanıcı
// uyarıyı bir kez kabul etmediyse açılışta tam ekran bir uyarı gösterir ve vurgulu
// varsayılan "1. No, exit"tir. Teslim kapısının görev + Enter'ı claude'u `exit 1` ile
// kapatıyordu: pane ölür, görev kaybolur (ölçüldü, claude 2.1.300 — Windows'ta açılış
// ölümlerinin büyük kısmı; docs/agent-results/WIN-CMD-01-evidence/).
// Claude uyarıyı yalnız KULLANICI (ya da politika) ayarında `skipDangerousModePermissionPrompt`
// görünce atlar (ikiliden okundu). ÖLÇÜLDÜ: pane'e verilen `--settings` dosyası SAYILMAZ;
// global `~/.claude.json` → `bypassPermissionsModeAccepted` claude'u İLK kez açan kullanıcıda
// işe yarar (claude onu bir kez ayara taşıyıp siler) ama claude'u daha önce açmış kullanıcıda
// YARAMAZ (3/3 uyarı). Bu yüzden ayar dosyasına yazılır: `$CLAUDE_CONFIG_DIR/settings.json`,
// yoksa `~/.claude/settings.json`; birleştirilir, kullanıcı alanlarına dokunulmaz, okunamayan
// (bozuk) dosya ezilmez. Kipi ürün seçiyor; kabul de ADP-048 güveniyle aynı anda yazılır.

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
module.exports = { claudeProjectKey, claudeTrustKeys, ensureClaudeTrusted, ensureClaudeBypassAccepted };
