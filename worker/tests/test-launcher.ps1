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

# ---- 8. 双击垫片 启动.bat（Windows 双击 .ps1 只会用记事本打开） ----
# 小白用户会直接双击包里的启动器。.ps1 双击是「打开编辑器」而不是「运行」，
# 所以必须有一个 .bat 垫片。这里钉死它的三个关键性质。
$batPath = Join-Path $scriptDir '启动.bat'
Check "启动.bat 存在" (Test-Path $batPath) $batPath

if (Test-Path $batPath) {
    $batBytes = [System.IO.File]::ReadAllBytes($batPath)

    # 先把 .ps1 的文本读出来，供下面几项共用（8d-3 / 8e 都要用）
    $ps1Path = Join-Path $scriptDir '安装.ps1'
    $ps1Text = if (Test-Path $ps1Path) { [System.IO.File]::ReadAllText($ps1Path) } else { '' }

    # 8a. 必须是 CRLF 换行 —— LF 会让 cmd.exe 把 rem 注释当命令执行
    $batText = [System.Text.Encoding]::ASCII.GetString($batBytes)
    $lfOnly = ([regex]::Matches($batText, "(?<!\r)\n")).Count
    Check "启动.bat 是 CRLF 换行（LF 会导致满屏报错）" ($lfOnly -eq 0) "裸 LF 数量：$lfOnly"

    # 8b. 必须是纯 ASCII —— cmd.exe 按 GBK 解码，非 ASCII 会乱码
    $nonAscii = 0
    foreach ($b in $batBytes) { if ($b -gt 127) { $nonAscii++ } }
    Check "启动.bat 是纯 ASCII（中文会乱码并被当命令执行）" ($nonAscii -eq 0) "非 ASCII 字节：$nonAscii"

    # 8c. 必须能调用 PowerShell，并且把退出码带出来
    Check "启动.bat 会调用 PowerShell" ($batText -match 'powershell\.exe') 
    Check "启动.bat 带 -ExecutionPolicy Bypass" ($batText -match 'ExecutionPolicy Bypass')
    Check "启动.bat 会回传退出码" ($batText -match 'ERRORLEVEL')

    # 8d. 不能写死中文文件名（.bat 里写中文路径会因 GBK 解码而匹配不到）
    Check "启动.bat 用通配符定位 .ps1（不写死中文名）" ($batText -match '\*\.ps1')

    # 8d-2. 🔴 定位 .ps1 必须用 for /f 读 dir 的输出，**不能**用
    #       `for %%F in ("*.ps1") do ( ... %%~fF ... )` 这种「通配展开进括号块」的写法。
    #
    # 为什么（2026-10-11 用户实测复现的真凶之一）：
    #   cmd 会把 for-in 匹配到的路径**塞进一对括号里**再执行。它给括号配对
    #   发生在考虑引号**之前**，所以只要展开出来的路径**本身带右括号**，
    #   这个块就在那个字符处被提前截断，剩下的部分被当成命令执行。
    #
    #   触发条件极其常见：浏览器下载同名文件第二次会自动改成
    #   "cdt-guard-worker-20261011 (1)"，解压后目录里就有 "(1)"。
    #   此时 for 展开出
    #       set "PS1=C:\...\cdt-guard-worker-20261011 (1)\cdt-guard-worker\安装.ps1"
    #   cmd 立即报「此时不应有 \cdt-guard-worker。」并终止整个启动器 ——
    #   用户看到的就是「双击，窗口一闪就没了」。
    #
    #   改成 for /f 读 dir /b 的输出即可绕开：名字是当**一行文本**读进来的，
    #   不经过括号块，目录名里有什么括号都不影响。已在真实失败目录验证。
    $usesForF = ($batText -match 'for\s+/f')
    $usesBadForIn = ($batText -match 'for\s+%%[A-Za-z]\s+in\s*\(\s*"\*\.ps1"')
    Check "定位 .ps1 用 for /f 读 dir（避开括号陷阱）" $usesForF `
        "必须用 for /f 读 dir /b 的输出；否则路径含 (1) 时命令块会被右括号截断"
    Check "没有 for %%F in (*.ps1) 的危险写法" (-not $usesBadForIn) `
        "该写法在路径含 (1) 时会报「此时不应有 ...」，整个启动器闪退"

    # 8d-3. 🔴 暂停不能用 Read-Host —— 它在 cmd -> powershell -File 链路下不等按键。
    #
    # 实测（2026-10-11）：
    #   同样这条「cmd -> powershell -File」的启动链里，
    #   Read-Host 返回耗时 0.025 秒（[Console]::IsInputRedirected = True），
    #   而 cmd 的 pause 会一直阻塞等到按键。
    #   所以启动器要停住窗口，必须走 cmd 的 pause，不能只靠 Read-Host。
    Check "启动器暂停不依赖 Read-Host（它在 -File 链路下不等按键）" `
        ($ps1Text -match 'cmd\.exe\s+/c\s+pause' -or $ps1Text -match 'cmd\s+/c\s+pause') `
        "Read-Host 在 cmd -> powershell -File 下 0.025 秒就返回，起不到暂停作用；应改用 cmd 的 pause"

    # 8d-4. 启动.bat 退出时要无条件暂停 —— 正常退出（退出码 0）也不能让窗口消失。
    #
    # 旧实现只在失败时 pause，于是「用户选 q 正常退出」这条最常见的路径
    # 会一路走到 exit，窗口瞬间消失。必须无条件 pause。
    $pauseCount = ([regex]::Matches($batText, '(?m)^\s*pause\s*$')).Count
    Check "启动.bat 至少有一处无条件 pause" ($pauseCount -ge 1) "无条件 pause 数量：$pauseCount"

    # 8e. 🔴 必须自动清除「来自互联网」标记（MOTW / Zone.Identifier）
    #
    # 为什么要有这一条：
    #   从网盘下载解压出来的文件，每一个都会带 NTFS 附加流
    #   Zone.Identifier（ZoneId=3 = Internet）。Windows 因此把它们当可疑文件，
    #   实测用户报的症状就是「双击打开就闪退」，偶尔还能看到安全提示一闪而过。
    #   解决方案必须能在启动真正的流程之前，把整个目录的这层标记清掉。
    #   少这一步，用户就得多手动「右键→属性→解除锁定」一次，
    #   而小白根本不知道要这么做 —— 所以他只会说「打不开」。
    #
    # 为什么检查的是「.bat 或 .ps1 二者之一」：
    #   实测结论 —— .bat 里用 cmd.exe -> powershell.exe -Command
    #   "Unblock-File ..." 这种一行式调用，40 个带标记的文件一个都没清掉
    #   （静默失效）；同一句写在 .ps1 里执行则 52 个全部清干净。
    #   所以真正的实现放在 .ps1，.bat 只负责用 -UnblockOnly 调它。
    #   只要「两者合起来」能把整个目录清干净就算通过，不限定写在哪个文件。
    $unblockInBat = ($batText -match 'Unblock-File')
    $unblockInPs1 = ($ps1Text -match 'Unblock-File')

    Check "有自动解除「来自网络」标记的实现（Unblock-File）" ($unblockInBat -or $unblockInPs1) `
        "缺少 Unblock-File，下载后的文件会因 MOTW 被拦，表现为双击闪退"

    # 无论实现在哪，都必须覆盖整个目录（只清单个文件是不够的：
    # .ps1 / .sh / tests 下的子文件同样带标记）
    Check "解除范围覆盖整个目录（-Recurse）" (($batText -match '-Recurse') -or ($ps1Text -match '-Recurse')) `
        "只解除单个文件不够 —— .ps1/.sh 子文件同样带标记"

    # .bat 必须真的会触发这一步（否则 .ps1 里写了也不会执行）
    Check "启动.bat 会触发解阻塞步骤（-UnblockOnly）" ($batText -match '-UnblockOnly') `
        "解阻塞实现在 .ps1，.bat 必须用 -UnblockOnly 调用它"
}

Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ("  通过 $pass 项，失败 $fail 项") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ""

if ($fail -gt 0) { exit 1 }
exit 0
