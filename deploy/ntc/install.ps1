# Thin NTConsult installer for Windows: verifies the release, runs the full installer and
# applies the NTConsult config. Usage (PowerShell, ordinary user):
#   $env:NTC_PILOT_CHAVE='ntcp_...'; irm <blob>/install.ps1 | iex
# Env: NTC_PILOT_CHAVE (required), NTC_PILOT_EMAIL, NTC_PILOT_BLOB_URL,
#      NTC_PILOT_CHANNEL (stable|canary), NTC_PILOT_INSTALLER (tests), NTC_PILOT_DRY_RUN=1,
#      NTC_PILOT_SKIP_RESTART=1, NTC_PILOT_ALLOW_LOOPBACK_HTTP=1.
# The key is never echoed nor passed as an argument; only apply-config inherits it
# (the installer child process runs without it).
#
# Trust model: the SHA256SUMS and the manifest come from the same origin (the blob) as
# the files they describe, so the hashes catch corruption and partial uploads, not a
# compromised blob. Transport is HTTPS-only (loopback http only for tests).
#
# Package archive: the Windows installer (installer-opensource.ps1) unpacks a .zip with
# Expand-Archive, while the manifest sha256 covers the .tar.gz only. So the .zip that sits
# next to the .tar.gz (same releases/<version>/ directory) is verified against SHA256SUMS.

$ErrorActionPreference = 'Stop'

$DefaultBlob = 'https://stntconsultpilot.blob.core.windows.net/pilot'
$Blob = if ($env:NTC_PILOT_BLOB_URL) { $env:NTC_PILOT_BLOB_URL } else { $DefaultBlob }
$Blob = $Blob.TrimEnd('/')
$Channel = if ($env:NTC_PILOT_CHANNEL) { $env:NTC_PILOT_CHANNEL } else { 'stable' }
$DataDir = Join-Path $env:USERPROFILE '.loongsuite-pilot'
$LoopbackRe = '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)'

function Fail([string]$Message) { throw $Message }

function Test-LoopbackHttp([string]$Url) {
    return ($env:NTC_PILOT_ALLOW_LOOPBACK_HTTP -eq '1') -and ($Url -match $LoopbackRe)
}

# Assert-Https <name> <url>: https only, except the loopback test exception.
function Assert-Https([string]$Name, [string]$Url) {
    if ($Url -match '^https://') { return }
    if (Test-LoopbackHttp $Url) { return }
    Fail "$Name deve usar https://"
}

function Get-Remote([string]$Url, [string]$Dest) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
        if (Test-LoopbackHttp $Url) {
            Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing | Out-Null
        } else {
            # No redirects: a redirect could downgrade the transport to http.
            Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -MaximumRedirection 0 | Out-Null
        }
    } catch {
        Fail "falha ao baixar $Url"
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-AgainstSums([string]$Sums, [string]$Dir, [string]$Name) {
    $pattern = '^([0-9a-fA-F]{64})[ \t]+\*?' + [regex]::Escape($Name) + '\s*$'
    $want = $null
    foreach ($line in (Get-Content -LiteralPath $Sums)) {
        if ($line -match $pattern) { $want = $Matches[1].ToLowerInvariant(); break }
    }
    if (-not $want) { Fail "$Name ausente em SHA256SUMS" }
    if ((Get-Sha256 (Join-Path $Dir $Name)) -ne $want) {
        Fail "sha256 de $Name nao confere; instalacao abortada"
    }
}

function Test-Key {
    $k = $env:NTC_PILOT_CHAVE
    if (-not $k) { Fail 'defina NTC_PILOT_CHAVE com a chave fornecida pela NTConsult' }
    if ($k -cnotmatch '^ntcp_[0-9A-Za-z]{32,}$') { Fail 'NTC_PILOT_CHAVE em formato invalido (esperado ntcp_...)' }
}

function Get-ManifestValue([hashtable]$Table, [string]$Name) {
    $v = $Table[$Name]
    if ($null -eq $v) { return '' }
    return ([string]$v).Trim()
}

function Resolve-Node {
    $n = ''
    $file = Join-Path $DataDir 'node-bin'
    if (Test-Path -LiteralPath $file) {
        $n = ((Get-Content -LiteralPath $file -Encoding UTF8 -TotalCount 1) | Out-String).Trim()
    }
    if (-not $n -or -not (Test-Path -LiteralPath $n)) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        $n = if ($cmd) { $cmd.Source } else { '' }
    }
    if (-not $n) { Fail 'Node nao encontrado' }
    return $n
}

# Every installer parameter we pass must exist in the downloaded (verified) installer.
function Assert-InstallerParams([string]$Installer) {
    $text = Get-Content -LiteralPath $Installer -Raw
    foreach ($p in @('Version', 'PackageUrl', 'AllAgents', 'UserId', 'CollectLog', 'InterceptorMode')) {
        if ($text -notmatch ('\[(string|switch)\]\$' + $p + '\b')) {
            Fail "o instalador baixado nao tem o parametro -$p; instalacao abortada"
        }
    }
}

function Get-PowerShellExe {
    foreach ($name in @('powershell.exe', 'pwsh.exe')) {
        $p = Join-Path $PSHOME $name
        if (Test-Path -LiteralPath $p) { return $p }
    }
    Fail 'powershell nao encontrado'
}

