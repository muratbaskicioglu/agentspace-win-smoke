#!/bin/bash
# macOS bundle-seal check for a PUBLISHED AgentSpace release (seal.yml).
#
# Question: does the app write into its own bundle while it runs, and what does
# Gatekeeper do with the bundle afterwards?
#
#   install (dmg -> /Applications) -> seal 0 -> launch like a double-click -> walk every
#   page in the app window (scripts/sealNav.cjs) -> close -> seal 1 -> launch again ->
#   close -> seal 2 -> Gatekeeper reaction: launch with no quarantine flag, then with the
#   quarantine flag a browser download carries -> frames of every window that shows up.
#
# A "seal" is: codesign --verify --deep --strict, spctl --assess, files newer than
# the signature, the Next.js route-cache folder inside the bundle, and a full file list
# (diffed against seal 0).
#
# --expect broken : the release is known to write into its bundle (control arm);
#                   green when the seal IS broken after the walk.
# --expect intact : green when the bundle is byte-for-byte the same after the walk.
#
# ⛔ Runs ONLY on a throwaway GitHub-hosted runner (it installs into /Applications).
# Usage: bash scripts/macSeal.sh <AgentSpace-x.y.z-arch.dmg> <out dir> <broken|intact>
# Exit:  0 green · 1 red · 2 not measured
set -uo pipefail

