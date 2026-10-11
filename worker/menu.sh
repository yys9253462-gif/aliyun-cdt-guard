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
# shellcheck source=lib-kv.sh
. ./lib-kv.sh

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
# 🔴 这里踩过一个大坑，务必看清再改（2026-10-11 用户实测复现）：
#
#   交付包里 wrangler.toml 的 KV id 是**故意留空**的（`id = ""`）。
#   但 wrangler **任何**命令启动时都会先解析这个文件，id 为空时**直接报错退出**
#   —— 连 `whoami` 都不例外：
#     X [ERROR] "kv_namespaces[0]" bindings should have a string "id" field
#
#   后果：菜单一打开就显示「Cloudflare 未登录 / Worker 未部署」，
#   哪怕用户明明已经登录、代码也已经部署过。用户会以为是自己没登录，
#   反复去点「一站式安装」，每次都被一个空 id 卡住。
#
#   所以：**判断登录之前，必须先确保配置是合法的**。
#   修复的实现 ensure_kv_id() 已放进 lib-preflight.sh（上面刚 source 过），
#   那里两个入口都能拿到，保证「实现只有一份」，不会跑偏。
#
#   注意：这个函数在探测阶段**必须保持安静** —— 菜单是刷新式的，
#   每次重画都打印一堆「正在查找存储...」会刷屏。所以传 quiet 让它闭嘴。
ensure_config_ready() {
  # 配置已经合法 → 什么都不用做
  grep -qE '^[[:space:]]*id[[:space:]]*=[[:space:]]*"[0-9a-f]{32}"' wrangler.toml 2>/dev/null && return 0

  # 需要修复，但修复函数还没加载（例如单独 source 了 menu.sh）→ 尽力而为
  if declare -F ensure_kv_id >/dev/null 2>&1; then
    ensure_kv_id quiet >/dev/null 2>&1 && return 0
  fi
  return 1
}

# 是否已登录 Cloudflare
is_logged_in() {
  preflight_wrangler 2>/dev/null || return 1
  cf_is_logged_in
}

# 当前登录的邮箱（取不到就输出空）
#
# 为什么要单独提取邮箱：状态栏只写「已登录」，用户没法确认登的是不是自己
# 以为的那个账号（有人有多个 Cloudflare 账号）。把邮箱显出来，一眼就能核对。
#
# ⚠️ 提取用 `\.[a-zA-Z]{2,}` 收尾，并且**必须剔除句末标点**：
#    直接 `grep -oE '[..]+@[..]+'` 会把 whoami 那句英文末尾的句号一起吃掉，
#    摘出来变成 "someone@example.com."（尾巴多一个点），很难看。
logged_in_email() {
  local out=""
  out="$(cf_auth_run whoami 2>/dev/null \
    | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' \
    | head -1 || true)"
  printf '%s' "$out"
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

# 是否已部署
#
# 🔴 这一处曾经误报（2026-10-11 用户实测：「我已经部署了，为什么还显示未部署」）：
#
#   旧实现是 `[ -f .worker-url ] && grep -q workers.dev .worker-url` ——
#   **只看本地这个文件在不在**。可 .worker-url 是「部署那一刻」写在
#   当时那个目录里的。用户重新解压一份新包、或换个目录跑，文件就不在，
#   菜单立刻判定「未部署」—— **完全不去问云端**，哪怕 Worker 跑得好好的。
#   实测确认：云端有部署记录，https://cdt-guard.<账号>.workers.dev 返回 200。
#
#   修法：判定「部署没部署」，必须以**真去探测**为准。
#   probe_worker_url（在 lib-preflight.sh）会：先看本地文件 → 再翻缓存
#   → 最后构造候选网址**实际访问**（这一步才能识别「换了目录但云端还在」）。
#   探测成功会顺手回写 .worker-url，下次就走快路径。
#
#   注意：探测带网络请求，菜单每次重画都会调它 → 有 curl 超时兜底（单个
#   候选最多 10 秒）。正常命中第一个候选就返回，不会卡。
is_deployed() {
  local url=""
  url="$(probe_worker_url 2>/dev/null || true)"
  [ -n "$url" ]
}

# 读当前配置里有多少台机器、多少个账号
#
# 输出格式（三态，务必区分开）：
#   "OK <机器数> <账号数>"  —— 成功读到配置
#   "EMPTY"                —— 读到了，但里面没有机器（config 不存在 / users 为空）
#   "ERR"                  —— **读不到**（node 找不到 / wrangler 失败 / 网络不通）
#
# 🔴 为什么必须分三态（2026-10-11 用户实测：「我 cloudflare 已经配置了机器了，
#    菜单却显示还没配机器」）：
#
#    旧实现无论哪种失败都只输出 "0 0"，而 show_header 看到 0 就一律显示
#    「还没配机器」。于是「读取失败」被**伪装成**「你没配」——
#    用户明明配好了机器，菜单却说他没配，他会以为配置丢了，
#    反复去点「配置监控机器」重配，越弄越乱。
#
#    更糟的是：这个错报**没有任何错误提示**，用户无从判断到底是
#    「真没配」还是「读不到」。所以现在把失败单独标成 ERR，
#    状态栏见到 ERR 会直接显示成「读取失败」并提示去查，不再冤枉用户。
config_stats() {
  local raw=""
  # 🔴 必须走 kvx（自动补 --remote），否则在 wrangler 4.x 上会读到
  #    **本地空存储**，把「云端有配置」误判成「还没配机器」。
  #    详见 lib-kv.sh 头部说明。
  #
  # ⚠️ 这里**不能**用 run_wrangler 兜底 —— 那会漏掉 --remote，
  #    在 4.x 上又回到「静默读本地空存储」的老毛病。
  #    兼容层不可用时，宁可报 ERR（提示用户去查），也绝不给出
  #    「还没配机器」这种会误导人的结论。
  if declare -F kvx >/dev/null 2>&1; then
    raw="$(kvx kv key get config --binding CDT_GUARD_KV --text 2>/dev/null || true)"
  else
    printf 'ERR'
    return 0
  fi
  raw="$(printf '%s\n' "$raw" | grep -E '^\{.*\}$' | head -1 || true)"
  if [ -z "$raw" ]; then
    printf 'EMPTY'
    return 0
  fi
  # ⚠️ 不要写死 node 路径 —— 换台机器就找不到。动态取。
  #
  # 🔴 这里**必须**用 preflight_node / local_node_bindir，不能直接 `command -v node`：
  #    本项目的 preflight 会自动把 Node 装到自己的目录（~/.cdt-guard/node 之类），
  #    那个目录**不在 PATH 里**。所以新手刚装完、还没重开终端时，
  #    `command -v node` 找不到，统计就会显示「0 台机器 0 个账号」——
  #    用户明明配好了机器，菜单却说他什么都没配，非常吓人。
  #    preflight_node 会先把本地目录加进 PATH，就认得出来了。
  if declare -F preflight_node >/dev/null 2>&1; then
    preflight_node >/dev/null 2>&1 || true
  fi
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] && declare -F local_node_bindir >/dev/null 2>&1; then
    local _lb=""
    _lb="$(local_node_bindir 2>/dev/null || true)"
    [ -n "$_lb" ] && [ -x "$_lb/node" ] && node_bin="$_lb/node"
  fi
  # 读到了 JSON 却连 node 都没有 → 是「读不到」，不是「没配」
  if [ -z "$node_bin" ]; then
    printf 'ERR'
    return 0
  fi
  local parsed=""
  parsed="$(printf '%s' "$raw" | "$node_bin" -e '
    let d="";
    process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const o=JSON.parse(d);
        const users=Array.isArray(o.users)?o.users:[];
        const aks=new Set(users.map(u=>String(u.ak||"").trim()).filter(Boolean));
        console.log(users.length+" "+aks.size);
      }catch(e){ console.log("PARSE_FAIL"); }
    });
  ' 2>/dev/null || true)"

  if [ -z "$parsed" ]; then
    printf 'ERR'
  elif [ "$parsed" = "PARSE_FAIL" ]; then
    printf 'ERR'
  else
    printf 'OK %s' "$parsed"
  fi
}

