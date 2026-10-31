# Close-console check for the public AgentSpace Windows installer.
#
# Question: when AgentSpace closes on Windows, does a VISIBLE console window open
# (a black window with "ping" in it that closes by itself after a few seconds)?
#
# Measured with two independent sources on a throwaway GitHub-hosted Windows runner:
#   - window list: a watcher thread enumerates the top-level windows every 25 ms and
#     records every NEW visible window (class, title, owner process). Console windows
#     (ConsoleWindowClass / Windows Terminal) are counted; each one gets a capture of
#     ITS OWN content (PrintWindow, not the desktop).
#   - process creation audit (Security event 4688 with command line): which console
#     programs the app tree started (cmd.exe, PING.EXE, taskkill.exe, ...).
#
# Arms:
#   close-N             the published app, real launch, WM_CLOSE (same as clicking X).
#                       CONTROL: the published build is expected to show console windows.
#   probe cases         closeConsoleProbe.cjs, run by the installed app binary in Node
#                       mode with the app's own modules (see that file). "*-published"
#                       = shipped options (control), "*-fix" = the fix branch's options
#                       applied to the same call (this repo never holds unreleased builds).
#
# No account, no sign-in, no user data. Each launch has its own temporary
# AGENTDESK_HOME and --user-data-dir.
#
# EXIT: 0 = every fix arm opened 0 windows and every control showed the window |
#       1 = a fix arm opened a window, or the hung-process watchdog did not work |
#       2 = not measured (no installer, or a control showed no window, so a 0 means nothing).
param(
  [string]$Dist = 'cc-input',
  [string]$OutDir = 'close-console',
  [int]$Closes = 2,
  [int]$LaunchTimeoutSec = 120,
  [int]$CloseTimeoutSec = 30,
  [int]$AfterSec = 12
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$OutFull = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$logPath = Join-Path $OutFull 'close-console.log'
function Log([string]$m) { Write-Host $m; Add-Content -Path $logPath -Value $m -Encoding utf8 }

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class CcSeen {
  public long FirstMs; public long LastMs; public long Hwnd; public string Cls = ""; public string Title = "";
  public uint Pid; public string Proc = ""; public int X; public int Y; public int W; public int H;
  public bool Cloaked; public bool ConsoleLike; public int Shots; public string ShotFiles = "";
}

public static class CcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }

  static readonly object Gate = new object();
  static HashSet<long> baseline = new HashSet<long>();
  static Dictionary<long, CcSeen> seen = new Dictionary<long, CcSeen>();
  static Thread th; static volatile bool stopFlag; static Stopwatch sw;
  static string dir = ""; static string tag = ""; static int interval = 25;
  static EnumProc cb; static List<IntPtr> buf = new List<IntPtr>();
  public static int ShotBudget = 24;

  static bool OnWin(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) buf.Add(h); return true; }
  static List<IntPtr> Visible() { buf = new List<IntPtr>(); EnumWindows(cb, IntPtr.Zero); return buf; }

  public static int Start(string outDir, string prefix, int intervalMs) {
    cb = new EnumProc(OnWin);
    dir = outDir; tag = prefix; interval = intervalMs;
    lock (Gate) { seen = new Dictionary<long, CcSeen>(); }
    baseline = new HashSet<long>();
    foreach (IntPtr h in Visible()) baseline.Add(h.ToInt64());
    stopFlag = false; sw = Stopwatch.StartNew();
    th = new Thread(Loop); th.IsBackground = true; th.Start();
    return baseline.Count;
  }
  public static long ElapsedMs() { return sw == null ? 0 : sw.ElapsedMilliseconds; }
  public static CcSeen[] Stop() {
    stopFlag = true;
    if (th != null) th.Join(5000);
    lock (Gate) { return new List<CcSeen>(seen.Values).ToArray(); }
  }
  static void Loop() {
    while (!stopFlag) {
      try { Tick(); } catch { }
      Thread.Sleep(interval);
    }
  }
  static void Tick() {
    long now = sw.ElapsedMilliseconds;
    foreach (IntPtr h in Visible()) {
      long k = h.ToInt64();
      if (baseline.Contains(k)) continue;
      CcSeen s;
      lock (Gate) {
        if (!seen.TryGetValue(k, out s)) { s = Describe(h, now); seen[k] = s; }
        s.LastMs = now;
      }
      if (s.ConsoleLike && !s.Cloaked && ShotBudget > 0) {
        long age = now - s.FirstMs;
        if (s.Shots == 0 || (s.Shots == 1 && age >= 400)) {
          string f = Shot(h, s.Shots);
          s.Shots++;
          if (f != null) { ShotBudget--; s.ShotFiles += (s.ShotFiles.Length > 0 ? ";" : "") + f; }
        }
      }
    }
  }
  static CcSeen Describe(IntPtr h, long now) {
    CcSeen s = new CcSeen(); s.FirstMs = now; s.LastMs = now; s.Hwnd = h.ToInt64();
    StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); s.Cls = sb.ToString();
    sb = new StringBuilder(256); GetWindowText(h, sb, sb.Capacity); s.Title = sb.ToString();
    if (s.Title.Length > 120) s.Title = s.Title.Substring(0, 120);
    uint pid; GetWindowThreadProcessId(h, out pid); s.Pid = pid;
    try { s.Proc = Process.GetProcessById((int)pid).ProcessName; } catch { s.Proc = "?"; }
    RECT r; if (GetWindowRect(h, out r)) { s.X = r.L; s.Y = r.T; s.W = r.R - r.L; s.H = r.B - r.T; }
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    s.Cloaked = cloaked != 0;
    string p = (s.Proc ?? "").ToLowerInvariant();
    s.ConsoleLike = s.Cls == "ConsoleWindowClass" || s.Cls == "CASCADIA_HOSTING_WINDOW_CLASS" || s.Cls == "PseudoConsoleWindow"
      || p == "conhost" || p == "openconsole" || p == "windowsterminal" || p == "cmd" || p == "ping" || p == "taskkill";
    return s;
  }
  // The window's OWN content (PrintWindow), written as a 32-bit top-down BMP.
  static string Shot(IntPtr h, int n) {
    RECT r; if (!GetWindowRect(h, out r)) return null;
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0 || w > 4000 || hh > 4000) return null;
    IntPtr sdc = GetDC(IntPtr.Zero); IntPtr mdc = CreateCompatibleDC(sdc); IntPtr bmp = CreateCompatibleBitmap(sdc, w, hh);
    IntPtr old = SelectObject(mdc, bmp);
    try {
      bool ok = PrintWindow(h, mdc, 2);
      SelectObject(mdc, old);
      BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
      bi.biSize = 40; bi.biWidth = w; bi.biHeight = -hh; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
      byte[] px = new byte[w * hh * 4];
      int lines = GetDIBits(mdc, bmp, 0, (uint)hh, px, ref bi, 0);
      if (!ok || lines == 0) return null;
      for (int i = 3; i < px.Length; i += 4) px[i] = 255;
      string f = Path.Combine(dir, tag + "-win" + h.ToInt64().ToString("x") + "-" + n + ".bmp");
      using (FileStream fs = new FileStream(f, FileMode.Create))
      using (BinaryWriter bw = new BinaryWriter(fs)) {
        bw.Write((ushort)0x4D42); bw.Write((uint)(54 + px.Length)); bw.Write((uint)0); bw.Write((uint)54);
        bw.Write((uint)40); bw.Write(w); bw.Write(-hh); bw.Write((ushort)1); bw.Write((ushort)32);
        bw.Write((uint)0); bw.Write((uint)px.Length); bw.Write(2835); bw.Write(2835); bw.Write((uint)0); bw.Write((uint)0);
        bw.Write(px);
      }
      return Path.GetFileName(f);
    } finally { SelectObject(mdc, old); DeleteObject(bmp); DeleteDC(mdc); ReleaseDC(IntPtr.Zero, sdc); }
  }
}
'@

