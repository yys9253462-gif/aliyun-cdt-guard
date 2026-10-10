#!/usr/bin/env bash
# ===========================================================================
# 部署脚本自检（不联网）
# ===========================================================================
# 检查的是「脚本本身的结构与行为」，不是机器人代码。
# 为什么需要它：这一轮改造里踩的坑**全都出在脚本层面**——
#   · 顶层 exit 会把引用它的脚本一起杀掉
#   · 函数没定义却已经被调用
#   · 临时文件在只读操作时被创建
#   · 密钥变量没赋值就使用
# 这些 bug 都不报错、不影响正常路径，只有横向检查才能发现。
#
# 用法：bash tests/test-scripts.sh
# ===========================================================================
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

PASS=0
FAIL=0
pass() { printf '  \033[32m✅\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31m❌\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
group() { printf '\n--- %s ---\n' "$1"; }

# ---------------------------------------------------------------------------
group "1. 语法检查"
# ---------------------------------------------------------------------------
if bash -n deploy.sh 2>/dev/null; then
  pass "deploy.sh 语法正确"
else
  fail "deploy.sh 语法有错"
fi

if bash -n configure.sh 2>/dev/null; then
  pass "configure.sh 语法正确"
else
  fail "configure.sh 语法有错"
fi

# ---------------------------------------------------------------------------
group "2. 函数定义完整性（main 里调用的函数必须都存在）"
# ---------------------------------------------------------------------------
for fn in check_env do_login do_create_kv do_set_secrets do_deploy \
          do_selfcheck do_configure print_next_steps probe_worker_url; do
  if grep -qE "^${fn}\(\) \{" deploy.sh; then
    pass "deploy.sh 定义了 ${fn}()"
  else
    fail "deploy.sh 缺少函数 ${fn}()（main 调用了它，运行时会崩）"
  fi
done

for fn in ensure_wrangler show_current ask_one_machine run_configure; do
  if grep -qE "^${fn}\(\) \{" configure.sh; then
    pass "configure.sh 定义了 ${fn}()"
  else
    fail "configure.sh 缺少函数 ${fn}()"
  fi
done

# ---------------------------------------------------------------------------
group "3. 密钥变量：必须被赋值，否则自动自检拿不到密钥"
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

# ---------------------------------------------------------------------------
group "4. 引用安全性：被 source 时不得自行退出、不得建文件"
# ---------------------------------------------------------------------------
# 这条是这轮踩过的真坑：顶层 exit 会杀掉 deploy.sh
top_exit="$(awk '/^[[:space:]]*exit /{print NR": "$0}' configure.sh \
  | awk -F: '$1 < 250' | head -5)"
# 只看「不在函数体内」的 exit —— 简单判据：缩进为 0 的 exit
bad_exit="$(grep -nE '^exit [0-9]+' configure.sh || true)"
if [ -z "$bad_exit" ]; then
  pass "configure.sh 顶层没有裸 exit（被引用时不会杀调用方）"
else
  fail "configure.sh 顶层存在裸 exit，会连带杀掉 deploy.sh：$bad_exit"
fi

if grep -qE 'mktemp -u' configure.sh; then
  pass "临时文件路径是延迟创建的（只读操作不会留垃圾文件）"
else
  fail "临时文件在脚本加载时就被创建了（show 也会留垃圾）"
fi

if grep -qE 'BASH_SOURCE\[0\].*=.*\$\{0\}' configure.sh; then
  pass "configure.sh 有「被直接执行才跑 main」的判断"
else
  fail "configure.sh 缺双用判断，被引用时会自动跑主流程"
fi

# ---------------------------------------------------------------------------
group "5. 独立运行 configure.sh 不联网也不崩（拿不到 wrangler 时优雅退出）"
# ---------------------------------------------------------------------------
out="$(timeout 30 bash configure.sh show 2>&1 || true)"
if printf '%s' "$out" | grep -qE '当前配置|还没有配置过'; then
  pass "configure.sh show 能正常执行并给出中文结果"
else
  fail "configure.sh show 行为异常，输出：$(printf '%s' "$out" | head -3)"
fi

if printf '%s' "$out" | grep -qE '[A-Za-z]{6,}'; then
  # 允许少量英文（如 wrangler 字样），但不能出现整段英文报错
  if printf '%s' "$out" | grep -qE 'Error:|error:|Traceback|not found'; then
    fail "configure.sh 输出了英文报错，用户看不懂"
  else
    pass "没有出现整段英文报错"
  fi
else
  pass "输出全中文"
fi

# 用完清理，不给工作区留垃圾
rm -f .config-temp.json 2>/dev/null || true

# ---------------------------------------------------------------------------
group "6. 部署脚本入口：check 模式只检查不改动"
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

if printf '%s' "$out" | grep -qE '一共 7 步'; then
  pass "流程说明与实际步数一致（7 步）"
else
  fail "流程说明里的步数对不上"
fi

# ---------------------------------------------------------------------------
group "7. 收尾指引：给的三条命令都真实可用"
# ---------------------------------------------------------------------------
for cmd in 'bash configure.sh' 'bash configure.sh show' 'wrangler tail'; do
  if grep -qF "$cmd" deploy.sh; then
    pass "收尾指引包含：${cmd}"
  else
    fail "收尾指引缺少：${cmd}"
  fi
done

# ---------------------------------------------------------------------------
printf '\n==========================================\n'
printf '脚本自检结果: 通过 %d / 失败 %d\n' "$PASS" "$FAIL"
printf '==========================================\n'

[ "$FAIL" -eq 0 ] || exit 1
exit 0
