#!/usr/bin/env bash
# ===========================================================================
# CDT 流量守护 · 机器清单配置
# ===========================================================================
#
# 部署完程序之后，用这个脚本告诉它「要监控哪几台机器」。
# 会一步步问你，每问一项都有说明；直接回车表示「用括号里的默认值」。
#
# 用法：
#   bash configure.sh          交互式填写
#   bash configure.sh show     只看当前配置，不改
#
# 生成结果写入 KV 的 config 键，程序下次运行就读到新配置。
# ===========================================================================

set -u

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"
RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"

ok()   { printf "${GREEN}[成功]${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}[注意]${RESET} %s\n" "$1"; }
err()  { printf "${RED}[失败]${RESET} %s\n" "$1"; }
step() { printf "\n${BOLD}${CYAN}== %s ==${RESET}\n" "$1"; }

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || { err "无法进入项目目录"; exit 1; }

# 临时文件路径。
# ⚠️ 不要在这里直接 mktemp —— 那样一来「被引用」时就已经建了个空文件，
#    哪怕用户只是想看一眼配置（show）也会平白多出个垃圾文件。
#    所以只记下路径，真正要用的时候（run_configure 里）再创建。
TEMP_JSON="$(mktemp -u 2>/dev/null || echo "./.config-temp.json")"

# ---------------------------------------------------------------------------
# 部署工具调用方式
# ---------------------------------------------------------------------------
# ⚠️ 跟 deploy.sh 里同一个坑：绝不用 `npx --no-install`。
#    项目里没装 wrangler 时它会直接失败（英文报错，用户看不懂），
#    表现就是「脚本跑到一半自己关了」。
wrun() {
  if [ -x "node_modules/.bin/wrangler" ]; then
    node_modules/.bin/wrangler "$@"
  elif [ -x "node_modules/.bin/wrangler.cmd" ]; then
    node_modules/.bin/wrangler.cmd "$@"
  elif command -v wrangler >/dev/null 2>&1; then
    wrangler "$@"
  else
    return 127
  fi
}

# ---------------------------------------------------------------------------
# 检查部署工具是否就绪
# ---------------------------------------------------------------------------
# ⚠️ 这里踩过一个坑（现在修好了，务必不要再挪到文件顶层）：
#     最初这个检查写在**文件顶层**，也就是「一被引用就立刻执行」。
#     后果有两个：
#       1. 它里面的 `exit 1` 会把**引用它的 deploy.sh 一起杀掉** ——
#          明明只是配置这一步做不了，整个安装流程却被判了死刑；
#       2. 每次 source 都白跑一个子进程去问版本号，纯属浪费。
#     正确做法：把它收进函数里，**谁需要谁才调**。
ensure_wrangler() {
  if wrun --version >/dev/null 2>&1; then
    return 0
  fi
  err "还没安装部署工具（wrangler）。"
  printf "请先跑一次 ${CYAN}bash deploy.sh${RESET}，它会自动装好。\n"
  return 1
}

# ---------------------------------------------------------------------------
# 读取现有配置
# ---------------------------------------------------------------------------
# ⚠️ 这里踩过一个版本差异的坑：
#     wrangler 4.x 需要显式加 `--remote` 才是操作线上数据；
#     但本机装的常用版本是 3.x，**它不认 --remote 这个参数**，
#     传了会直接报「未知参数」并打印一大段英文帮助 ——
#     用户看到的就是「脚本突然刷出一屏英文」。
#
#     好消息是：3.x 默认就是操作线上，不加正好。
#     所以这里不加 --remote，两种版本都能跑。
#
# 另外：配置还没写过时，接口会返回 404。这是**正常情况**，不是错误，
#      所以要把报错信息丢掉（2>/dev/null），只认「有没有拿到内容」。
show_current() {
  step "当前配置"
  local raw
  raw="$(wrun kv key get config --binding CDT_GUARD_KV --text 2>/dev/null || true)"

  # 把 wrangler 的各种噪音清掉，只留真正的配置内容。
  # 这些噪音包括：代理提示、版本警告、404 的英文报错、日志路径等。
  # 判据很简单：**真正的配置一定是以 { 开头的 JSON**。
  # 所以最稳的做法是直接找那行 JSON，而不是一条条列黑名单。
  raw="$(printf '%s\n' "$raw" | grep -E '^\{.*\}$' | head -1 || true)"

  # 若没有 JSON 内容，且输出里出现过 404 / Not Found，说明是「还没配过」
  if [ -z "$raw" ]; then
    warn "还没有配置过（这是正常的，第一次配都这样）。"
    return 1
  fi
  printf "%s\n" "$raw"
  return 0
}

