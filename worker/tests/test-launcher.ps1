# ===========================================================================
#  启动器逻辑测试（不真的开菜单，只验证「找得到 / 找不到」两条分支）
# ===========================================================================
#  真实场景验证点：
#    1. 找到 Git Bash  -> 拼出的 bash 命令行能不能真的跑起来
#    2. 找不到 Git Bash -> 会不会给出可用的安装指引
#    3. 中文在 PowerShell 里是不是正常输出
# ===========================================================================

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher  = Join-Path $scriptDir '安装.ps1'

$pass = 0
$fail = 0

function Check($name, $ok, $detail) {
    if ($ok) {
        Write-Host ("  [通过] " + $name) -ForegroundColor Green
        if ($detail) { Write-Host ("         " + $detail) -ForegroundColor DarkGray }
        $script:pass++
    } else {
        Write-Host ("  [失败] " + $name) -ForegroundColor Red
        if ($detail) { Write-Host ("         " + $detail) -ForegroundColor DarkGray }
        $script:fail++
    }
}

Write-Host ""
Write-Host "  启动器逻辑测试" -ForegroundColor Cyan
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray

# ---- 1. 启动器文件语法能不能解析 ----
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$null, [ref]$parseErrors)
Check "安装.ps1 语法解析通过" ($parseErrors.Count -eq 0) "解析错误数：$($parseErrors.Count)"

# ---- 2. 文件编码是 UTF-8 且不含 BOM 以外的异常字节 ----
$bytes = [System.IO.File]::ReadAllBytes($launcher)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$canDecodeUtf8 = $true
try { $null = $utf8Strict.GetString($bytes) } catch { $canDecodeUtf8 = $false }
Check "启动器内容是合法 UTF-8" $canDecodeUtf8 "带 BOM：$hasBom"

# ---- 3. 不含 GBK 解不开的全角标点以外的裸中文命令（粗筛：不应出现 .bat 残留） ----
$text = [System.IO.File]::ReadAllText($launcher, [System.Text.Encoding]::UTF8)
Check "已无 安装.bat 残留" (-not ($text -match '安装\.bat'))

# ---- 4. Git Bash 探测逻辑与实测一致 ----
$candidates = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe",
    "$env:ProgramFiles\Git\usr\bin\bash.exe"
)
$found = $null
foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $found = $c; break } }
if (-not $found) {
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe -and $gitExe.Source) {
        $gitRoot = Split-Path (Split-Path $gitExe.Source -Parent) -Parent
        foreach ($sub in @('bin\bash.exe', 'usr\bin\bash.exe')) {
            $p = Join-Path $gitRoot $sub
            if (Test-Path $p) { $found = $p; break }
        }
    }
}
Check "在本机能探测到 Git Bash" ([bool]$found) "命中：$found"

# ---- 5. 拼出的命令行真的能执行（跑一个最小验证，不开菜单） ----
if ($found) {
    $probe = "echo LAUNCHER_OK && exit 7"
    $out = & $found --login -c $probe 2>&1
    $joined = ($out | Out-String).Trim()
    Check "命令行能真正跑起来" ($joined -match 'LAUNCHER_OK') "输出：$joined"
    Check "退出码能透传" ($LASTEXITCODE -eq 7) "退出码：$LASTEXITCODE"

    # 中文参数经 bash 往返不丢字（路径带中文目录）
    $cnCmd = "printf '%s' '中文测试通过'"
    $cnOut = (& $found --login -c $cnCmd 2>&1 | Out-String).Trim()
    Check "中文经 bash 往返正常" ($cnOut -eq '中文测试通过') "输出：$cnOut"
}

# ---- 6. 找不到分支的指引文案包含关键动作 ----
$hasWingetTip = ($text -match 'winget install')
$hasManualTip = ($text -match 'git-scm\.com/download/win')
$hasReopen    = ($text -match '重新双击')
Check "缺失分支给出 winget 自动安装命令" $hasWingetTip
Check "缺失分支给出官网手动下载地址" $hasManualTip
Check "缺失分支提示装完重新双击" $hasReopen

# ---- 7. 启动器里不再出现「假设已装 Git」的硬编码路径 ----
$hardCoded = ($text -match 'C:\\\\Program Files\\\\Git\\\\bin\\\\bash\.exe"')
Check "没有写死绝对路径（都是动态探测）" (-not $hardCoded)

Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ("  通过 $pass 项，失败 $fail 项") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ""

if ($fail -gt 0) { exit 1 }
exit 0
