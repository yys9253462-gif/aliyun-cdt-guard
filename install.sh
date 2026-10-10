#!/bin/bash
# ==============================================================================
# 阿里云 CDT 流量守护 - 一键安装 / 管理脚本
# 项目：https://github.com/yys9253462-gif/aliyun-cdt-guard
# ==============================================================================
# 小白友好设计：
#   1. 全程中文提示，每一步告诉你要去哪里复制什么、粘贴到哪里。
#   2. 输入错了不会崩，会重新问一遍。
#   3. 装完自动跑一次自检，把结果直接告诉你。
#   4. 二次运行自动进入管理菜单，不用记参数。
# ==============================================================================

set -u

REPO_RAW="https://raw.githubusercontent.com/yys9253462-gif/aliyun-cdt-guard/main/src"
WORK_DIR="/opt/cdt-guard"
VENV_DIR="${WORK_DIR}/venv"
CONFIG_FILE="${WORK_DIR}/config.json"
SELF_URL="https://raw.githubusercontent.com/yys9253462-gif/aliyun-cdt-guard/main/install.sh"

# ------------------------------ 颜色与工具函数 ------------------------------
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; NC=''
fi

info()  { echo -e "${GREEN}[完成]${NC} $1"; }
warn()  { echo -e "${YELLOW}[注意]${NC} $1"; }
error() { echo -e "${RED}[错误]${NC} $1"; }
step()  { echo -e "\n${BOLD}${BLUE}==== $1 ====${NC}"; }

# 读取输入，支持默认值；空输入时返回默认值
ask() {
    local prompt="$1" default="${2:-}" answer
    if [ -n "$default" ]; then
        read -r -p "$(echo -e "${CYAN}$prompt${NC} [默认: $default]: ")" answer
        echo "${answer:-$default}"
    else
        read -r -p "$(echo -e "${CYAN}$prompt${NC}: ")" answer
        echo "$answer"
    fi
}

# 校验必填项，空值反复询问
ask_required() {
    local prompt="$1" answer
    while true; do
        answer=$(ask "$prompt")
        if [ -n "$answer" ]; then
            echo "$answer"; return
        fi
        error "这一项不能为空，请重新输入。"
    done
}

confirm() {
    local prompt="$1" answer
    read -r -p "$(echo -e "${YELLOW}$prompt${NC} (y/n): ")" answer
    [[ "$answer" =~ ^[Yy]$ ]]
}

# ------------------------------ 环境准备 ------------------------------
require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        error "请用 root 权限运行。切换方法：输入 sudo -i 后回车，再重新执行本脚本。"
        exit 1
    fi
}

detect_os() {
    if [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "redhat"
    elif [ -f /etc/alpine-release ]; then
        echo "alpine"
    else
        echo "unknown"
    fi
}

install_system_deps() {
    local os_type
    os_type=$(detect_os)
    step "第 1 步 / 共 5 步：安装系统组件"

    case "$os_type" in
        debian)
            info "识别到 Debian / Ubuntu 系统"
            apt-get update -y >/dev/null 2>&1
            apt-get install -y python3 python3-venv python3-pip cron wget curl >/dev/null 2>&1
            systemctl enable cron >/dev/null 2>&1 || true
            systemctl start cron >/dev/null 2>&1 || true
            ;;
        redhat)
            info "识别到 CentOS / RHEL / Rocky 系统"
            yum install -y python3 python3-pip cronie wget curl >/dev/null 2>&1
            systemctl enable crond >/dev/null 2>&1 || true
            systemctl start crond >/dev/null 2>&1 || true
            ;;
        alpine)
            info "识别到 Alpine 系统"
            apk add --no-cache python3 py3-pip py3-virtualenv dcron wget curl bash >/dev/null 2>&1
            rc-update add dcron default >/dev/null 2>&1 || true
            rc-service dcron start >/dev/null 2>&1 || true
            ;;
        *)
            warn "未能识别系统类型，跳过自动安装。若后续报错缺少命令，请手动安装 python3 / pip / cron / wget。"
            ;;
    esac
    info "系统组件就绪"
}