# ---------------------------------------------------------------------------
# 询问一台机器（把结果追加进临时 JSON）
# ---------------------------------------------------------------------------
ask_one_machine() {
  local index="$1"
  printf "\n${BOLD}--- 第 %s 台机器 ---${RESET}\n" "$index"

  printf "① 给它起个名字（你认得出来就行，比如「菲律宾节点」）\n"
  read -r -p "   名字： " name
  [ -z "$name" ] && { warn "名字不能为空，跳过这台。"; return 1; }

  printf "② 实例 ID。在阿里云控制台实例列表里能找到，以 i- 开头，\n"
  printf "   比如 i-5ts7fo7n0ui3stsujw0r\n"
  read -r -p "   实例 ID： " instance_id
  [ -z "$instance_id" ] && { warn "实例 ID 不能为空，跳过这台。"; return 1; }

  printf "③ 地域代码。在控制台实例详情里能看到，比如：\n"
  printf "   cn-hangzhou 杭州 / cn-shanghai 上海 / ap-southeast-1 新加坡\n"
  printf "   ap-northeast-1 东京 / us-west-1 硅谷\n"
  read -r -p "   地域（直接回车用 ap-southeast-1）： " region
  [ -z "$region" ] && region="ap-southeast-1"

  printf "④ AccessKey ID 与 Secret。在阿里云「访问控制」里创建，\n"
  printf "   建议用只读+开关机权限的子账号。\n"
  read -r -p "   AccessKey ID： " ak
  [ -z "$ak" ] && { warn "AccessKey ID 不能为空，跳过这台。"; return 1; }
  read -r -s -p "   AccessKey Secret（输入时不显示）： " sk
  printf "\n"
  [ -z "$sk" ] && { warn "AccessKey Secret 不能为空，跳过这台。"; return 1; }

  printf "⑤ 流量阈值（GB）。超过这个数就自动关机止损。\n"
  printf "   非中国内地免费额度是 200GB，建议填 180 留点缓冲。\n"
  read -r -p "   阈值（直接回车用 180）： " limit
  [ -z "$limit" ] && limit="180"

  # 地区所在地域判断（给用户一个明确反馈）
  case "$region" in
    cn-*)  printf "   已识别为「中国内地」地域，免费额度按 20GB 算。\n" ;;
    *)     printf "   已识别为「非中国内地」地域，免费额度按 200GB 算。\n" ;;
  esac

  # 追加到临时文件（每行一个 JSON 对象）
  printf '{"name":"%s","instance_id":"%s","region":"%s","ak":"%s","sk":"%s","traffic_limit":%s,"paused":false}\n' \
    "$name" "$instance_id" "$region" "$ak" "$sk" "$limit" >> "$TEMP_JSON"
  ok "第 $index 台已记录：$name"
  return 0
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
# 说明：这个文件有两个用法，靠文件末尾的「是否被直接执行」判断：
#   1. 直接运行：bash configure.sh        -> 只做配置
#   2. 被 deploy.sh 引用：source 后调 run_configure()
#      -> 部署完接着问机器信息，用户不用再跑第二条命令
#
# 关键设计：**配置逻辑只有这一份**。
# 最初把配置逻辑独立成一个脚本，结果 deploy.sh 和 configure.sh
# 各有一份「问机器信息」的代码，早晚会走偏（改了一处忘了另一处）。
# 现在统一收在 run_configure() 里，两边共用。
# ---------------------------------------------------------------------------

# 配置完成后的收尾话术。允许调用方覆盖（deploy.sh 会传入更适合的版本）。
CONFIGURE_DONE_HINT="${CONFIGURE_DONE_HINT:-}"

