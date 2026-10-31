#!/bin/bash
# Linux clean-profile smoke for AgentSpace (AppImage).
#
#   copy the AppImage to ~/Applications + chmod +x (what a user does after the download)
#   → first launch on the clean default profile up to the sign-in screen → close
#   → no app process and no AppImage mount 60 s later → delete the file
#
# Every step leaves a line in linux-smoke.json. Window steps also leave a frame of the
# app window only (never the full desktop). Before the launch it records what a user on
# this Ubuntu meets first: FUSE 2 (AppImage needs it) and the user-namespace sandbox
# (Ubuntu 24.04+ can block it; the AppImage then starts without the Chromium sandbox).
# It also runs the installed app's own modules (scripts/appProbe.cjs).
#
# ⛔ Runs ONLY on a throwaway GitHub-hosted runner: it installs packages with sudo and
#    deletes the app's data folders of the current user.
#
# Usage: bash scripts/linuxSmoke.sh <AgentSpace-x.y.z-arch.AppImage> <out dir>
# Exit:  0 green · 1 red · 2 not measured
set -uo pipefail

SRC_IMG="${1:-}"
OUT="${2:-linux-smoke}"
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "refusing: this script only runs on a throwaway GitHub-hosted runner" >&2
  exit 2
fi
[[ -f "$SRC_IMG" ]] || { echo "usage: linuxSmoke.sh <AppImage> <out dir>" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/frames" "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
STEPS="$OUT/steps.tsv"
: > "$STEPS"
APPS_DIR="$HOME/Applications"
IMG="$APPS_DIR/$(basename "$SRC_IMG")"
PROFILE="$HOME/.config/agentdesk-shell"
AGENTDESK_DIR="$HOME/.agentdesk"
TMPW="$(mktemp -d "${RUNNER_TEMP:-/tmp}/as-linux.XXXXXX")"
RED=0
UNMEASURED=0
XVFB_PID=""

step() { # step <name> <pass|fail|info|unmeasured> <detail>
  local d="${3//$'\t'/ }"; d="${d//$'\n'/ | }"
  printf '%s\t%s\t%s\n' "$1" "$2" "$d" >> "$STEPS"
  echo "[$2] $1: $3"
  [[ "$2" == fail ]] && RED=1
  [[ "$2" == unmeasured ]] && UNMEASURED=1
  return 0
}

# All processes of the app: the AppImage runtime (it serves the mount) and everything
# started from the mount (/tmp/.mount_<name>…/).
app_pids() {
  # Patterns come from the environment, not argv, so awk does not match itself.
  ps -eo pid=,comm=,args= | AS_IMG="$IMG" AS_MNT='/.mount_AgentS' awk '
    $2 != "awk" && $2 != "ps" && (index($0, ENVIRON["AS_IMG"]) || index($0, ENVIRON["AS_MNT"])) { print $1 }' | tr '\n' ' '
}
pid_keys() { # pid + start time: a pid alone can be reused
  local p; for p in $(app_pids); do printf '%s@%s ' "$p" "$(ps -o lstart= -p "$p" 2>/dev/null | tr -s ' ' '_')"; done
}
main_pid() { # the Electron main process: started from the mount, no --type= argument
  ps -eo pid=,comm=,args= | AS_MNT='/.mount_AgentS' awk '
    $2 != "awk" && $2 != "ps" && index($3, ENVIRON["AS_MNT"]) && $0 !~ /--type=/ && $3 !~ /AppRun$/ { print $1; exit }'
}
mounts() { awk '$2 ~ /\/\.mount_AgentS/ { print $2 }' /proc/mounts 2>/dev/null | tr '\n' ' '; }

# frame <file> <pid list>: biggest viewable window of those processes, that window only
frame() {
  local file="$1" pids="$2" best="" area=0 id w h a p
  for p in $pids; do
    for id in $(xdotool search --onlyvisible --pid "$p" 2>/dev/null); do
      w="$(xwininfo -id "$id" 2>/dev/null | sed -n 's/^ *Width: *//p')"
      h="$(xwininfo -id "$id" 2>/dev/null | sed -n 's/^ *Height: *//p')"
      a=$(( ${w:-0} * ${h:-0} ))
      (( a > area )) && { area=$a; best="$id ${w}x${h}"; }
    done
  done
  [[ -n "$best" ]] || { echo "no window"; return 1; }
  id="${best%% *}"
  import -window "$id" "$file" 2>/dev/null && [[ -s "$file" ]] || { echo "capture failed ($best)"; return 1; }
  # Share of non-black pixels: an all-black frame disproves "the window appeared".
  local lit; lit="$(convert "$file" -colorspace gray -threshold 3% -format '%[fx:mean]' info: 2>/dev/null)"
  echo "window $best \"$(xdotool getwindowname "$id" 2>/dev/null)\" lit=${lit:-?}"
  awk -v l="${lit:-0}" 'BEGIN { exit !(l > 0.02) }'
}

cleanup() {
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null
  rm -rf "$TMPW"
}
trap cleanup EXIT

# ── 0. machine ─────────────────────────────────────────────────────────────
. /etc/os-release
MEM_GB=$(( $(awk '/MemTotal/ { print $2 }' /proc/meminfo) / 1024 / 1024 ))
{
  cat /etc/os-release
  echo "kernel $(uname -r) arch $(uname -m) cpus $(nproc) mem ${MEM_GB} GB"
  echo "apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
  echo "unprivileged_userns_clone=$(sysctl -n kernel.unprivileged_userns_clone 2>&1)"
} > "$OUT/machine.txt" 2>&1
step machine info "$PRETTY_NAME $(uname -m), kernel $(uname -r), $(nproc) cpu, ${MEM_GB} GB"

# What the AppImage's own start script asks before it decides on --no-sandbox.
if unshare -Ur true 2>/dev/null; then USERNS=yes; else USERNS=no; fi
step userns info "unshare -Ur true: $USERNS (apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a))"

# ── 1. clean profile: nothing of the app on this machine yet ───────────────
pre=""
for d in "$IMG" "$PROFILE" "$AGENTDESK_DIR"; do [[ -e "$d" ]] && pre+="$d "; done
pre+="$(ls "$HOME/.local/share/applications" 2>/dev/null | grep -i -E 'agentspace|agentdesk' | tr '\n' ' ')"
if [[ -n "${pre// /}" ]]; then step clean-profile fail "already present before install: $pre"
else step clean-profile pass "no AppImage, no profile, no ~/.agentdesk, no desktop entry before install"; fi

# ── 2. test tools only (a user does not need these): virtual screen + window tools ──
need=""
for t in Xvfb:xvfb xdotool:xdotool xwininfo:x11-utils import:imagemagick; do
  command -v "${t%%:*}" >/dev/null 2>&1 || need+="${t##*:} "
done
if [[ -n "$need" ]]; then
  sudo apt-get update -qq >/dev/null 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null 2>&1 \
    && step test-tools info "installed for the test: $need" || step test-tools unmeasured "apt install failed: $need"
else step test-tools info "xvfb, xdotool, x11-utils, imagemagick already on the image"; fi
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 & XVFB_PID=$!
sleep 2
export DISPLAY=:99

# ── 3. install like a user: keep the file in ~/Applications, make it executable ──
mkdir -p "$APPS_DIR"
cp "$SRC_IMG" "$IMG" && chmod +x "$IMG" \
  && step install pass "$(basename "$IMG") ($(du -h "$IMG" | cut -f1)) in ~/Applications, chmod +x" \
  || step install fail "copy/chmod failed"

# ── 4. FUSE 2: AppImages need libfuse.so.2, which new Ubuntu desktops do not ship ──
if ldconfig -p | grep -q 'libfuse\.so\.2'; then
  step fuse2 info "libfuse.so.2 already on the image"
else
  # What a user sees when they double-click the file on this Ubuntu as it comes.
  msg="$(env -u DISPLAY timeout 20 "$IMG" 2>&1 | grep -v '^$' | head -3)"; rc=$?
  step fuse2-missing info "without libfuse.so.2 the file does not start: ${msg:-<no output>}"
  pkg=libfuse2t64; apt-cache show libfuse2t64 >/dev/null 2>&1 || pkg=libfuse2
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" >/dev/null 2>&1 \
    && step fuse2 info "installed $pkg (sudo apt install $pkg)" || step fuse2 fail "apt install $pkg failed"
fi

# ── 5a. probe launch in a throwaway profile: the app draws its own frame ───
P_HOME="$(mktemp -d "$TMPW/probe-home.XXXXXX")"; P_UDD="$(mktemp -d "$TMPW/probe-udd.XXXXXX")"
AGENTDESK_APP_PROBE=1 AGENTDESK_HOME="$P_HOME" AGENTDESK_DISABLE_RESTORE=1 AGENTDESK_DISABLE_AUTORESUME=1 \
AGENTDESK_PROBE_WAIT=6000 AGENTDESK_PROBE_SHOT="$OUT/frames/01-probe-signin.png" \
  "$IMG" "--user-data-dir=$P_UDD" > "$OUT/probe-stdout.txt" 2>&1 &
PB=$!; w=0
while kill -0 "$PB" 2>/dev/null && [[ $w -lt 90 ]]; do sleep 2; w=$((w + 2)); done
kill -0 "$PB" 2>/dev/null && { kill -TERM "$PB"; sleep 3; kill -KILL "$PB" 2>/dev/null; }
wait "$PB" 2>/dev/null
for i in $(seq 1 10); do [[ -z "$(app_pids)" ]] && break; sleep 1; done
rm -rf "$P_HOME" "$P_UDD"
PL="$(grep -m1 'app-probe loaded:' "$OUT/probe-stdout.txt" || true)"
CR="$(grep -m1 -E 'Cannot find module|Uncaught Exception|A JavaScript error occurred|No usable sandbox|SUID sandbox helper' "$OUT/probe-stdout.txt" || true)"
BL="$(printf '%s' "$PL" | sed -n 's/.*bodyLen[\\"]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
if [[ -n "$CR" ]]; then step probe-launch fail "main process error: $CR"
elif [[ -z "$PL" ]]; then step probe-launch fail "no 'app-probe loaded' line in ${w}s: $(tail -3 "$OUT/probe-stdout.txt" | tr '\n' ' ')"
elif [[ -z "$BL" || "$BL" -le 0 ]]; then step probe-launch fail "window is empty: $PL"
else step probe-launch pass "${PL#*app-probe loaded: } (${w}s)"; fi