setup_python_env() {
    step "第 2 步 / 共 5 步：准备运行环境"
    mkdir -p "$WORK_DIR"

    if [ ! -d "$VENV_DIR" ]; then
        python3 -m venv "$VENV_DIR" 2>/dev/null || {
            error "创建 Python 虚拟环境失败。Debian/Ubuntu 请先执行：apt-get install -y python3-venv"
            exit 1
        }
    fi

    info "正在安装依赖库，大约需要 1-2 分钟，请耐心等待..."
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1
    "$VENV_DIR/bin/pip" install --quiet \
        requests \
        aliyun-python-sdk-core \
        aliyun-python-sdk-ecs \
        aliyun-python-sdk-bssopenapi 2>/dev/null

    if [ $? -ne 0 ]; then
        warn "部分依赖安装失败，尝试使用国内镜像源重装..."
        "$VENV_DIR/bin/pip" install --quiet -i https://mirrors.aliyun.com/pypi/simple/ \
            requests aliyun-python-sdk-core aliyun-python-sdk-ecs aliyun-python-sdk-bssopenapi 2>/dev/null
    fi

    info "依赖库安装完成"
}

download_sources() {
    step "第 3 步 / 共 5 步：下载运行程序"
    for file in common.py notifier.py aliyun_api.py guard.py report.py list_instances.py; do
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${REPO_RAW}/${file}" -o "${WORK_DIR}/${file}" || {
                error "下载 ${file} 失败，请检查网络能否访问 GitHub。"
                exit 1
            }
        else
            wget -qO "${WORK_DIR}/${file}" "${REPO_RAW}/${file}" || {
                error "下载 ${file} 失败，请检查网络能否访问 GitHub。"
                exit 1
            }
        fi
    done
    info "程序下载完成"
}

# ------------------------------ 交互式配置 ------------------------------
collect_telegram() {
    step "第 4 步 / 共 5 步：配置通知渠道"
    echo -e "${BOLD}先配置通知，否则机器被关了你也不知道。${NC}"
    echo ""
    echo "【Telegram 配置方法】（主力告警渠道，必配）"
    echo "  1. 在 Telegram 搜索 @BotFather -> 发送 /newbot -> 按提示创建机器人"
    echo "  2. BotFather 会给你一串 Token，形如 123456:ABC-DEF...，复制它"
    echo "  3. 在 Telegram 搜索 @userinfobot -> 发送任意消息 -> 它会回复你的数字 ID"
    echo ""

    TG_TOKEN=$(ask "粘贴 Bot Token（直接回车表示跳过 Telegram）")
    TG_CHAT=""
    if [ -n "$TG_TOKEN" ]; then
        TG_CHAT=$(ask_required "粘贴你的数字 ID（Chat ID）")
    fi

    if [ -z "$TG_TOKEN" ]; then
        warn "没有配置 Telegram！所有告警（含流量超标、止损失败）都将无法送达。"
        if ! confirm "确认跳过 Telegram 继续？"; then
            collect_telegram
            return
        fi
    fi

    echo ""
    echo "【QQ 推送配置（可选，二选一或都配）】"
    echo -e "${BOLD}方案 A：NapCat / OneBot（推荐）${NC}"
    echo "  自己搭的 QQ 机器人框架，无配额限制、无需审核，可以直接发告警。"
    echo "  用法：先在任意机器上跑起 NapCat（或 Lagrange），开启 HTTP 服务，"
    echo "        然后在框架配置里找到 HTTP 地址（形如 http://127.0.0.1:3000）和 Token。"
    echo ""
    echo -e "${BOLD}方案 B：QQ 官方机器人（备选）${NC}"
    echo -e "${YELLOW}  限制：腾讯对主动消息有严格频控，群聊每月仅 4 条。${NC}"
    echo "  因此官方通道只用来发日报摘要，不承担告警。"
    echo ""

    OB_URL=$(ask "【方案A】OneBot HTTP 地址（可留空）")
    OB_TOKEN=""; OB_TARGET=""; OB_TARGET_TYPE="group"
    if [ -n "$OB_URL" ]; then
        OB_TOKEN=$(ask "OneBot 访问 Token（没设置就回车）")
        echo "  推送目标类型：1) 群聊  2) 私聊"
        local ob_type
        ob_type=$(ask "选择 1 或 2" "1")
        if [ "$ob_type" = "2" ]; then
            OB_TARGET_TYPE="private"
            OB_TARGET=$(ask_required "对方的 QQ 号")
        else
            OB_TARGET_TYPE="group"
            OB_TARGET=$(ask_required "群号")
        fi
        info "OneBot 通道已配置，将参与告警与日报推送"
    fi

    echo ""
    QQ_APPID=$(ask "【方案B】QQ 官方 AppID（可留空）")
    QQ_SECRET=""; QQ_TARGET=""; QQ_TARGET_TYPE="group"
    if [ -n "$QQ_APPID" ]; then
        QQ_SECRET=$(ask_required "AppSecret")
        echo "  推送目标类型：1) 群聊  2) 单聊"
        local qq_type
        qq_type=$(ask "选择 1 或 2" "1")
        if [ "$qq_type" = "2" ]; then
            QQ_TARGET_TYPE="user"
            QQ_TARGET=$(ask_required "对方的 OpenID")
        else
            QQ_TARGET_TYPE="group"
            QQ_TARGET=$(ask_required "群的 OpenID")
        fi
    fi
}

