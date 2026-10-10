#!/usr/bin/env bash
# ===========================================================================
# CDT 流量守护 · 交互式主菜单（唯一入口）
# ===========================================================================
#
# 为什么要有这个文件：
#   最初的版本把功能拆成两个脚本（deploy.sh 部署、configure.sh 配置），
#   用户得先记住「第一步跑哪个、第二步跑哪个」。老大的原话是
#   「为什么不把填机器放到一键脚本里交互」—— 对，那是设计缺陷：
#   **用户不该需要记住命令，他应该打开就看到菜单，选哪个干哪个。**
#
# 这个文件的职责：把「有什么能力」和「怎么用」分开——
#   本文件只负责**菜单与调度**（问用户想干什么、然后去调对应的函数）；
#   真正的活儿仍然在 deploy.sh / configure.sh 里，一份实现，不重复写。
#
# 用法：
#   bash menu.sh              打开菜单（推荐）
#   bash menu.sh install      直接跑完整安装（跳过菜单，给老手/自动化用）
#   bash menu.sh check        直接跑环境体检
#   bash menu.sh status       直接看当前配置
#
# 所有提示都是中文。看不懂的地方把整屏内容发给我。
# ===========================================================================

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || { echo "无法进入项目目录"; exit 1; }

# ---------------------------------------------------------------------------
# 颜色与输出函数（公共库，三个脚本共用同一份）
# ---------------------------------------------------------------------------
# ⚠️ 这里踩过坑：最早 menu.sh / deploy.sh / configure.sh 各抄了一份
#    ok/warn/err/step，看着一样，其实是定时炸弹 —— 改一份忘一份，
#    同样的提示在不同入口下长得不一样，且不报错。现在统一收进 lib-ui.sh。
# shellcheck source=lib-ui.sh
. ./lib-ui.sh

# ---------------------------------------------------------------------------
# 载入零件
# ---------------------------------------------------------------------------
# 说明：这里用 source 引入另外两个文件，是为了让「实现只有一份」。
#   lib-preflight.sh  环境体检（含零依赖时的中文安装引导）
#   deploy.sh         部署相关（登录、建存储、写密钥、上传、自检）
#   configure.sh      配置相关（问机器信息、写配置）
#
# ⚠️ 这三个文件都被改造成「被引用时不自动跑主流程」，
#    靠各自末尾的「是否被直接执行」判断实现。改动它们时务必保留那段。

. ./lib-preflight.sh

# ---------------------------------------------------------------------------
# 状态探测：菜单要显示「当前是什么状态」，才能引导用户做对该做的事
# ---------------------------------------------------------------------------
# 是否已登录 Cloudflare
is_logged_in() {
  preflight_wrangler || return 1
  run_wrangler whoami >/dev/null 2>&1
}

# 统一调用 wrangler（与 deploy.sh 保持一致的策略）
run_wrangler() {
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

# 是否已部署（有 .worker-url 或能在 KV 里读到东西）
is_deployed() {
  [ -f .worker-url ] && grep -q 'workers.dev' .worker-url 2>/dev/null
}

# 读当前配置里有多少台机器、多少个账号
# 输出格式："机器数 账号数"（读不到时输出 "0 0"）
config_stats() {
  local raw=""
  raw="$(run_wrangler kv key get config --binding CDT_GUARD_KV --text 2>/dev/null || true)"
  raw="$(printf '%s\n' "$raw" | grep -E '^\{.*\}$' | head -1 || true)"
  if [ -z "$raw" ]; then
    printf '0 0'
    return 0
  fi
  # ⚠️ 不要写死 node 路径 —— 换台机器就找不到。动态取。
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ]; then
    printf '0 0'
    return 0
  fi
  printf '%s' "$raw" | "$node_bin" -e '
    let d="";
    process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const o=JSON.parse(d);
        const users=Array.isArray(o.users)?o.users:[];
        const aks=new Set(users.map(u=>String(u.ak||"").trim()).filter(Boolean));
        console.log(users.length+" "+aks.size);
      }catch(e){ console.log("0 0"); }
    });
  ' 2>/dev/null || printf '0 0'
}

