#!/bin/bash
# macOS clean-profile smoke for AgentSpace.
#
#   install (dmg → /Applications) → Gatekeeper check → first launch on the clean default
#   profile up to the sign-in screen → close → uninstall (drag to Trash)
#
# Every step leaves a frame (window-only screenshot, never the full desktop) and a line
# in mac-smoke.json. It also records how much memory this machine has and what the
# app's own memory brake says about it (scripts/appProbe.cjs, the app's own code).
#
# ⛔ Runs ONLY on a throwaway GitHub-hosted runner: it deletes /Applications/AgentSpace.app
#    and the app's data folders of the current user.
#
# Usage: bash scripts/macSmoke.sh <AgentSpace-x.y.z-arch.dmg> <out dir>
# Exit:  0 green · 1 red · 2 not measured
set -uo pipefail

DMG="${1:-}"
OUT="${2:-mac-smoke}"
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "refusing: this script only runs on a throwaway GitHub-hosted runner" >&2
  exit 2
fi
[[ -f "$DMG" ]] || { echo "usage: macSmoke.sh <dmg> <out dir>" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/frames" "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
STEPS="$OUT/steps.tsv"
: > "$STEPS"
APP=/Applications/AgentSpace.app
MNT="$(mktemp -d /tmp/as-dmg.XXXXXX)"
PROFILE="$HOME/Library/Application Support/agentdesk-shell"
LOGDIR="$HOME/Library/Logs/AgentSpace"
AGENTDESK_DIR="$HOME/.agentdesk"
RED=0
UNMEASURED=0

step() { # step <name> <pass|fail|info|unmeasured> <detail>
  local d="${3//$'\t'/ }"; d="${d//$'\n'/ | }"
  printf '%s\t%s\t%s\n' "$1" "$2" "$d" >> "$STEPS"
  echo "[$2] $1: $3"
  [[ "$2" == fail ]] && RED=1
  [[ "$2" == unmeasured ]] && UNMEASURED=1
  return 0
}

# ── window list (owner pid, window id, bounds) without screen-recording permission ──
WINLIST="$(mktemp -d /tmp/as-winlist.XXXXXX)/winlist"
cat > "$WINLIST.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let id = w[kCGWindowNumber as String] as? Int ?? 0
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let owner = (w[kCGWindowOwnerName as String] as? String ?? "").replacingOccurrences(of: "\t", with: " ")
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let wd = b["Width"] as? Double ?? 0, ht = b["Height"] as? Double ?? 0
  print("\(pid)\t\(id)\t\(layer)\t\(Int(wd))x\(Int(ht))\t\(owner)")
}
SWIFT
swiftc -O -o "$WINLIST" "$WINLIST.swift" >/dev/null 2>&1 || WINLIST=""

# frame <file> <owner name or pid list>: biggest on-screen layer-0 window of that owner
frame() {
  local file="$1" who="$2" line id
  [[ -n "$WINLIST" ]] || { echo "no window lister"; return 1; }
  line="$("$WINLIST" | awk -F'\t' -v who="$who" '
    $3==0 { split($4,s,"x"); a=s[1]*s[2]; n=split(who,ws," "); hit=0
            for(i=1;i<=n;i++) if ($1==ws[i] || $5==ws[i]) hit=1
            if (hit && a>best) { best=a; out=$2"\t"$4 } }
    END { if (out!="") print out }')"
  [[ -n "$line" ]] || { echo "no window"; return 1; }
  id="${line%%$'\t'*}"
  screencapture -x -o -l "$id" "$file" 2>/dev/null && [[ -s "$file" ]] && { echo "window $line"; return 0; }
  echo "screencapture failed"; return 1
}

app_pids() { pgrep -f "^$APP/" 2>/dev/null | tr '\n' ' '; }
pid_keys() { # pid + start time: a pid alone can be reused
  local p; for p in $(app_pids); do printf '%s@%s ' "$p" "$(ps -o lstart= -p "$p" 2>/dev/null | tr -s ' ' '_')"; done
}
mem_line() {
  printf 'pressure=%s free=%s swap=%s' \
    "$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)" \
    "$(memory_pressure -Q 2>/dev/null | sed -n 's/.*free percentage: *//p')" \
    "$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*used = \([0-9.]*M\).*/\1/p')"
}
app_probe() { # app_probe <label>: the app's own modules in Node mode
  local asar="$APP/Contents/Resources/app.asar" bin
  bin="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
  ELECTRON_RUN_AS_NODE=1 "$bin" "$HERE/appProbe.cjs" --app "$asar" --out "$OUT" --label "$1" ${2:+--check "$2"} 2>&1 | tail -20
  return "${PIPESTATUS[0]}"
}