# ── 5b. the real first launch: default (clean) profile, like a double-click ──
T0=$(date +%s)
"$IMG" > "$OUT/first-launch-stdout.txt" 2>&1 &
win=""
for i in $(seq 1 45); do
  sleep 2
  pids="$(app_pids)"
  for p in $pids; do
    for id in $(xdotool search --onlyvisible --pid "$p" 2>/dev/null); do
      w="$(xwininfo -id "$id" 2>/dev/null | sed -n 's/^ *Width: *//p')"
      h="$(xwininfo -id "$id" 2>/dev/null | sed -n 's/^ *Height: *//p')"
      (( ${w:-0} > 300 && ${h:-0} > 300 )) && { win="$id"; break 2; }
    done
  done
  [[ -n "$win" ]] && break
done
MAIN="$(main_pid)"
if [[ -z "$(app_pids)" ]]; then
  step first-launch fail "no AgentSpace process after start: $(tail -3 "$OUT/first-launch-stdout.txt" | tr '\n' ' ')"
elif [[ -z "$win" ]]; then
  step first-launch fail "process up, no window in $(( $(date +%s) - T0 ))s ($(app_pids))"
else
  step first-launch pass "window up in $(( $(date +%s) - T0 ))s"
  sleep 12   # let the first screen (sign-in) render
  f="$(frame "$OUT/frames/02-first-launch-signin.png" "$(app_pids)")" \
    && step first-launch-frame info "$f" || step first-launch-frame unmeasured "$f"
