# Windows half of the bundle-seal check (seal.yml) for a PUBLISHED AgentSpace release.
#
# Question: does the app write into its own install folder while it runs, and does it
# run cleanly from a READ-ONLY folder (a Program Files style install)?
#
#   install (Setup.exe /S, the normal per-user folder)
#   -> arm "emulated-fix": turn the Next.js disk cache off in the installed copy
#      (isrFlushToDisk true -> false, the same one-line change the fix makes; this repo
#      never holds unreleased builds, so the fix is emulated on the published build)
#   -> copy the install to C:\Program Files\AgentSpace (it keeps the Program Files ACL), deny
#      new files, new folders, overwrite and delete to Everyone (admins included), and PROVE
#      it: a test write, a new folder and an open-for-write of an existing file must be refused
#   A) per-user folder (writable, the real customer layout): launch -> walk every page in
#      the app window (scripts/sealNav.cjs) -> close -> diff the folder
#   B) read-only folder: launch with the Next.js cache debug log on -> walk -> close ->
#      search the output for write errors -> launch again like a user (no debug) -> walk ->
#      close -> search again -> diff the folder
#
# -Expect broken (arm "published", a release known to have the problem): it must show
# (files added in A, write errors in B with the debug log), otherwise the measurement
# cannot see it. -Expect intact, and always arm "emulated-fix": none of it may show.
#
# Each launch: its own temporary AGENTDESK_HOME and --user-data-dir. No account.
# EXIT: 0 green | 1 red | 2 not measured. Details: <OutDir>/win-seal.json + .log + frames.
param(
  [string]$Dist = 'seal-input',
  [string]$OutDir = 'win-seal',
  [ValidateSet('published', 'emulated-fix')][string]$Arm = 'published',
  # what the PUBLISHED release is known to do: 'broken' = writes into its install folder
  [ValidateSet('broken', 'intact')][string]$Expect = 'broken',
  [int]$Cdp = 9333,
  [int]$LaunchTimeoutSec = 120,
  [int]$CloseTimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  Write-Host 'refusing: this script only runs on a throwaway GitHub-hosted runner'; exit 2
}

$OutFull = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$logPath = Join-Path $OutFull 'win-seal.log'
function Log([string]$m) { Write-Host $m; Add-Content -Path $logPath -Value $m -Encoding utf8 }
$want = $(if ($Arm -eq 'emulated-fix') { 'intact' } else { $Expect })
$result = [ordered]@{ arm = $Arm; expect = $want; verdict = 'unknown'; version = $null; steps = [ordered]@{} }
$script:red = $false; $script:unmeasured = $false
function Step([string]$name, [string]$status, $detail) {
  # status: pass | fail | info | unmeasured
  $result.steps[$name] = [ordered]@{ status = $status; detail = $detail }
  if ($status -eq 'fail') { $script:red = $true }
  if ($status -eq 'unmeasured') { $script:unmeasured = $true }
  Log ("[{0}] {1} - {2}" -f $status, $name, ($detail | ConvertTo-Json -Compress -Depth 5))
}
function Finish {
  $code = 0; $v = 'green'
  if ($script:unmeasured) { $code = 2; $v = 'unmeasured' }
  if ($script:red) { $code = 1; $v = 'red' }
  $result.verdict = $v
  $result | ConvertTo-Json -Depth 7 | Set-Content -Path (Join-Path $OutFull 'win-seal.json') -Encoding utf8
  $lines = @("### seal - Windows $([System.Environment]::OSVersion.Version) - arm $Arm - expect $want - $v", '', '| step | status | detail |', '|---|---|---|')
  foreach ($k in $result.steps.Keys) {
    $d = ($result.steps[$k].detail | ConvertTo-Json -Compress -Depth 4) -replace '\|', '/'
    if ($d.Length -gt 600) { $d = $d.Substring(0, 600) + '...' }
    $lines += "| $k | $($result.steps[$k].status) | $d |"
  }
  if ($env:GITHUB_STEP_SUMMARY) { $lines | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY }
  Log "========== WIN SEAL ($Arm): $v =========="
  exit $code
}

