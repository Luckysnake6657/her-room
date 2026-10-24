# Undo the api.wmpvp.com capture interception (REQUIRES ADMIN).
# Restores the hosts file from backup (or strips just our lines) and untrusts the CA.
# Run this after capturing the token. ASCII only.

$ErrorActionPreference = 'Stop'

$captureDir = 'D:\qq-bridge\state\wmpvp-capture'
$caCer = Join-Path $captureDir 'ca.cer'
$hosts = Join-Path $env:windir 'System32\drivers\etc\hosts'
$hostsBackup = Join-Path $captureDir 'hosts.backup'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: needs Administrator. Right-click -> Run as administrator.' -ForegroundColor Red
    exit 1
}

Write-Host '=== 1) restore hosts ===' -ForegroundColor Cyan
# .NET file APIs only: Get-Content/Set-Content silently turn an empty/oddly-encoded
# hosts file into an empty one (that is exactly how this machine's hosts got wiped).
# A backup is only used when it actually looks clean.
$current = [System.IO.File]::ReadAllLines($hosts)
$stripped = @($current | Where-Object {
    ($_ -notmatch [regex]::Escape('qq-bridge wmpvp capture')) -and
    ($_ -notmatch '\bwmpvp\.com\b')
})

$restored = $false
if (Test-Path $hostsBackup) {
    $bakLines = [System.IO.File]::ReadAllLines($hostsBackup)
    $bakHasCapture = @($bakLines | Where-Object { $_ -match '\bwmpvp\.com\b' }).Count -gt 0
    if ($bakLines.Count -eq 0) {
        Write-Host '  backup is empty (not usable); stripping current file instead'
    } elseif ($bakHasCapture) {
        Write-Host '  backup contains stale capture lines; stripping current file instead'
    } else {
        $stripped = $bakLines
        $restored = $true
        Write-Host "  restored from clean backup: $hostsBackup"
    }
} else {
    Write-Host '  no backup found; stripping our lines from the current file'
}

if ($stripped.Count -eq 0) {
    Write-Host '  WARNING: result would be empty; leaving hosts untouched' -ForegroundColor Yellow
} else {
    [System.IO.File]::WriteAllLines($hosts, $stripped, [System.Text.Encoding]::ASCII)
    Write-Host ("  hosts written ({0} lines{1})" -f $stripped.Count, $(if ($restored) { ', from backup' } else { '' }))
}

Write-Host '=== 2) untrust the capture CA ===' -ForegroundColor Cyan
if (Test-Path $caCer) {
    $thumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caCer)).Thumbprint
    $found = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $thumb }
    if ($found) {
        $found | ForEach-Object { Remove-Item "Cert:\LocalMachine\Root\$($_.Thumbprint)" -Force }
        Write-Host "  removed from LocalMachine\Root: $thumb"
    } else {
        Write-Host "  not present in LocalMachine\Root: $thumb"
    }
    # also clean the CurrentUser copies made by wmpvp-make-cert.ps1
    $cur = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -match 'QQBridge WMPVP Capture CA|CN=api\.wmpvp\.com' }
    if ($cur) {
        $cur | ForEach-Object { Remove-Item "Cert:\CurrentUser\My\$($_.Thumbprint)" -Force }
        Write-Host ("  cleaned {0} cert(s) from CurrentUser\My" -f @($cur).Count)
    }
} else {
    Write-Host '  CA file missing; skipping'
}

Write-Host '=== 3) verify ===' -ForegroundColor Cyan
$hostsHit = Select-String -Path $hosts -Pattern 'api\.wmpvp\.com'
Write-Host ("  hosts still mentions api.wmpvp.com : {0}" -f ([bool]$hostsHit))
try {
    $resolved = [System.Net.Dns]::GetHostAddresses('api.wmpvp.com') | ForEach-Object { $_.IPAddressToString }
    Write-Host ("  resolves to : {0}" -f ($resolved -join ', '))
} catch {
    Write-Host '  resolves to : (failed)'
}

Write-Host ''
Write-Host '=== DONE ===' -ForegroundColor Green
Write-Host 'Capture interception is off. api.wmpvp.com resolves normally again.'
Write-Host 'The captured token (state\wmpvp-token.json) is untouched - the bot keeps working.'