DMG="${1:-}"; OUT="${2:-mac-seal}"; EXPECT="${3:-}"
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "refusing: this script only runs on a throwaway GitHub-hosted runner" >&2; exit 2
fi
[[ -f "$DMG" && ( "$EXPECT" == broken || "$EXPECT" == intact ) ]] || { echo "usage: macSeal.sh <dmg> <out dir> <broken|intact>" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/frames" "$OUT/seal" "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
STEPS="$OUT/steps.tsv"; : > "$STEPS"
APP=/Applications/AgentSpace.app
RC_DIR="$APP/Contents/Resources/standalone/.next/server/route-cache"
SIG="$APP/Contents/_CodeSignature/CodeResources"
MNT="$(mktemp -d /tmp/as-dmg.XXXXXX)"
CDP=9333
RED=0; UNMEASURED=0

step() { # step <name> <pass|fail|info|unmeasured> <detail>
  local d="${3//$'\t'/ }"; d="${d//$'\n'/ | }"
  printf '%s\t%s\t%s\n' "$1" "$2" "$d" >> "$STEPS"; echo "[$2] $1: $3"
  [[ "$2" == fail ]] && RED=1; [[ "$2" == unmeasured ]] && UNMEASURED=1; return 0
}

# ── window list (owner pid, window id, layer, size, owner) without screen-recording permission ──
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

frame() { # frame <file> <owner names or pids>: biggest on-screen window of that owner (any layer)
  local file="$1" who="$2" line id
  [[ -n "$WINLIST" ]] || { echo "no window lister"; return 1; }
  line="$("$WINLIST" | awk -F'\t' -v who="$who" '
    { split($4,s,"x"); a=s[1]*s[2]; n=split(who,ws," "); hit=0
      for(i=1;i<=n;i++) if ($1==ws[i] || $5==ws[i]) hit=1
      if (hit && a>best) { best=a; out=$2"\t"$4"\t"$5 } }
    END { if (out!="") print out }')"
  [[ -n "$line" ]] || { echo "no window"; return 1; }
  id="${line%%$'\t'*}"
  screencapture -x -o -l "$id" "$file" 2>/dev/null && [[ -s "$file" ]] && { echo "window $line"; return 0; }
  echo "screencapture failed"; return 1
}
windows_now() { [[ -n "$WINLIST" ]] && "$WINLIST" | awk -F'\t' '{print $5" "$4" (layer "$3")"}' | sort | uniq -c | tr -s ' ' | tr '\n' ';'; }
app_pids() { pgrep -f "^$APP/" 2>/dev/null | tr '\n' ' '; }
main_pid() { pgrep -f "^$APP/Contents/MacOS/[^/]*( |$)" 2>/dev/null | head -1; }

seal() { # seal <label>: codesign + spctl + newer-than-signature + route-cache + file list
  local l="$1" cs csrc gk gkrc newer rc added changed
  cs="$(codesign --verify --deep --strict -vvv "$APP" 2>&1)"; csrc=$?
  gk="$(spctl --assess --type execute -vv "$APP" 2>&1)"; gkrc=$?
  printf '%s\n' "$cs" > "$OUT/seal/$l.codesign.txt"; printf '%s\n' "$gk" > "$OUT/seal/$l.spctl.txt"
  newer="$(find "$APP" -type f -newer "$SIG" 2>/dev/null | wc -l | tr -d ' ')"
  rc=0; [[ -d "$RC_DIR" ]] && rc="$(find "$RC_DIR" -type f | wc -l | tr -d ' ')"
  ( cd "$APP" && find . -print0 | xargs -0 stat -f '%N	%z	%m	%HT' ) | LC_ALL=C sort > "$OUT/seal/$l.tree.tsv"
  if [[ -f "$OUT/seal/seal0.tree.tsv" && "$l" != seal0 ]]; then
    added="$(LC_ALL=C comm -13 <(cut -f1 "$OUT/seal/seal0.tree.tsv") <(cut -f1 "$OUT/seal/$l.tree.tsv") | tee "$OUT/seal/$l.added.txt" | wc -l | tr -d ' ')"
    changed="$(LC_ALL=C join -t $'\t' "$OUT/seal/seal0.tree.tsv" "$OUT/seal/$l.tree.tsv" | awk -F'\t' '$4=="Regular File" && ($2!=$5 || $3!=$6)' | tee "$OUT/seal/$l.changed.txt" | wc -l | tr -d ' ')"
  else added=-; changed=-; fi
  SEAL_CS=$csrc; SEAL_GK=$gkrc; SEAL_RC=$rc; SEAL_ADDED=$added
  step "$l" info "codesign rc=$csrc ($(printf '%s' "$cs" | grep -E 'sealed resource|valid on disk|satisfies|invalid|modified|added' | head -2 | tr '\n' ' ')) · spctl rc=$gkrc ($(printf '%s' "$gk" | head -2 | tr '\n' ' ')) · files newer than signature $newer · route-cache files $rc · vs seal0: added $added, changed files $changed"
}

close_app() { # close_app <label>: Cmd-Q as an Apple event, SIGTERM if it does not take
  local how="quit (Apple event)"
  osascript -e 'tell application id "com.muratify.agentspace" to quit' >/dev/null 2>&1 & local q=$!
  for _ in $(seq 1 15); do kill -0 "$q" 2>/dev/null || break; sleep 1; done
  kill "$q" 2>/dev/null; wait "$q" 2>/dev/null
  for _ in $(seq 1 15); do [[ -z "$(app_pids)" ]] && break; sleep 2; done
  if [[ -n "$(app_pids)" ]]; then local m; m="$(main_pid)"; [[ -n "$m" ]] && kill -TERM "$m"; how="SIGTERM"; for _ in $(seq 1 15); do [[ -z "$(app_pids)" ]] && break; sleep 2; done; fi
  if [[ -n "$(app_pids)" ]]; then for p in $(app_pids); do kill -KILL "$p" 2>/dev/null; done; step "$1" fail "still running after quit and SIGTERM (killed)"; else step "$1" pass "all app processes gone after $how"; fi
}

gk_log() { # gk_log <file>: what syspolicyd / CoreServicesUIAgent said about the app in the last 3 min
  log show --last 3m --style compact --predicate '(process == "syspolicyd" OR process == "CoreServicesUIAgent" OR process == "amfid" OR subsystem == "com.apple.syspolicy.exec") AND (eventMessage CONTAINS[c] "agentspace" OR eventMessage CONTAINS[c] "muratify")' > "$1" 2>&1 || true
  grep -c . "$1" 2>/dev/null || echo 0
}

launch_watch() { # launch_watch <label> <frame prefix>: open like a double-click, wait, record what shows up
  local l="$1" fp="$2" t0 win="" ui=""
  t0=$(date +%s); open "$APP" 2>"$OUT/logs/$l.open.txt"; local orc=$?
  for _ in $(seq 1 20); do
    sleep 2
    local p; p="$(app_pids)"
    [[ -n "$p" && -n "$WINLIST" ]] && win="$("$WINLIST" | awk -F'\t' -v ps="$p" '$3==0 { n=split(ps,a," "); for(i=1;i<=n;i++) if ($1==a[i]) { split($4,s,"x"); if (s[1]>300 && s[2]>300) print $2 } }' | head -1)"
    [[ -n "$WINLIST" ]] && ui="$("$WINLIST" | awk -F'\t' '$5=="CoreServicesUIAgent" {print $2}' | head -1)"
    [[ -n "$win" || -n "$ui" ]] && break
  done
  sleep 6
  local f1="" f2="" n
  [[ -n "$(app_pids)" ]] && f1="$(frame "$OUT/frames/$fp-app.png" "$(app_pids)")"; [[ -n "$f1" ]] && echo "frame: $f1"
  f2="$(frame "$OUT/frames/$fp-gatekeeper-dialog.png" "CoreServicesUIAgent")" || f2=""
  n="$(gk_log "$OUT/logs/$l.syspolicy.txt")"
  step "$l" info "open rc=$orc · app processes: $( [[ -n "$(app_pids)" ]] && echo up || echo none ) · app window: $( [[ -n "$win" ]] && echo yes || echo no ) · Gatekeeper dialog (CoreServicesUIAgent): $( [[ -n "$f2" ]] && echo "YES $f2" || echo no ) · syspolicy log lines $n · on screen: $(windows_now) · $(( $(date +%s) - t0 ))s"
  LW_APP=$( [[ -n "$win" ]] && echo yes || echo no ); LW_DIALOG=$( [[ -n "$f2" ]] && echo yes || echo no )
}

# ── 0. machine + install ─────────────────────────────────────────────────
step machine info "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)) $(uname -m) · $(spctl --status 2>&1 | tr "\n" " ")· SIP $(csrutil status 2>&1 | sed -n 1p)"
if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null; then step install unmeasured "hdiutil attach failed"; fi
SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -type d | head -1)"
if [[ -n "$SRC" ]] && ditto "$SRC" "$APP"; then
  step install pass "copied to $APP, version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"), xattr: $(xattr "$APP" | tr '\n' ' ')"
