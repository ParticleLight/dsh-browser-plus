<#
.SYNOPSIS
  Capture the self-hosted browser window as a PNG, for visual verification.

.DESCRIPTION
  The plugin's chrome is injected into the page, so browser_screenshot (CDP
  Page.captureScreenshot) shows it -- but the OS window around it, the tab strip
  at real size and anything that is only visible in the window cannot be checked
  that way. This script grabs the real window.

  Three things were learned the hard way and are baked in:
    * SetProcessDPIAware() -- without it GetWindowRect/CopyFromScreen work in
      DIP, and a 150%/175% display yields a cropped capture that looks like a
      layout bug.
    * The window title changes with the task label ("dsh-browser-plus -- X"), so
      the match is a wildcard.
    * The window must be raised, or CopyFromScreen returns whatever is on top of
      it (measured: a QQ window). HWND_TOPMOST is used and then released.
  A minimised window is restored first: while minimised it reports a 0x0 content
  size, which is what makes CDP screenshots time out.
#>
param([string]$Out = 'F:\deepseekharness\dsh-browser-plus\.tmp\window.png', [switch]$NoRestore)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap8 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][Cap8]::SetProcessDPIAware()
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*dsh-browser-plus*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO WINDOW'; exit 1 }
$h = $p.MainWindowHandle
if (-not $NoRestore) {
  if ([Cap8]::IsIconic($h)) { [void][Cap8]::ShowWindow($h, 9); Start-Sleep -Milliseconds 1200 }
  [void][Cap8]::ShowWindow($h, 5)
  Start-Sleep -Milliseconds 800
}
$r = New-Object Cap8+RECT
[void][Cap8]::GetWindowRect($h, [ref]$r)
$cw = $r.Right - $r.Left; $ch = $r.Bottom - $r.Top
Write-Output ("pid=" + $p.Id + " rect=" + $r.Left + "," + $r.Top + " " + $cw + "x" + $ch + " iconic=" + [Cap8]::IsIconic($h))
if ($cw -le 0 -or $ch -le 0) { Write-Output 'BAD RECT'; exit 2 }
[void][Cap8]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003 -bor 0x0040)
Start-Sleep -Milliseconds 1800
$bmp = New-Object System.Drawing.Bitmap($cw, $ch)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
$dir = Split-Path $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[void][Cap8]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
Write-Output "saved $Out"
