#!/bin/sh
# ==============================================================================
# 阿里云 CDT 流量守护 - 卸载脚本
# ==============================================================================
# 做什么：停止定时任务、删除程序与配置、可选保留日志。
# ==============================================================================

set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="/opt/cdt-guard"

echo -e "${YELLOW}即将卸载 CDT 流量守护。${NC}"
echo "将会删除："
echo "  - 每 5 分钟的巡检定时任务"
echo "  - 每天 9:00 的报表定时任务"
echo "  - 程序目录 ${WORK_DIR}"
echo ""
echo -n "确认卸载吗？(y/n): "
read -r answer
if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "已取消。"
    exit 0
fi

# 1. 清理定时任务
if command -v crontab >/dev/null 2>&1; then
    crontab -l 2>/dev/null | grep -v "cdt-guard" > /tmp/cdt_cron_clean || true
    crontab /tmp/cdt_cron_clean 2>/dev/null || true
    rm -f /tmp/cdt_cron_clean
    echo -e "${GREEN}[完成]${NC} 定时任务已清除"
fi

# 2. 停掉可能残留的进程
pkill -f "${WORK_DIR}/guard.py" 2>/dev/null || true
pkill -f "${WORK_DIR}/report.py" 2>/dev/null || true

# 3. 删除程序目录
if [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
    echo -e "${GREEN}[完成]${NC} 程序目录已删除"
fi

echo ""
echo -e "${GREEN}卸载完成。${NC}"
echo "提示：你的阿里云 RAM 子账号仍然存在，如需彻底清理，"
echo "      请登录阿里云控制台手动删除该 RAM 用户及其 AccessKey。"
