# Install raminga.exe for the current Windows user.
# Run from the unpacked archive (next to raminga.exe).
#Requires -Version 5.1
param(
    [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "raminga.exe"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "找不到 raminga.exe；请在归档解压目录运行 scripts\install.ps1"
}

$destDir = Join-Path $env:LOCALAPPDATA "Programs\Raminga"
$dest = Join-Path $destDir "raminga.exe"
$old = "$dest.old"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
# Remove the stale backup from an earlier upgrade. A running exe can be renamed
# but not overwritten, so every upgrade moves the old file aside first.
if (Test-Path -LiteralPath $old) {
    Remove-Item -Force -LiteralPath $old
}
if (Test-Path -LiteralPath $dest) {
    Move-Item -Force -LiteralPath $dest -Destination $old
}
try {
    Copy-Item -Force -LiteralPath $source -Destination $dest
} catch {
    if (Test-Path -LiteralPath $old) {
        Move-Item -Force -LiteralPath $old -Destination $dest
    }
    throw
}
Unblock-File -LiteralPath $dest

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $userPath) {
    $userPath = ""
}
$onPath = $false
foreach ($part in ($userPath -split ";")) {
    if ($part.Trim().TrimEnd("\") -ieq $destDir.TrimEnd("\")) {
        $onPath = $true
    }
}
if (-not $onPath) {
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        $newPath = $destDir
    } else {
        $newPath = $userPath.TrimEnd(";") + ";" + $destDir
    }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "已将 $destDir 添加到用户 PATH；请打开新的终端。"
}

$statusDir = if ($DataDir) { $DataDir } else { Join-Path $HOME ".raminga" }
$oldRunning = $false
try {
    & $dest status --data-dir $statusDir *> $null
    if ($LASTEXITCODE -eq 0) {
        $oldRunning = $true
    }
} catch {
    $oldRunning = $false
}

$installedVersion = (& $dest version 2>$null | Select-Object -First 1)
if ($installedVersion) {
    Write-Host "已安装 $installedVersion 到 $dest"
} else {
    Write-Host "已安装 $dest"
}
if ($oldRunning) {
    Write-Host "运行 raminga restart 切换到新版本"
}