# 找一个能用的 Python 解释器（优先虚拟环境，其次系统）
# 输出解释器绝对路径；都不可用则返回非零
find_working_python() {
    local candidates="${VENV_DIR}/bin/python python3 python"
    local candidate
    for candidate in $candidates; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if "$candidate" -c "import aliyunsdkcore" >/dev/null 2>&1; then
                echo "$candidate"
                return 0
            fi
        fi
    done
    # 虚拟环境存在但上面没命中（例如刚装完依赖），兜底返回虚拟环境
    if [ -x "${VENV_DIR}/bin/python" ]; then
        echo "${VENV_DIR}/bin/python"
        return 0
    fi
    return 1
}

# 自动查询账号下的实例并让用户选择
# 成功：stdout 输出两行 —— 第 1 行地域代码，第 2 行实例 ID
# 失败：stdout 为空（调用方回退到手动输入）
auto_pick_instance() {
    local ak="$1" sk="$2"
    local script="${WORK_DIR}/list_instances.py"
    local py

    py=$(find_working_python 2>/dev/null) || return 0
    if [ -z "$py" ] || [ ! -f "$script" ]; then
        return 0
    fi

    local raw
    raw=$("$py" "$script" "$ak" "$sk" 2>/dev/null) || return 0
    if [ -z "$raw" ]; then
        return 0
    fi

    # 解析每行 JSON -> "地域|友好名|实例ID|名称|状态"
    local list="" n=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local region region_name iid iname status
        region=$(echo "$line" | sed -n 's/.*"region": *"\([^"]*\)".*/\1/p')
        region_name=$(echo "$line" | sed -n 's/.*"region_name": *"\([^"]*\)".*/\1/p')
        iid=$(echo "$line" | sed -n 's/.*"instance_id": *"\([^"]*\)".*/\1/p')
        iname=$(echo "$line" | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p')
        status=$(echo "$line" | sed -n 's/.*"status": *"\([^"]*\)".*/\1/p')
        [ -z "$iid" ] && continue
        n=$((n + 1))
        if [ -n "$iname" ]; then
            printf '  %2d) %s  %s  [%s]  %s\n' "$n" "$region_name" "$iid" "$status" "$iname"
        else
            printf '  %2d) %s  %s  [%s]\n' "$n" "$region_name" "$iid" "$status"
        fi
        list="${list}${region}|${iid}
"
    done <<< "$raw"

    if [ "$n" -eq 0 ]; then
        return 0
    fi

    echo ""
    echo -e "${GREEN}共找到 ${n} 台实例，请选择要监控的那一台：${NC}"
    echo -e "${CYAN}（输入 0 可改为手动填写）${NC}"
    local choice
    choice=$(ask "输入编号" "1")
    case "$choice" in
        ''|*[!0-9]*) return 0 ;;
    esac
    if [ "$choice" -eq 0 ] 2>/dev/null; then
        return 0
    fi
    if [ "$choice" -lt 1 ] || [ "$choice" -gt "$n" ]; then
        warn "编号超出范围，改为手动填写。"
        return 0
    fi

    local sel
    sel=$(echo "$list" | sed -n "${choice}p")
    local sel_region sel_iid
    sel_region=$(echo "$sel" | cut -d'|' -f1)
    sel_iid=$(echo "$sel" | cut -d'|' -f2)
    if [ -z "$sel_region" ] || [ -z "$sel_iid" ]; then
        return 0
    fi
    echo "$sel_region"
    echo "$sel_iid"
}

