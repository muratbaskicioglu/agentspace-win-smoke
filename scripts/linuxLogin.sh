#!/bin/bash
# Linux sign-in of a PUBLISHED AgentSpace AppImage, measured arm by arm.
#
# Each arm is a fresh home + its own D-Bus session, and differs in ONE thing a Linux user
# can have: the desktop the session declares (XDG_CURRENT_DESKTOP), whether a keyring
# (gnome-keyring, Secret Service) runs, and one command-line flag. In each arm:
#   launch the AppImage → the app's own log lines (secret storage backend, agentspace://
#   registration) → click "Sign in" with a real mouse event → did the system browser get
#   the sign-in address? → can a real browser start from the app's environment? →
#   send an agentspace:// return the way a browser does (xdg-open) → did it reach the app?
# Then the engine CLIs' sign-in flow is started with the app's own engineAuth module.
#
# No account, no secrets: the browser is a stand-in that records the address and never
# loads it; the return carries a fake code with a wrong state, so the app rejects it
# locally before any network call.
#
# ⛔ Runs ONLY on a throwaway GitHub-hosted runner (installs packages with sudo).
#
# Usage: bash scripts/linuxLogin.sh <AgentSpace-x.y.z-x86_64.AppImage> <out dir>
# Exit:  0 every arm measured · 2 something could not be measured
set -uo pipefail

if [[ "${1:-}" == "--arm" ]]; then INNER=1; else INNER=0; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

app_pids() {
  ps -eo pid=,comm=,args= | AS_IMG="${IMG:-/nonexistent}" AS_MNT='/.mount_AgentS' awk '
    index($3, ENVIRON["AS_IMG"]) == 1 || index($3, ENVIRON["AS_MNT"]) { print $1 }' | tr '\n' ' '
}
main_pid() {
  ps -eo pid=,comm=,args= | AS_MNT='/.mount_AgentS' awk '
    $2 != "awk" && $2 != "ps" && index($3, ENVIRON["AS_MNT"]) && $0 !~ /--type=/ && $3 !~ /AppRun$/ { print $1; exit }'
}
stop_app() {
  local m; m="$(main_pid)"
  [[ -n "$m" ]] && kill -TERM "$m" 2>/dev/null
  for i in $(seq 1 15); do [[ -z "$(app_pids)" ]] && return 0; sleep 1; done
  for p in $(app_pids); do kill -KILL "$p" 2>/dev/null; done
  sleep 2
}

# ════════════════════════ one arm (inside its own D-Bus session) ════════════════════════
if [[ $INNER -eq 1 ]]; then
  ARM="$2"; IMG="$3"; BIN="$4"; O="$5"; PORT="$6"
  R="$O/$ARM"; mkdir -p "$R"
  res() { printf '%s\t%s\n' "$1" "$2" >> "$R/result.tsv"; echo "[$ARM] $1: $2"; }
  : > "$R/result.tsv"

  export HOME; HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/as-login-home.XXXXXX")"
  unset XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP DESKTOP_SESSION KDE_SESSION_VERSION KDE_FULL_SESSION \
        XDG_CONFIG_HOME XDG_DATA_HOME GNOME_KEYRING_CONTROL BROWSER
  KEYRING=1; EXTRA=()
  case "$ARM" in
    gnome)            export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome DESKTOP_SESSION=gnome ;;
    no-desktop)       : ;;
    no-desktop-flag)  EXTRA=(--password-store=gnome-libsecret) ;;
    gnome-no-keyring) export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome DESKTOP_SESSION=gnome; KEYRING=0 ;;
    no-keyring-flag)  KEYRING=0; EXTRA=(--password-store=gnome-libsecret) ;;
    kde-no-kwallet)   export XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE DESKTOP_SESSION=plasma KDE_SESSION_VERSION=6 KDE_FULL_SESSION=true ;;
    kde-no-kwallet-flag) export XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE DESKTOP_SESSION=plasma KDE_SESSION_VERSION=6 KDE_FULL_SESSION=true
                      EXTRA=(--password-store=gnome-libsecret) ;;
    *) echo "unknown arm $ARM"; exit 2 ;;
  esac
  res desktop "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-<unset>} KDE_SESSION_VERSION=${KDE_SESSION_VERSION:-<unset>} flags=${EXTRA[*]:-none}"

  KR_PID=""
  if [[ $KEYRING -eq 1 ]]; then
    eval "$(printf 'lab-pass' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
    sleep 1
    KR_PID="$(pgrep -n -u "$(id -u)" gnome-keyring-d || true)"
    if printf 'x' | secret-tool store --label=lxprobe lxprobe arm 2>/dev/null && [[ "$(secret-tool lookup lxprobe arm 2>/dev/null)" == x ]]; then
      res keyring "gnome-keyring running and unlocked: secret-tool store+lookup ok"
    else
      res keyring "gnome-keyring started but secret-tool store/lookup FAILED"
    fi
  else
    # This arm's bus has no activatable services (see SESSION_CONF), so nothing can
    # start a keyring behind the app's back.
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListActivatableNames 2>/dev/null | grep -q org.freedesktop.secrets \
       || dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q org.freedesktop.secrets; then
      res keyring "no keyring started, but org.freedesktop.secrets is on/activatable on the bus"
    else res keyring "no keyring: org.freedesktop.secrets neither running nor activatable on the session bus"; fi
  fi

  # Stand-in browser: records the address it was asked to open (path + parameter NAMES
  # only), the environment it inherited from the app, and whether a real browser can
  # start with that environment.
  mkdir -p "$HOME/.local/share/applications" "$HOME/bin"
  cat > "$HOME/bin/fakebrowser" <<'FB'