$result = [ordered]@{
  verdict = 'unknown'; runner = $env:RUNNER_NAME; os = $null; installer = $null; installed_exe = $null
  version = $null; audit = $null; arms = @()
}
try {
  $osv = Get-CimInstance Win32_OperatingSystem
  $result.os = [ordered]@{ caption = $osv.Caption; version = $osv.Version; build = $osv.BuildNumber; arch = $osv.OSArchitecture }
} catch { }
function Save-Result([int]$code) {
  $result.verdict = $(if ($code -eq 0) { 'green' } elseif ($code -eq 1) { 'red' } else { 'unmeasured' })
  $result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutFull 'close-console.json') -Encoding utf8
}

function Get-Procs { Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate }
function Get-Descendants([int]$rootPid, $all) {
  $set = @{ $rootPid = $true }; $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) { if ($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $true; $changed = $true } }
  }
  return $all | Where-Object { $set.ContainsKey([int]$_.ProcessId) }
}
function Redact([string]$c) {
  if (-not $c) { return '' }
  $c = [regex]::Replace($c, '[A-Za-z0-9+/=_-]{40,}', '<long>')
  if ($c.Length -gt 220) { $c = $c.Substring(0, 220) + '...' }
  return $c
}

# -- process creation audit (4688 + command line) -------------------------------
function Enable-Audit {
  $r = [ordered]@{ ok = $false; detail = '' }
  try {
    $o = & auditpol.exe /set '/subcategory:{0CCE922B-69AE-11D9-BED3-505054503030}' /success:enable 2>&1
    $code = $LASTEXITCODE
    $k = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name ProcessCreationIncludeCmdLine_Enabled -Value 1 -Type DWord
    $r.detail = ($o | Out-String).Trim()
    $r.ok = ($code -eq 0)
  } catch { $r.detail = $_.Exception.Message }
  return $r
}
function HexPid([string]$s) {
  if (-not $s) { return [int64]0 }
  try { return [Convert]::ToInt64(($s -replace '^0x', ''), 16) } catch { return [int64]0 }
}
function Get-Spawns([datetime]$since) {
  $list = New-Object System.Collections.Generic.List[object]
  $ev = @()
  try { $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688; StartTime = $since } -ErrorAction Stop | Sort-Object RecordId) } catch { }
  foreach ($e in $ev) {
    [xml]$x = $e.ToXml(); $d = @{}
    foreach ($n in $x.SelectNodes("//*[local-name()='Data']")) { $d[[string]$n.GetAttribute('Name')] = [string]$n.InnerText }
    $list.Add([pscustomobject]@{
      t = $e.TimeCreated; pid = (HexPid $d['NewProcessId']); ppid = (HexPid $d['ProcessId'])
      name = [string]$d['NewProcessName']; parent = [string]$d['ParentProcessName']; cmd = (Redact $d['CommandLine'])
    })
  }
  return , $list
}
# Spawns of the tree rooted at $rootPid, in creation order (a pid joins when its creator is in).
function Select-Tree($spawns, [int64]$rootPid, [datetime]$from) {
  $set = @{ $rootPid = $true }
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($s in $spawns) {
    if ($set.ContainsKey([int64]$s.ppid)) {
      $set[[int64]$s.pid] = $true
      if ($s.t -ge $from) {
        $out.Add([ordered]@{ t = $s.t.ToString('HH:mm:ss.fff'); pid = $s.pid; ppid = $s.ppid; name = (Split-Path $s.name -Leaf); cmd = $s.cmd })
      }
    }
  }
  return , $out
}