function Invoke-NtcInstall {
    Write-Host 'Configurando o SDLC NTConsult e o coletor de métricas.'
    Test-Key
    Assert-Https 'NTC_PILOT_BLOB_URL' $Blob
    if ($Channel -ne 'stable' -and $Channel -ne 'canary') { Fail 'NTC_PILOT_CHANNEL deve ser stable ou canary' }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('ntc-pilot-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        Get-Remote "$Blob/manifest/$Channel.txt" (Join-Path $work 'channel.txt')
        try {
            $m = ConvertFrom-StringData -StringData ((Get-Content -LiteralPath (Join-Path $work 'channel.txt') -Raw))
        } catch {
            Fail "manifesto do canal $Channel ilegivel"
        }
        $version = Get-ManifestValue $m 'version'
        $packageUrl = Get-ManifestValue $m 'package_url'
        $packageSha = (Get-ManifestValue $m 'sha256').ToLowerInvariant()
        if (-not $version -or -not $packageUrl -or -not $packageSha) {
            Fail "manifesto do canal $Channel incompleto (version, package_url e sha256 sao obrigatorios)"
        }
        if ($packageUrl -match '\s') { Fail 'package_url invalido no manifesto' }
        Assert-Https 'package_url' $packageUrl
        if ($version -cnotmatch '^[0-9A-Za-z.+-]+$') { Fail 'versao invalida no manifesto' }
        if ($packageSha -cnotmatch '^[0-9a-f]{64}$') { Fail 'sha256 invalido no manifesto' }
        if ($packageUrl -notmatch '\.tar\.gz$') { Fail 'package_url deve terminar em .tar.gz' }
        $zipUrl = $packageUrl -replace '\.tar\.gz$', '.zip'

        if ($env:NTC_PILOT_DRY_RUN -eq '1') {
            Write-Host "[dry-run] canal=$Channel versao=$version"
            Write-Host "[dry-run] pacote=$packageUrl"
            Write-Host "[dry-run] pacote windows=$zipUrl"
            Write-Host '[dry-run] nada foi executado'
            return
        }

        $rel = "$Blob/releases/$version"
        $sums = Join-Path $work 'SHA256SUMS'
        Get-Remote "$rel/SHA256SUMS" $sums
        Get-Remote "$rel/apply-config.mjs" (Join-Path $work 'apply-config.mjs')
        Test-AgainstSums $sums $work 'apply-config.mjs'

        # The manifest sha256 covers the .tar.gz; the Windows installer needs the .zip.
        $zip = Join-Path $work 'loongsuite-pilot.zip'
        Get-Remote $zipUrl $zip
        Test-AgainstSums $sums $work 'loongsuite-pilot.zip'

        $installer = $env:NTC_PILOT_INSTALLER
        if ($installer) {
            [Console]::Error.WriteLine('Aviso: NTC_PILOT_INSTALLER definido; verificacao sha256 do instalador ignorada.')
        } else {
            $installer = Join-Path $work 'installer.ps1'
            Get-Remote "$rel/installer.ps1" $installer
            Test-AgainstSums $sums $work 'installer.ps1'
        }
        Assert-InstallerParams $installer

        # The installer never sees the key.
        $instArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
            'install', '-Version', $version, '-PackageUrl', $zip, '-AllAgents')
        if ($env:NTC_PILOT_EMAIL) { $instArgs += @('-UserId', $env:NTC_PILOT_EMAIL) }
        $instArgs += @('-CollectLog', 'false', '-InterceptorMode', 'all')
        $savedKey = $env:NTC_PILOT_CHAVE
        Remove-Item Env:NTC_PILOT_CHAVE -ErrorAction SilentlyContinue
        try {
            & (Get-PowerShellExe) @instArgs
            if ($LASTEXITCODE -ne 0) { Fail "o instalador terminou com erro (codigo $LASTEXITCODE)" }
        } finally {
            $env:NTC_PILOT_CHAVE = $savedKey
        }

        $node = Resolve-Node
        $applyArgs = @((Join-Path $work 'apply-config.mjs'), '--data-dir', $DataDir)
        if ($env:NTC_PILOT_ALLOW_LOOPBACK_HTTP -eq '1') { $applyArgs += '--allow-loopback-http' }
        if ($Channel -eq 'canary') { $env:NTC_PILOT_CANARY = '1' }
        $env:NTC_PILOT_BLOB_URL = $Blob
        & $node @applyArgs
        if ($LASTEXITCODE -ne 0) { Fail "apply-config terminou com erro (codigo $LASTEXITCODE)" }

        if ($env:NTC_PILOT_SKIP_RESTART -ne '1') {
            $cli = Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot.cmd'
            & $cli restart
            if ($LASTEXITCODE -ne 0) { Fail "loongsuite-pilot restart terminou com erro (codigo $LASTEXITCODE)" }
            & $cli status
        }
        Write-Host 'Concluído.'
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    Invoke-NtcInstall
} catch {
    [Console]::Error.WriteLine("Erro: $($_.Exception.Message)")
    # Run as a file: set the exit code. Under `irm | iex` there is no file, and `exit`
    # would close the user's terminal.
    if ($PSCommandPath) { exit 1 }
    $global:LASTEXITCODE = 1
}