# ── 0. machine ─────────────────────────────────────────────────────────────
{
  sw_vers
  echo "arch $(uname -m)"
  echo "memsize $(sysctl -n hw.memsize)  ncpu $(sysctl -n hw.ncpu)"
  echo "--- vm_stat (idle, before install)"
  vm_stat
  echo "--- memory_pressure -Q"
  memory_pressure -Q 2>/dev/null | tail -3
  echo "--- swap $(sysctl -n vm.swapusage)"
} > "$OUT/machine.txt" 2>&1
MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
step machine info "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)) $(uname -m), ${MEM_GB} GB, $(sysctl -n hw.ncpu) cpu; idle $(mem_line)"

# ── 1. clean profile: nothing of the app on this machine yet ───────────────
pre=""
for d in "$APP" "$PROFILE" "$LOGDIR" "$AGENTDESK_DIR"; do [[ -e "$d" ]] && pre+="$d "; done
if [[ -n "$pre" ]]; then step clean-profile fail "already present before install: $pre"
else step clean-profile pass "no app, no profile, no logs, no ~/.agentdesk before install"; fi

# ── 2. open the dmg like a user (Finder window) and check the signature ────
if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null; then
  step dmg-mount fail "hdiutil attach failed"
else
  SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -type d | head -1)"
  step dmg-mount pass "mounted; app in dmg: $(basename "${SRC:-none}")"
  # A frame of the dmg window, as the user sees it after double-clicking the file.
  open "$MNT" 2>/dev/null; sleep 4
  f="$(frame "$OUT/frames/01-dmg-window.png" Finder)" && step dmg-frame info "$f" || step dmg-frame info "no frame: $f"

  cs="$(codesign --verify --deep --strict --verbose=2 "$SRC" 2>&1 | tail -2)"
  [[ "$cs" == *"valid on disk"* && "$cs" == *"satisfies its Designated Requirement"* ]] \
    && step codesign pass "$cs" || step codesign fail "$cs"
  team="$(codesign -dv "$SRC" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  # stapler asks Apple's ticket service; a network hiccup reads "Error 68" (seen 31.10 on
  # macos-15 while gatekeeper said "Notarized" on the same machine). Up to 3 tries, 15 s apart;
  # still red if all three fail.
  st=""; try=0
  while (( try < 3 )); do
    try=$((try + 1))
    st="$(xcrun stapler validate "$SRC" 2>&1 | tail -1)"
    [[ "$st" == *"worked"* ]] && break
    if (( try < 3 )); then sleep 15; fi
  done
  [[ "$st" == *"worked"* ]] && step notarization-ticket pass "$st (team $team, try $try)" || step notarization-ticket fail "$st (after $try tries)"

  # ── 3. install: copy into /Applications (what drag-and-drop does) ─────────
  ditto "$SRC" "$APP" && step install pass "copied to $APP ($(du -sh "$APP" | cut -f1)), version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" \
    || step install fail "ditto failed"
  hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
fi

if [[ ! -d "$APP" ]]; then
  step launch fail "not installed";
