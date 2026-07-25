[CmdletBinding()]
param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw |
    ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "package.json 中的版本号必须是 x.y.z：$version"
}

$nativeUi = Get-Content -LiteralPath (Join-Path $repoRoot "native-ui.py") -Raw
if ($nativeUi -notmatch ('APP_VERSION\s*=\s*"' + [regex]::Escape($version) + '"')) {
    throw "native-ui.py 中的 APP_VERSION 与 package.json 不一致"
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot "dist"
}
$distDir = [IO.Path]::GetFullPath($OutputDirectory)
$stageDir = Join-Path $distDir ".staging-v$version"
$zipName = "efficent_sell-v$version.zip"
$zipPath = Join-Path $distDir $zipName
$checksumPath = "$zipPath.sha256"

New-Item -ItemType Directory -Path $distDir -Force | Out-Null
if (Test-Path -LiteralPath $stageDir) {
    $resolvedStage = (Resolve-Path -LiteralPath $stageDir).Path
    if (-not $resolvedStage.StartsWith($distDir + [IO.Path]::DirectorySeparatorChar)) {
        throw "拒绝清理输出目录之外的暂存目录：$resolvedStage"
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

$runtimeDirectories = @("assets", "public", "src")
$runtimeFiles = @(
    "native-ui.py",
    "updater.py",
    "update_support.py",
    "package.json",
    "package-lock.json",
    "README.md",
    "start.bat"
)

foreach ($directory in $runtimeDirectories) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $directory) `
        -Destination $stageDir -Recurse
}
foreach ($file in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $stageDir
}

$manifestFiles = @(
    Get-ChildItem -LiteralPath $stageDir -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($stageDir.Length + 1).Replace("\", "/")
            [ordered]@{
                path = $relative
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
)
$manifest = [ordered]@{
    version = $version
    files = $manifestFiles
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
    (Join-Path $stageDir "update-manifest.json"),
    $manifestJson,
    $utf8NoBom
)

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $checksumPath) {
    Remove-Item -LiteralPath $checksumPath -Force
}
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath
$checksum = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(
    $checksumPath,
    "$checksum  $zipName`n",
    $utf8NoBom
)

Remove-Item -LiteralPath $stageDir -Recurse -Force
Write-Host "Release package: $zipPath"
Write-Host "SHA-256 file:  $checksumPath"
