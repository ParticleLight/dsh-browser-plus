param([string]$Out = 'F:\deepseekharness\dsh-browser-plus\.tmp\window.png', [long]$Hwnd = 0)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapFg {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static void Force(IntPtr h) {
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(me, fg, false);
  }
}
"@
[void][CapFg]::SetProcessDPIAware()
# An explicit handle wins: Electron can own several top-level windows and
# MainWindowHandle sometimes picks a helper instead of the browser window.
$h = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { 0 }
$p = $null
if ($Hwnd -eq 0) {
# Pick the LARGEST top-level window owned by an electron process with our title.
# MainWindowHandle is unreliable here: Electron owns several top-level windows and
# Windows happily reports a small helper, which silently screenshots the wrong thing.
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*dsh-browser-plus*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO WINDOW'; exit 1 }
$best = [IntPtr]::Zero
$bestArea = 0
foreach ($proc in $p) {
  foreach ($h in @($proc.MainWindowHandle)) {
    if ($h -eq [IntPtr]::Zero) { continue }
    $rect = New-Object CapFg+RECT
    if (-not [CapFg]::GetWindowRect($h, [ref]$rect)) { continue }
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
  }
}
if ($best -eq [IntPtr]::Zero) { Write-Output 'NO WINDOW'; exit 1 }
$h = $best
}
[void][CapFg]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 500
[CapFg]::Force($h)
[void][CapFg]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003 -bor 0x0040)
Start-Sleep -Milliseconds 1500
$r = New-Object CapFg+RECT
[void][CapFg]::GetWindowRect($h, [ref]$r)
$cw = $r.Right - $r.Left; $ch = $r.Bottom - $r.Top
$fg = [CapFg]::GetForegroundWindow()
Write-Output ("hwnd=" + $h + " fg=" + $fg + " same=" + ($fg -eq $h) + " rect=" + $cw + "x" + $ch)
$bmp = New-Object System.Drawing.Bitmap($cw, $ch)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
$dir = Split-Path $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[void][CapFg]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
# The foreground dance above can leave the window minimised (seen 2026-10-02: the
# capture reported 276x45 = the iconic rect and the user's browser stayed in the
# taskbar). Put it back the way we found it before we hand control back.
if ([CapFg]::IsIconic($h)) {
  [void][CapFg]::ShowWindow($h, 9)
  Start-Sleep -Milliseconds 500
}
Write-Output ("saved " + $Out + " iconicAfter=" + [CapFg]::IsIconic($h))