# -- window watcher wrappers --------------------------------------------------------
function Start-Watch([string]$tag) { return [CcWin]::Start($OutFull, $tag, 25) }
function Stop-Watch {
  $arr = [CcWin]::Stop()
  return @($arr | Sort-Object FirstMs | ForEach-Object {
    [ordered]@{
      first_ms = $_.FirstMs; visible_ms = ($_.LastMs - $_.FirstMs); class = $_.Cls; title = $_.Title
      pid = $_.Pid; process = $_.Proc; rect = "$($_.X),$($_.Y) $($_.W)x$($_.H)"; cloaked = $_.Cloaked
      console = $_.ConsoleLike; captures = $_.ShotFiles
    }
  })
}
# An empty window list must count as 0 (a `$null` piped into Where-Object runs once, and StrictMode
# then stops the script on the missing property), so callers wrap Stop-Watch in @() and these skip `$null.
function Count-Console($wins) { return @(@($wins) | Where-Object { $null -ne $_ -and $_.console -and -not $_.cloaked }).Count }
function Count-Visible($wins) { return @(@($wins) | Where-Object { $null -ne $_ -and -not $_.cloaked }).Count }

# Watchdog helpers still running that were created after $since (cmd / ping / taskkill
# whose command line is the watchdog's), so unrelated system processes do not count.
function Get-Leftovers([datetime]$since) {
  return @(Get-Procs | Where-Object {
    $_.Name -match '^(?i)(cmd|ping|taskkill)\.exe$' -and [string]$_.CommandLine -match '(?i)ping|taskkill' -and
    $_.CreationDate -and $_.CreationDate -ge $since
  } | ForEach-Object { [ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = (Redact $_.CommandLine) } })
}