fi
if [[ -n "$MAIN" ]]; then
  args="$(tr '\0' ' ' < "/proc/$MAIN/cmdline" 2>/dev/null)"
  if [[ "$args" == *--no-sandbox* ]]; then sb="started WITHOUT the Chromium sandbox (--no-sandbox; user namespaces: $USERNS)"
  else sb="started WITH the Chromium sandbox (user namespaces: $USERNS)"; fi
  step sandbox info "$sb"
  step memory-app-open info "$(free -m | awk '/Mem:/ { print "used " $3 " MB of " $2 " MB" }'); app processes $(app_pids | wc -w)"
fi
[[ -d "$PROFILE" ]] && step profile-created pass "first launch created ~/.config/agentdesk-shell" \
  || step profile-created info "no ~/.config/agentdesk-shell after first launch"
CR2="$(grep -m1 -E 'Cannot find module|Uncaught Exception|A JavaScript error occurred|No usable sandbox|SUID sandbox helper' "$OUT/first-launch-stdout.txt" || true)"
[[ -n "$CR2" ]] && step first-launch-errors fail "$CR2"

# ── 6. close (SIGTERM, what logout/shutdown sends) and make sure nothing stays behind ──
BEFORE="$(pid_keys)"
if [[ -n "$MAIN" ]]; then kill -TERM "$MAIN" 2>/dev/null; fi
for i in $(seq 1 20); do [[ -z "$(app_pids)" ]] && break; sleep 2; done
if [[ -n "$(app_pids)" ]]; then
  # the runtime process that serves the mount, if the main process is gone
  for p in $(app_pids); do kill -TERM "$p" 2>/dev/null; done
  for i in $(seq 1 10); do [[ -z "$(app_pids)" ]] && break; sleep 2; done
  [[ -z "$(app_pids)" ]] && step close fail "closed only after SIGTERM to every process" \
    || step close fail "still running after SIGTERM: $(pid_keys)"
