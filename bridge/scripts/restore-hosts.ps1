# Restore the Windows hosts file from the pristine WinSxS copy (REQUIRES ADMIN).
# ASCII only.
$ErrorActionPreference = 'Stop'

$hosts = Join-Path $env:windir 'System32\drivers\etc\hosts'
$default = 'C:\Windows\WinSxS\amd64_microsoft-windows-w..ucture-other-minwin_31bf3856ad364e35_10.0.26100.1_none_323345d6cd9e8cb7\hosts'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: needs Administrator.' -ForegroundColor Red
    exit 1
}

Write-Host "current hosts size: $((Get-Item $hosts).Length) bytes"

if (-not (Test-Path $default)) {
    Write-Host "ERROR: default hosts template not found: $default" -ForegroundColor Red
    exit 1
}

$lines = [System.IO.File]::ReadAllLines($default)
[System.IO.File]::WriteAllLines($hosts, $lines, [System.Text.Encoding]::ASCII)

Write-Host "restored hosts from WinSxS template"
Write-Host "new hosts size: $((Get-Item $hosts).Length) bytes"
Write-Host ''
Get-Content $hosts | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'Run "ipconfig /flushdns" to be safe.'
