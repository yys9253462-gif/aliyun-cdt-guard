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
echo " 1/6  菜单文案自检"
echo "=========================================="
"$NODE" tests/test-menu-labels.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 2/6  命令注册一致性自检（不联网）"
echo "=========================================="
"$NODE" tests/test-commands.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 3/6  集成自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-integration.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 4/6  添加账号流程自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-add-account.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 5/6  凭据失效处理自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-credential.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 6/6  部署脚本自检（不联网）"
echo "=========================================="
timeout 240 bash tests/test-scripts.sh
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
if [ "$total_fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "有 $total_fail 组自检未通过，请查看上面输出。"
fi
exit "$total_fail"
