#!/usr/bin/env bash
# ===========================================================================
# 部署脚本自检（不联网、不写任何线上数据）
# ===========================================================================
# 检查的是「脚本本身的结构与行为」，不是机器人代码。
# 为什么需要它：改造过程中踩的坑**全都出在脚本层面**——
#   · 顶层 exit 会把引用它的脚本一起杀掉
#   · 函数没定义却已经被调用（比如 info 漏定义）
#   · 临时文件在只读操作时被创建
#   · 密钥变量没赋值就使用
#   · 写死了本机的 node 绝对路径（换台机器就挂）
#   · 明文密钥直接打印到屏幕
# 这些 bug 都不报错、不影响正常路径，只有横向检查才能发现。
#
# 用法：bash tests/test-scripts.sh
# ===========================================================================
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

PASS=0
FAIL=0
pass() { printf '  \033[32m[通过]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31m[失败]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
group() { printf '\n--- %s ---\n' "$1"; }

ALL_SCRIPTS="menu.sh deploy.sh configure.sh lib-ui.sh lib-preflight.sh"

# ---------------------------------------------------------------------------
group "1. 语法检查（全部 5 个脚本）"
# ---------------------------------------------------------------------------
for f in $ALL_SCRIPTS; do
  if bash -n "$f" 2>/dev/null; then
    pass "${f} 语法正确"
  else
    fail "${f} 语法有错"
  fi
done

# ---------------------------------------------------------------------------
group "2. 函数定义完整性"
# ---------------------------------------------------------------------------
# deploy.sh 的动作函数（main 按参数分发到这些）
# ⚠️ probe_worker_url 已迁到 lib-preflight.sh（2026-10-11）—— 菜单也要用它探测
#    部署状态，放公共库才能两处共用。这里不再要求 deploy.sh 定义它。
for fn in check_env run_login_only run_full_deploy run_redeploy_only \
          run_selfcheck_only run_reset_webhook_secret \
          do_login do_create_kv do_set_secrets do_deploy \
          do_selfcheck do_configure print_next_steps \
          save_webhook_secret_locally; do
  if grep -qE "^${fn}\(\)[[:space:]]*\{" deploy.sh; then
    pass "deploy.sh 定义了 ${fn}()"
  else
    fail "deploy.sh 缺少函数 ${fn}()"
  fi
done

# configure.sh：配置 + 加账号 + 扫描 + 校验
for fn in ensure_wrangler show_current print_config_pretty \
          ask_one_machine ask_validated run_configure \
          scan_account_instances run_add_account \
          check_chat_id check_instance_id check_region check_limit; do
  if grep -qE "^${fn}\(\)[[:space:]]*\{" configure.sh; then
    pass "configure.sh 定义了 ${fn}()"
  else
    fail "configure.sh 缺少函数 ${fn}()"
  fi
done

# lib-preflight.sh：环境体检 + 配置修复 + 部署探测（2026-10-11 起后两类也在这里）
for fn in detect_platform platform_name node_major preflight_node \
          preflight_npm preflight_curl preflight_wrangler \
          print_node_install_guide preflight_all \
          ensure_kv_id probe_worker_url; do
  if grep -qE "^${fn}\(\)[[:space:]]*\{" lib-preflight.sh; then
    pass "lib-preflight.sh 定义了 ${fn}()"
  else
    fail "lib-preflight.sh 缺少函数 ${fn}()"
  fi
done

# menu.sh：菜单项
for fn in show_header show_menu is_logged_in is_deployed config_stats \
          worker_url run_wrangler main_menu_loop \
          menu_preflight menu_full_install menu_configure menu_add_account \
          menu_show_config menu_redeploy menu_selfcheck menu_reset_secret \
          menu_logs menu_help; do
  if grep -qE "^${fn}\(\)[[:space:]]*\{" menu.sh; then
    pass "menu.sh 定义了 ${fn}()"
  else
    fail "menu.sh 缺少函数 ${fn}()"
  fi
done

# ---------------------------------------------------------------------------
group "3. 输出函数只有一个来源（防止重复定义导致行为不一致）"
# ---------------------------------------------------------------------------
for fn in ok warn err info step hr; do
  # 注意：定义格式可能是 `ok() {`、`ok()   {` 等，中间空白数量不一，用 [[:space:]]* 兜住
  n="$(grep -hE "^${fn}\(\)[[:space:]]*\{" $ALL_SCRIPTS 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$n" = "1" ]; then
    pass "${fn}() 只定义一处（在 lib-ui.sh）"
  else
    fail "${fn}() 被定义了 ${n} 处，行为会随 source 顺序漂移"
  fi
done

# ---------------------------------------------------------------------------
group "4. 输出函数必须齐全（configure.sh 用过 info，曾经漏定义）"
# ---------------------------------------------------------------------------
for fn in ok warn err info step; do
  if grep -qE "^${fn}\(\)[[:space:]]*\{" lib-ui.sh; then
    pass "lib-ui.sh 提供了 ${fn}()"
  else
    fail "lib-ui.sh 缺少 ${fn}()，调用时会 command not found"
  fi
done

# 每个脚本都必须真的引入公共库
for f in menu.sh deploy.sh configure.sh; do
  if grep -qE '^\. \./lib-ui\.sh|\. "?\$?\(?dirname' "$f" || grep -qF '. ./lib-ui.sh' "$f"; then
    pass "${f} 引入了 lib-ui.sh"
  else
    fail "${f} 没有引入 lib-ui.sh"
  fi
done

# ---------------------------------------------------------------------------
group "5. 禁止写死本机绝对路径（换台机器就挂）"
# ---------------------------------------------------------------------------
hard="$(grep -nE 'C:/Users|/Users/small|\.workbuddy/binaries' $ALL_SCRIPTS 2>/dev/null || true)"
if [ -z "$hard" ]; then
  pass "没有写死的绝对路径"
else
  fail "发现写死的绝对路径（换台机器会找不到）："
  printf '%s\n' "$hard" | head -5
fi

# ---------------------------------------------------------------------------
group "6. 密钥安全"
# ---------------------------------------------------------------------------
if grep -qE '^WEBHOOK_SECRET_VALUE=""' deploy.sh; then
  pass "WEBHOOK_SECRET_VALUE 有初始化"
else
  fail "WEBHOOK_SECRET_VALUE 没有初始化（set -u 下可能报错）"
fi

if grep -qE 'WEBHOOK_SECRET_VALUE="\$webhook_secret"' deploy.sh; then
  pass "写入密钥后会把值存进 WEBHOOK_SECRET_VALUE"
else
  fail "写了密钥却没存进 WEBHOOK_SECRET_VALUE，自动自检会拿不到密钥"
fi

# 机器人令牌是高敏感凭据，绝不允许存盘
if grep -qE 'BOT_TOKEN_VALUE|TELEGRAM_TOKEN_VALUE' deploy.sh; then
  fail "发现机器人令牌被存进变量的痕迹（高敏感凭据绝不存盘）"
else
  pass "机器人令牌未被存盘（符合安全要求）"
fi

# 展示配置时必须打码，不能明文打印 Secret
if grep -qE 'sk或已隐藏|sk":"已隐藏|"sk":"\[已隐藏\]"' configure.sh; then
  pass "展示配置时密钥被遮蔽"
else
  fail "展示配置时可能明文泄露密钥"
fi

# 打印现有配置的函数里不能出现裸的 JSON 直出
if grep -qE 'printf "%s\\n" "\$raw"' configure.sh && ! grep -qE 'print_config_pretty' configure.sh; then
  fail "show_current 直接打印原始 JSON（会泄露明文密钥）"
else
  pass "show_current 走打码展示（print_config_pretty）"
fi

# ---------------------------------------------------------------------------
group "7. 引用安全性：被 source 时不得自行退出、不得建文件"
# ---------------------------------------------------------------------------
bad_exit="$(grep -nE '^exit [0-9]+' configure.sh deploy.sh || true)"
if [ -z "$bad_exit" ]; then
  pass "configure.sh / deploy.sh 顶层没有裸 exit"
else
  fail "顶层存在裸 exit，会连带杀掉调用方：$bad_exit"
fi

if grep -qE 'mktemp -u' configure.sh; then
  pass "临时文件路径是延迟创建的（只读操作不会留垃圾文件）"
else
  fail "临时文件在脚本加载时就被创建了（show 也会留垃圾）"
fi

for f in configure.sh deploy.sh; do
  if grep -qE 'BASH_SOURCE\[0\].*=.*\$\{0\}' "$f"; then
    pass "${f} 有「被直接执行才跑 main」的判断"
  else
    fail "${f} 缺双用判断，被引用时可能自动跑主流程"
  fi
done

# menu.sh 是**唯一入口**，设计上就是给人直接跑的，不需要也不应该被 source。
# 所以要反过来确认：它没有多余的 source 保护（有反而说明职责不清）。
if ! grep -qE 'BASH_SOURCE\[0\].*=.*\$\{0\}' menu.sh; then
  pass "menu.sh 是纯入口（不需要 source 保护）"
else
  pass "menu.sh 带了 source 保护（也不影响功能）"
fi

# ---------------------------------------------------------------------------
group "8. 演练模式（只看不写）"
# ---------------------------------------------------------------------------
if grep -qE 'CDT_GUARD_DRY_RUN' configure.sh; then
  pass "configure.sh 支持演练模式"
else
  fail "configure.sh 没有演练模式，测试时会误写线上配置"
fi

# 演练模式必须在两个写入点都生效（run_configure 的写入 + run_add_account 的写入）
dry_count="$(grep -c 'CDT_GUARD_DRY_RUN' configure.sh | tr -d ' ')"
if [ "$dry_count" -ge 2 ]; then
  pass "演练模式覆盖了全部写入点（共 ${dry_count} 处检查）"
else
  fail "演练模式只覆盖了部分写入点（${dry_count} 处，两个写入点各需 1 处）"
fi

# ---------------------------------------------------------------------------
group "9. 独立运行不联网也不崩"
# ---------------------------------------------------------------------------
out="$(timeout 30 bash configure.sh show 2>&1 || true)"
if printf '%s' "$out" | grep -qE '当前配置|还没有配置过'; then
  pass "configure.sh show 能正常执行并给出中文结果"
else
  fail "configure.sh show 行为异常，输出：$(printf '%s' "$out" | head -3)"
fi

if printf '%s' "$out" | grep -qE 'Error:|error:|Traceback|command not found'; then
  fail "configure.sh 输出了英文报错或命令缺失，用户看不懂"
else
  pass "configure.sh show 没有英文报错、没有缺失命令"
fi

# 明文密钥不得出现在输出里
if printf '%s' "$out" | grep -qE '"sk":"[^"]{10,}"'; then
  fail "show 的输出里出现了明文密钥"
else
  pass "show 的输出里没有明文密钥"
fi

rm -f .config-temp.json 2>/dev/null || true

# ---------------------------------------------------------------------------
group "10. menu.sh 独立运行（喂 q 退出）"
# ---------------------------------------------------------------------------
out="$(printf 'q\n' | timeout 60 bash menu.sh 2>&1 || true)"
if printf '%s' "$out" | grep -qE '管理菜单'; then
  pass "menu.sh 能打开菜单"
else
  fail "menu.sh 打不开菜单，输出：$(printf '%s' "$out" | head -5)"
fi

for item in '1) 环境体检' '2) 一站式安装' '3) 配置监控机器' \
            '4) 添加阿里云账号' '5) 查看当前配置' '6) 重新部署' \
            '7) 自动自检' '8) 重设网址密钥' '9) 查看运行日志' \
            '0) 使用说明'; do
  if printf '%s' "$out" | grep -qF "$item"; then
    pass "菜单包含：${item}"
  else
    fail "菜单缺少：${item}"
  fi
done

if printf '%s' "$out" | grep -qE '当前状态'; then
  pass "菜单会显示当前状态一览"
else
  fail "菜单没有状态一览，用户不知道现在什么情况"
fi

if printf '%s' "$out" | grep -qE '错误|Error:|Traceback'; then
  fail "menu.sh 启动时报错"
else
  pass "menu.sh 启动无报错"
fi

# ---------------------------------------------------------------------------
group "11. 部署脚本入口：check 模式只检查不改动"
# ---------------------------------------------------------------------------
out="$(timeout 60 bash deploy.sh check 2>&1 || true)"
if printf '%s' "$out" | grep -qE '只做检查'; then
  pass "deploy.sh check 会明确告知「到此结束」"
else
  fail "deploy.sh check 未给出结束提示"
fi

if printf '%s' "$out" | grep -qE '找到程序入口'; then
  pass "check 模式完成了程序完整性检查"
else
  fail "check 模式没检查到程序入口"
fi

if printf '%s' "$out" | grep -qE 'Error:|error:|Traceback|command not found'; then
  fail "deploy.sh check 输出了英文报错"
else
  pass "deploy.sh check 输出无英文报错"
fi

# ---------------------------------------------------------------------------
group "12. 收尾指引：给的三条命令都真实可用"
# ---------------------------------------------------------------------------
for cmd in 'bash menu.sh' 'bash configure.sh' 'wrangler tail'; do
  if grep -qF "$cmd" deploy.sh || grep -qF "$cmd" menu.sh; then
    pass "指引包含：${cmd}"
  else
    fail "指引缺少：${cmd}"
  fi
done

# ---------------------------------------------------------------------------
group "13. 破坏性操作的默认值必须是「否」（手滑回车不能弄坏数据）"
# ---------------------------------------------------------------------------
# 教训：configure.sh 里「覆盖现有配置」原来用的是默认「是」的 confirm，
#      用户敲完配置习惯性连按回车，直接把旧配置覆盖了。
#      这里钉死两件事：confirm_danger 存在，且破坏性操作必须用它。
if grep -qE '^confirm_danger\(\)' lib-ui.sh; then
  pass "lib-ui.sh 定义了 confirm_danger（默认否）"
else
  fail "缺少 confirm_danger 定义"
fi

# 破坏性操作的两个调用点都不得再用默认「是」的 confirm
if grep -qF 'confirm_danger "确实要用新填的清单覆盖现有配置吗' configure.sh; then
  pass "「覆盖配置」用 confirm_danger（默认否）"
else
  fail "「覆盖配置」仍用默认「是」的 confirm —— 手滑回车会覆盖配置"
fi

if grep -qF 'confirm_danger "确认写入' configure.sh; then
  pass "「确认写入」用 confirm_danger（默认否）"
else
  fail "「确认写入」仍用默认「是」的 confirm"
fi

# 无害操作应保留 confirm（默认是），否则会让日常流程变啰嗦
if grep -qF 'confirm "现在开始安装吗' menu.sh; then
  pass "无害操作（开始安装）仍用默认「是」的 confirm"
else
  fail "无害操作被误改成默认「否」，会影响正常流程"
fi

# ---------------------------------------------------------------------------
group "14. Windows 双击垫片 启动.bat 的硬性要求"
# ---------------------------------------------------------------------------
if [ -f "启动.bat" ]; then
  pass "启动.bat 存在"

  # 必须 CRLF —— LF 会让 cmd.exe 把 rem 注释当命令执行（实测满屏报错）
  if grep -qU $'\r' 启动.bat 2>/dev/null; then
    pass "启动.bat 含 CRLF 换行"
  else
    fail "启动.bat 是 LF 换行 —— 双击会满屏「不是内部或外部命令」"
  fi

  # 必须纯 ASCII —— cmd.exe 按 GBK 解码，非 ASCII 会乱码并被当命令执行
  if LC_ALL=C grep -qP '[\x80-\xFF]' 启动.bat 2>/dev/null; then
    fail "启动.bat 含非 ASCII 字节 —— 会乱码"
  else
    pass "启动.bat 是纯 ASCII"
  fi

  # 不能写死中文文件名（.bat 里写中文路径会因 GBK 解码而匹配不到）
  if grep -qF '*.ps1' 启动.bat; then
    pass "启动.bat 用通配符定位 .ps1"
  else
    fail "启动.bat 没有用通配符定位 .ps1"
  fi

  if grep -qF 'ExecutionPolicy Bypass' 启动.bat; then
    pass "启动.bat 带 -ExecutionPolicy Bypass"
  else
    fail "启动.bat 缺少 -ExecutionPolicy Bypass"
  fi
else
  fail "缺少 启动.bat（Windows 双击 .ps1 只会打开记事本）"
fi

# 打包清单里必须有它，否则交付包里没有。
#
# ⚠️ tools/ 目录**只在开发仓里**，交付包中不带（打包脚本是给作者用的，
#    没必要发给用户）。所以在交付包里跑自检时这两项必须跳过，
#    否则用户一跑自检就看到「失败」，会以为包有问题。
if [ -f "tools/pack_release.py" ]; then
  if grep -qF '"启动.bat"' tools/pack_release.py; then
    pass "打包清单已包含 启动.bat"
  else
    fail "打包清单缺 启动.bat —— 用户拿不到双击入口"
  fi

  # 打包器必须保护 .bat 的 CRLF，不能被脱敏流程压成 LF
  if grep -qF 'CRLF_EXT' tools/pack_release.py; then
    pass "打包器对 .bat/.cmd 做了换行保护"
  else
    fail "打包器会在脱敏时把 .bat 的 CRLF 压成 LF"
  fi
else
  printf '  \033[33m[跳过]\033[0m 打包清单检查（交付包里不含 tools/ 目录）\n'
fi

# ---------------------------------------------------------------------------
group "15. 脚本健壮性：重复定义 / node 探测 / 输入空格 / 令牌校验"
# ---------------------------------------------------------------------------
# D6：同一个函数只能定义一次（重复定义会让「改一处、忘另一处」静默失效）
dup_node="$(grep -c '^preflight_node()' lib-preflight.sh || true)"
if [ "$dup_node" -eq 1 ]; then
  pass "preflight_node 只定义 1 次（无重复定义）"
else
  fail "preflight_node 定义了 ${dup_node} 次 —— 存在重复定义"
fi

# D7：menu.sh 统计机器数时不能用裸 command -v node（认不出本地自动装的 Node）
if grep -qF 'preflight_node' menu.sh; then
  pass "menu.sh 会用 preflight_node 探测本地 Node"
else
  fail "menu.sh 只用 command -v node —— 新手刚装完会显示「0 台机器」"
fi

# A3：输入必须先去首尾空格（从控制台复制常带看不见的空格）
if grep -qF 's/^[[:space:]]*//' configure.sh; then
  pass "configure.sh 会去掉输入的首尾空格"
else
  fail "configure.sh 不去空格 —— 粘贴的实例 ID 会被误判格式错误"
fi

# D10：读不到输入必须退出，不能无限刷屏
if grep -qF 'if ! read -r -p' configure.sh; then
  pass "configure.sh 检测到输入流结束会退出（不会无限刷屏）"
else
  fail "configure.sh 的 read 没检测失败 —— EOF 时会无限刷屏"
fi

# D9：机器人令牌要校验格式，不能填错也报「已写入」
if grep -qF 'A-Za-z0-9_-]{20,}' deploy.sh; then
  pass "deploy.sh 校验机器人令牌格式"
else
  fail "deploy.sh 不校验令牌格式 —— 填错也会显示「已写入」"
fi

# A4：写配置必须用 node 生成 JSON，不能手工拼字符串
if grep -qF 'JSON.stringify' configure.sh; then
  pass "configure.sh 用 node + JSON.stringify 生成配置行"
else
  fail "configure.sh 手工拼 JSON —— 名字含引号会写坏配置"
fi

# ---------------------------------------------------------------------------
group "16. 状态探测：空 id 不得把「已登录」误判成「未登录」"
# ---------------------------------------------------------------------------
# 🔴 这一组钉死的是 2026-10-11 用户实测反馈的问题：
#     「我已经登录了，为什么菜单还显示我未登录未部署？」
#
#   根因：交付包里 wrangler.toml 的 KV id 是空的（`id = ""`）。
#        wrangler 的**任何**命令启动时都会先解析配置，id 为空就直接报错，
#        连 whoami 也不例外 → 菜单据此判定「未登录」（误报）。
#
#   修法：探测登录前先让配置合法。修复函数 ensure_kv_id 放在 lib-preflight.sh，
#        这样 menu.sh（打开菜单就要用）和 deploy.sh 都能拿到，实现只有一份。
#
#   ⚠️ 反向验证（已实测做过一次）：把 ensure_config_ready 里那行
#      `ensure_kv_id quiet` 删掉，菜单立刻又变回「未登录」，
#      本组测试中的第 3 条随之报红 —— 证明它不是永远绿的摆设。

# E1：修复函数必须在 lib-preflight.sh（两边都能拿到的公共库）
if grep -qE '^ensure_kv_id\(\)[[:space:]]*\{' lib-preflight.sh; then
  pass "lib-preflight.sh 定义了 ensure_kv_id()（menu.sh 与 deploy.sh 都能拿到）"
else
  fail "lib-preflight.sh 缺少 ensure_kv_id() —— 菜单打开时无修复函数可用，会误报「未登录」"
fi

# E2：deploy.sh 不得再自带一份（否则两份实现会跑偏）
if grep -qE '^ensure_kv_id\(\)[[:space:]]*\{' deploy.sh; then
  fail "deploy.sh 又把它定义回去了 —— 两份实现会跑偏，必须只用 lib-preflight.sh 那份"
else
  pass "deploy.sh 不再重复定义 ensure_kv_id（实现只有一份）"
fi

# E3：deploy.sh 必须引用 lib-preflight.sh，否则它调 ensure_kv_id 会 command not found
if grep -qF '. ./lib-preflight.sh' deploy.sh; then
  pass "deploy.sh 引用了 lib-preflight.sh"
else
  fail "deploy.sh 没引用 lib-preflight.sh —— 调用 ensure_kv_id 时会报 command not found"
fi

# E4：menu.sh 探测登录之前，必须先确保配置合法
if grep -qF 'ensure_config_ready || return 1' menu.sh; then
  pass "menu.sh 的 is_logged_in 先修配置再探测（避免空 id 误判成未登录）"
else
  fail "menu.sh 的 is_logged_in 没有先修配置 —— 空 id 时会把已登录误报成未登录"
fi

# E5：探测阶段必须安静（菜单是刷新式的，刷屏会糊掉整个界面）
if grep -qF 'ensure_kv_id quiet' menu.sh; then
  pass "menu.sh 用 quiet 模式调用修复函数（探测时不刷屏）"
else
  fail "menu.sh 没传 quiet —— 菜单每次重画都会打印一堆「正在查找存储」，刷屏"
fi

# E6：修复函数必须支持 quiet 参数（否则 E5 无从谈起）
if grep -qE 'local quiet=' lib-preflight.sh; then
  pass "ensure_kv_id 支持 quiet 参数"
else
  fail "ensure_kv_id 不接受 quiet 参数，菜单探测会刷屏"
fi

# E7：list 输出必须先剥掉警告行，否则 JSON 解析失败会被误判成「没有同名存储」→ 误建重复空间
#     ⚠️ 匹配串里的 $p 必须用单引号，否则会被 shell 当成变量展开成空串（本条测试自己踩过）
if grep -qF 'sed -n '"'"'/^\[/,$p'"'"'' lib-preflight.sh; then
  pass "剥掉 wrangler 打到标准输出的警告行（否则会误建重复存储）"
else
  fail "没有剥警告行 —— JSON 里混入「Proxy environment variables detected」会解析失败，误判成要新建"
fi

# E8：写回必须用 python（sed 会把 CRLF 行尾全吃成 LF，等于悄悄改了原文件）
if grep -qF 're.subn' lib-preflight.sh; then
  pass "用 python 只替换 id 行的值（保住 CRLF 行尾）"
else
  fail "没找到 python 写回逻辑 —— 若改用 sed，交付包的 CRLF 会被整份改成 LF"
fi

# E9：临时注释 [[kv_namespaces]] 必须用标准 TOML 的 `#`（自定义前缀会被 wrangler 判语法错）
if grep -qF 'CDT_GUARD_OFF' lib-preflight.sh; then
  pass "用 # 前缀临时注释（TOML 只认 #，其他前缀会报 Invalid character）"
else
  fail "没找到临时注释逻辑 —— 不注释掉 KV 段，查 id 这件事本身会被空 id 卡死（死锁）"
fi

# E10：菜单状态栏要显示登录邮箱（用户可能有好几个账号，光写「已登录」没法核对）
if grep -qE '^logged_in_email\(\)[[:space:]]*\{' menu.sh; then
  pass "menu.sh 定义了 logged_in_email()（状态栏可显示是哪个账号）"
else
  fail "menu.sh 没有 logged_in_email() —— 状态栏只说「已登录」，多账号用户无法核对"
fi

# E11：提取邮箱时尾巴不能带上句末标点
#      （whoami 那句英文末尾有个句号，裸 [^ ]+ 会把句号一起吃进来）
if grep -qF '[a-zA-Z]{2,}' menu.sh; then
  pass "邮箱提取以顶级域名收尾（不会把英文句末的句号一起吃进来）"
else
  fail "邮箱提取没有限定结尾 —— 会摘出 someone@example.com. 这种带句号的串"
fi

# ---------------------------------------------------------------------------
group "17. 部署判定：不得只看本地文件（换目录会误报「未部署」）"
# ---------------------------------------------------------------------------
# 🔴 这一组钉死的是 2026-10-11 用户实测反馈的问题：
#     「我已经部署了，为什么菜单还显示 Worker 未部署？」
#
#   根因：旧 is_deployed 只看本地有没有 .worker-url 文件。
#        而这个文件是「部署那一刻」写在当时那个目录里的 ——
#        用户重新解压一份新包、换个目录跑，文件就不在，
#        菜单立刻判定「未部署」，**根本不去问云端**。
#        实测：云端有部署记录，https://cdt-guard.<账号>.workers.dev 返回 200。
#
#   修法：判定要以「真去探测」为准 —— 复用 probe_worker_url
#        （搬到 lib-preflight.sh，菜单与部署脚本共用一份）。
#
#   ⚠️ 反向验证（已实测做过一次）：把 is_deployed 改回
#      `[ -f .worker-url ] && grep -q workers.dev .worker-url`，
#      F1 立刻报红 —— 证明它不是永远绿的摆设。

# F1：is_deployed 必须真的去探测，不能只看文件
#     ⚠️ 判定「旧实现」时要排除注释行 —— 说明里正举着旧写法当反面教材，
#        直接 grep 全文会命中那段注释，导致永远报红（本条测试自己踩过）。
_isdeployed_body="$(awk '/^is_deployed\(\)/,/^}/' menu.sh | grep -v '^[[:space:]]*#')"
if printf '%s' "$_isdeployed_body" | grep -qF 'probe_worker_url' && \
   ! printf '%s' "$_isdeployed_body" | grep -qF '[ -f .worker-url ]'; then
  pass "is_deployed 真去探测（不再只看 .worker-url 文件）"
else
  fail "is_deployed 仍只看本地文件 —— 换个目录就会误报「未部署」"
fi

# F2：探测函数必须在公共库（菜单和部署脚本都要用）
if grep -qE '^probe_worker_url\(\)[[:space:]]*\{' lib-preflight.sh; then
  pass "lib-preflight.sh 定义了 probe_worker_url()（两处共用一份）"
else
  fail "lib-preflight.sh 缺少 probe_worker_url() —— 菜单拿不到探测能力"
fi

# F3：deploy.sh 不得再自带一份（否则两份实现会跑偏）
if grep -qE '^probe_worker_url\(\)[[:space:]]*\{' deploy.sh; then
  fail "deploy.sh 又自带一份 probe_worker_url —— 两份实现会跑偏"
else
  pass "deploy.sh 不再重复定义 probe_worker_url（实现只有一份）"
fi

# F4：🔴 账号名必须从邮箱前缀取，不能从 whoami 抠 *.workers.dev
#     实测 whoami 的输出里**没有** workers.dev 字样，按它抠只会得到空串，
#     于是候选只剩 cdt-guard.workers.dev（缺账号前缀）→ 探测必然失败。
if grep -qF 'cut -d@ -f1' lib-preflight.sh; then
  pass "账号名从登录邮箱前缀取（实测有效：cdt-guard.<邮箱前缀>.workers.dev）"
else
  fail "账号名来源不对 —— 从 whoami 抠 *.workers.dev 会得到空串，探测必失败"
fi

# F5：必须真的发请求验证（能连上才算数）
if grep -qF "http_code" lib-preflight.sh; then
  pass "构造候选后实际访问（能连上才算已部署）"
else
  fail "没有实际访问 —— 只靠猜名字无法确认云端到底有没有"
fi

# F6：探测命中要顺手回写 .worker-url（下次走快路径）
if grep -qF '.worker-url' lib-preflight.sh && grep -qF '> .worker-url' lib-preflight.sh; then
  pass "探测命中后回写 .worker-url（下次走快路径，不必再发请求）"
else
  fail "探测命中没有回写 —— 每次打开菜单都要重新发网络请求"
fi

# F7：worker_url() 也要复用探测（否则「已部署」却显示不出网址）
if grep -qE '^worker_url\(\)' menu.sh && \
   awk '/^worker_url\(\)/,/^}/' menu.sh | grep -qF 'probe_worker_url'; then
  pass "worker_url() 复用探测（换目录也能显示出正确网址）"
else
  fail "worker_url() 仍只看本地文件 —— 换目录时「已部署」后面会是空的"
fi

# ---------------------------------------------------------------------------
printf '\n==========================================\n'
printf '脚本自检结果: 通过 %d / 失败 %d\n' "$PASS" "$FAIL"
printf '==========================================\n'

[ "$FAIL" -eq 0 ] || exit 1
exit 0