# 统一提取 worker 网址
worker_url() {
  if [ -f .worker-url ]; then
    sed -n 's|\(https://[a-zA-Z0-9._-]*\.workers\.dev\).*|\1|p' .worker-url 2>/dev/null | head -1
  fi
}

# ---------------------------------------------------------------------------
# 菜单渲染
# ---------------------------------------------------------------------------
show_header() {
  printf "\n"
  printf "${BOLD}${BLUE}============================================================${RESET}\n"
  printf "${BOLD}${BLUE}        CDT 流量守护 · 管理菜单${RESET}\n"
  printf "${BOLD}${BLUE}============================================================${RESET}\n"
  printf " 监控阿里云流量，超标自动关机止损；跑在 Cloudflare 上，"
  printf "下月流量\n 重置后还能自动开机。\n\n"

  # ---- 当前状态一览（让用户知道自己在哪一步）----
  printf "${BOLD}当前状态：${RESET}\n"

  if preflight_node; then
    printf "  Node.js        ${GREEN}已装${RESET}（%s）\n" "$(node -v 2>/dev/null || echo '?')"
  else
    printf "  Node.js        ${RED}未装${RESET}  ${YELLOW}← 先选「1」体检，它会教你怎么装${RESET}\n"
  fi

  if is_logged_in; then
    printf "  Cloudflare     ${GREEN}已登录${RESET}\n"
  else
    printf "  Cloudflare     ${YELLOW}未登录${RESET}\n"
  fi

  if is_deployed; then
    printf "  Worker         ${GREEN}已部署${RESET}  %s\n" "$(worker_url)"
  else
    printf "  Worker         ${YELLOW}未部署${RESET}\n"
  fi

  if preflight_wrangler && is_logged_in; then
    local stats machines accounts
    stats="$(config_stats)"
    machines="${stats%% *}"; accounts="${stats##* }"
    if [ "$machines" -gt 0 ] 2>/dev/null; then
      printf "  监控配置       ${GREEN}已配 %s 台机器 / %s 个账号${RESET}\n" "$machines" "$accounts"
    else
      printf "  监控配置       ${YELLOW}还没配机器${RESET}\n"
    fi
  else
    printf "  监控配置       ${DIM}（登录后可见）${RESET}\n"
  fi

  hr
}

show_menu() {
  printf "\n${BOLD}你想做什么？${RESET}\n\n"
  printf "  ${BOLD}${CYAN}1${RESET}) 环境体检          检查缺什么、怎么装（第一次用先选它）\n"
  printf "  ${BOLD}${CYAN}2${RESET}) 一站式安装        ${DIM}装好一切 + 配置机器，新手推荐${RESET}\n"
  printf "\n"
  printf "  ${BOLD}${CYAN}3${RESET}) 配置监控机器      重新填写要监控的机器（会覆盖旧配置）\n"
  printf "  ${BOLD}${CYAN}4${RESET}) 添加阿里云账号    ${DIM}新增另一个账号，不动现有配置${RESET}\n"
  printf "  ${BOLD}${CYAN}5${RESET}) 查看当前配置      只读，不改任何东西\n"
  printf "\n"
  printf "  ${BOLD}${CYAN}6${RESET}) 重新部署          代码改动后重新上传\n"
  printf "  ${BOLD}${CYAN}7${RESET}) 自动自检          检查机器人是否真的在工作\n"
  printf "  ${BOLD}${CYAN}8${RESET}) 重设网址密钥      ${DIM}密钥忘了、或想换一串时用${RESET}\n"
  printf "\n"
  printf "  ${BOLD}${CYAN}9${RESET}) 查看运行日志      实时看机器人在做什么（Ctrl+C 退出）\n"
  printf "  ${BOLD}${CYAN}0${RESET}) 使用说明          常见问题与原理说明\n"
  printf "\n"
  printf "  ${BOLD}${CYAN}q${RESET}) 退出\n"
  hr
}