# 采集单个实例配置，结果写入全局 NEW_USER
collect_one_instance() {
    local idx="$1"
    echo ""
    echo -e "${BOLD}--- 第 ${idx} 台实例 ---${NC}"

    NAME=$(ask "起个备注名（方便你在通知里认出它，例如 香港节点）")
    NAME=${NAME:-机器$idx}

    echo ""
    echo "【AccessKey 在哪里拿】"
    echo "  阿里云控制台 -> 右上角头像 -> 访问控制 RAM -> 用户 -> 创建用户"
    echo "  勾选「使用永久 AccessKey 访问」-> 创建完成后立刻复制 ID 和 Secret（只显示一次）"
    echo ""
    echo -e "${YELLOW}安全提醒：请务必用 RAM 子账号，不要用主账号的 AccessKey！${NC}"
    AK=$(ask_required "AccessKey ID")
    SK=$(ask_required "AccessKey Secret")

    echo ""
    echo "【账号类型】决定账单显示人民币还是美元"
    echo "  1) 阿里云中国站（人民币）"
    echo "  2) 阿里云国际站（美元）"
    local acc_type
    acc_type=$(ask "选择 1 或 2" "1")
    if [ "$acc_type" = "2" ]; then
        BILL_ENDPOINT="business.ap-southeast-1.aliyuncs.com"
        CURRENCY="$"
    else
        BILL_ENDPOINT="business.aliyuncs.com"
        CURRENCY="¥"
    fi

    echo ""
    echo "【怎么找你的机器】"
    echo "  正在用你刚填的 AccessKey 自动查询账号下的所有实例（约 10 秒）..."
    echo "  查到了就直接选，查不到再手动填，不影响使用。"

    local picked
    picked=$(auto_pick_instance "$AK" "$SK")
    # auto_pick_instance 成功时输出两行：第一行地域，第二行实例ID
    if [ -n "$picked" ]; then
        REGION=$(echo "$picked" | sed -n '1p')
        INSTANCE=$(echo "$picked" | sed -n '2p')
        info "已选定：${REGION} / ${INSTANCE}"
    else
        warn "没能自动查到实例（可能是网络问题或权限不足），改为手动填写。"
        echo ""
        echo "【实例所在地域】"
        echo "  1) 中国香港（cn-hongkong）      2) 新加坡（ap-southeast-1）"
        echo "  3) 菲律宾 马尼拉（ap-southeast-6） 4) 马来西亚 吉隆坡（ap-southeast-3）"
        echo "  5) 印度尼西亚 雅加达（ap-southeast-5） 6) 泰国 曼谷（ap-southeast-7）"
        echo "  7) 日本 东京（ap-northeast-1）   8) 韩国 首尔（ap-northeast-2）"
        echo "  9) 美国 硅谷（us-west-1）       10) 美国 弗吉尼亚（us-east-1）"
        echo "  11) 德国 法兰克福（eu-central-1） 12) 英国 伦敦（eu-west-1）"
        echo "  13) 中国大陆（cn-hangzhou / cn-shanghai 等）"
        echo "  14) 手动输入其他地域代码"
        echo ""
        echo -e "${YELLOW}不知道自己的地域代码？去控制台实例列表页看一眼「地域」那一列，"
        echo -e "或在页面上方地域切换器里能看到形如 ap-southeast-6 的代码。${NC}"
        local region_opt
        region_opt=$(ask "选择 1-14" "1")
        case "$region_opt" in
            1) REGION="cn-hongkong" ;;
            2) REGION="ap-southeast-1" ;;
            3) REGION="ap-southeast-6" ;;
            4) REGION="ap-southeast-3" ;;
            5) REGION="ap-southeast-5" ;;
            6) REGION="ap-southeast-7" ;;
            7) REGION="ap-northeast-1" ;;
            8) REGION="ap-northeast-2" ;;
            9) REGION="us-west-1" ;;
            10) REGION="us-east-1" ;;
            11) REGION="eu-central-1" ;;
            12) REGION="eu-west-1" ;;
            13) REGION=$(ask_required "输入地域代码，例如 cn-hangzhou") ;;
            *) REGION=$(ask_required "输入地域代码，例如 ap-southeast-6") ;;
        esac

        echo ""
        echo "【实例 ID】阿里云 ECS 控制台 -> 实例列表 -> 实例 ID 列，形如 i-xxxxxxxx"
        INSTANCE=$(ask_required "ECS 实例 ID")
    fi

    echo ""
    echo "【流量熔断阈值】单位 GB。"
    echo "  阿里云 CDT 每月给的免费公网流量额度是："
    echo "    中国内地地域  20 GB/月"
    echo "    非中国内地地域 200 GB/月（含中国香港、新加坡、菲律宾、日本、美国、欧洲等）"
    echo "  这是**按账号统一计算**的，不是每台机器各有一份。"
    echo -e "  ${YELLOW}注意：超过免费额度就开始按量计费，不是「离得远就免费」。${NC}"
    echo "  建议填得比免费额度低一些，留点缓冲，例如免费 200GB 就填 180GB。"
    local free_hint="180"
    case "$REGION" in
        cn-hangzhou|cn-shanghai|cn-beijing|cn-shenzhen|cn-guangzhou|cn-qingdao|cn-zhangjiakou|cn-huhehaote|cn-wulanchabu|cn-chengdu|cn-nanjing|cn-heyuan|cn-wuhan*)
            free_hint="18"
            echo -e "  ${CYAN}你选的是中国内地地域，免费额度 20GB，建议阈值填 18 左右。${NC}"
            ;;
        *)
            echo -e "  ${CYAN}你选的是非中国内地地域，免费额度 200GB，建议阈值填 180 左右。${NC}"
            ;;
    esac
    LIMIT=$(ask "关机阈值（GB）" "$free_hint")

    echo ""
    echo "【资源组 ID】仅当你的 RAM 用户被限制在某个资源组内时才需要填，否则直接回车。"
    RESGROUP=$(ask "资源组 ID（可留空）")

    NEW_USER=$(cat <<EOF
{
    "name": "${NAME}",
    "ak": "${AK}",
    "sk": "${SK}",
    "region": "${REGION}",
    "instance_id": "${INSTANCE}",
    "traffic_limit": ${LIMIT},
    "bill_endpoint": "${BILL_ENDPOINT}",
    "currency": "${CURRENCY}",
    "resgroup": "${RESGROUP}",
    "paused": false
}
EOF
)
}