else
  # Gatekeeper: what a browser download would face (quarantine flag set on purpose).
  xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$APP"
  gk="$(spctl --assess --type execute -vv "$APP" 2>&1 | tr '\n' ' ')"
  [[ "$gk" == *accepted* ]] && step gatekeeper pass "$gk" || step gatekeeper fail "$gk"
  # The runner has nobody to click "Open" on the first-open question, so the flag is
  # removed before the unattended launch (the check above is Gatekeeper's verdict).
  xattr -dr com.apple.quarantine "$APP"

  EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
  BIN="$APP/Contents/MacOS/$EXEC_NAME"

  # ── 4a. probe launch in a throwaway profile: the app draws its own frame ──
  P_HOME="$(mktemp -d /tmp/as-probe-home.XXXXXX)"; P_UDD="$(mktemp -d /tmp/as-probe-udd.XXXXXX)"
  AGENTDESK_APP_PROBE=1 AGENTDESK_HOME="$P_HOME" AGENTDESK_DISABLE_RESTORE=1 AGENTDESK_DISABLE_AUTORESUME=1 \
  AGENTDESK_PROBE_WAIT=6000 AGENTDESK_PROBE_SHOT="$OUT/frames/02-probe-signin.png" \
    "$BIN" "--user-data-dir=$P_UDD" > "$OUT/probe-stdout.txt" 2>&1 &
  PPID_=$!; w=0
  while kill -0 "$PPID_" 2>/dev/null && [[ $w -lt 90 ]]; do sleep 2; w=$((w + 2)); done
  kill -0 "$PPID_" 2>/dev/null && { kill -TERM "$PPID_"; sleep 2; kill -KILL "$PPID_" 2>/dev/null; }
  wait "$PPID_" 2>/dev/null
  rm -rf "$P_HOME" "$P_UDD"
  PL="$(grep -m1 'app-probe loaded:' "$OUT/probe-stdout.txt" || true)"
  CR="$(grep -m1 -E 'Cannot find module|Uncaught Exception|A JavaScript error occurred' "$OUT/probe-stdout.txt" || true)"
  BL="$(printf '%s' "$PL" | sed -n 's/.*bodyLen[\\"]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  if [[ -n "$CR" ]]; then step probe-launch fail "main process error: $CR"
  elif [[ -z "$PL" ]]; then step probe-launch fail "no 'app-probe loaded' line in ${w}s"
  elif [[ -z "$BL" || "$BL" -le 0 ]]; then step probe-launch fail "window is empty: $PL"
  else step probe-launch pass "${PL#*app-probe loaded: } (${w}s)"; fi

  # ── 4b. the real first launch: default (clean) profile, opened like a double-click ──
  T0=$(date +%s)
  open "$APP"
  win="" ; for i in $(seq 1 45); do
    sleep 2
    pids="$(app_pids)"
    [[ -n "$pids" && -n "$WINLIST" ]] && win="$("$WINLIST" | awk -F'\t' -v ps="$pids" '$3==0 { n=split(ps,a," "); for(i=1;i<=n;i++) if ($1==a[i]) { split($4,s,"x"); if (s[1]>300 && s[2]>300) print $2 } }' | head -1)"
    [[ -n "$win" ]] && break
  done
  if [[ -z "$(app_pids)" ]]; then step first-launch fail "no AgentSpace process after open"
  elif [[ -z "$win" ]]; then step first-launch fail "process up, no window in $(( $(date +%s) - T0 ))s ($(app_pids))"
  else
    step first-launch pass "window up in $(( $(date +%s) - T0 ))s"
    sleep 12   # let the first screen (sign-in) render
    f="$(frame "$OUT/frames/03-first-launch-signin.png" "$(app_pids)")" && step first-launch-frame info "$f" || step first-launch-frame unmeasured "$f"
  fi
  step memory-app-open info "$(mem_line); app processes $(app_pids | wc -w | tr -d ' ')"
  vm_stat > "$OUT/vm_stat-app-open.txt" 2>&1
  pr="$(app_probe app-open memory)"; step memory-brake-app-open info "${pr//$'\n'/ }"
  # Positive control for the Windows hook check: the same app code, same check, on macOS.
  pr="$(app_probe mac agy-hook)"; rc=$?
  [[ $rc -eq 0 ]] && step agy-hook pass "${pr//$'\n'/ }" || step agy-hook fail "${pr//$'\n'/ }"
  [[ -d "$PROFILE" ]] && step profile-created pass "first launch created the profile folder" || step profile-created info "no profile folder after first launch"

  # ── 5. close (Cmd-Q) and make sure nothing stays behind ───────────────────
  BEFORE="$(pid_keys)"
  # Cmd-Q as an Apple event. If the runner does not let the event through (no one to
  # answer an automation prompt), the app gets SIGTERM, what logout/shutdown sends.
  osascript -e 'tell application id "com.muratify.agentspace" to quit' >/dev/null 2>&1 & Q=$!
  for i in $(seq 1 15); do kill -0 "$Q" 2>/dev/null || break; sleep 1; done
  kill "$Q" 2>/dev/null; wait "$Q" 2>/dev/null
  HOW="quit (Apple event)"
  for i in $(seq 1 15); do [[ -z "$(app_pids)" ]] && break; sleep 2; done
  if [[ -n "$(app_pids)" ]]; then
    MAIN="$(pgrep -f "^$BIN( |$)" | head -1)"
    f="$(frame "$OUT/frames/04-close-pending.png" "$(app_pids)")"
    [[ -n "$MAIN" ]] && kill -TERM "$MAIN"; HOW="SIGTERM (Apple event quit did not close it; $f)"
    for i in $(seq 1 15); do [[ -z "$(app_pids)" ]] && break; sleep 2; done
  fi
  if [[ -n "$(app_pids)" ]]; then
    step close fail "still running after quit and SIGTERM: $(pid_keys)"
  else
    step close pass "all app processes gone after $HOW"
  fi
  sleep 60
  LEFT=""; for k in $BEFORE; do p="${k%@*}"; now="$(ps -o lstart= -p "$p" 2>/dev/null | tr -s ' ' '_')"; [[ -n "$now" && "$p@$now" == "$k" ]] && LEFT+="$k "; done
  NEW="$(pid_keys)"
  [[ -z "$LEFT$NEW" ]] && step leftover-60s pass "no app process 60s after close" || step leftover-60s fail "left: $LEFT new: $NEW"

  # The app's own log (not the Chromium profile: its *.log files are database journals).
  if [[ -d "$LOGDIR" ]]; then
    find "$LOGDIR" -maxdepth 1 -type f -name '*.log' -size -5M -exec cp {} "$OUT/logs/" \;
    errs="$(cat "$OUT"/logs/*.log 2>/dev/null | grep -c -E 'Uncaught|Cannot find module|FATAL' || true)"
    step app-log info "$(ls "$OUT/logs" | wc -l | tr -d ' ') log file(s), crash lines: $errs"
  fi

  # ── 6. uninstall: drag to Trash ──────────────────────────────────────────
  [[ -x "$BIN" ]] && step uninstall-precheck pass "app present before uninstall" || step uninstall-precheck fail "app missing before uninstall"
  mv "$APP" "$HOME/.Trash/" 2>/dev/null || rm -rf "$APP"
  rm -rf "$HOME/.Trash/AgentSpace.app"
  agents="$(ls "$HOME/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null | grep -i -E 'agentspace|agentdesk|muratify' || true)"
  if [[ -e "$APP" || -n "$(app_pids)" || -n "$agents" ]]; then
    step uninstall fail "left: app=$([[ -e $APP ]] && echo yes || echo no) procs=$(app_pids) launchagents=$agents"
  else
    step uninstall pass "app gone, no process, no launch agent"
  fi
  data=""; for d in "$PROFILE" "$LOGDIR" "$AGENTDESK_DIR"; do [[ -e "$d" ]] && data+="${d/#$HOME/~} ($(du -sh "$d" 2>/dev/null | cut -f1)) "; done
  step user-data-left info "${data:-none} (macOS apps keep user data after drag-to-Trash)"
fi
hdiutil detach "$MNT" -force -quiet 2>/dev/null

# ── verdict ───────────────────────────────────────────────────────────────
V=green; RC=0
[[ $UNMEASURED -eq 1 ]] && { V=unmeasured; RC=2; }
[[ $RED -eq 1 ]] && { V=red; RC=1; }
python3 -I - "$STEPS" "$OUT/mac-smoke.json" "$V" <<'PY'
import json, sys
steps = []
for line in open(sys.argv[1], encoding='utf-8'):
    name, status, detail = (line.rstrip('\n').split('\t') + ['', ''])[:3]
    steps.append({'step': name, 'status': status, 'detail': detail})
json.dump({'verdict': sys.argv[3], 'steps': steps}, open(sys.argv[2], 'w'), indent=2)
PY
echo "verdict: $V"
{
  echo "### macOS $(sw_vers -productVersion) $(uname -m) — $V"
  echo
  echo "| step | status | detail |"
  echo "|---|---|---|"
  while IFS=$'\t' read -r n s d; do echo "| $n | $s | ${d//|//} |"; done < "$STEPS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit $RC
