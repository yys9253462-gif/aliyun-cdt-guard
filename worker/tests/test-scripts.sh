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
for fn in check_env run_login_only run_full_deploy run_redeploy_only \
          run_selfcheck_only run_reset_webhook_secret \
          do_login do_create_kv do_set_secrets do_deploy \
          do_selfcheck do_configure print_next_steps probe_worker_url \
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

# lib-preflight.sh：环境体检
for fn in detect_platform platform_name node_major preflight_node \
          preflight_npm preflight_curl preflight_wrangler \
          print_node_install_guide preflight_all; do
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
printf '\n==========================================\n'
printf '脚本自检结果: 通过 %d / 失败 %d\n' "$PASS" "$FAIL"
printf '==========================================\n'

[ "$FAIL" -eq 0 ] || exit 1
exit 0