collect_instances() {
    step "第 5 步 / 共 5 步：添加要监控的机器"

    local users_json="" instance_count=1
    while true; do
        collect_one_instance "$instance_count"
        if [ -z "$users_json" ]; then
            users_json="$NEW_USER"
        else
            users_json="${users_json},
${NEW_USER}"
        fi

        echo ""
        if ! confirm "还要再加一台机器吗？"; then
            break
        fi
        instance_count=$((instance_count + 1))
    done

    # 用 python 安全地拼装 JSON，避免引号转义踩坑
    TG_TOKEN="$TG_TOKEN" TG_CHAT="$TG_CHAT" \
    OB_URL="$OB_URL" OB_TOKEN="$OB_TOKEN" OB_TARGET="$OB_TARGET" OB_TARGET_TYPE="$OB_TARGET_TYPE" \
    QQ_APPID="$QQ_APPID" QQ_SECRET="$QQ_SECRET" \
    QQ_TARGET="$QQ_TARGET" QQ_TARGET_TYPE="$QQ_TARGET_TYPE" \
    USERS_JSON="$users_json" CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json, os

config = {
    "telegram": {
        "bot_token": os.environ.get("TG_TOKEN", ""),
        "chat_id": os.environ.get("TG_CHAT", ""),
    },
    "onebot": {
        "base_url": os.environ.get("OB_URL", ""),
        "token": os.environ.get("OB_TOKEN", ""),
        "target_id": os.environ.get("OB_TARGET", ""),
        "target_type": os.environ.get("OB_TARGET_TYPE", "group"),
    },
    "qq": {
        "app_id": os.environ.get("QQ_APPID", ""),
        "app_secret": os.environ.get("QQ_SECRET", ""),
        "target_id": os.environ.get("QQ_TARGET", ""),
        "target_type": os.environ.get("QQ_TARGET_TYPE", "group"),
    },
    "users": json.loads("[" + os.environ["USERS_JSON"] + "]"),
}

with open(os.environ["CONFIG_FILE"], "w", encoding="utf-8") as fp:
    json.dump(config, fp, ensure_ascii=False, indent=4)
PY
    chmod 600 "$CONFIG_FILE"
    info "配置文件已生成并锁定权限为仅 root 可读"
}