else
  step close pass "all app processes gone after SIGTERM to the main process"
fi
sleep 60
LEFT=""; for k in $BEFORE; do p="${k%@*}"; now="$(ps -o lstart= -p "$p" 2>/dev/null | tr -s ' ' '_')"; [[ -n "$now" && "$p@$now" == "$k" ]] && LEFT+="$k "; done
NEW="$(pid_keys)"; MNT="$(mounts)"
[[ -z "$LEFT$NEW$MNT" ]] && step leftover-60s pass "no app process and no AppImage mount 60s after close" \
  || step leftover-60s fail "left: $LEFT new: $NEW mounts: $MNT"

# The app's own log.
if [[ -d "$PROFILE/logs" ]]; then
  find "$PROFILE/logs" -maxdepth 1 -type f -name '*.log' -size -5M -exec cp {} "$OUT/logs/" \;
  errs="$(cat "$OUT"/logs/*.log 2>/dev/null | grep -c -E 'Uncaught|Cannot find module|FATAL' || true)"
  step app-log info "$(ls "$OUT/logs" | wc -l) log file(s), crash lines: $errs"
fi

# ── 7. the app's own modules (Antigravity hook, memory brake), from the AppImage ──
( cd "$TMPW" && "$IMG" --appimage-extract >/dev/null 2>&1 )
ROOT="$TMPW/squashfs-root"
BIN="$ROOT/agentspace"
[[ -x "$BIN" ]] || BIN="$(find "$ROOT" -maxdepth 1 -type f -perm -u+x ! -name AppRun ! -name 'chrome*' ! -name '*.so*' | head -1)"
if [[ -x "$BIN" && -f "$ROOT/resources/app.asar" ]]; then
  pr="$(ELECTRON_RUN_AS_NODE=1 "$BIN" "$HERE/appProbe.cjs" --app "$ROOT/resources/app.asar" --out "$OUT" --label "linux-$(uname -m)" 2>&1 | tail -20)"; rc=${PIPESTATUS[0]}
  case $rc in
    0) step app-probe pass "${pr//$'\n'/ }" ;;
    2) step app-probe unmeasured "${pr//$'\n'/ }" ;;
    *) step app-probe fail "${pr//$'\n'/ }" ;;
  esac
else
  step app-probe unmeasured "could not extract the AppImage (bin=$BIN)"
fi

# ── 8. remove like a user: delete the file ─────────────────────────────────
rm -f "$IMG"
desk="$(ls "$HOME/.local/share/applications" "$HOME/.config/autostart" "$HOME/.config/systemd/user" 2>/dev/null | grep -i -E 'agentspace|agentdesk' | tr '\n' ' ')"
if [[ -e "$IMG" || -n "$(app_pids)" || -n "$(mounts)" ]]; then
  step uninstall fail "left: file=$([[ -e $IMG ]] && echo yes || echo no) procs=$(app_pids) mounts=$(mounts)"
else
  step uninstall pass "file gone, no process, no mount"
fi
step desktop-entries info "${desk:-none} (desktop entry / autostart / user service left after delete)"
data=""; for d in "$PROFILE" "$AGENTDESK_DIR"; do [[ -e "$d" ]] && data+="${d/#$HOME/~} ($(du -sh "$d" 2>/dev/null | cut -f1)) "; done
step user-data-left info "${data:-none} (an AppImage keeps user data after the file is deleted)"

# ── verdict ───────────────────────────────────────────────────────────────
V=green; RC=0
[[ $UNMEASURED -eq 1 ]] && { V=unmeasured; RC=2; }
[[ $RED -eq 1 ]] && { V=red; RC=1; }
python3 -I - "$STEPS" "$OUT/linux-smoke.json" "$V" <<'PY'
import json, sys
steps = []
for line in open(sys.argv[1], encoding='utf-8'):
    name, status, detail = (line.rstrip('\n').split('\t') + ['', ''])[:3]
    steps.append({'step': name, 'status': status, 'detail': detail})
json.dump({'verdict': sys.argv[3], 'steps': steps}, open(sys.argv[2], 'w'), indent=2)
PY
echo "verdict: $V"
{
  echo "### $PRETTY_NAME $(uname -m) — $V"
  echo
  echo "| step | status | detail |"
  echo "|---|---|---|"
  while IFS=$'\t' read -r n s d; do echo "| $n | $s | ${d//|//} |"; done < "$STEPS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit $RC
