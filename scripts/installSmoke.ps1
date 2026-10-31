# Install smoke test for the public AgentSpace Windows installer.
#
# Runs on a throwaway GitHub-hosted Windows runner and measures four things:
#   1) SILENT INSTALL  - `Setup.exe /S`, exit code, installed exe on disk
#   2) LAUNCH PROBE    - the app's own probe mode (AGENTDESK_APP_PROBE=1): the main
#                        process lived, the renderer drew (bodyLen > 0), app screenshot
#   3) REAL LAUNCH     - probe off, like a user: did the main window appear (title),
#                        desktop screenshot
#   4) CLOSE + 60 S    - WM_CLOSE to the window (same as clicking X) -> did the process
#                        exit -> 60 s later, is any AgentSpace / node / codex / opencode
#                        process left behind
#
# No account, no sign-in and no user data: a fresh install stops at the sign-in
# screen. Each launch uses its own temporary AGENTDESK_HOME and --user-data-dir.
#
# GUI-subsystem exes: PowerShell `&` does not wait for them and does not set
# $LASTEXITCODE, so every exe is started with `Start-Process -PassThru` and the
# exit code is read from `$p.ExitCode`.
#
# EXIT: 0 = all four steps green | 1 = at least one step red | 2 = not measured
# (no installer found, etc.). Details: <OutDir>/install-smoke.json + .log + screenshots.
param(
  [string]$Dist = 'smoke-input',
  [string]$OutDir = 'install-smoke',
  [int]$LaunchTimeoutSec = 120,
  [int]$CloseTimeoutSec = 30,
  [int]$LingerSec = 60
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$OutFull = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$logPath = Join-Path $OutFull 'install-smoke.log'
function Log([string]$m) { Write-Host $m; Add-Content -Path $logPath -Value $m -Encoding utf8 }

$result = [ordered]@{
  verdict = 'unknown'; steps = [ordered]@{}; installer = $null; installed_exe = $null
  version = $null; leftovers = @(); tree_before_close = @()
}
$fails = New-Object System.Collections.Generic.List[string]
function Step([string]$name, [bool]$ok, $detail) {
  $result.steps[$name] = [ordered]@{ ok = $ok; detail = $detail }
  if (-not $ok) { $fails.Add($name) }
  Log ("{0} {1} - {2}" -f ($(if ($ok) { 'OK  ' } else { 'FAIL' })), $name, ($detail | ConvertTo-Json -Compress -Depth 4))
}
function Save-Result([int]$code) {
  $result.verdict = $(if ($code -eq 0) { 'green' } elseif ($code -eq 1) { 'red' } else { 'unmeasured' })
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutFull 'install-smoke.json') -Encoding utf8
}

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SmokeW32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
function Save-Desktop([string]$name) {
  $vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vb.Width, $vb.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($vb.X, $vb.Y, 0, 0, $bmp.Size) } catch { Log "- screenshot failed: $($_.Exception.Message)" }
  $g.Dispose()
  $p = Join-Path $OutFull "$name.png"
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  # Share of non-black pixels: an all-black frame disproves "the window appeared".
  $nonBlack = 0; $total = 0
  for ($x = 0; $x -lt $bmp.Width; $x += [math]::Max(1, [int]($bmp.Width / 40))) {
    for ($y = 0; $y -lt $bmp.Height; $y += [math]::Max(1, [int]($bmp.Height / 40))) {
      $c = $bmp.GetPixel($x, $y); $total++
      if (($c.R + $c.G + $c.B) -gt 24) { $nonBlack++ }
    }
  }
  $bmp.Dispose()
  return [ordered]@{ path = $p; size = "$($vb.Width)x$($vb.Height)"; nonblack_ratio = [math]::Round($nonBlack / [math]::Max(1, $total), 3) }
}