setup_cron() {
    step "配置定时任务"
    local python_bin="${VENV_DIR}/bin/python"

    local cron_lines="*/5 * * * * ${python_bin} ${WORK_DIR}/guard.py >> ${WORK_DIR}/guard.log 2>&1 #cdt-guard"
    local report_line="0 9 * * * ${python_bin} ${WORK_DIR}/report.py >> ${WORK_DIR}/report.log 2>&1 #cdt-guard"

    if command -v crontab >/dev/null 2>&1; then
        crontab -l 2>/dev/null | grep -v "cdt-guard" > /tmp/cdt_cron_clean || true
        echo "$cron_lines" >> /tmp/cdt_cron_clean
        echo "$report_line" >> /tmp/cdt_cron_clean
        crontab /tmp/cdt_cron_clean
        rm -f /tmp/cdt_cron_clean
        info "定时任务已设置：每 5 分钟巡检一次，每天 9:00 发送报表"
    else
        warn "当前系统没有 crontab，未能设置定时任务。"
        warn "手动执行命令：${python_bin} ${WORK_DIR}/guard.py"
    fi
}

# ------------------------------ 自检 ------------------------------
self_test() {
    step "安装完成，正在自检"
    local python_bin="${VENV_DIR}/bin/python"

    echo "1) 检查程序文件..."
    local missing=0
    for file in common.py notifier.py aliyun_api.py guard.py report.py list_instances.py; do
        if [ ! -s "${WORK_DIR}/${file}" ]; then
            error "缺少文件 ${file}"
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] && info "程序文件齐全"

    echo ""
    echo "2) 检查阿里云接口连通性..."
    "$python_bin" - <<'PY'
import json, os, sys
sys.path.insert(0, os.environ.get("CDT_GUARD_DIR", "/opt/cdt-guard"))
import common, aliyun_api

config = common.load_config()
logger = common.build_logger("self_test", "/opt/cdt-guard/selftest.log")

ok_any = False
for user in config.get("users", []):
    name = user.get("name") or user["instance_id"]
    try:
        traffic = aliyun_api.get_cdt_traffic_gb(user["ak"], user["sk"], user["region"])
        print("   [正常] %s 流量查询成功：%.2f GB" % (name, traffic))
        ok_any = True
    except Exception as error:
        print("   [失败] %s 流量查询失败：%s" % (name, common.redact(error)))
        print("          常见原因：AccessKey 填错 / 未授予 CDT 权限 / 地域填错")

print("")
print("3) 逐个通知渠道发送测试消息...")
from notifier import send_alert, _send_telegram, _build_onebot, telegram_reachable

sent_ok = False
tg = config.get("telegram") or {}
if tg.get("bot_token") and tg.get("chat_id"):
    reachable, why = telegram_reachable()
    if not reachable:
        print("   [失败] Telegram 网络不通：%s" % why)
        print("          本机无法访问 api.telegram.org，需先配置代理再试。")
        print("          提示：阿里云海外节点通常可直连；国内节点一般需要代理。")
    else:
        r = _send_telegram(tg["bot_token"], tg["chat_id"],
                           "CDT 流量守护 - Telegram 通道测试成功", logger)
        print("   [%s] Telegram" % ("正常" if r else "失败"))
        if r:
            sent_ok = True
        else:
            print("          网络可达，但发送被拒。检查 Bot Token 与 Chat ID 是否正确，")
            print("          以及你是否先给这个机器人发过一条消息（否则它无权主动联系你）。")