function Get-Procs { Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate }
function Get-Descendants([int]$rootPid, $all) {
  $set = @{ $rootPid = $true }; $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) { if ($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $true; $changed = $true } }
  }
  return @($all | Where-Object { $set.ContainsKey([int]$_.ProcessId) })
}
function Get-Tree([string]$dir) {
  $t = @{}
  Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
    $t[$_.FullName.Substring($dir.Length)] = "$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
  }
  return $t
}
function Compare-Tree($before, $after) {
  $added = @($after.Keys | Where-Object { -not $before.ContainsKey($_) } | Sort-Object)
  $removed = @($before.Keys | Where-Object { -not $after.ContainsKey($_) } | Sort-Object)
  $changed = @($after.Keys | Where-Object { $before.ContainsKey($_) -and $before[$_] -ne $after[$_] } | Sort-Object)
  return [ordered]@{ added = $added.Count; removed = $removed.Count; changed = $changed.Count
    route_cache_added = @($added | Where-Object { $_ -like '*\route-cache\*' }).Count
    sample_added = @($added | Select-Object -First 8); sample_changed = @($changed | Select-Object -First 8) }
}
function Find-Exe([string]$dir) {
  $c = Get-ChildItem -LiteralPath $dir -Filter 'AgentSpace*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  if ($c) { return $c.FullName } else { return $null }
}