#!/bin/bash
u="${1:-}"
printf '%s\n' "$u" > "$HOME/fakebrowser.url"
{
  echo "address: ${u%%\?*} ?$(printf '%s' "${u#*\?}" | tr '&' '\n' | sed 's/=.*//' | tr '\n' '&')"
  for v in LD_LIBRARY_PATH LD_PRELOAD APPDIR APPIMAGE ARGV0 OWD GSETTINGS_SCHEMA_DIR PYTHONHOME PYTHONPATH PERLLIB QT_PLUGIN_PATH GTK_PATH GIO_MODULE_DIR XDG_DATA_DIRS ELECTRON_RUN_AS_NODE CHROME_DESKTOP; do
    if [[ -n "${!v+x}" ]]; then echo "env $v=${!v}"; else echo "env $v=<unset>"; fi
  done
  echo "env PATH=$PATH"
  echo "parent: $(ps -o args= -p "$PPID" 2>/dev/null | cut -c1-160)"
} > "$HOME/fakebrowser.env"
# Real browsers, started with exactly this inherited environment.
T="$(mktemp -d)"
if command -v google-chrome >/dev/null 2>&1; then
  out="$(timeout 40 google-chrome --headless=new --no-first-run --user-data-dir="$T/c" --dump-dom 'data:text/html,<p>browser-ok</p>' 2>"$T/c.err")"; rc=$?
  if [[ "$out" == *browser-ok* ]]; then echo "google-chrome: started (rc=$rc)"; else echo "google-chrome: FAILED rc=$rc $(grep -v '^$' "$T/c.err" | tail -2 | tr '\n' ' ' | cut -c1-300)"; fi
fi >> "$HOME/fakebrowser.env"
if command -v firefox >/dev/null 2>&1; then
  mkdir -p "$T/f"
  timeout 60 firefox --headless --no-remote --profile "$T/f" --screenshot "$T/f.png" 'data:text/html,<p>browser-ok</p>' >"$T/f.out" 2>&1; rc=$?
  if [[ -s "$T/f.png" ]]; then echo "firefox: started (rc=$rc)"; else echo "firefox: FAILED rc=$rc $(grep -v '^$' "$T/f.out" | tail -2 | tr '\n' ' ' | cut -c1-300)"; fi
fi >> "$HOME/fakebrowser.env"
rm -rf "$T"
FB
  chmod +x "$HOME/bin/fakebrowser"
  cat > "$HOME/.local/share/applications/fakebrowser.desktop" <<FD
[Desktop Entry]
Type=Application
Name=Stand-in browser
Exec=$HOME/bin/fakebrowser %u
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
NoDisplay=true
FD
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1
  xdg-mime default fakebrowser.desktop x-scheme-handler/https x-scheme-handler/http text/html 2>/dev/null
  res https-handler "$(xdg-mime query default x-scheme-handler/https 2>&1)"
  res agentspace-handler-before "$(xdg-mime query default x-scheme-handler/agentspace 2>&1 || true)"

  # Launch like a double-click, plus a DevTools port for the driver.
  "$IMG" "--remote-debugging-port=$PORT" --remote-debugging-address=127.0.0.1 "${EXTRA[@]}" > "$R/app-stdout.txt" 2>&1 &
  ELECTRON_RUN_AS_NODE=1 "$BIN" "$HERE/loginDrive.cjs" --port "$PORT" --out "$R" --label "$ARM" --wait-after 12000 > "$R/drive.txt" 2>&1
  DRC=$?
  res drive "exit $DRC: $(grep -E '\] (click|button|keychain-warning-before-click):' "$R/drive.txt" | sed 's/^\[[^]]*\] //' | tr '\n' ' ' | cut -c1-600)"
  res screen-note "$(grep -E '\] note-after-click:' "$R/drive.txt" | sed 's/^\[[^]]*\] //' | cut -c1-400)"
  L="$R/app-stdout.txt"
  res app-backend "$(grep -m1 -o 'safeStorage: kullanılabilir=.*' "$L" | cut -c1-220)"
  res app-scheme-registration "$(grep -m1 -o 'Linux masaüstü kaydı:.*' "$L" | cut -c1-300)"
  res app-scheme-ownership "$(grep -m1 -o 'sahiplik(linux):.*' "$L" | cut -c1-300)"
  res app-signin "$(grep -m2 -o -E 'muratify:signIn error:.*|seatGate: signIn başlatıldı.*|\[auth\] session:.*' "$L" | cut -c1-300 | tr '\n' ' ')"
  if [[ -s "$HOME/fakebrowser.url" ]]; then
    res browser-opened "YES — $(grep -m1 '^address:' "$HOME/fakebrowser.env")"
    res browser-env "$(grep -E '^env (LD_LIBRARY_PATH|APPDIR|APPIMAGE|GSETTINGS_SCHEMA_DIR|ELECTRON_RUN_AS_NODE|PYTHONHOME|QT_PLUGIN_PATH|GTK_PATH)=' "$HOME/fakebrowser.env" | tr '\n' ' ')"
    res real-browsers "$(grep -E '^(google-chrome|firefox):' "$HOME/fakebrowser.env" | tr '\n' ' ')"
    cp "$HOME/fakebrowser.env" "$R/browser-env.txt"
  else
    res browser-opened "NO — the system browser was not asked to open anything"
  fi
  [[ "${XDG_CURRENT_DESKTOP:-}" == KDE ]] && res kde-note "xdg-open on KDE hands over to kde-open, which is not on this image: browser hand-off and return are NOT representative in KDE arms; read app-signin"
  res agentspace-handler-after "$(xdg-mime query default x-scheme-handler/agentspace 2>&1 || true)"
  ls "$HOME/.local/share/applications" > "$R/applications.txt" 2>&1

  # The return, the way a browser hands it over: xdg-open with the app's scheme.
  before="$(wc -l < "$L")"
  timeout 30 xdg-open 'agentspace://auth/callback?code=LXFAKE&state=lx-wrong-state' > "$R/xdg-open.txt" 2>&1; XRC=$?
  sleep 10
  got="$(tail -n +"$((before + 1))" "$L" | grep -o -E 'deep-link[^:]*: agentspace://[a-z/]*|callback reddedildi \([a-z_]*\)|giriş TAMAM' | tr '\n' ' ')"
  res return-delivery "xdg-open exit $XRC $(head -c 200 "$R/xdg-open.txt" | tr '\n' ' ') → app: ${got:-<nothing reached the app>}"

  stop_app
  [[ -n "$KR_PID" ]] && kill "$KR_PID" 2>/dev/null
  rm -rf "$HOME"
  exit 0
fi

# ════════════════════════════════════ outer ════════════════════════════════════
SRC_IMG="${1:-}"; OUT="${2:-linux-login}"
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "refusing: this script only runs on a throwaway GitHub-hosted runner" >&2; exit 2
fi
[[ -f "$SRC_IMG" ]] || { echo "usage: linuxLogin.sh <AppImage> <out dir>" >&2; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
TMPW="$(mktemp -d "${RUNNER_TEMP:-/tmp}/as-login.XXXXXX")"
. /etc/os-release
echo "machine: $PRETTY_NAME $(uname -m) kernel $(uname -r)" | tee "$OUT/machine.txt"

pkg_fuse=libfuse2t64; apt-cache show libfuse2t64 >/dev/null 2>&1 || pkg_fuse=libfuse2
sudo apt-get update -qq >/dev/null 2>&1
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb xdotool x11-utils imagemagick dbus-x11 \
  gnome-keyring libsecret-tools xdg-utils desktop-file-utils "$pkg_fuse" >/dev/null 2>&1 \
  || { echo "apt install failed"; exit 2; }
{ echo "browsers on the image:"; google-chrome --version 2>&1; firefox --version 2>&1; xdg-open --version 2>&1; gnome-keyring-daemon --version 2>&1; } | tee -a "$OUT/machine.txt"

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 & XVFB_PID=$!
trap 'kill $XVFB_PID 2>/dev/null; rm -rf "$TMPW"' EXIT
sleep 2; export DISPLAY=:99

mkdir -p "$HOME/Applications"
IMG="$HOME/Applications/$(basename "$SRC_IMG")"
cp "$SRC_IMG" "$IMG" && chmod +x "$IMG"
( cd "$TMPW" && "$IMG" --appimage-extract >/dev/null 2>&1 )
ROOT="$TMPW/squashfs-root"; BIN="$ROOT/agentspace"
[[ -x "$BIN" && -f "$ROOT/resources/app.asar" ]] || { echo "could not extract the AppImage"; exit 2; }
sed -n '1,200p' "$ROOT/AppRun" > "$OUT/AppRun.txt" 2>/dev/null
echo "app version: $(ELECTRON_RUN_AS_NODE=1 "$BIN" -e "console.log(require('$ROOT/resources/app.asar/package.json').version)")" | tee -a "$OUT/machine.txt"

# A session bus with NO service directories: on the stock session bus gnome-keyring is
# D-Bus activatable, so "no keyring" would silently start one.
SESSION_CONF="$TMPW/session-no-services.conf"
cat > "$SESSION_CONF" <<'CONF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF

PORT=9333; RC=0
for arm in gnome no-desktop no-desktop-flag gnome-no-keyring no-keyring-flag kde-no-kwallet kde-no-kwallet-flag; do
  echo "════ arm $arm"
  conf=()
  [[ "$arm" == gnome-no-keyring || "$arm" == no-keyring-flag ]] && conf=(--config-file="$SESSION_CONF")
  IMG="$IMG" dbus-run-session "${conf[@]}" -- bash "$0" --arm "$arm" "$IMG" "$BIN" "$OUT" "$PORT" || RC=2
  IMG="$IMG"; stop_app
  PORT=$((PORT + 1))
done

# ── engine CLIs: start their sign-in with the app's own module ──
echo "════ engines"
if sudo npm install -g --silent @anthropic-ai/claude-code @openai/codex >/dev/null 2>&1; then
  { echo "claude $(claude --version 2>&1 | head -1)"; echo "codex $(codex --version 2>&1 | head -1)"; } | tee "$OUT/engine-versions.txt"
  ( export HOME; HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/as-eng-home.XXXXXX")"
    ELECTRON_RUN_AS_NODE=1 timeout 300 "$BIN" "$HERE/engineLoginProbe.cjs" --app "$ROOT/resources/app.asar" --out "$OUT" --engines claude,codex \
      > "$OUT/engine-login.txt" 2>&1; echo "exit $?" >> "$OUT/engine-login.txt"; rm -rf "$HOME" )
else
  echo "npm install of the engine CLIs failed" | tee "$OUT/engine-login.txt"; RC=2
fi

# ── summary ──
{
  echo "### $PRETTY_NAME $(uname -m) — AgentSpace $(basename "$SRC_IMG")"
  for d in "$OUT"/*/; do
    [[ -f "$d/result.tsv" ]] || continue
    echo; echo "#### arm \`$(basename "$d")\`"; echo; echo "| check | result |"; echo "|---|---|"
    while IFS=$'\t' read -r k v; do echo "| $k | ${v//|//} |"; done < "$d/result.tsv"
  done
  echo; echo "#### engines"; echo; echo '```'; cut -c1-900 "$OUT/engine-login.txt"; echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit $RC
