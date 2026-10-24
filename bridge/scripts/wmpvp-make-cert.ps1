# Build the capture certs (ASCII only - avoids Windows/console codepage issues).
# Non-admin step: generate certs into CurrentUser store, export files.
# Admin step (import CA to root + hosts) lives in install-wmpvp-capture.ps1.
$ErrorActionPreference = 'Stop'

$outDir = 'D:\qq-bridge\state\wmpvp-capture'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$caSubject = 'CN=QQBridge WMPVP Capture CA'
$leafSubject = 'CN=api.wmpvp.com'

Write-Host '=== 1) root CA ==='
$ca = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $caSubject } | Select-Object -First 1
if ($ca) {
    Write-Host "  reuse CA: $($ca.Thumbprint)"
} else {
    $ca = New-SelfSignedCertificate -Subject $caSubject -KeyAlgorithm RSA -KeyLength 2048 `
        -HashAlgorithm SHA256 -CertStoreLocation Cert:\CurrentUser\My `
        -KeyUsage CertSign, CRLSign, DigitalSignature -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(10) `
        -TextExtension @('2.5.29.19={critical}{text}ca=1')
    Write-Host "  created CA: $($ca.Thumbprint)"
}

Write-Host '=== 2) leaf cert for wmpvp (wildcard + known hosts) ==='
Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $leafSubject } | ForEach-Object {
    Remove-Item "Cert:\CurrentUser\My\$($_.Thumbprint)" -Force
}
# Wildcard SANs so the certificate is valid for whatever *.wmpvp.com / *.wanmei.com
# hostname the client actually uses (we do not know the real API host yet, and a
# cert that does not match makes the client fail TLS and never send the request).
$dnsNames = @(
    'api.wmpvp.com', 'appengine.wmpvp.com', 'gate.wmpvp.com',
    'cdn.wmpvp.com', 'img.wmpvp.com', 'client.wmpvp.com',
    'highlights.wmpvp.com', 'pwacdn.wmpvp.com', 'pwaweblogin.wmpvp.com',
    '*.wmpvp.com', '*.wanmei.com', 'api.wanmei.com'
)
$leaf = New-SelfSignedCertificate -Subject $leafSubject -DnsName $dnsNames `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My -Signer $ca `
    -KeyUsage DigitalSignature, KeyEncipherment -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
Write-Host "  created leaf: $($leaf.Thumbprint)"
Write-Host "  SAN: $($dnsNames -join ', ')"

Write-Host '=== 3) export ==='
$caPfx = Join-Path $outDir 'ca.pfx'
$caCer = Join-Path $outDir 'ca.cer'
$leafPfx = Join-Path $outDir 'leaf.pfx'
$leafCer = Join-Path $outDir 'leaf.cer'
$serverPem = Join-Path $outDir 'server.pem'
$caPemOut = Join-Path $outDir 'ca-cert.pem'
$leafPw = ConvertTo-SecureString -String 'qqbridge' -Force -AsPlainText
$caPw = ConvertTo-SecureString -String 'qqbridge' -Force -AsPlainText

Export-PfxCertificate -Cert $ca -FilePath $caPfx -Password $caPw -ChainOption EndEntityCertOnly | Out-Null
Export-Certificate -Cert $ca -FilePath $caCer -Type CERT | Out-Null
Export-PfxCertificate -Cert $leaf -FilePath $leafPfx -Password $leafPw -ChainOption BuildChain | Out-Null
Export-Certificate -Cert $leaf -FilePath $leafCer -Type CERT | Out-Null

# ca-cert.pem: the PEM form of the CA, used two ways --
#   1) the proxy passes it as `ca` so the server presents the full chain
#   2) the install script trusts it (and it doubles as the "trust this root" file)
certutil -encode $caCer $caPemOut | Out-Null

# No PEM key bundle needed: the proxy loads the PKCS#12 (which already carries the
# CA alongside the leaf, verified with certutil) and passes ca-cert.pem explicitly
# so Node presents the full chain. Windows PowerShell 5.1 has no API to export the
# private key as PKCS#8/PKCS#1 PEM, so avoid that path entirely.

Write-Host '=== done ==='
Get-ChildItem $outDir | ForEach-Object { Write-Host ("  {0,8}  {1}" -f $_.Length, $_.Name) }
Write-Host ''
Write-Host "CA thumbprint : $($ca.Thumbprint)"
Write-Host "CA subject    : $($ca.Subject)"
Write-Host "leaf subject  : $($leaf.Subject)  expires $($leaf.NotAfter)"
