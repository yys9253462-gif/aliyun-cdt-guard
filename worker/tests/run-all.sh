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
echo " 1/7  菜单文案自检"
echo "=========================================="
"$NODE" tests/test-menu-labels.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 2/7  命令注册一致性自检（不联网）"
echo "=========================================="
"$NODE" tests/test-commands.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 3/7  集成自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-integration.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 4/7  添加账号流程自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-add-account.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 5/7  凭据失效处理自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-credential.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 6/7  部署脚本自检（不联网）"
echo "=========================================="
timeout 240 bash tests/test-scripts.sh
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 7/7  Windows 启动器自检（仅 Windows）"
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

echo ""
if [ "$total_fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "有 $total_fail 组自检未通过，请查看上面输出。"
fi
exit "$total_fail"