# ---------------------------------------------------------------------------
# 各菜单项的实现
# ---------------------------------------------------------------------------

menu_preflight() {
  step "环境体检"
  preflight_all
  printf "\n"
  pause
}

menu_full_install() {
  step "一站式安装"
  printf "这一步会做这些事：\n"
  printf "  · 检查环境（缺 Node 会告诉你怎么装）\n"
  printf "  · 打开浏览器让你登录 Cloudflare\n"
  printf "  · 创建存储空间、写入密钥\n"
  printf "  · 上传程序、自动自检\n"
  printf "  · 接着问你「要监控哪几台机器」\n\n"

  # 环境没就绪就别往下走 —— 这是小白最容易卡住的地方，
  # 提前拦下来并给出中文安装指引，比走到一半崩掉体验好得多。
  if ! preflight_all; then
    printf "\n${YELLOW}环境还没就绪，先按上面的说明处理，再回来选「2」。${RESET}\n"
    pause
    return 0
  fi

  if ! confirm "现在开始安装吗？"; then
    info "已取消。"
    pause
    return 0
  fi

  # shellcheck source=deploy.sh
  . ./deploy.sh
  run_full_deploy
  pause
}

menu_configure() {
  step "配置监控机器"
  ensure_wrangler_for_menu || { pause; return 0; }
  # shellcheck source=configure.sh
  . ./configure.sh
  if run_configure; then
    ok "配置已更新。"
  else
    warn "配置没完成。"
  fi
  pause
}

menu_add_account() {
  step "添加阿里云账号"
  ensure_wrangler_for_menu || { pause; return 0; }
  # shellcheck source=configure.sh
  . ./configure.sh
  run_add_account
  pause
}

menu_show_config() {
  ensure_wrangler_for_menu || { pause; return 0; }
  # shellcheck source=configure.sh
  . ./configure.sh
  show_current || true
  printf "\n"
  pause
}

menu_redeploy() {
  step "重新部署"
  ensure_wrangler_for_menu || { pause; return 0; }
  . ./deploy.sh
  run_redeploy_only
  pause
}

menu_selfcheck() {
  step "自动自检"
  ensure_wrangler_for_menu || { pause; return 0; }
  . ./deploy.sh
  run_selfcheck_only
  pause
}

menu_reset_secret() {
  step "重设网址密钥"
  ensure_wrangler_for_menu || { pause; return 0; }
  . ./deploy.sh
  run_reset_webhook_secret
  pause
}

menu_logs() {
  step "运行日志"
  ensure_wrangler_for_menu || { pause; return 0; }
  printf "接下来会实时显示机器人的每一条处理记录。\n"
  printf "随便给它发个消息，你就能看到它怎么响应的。\n"
  printf "${YELLOW}看完按 Ctrl+C 回到菜单。${RESET}\n\n"
  pause
  run_wrangler tail --format pretty || true
  printf "\n"
  pause
}

