<# : batch portion
@echo off
setlocal
set "AS_SIFIRLA_DOSYA=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:AS_SIFIRLA_DOSYA, [Text.Encoding]::UTF8))"
set "RC=%ERRORLEVEL%"
if not "%AS_SIFIRLA_BEKLE%"=="0" pause
exit /b %RC%
#>
# AgentSpace-Sifirla (Windows) — HESAP-SIFIRLA-01. Çift tıkla. Üst kısım cmd, alt kısım PowerShell.
# Bu bilgisayardaki AgentSpace'i "ilk kez kurulmuş" hâline döndürür. Kurulu uygulama
# (%LOCALAPPDATA%\Programs\AgentSpace) KALIR.
#   1) AgentSpace verisi: ofis, ayarlar, ilk açılış/tur işaretleri, oturum + lisans belirteci,
#      tarayıcı önbelleği, güncelleme önbelleği, günlükler (Dev kopyası dahil).
#   2) 1 + ürünün kurduğu motorlar ve girişleri: Claude Code, Codex, Antigravity (agy),
#      OpenCode (npm), ürünün indirdiği Node, .claude .codex .gemini, sağlayıcı anahtarları.
# Yalnız aşağıda ADI GEÇEN yollar silinir (izin listesi). Kurulu uygulama ve ~\AgentSpace-Kurtarma
# korunur: listedeki bir yol bunlara değerse betik HİÇBİR ŞEY silmeden durur (çıkış 3).
# Sunucu tarafı (takım, görev, ilk açılış bayrağı) ayrı: scripts/hesap-sifirla/sunucu.mjs.
# Gözetimsiz koşum / test: AS_SIFIRLA_SECIM=1|2, AS_SIFIRLA_ONAY=SIFIRLA, AS_SIFIRLA_BEKLE=0,
# AS_SIFIRLA_SUREC_ADLARI=ad1,ad2 (varsayılan: AgentSpace,AgentSpace Dev).
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Stop'

function Sor($metin, $ortam) {
  $v = [Environment]::GetEnvironmentVariable($ortam)
  if ($v) { Write-Host "$metin$v"; return $v }
  return (Read-Host $metin.TrimEnd([char[]]': '))
}
function Normal($s) { if ($null -eq $s) { return '' }; return ($s.Trim() -replace 'ı', 'i' -replace 'İ', 'I').ToUpperInvariant() }

$adlar = 'AgentSpace', 'AgentSpace Dev'
if ($env:AS_SIFIRLA_SUREC_ADLARI) { $adlar = $env:AS_SIFIRLA_SUREC_ADLARI -split ',' }
function Acik { @(Get-Process -Name $adlar -ErrorAction SilentlyContinue).Count -gt 0 }

$U = $env:USERPROFILE; $R = $env:APPDATA; $L = $env:LOCALAPPDATA
Write-Host ''
Write-Host '  AgentSpace — bu bilgisayarı ilk kurulum hâline döndür'
Write-Host '  ---------------------------------------------------'

# Ev klasörü değişkenlerinden biri boşsa yollar göreli olur (betiğin klasörüne göre) — hiç başlama.
if (-not $U -or -not $R -or -not $L) { Write-Host '  ! USERPROFILE / APPDATA / LOCALAPPDATA boş — durdum, hiçbir şey silinmedi.'; exit 3 }

if (Acik) {
  Write-Host ''
  Write-Host '  AgentSpace şu an AÇIK. Önce uygulamayı kapat (sağ alttaki simgeden "Çık"), sonra bu dosyayı yeniden aç.'
  Write-Host '  Hiçbir şey silinmedi.'
  exit 2
}

Write-Host ''
Write-Host '  1) AgentSpace verisini sıfırla (önerilen — lisans hesabında kalır, yeniden giriş yaparsın)'
Write-Host '  2) 1 + motorları da kaldır (Claude Code, Codex, Antigravity, OpenCode, Node ve girişleri)'
Write-Host '  q) Vazgeç'
$secim = (Sor '  Seçim: ' 'AS_SIFIRLA_SECIM')
if ($null -ne $secim) { $secim = $secim.Trim() }
if ($secim -ne '1' -and $secim -ne '2') { Write-Host '  Vazgeçildi, hiçbir şey silinmedi.'; exit 0 }

# Yol biçimi: \ ve / tek ayraca, tam yola. Böylece betik macOS/Linux pwsh'ta da aynı kararı verir (test).
$S = [IO.Path]::DirectorySeparatorChar
function Tam($p) { return [IO.Path]::GetFullPath(($p -replace '[\\/]', $S)).TrimEnd($S) }

