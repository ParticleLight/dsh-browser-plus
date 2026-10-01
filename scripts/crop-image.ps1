<#
.SYNOPSIS
  Crop a region out of a PNG (no image library, System.Drawing only).

.DESCRIPTION
  Used with scripts/capture-window.ps1 to look at the chrome band at full
  resolution: a downscaled full-window capture cannot show whether a tab icon
  actually rendered. Omit -W/-H to crop to the bottom-right corner.
#>
param([string]$In, [string]$Out, [int]$X=0, [int]$Y=0, [int]$W=0, [int]$H=0)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($In)
if ($W -le 0) { $W = $src.Width - $X }
if ($H -le 0) { $H = $src.Height - $Y }
$dst = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0,0,$W,$H)), (New-Object System.Drawing.Rectangle($X,$Y,$W,$H)), [System.Drawing.GraphicsUnit]::Pixel)
$dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $dst.Dispose(); $src.Dispose()
Write-Output "cropped $Out $W x $H"