function New-Iso([string]$tag) {
  $root = Join-Path $env:RUNNER_TEMP ("cc-$tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $home_ = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'home')).FullName
  $udd = (New-Item -ItemType Directory -Force -Path (Join-Path $root 'udd')).FullName
  return [ordered]@{ root = $root; home = $home_; udd = $udd }
}
function Start-WithEnv([string]$exe, [string]$argLine, [hashtable]$vars, [string]$tag) {
  # Redirected stdout/stderr: like a Start-menu launch, the GUI-subsystem app gets NO console.
  $envBackup = @{}
  foreach ($k in $vars.Keys) { $envBackup[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru `
      -RedirectStandardOutput (Join-Path $OutFull "$tag.stdout.log") -RedirectStandardError (Join-Path $OutFull "$tag.stderr.log")
  } finally {
    foreach ($k in $envBackup.Keys) { [Environment]::SetEnvironmentVariable($k, $envBackup[$k]) }
  }
  return $p
}
function Copy-AppLogs($iso, [string]$tag, [datetime]$since) {
  # Only *.log files inside a 'logs' folder, written after this launch (Chromium storage
  # files also end in .log; they are profile data and must not reach the public artifact).
  $dst = (New-Item -ItemType Directory -Force -Path (Join-Path $OutFull "$tag-applogs")).FullName
  $roots = @($iso.root) + @(Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(agentdesk|AgentSpace)' } | ForEach-Object { $_.FullName })
  foreach ($r in $roots) {
    Get-ChildItem -Path $r -Recurse -File -Include *.log -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -eq 'logs' -and $_.LastWriteTime -ge $since } | Select-Object -First 40 |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $dst ($_.Directory.Name + '__' + $_.Name)) -ErrorAction SilentlyContinue }
  }
}

Log "> close-console check - $(Get-Date -Format o)"
if ($result.os) { Log "- os: $($result.os.caption) $($result.os.version) ($($result.os.arch))" }

# -- install --------------------------------------------------------------------------
$setups = @(Get-ChildItem -Path $Dist -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue)
if ($setups.Count -ne 1) { Log "not measured: expected exactly 1 installer under $Dist, found $($setups.Count)"; Save-Result 2; exit 2 }
$result.installer = [ordered]@{ name = $setups[0].Name; bytes = $setups[0].Length }
$ip = Start-Process -FilePath $setups[0].FullName -ArgumentList '/S' -PassThru
if (-not $ip.WaitForExit(300000)) { Log 'not measured: installer did not finish in 300 s'; Save-Result 2; exit 2 }
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
if (-not $exe) { Log 'not measured: installed exe not found'; Save-Result 2; exit 2 }
$installDir = Split-Path $exe -Parent
$asar = Join-Path $installDir 'resources\app.asar'
$result.installed_exe = $exe
$result.version = (Get-Item $exe).VersionInfo.ProductVersion
Log "- installed $($result.version): $exe (installer exit $($ip.ExitCode))"
Start-Sleep -Seconds 3
@(Get-Procs | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }) |
  ForEach-Object { Log "- auto-started after install, stopped for isolation: $($_.Name)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$result.audit = Enable-Audit
Log "- process creation audit: ok=$($result.audit.ok) $($result.audit.detail)"
$fails = New-Object System.Collections.Generic.List[string]
$unmeasured = New-Object System.Collections.Generic.List[string]

function Add-Arm($arm) {
  $result.arms += $arm
  $mark = $(if ($arm.ok) { 'OK  ' } else { 'FAIL' })
  Log ("{0} {1} [{2}] console_windows={3} new_visible={4} spawns={5} {6}" -f $mark, $arm.name, $arm.kind, $arm.console_windows, $arm.new_visible_windows,
    (($arm.spawns | ForEach-Object { $_.name }) -join ','), $arm.note)
  foreach ($w in $arm.windows) { Log ("      +{0} ms {1} ms visible  {2}  '{3}'  {4}  {5}" -f $w.first_ms, $w.visible_ms, $w.class, $w.title, $w.process, $w.rect) }
  if ($arm.Contains('launch')) {
    Log ("      launch: console_windows={0}" -f $arm.launch.console_windows)
    foreach ($o in @($arm.launch.owners)) {
      if ($null -eq $o) { continue }
      $by = $(if ($o.created_by) { "{0} (pid {1}) '{2}'" -f $o.created_by.parent, $o.created_by.ppid, $o.created_by.cmd } else { 'no 4688 event' })
      Log ("      launch window '{0}' {1} pid {2}: started by {3}; in app tree: {4}" -f $o.title, $o.process, $o.window_pid, $by, $o.in_app_tree)
    }
  }
  if (-not $arm.ok) { if ($arm.kind -eq 'control') { $unmeasured.Add($arm.name) } else { $fails.Add($arm.name) } }
}

# -- arm 1: the published app, real launch + WM_CLOSE (control) ------------------------
for ($i = 1; $i -le $Closes; $i++) {
  $tag = "close-$i"
  $iso = New-Iso $tag
  $launchAt = Get-Date
  [void](Start-Watch "launch-$i")
  $pb = Start-WithEnv $exe "--user-data-dir=`"$($iso.udd)`"" @{ AGENTDESK_HOME = $iso.home; AGENTDESK_DISABLE_RESTORE = '1'; AGENTDESK_DISABLE_AUTORESUME = '1' } $tag
  $handle = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds($LaunchTimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $pb.HasExited) {
    Start-Sleep -Milliseconds 500; $pb.Refresh()
    if ($pb.MainWindowHandle -ne [IntPtr]::Zero -and $pb.MainWindowTitle) { $handle = $pb.MainWindowHandle; break }
  }
  Start-Sleep -Seconds 10   # let the app finish starting (server, renderer, probes)
  $launchWins = @(Stop-Watch)
  if ($handle -eq [IntPtr]::Zero -or $pb.HasExited) {
    Add-Arm ([ordered]@{ name = $tag; kind = 'control'; ok = $false; console_windows = 0; new_visible_windows = 0; windows = @(); spawns = @(); note = 'main window did not appear; close not measured' })
    Get-Descendants $pb.Id (Get-Procs) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    continue
  }
  $treeBefore = @(Get-Descendants $pb.Id (Get-Procs))
  [void](Start-Watch $tag)
  $c0 = Get-Date
  [void]$pb.CloseMainWindow()          # WM_CLOSE - same path as the user clicking X
  $exited = $pb.WaitForExit($CloseTimeoutSec * 1000)
  $closeSec = [math]::Round(((Get-Date) - $c0).TotalSeconds, 1)
  Start-Sleep -Seconds 1
  $early = @(Get-Leftovers $c0)
  Start-Sleep -Seconds $AfterSec
  $wins = @(Stop-Watch)
  $late = @(Get-Leftovers $c0)
  $spawnsAll = Get-Spawns $launchAt
  $atClose = Select-Tree $spawnsAll ([int64]$pb.Id) $c0
  $atLaunch = Select-Tree $spawnsAll ([int64]$pb.Id) $launchAt
  $cw = Count-Console $wins
  $ping = @($wins | Where-Object { $_.process -match '^(?i)ping$' -or $_.title -match '(?i)ping' }).Count
  # Who started each console window seen during launch: its process creation event (4688)
  # and whether that process belongs to the app's own process tree.
  $launchOwners = @(@($launchWins) | Where-Object { $null -ne $_ -and $_.console } | ForEach-Object {
    $w = $_
    $sp = @($spawnsAll | Where-Object { $_.pid -eq [int64]$w.pid } | Select-Object -Last 1)
    [ordered]@{
      window_pid = $w.pid; process = $w.process; title = $w.title
      created_by = $(if ($sp.Count) { [ordered]@{ ppid = $sp[0].ppid; parent = (Split-Path $sp[0].parent -Leaf); cmd = $sp[0].cmd } } else { $null })
      in_app_tree = (@($atLaunch | Where-Object { $_.pid -eq [int64]$w.pid }).Count -gt 0)
    }
  })
  Add-Arm ([ordered]@{
    name = $tag; kind = 'control'; ok = ($cw -ge 1); console_windows = $cw; new_visible_windows = (Count-Visible $wins)
    ping_windows = $ping; windows = $wins; spawns = $atClose
    close = [ordered]@{ exited = $exited; seconds = $closeSec; exit_code = $(if ($exited) { $pb.ExitCode } else { $null }) }
    leftovers_plus_1s = $early; leftovers_end = $late
    launch = [ordered]@{ console_windows = (Count-Console $launchWins); windows = @($launchWins | Where-Object { $_.console }); owners = $launchOwners; console_spawns = @($atLaunch | Where-Object { $_.t -lt $c0.ToString('HH:mm:ss.fff') -and $_.name -match '^(?i)(cmd|ping|taskkill|where|reg|wmic|powershell|pwsh|tasklist|conhost|wsl|bash|sh|git)\.exe$' }) }
    note = "published build: a console window is expected here (close took $closeSec s)"
  })
  Copy-AppLogs $iso $tag $launchAt
  @($treeBefore) + @(Get-Procs | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) }) |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# -- arm 2: probe cases with the installed app's own modules ---------------------------
$probe = Join-Path $PSScriptRoot 'closeConsoleProbe.cjs'
$cases = [ordered]@{
  'watchdog-published' = 'control'; 'watchdog-fix' = 'fix'; 'watchdog-fix-hang' = 'fix'
  'taskkill-published' = 'control'; 'taskkill-fix' = 'fix'
  'cli-published' = 'control'; 'cli-fix' = 'fix'
}
foreach ($case in $cases.Keys) {
  $kind = $cases[$case]
  $json = Join-Path $OutFull "probe-$case.json"
  [void](Start-Watch "probe-$case")
  $t0 = Get-Date
  $pp = Start-WithEnv $exe "`"$probe`" --app `"$asar`" --case $case --out `"$json`"" @{ ELECTRON_RUN_AS_NODE = '1' } "probe-$case"
  $done = $pp.WaitForExit(40000)
  $exitAt = Get-Date
  Start-Sleep -Seconds 1
  $early = @(Get-Leftovers $t0)
  Start-Sleep -Seconds $AfterSec
  $wins = @(Stop-Watch)
  $late = @(Get-Leftovers $t0)
  $spawns = Select-Tree (Get-Spawns $t0) ([int64]$pp.Id) $t0
  $pj = $null; if (Test-Path $json) { $pj = Get-Content -Raw $json | ConvertFrom-Json }
  $cw = Count-Console $wins; $nv = Count-Visible $wins
  $arm = [ordered]@{
    name = $case; kind = $kind; console_windows = $cw; new_visible_windows = $nv; windows = $wins; spawns = $spawns
    probe_exit = $(if ($done) { $pp.ExitCode } else { 'still running after 40 s' }); probe = $pj
    leftovers_plus_1s = $early; leftovers_end = $late; note = ''
  }
  if ($kind -eq 'control') {
    $arm.ok = ($cw -ge 1)
    $arm.note = $(if ($arm.ok) { 'shipped options: console window seen (control holds)' } else { 'shipped options showed NO window: the check cannot see the defect here' })
  } else {
    $arm.ok = ($done -and $cw -eq 0 -and $nv -eq 0)
    if ($case -eq 'watchdog-fix-hang') {
      $killedAfter = $null
      if ($pj -and $pj.PSObject.Properties['armed_at'] -and $done) { $killedAfter = [math]::Round(($pp.ExitTime.ToUniversalTime() - ([datetime]$pj.armed_at).ToUniversalTime()).TotalSeconds, 1) }
      $arm.killed_after_s = $killedAfter
      $arm.ok = $arm.ok -and ($pp.ExitCode -ne 3) -and ($pp.ExitCode -ne 0) -and ($null -ne $killedAfter) -and ($killedAfter -ge 4) -and ($killedAfter -le 15)
      $arm.note = "hung main thread; the watchdog must end it after ~6 s (ended after $killedAfter s, exit $($arm.probe_exit))"
    } elseif ($case -eq 'watchdog-fix') {
      $arm.ok = $arm.ok -and (@($late).Count -eq 0)
      $arm.note = 'fix options: 0 windows, nothing left after the probe exits'
    } else { $arm.note = 'fix options: 0 windows' }
  }
  Add-Arm $arm
  Get-Procs | Where-Object { $_.CreationDate -and $_.CreationDate -ge $t0 -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Captures: BMP -> PNG (window content only).
Get-ChildItem -Path $OutFull -Filter '*.bmp' -File -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $b = [System.Drawing.Bitmap]::new($_.FullName)
    $b.Save(($_.FullName -replace '\.bmp$', '.png'), [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
    Remove-Item $_.FullName
  } catch { Log "- capture convert failed: $($_.Name)" }
}

$code = $(if ($fails.Count) { 1 } elseif ($unmeasured.Count) { 2 } else { 0 })
Save-Result $code
if ($env:GITHUB_STEP_SUMMARY) {
  $osText = $(if ($result.os) { "$($result.os.caption) $($result.os.version)" } else { 'Windows' })
  $s = @("### close console - $osText - AgentSpace $($result.version)", '',
    '| arm | kind | console windows | new visible windows | console programs started (4688) | note |', '|---|---|---|---|---|---|')
  foreach ($a in $result.arms) {
    $names = (($a.spawns | ForEach-Object { $_.name }) | Select-Object -Unique) -join ', '
    $s += "| $($a.name) | $($a.kind) | $($a.console_windows) | $($a.new_visible_windows) | $names | $($a.note) |"
  }
  $s += ''; $s += "verdict: **$($result.verdict)**"
  $s -join "`n" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
Log ''
if ($code -eq 0) { Log '========== CLOSE CONSOLE: GREEN (fix arms 0 windows, controls show the window) ==========' }
elseif ($code -eq 1) { Log "========== CLOSE CONSOLE: RED - $($fails -join ', ') ==========" }
else { Log "========== CLOSE CONSOLE: UNMEASURED - control without a window: $($unmeasured -join ', ') ==========" }
exit $code