else:
    print("   [跳过] Telegram（未配置）")

onebot = _build_onebot(config, logger)
if onebot:
    r = onebot.send("CDT 流量守护 - OneBot 通道测试成功")
    print("   [%s] OneBot" % ("正常" if r else "失败"))
    if r:
        sent_ok = True
    else:
        print("          可能原因：地址不通 / Token 错 / 目标 ID 错")
else:
    print("   [跳过] OneBot（未配置）")

qq = config.get("qq") or {}
if qq.get("app_id"):
    print("   [说明] QQ 官方通道（仅日报，不发测试告警，受每月 4 条配额限制）")
else:
    print("   [跳过] QQ 官方（未配置）")

print("")
if sent_ok:
    print("   自检完成：至少一个通知渠道可用，测试消息已发出。")
elif tg.get("bot_token") or (config.get("onebot") or {}).get("base_url"):
    print("   自检完成：但**所有通知渠道都发送失败**，请按上面的原因排查。")
    print("   注意：巡检与止损功能不受影响，仍会正常执行。")
else:
    print("   自检完成：没有配置任何通知渠道，将无法收到告警。")
    print("   建议重新运行本脚本，进入菜单第 5 项配置 Telegram 或 OneBot。")

if not ok_any:
    print("")
    print("   警告：所有实例流量查询均失败，请检查 AccessKey 与权限配置。")
PY
}

# ------------------------------ 管理菜单 ------------------------------
list_instances() {
    python3 - "$CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fp:
    users = json.load(fp).get("users", [])
if not users:
    print("   当前没有任何监控实例。")
for idx, user in enumerate(users):
    state = "已暂停" if user.get("paused") else "监控中"
    print("   [%d] %s | %s | %s | 阈值 %.0fGB | %s" % (
        idx, user.get("name"), user.get("instance_id"),
        user.get("region"), float(user.get("traffic_limit", 180)), state))
PY
}

manage_menu() {
    while true; do
        echo ""
        echo -e "${BOLD}${GREEN}========== CDT 流量守护 管理菜单 ==========${NC}"
        echo " 1) 查看当前监控的机器"
        echo " 2) 添加一台新机器"
        echo " 3) 删除一台机器"
        echo " 4) 暂停 / 恢复某台机器的监控"
        echo " 5) 修改通知配置（Telegram / OneBot / QQ 官方）"
        echo " 6) 立即发送一次报表测试"
        echo " 7) 立即执行一次巡检"
        echo " 8) 查看最近日志"
        echo " 9) 退出"
        echo -e "${BOLD}${GREEN}===========================================${NC}"

        local opt
        opt=$(ask "请输入序号 1-9")
        case "$opt" in
            1) list_instances ;;
            2)
                collect_one_instance 1
                NEW_USER="$NEW_USER" CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
with open(path, "r", encoding="utf-8") as fp:
    data = json.load(fp)
data.setdefault("users", []).append(json.loads(os.environ["NEW_USER"]))
with open(path, "w", encoding="utf-8") as fp:
    json.dump(data, fp, ensure_ascii=False, indent=4)
PY
                info "已添加新机器"
                ;;
            3)
                list_instances
                local idx
                idx=$(ask "输入要删除的编号（直接回车取消）")
                if [ -n "$idx" ]; then
                    IDX="$idx" CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
with open(path, "r", encoding="utf-8") as fp:
    data = json.load(fp)
try:
    removed = data["users"].pop(int(os.environ["IDX"]))
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=4)
    print("   已删除：%s" % removed.get("name"))
except Exception:
    print("   编号无效，操作取消")
PY
                fi
                ;;
            4)
                list_instances
                local idx
                idx=$(ask "输入要切换状态的编号（直接回车取消）")
                if [ -n "$idx" ]; then
                    IDX="$idx" CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
