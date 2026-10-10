# ===========================================================================
#  Windows 启动器（双击这个文件就能用）
# ===========================================================================
#  为什么用 PowerShell 而不是纯 .bat：
#    cmd.exe 读 .bat 默认按 GBK 解码，而文件是 UTF-8 —— 中文全部变乱码，
#    乱码还会被当成命令去执行（实测：一堆「不是内部或外部命令」）。
#    PowerShell 原生支持 UTF-8，中文不会出问题。
#
#  这个脚本只做一件事：找到 Git Bash → 打开菜单。
#  找不到 Git Bash 就给出安装指引。
# ===========================================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Show-Banner {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "    CDT 流量守护机器人 - 安装向导" -ForegroundColor Cyan
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Pause-Exit($code) {
    Write-Host ""
    Write-Host "  按回车键关闭这个窗口..." -ForegroundColor DarkGray
    [void](Read-Host)
    exit $code
}

Show-Banner

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$menuSh    = Join-Path $scriptDir 'menu.sh'

# ---- 1. 脚本文件在不在 ----
if (-not (Test-Path $menuSh)) {
    Write-Host "  [错误] 没找到 menu.sh" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请确认「安装.ps1」和 menu.sh 在同一个文件夹里。"
    Write-Host "  如果你是解压后直接双击的，先看看是不是多套了一层目录。"
    Write-Host ""
    Write-Host "  当前目录：$scriptDir" -ForegroundColor DarkGray
    Pause-Exit 1
}

# ---- 2. 找 Git Bash ----
$candidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe",
    "$env:ProgramFiles\Git\usr\bin\bash.exe"
)

$gitBash = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $gitBash = $c; break }
}

# 再从 PATH 里的 git 反推
if (-not $gitBash) {
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe) {
        # git.exe 一般在 Git\cmd\ 下，bash.exe 在 Git\bin\ 或 Git\usr\bin\ 下
        $gitRoot = Split-Path (Split-Path $gitExe.Source -Parent) -Parent
        foreach ($sub in @('bin\bash.exe', 'usr\bin\bash.exe')) {
            $p = Join-Path $gitRoot $sub
            if (Test-Path $p) { $gitBash = $p; break }
        }
    }
}

# ---- 3. 找到了：启动菜单 ----
if ($gitBash) {
    Write-Host "  [就绪] 找到运行环境" -ForegroundColor Green
    Write-Host "         $gitBash" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  正在打开安装菜单..." -ForegroundColor Yellow
    Write-Host ""

    # 用 bash 打开菜单。cd 到脚本目录，避免相对路径出错。
    $bashCmd = "cd '$($scriptDir -replace '\\','/')' && bash menu.sh"
    & $gitBash --login -i -c $bashCmd

    Write-Host ""
    Write-Host "  菜单已关闭。" -ForegroundColor DarkGray
    Write-Host "  如果刚才有报错，把上面的内容截图发给作者。" -ForegroundColor DarkGray
    Pause-Exit 0
}

# ---- 4. 没找到：给安装指引 ----
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host "   还差一个运行环境：Git for Windows" -ForegroundColor Yellow
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  这套程序需要在 Git Bash 里运行，你电脑上还没装。"
Write-Host "  装一次就好，以后都不用再管。大约 60 兆，一分钟能装完。"
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "   怎么装（二选一）" -ForegroundColor White
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  【方案一】自动安装（推荐）" -ForegroundColor Green
Write-Host ""
Write-Host "      按 Win+R 打开「运行」框，粘贴下面这条，回车："
Write-Host ""
Write-Host "          winget install --id Git.Git -e" -ForegroundColor Cyan
Write-Host ""
$hasWinget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $hasWinget) {
    Write-Host "      （你这台电脑好像没有 winget，那就用方案二）" -ForegroundColor DarkGray
}
Write-Host "      跑完之后，关掉窗口，重新双击「安装.ps1」。"
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  【方案二】手动下载" -ForegroundColor Green
Write-Host ""
Write-Host "      1. 浏览器打开：https://git-scm.com/download/win" -ForegroundColor Cyan
Write-Host "      2. 网页会自动开始下载，等它下完"
Write-Host "      3. 双击安装包，一路点「Next / 下一步」"
Write-Host "         （所有选项用默认的，不用改）"
Write-Host "      4. 装完关掉窗口，重新双击「安装.ps1」"
Write-Host ""

$ans = Read-Host "  要现在打开下载页面吗？(y=打开 / 直接回车=关闭)"
if ($ans -eq 'y' -or $ans -eq 'Y') {
    Start-Process "https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "  浏览器已打开。装完重新双击「安装.ps1」即可。" -ForegroundColor Green
}
Pause-Exit 0