# Watched process names: the app itself + engines/helpers it may spawn.
$WatchNames = '^(AgentSpace.*|node|codex.*|opencode.*|conpty_console_list_agent)\.exe$'
function Get-Procs { Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate }
function Get-Descendants([int]$rootPid, $all) {
  $set = @{ $rootPid = $true }; $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) { if ($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $true; $changed = $true } }
  }
  return $all | Where-Object { $set.ContainsKey([int]$_.ProcessId) }
}
function Short($p) {
  $cmd = [string]$p.CommandLine; if ($cmd.Length -gt 160) { $cmd = $cmd.Substring(0, 160) + '...' }
  [ordered]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; name = $p.Name; path = $p.ExecutablePath; cmd = $cmd }
}

# Isolated profile: a separate temporary AGENTDESK_HOME + Chromium profile per launch.
function New-Iso([string]$tag) {
  $root = Join-Path $env:RUNNER_TEMP ("smoke-$tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $home_ = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'home')).FullName
  $udd = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'udd')).FullName
  return [ordered]@{ root = $root; home = $home_; udd = $udd }
}
function Start-App([string]$exe, $iso, [hashtable]$extraEnv, [string]$tag) {
  $envBackup = @{}
  $vars = @{ AGENTDESK_HOME = $iso.home; AGENTDESK_DISABLE_RESTORE = '1'; AGENTDESK_DISABLE_AUTORESUME = '1' }
  foreach ($k in $extraEnv.Keys) { $vars[$k] = $extraEnv[$k] }
  foreach ($k in $vars.Keys) { $envBackup[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$($iso.udd)`"" -PassThru `
      -RedirectStandardOutput (Join-Path $OutFull "$tag.stdout.log") -RedirectStandardError (Join-Path $OutFull "$tag.stderr.log")
  } finally {
    foreach ($k in $envBackup.Keys) { [Environment]::SetEnvironmentVariable($k, $envBackup[$k]) }
  }
  return $p
}
function Copy-AppLogs($iso, [string]$tag, [datetime]$since) {
  # The app also writes its log under app.getPath('logs'), which may not be inside
  # --user-data-dir (on Windows: %APPDATA%\<name>\logs). Only *.log files inside a
  # 'logs' folder, written after this launch, are copied. Chromium storage files
  # (leveldb, Session Storage) also end in .log; they are profile data, not logs,
  # and must not reach the public artifact.
  $dst = (New-Item -ItemType Directory -Force -Path (Join-Path $OutFull "$tag-applogs")).FullName
  $roots = @($iso.root) + @(Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(agentdesk|AgentSpace)' } | ForEach-Object { $_.FullName })
  foreach ($r in $roots) {
    Get-ChildItem -Path $r -Recurse -File -Include *.log -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -eq 'logs' -and $_.LastWriteTime -ge $since } | Select-Object -First 40 |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $dst ($_.Directory.Name + '__' + $_.Name)) -ErrorAction SilentlyContinue }
  }
}
function Read-Out([string]$tag) {
  # stdout/stderr + the app logs collected by Copy-AppLogs (call that first).
  $txt = ''
  $files = @(Get-ChildItem -Path $OutFull -File -Filter "$tag.*.log" -ErrorAction SilentlyContinue) +
           @(Get-ChildItem -Path (Join-Path $OutFull "$tag-applogs") -File -ErrorAction SilentlyContinue)
  foreach ($f in $files) { $txt += (Get-Content -Raw -Path $f.FullName -ErrorAction SilentlyContinue) + "`n" }
  return $txt
}

Log "> install smoke - $(Get-Date -Format o)"

