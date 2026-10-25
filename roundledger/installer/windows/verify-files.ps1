# Verifies the installed extension files against SHA256SUMS.txt.
# Usage: right-click → Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File verify-files.ps1)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'extension'
$bad = 0; $count = 0
foreach ($line in Get-Content (Join-Path $PSScriptRoot 'SHA256SUMS.txt')) {
  if ($line -notmatch '^([0-9a-f]{64})\s+(.+)$') { continue }
  $expected = $Matches[1]; $rel = $Matches[2]; $count++
  $file = Join-Path $root ($rel -replace '/', '\')
  if (-not (Test-Path $file)) { Write-Host "MISSING  $rel" -ForegroundColor Red; $bad++; continue }
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expected) { Write-Host "CHANGED  $rel" -ForegroundColor Red; $bad++ }
}
if ($bad -eq 0) { Write-Host "OK: all $count files match." -ForegroundColor Green } else { Write-Host "$bad of $count files do not match. Reinstall RoundLedger." -ForegroundColor Red }
Read-Host 'Press Enter to close'
