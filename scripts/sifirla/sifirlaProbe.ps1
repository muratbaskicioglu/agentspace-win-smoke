# Reset-script probe (SIFIRLA-MOTOR-IKILI-01 / AS-4570). Ephemeral GitHub runner only.
# 1) install the REAL engines the way AgentSpace does: Antigravity (vendor install.ps1),
#    OpenCode with a system npm (default prefix %APPDATA%\npm) and with the app's own helper Node,
# 2) dry run of the new script (nothing may be deleted),
# 3) control arm: the previous script (agy + opencode must STILL be there = the bug),
# 4) the new script, then check: engines gone, protected folders still there.
param([string]$Out = 'sifirla')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force $Out | Out-Null
$ev = Join-Path (Resolve-Path $Out) 'evidence.txt'
function Yaz($s) { "$s" | Tee-Object -Append -FilePath $ev | Out-Host }
$script:fail = 0
function Kontrol($ad, [bool]$ok) { if ($ok) { Yaz "  OK    $ad" } else { Yaz "  FAIL  $ad"; $script:fail = 1 } }
function Mask($s) { "$s" -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%' }

$U = $env:USERPROFILE; $R = $env:APPDATA; $L = $env:LOCALAPPDATA
$dir = $PSScriptRoot
$os = Get-CimInstance Win32_OperatingSystem
Yaz "os: $($os.Caption) | version $($os.Version) | build $($os.BuildNumber)"
Yaz "powershell 5: $(powershell -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"

# ---------- 1) install ----------
Yaz ''
Yaz '== 1) install (real engines) =='
# Antigravity: the app's own win32 line, engineInstall.cjs → powershellInstaller(url)
powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex" 2>&1 | ForEach-Object { Mask $_ } | Out-File -Append (Join-Path $Out 'agy-install.txt')
$agy = Join-Path $L 'agy\bin\agy.exe'
Kontrol "agy installed: $(Mask $agy)" (Test-Path $agy)
if (Test-Path $agy) { Yaz "  agy --version: $(& $agy --version 2>&1 | Select-Object -First 1)" }

# OpenCode, system npm. The runner's npm prefix is C:\npm\prefix; a customer with the Node
# installer has %APPDATA%\npm, so the app's line `npm install -g opencode-ai@1.19.5` lands there.
Yaz "  runner npm prefix: $(npm config get prefix)  (NPM_CONFIG_PREFIX='$env:NPM_CONFIG_PREFIX')"
npm install -g --prefix "$R\npm" opencode-ai@1.19.5 --no-fund --no-audit --loglevel=error 2>&1 | Out-File -Append (Join-Path $Out 'opencode-npm.txt')
Kontrol 'opencode (system npm) in %APPDATA%\npm' ((Test-Path "$R\npm\opencode.cmd") -and (Test-Path "$R\npm\node_modules\opencode-ai"))
Yaz "  files: $((Get-ChildItem "$R\npm" -Filter 'opencode*' -Force | ForEach-Object Name) -join ', ')"
Yaz "  opencode --version: $(& "$R\npm\opencode.cmd" --version 2>&1 | Select-Object -First 1)"

# OpenCode, the app's helper Node (engineSetupHelper.cjs: <userData>\runtime\node, npm --prefix there)
$zip = Join-Path $env:RUNNER_TEMP 'node.zip'
Invoke-WebRequest 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' -OutFile $zip
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Kontrol "helper Node sha256 = app table ($sha)" ($sha -eq '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541')
$rt = Join-Path $R 'agentdesk-shell\runtime'
New-Item -ItemType Directory -Force $rt | Out-Null
Expand-Archive $zip -DestinationPath $rt
Rename-Item (Join-Path $rt 'node-v24.21.0-win-x64') 'node'
$root = Join-Path $rt 'node'
& "$root\node.exe" "$root\node_modules\npm\bin\npm-cli.js" install -g --prefix $root opencode-ai@1.19.5 --no-fund --no-audit --loglevel=error 2>&1 | Out-File -Append (Join-Path $Out 'opencode-helper.txt')
Kontrol 'opencode (helper Node) in <userData>\runtime\node' (Test-Path "$root\node_modules\opencode-ai")

# OpenCode's own folders (xdg under the home folder) appear after a first run
foreach ($a in '.local\share\opencode', '.local\state\opencode', '.config\opencode', '.cache\opencode') {
  Yaz "  $a exists after first run: $(Test-Path (Join-Path $U $a))"
}

# fake AgentSpace data + protected folders + another npm package
function Dosya($p) { New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null; Set-Content -LiteralPath $p 'x' }
$kalmali = @(
  (Join-Path $L 'Programs\AgentSpace\AgentSpace.exe'),
  (Join-Path $U 'AgentSpace-Kurtarma\yedek.json'),
  (Join-Path $R 'npm\node_modules\baska-paket\package.json'),
  (Join-Path $R 'npm\baska.cmd')
)
foreach ($p in $kalmali) { Dosya $p }
Dosya (Join-Path $U '.agentdesk\settings.json')
Dosya (Join-Path $R 'agentdesk-shell\Local State')

$gitmeli = @(
  (Join-Path $L 'agy'),
  (Join-Path $R 'npm\opencode'), (Join-Path $R 'npm\opencode.cmd'), (Join-Path $R 'npm\opencode.ps1'),
  (Join-Path $R 'npm\node_modules\opencode-ai'),
  $rt
) + @('.local\share\opencode', '.local\state\opencode', '.config\opencode', '.cache\opencode' | ForEach-Object { Join-Path $U $_ } | Where-Object { Test-Path $_ })

function Sifirla($betik, $onay, $log) {
  $env:AS_SIFIRLA_SECIM = '2'; $env:AS_SIFIRLA_ONAY = $onay; $env:AS_SIFIRLA_BEKLE = '0'
  cmd.exe /c "`"$betik`"" 2>&1 | ForEach-Object { Mask $_ } | Tee-Object -FilePath (Join-Path $Out $log) | Out-Host
  return $LASTEXITCODE
}

# ---------- 2) dry run, new script ----------
Yaz ''
Yaz '== 2) dry run: new script, choice 2, wrong confirmation =='
$rc = Sifirla (Join-Path $dir 'AgentSpace-Sifirla.cmd') 'HAYIR' 'kuru.txt'
$liste = Get-Content (Join-Path $Out 'kuru.txt') -Raw
Kontrol "dry run rc=$rc (0)" ($rc -eq 0)
Kontrol 'dry run lists agy' ($liste -match '\\agy\r?\n')
Kontrol 'dry run lists opencode-ai' ($liste -match 'opencode-ai')
foreach ($p in $gitmeli + $kalmali) { Kontrol "dry run left $(Mask $p)" (Test-Path $p) }

# ---------- 3) control arm: previous script ----------
Yaz ''
Yaz '== 3) control arm: previous script, choice 2 + SIFIRLA =='
$rc = Sifirla (Join-Path $dir 'AgentSpace-Sifirla-eski.cmd') 'SIFIRLA' 'eski.txt'
Yaz "  previous script rc=$rc"
$aKaldi = Test-Path (Join-Path $L 'agy\bin\agy.exe'); $oKaldi = Test-Path (Join-Path $R 'npm\node_modules\opencode-ai')
Yaz "  after previous script: agy.exe left=$aKaldi, npm opencode-ai left=$oKaldi"
Kontrol 'control arm reproduces the bug (agy and opencode left behind)' ($aKaldi -and $oKaldi)

# ---------- 4) new script ----------
Yaz ''
Yaz '== 4) new script, choice 2 + SIFIRLA =='
$rc = Sifirla (Join-Path $dir 'AgentSpace-Sifirla.cmd') 'SIFIRLA' 'yeni.txt'
Kontrol "new script rc=$rc (0)" ($rc -eq 0)
foreach ($p in $gitmeli) { Kontrol "gone: $(Mask $p)" (-not (Test-Path $p)) }
Kontrol "gone: $(Mask (Join-Path $L 'antigravity'))" (-not (Test-Path (Join-Path $L 'antigravity')))
foreach ($p in $kalmali) { Kontrol "still there: $(Mask $p)" (Test-Path $p) }
Kontrol 'still there: %APPDATA%\npm\node_modules' (Test-Path (Join-Path $R 'npm\node_modules'))

# what a NEW terminal would find on PATH (registry PATH, not this process's)
$yeniPath = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$bulunan = foreach ($d in ($yeniPath -split ';' | Where-Object { $_ })) {
  foreach ($n in 'agy.exe', 'opencode.cmd', 'opencode.exe', 'opencode') {
    $f = Join-Path ([Environment]::ExpandEnvironmentVariables($d)) $n
    if (Test-Path -LiteralPath $f -PathType Leaf) { $f }
  }
}
Kontrol "new terminal finds no agy/opencode on PATH ($(@($bulunan).Count) found)" (@($bulunan).Count -eq 0)
foreach ($f in $bulunan) { Yaz "    found: $(Mask $f)" }
$artik = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -match '\\agy\\bin' }
Yaz "  user PATH entries pointing at agy\bin (left by the vendor's 'agy install'): $(@($artik).Count)"

Yaz ''
Yaz "RESULT: $(if ($script:fail) { 'FAIL' } else { 'PASS' })"
exit $script:fail