# -- 1) SILENT INSTALL --------------------------------------------------------
$setups = @(Get-ChildItem -Path $Dist -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue)
if ($setups.Count -ne 1) {
  Log "FAIL not measured: expected exactly 1 installer under $Dist, found: $($setups.Count)"
  Save-Result 2; exit 2
}
$setup = $setups[0].FullName
$result.installer = [ordered]@{ path = $setup; bytes = $setups[0].Length }
$t0 = Get-Date
$ip = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
if (-not $ip.WaitForExit(300000)) { Stop-Process -Id $ip.Id -Force -ErrorAction SilentlyContinue; Step 'install' $false @{ error = 'did not finish within 300 s' }; Save-Result 1; exit 1 }
$installSec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

# Installed exe: uninstall key (InstallLocation) first, else the per-user default root.
$exe = $null
$unKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'AgentSpace*' } | Select-Object -First 1
if ($unKey -and $unKey.PSObject.Properties['InstallLocation'] -and $unKey.InstallLocation) {
  $cand = Get-ChildItem -Path $unKey.InstallLocation -Filter 'AgentSpace*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  if ($cand) { $exe = $cand.FullName }
}
if (-not $exe) {
  $cand = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Depth 2 -Filter 'AgentSpace*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  if ($cand) { $exe = $cand.FullName }
}
$installDir = $(if ($exe) { Split-Path $exe -Parent } else { $null })
$result.installed_exe = $exe
if ($exe) { $result.version = (Get-Item $exe).VersionInfo.ProductVersion }
Step 'install' (($ip.ExitCode -eq 0) -and [bool]$exe) ([ordered]@{
  exit_code = $ip.ExitCode; seconds = $installSec; exe = $exe; version = $result.version
  uninstall_key = $(if ($unKey) { $unKey.DisplayName } else { $null })
})
if (-not $exe) { Save-Result 1; exit 1 }