run_configure() {
  # 没有部署工具就做不了这件事，先拦下（返回 1 而非 exit，避免杀掉调用方）
  ensure_wrangler || return 1

  show_current || true

  printf "\n"
  printf "接下来会问你几台机器的信息。填完会覆盖上面的旧配置。\n"
  printf "如果不想覆盖，现在就按 Ctrl+C 退出。\n"
  read -r -p "按回车开始填写..." _

  : > "$TEMP_JSON"

  # ---- Telegram 数字 ID ----
  step "你的 Telegram 数字 ID"
  printf "这是用来确认「只有你能操作机器人」的。\n"
  printf "获取方法：在 Telegram 里搜索 ${CYAN}@userinfobot${RESET}，点开始，\n"
  printf "它会回你一条消息，里面的 Id 那串数字就是。\n"
  read -r -p "你的数字 ID： " chat_id
  if [ -z "$chat_id" ]; then
    err "数字 ID 不能为空 —— 空着机器人不会响应任何人。已中止。"
    printf "（没有修改任何配置）\n"
    return 1
  fi

  # ---- 逐台机器 ----
  step "逐台填写机器"
  printf "每填完一台会问你还要不要继续。填完直接选「不了」即可。\n"

  local index=1
  while true; do
    if ask_one_machine "$index"; then
      index=$((index + 1))
    fi
    printf "\n还要再填一台吗？(y/N) "
    read -r answer
    case "$answer" in
      [Yy]*) ;;
      *) break ;;
    esac
  done

  # ---- 组装完整配置 ----
  if [ ! -s "$TEMP_JSON" ]; then
    err "一台机器都没填，不生成配置。"
    rm -f "$TEMP_JSON"
    return 1
  fi

  local users_json
  users_json="$(paste -sd, "$TEMP_JSON")"
  local full_json
  full_json="{\"telegram\":{\"chat_id\":\"$chat_id\"},\"users\":[$users_json]}"

  # ---- 写入前先给别人看（避免填错还不知道）----
  step "写入前确认"
  printf "即将写入的配置（机器密钥已打码）：\n\n"
  printf "%s\n" "$full_json" \
    | sed -E 's/"sk":"[^"]*"/"sk":"[已隐藏]"/g; s/"ak":"([^"]{6})[^"]*"/"ak":"\1****"/g'
  printf "\n"

  read -r -p "确认写入？(Y/n) " confirm
  case "$confirm" in
    [Nn]*) err "已取消，没有写入任何内容。"; rm -f "$TEMP_JSON"; return 1 ;;
  esac

  # ---- 写入 KV ----
  # ⚠️ 这里踩过版本差异的坑：
  #     `wrangler kv key put` **不接受管道输入**（echo xxx | wrangler ... 无效）。
  #     实测 wrangler 3.x 的用法是：kv key put <键> [值]
  #     值要么当位置参数、要么用 --path 从文件读。
  #     密码里带引号/空格时位置参数容易被 shell 吃掉，
  #     所以统一用 --path 走文件，最稳且跨版本通用。
  step "写入配置"
  local cfg_file=".config-payload.json"
  printf '%s' "$full_json" > "$cfg_file"

  if wrun kv key put config --binding CDT_GUARD_KV --path "$cfg_file" >/dev/null 2>&1; then
    ok "配置已写入。"
    rm -f "$cfg_file"
  else
    err "写入失败。请把下面这条命令的输出发给我："
    printf "   npx wrangler kv key put config --binding CDT_GUARD_KV --path %s\n" "$cfg_file"
    printf "（配置文件已留在 %s，方便重试）\n" "$cfg_file"
    rm -f "$TEMP_JSON"
    return 1
  fi

  rm -f "$TEMP_JSON"
  return 0
}

# ---------------------------------------------------------------------------
# 直接运行这个脚本时的入口
# ---------------------------------------------------------------------------
main() {
  printf "${BOLD}==========================================${RESET}\n"
  printf "${BOLD} CDT 流量守护 · 机器清单配置${RESET}\n"
  printf "${BOLD}==========================================${RESET}\n"

  # 独立运行时，先自己确认工具就绪（这里可以放心地 return，因为没人引用本文件）
  ensure_wrangler || exit 1

  if [ "${1:-}" = "show" ]; then
    show_current
    exit $?
  fi

  if run_configure; then
    step "完成"
    if [ -n "$CONFIGURE_DONE_HINT" ]; then
      printf '%s\n' "$CONFIGURE_DONE_HINT"
    else
      ok "现在可以打开 Telegram 对机器人发送 /menu 了。"
      printf "\n"
      printf "想核对配置：${CYAN}bash configure.sh show${RESET}\n"
      printf "想改配置：再跑一次 ${CYAN}bash configure.sh${RESET}（会覆盖）\n"
    fi
  else
    printf "\n"
    printf "配置没有完成。想重试：${CYAN}bash configure.sh${RESET}\n"
    exit 1
  fi
}

# 只有「被直接执行」时才跑 main；被 source 引用时不跑（由调用方决定）
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
