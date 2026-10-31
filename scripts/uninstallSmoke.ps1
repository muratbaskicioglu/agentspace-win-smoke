# Uninstall smoke test: can the AgentSpace installed by installSmoke.ps1 be removed
# silently, and does it leave anything behind (exe, uninstall key, process)?
#
# Measures three things, right after the install smoke on the same runner:
#   1) UNINSTALL KEY   - an entry under HKCU\...\Uninstall with DisplayName 'AgentSpace*',
#                        and its QuietUninstallString / UninstallString
#   2) SILENT UNINSTALL - the uninstaller runs with `/S`, exit code
#   3) NOTHING LEFT    - installed exe gone, uninstall key gone, no process running
#                        from the install folder (waits up to $WaitSec s)
#
# The NSIS uninstaller copies itself to %TEMP% and relaunches from there, so the
# first process exits at once and `WaitForExit` does not mean "done". The verdict
# is read from DISK and REGISTRY (polling); the exit code is informational only.
#
# SCOPE: throwaway GitHub-hosted runners only. Never run this on a real PC: it would
# uninstall a real AgentSpace installation with the same app id.
#
# EXIT: 0 = all three steps green | 1 = at least one step red | 2 = not measured
# (no uninstall key - run the install smoke first).
# Details: <OutDir>/uninstall-smoke.json + .log
param(
  [string]$OutDir = 'install-smoke',
  [int]$WaitSec = 120
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$OutFull = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$logPath = Join-Path $OutFull 'uninstall-smoke.log'
function Log([string]$m) { Write-Host $m; Add-Content -Path $logPath -Value $m -Encoding utf8 }

$result = [ordered]@{ verdict = 'unknown'; steps = [ordered]@{} }
$fails = New-Object System.Collections.Generic.List[string]
function Step([string]$name, [bool]$ok, $detail) {
  $result.steps[$name] = [ordered]@{ ok = $ok; detail = $detail }
  if (-not $ok) { $fails.Add($name) }
  Log ("{0} {1} - {2}" -f ($(if ($ok) { 'OK  ' } else { 'FAIL' })), $name, ($detail | ConvertTo-Json -Compress -Depth 4))
}
function Save-Result([int]$code) {
  $result.verdict = $(if ($code -eq 0) { 'green' } elseif ($code -eq 1) { 'red' } else { 'unmeasured' })
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutFull 'uninstall-smoke.json') -Encoding utf8
}
$UninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Get-AgentSpaceKey {
  Get-ChildItem $UninstallRoot -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'AgentSpace*' } |
    Select-Object -First 1
}
function Prop($o, [string]$n) { if ($o -and $o.PSObject.Properties[$n]) { return [string]$o.$n } return '' }
# '"C:\...\Uninstall AgentSpace.exe" /currentuser /S' -> exe path + arguments.
function Split-Command([string]$cmd) {
  $m = [regex]::Match($cmd.Trim(), '^"([^"]+)"\s*(.*)$')
  if ($m.Success) { return @($m.Groups[1].Value, $m.Groups[2].Value) }
  $m = [regex]::Match($cmd.Trim(), '^(\S+\.exe)\s*(.*)$')
  if ($m.Success) { return @($m.Groups[1].Value, $m.Groups[2].Value) }
  return @($null, '')
}

Log "> uninstall smoke - $(Get-Date -Format o)"

# -- 1) UNINSTALL KEY -----------------------------------------------------------
$key = Get-AgentSpaceKey
if (-not $key) {
  Log 'FAIL not measured: no AgentSpace entry under the HKCU uninstall key (did the install smoke run?)'
  Save-Result 2; exit 2
}
$installDir = Prop $key 'InstallLocation'
$quiet = Prop $key 'QuietUninstallString'
$plain = Prop $key 'UninstallString'
$cmd = $(if ($quiet) { $quiet } else { $plain })
$parts = Split-Command $cmd
$uninstExe = $parts[0]; $uninstArgs = $parts[1]
# Add the silent flag if missing (UninstallString has no /S).
if ($uninstArgs -notmatch '(^|\s)/S(\s|$)') { $uninstArgs = ($uninstArgs + ' /S').Trim() }
# The per-user installer leaves InstallLocation EMPTY. Without a folder the exe and
# process checks in step 3 look at nothing and pass vacuously, so fall back to the
# uninstaller's own folder (it sits next to the app exe).
$installDirSource = 'InstallLocation'
if (-not $installDir -and $uninstExe) { $installDir = Split-Path $uninstExe -Parent; $installDirSource = 'uninstaller folder' }
$appExes = @()
if ($installDir -and (Test-Path $installDir)) {
  $appExes = @(Get-ChildItem -Path $installDir -Filter 'AgentSpace*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'Uninstall*' } | ForEach-Object { $_.FullName })
}
# Positive control: the installed app exe must be found BEFORE uninstalling,
# otherwise "nothing left" in step 3 would prove nothing.
$keyOk = [bool]$uninstExe -and (Test-Path $uninstExe) -and ($appExes.Count -gt 0)
Step 'uninstall key' $keyOk ([ordered]@{
  display_name = Prop $key 'DisplayName'; display_version = Prop $key 'DisplayVersion'
  install_location = $installDir; install_location_source = $installDirSource; quiet_string_present = [bool]$quiet
  uninstaller = $uninstExe; args = $uninstArgs; app_exes = $appExes
})
if (-not $keyOk) { Save-Result 1; exit 1 }

# -- 2) SILENT UNINSTALL --------------------------------------------------------
$t0 = Get-Date
$up = Start-Process -FilePath $uninstExe -ArgumentList $uninstArgs -PassThru
$firstExited = $up.WaitForExit(60000)
Step 'uninstaller ran' $firstExited ([ordered]@{
  exit_code = $(if ($firstExited) { $up.ExitCode } else { $null })
  note = 'NSIS copies itself to %TEMP% and relaunches; the verdict is read from disk in step 3'
})

# -- 3) NOTHING LEFT (polling) --------------------------------------------------
$deadline = $t0.AddSeconds($WaitSec)
do {
  Start-Sleep -Seconds 2
  $keyLeft = [bool](Get-AgentSpaceKey)
  $exeLeft = @($appExes | Where-Object { Test-Path $_ })
  $procLeft = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $installDir -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)
  })
  $clean = (-not $keyLeft) -and ($exeLeft.Count -eq 0) -and ($procLeft.Count -eq 0)
} while (-not $clean -and (Get-Date) -lt $deadline)
$sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
$dirLeft = @()
if ($installDir -and (Test-Path $installDir)) {
  $dirLeft = @(Get-ChildItem -Path $installDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { $_.FullName })
}
Step 'nothing left' $clean ([ordered]@{
  seconds = $sec; uninstall_key_left = $keyLeft; app_exes_left = $exeLeft
  processes_left = @($procLeft | ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name } })
  install_dir_files_left = $dirLeft   # info only: the verdict comes from exe + key + processes
})

$code = $(if ($fails.Count) { 1 } else { 0 })
Save-Result $code
Log ''
if ($code -eq 0) { Log "========== UNINSTALL SMOKE: GREEN ($sec s) ==========" }
else { Log "========== UNINSTALL SMOKE: RED - $($fails -join ', ') ==========" }
exit $code