# Output search: what a failed write looks like in Node / Next.js / Chromium output.
$WriteErr = 'EPERM|EACCES|EROFS|EBUSY|access is denied|operation not permitted|permission denied|failed to promote build seed|Failed to update prerender cache'
function Get-AppLogFiles($iso) {
  # The app's own log files: inside this launch's temp root, and under %APPDATA% (the
  # app's log folder may live there whatever --user-data-dir says). Only *.log files in a
  # folder named 'logs': Chromium storage files (leveldb) also end in .log.
  $roots = @($iso.root) + @(Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(agentdesk|AgentSpace)' } | ForEach-Object { $_.FullName })
  $o = @{}
  foreach ($r in $roots) { Get-ChildItem -Path $r -Recurse -File -Include *.log -ErrorAction SilentlyContinue | Where-Object { $_.Directory.Name -eq 'logs' } | ForEach-Object { $o[$_.FullName] = $_.Length } }
  return $o
}
function Search-Out([string]$tag, $iso, $sizesBefore) {
  # stdout/stderr of this launch + only the part of each app log written during it
  # (a log shared by several launches must not count an earlier launch's lines).
  $texts = [ordered]@{}
  foreach ($f in @(Get-ChildItem -Path $OutFull -File -Filter "$tag.*.log" -ErrorAction SilentlyContinue)) { $texts[$f.Name] = [IO.File]::ReadAllText($f.FullName) }
  $dst = (New-Item -ItemType Directory -Force -Path (Join-Path $OutFull "$tag-applogs")).FullName
  $now = Get-AppLogFiles $iso
  foreach ($p in $now.Keys) {
    $from = 0; if ($sizesBefore.ContainsKey($p)) { $from = [long]$sizesBefore[$p] }
    if ($now[$p] -le $from) { continue }
    $bytes = [IO.File]::ReadAllBytes($p)
    $part = [Text.Encoding]::UTF8.GetString($bytes, [int]$from, $bytes.Length - [int]$from)
    $name = (Split-Path (Split-Path $p -Parent) -Leaf) + '__' + (Split-Path $p -Leaf)
    $texts[$name] = $part
    [IO.File]::WriteAllText((Join-Path $dst $name), $part)
  }
  $hits = New-Object System.Collections.Generic.List[string]; $total = 0
  foreach ($k in $texts.Keys) {
    $total += $texts[$k].Length
    foreach ($line in ($texts[$k] -split "`r?`n")) {
      if ($line -match $WriteErr) { $l = $line.Trim(); if ($l.Length -gt 220) { $l = $l.Substring(0, 220) + '...' }; $hits.Add("${k}: $l") }
    }
  }
  return [ordered]@{ sources = @($texts.Keys); chars = $total; write_errors = $hits.Count; sample = @($hits | Select-Object -First 10) }
}

# The walk needs a Node with global WebSocket (22+); the app's own exe in Node mode has it.
$nodeVer = 0
try { $nodeVer = [int](& node -p "process.versions.node.split('.')[0]" 2>$null) } catch { $nodeVer = 0 }

function Invoke-Run([string]$exe, [string]$tag, [hashtable]$extraEnv) {
  # launch with the devtools port -> wait for it -> walk -> close -> stop leftovers
  $root = Join-Path $env:RUNNER_TEMP ("seal-$tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $iso = [ordered]@{ root = $root; home = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'home')).FullName; udd = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'udd')).FullName }
  $vars = @{ AGENTDESK_HOME = $iso.home; AGENTDESK_DISABLE_RESTORE = '1'; AGENTDESK_DISABLE_AUTORESUME = '1' }
  foreach ($k in $extraEnv.Keys) { $vars[$k] = $extraEnv[$k] }
  $bak = @{}; foreach ($k in $vars.Keys) { $bak[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  $logSizes = Get-AppLogFiles $iso
  $p = $null; $startErr = $null
  try {
    $p = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=`"$($iso.udd)`"", "--remote-debugging-port=$Cdp") -PassThru `
      -RedirectStandardOutput (Join-Path $OutFull "$tag.stdout.log") -RedirectStandardError (Join-Path $OutFull "$tag.stderr.log")
  } catch {
    $e = $_.Exception; $startErr = "$($e.GetType().Name): $($e.Message)"
    if ($e.InnerException) { $startErr += " / $($e.InnerException.GetType().Name): $($e.InnerException.Message)" }
    if ($e.PSObject.Properties['NativeErrorCode']) { $startErr += " (win32 $($e.NativeErrorCode))" }
  } finally { foreach ($k in $bak.Keys) { [Environment]::SetEnvironmentVariable($k, $bak[$k]) } }
  $r = [ordered]@{ tag = $tag; up = $false; start_error = $startErr; walk = $null; walk_rc = $null; window_title = ''; closed_by_wm_close = $false; leftovers = 0 }
  if (-not $p) { $r.output = [ordered]@{ sources = @(); chars = 0; write_errors = 0; sample = @() }; return $r }
  $deadline = (Get-Date).AddSeconds($LaunchTimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Cdp/json/version" | Out-Null; $r.up = $true; break } catch { }
  }
  if ($r.up) {
    Start-Sleep -Seconds 6
    $walkOut = Join-Path $OutFull "$tag.walk.json"
    $nav = Join-Path $PSScriptRoot 'sealNav.cjs'
    $srv = Join-Path (Split-Path $exe -Parent) 'resources\standalone\.next\server'
    $args_ = @("`"$nav`"", '--server', "`"$srv`"", '--cdp', "$Cdp", '--out', "`"$walkOut`"", '--frames', "`"$(Join-Path $OutFull "frames-$tag")`"")
    $walker = $(if ($nodeVer -ge 22) { 'node' } else { $exe })
    if ($nodeVer -lt 22) { $env:ELECTRON_RUN_AS_NODE = '1' }
    try {
      $w = Start-Process -FilePath $walker -ArgumentList $args_ -NoNewWindow -PassThru -Wait -RedirectStandardOutput (Join-Path $OutFull "$tag.walk.stdout.txt") -RedirectStandardError (Join-Path $OutFull "$tag.walk.stderr.txt")
      $r.walk_rc = $w.ExitCode
    } catch { $r.walk_rc = "start failed: $($_.Exception.Message)" }
    finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    $r.walk = ((Get-Content -Raw (Join-Path $OutFull "$tag.walk.stdout.txt") -ErrorAction SilentlyContinue) + ' ' + (Get-Content -Raw (Join-Path $OutFull "$tag.walk.stderr.txt") -ErrorAction SilentlyContinue)).Trim()
  }
  $p.Refresh(); $r.window_title = $p.MainWindowTitle
  $tree = Get-Descendants $p.Id (Get-Procs)
  if (-not $p.HasExited) {
    [void]$p.CloseMainWindow()   # WM_CLOSE, same as clicking X
    $r.closed_by_wm_close = $p.WaitForExit($CloseTimeoutSec * 1000)
  }
  Start-Sleep -Seconds 5
  $left = @(Get-Procs | Where-Object { $pp = $_; @($tree | Where-Object { $_.ProcessId -eq $pp.ProcessId -and $_.CreationDate -eq $pp.CreationDate }).Count -gt 0 })
  $r.leftovers = $left.Count
  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $r.output = Search-Out $tag $iso $logSizes
  return $r
}

Log "> win seal ($Arm) - $(Get-Date -Format o)"
Step 'machine' 'info' "$((Get-CimInstance Win32_OperatingSystem).Caption) $([System.Environment]::OSVersion.Version) $env:PROCESSOR_ARCHITECTURE; node major $nodeVer"

# -- install --------------------------------------------------------------------
$setups = @(Get-ChildItem -Path $Dist -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue)
if ($setups.Count -ne 1) { Step 'install' 'unmeasured' "expected 1 installer under $Dist, found $($setups.Count)"; Finish }
$ip = Start-Process -FilePath $setups[0].FullName -ArgumentList '/S' -PassThru
if (-not $ip.WaitForExit(300000)) { Stop-Process -Id $ip.Id -Force -ErrorAction SilentlyContinue; Step 'install' 'unmeasured' 'installer did not finish in 300 s'; Finish }
$exeA = $null
$def = Join-Path $env:LOCALAPPDATA 'Programs\agentdesk-shell'
if (Test-Path $def) { $exeA = Find-Exe $def }
if (-not $exeA) { $c = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Depth 2 -Filter 'AgentSpace*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1; if ($c) { $exeA = $c.FullName } }
if (-not $exeA) { Step 'install' 'unmeasured' "installer exit $($ip.ExitCode), installed exe not found"; Finish }
$dirA = Split-Path $exeA -Parent
$result.version = (Get-Item $exeA).VersionInfo.ProductVersion
Start-Sleep -Seconds 3
@(Get-Procs | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dirA, [StringComparison]::OrdinalIgnoreCase) }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Step 'install' 'pass' ([ordered]@{ exit_code = $ip.ExitCode; dir = $dirA; version = $result.version; authenticode = [string](Get-AuthenticodeSignature $exeA).Status })

# -- the Next.js disk-cache flag in the installed copy ----------------------------
$flagFiles = @('resources\standalone\server.js', 'resources\standalone\.next\required-server-files.json')
$flag = [ordered]@{}
foreach ($rel in $flagFiles) {
  $f = Join-Path $dirA $rel
  if (-not (Test-Path -LiteralPath $f)) { Step 'flag' 'unmeasured' "missing $rel"; Finish }
  $txt = [IO.File]::ReadAllText($f)
  $on = [regex]::Matches($txt, '"isrFlushToDisk":\s*true').Count; $off = [regex]::Matches($txt, '"isrFlushToDisk":\s*false').Count
  $flag[$rel] = [ordered]@{ published_true = $on; published_false = $off; sha256_before = (Get-FileHash -LiteralPath $f).Hash.ToLower() }
  if ($Arm -eq 'emulated-fix') {
    if ($on -ne 1 -or $off -ne 0) { Step 'flag' 'unmeasured' ([ordered]@{ file = $rel; true = $on; false = $off; why = 'expected exactly one "isrFlushToDisk": true' }); Finish }
    $new = [regex]::Replace($txt, '("isrFlushToDisk":\s*)true', '${1}false')
    [IO.File]::WriteAllText($f, $new, (New-Object System.Text.UTF8Encoding $false))
    $flag[$rel].sha256_after = (Get-FileHash -LiteralPath $f).Hash.ToLower()
    $flag[$rel].after_false = [regex]::Matches([IO.File]::ReadAllText($f), '"isrFlushToDisk":\s*false').Count
  }
}
Step 'flag' 'info' $flag

# -- read-only copy (Program Files style) + proof that it is read-only -----------
$dirB = 'C:\Program Files\AgentSpace'
& robocopy $dirA $dirB /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Step 'read-only copy' 'unmeasured' "robocopy exit $LASTEXITCODE"; Finish }
$LASTEXITCODE = 0
# Run 1 used "/inheritance:r + Everyone RX + SYSTEM F" and Start-Process then failed with
# "Access is denied". Now the copy keeps the Program Files ACL it inherits (Users RX,
# Administrators/SYSTEM/TrustedInstaller F, app packages RX) and an inheritable DENY for
# Everyone blocks write data/add file (WD), append/add folder (AD), delete child (DC) and
# delete (DE). A deny beats the Administrators allow, so the elevated runner account is
# held to read+execute like a standard user. Only specific rights: the simple rights "W"
# and "D" both hold SYNCHRONIZE, which every open, folder listing and process start also
# asks for. Run 2 used "D" and the folder could not even be listed (exe not found).
$acl = & icacls $dirB /deny '*S-1-1-0:(OI)(CI)(WD,AD,DC,DE)' /C /Q 2>&1
$exeB = Find-Exe $dirB
$listErr = ''
if (-not $exeB) { try { $n = @(Get-ChildItem -LiteralPath $dirB -Force -ErrorAction Stop).Count; $listErr = "listed $n entries, no AgentSpace*.exe" } catch { $listErr = "list refused: $($_.Exception.GetType().Name): $($_.Exception.Message)" } }
$dirAcl = ((& icacls $dirB 2>&1) | Where-Object { "$_".Trim() } | ForEach-Object { "$_".Trim() }) -join ' | '
$probeDir = Join-Path $dirB 'resources\standalone\.next\server'
$denied = [ordered]@{}
$existing = Join-Path $dirB 'resources\standalone\server.js'
foreach ($t in @(@{ k = 'file'; p = (Join-Path $probeDir 'seal-write-probe.txt') }, @{ k = 'folder'; p = (Join-Path $probeDir 'route-cache-probe') }, @{ k = 'overwrite'; p = $existing })) {
  try {
    if ($t.k -eq 'file') { [IO.File]::WriteAllText($t.p, 'x') }
    elseif ($t.k -eq 'folder') { [IO.Directory]::CreateDirectory($t.p) | Out-Null }
    else { $fs = [IO.File]::Open($t.p, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $fs.Dispose() }  # opened for write, nothing written
    $denied[$t.k] = 'WRITE SUCCEEDED'
    if ($t.k -ne 'overwrite') { Remove-Item -LiteralPath $t.p -Recurse -Force -ErrorAction SilentlyContinue }
  } catch { $denied[$t.k] = "refused: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
# the exe must stay readable + startable: read it, ask Windows what the ACL is
$exeRead = 'no exe'
if ($exeB) { try { $fs = [IO.File]::OpenRead($exeB); $exeRead = "read ok ($($fs.Length) bytes)"; $fs.Dispose() } catch { $exeRead = "read refused: $($_.Exception.Message)" } }
# reads of a bundle file must still work (the refusals above must come from the deny, not a broken open)
$readExisting = $(try { "read ok ($([IO.File]::ReadAllBytes($existing).Length) bytes)" } catch { "read refused: $($_.Exception.Message)" })
$exeAcl = $(if ($exeB) { ((& icacls $exeB 2>&1) | Where-Object { "$_".Trim() } | ForEach-Object { "$_".Trim() }) -join ' | ' } else { '' })
$roOk = ($denied.file -like 'refused*') -and ($denied.folder -like 'refused*') -and ($denied.overwrite -like 'refused*') -and [bool]$exeB -and ($exeRead -like 'read ok*') -and ($readExisting -like 'read ok*')
Step 'read-only copy' $(if ($roOk) { 'pass' } else { 'unmeasured' }) ([ordered]@{ dir = $dirB; exe = $exeB; list_error = $listErr; icacls = (($acl | Select-Object -Last 1) -as [string]); dir_acl = $dirAcl; exe_acl = $exeAcl; exe_read = $exeRead; read_existing = $readExisting; test_write = $denied; whoami = (& whoami) })
if (-not $roOk) { Finish }

# -- A) per-user folder (writable) -----------------------------------------------
$t0 = Get-Tree $dirA
$a = Invoke-Run $exeA 'A-peruser' @{}
$dA = Compare-Tree $t0 (Get-Tree $dirA)
$a.tree = $dA
Step 'A walk (per-user folder)' $(if ($a.up -and $a.walk_rc -eq 0) { 'pass' } else { 'unmeasured' }) $a
if ($want -eq 'broken') {
  Step 'A expectation' $(if ($dA.route_cache_added -gt 0) { 'pass' } else { 'fail' }) "expect broken: route-cache files added by the walk: $($dA.route_cache_added) (must be > 0, otherwise the walk cannot trigger the bug); added $($dA.added), changed $($dA.changed)"
} else {
  Step 'A expectation' $(if ($dA.added -eq 0 -and $dA.changed -eq 0 -and $dA.removed -eq 0) { 'pass' } else { 'fail' }) "expect intact: install folder after the walk: added $($dA.added), changed $($dA.changed), removed $($dA.removed) (all must be 0)"
}

# -- B) read-only folder ---------------------------------------------------------
$t1 = Get-Tree $dirB
$b1 = Invoke-Run $exeB 'B1-readonly-debuglog' @{ NEXT_PRIVATE_DEBUG_CACHE = '1' }
Step 'B1 walk (read-only, cache debug log on)' $(if ($b1.up -and $b1.walk_rc -eq 0) { 'pass' } else { 'unmeasured' }) $b1
if (-not $b1.up) { Step 'B expectation' 'unmeasured' "the read-only copy did not come up: $($b1.start_error)"; Finish }
$b2 = Invoke-Run $exeB 'B2-readonly-user' @{}
Step 'B2 walk (read-only, like a user)' $(if ($b2.up -and $b2.walk_rc -eq 0) { 'pass' } else { 'unmeasured' }) $b2
$dB = Compare-Tree $t1 (Get-Tree $dirB)
Step 'B folder unchanged' $(if ($dB.added -eq 0 -and $dB.changed -eq 0 -and $dB.removed -eq 0) { 'pass' } else { 'fail' }) $dB
if ($want -eq 'broken') {
  Step 'B expectation' $(if ($b1.output.write_errors -gt 0) { 'pass' } else { 'unmeasured' }) "expect broken: write errors seen with the cache debug log: $($b1.output.write_errors) (must be > 0, otherwise the output search cannot see a failed write); like a user: $($b2.output.write_errors)"
} else {
  Step 'B expectation' $(if (-not $b2.up) { 'unmeasured' } elseif ($b1.output.write_errors -eq 0 -and $b2.output.write_errors -eq 0) { 'pass' } else { 'fail' }) "expect intact: write errors with the cache debug log: $($b1.output.write_errors), like a user: $($b2.output.write_errors) (both must be 0)"
}
Finish