else step install unmeasured "no app in dmg or ditto failed"; fi
hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null
[[ -d "$APP" ]] || { step verdict unmeasured "not installed"; exit 2; }
BIN="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
SRV="$APP/Contents/Resources/standalone/.next/server"

# The walk needs a Node with global WebSocket (22+). The app's own binary in Node mode has it.
NODE=(node); v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( v < 22 )); then NODE=(env ELECTRON_RUN_AS_NODE=1 "$BIN"); fi

# ── 1. seal before anything ran ─────────────────────────────────────────
seal seal0; S0_CS=$SEAL_CS; S0_GK=$SEAL_GK
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$APP"
gk="$(spctl --assess --type execute -vv "$APP" 2>&1 | tr '\n' ' ')"; step gatekeeper-quarantined-before info "$gk"
xattr -dr com.apple.quarantine "$APP"

# ── 2. launch like a double-click, walk every page in the app window, close ──
open "$APP" --args "--remote-debugging-port=$CDP" 2>"$OUT/logs/launch1.open.txt"
up=""; for _ in $(seq 1 45); do sleep 2; curl -fsS "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && { up=1; break; }; done
if [[ -z "$up" ]]; then step launch1 unmeasured "devtools port $CDP not up in 90 s ($(app_pids))"
else
  step launch1 pass "app up, devtools port open"
  sleep 8
  f="$(frame "$OUT/frames/01-launch1-app.png" "$(app_pids)")"; step launch1-frame info "$f"
  w="$("${NODE[@]}" "$HERE/sealNav.cjs" --server "$SRV" --cdp "$CDP" --out "$OUT/walk1.json" --frames "$OUT/frames/walk1" 2>&1)"; wrc=$?
  [[ $wrc -eq 0 ]] && step walk1 pass "${w//$'\n'/ }" || step walk1 unmeasured "rc=$wrc ${w//$'\n'/ }"
  step walk1-route-cache info "route-cache files while the app runs: $( [[ -d "$RC_DIR" ]] && find "$RC_DIR" -type f | wc -l | tr -d ' ' || echo 0 )"