menu_help() {
  step "使用说明"
  cat <<'HELP'

【它是怎么工作的】

  监控阿里云账号的 CDT 公网出流量。每 5 分钟查一次，
  流量超过你设的阈值就自动关机止损，避免超额扣费。
  下个月流量重置后，它发现机器还关着，会自动开机。

  机器人跑在 Cloudflare 上（不是你的服务器上），
  所以你的机器关了，它照样活着 —— 这是它能叫醒机器的原因。

【日常怎么用】

  打开 Telegram，对你的机器人发送 /menu。
  底部会跳出一排中文按钮，点就行了：

    总览 / 流量额度 / 实例状态 / 完整报表 / 周报
    余额详情 / 账号汇总 / 单机操作 / 全部开机 / 全部关机
    立即巡检 / 使用说明 / 收起菜单

【多个阿里云账号】

  可以同时监控多个账号。每个账号的免费额度是**分开算**的
  （内地 20GB / 非内地 200GB，互不占用）。

  加账号：回到菜单选「4 添加阿里云账号」。
  看汇总：在 Telegram 里点「账号汇总」。

【关于免费额度】

  ⚠️ 额度是按「账号」算的，不是按机器算的。
     同一个账号下 3 台机器共享一份 200GB，不是每台 200GB。
     所以「账号汇总」比逐台看更有参考价值。

【常见问题】

  Q: 机器人不理我？
  A: 只有配置里那个数字 ID 对应的账号能操作它，别人发消息它不理。
     这是设计，不是故障。

  Q: 提示「查询失败」？
  A: 多半是 AK 权限不够，或地域填错了。回菜单选「3」重新填。

  Q: 忘了访问网址？
  A: 回菜单选「5 查看当前配置」，或看项目目录里的 .worker-url 文件。

  Q: 怎么停掉不想要了？
  A: 到 Cloudflare 后台删掉名为 cdt-guard 的 Worker 即可。

HELP
  pause
}

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
# 暂停等用户按键（比直接刷屏友好，尤其在 Windows 上窗口可能直接关掉）
#
# 这里**故意覆盖** lib-ui.sh 里的 pause：
#   lib-ui 的文案是「按回车继续」（适合 deploy/configure 单独跑的场景），
#   而菜单里更贴切的是「按回车回到菜单」—— 告诉用户接下来会看到什么。
#   这是有意的差异化，不是重复定义。
pause() {
  printf "\n${DIM}按回车回到菜单...${RESET}"
  read -r _ || true
}
# confirm 直接用 lib-ui.sh 里那份，不再重复定义。

# 菜单里在做需要 wrangler 的操作前，先把「没登录/没装」说清楚
ensure_wrangler_for_menu() {
  if ! preflight_wrangler; then
    err "还没安装部署工具。请先选「1 环境体检」按提示装好。"
    return 1
  fi
  if ! is_logged_in; then
    warn "你还没登录 Cloudflare。"
    if confirm "现在去登录？"; then
      . ./deploy.sh
      run_login_only
    else
      info "已取消。需要先登录才能做这件事。"
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
main_menu_loop() {
  while true; do
    clear 2>/dev/null || printf '\n\n'
    show_header
    show_menu

    local choice=""
    printf "请输入序号后回车："
    read -r choice || { printf "\n"; return 0; }

    case "$choice" in
      1) menu_preflight ;;
      2) menu_full_install ;;
      3) menu_configure ;;
      4) menu_add_account ;;
      5) menu_show_config ;;
      6) menu_redeploy ;;
      7) menu_selfcheck ;;
      8) menu_reset_secret ;;
      9) menu_logs ;;
      0) menu_help ;;
      q|Q|quit|exit) printf "\n再见。\n"; return 0 ;;
      "") ;; # 直接回车，重画菜单
      *) warn "没看懂「${choice}」，请输入 0-9 之间的数字，或 q 退出。" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
main() {
  case "${1:-}" in
    install)   # 供自动化/老手：直接跑完整安装
      . ./deploy.sh
      run_full_deploy
      ;;
    check)     # 直接体检
      preflight_all
      ;;
    status)    # 直接看配置
      . ./configure.sh
      show_current
      ;;
    ""|menu)   # 默认：打开菜单
      main_menu_loop
      ;;
    *)
      printf "用法：bash menu.sh           打开菜单\n"
      printf "      bash menu.sh install   直接安装\n"
      printf "      bash menu.sh check     环境体检\n"
      printf "      bash menu.sh status    查看配置\n"
      exit 1
      ;;
  esac
}

main "$@"
