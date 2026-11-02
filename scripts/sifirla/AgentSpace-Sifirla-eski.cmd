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
#   2) 1 + ürünün kurduğu motorlar ve girişleri: Claude Code, Codex, ürünün indirdiği Node,
#      .claude .codex .gemini, sağlayıcı anahtarları.
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

if (Acik) {
  Write-Host ''
  Write-Host '  AgentSpace şu an AÇIK. Önce uygulamayı kapat (sağ alttaki simgeden "Çık"), sonra bu dosyayı yeniden aç.'
  Write-Host '  Hiçbir şey silinmedi.'
  exit 2
}

Write-Host ''
Write-Host '  1) AgentSpace verisini sıfırla (önerilen — lisans hesabında kalır, yeniden giriş yaparsın)'
Write-Host '  2) 1 + motorları da kaldır (Claude Code, Codex, Node ve girişleri)'
Write-Host '  q) Vazgeç'
$secim = (Sor '  Seçim: ' 'AS_SIFIRLA_SECIM')
if ($null -ne $secim) { $secim = $secim.Trim() }
if ($secim -ne '1' -and $secim -ne '2') { Write-Host '  Vazgeçildi, hiçbir şey silinmedi.'; exit 0 }

$hedef = New-Object System.Collections.Generic.List[string]
function Ekle($p) { if ($p -and (Test-Path -LiteralPath $p)) { $hedef.Add($p) } }
foreach ($ad in 'agentdesk-shell', 'agentdesk-shell-dev') {
  $ud = Join-Path $R $ad
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
  Ekle (Join-Path $U '.claude')
  Ekle (Join-Path $U '.claude.json')
  Ekle (Join-Path $U '.codex')
  Ekle (Join-Path $U '.gemini')
  Ekle (Join-Path $U '.agentspace\keys.env')
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
Write-Host "  KALIR: kurulu uygulama ($(Join-Path $L 'Programs\AgentSpace'))."
$onay = Sor '  Onaylamak için SIFIRLA yaz: ' 'AS_SIFIRLA_ONAY'
if ((Normal $onay) -ne 'SIFIRLA') { Write-Host '  Vazgeçildi, hiçbir şey silinmedi.'; exit 0 }

# Onay ile silme arasında uygulama açıldıysa dur.
if (Acik) { Write-Host '  AgentSpace açıldı — durdum, hiçbir şey silinmedi.'; exit 2 }

$kokler = @($U, $R, $L) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') + '\' }
$korunan = (Join-Path $L 'Programs\AgentSpace').TrimEnd('\')
$hata = 0
foreach ($h in $hedef) {
  $tam = [IO.Path]::GetFullPath($h)
  $icinde = @($kokler | Where-Object { $tam.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
  if (-not $icinde -or $tam.StartsWith($korunan, [StringComparison]::OrdinalIgnoreCase)) { Write-Host "  ! korunan yer, atlandı: $tam"; $hata = 1; continue }
  try { Remove-Item -LiteralPath $tam -Recurse -Force -ErrorAction Stop }
  catch { Write-Host "  ! silinemedi: $tam ($($_.Exception.Message))"; $hata = 1 }
}

Write-Host ''
if ($hata -eq 0) { Write-Host "  Tamam. AgentSpace'i açınca kurulum ve tur baştan gelir; aynı hesapla giriş yap, lisans yerinde." }
else { Write-Host "  Bazı öğeler silinemedi (yukarıda). AgentSpace'in kapalı olduğundan emin olup yeniden dene." }
exit $hata
