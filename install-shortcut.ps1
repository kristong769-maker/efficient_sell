[CmdletBinding()]
param(
    [string]$DesktopDirectory = "",
    [switch]$Silent
)

$ErrorActionPreference = "Stop"
$appRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$targetPath = Join-Path $appRoot "start.bat"
$iconPath = Join-Path $appRoot "assets\efficent_sell_es_transparent.ico"

if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "找不到程序启动文件：$targetPath"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "找不到程序图标：$iconPath"
}

if (-not $DesktopDirectory) {
    $DesktopDirectory = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::DesktopDirectory
    )
}
if (-not $DesktopDirectory) {
    throw "无法取得当前用户的桌面目录"
}

$desktopPath = [IO.Path]::GetFullPath($DesktopDirectory)
if (-not (Test-Path -LiteralPath $desktopPath -PathType Container)) {
    New-Item -ItemType Directory -Path $desktopPath -Force | Out-Null
}

$shortcutPath = Join-Path $desktopPath "efficent_sell.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $appRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "Steam 库存一键出售"
$shortcut.WindowStyle = 1
$shortcut.Save()

if (-not $Silent) {
    Write-Host "桌面快捷方式已创建：$shortcutPath"
}