$hedef = New-Object System.Collections.Generic.List[string]
function Ekle($p) { if ($p) { $t = Tam $p; if (Test-Path -LiteralPath $t) { $hedef.Add($t) } } }
foreach ($ad in 'agentdesk-shell', 'agentdesk-shell-dev') {
  $ud = Tam (Join-Path $R $ad)
  if (Test-Path -LiteralPath $ud) {
    foreach ($c in Get-ChildItem -LiteralPath $ud -Force) {
      if ($c.Name -eq 'runtime' -and $secim -eq '1') { continue }
      $hedef.Add($c.FullName)
    }
  }
  Ekle (Join-Path $L "$ad-updater")
  Ekle (Join-Path $L $ad)
}
Ekle (Join-Path $U '.agentdesk')
Ekle (Join-Path $U '.agentdesk-dev')
if ($secim -eq '2') {
  Ekle (Join-Path $U '.local\bin\claude.exe')
  Ekle (Join-Path $U '.local\share\claude')
  Ekle (Join-Path $U '.local\state\claude')
  Ekle (Join-Path $L 'Programs\OpenAI\Codex')
  # Antigravity CLI — satıcının install.ps1'i: ikili %LOCALAPPDATA%\agy\bin, indirme ara klasörü
  # %LOCALAPPDATA%\antigravity\staging. Girişi ve durumu ~\.gemini altında (aşağıda).
  Ekle (Join-Path $L 'agy')
  Ekle (Join-Path $L 'antigravity\staging')
  # OpenCode — ürün Windows'ta `npm install -g opencode-ai@…` ile kurar → %APPDATA%\npm.
  # npm klasörünün KENDİSİ ve içindeki başka paketler kalır; yalnız opencode'un kendi dosyaları gider.
  foreach ($a in 'opencode', 'opencode.cmd', 'opencode.ps1', 'node_modules\opencode-ai') { Ekle (Join-Path $R "npm\$a") }
  foreach ($a in '.local\share\opencode', '.local\state\opencode', '.config\opencode', '.cache\opencode') { Ekle (Join-Path $U $a) }
  Ekle (Join-Path $U '.claude')
  Ekle (Join-Path $U '.claude.json')
  Ekle (Join-Path $U '.codex')
  Ekle (Join-Path $U '.gemini')
  Ekle (Join-Path $U '.agentspace\keys.env')
}

# KORUMA. Her hedef bir ev kökünün İÇİNDE olmalı (kökün kendisi olamaz).
#   $korunan: kendisi, içi ve onu içeren üst klasör silinemez.
#   $kap:     kendisi ve onu içeren üst klasör silinemez; içindeki adı geçen öğe silinebilir.
# Tek ihlalde HİÇBİR ŞEY silinmeden durulur (çıkış 3).
$kokler = @($U, $R, $L) | ForEach-Object { (Tam $_) + $S }
$korunan = @((Join-Path $L 'Programs\AgentSpace'), (Join-Path $U 'AgentSpace-Kurtarma')) | ForEach-Object { Tam $_ }
$kap = @((Join-Path $R 'npm'), (Join-Path $R 'npm\node_modules'), (Join-Path $U '.local'), (Join-Path $U '.config')) | ForEach-Object { Tam $_ }
$IC = [StringComparison]::OrdinalIgnoreCase
function Korunuyor($t) {
  if (@($kokler | Where-Object { $t.StartsWith($_, $IC) }).Count -eq 0) { return $true }
  foreach ($k in $korunan) { if ($t.Equals($k, $IC) -or $t.StartsWith($k + $S, $IC) -or $k.StartsWith($t + $S, $IC)) { return $true } }
  foreach ($k in $kap) { if ($t.Equals($k, $IC) -or $k.StartsWith($t + $S, $IC)) { return $true } }
  return $false
}
$ihlal = @($hedef | Where-Object { Korunuyor $_ })
if ($ihlal.Count -gt 0) {
  Write-Host ''
  foreach ($h in $ihlal) { Write-Host "  ! korunan yere değiyor: $h" }
  Write-Host '  Durdum, hiçbir şey silinmedi.'
  exit 3
}

Write-Host ''
if ($hedef.Count -eq 0) { Write-Host '  Silinecek bir şey yok — bu bilgisayar zaten ilk kurulum hâlinde.'; exit 0 }
Write-Host '  Silinecekler:'
foreach ($h in $hedef) {
  $b = 0
  try { $b = (Get-ChildItem -LiteralPath $h -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } catch {}
  if (-not $b) { try { $b = (Get-Item -LiteralPath $h -Force).Length } catch {} }
  $mb = '{0,8:N1} MB' -f ([double]$b / 1MB)
  Write-Host "  $mb  $h"
}
Write-Host ''
Write-Host '  KALIR (dokunulmaz):'
foreach ($k in $korunan) { Write-Host "              $k" }
$onay = Sor '  Onaylamak için SIFIRLA yaz: ' 'AS_SIFIRLA_ONAY'
if ((Normal $onay) -ne 'SIFIRLA') { Write-Host '  Vazgeçildi, hiçbir şey silinmedi.'; exit 0 }

# Onay ile silme arasında uygulama açıldıysa dur.
if (Acik) { Write-Host '  AgentSpace açıldı — durdum, hiçbir şey silinmedi.'; exit 2 }

$hata = 0
foreach ($h in $hedef) {
  if (Korunuyor $h) { Write-Host "  ! korunan yer, atlandı: $h"; $hata = 1; continue }
  try {
    $oge = Get-Item -LiteralPath $h -Force
    # Bağlantı (junction/symlink) ise YALNIZ bağlantının kendisi silinir; gösterdiği yere inilmez.
    if ($oge.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($oge.PSIsContainer) { [IO.Directory]::Delete($h, $false) } else { [IO.File]::Delete($h) }
    } else { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction Stop }
  }
  catch { Write-Host "  ! silinemedi: $h ($($_.Exception.Message))"; $hata = 1 }
}
# antigravity\staging gidince üst klasör boş kalır — yalnız BOŞSA kaldır.
$ag = Tam (Join-Path $L 'antigravity')
if ($secim -eq '2' -and (Test-Path -LiteralPath $ag) -and @(Get-ChildItem -LiteralPath $ag -Force).Count -eq 0) {
  try { [IO.Directory]::Delete($ag, $false) } catch {}
}

Write-Host ''
if ($hata -eq 0) { Write-Host "  Tamam. AgentSpace'i açınca kurulum ve tur baştan gelir; aynı hesapla giriş yap, lisans yerinde." }
else { Write-Host "  Bazı öğeler silinemedi (yukarıda). AgentSpace'in kapalı olduğundan emin olup yeniden dene." }
exit $hata
