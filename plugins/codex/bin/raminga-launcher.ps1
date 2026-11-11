# Raminga MCP launcher (PowerShell) — source template.
#
# scripts/genplugins renders this into each host shell (plugins/claude/bin/...)
# after substituting the pinned release version and repository. The rendered
# copy is committed and verified by `genplugins --check`; edit this template,
# not the rendered copy.
#
# It resolves a `raminga.exe` binary and runs `raminga mcp`:
#   0. use $env:RAMINGA_BIN verbatim, skipping the version check (stderr notice);
#   1. reuse a PATH-installed `raminga` whose version exactly matches the pinned release;
#   2. reuse a previously downloaded, verified binary in the shared cache;
#   3. otherwise download the pinned release asset, verify SHA-256, then run.
#
# Windows only. macOS and Linux use launcher.sh.
$ErrorActionPreference = 'Stop'

$ReleaseVersion = '0.1.0'
$ReleaseRepo = 'Raminga/raminga'

function Get-RamingaVersion([string]$Path) {
    $first = (& $Path version 2>$null | Select-Object -First 1)
    if ($first -match '^raminga\s+(\S+)') { return $Matches[1] }
    return $null
}

# 0. Explicit override. No version comparison: the caller owns that choice.
if ($env:RAMINGA_BIN) {
    [Console]::Error.WriteLine("raminga-launcher: RAMINGA_BIN is set; using $($env:RAMINGA_BIN) and skipping the version check")
    if (-not (Test-Path -LiteralPath $env:RAMINGA_BIN -PathType Leaf)) {
        [Console]::Error.WriteLine("raminga-launcher: RAMINGA_BIN does not exist: $($env:RAMINGA_BIN)")
        exit 1
    }
    & $env:RAMINGA_BIN mcp
    exit $LASTEXITCODE
}

# 1. Reuse a PATH binary only when its reported version is exactly the pinned one.
$raminga = Get-Command raminga -ErrorAction SilentlyContinue
if ($null -ne $raminga) {
    if ((Get-RamingaVersion 'raminga') -eq $ReleaseVersion) {
        & raminga mcp
        exit $LASTEXITCODE
    }
}

# 2. Reuse the shared verified cache.
$binDir = if ($env:RAMINGA_BIN_DIR) { $env:RAMINGA_BIN_DIR } else { Join-Path $HOME ".raminga/bin/$ReleaseVersion" }
$exe = Join-Path $binDir 'raminga.exe'
if (Test-Path $exe) {
    & $exe mcp
    exit $LASTEXITCODE
}

# 3. Download the pinned Windows asset and verify its SHA-256.
# Download into a private temporary directory first. Nothing under
# ~/.raminga is created until the checksum has passed, so a failed download
# leaves no empty ~/.raminga/bin/<version>/ behind.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$base = "https://github.com/$ReleaseRepo/releases/download/v$ReleaseVersion"
$asset = "raminga_windows_${arch}.exe"
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('raminga-launcher.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
$tmp = Join-Path $tmpDir $asset
$sums = Join-Path $tmpDir 'SHA256SUMS'
$createdDirs = New-Object System.Collections.Generic.List[string]
$installed = $false
try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $tmp -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing

    $expected = $null
    foreach ($line in (Get-Content $sums)) {
        $parts = $line -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -eq $asset) { $expected = $parts[0]; break }
    }
    if ([string]::IsNullOrEmpty($expected)) {
        throw "no SHA256 entry for $asset in SHA256SUMS"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
    if ($expected.ToLowerInvariant() -ne $actual) {
        throw "SHA-256 verification failed (want $expected, got $actual)"
    }

    # Record every directory this run would create, so a partial install can
    # be removed without touching a pre-existing cache.
    $probe = $binDir
    while (-not (Test-Path -LiteralPath $probe -PathType Container)) {
        $createdDirs.Add($probe)
        $parent = Split-Path -Parent $probe
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $probe) { break }
        $probe = $parent
    }
    if (-not (Test-Path -LiteralPath $binDir -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    }

    Move-Item -Force $tmp $exe
    Move-Item -Force $sums (Join-Path $binDir 'SHA256SUMS')
    $installed = $true
    & $exe mcp
    exit $LASTEXITCODE
}
finally {
    if (-not $installed) {
        foreach ($dir in $createdDirs) {
            if (Test-Path -LiteralPath $dir) {
                Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if (Test-Path -LiteralPath $tmpDir) {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
