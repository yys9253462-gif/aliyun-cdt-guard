#!/usr/bin/env bash
# 本地自检一键运行（Windows / Git Bash 可用）
# 用法：bash tests/run-all.sh
set -u

NODE="C:/Users/small/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

total_fail=0

echo "=========================================="
echo " 1/3  菜单文案自检"
echo "=========================================="
"$NODE" tests/test-menu-labels.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 2/3  集成自检（不联网）"
echo "=========================================="
timeout 60 "$NODE" tests/test-integration.mjs
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
echo "=========================================="
echo " 3/3  部署脚本自检（不联网）"
echo "=========================================="
timeout 180 bash tests/test-scripts.sh
[ $? -ne 0 ] && total_fail=$((total_fail + 1))

echo ""
if [ "$total_fail" -eq 0 ]; then
  echo "全部自检通过。"
else
  echo "有 $total_fail 组自检未通过，请查看上面输出。"
fi
exit "$total_fail"