fi
close_app close1
seal seal1; S1_CS=$SEAL_CS; S1_RC=$SEAL_RC; S1_ADDED=$SEAL_ADDED

# ── 3. Gatekeeper reaction: daily relaunch (no quarantine flag) ──────────
launch_watch relaunch-no-quarantine 02-relaunch; R1_APP=$LW_APP; R1_DIALOG=$LW_DIALOG
close_app close2
seal seal2; S2_CS=$SEAL_CS; S2_RC=$SEAL_RC

# ── 4. Gatekeeper reaction: same bundle with the quarantine flag (as a browser download) ──
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$APP"
gk="$(spctl --assess --type execute -vv "$APP" 2>&1 | tr '\n' ' ')"; step gatekeeper-quarantined-after info "$gk"
launch_watch launch-quarantined 03-quarantined; R2_APP=$LW_APP; R2_DIALOG=$LW_DIALOG
close_app close3
pkill -x CoreServicesUIAgent 2>/dev/null || true
xattr -dr com.apple.quarantine "$APP"

# ── verdict ─────────────────────────────────────────────────────────────
if [[ $S0_CS -ne 0 || $S0_GK -ne 0 ]]; then step seal0-clean fail "the installed release was not clean before it ran (codesign rc=$S0_CS, spctl rc=$S0_GK)"
else step seal0-clean pass "codesign and spctl clean before the first launch"; fi
BROKEN=0; [[ $S1_CS -ne 0 || "$S1_RC" != 0 || ( "$S1_ADDED" != - && "$S1_ADDED" != 0 ) ]] && BROKEN=1
if [[ "$EXPECT" == broken ]]; then
  [[ $BROKEN -eq 1 ]] && step expectation pass "control arm: the walk broke the seal (codesign rc=$S1_CS, route-cache $S1_RC, added $S1_ADDED)" \
                      || step expectation fail "control arm: the seal is still clean after the walk, so this measurement cannot see the bug"
else
  [[ $BROKEN -eq 0 && $S2_CS -eq 0 && "$S2_RC" == 0 ]] && step expectation pass "seal clean after walk + close + relaunch (codesign rc=$S1_CS/$S2_CS, route-cache $S1_RC/$S2_RC, added $S1_ADDED)" \
                      || step expectation fail "seal broken (codesign rc=$S1_CS/$S2_CS, route-cache $S1_RC/$S2_RC, added $S1_ADDED)"
fi
step gatekeeper-reaction info "relaunch without quarantine: app window $R1_APP, dialog $R1_DIALOG · with quarantine: app window $R2_APP, dialog $R2_DIALOG"

V=green; RC=0
[[ $UNMEASURED -eq 1 ]] && { V=unmeasured; RC=2; }
[[ $RED -eq 1 ]] && { V=red; RC=1; }
python3 -I - "$STEPS" "$OUT/mac-seal.json" "$V" "$EXPECT" <<'PY'
import json, sys
steps = []
for line in open(sys.argv[1], encoding='utf-8'):
    name, status, detail = (line.rstrip('\n').split('\t') + ['', ''])[:3]
    steps.append({'step': name, 'status': status, 'detail': detail})
json.dump({'verdict': sys.argv[3], 'expect': sys.argv[4], 'steps': steps}, open(sys.argv[2], 'w'), indent=2)
PY
echo "verdict: $V"
{
  echo "### seal · macOS $(sw_vers -productVersion) $(uname -m) · expect $EXPECT — $V"
  echo
  echo "| step | status | detail |"
  echo "|---|---|---|"
  while IFS=$'\t' read -r n s d; do echo "| $n | $s | ${d//|//} |"; done < "$STEPS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit $RC