# A silent install must not auto-start the app (a non-isolated copy would hold the
# single-instance lock and spoil the measurements below). If it did: record + stop.
Start-Sleep -Seconds 3
$auto = @(Get-Procs | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) })
if ($auto.Count) {
  Log "- process auto-started after install: $($auto.Count) - stopping it (measurement isolation)"
  $auto | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
$result.steps['install'].detail['autostarted_after_silent_install'] = $auto.Count

# -- 2) LAUNCH PROBE (the app's own proof) -------------------------------------
$isoA = New-Iso 'probe'
$probeShot = Join-Path $OutFull 'probe-window.png'
$probeAt = Get-Date
$pa = Start-App $exe $isoA @{ AGENTDESK_APP_PROBE = '1'; AGENTDESK_PROBE_WAIT = '4000'; AGENTDESK_PROBE_SHOT = $probeShot } 'probe'
$exited = $pa.WaitForExit($LaunchTimeoutSec * 1000)
if (-not $exited) { Get-Descendants $pa.Id (Get-Procs) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 2
Copy-AppLogs $isoA 'probe' $probeAt
$outA = Read-Out 'probe'
$probeLine = ([regex]::Match($outA, 'app-probe loaded:[^\r\n]*')).Value
$crash = ([regex]::Match($outA, '(Cannot find module|Uncaught Exception|A JavaScript error occurred)[^\r\n]*')).Value
$bodyLen = 0
$m = [regex]::Match($probeLine, 'bodyLen\\?"?:\s*(\d+)')
if ($m.Success) { $bodyLen = [int]$m.Groups[1].Value }
Step 'launch probe' ([bool]$probeLine -and $bodyLen -gt 0 -and -not $crash) ([ordered]@{
  exited_by_itself = $exited; exit_code = $(if ($exited) { $pa.ExitCode } else { $null })
  probe_line = $probeLine; body_len = $bodyLen; crash = $crash
  app_screenshot = $(if (Test-Path $probeShot) { (Get-Item $probeShot).Length } else { 0 })
  watchdog_timeout = ($outA -match 'app-probe watchdog timeout')
})

# -- 3) REAL LAUNCH (probe off, like a user) ------------------------------------
$isoB = New-Iso 'real'
$launchAt = Get-Date
$pb = Start-App $exe $isoB @{} 'real'
$title = ''; $handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($LaunchTimeoutSec)
while ((Get-Date) -lt $deadline -and -not $pb.HasExited) {
  Start-Sleep -Milliseconds 500
  $pb.Refresh()
  if ($pb.MainWindowHandle -ne [IntPtr]::Zero -and $pb.MainWindowTitle) { $handle = $pb.MainWindowHandle; $title = $pb.MainWindowTitle; break }
}
$windowSec = [math]::Round(((Get-Date) - $launchAt).TotalSeconds, 1)
$shot = $null
if ($handle -ne [IntPtr]::Zero) {
  # Let the renderer settle, bring the window to front, capture the desktop.
  Start-Sleep -Seconds 8
  [void][SmokeW32]::ShowWindow($handle, 3); [void][SmokeW32]::SetForegroundWindow($handle)
  Start-Sleep -Seconds 2
  $pb.Refresh(); $title = $pb.MainWindowTitle
  $shot = Save-Desktop 'real-window-desktop'
}
$treeBefore = @(Get-Descendants $pb.Id (Get-Procs))
$result.tree_before_close = @($treeBefore | ForEach-Object { Short $_ })
Step 'window opened' ($handle -ne [IntPtr]::Zero -and -not $pb.HasExited) ([ordered]@{
  title = $title; seconds_to_window = $windowSec; process_count = $treeBefore.Count
  died_early = $pb.HasExited; screenshot = $shot
})

# -- 4) CLOSE + LEFTOVER PROCESSES AFTER 60 S -----------------------------------
$closeOk = $false; $closeSec = $null; $closeCode = $null
if (-not $pb.HasExited) {
  $c0 = Get-Date
  $sent = $pb.CloseMainWindow()   # WM_CLOSE - same path as the user clicking X
  $closeOk = $pb.WaitForExit($CloseTimeoutSec * 1000)
  $closeSec = [math]::Round(((Get-Date) - $c0).TotalSeconds, 1)
  if ($closeOk) { $closeCode = $pb.ExitCode }
  Step 'close (WM_CLOSE)' $closeOk ([ordered]@{ close_message_sent = $sent; exited = $closeOk; seconds = $closeSec; exit_code = $closeCode })
} else {
  Step 'close (WM_CLOSE)' $false @{ error = 'process had already died before close' }
}
Log "- waiting $LingerSec s (leftover process check)..."
Start-Sleep -Seconds $LingerSec
# Windows reuses PIDs within seconds, so a PID alone does not identify a process:
# match on PID + creation time (a reused PID once matched TrustedInstaller.exe).
function ProcKey($p) { "{0}|{1}" -f $p.ProcessId, $(if ($p.CreationDate) { $p.CreationDate.Ticks } else { '' }) }
$treeKeys = @{}; foreach ($t in $treeBefore) { $treeKeys[(ProcKey $t)] = $true }
$after = @(Get-Procs | Where-Object {
  $treeKeys.ContainsKey((ProcKey $_)) -or
  ($installDir -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -match $WatchNames -and $_.CreationDate -and $_.CreationDate -ge $launchAt)
})
$result.leftovers = @($after | ForEach-Object { Short $_ })
Step "no leftover process (+$LingerSec s)" ($after.Count -eq 0) ([ordered]@{ leftover_count = $after.Count; leftovers = $result.leftovers })
# No desktop screenshot after close: with the app gone it only shows the runner's own
# console, which does not belong in a public artifact. The verdict is the process list.
Copy-AppLogs $isoB 'real' $launchAt

# Cleanup: whatever is left (evidence already saved) - only what this script started.
$after | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$code = $(if ($fails.Count) { 1 } else { 0 })
Save-Result $code
Log ''
if ($code -eq 0) { Log "========== INSTALL SMOKE: GREEN (version $($result.version)) ==========" }
else { Log "========== INSTALL SMOKE: RED - $($fails -join ', ') ==========" }
exit $code