with open(path, "r", encoding="utf-8") as fp:
    data = json.load(fp)
try:
    user = data["users"][int(os.environ["IDX"])]
    user["paused"] = not bool(user.get("paused"))
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=4)
    print("   %s 现在是：%s" % (user.get("name"), "已暂停" if user["paused"] else "监控中"))
except Exception:
    print("   编号无效，操作取消")
PY
                fi
                ;;
            5)
                collect_telegram
                TG_TOKEN="$TG_TOKEN" TG_CHAT="$TG_CHAT" \
                OB_URL="$OB_URL" OB_TOKEN="$OB_TOKEN" OB_TARGET="$OB_TARGET" OB_TARGET_TYPE="$OB_TARGET_TYPE" \
                QQ_APPID="$QQ_APPID" QQ_SECRET="$QQ_SECRET" \
                QQ_TARGET="$QQ_TARGET" QQ_TARGET_TYPE="$QQ_TARGET_TYPE" \
                CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json, os
path = os.environ["CONFIG_FILE"]
with open(path, "r", encoding="utf-8") as fp:
    data = json.load(fp)
data["telegram"] = {"bot_token": os.environ["TG_TOKEN"], "chat_id": os.environ["TG_CHAT"]}
data["onebot"] = {
    "base_url": os.environ["OB_URL"],
    "token": os.environ["OB_TOKEN"],
    "target_id": os.environ["OB_TARGET"],
    "target_type": os.environ["OB_TARGET_TYPE"],
}
data["qq"] = {
    "app_id": os.environ["QQ_APPID"],
    "app_secret": os.environ["QQ_SECRET"],
    "target_id": os.environ["QQ_TARGET"],
    "target_type": os.environ["QQ_TARGET_TYPE"],
}
with open(path, "w", encoding="utf-8") as fp:
    json.dump(data, fp, ensure_ascii=False, indent=4)
PY
                info "通知配置已更新"
                ;;
            6) "${VENV_DIR}/bin/python" "${WORK_DIR}/report.py" ;;
            7) "${VENV_DIR}/bin/python" "${WORK_DIR}/guard.py" && info "巡检执行完毕" ;;
            8)
                if [ -f "${WORK_DIR}/guard.log" ]; then
                    tail -n 30 "${WORK_DIR}/guard.log"
                else
                    warn "还没有日志，说明巡检任务尚未执行过"
                fi
                ;;
            9) info "已退出"; exit 0 ;;
            *) error "输入无效，请输入 1-9 之间的数字" ;;
        esac
    done
}

# ------------------------------ 入口 ------------------------------
main() {
    echo ""
    echo -e "${BOLD}${BLUE}==============================================================${NC}"
    echo -e "${BOLD}${BLUE}      阿里云 CDT 流量守护 - 一键安装与管理脚本                ${NC}"
    echo -e "${BOLD}${BLUE}==============================================================${NC}"
    echo " 功能：实时监控 CDT 公网流量，快超标时自动关机止损，"
    echo "       次月流量重置后自动开机，并每天推送一份使用报表。"
    echo ""

    require_root

    if [ -f "$CONFIG_FILE" ]; then
        info "检测到已经安装过，进入管理菜单。"
        manage_menu
    else
        echo -e "${BOLD}即将开始安装，全程大约 3-5 分钟。${NC}"
        echo "你需要提前准备好："
        echo "  1. 阿里云 RAM 子账号的 AccessKey ID 和 Secret"
        echo "  2. 要监控的 ECS 实例 ID"
        echo "  3. （必须）Telegram 机器人的 Token 和你的 Chat ID"
        echo "  4. （可选）QQ 机器人的 AppID / AppSecret，用于日报推送"
        echo ""
        if ! confirm "准备好了吗？开始安装"; then
            echo "已取消。"
            exit 0
        fi

        install_system_deps
        setup_python_env
        download_sources
        collect_telegram
        collect_instances
        setup_cron
        self_test

        echo ""
        echo -e "${GREEN}${BOLD}安装全部完成！${NC}"
        echo "下次想改配置，只要再运行一次本脚本即可进入管理菜单。"
        echo ""
    fi
}

main