# 统一提取 worker 网址
#
# 复用 probe_worker_url（见上面 is_deployed 的说明）—— 不再只依赖本地文件，
# 这样「换了目录但云端还在」也能正确显示网址。
worker_url() {
  probe_worker_url 2>/dev/null | head -1 || true
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
    local _email=""
    _email="$(logged_in_email)"
    if [ -n "$_email" ]; then
      printf "  Cloudflare     ${GREEN}已登录${RESET}  ${DIM}%s${RESET}\n" "$_email"
    else
      printf "  Cloudflare     ${GREEN}已登录${RESET}\n"
    fi
  else
    printf "  Cloudflare     ${YELLOW}未登录${RESET}\n"
  fi

  local verified_url probe_rc
  verified_url="$(probe_worker_url 2>/dev/null)"
  probe_rc=$?
  case "$probe_rc" in
    0) printf "  Worker         ${GREEN}已部署（当前账号）${RESET}  %s\n" "$verified_url" ;;
    2) printf "  Worker         ${YELLOW}当前账号未部署${RESET}\n" ;;
    *) printf "  Worker         ${YELLOW}状态无法确认${RESET}（认证、网络或账号选择异常）\n" ;;
  esac

  if preflight_wrangler && is_logged_in; then
    local stats machines accounts
    stats="$(config_stats)"
    # 🔴 config_stats 是三态输出，必须分开判断（2026-10-11 修）：
    #    "OK n m" → 读到配置，n 台机器 m 个账号
    #    "EMPTY"  → 读到了，但确实没有机器（用户还没配，或配置被清空）
    #    "ERR"    → **读不到**（找不到 node / wrangler 失败 / 网络不通 / KV 编号指错）
    #
    #    旧实现把 ERR 也当成「0 台」，于是显示成「还没配机器」——
    #    用户明明配好了机器却被告知没配（用户实测反馈过这个）。
    #    现在 ERR 会**明确说出来**，用户才知道要去查，而不是白配一遍。
    case "$stats" in
      OK\ *)
        machines="$(printf '%s' "$stats" | awk '{print $2}')"
        accounts="$(printf '%s' "$stats" | awk '{print $3}')"
        if [ "${machines:-0}" -gt 0 ] 2>/dev/null; then
          printf "  监控配置       ${GREEN}已配 %s 台机器 / %s 个账号${RESET}\n" "$machines" "$accounts"
        else
          printf "  监控配置       ${YELLOW}还没配机器${RESET}  ${DIM}（选「3」开始配）${RESET}\n"
        fi
        ;;
      EMPTY)
        printf "  监控配置       ${YELLOW}还没配机器${RESET}  ${DIM}（选「3」开始配）${RESET}\n"
        ;;
      *)
        # ERR 或其他异常：**绝不**谎报成「还没配机器」
        printf "  监控配置       ${RED}读取失败${RESET}  ${DIM}（选「0」看排查方法）${RESET}\n"
        ;;
    esac
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
  printf "  · 检查 Cloudflare 登录（已登录就直接用，没登录才开浏览器）\n"
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
