# Install the api.wmpvp.com capture interception (REQUIRES ADMIN).
# Does two things in a single elevation:
#   1) trust our capture CA in LocalMachine\Root
#   2) point api.wmpvp.com at 127.0.0.1 in the hosts file (backed up first)
# ASCII only on purpose - Windows/console codepage issues mangled Chinese output before.

$ErrorActionPreference = 'Stop'

$captureDir = 'D:\qq-bridge\state\wmpvp-capture'
$caCer = Join-Path $captureDir 'ca.cer'
$hosts = Join-Path $env:windir 'System32\drivers\etc\hosts'
$hostsBackup = Join-Path $captureDir 'hosts.backup'
$marker = '# qq-bridge wmpvp capture'

# --- sanity ---
if (-not (Test-Path $caCer)) {
    Write-Host "ERROR: CA cert not found: $caCer" -ForegroundColor Red
    Write-Host 'Run first (no admin needed): powershell -File scripts\wmpvp-make-cert.ps1'
    exit 1
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: needs Administrator. Right-click -> Run as administrator.' -ForegroundColor Red
    exit 1
}

Write-Host '=== 1) trust the capture CA (LocalMachine\Root) ===' -ForegroundColor Cyan
$wantThumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caCer)).Thumbprint
$already = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $wantThumb }
if ($already) {
    Write-Host "  already trusted: $wantThumb"
} else {
    Import-Certificate -FilePath $caCer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Write-Host "  imported: $wantThumb"
}

Write-Host '=== 2) hosts: wmpvp domains -> 127.0.0.1 ===' -ForegroundColor Cyan
# Use .NET file APIs rather than Get-Content/Set-Content: on this machine the hosts
# file started out 0 bytes, and the Get-Content | Where-Object | Set-Content pipeline
# turns an unreadable/empty file into an empty one while looking like it succeeded.
if (-not (Test-Path $hostsBackup) -or (Get-Item $hostsBackup).Length -eq 0) {
    $orig = [System.IO.File]::ReadAllText($hosts)
    [System.IO.File]::WriteAllText($hostsBackup, $orig, [System.Text.Encoding]::ASCII)
    Write-Host "  backed up hosts -> $hostsBackup ($($orig.Length) chars)"
} else {
    Write-Host "  backup already exists: $hostsBackup"
}

# api.wmpvp.com hosts the CS stats endpoints, but the client's real credential traffic
# goes to pwaweblogin.wmpvp.com (found by reverse-mapping its live connections), so
# intercept the whole plausible set.
$captureHosts = @(
    'api.wmpvp.com',
    'appengine.wmpvp.com',
    'pwaweblogin.wmpvp.com',
    'wspwaweblogin.wmpvp.com',
    'client.wmpvp.com'
)

$existing = [System.IO.File]::ReadAllLines($hosts)
$kept = @($existing | Where-Object {
    ($_ -notmatch [regex]::Escape($marker)) -and ($_ -notmatch '\bwmpvp\.com\b')
})
$block = @('')
foreach ($h in $captureHosts) { $block += "127.0.0.1 $h $marker" }
$out = $kept + $block
[System.IO.File]::WriteAllLines($hosts, $out, [System.Text.Encoding]::ASCII)
Write-Host ("  hosts updated with {0} entries (kept {1} existing lines)" -f $captureHosts.Count, $kept.Count)

Write-Host ''
Write-Host '=== 3) verify ===' -ForegroundColor Cyan
$chk = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $wantThumb }
Write-Host ("  root trusted : {0}" -f ([bool]$chk))
$hostsHit = Select-String -Path $hosts -Pattern 'api\.wmpvp\.com' -SimpleMatch
Write-Host ("  hosts entry  : {0}" -f ([bool]$hostsHit))
try {
    $resolved = [System.Net.Dns]::GetHostAddresses('api.wmpvp.com') | ForEach-Object { $_.IPAddressToString }
    Write-Host ("  resolves to  : {0}" -f ($resolved -join ', '))
} catch {
    Write-Host '  resolves to  : (failed)'
}

Write-Host ''
Write-Host '=== DONE ===' -ForegroundColor Green
Write-Host 'Next steps:'
Write-Host '  1) start the proxy (needs admin for port 443):'
Write-Host '       node scripts\wmpvp-proxy.mjs'
Write-Host '  2) launch the Perfect World client and log in'
Write-Host '  3) the proxy auto-saves the token, then press Ctrl+C'
Write-Host '  4) node scripts\check-wmpvp-token.mjs'
Write-Host '  5) powershell -File scripts\wmpvp-uninstall-capture.ps1   (restore hosts + untrust CA)'
