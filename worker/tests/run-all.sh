#!/usr/bin/env bash
# 本地自检一键运行（Windows / Git Bash / macOS / Linux 可用）
# 用法：bash tests/run-all.sh
set -u

# ⚠️ 不要写死 node 的绝对路径 —— 换台机器、换个用户就找不到，
#    会变成「只有原作者能跑测试」的假象。这里动态取。
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  echo "找不到 Node.js，无法运行测试。请先安装 Node.js。"
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

total_fail=0

echo "=========================================="
echo " 1/13  菜单文案自检"
echo "=========================================="
"$NODE" tests/test-menu-labels.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 2/13  命令注册一致性自检（不联网）"
echo "=========================================="
"$NODE" tests/test-commands.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 3/13  集成自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-integration.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 4/13  添加账号流程自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-add-account.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 5/13  凭据失效处理自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-credential.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 6/13  巡检回执文案自检（不联网）"
echo "=========================================="
# 钉死「回执里不能出现 [object Object]」与「失败不能显示成成功」
timeout 60 "$NODE" tests/test-inspection-reply.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 7/13  机器身份定位自检（不联网）"
echo "=========================================="
# 钉死「两台同名前缀机器不能串台」，否则会删错机器
timeout 60 "$NODE" tests/test-device-identity.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 8/13  额度口径与关机阈值自检（不联网）"
echo "=========================================="
# 这一组盯的是「会算错、但不报错」的两类问题：
#   - 免费额度按台累加（3 台海外算成 600GB）
#   - 阈值不合法被当成 0，导致每轮巡检都强制关机
timeout 60 "$NODE" tests/test-quota-limit.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 9/13  到流量阈值自动停机 · 边界实测（不联网）"
echo "=========================================="
# 用**线上真实配置参数**（region=ap-southeast-6 / traffic_limit=180）
# 跑完整边界序列：正好等于阈值、刚超一点、严重超标、已停止时超标、
# 阈值被改坏、阈值高于免费额度。直接观察真实链路有没有下发 StopInstance。
timeout 60 "$NODE" tests/test-threshold-live.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 10/13  「设阈值」与菜单精简自检（不联网）"
echo "=========================================="
# 这一组盯的是手机里改阈值这条新链路：
#   · 档位文字各种写法都要认（180GB / 180 / ✅ 180GB / 手动输入）
#   · 非法值（0 / 负数 / NaN / 乱填）必须被拒绝，**不改配置**
#   · 主菜单精简为 9 项后，新入口都在、老标签仍可匹配
timeout 60 "$NODE" tests/test-set-limit.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 11/13  Telegram 发送层自检（不联网）"
echo "=========================================="
# 这一组盯的是「都不报错、都静默失效」的五类问题：
#   - 机器名里一个下划线就让消息被 Telegram 拒收（然后悄悄降级重发）
#   - 报表超过 4096 字符直接被拒，用户一个字都收不到
#   - 正文里的落单星号「吃掉」告警标题的加粗
#   - 余额被重复查询，白白消耗子请求预算
#   - 子请求撞上 50 上限导致整个请求崩掉
timeout 60 "$NODE" tests/test-telegram-limits.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 12/13  部署脚本自检（不联网）"
echo "=========================================="
timeout 240 bash tests/test-scripts.sh
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 13/13  Windows 启动器自检（仅 Windows）"
echo "=========================================="
# 交付包面向 Windows 小白用户，启动器是最先被双击的东西，
# 它的「找不到 Git Bash 时给指引」这条分支必须验证。
# 非 Windows 环境（Git Bash 的 uname 为 MINGW*/MSYS*）跳过，不算失败。
if command -v powershell >/dev/null 2>&1; then
  powershell -NoProfile -ExecutionPolicy Bypass -File tests/test-launcher.ps1
  [ $? -ne 0 ] && total_fail=$((total_fail + 1))
else
  echo "  跳过：当前环境没有 powershell（非 Windows）"
fi

echo "新增修复回归测试"
bash tests/test-login.sh || total_fail=$((total_fail + 1))
bash tests/test-deploy-guard.sh || total_fail=$((total_fail + 1))
for test in tests/test-worker-account.mjs tests/test-bind-chat.mjs tests/test-config-key.mjs tests/test-cdt-traffic.mjs tests/test-manual-stop-rotation.mjs tests/test-stop-gaps.mjs tests/test-early-warning.mjs tests/test-notify-start.mjs tests/test-round2-fixes.mjs tests/test-round3-fixes.mjs tests/test-quota-pools.mjs; do
  "$NODE" "$test" || total_fail=$((total_fail + 1))
done
echo ""
if [ "$total_fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "有 $total_fail 组自检未通过，请查看上面输出。"
fi
exit "$total_fail"
