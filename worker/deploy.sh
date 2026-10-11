#!/usr/bin/env bash
# ===========================================================================
# CDT 流量守护 · Cloudflare 一键部署脚本
# ===========================================================================
#
# 这个脚本替你做三件事（每一步都会先问你，不会偷偷改东西）：
#   1. 检查环境（Node、wrangler 有没有装好）
#   2. 创建 KV 存储，并把返回的 id 自动写回 wrangler.toml
#   3. 上传密钥、部署代码、最后打印一条「点一下就能自检」的网址
#
# 用法：
#   bash deploy.sh           完整部署（推荐）
#   bash deploy.sh check     只检查环境，不改任何东西
#
# 所有提示都是中文。看不懂的地方把整屏内容发给我就行。
# ===========================================================================

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
# ⚠️ 这里用 return 而不是 exit：本文件会被 menu.sh 引用，
#    顶层 exit 会把菜单一起杀掉（configure.sh 里踩过这个坑）。
#    只有「直接运行」时才该退出，那种情况下 return 的效果等同于结束。
cd "$DIR" 2>/dev/null || { echo "无法进入项目目录"; return 1 2>/dev/null || exit 1; }

# 颜色与输出函数：公共库，三个脚本共用同一份（见 lib-ui.sh 里的说明）
# shellcheck source=lib-ui.sh
. ./lib-ui.sh

KV_NAME="CDT_GUARD_KV"

# ---------------------------------------------------------------------------
# 部署工具（wrangler）的调用方式
# ---------------------------------------------------------------------------
# ⚠️ 这里踩过一个坑（务必看清再改）：
#     最初全程用 `npx --no-install wrangler`。这个名字里的 --no-install
#     意思是「不许联网下载」，本意是防止 npx 偷偷装东西。
#     但后果是：项目里还没装 wrangler 时，**每一个调用都会失败**，
#     而且失败信息是英文的 npm 报错，用户完全看不懂，
#     表现就是「脚本跑到某一步突然自己关了」。
#
# 正确做法：
#     优先用项目本地装的 node_modules/.bin/wrangler（最稳，版本可控）；
#     找不到就退回 npx（允许它自动下载）；
#     两者都没有，就在第 1 步直接拦下并自动安装，不让问题拖到后面。
wrangler_cmd() {
  if [ -x "node_modules/.bin/wrangler" ]; then
    printf '%s' "node_modules/.bin/wrangler"
    return 0
  fi
  if [ -x "node_modules/.bin/wrangler.cmd" ]; then
    printf '%s' "node_modules/.bin/wrangler.cmd"
    return 0
  fi
  printf '%s' "npx wrangler"
}

WRANGLER="$(wrangler_cmd)"

# 统一的调用封装：所有地方都走它，方便换实现
wrun() {
  # shellcheck disable=SC2086
  $WRANGLER "$@"
}

# ---------------------------------------------------------------------------
# 第 1 步：环境检查
# ---------------------------------------------------------------------------
check_env() {
  step "第 1 步 / 检查环境"
  local failed=0

  if command -v node >/dev/null 2>&1; then
    ok "已安装 Node（版本 $(node -v)）"
  else
    err "没找到 Node。请先安装 Node.js：https://nodejs.org"
    failed=1
  fi

  if command -v npm >/dev/null 2>&1; then
    ok "已安装 npm（版本 $(npm -v)）"
  else
    err "没找到 npm。它一般随 Node 一起安装，请重装 Node。"
    failed=1
  fi

  [ "$failed" -ne 0 ] && return 1

  # ---- 部署工具：没有就当场装，绝不拖到后面 ----
  # （这里是「脚本自己关了」的根因所在，见文件上方 wrangler_cmd 的注释）
  if [ -x "node_modules/.bin/wrangler" ] || [ -x "node_modules/.bin/wrangler.cmd" ]; then
    ok "已安装部署工具（项目本地版本）"
  elif command -v wrangler >/dev/null 2>&1; then
    ok "已安装部署工具（全局版本）"
    WRANGLER="wrangler"
  else
    warn "还没安装部署工具（wrangler），现在自动安装..."
    printf "   这一步会联网下载，可能要一两分钟，请耐心等。\n\n"
    if ! npm install --no-audit --no-fund 2>&1 | tail -8; then
      err "自动安装失败。"
      printf "\n请手动执行这一条，成功后再重新运行本脚本：\n"
      printf "   ${CYAN}npm install${RESET}\n\n"
      printf "如果还失败，常见原因：\n"
      printf "  · 网络连不上 npm（国内可试试换淘宝镜像：\n"
      printf "    ${CYAN}npm config set registry https://registry.npmmirror.com${RESET}）\n"
      printf "  · Node 版本太老，建议用 18 以上\n"
      return 1
    fi
    # 重算调用方式
    WRANGLER="$(wrangler_cmd)"
    if [ -x "node_modules/.bin/wrangler" ] || [ -x "node_modules/.bin/wrangler.cmd" ]; then
      ok "部署工具安装完成。"
    else
      err "安装命令跑完了，但没找到部署工具。"
      printf "请把上面的输出发给我。\n"
      return 1
    fi
  fi

  if [ -f wrangler.toml ]; then
    ok "找到配置文件 wrangler.toml"
  else
    err "缺少配置文件 wrangler.toml。请确认在项目根目录运行本脚本。"
    return 1
  fi

  if [ -f src/index.js ]; then
    ok "找到程序入口 src/index.js"
  else
    err "缺少 src/index.js，代码不完整。"
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# 工具函数：把 KV 存储 id 补齐（无交互，可被多处复用）
# ---------------------------------------------------------------------------
# 🔴 这里踩过一个**很隐蔽的死锁坑**（务必看清再改，否则整个方案会失效）：
#
#   wrangler.toml 里 `id = ""` 时，**wrangler 的任何命令都会先解析配置再报错**，
#   连 `whoami`、`kv namespace list` 都不例外。实测报错就是：
#     X [ERROR] Processing wrangler.toml configuration:
#       - "kv_namespaces[0]" bindings should have a string "id" field but got
#         {"binding":"CDT_GUARD_KV","id":""}
#
#   → 所以「用 `kv namespace list` 去云端找 id」这个念头本身是**死锁**的：
#     要 list 就得先有个合法配置，而配置合法又正是我们要解决的事。
#     第一版就是栽在这 —— list 失败后输出为空，被程序误判成
#     「云端没有同名存储」，于是去新建，然后新建也失败，全线崩。
#
#   正确解法：**查之前，先把 [[kv_namespaces]] 整段临时注释掉**，
#   让 wrangler 能正常启动 → list 拿到真实数据 → 再写回 → 最后恢复结构。
#   （已验证：注释掉那 3 行后，`kv namespace list` 立刻正常返回。）
#
# 策略（顺序很重要）：
#   1. 备份 wrangler.toml
#   2. 临时注释掉 [[kv_namespaces]] 那 3 行，让 wrangler 可用
#   3. `kv namespace list`：
#        · 有同名存储 → 复用它的 id（不重复创建）
#        · 没有       → 新建一个，拿到 id
#      ⚠️ list 本身失败（网络/未登录等）与「真的没有」必须区分开，
#         否则会误去新建 —— 见下面的 rc 判断。
#   4. 把 id 写回 wrangler.toml，恢复正常结构
#   5. 任何一步失败 → 用备份整体还原，不留半截文件
#
# 返回：0 = 已就绪；非 0 = 没搞定（调用方负责给出中文指引）
ensure_kv_id() {
  local cfg="wrangler.toml"
  local backup="${cfg}.bak-$(date +%Y%m%d%H%M%S)"

  # 1) 备份
  cp "$cfg" "$backup" || { err "无法备份配置文件，已中止。"; return 1; }

  # 2) 临时注释掉 [[kv_namespaces]] 段的 3 行，让 wrangler 能启动
  #    用 python 做，避免 sed 在不同平台的转义差异；失败则还原。
  local tmpcfg="${cfg}.tmp-$$"
  local _PY
  if command -v python3 >/dev/null 2>&1; then _PY=python3; else _PY=python; fi
  if ! "$_PY" - "$cfg" "$tmpcfg" <<'PYEOF'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
# ⚠️ 必须用标准的 TOML 注释符 `#` 前缀！
#    踩坑记录：最初写的是自定义前缀 `_CDTGUARD_OFF_`，结果 wrangler 解析报
#      X [ERROR] Invalid character, expected "="
#      C:\...\wrangler.toml:40:5:  _CDTGUARD_OFF_ [[kv_namespaces]]
#    TOML 只认 `#` 开头为注释，前缀一改就是一个语法错误。
s = re.sub(r'^\[\[kv_namespaces\]\]', r'# CDT_GUARD_OFF [[kv_namespaces]]', s, flags=re.M)
s = re.sub(r'^binding\s*=\s*"CDT_GUARD_KV"', r'# CDT_GUARD_OFF binding = "CDT_GUARD_KV"', s, flags=re.M)
s = re.sub(r'^id\s*=\s*""', r'# CDT_GUARD_OFF id = ""', s, flags=re.M)
open(dst, "w", encoding="utf-8").write(s)
PYEOF
  then
    err "临时改写配置文件失败，已中止。"
    rm -f "$tmpcfg"
    rm -f "$backup"
    return 1
  fi
  cp "$tmpcfg" "$cfg" 2>/dev/null || { mv -f "$tmpcfg" "$cfg" 2>/dev/null || cp "$tmpcfg" "$cfg"; }
  rm -f "$tmpcfg"

  # 3) 现在 wrangler 可用了，去云端查同名存储
  local listed rc found_id="" clean=""
  listed="$(wrun kv namespace list 2>/dev/null)"
  rc=$?

  if [ $rc -ne 0 ] || [ -z "$listed" ]; then
    # ⚠️ 这一步特意与「没有同名存储」区分开：这多半是没登录 / 网络不通，
    #    绝不能再往下走「新建」，否则会误报成「新建失败」把用户带偏。
    err "查询云端存储列表失败（可能是还没登录，或网络不通）。"
    cp "$backup" "$cfg"
    rm -f "$backup"
    return 1
  fi

  # 🔴 关键一步：wrangler 会把警告（如「检测到代理环境变量」）**打到标准输出**，
  #    它和 JSON 混在一起会让解析器直接失败 —— 于是「解析失败」被误当成
  #    「云端没有同名存储」，脚本就会去新建一个重复的空间。
  #    实测就是栽在这：明明线上已有 CDT_GUARD_KV，却被判成「没有」。
  #    修法：只取从第一个 `[` 开始的内容，把前面的杂质行全部丢掉。
  clean="$(printf '%s' "$listed" | sed -n '/^\[/,$p')"
  [ -z "$clean" ] && clean="$listed"

  # 从 JSON 里找 title == KV_NAME 的那条的 id；优先 python，退化正则。
  if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    found_id="$(printf '%s' "$clean" | "$_PY" -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for item in (data or []):
    if item.get('title') == '$KV_NAME':
        print(item.get('id', ''))
        break
" 2>/dev/null)"
  else
    found_id="$(printf '%s' "$clean" | tr -d ' \n' \
      | grep -oE "\"id\":\"[0-9a-f]{32}\",\"title\":\"$KV_NAME\"" \
      | grep -oE '[0-9a-f]{32}' | head -1)"
  fi

  if [ -z "$found_id" ]; then
    printf "     云端没有同名存储，新建一个...\n"
    local output
    if ! output="$(wrun kv namespace create "$KV_NAME" 2>&1)"; then
      printf "%s\n" "$output"
      err "新建存储失败，已还原配置文件。"
      cp "$backup" "$cfg"
      rm -f "$backup"
      return 1
    fi
    found_id="$(printf '%s' "$output" | grep -oE '[0-9a-f]{32}' | head -1)"
  else
    ok "找到已有的同名存储，直接复用（不重复创建）：$found_id"
  fi

  if [ -z "$found_id" ]; then
    err "没有拿到存储 id，已还原配置文件。"
    cp "$backup" "$cfg"
    rm -f "$backup"
    return 1
  fi

  # 4) 从备份恢复结构，再把真实 id 填进去
  #
  # ⚠️ 这里**故意不用 sed** —— 踩过坑：
  #    交付包里的 wrangler.toml 是 **CRLF（Windows 行尾）**，而 Git Bash 的
  #    `sed -i` 会把 `\r` 当普通字符吃掉，结果是**整个文件 68 行行尾全变成 LF**。
  #    TOML 语义虽然不变，但等于把人家原文件格式改了一遍，属于不该有的副作用。
  #    改用 python：**只替换 id 那一行的值**，其余字节原样保留，行尾不受影响。
  cp "$backup" "$cfg" || return 1
  if "$_PY" - "$cfg" "$found_id" <<'PYEOF'
import re, sys
path, new_id = sys.argv[1], sys.argv[2]
with open(path, "rb") as fh:
    raw = fh.read()
text = raw.decode("utf-8")
# 只动 id 行的值，保留其行尾（\r\n 或 \n 都不碰）
new_text, n = re.subn(r'^(id\s*=\s*)"[^"]*"', lambda m: m.group(1) + '"' + new_id + '"',
                      text, count=1, flags=re.M)
if n == 0:
    sys.exit(1)
with open(path, "wb") as fh:
    fh.write(new_text.encode("utf-8"))
PYEOF
  then
    ok "存储 id 已写入配置文件：$found_id"
    printf "       ${DIM}（改动前的备份：%s）${RESET}\n" "$backup"
    return 0
  fi
  err "写配置文件失败，已从备份恢复。"
  cp "$backup" "$cfg"
  rm -f "$backup"
  return 1
}

# ---------------------------------------------------------------------------
# 第 2 步：登录 Cloudflare
# ---------------------------------------------------------------------------
do_login() {
  step "第 2 步 / 登录 Cloudflare 账号"

  # ⚠️⚠️ 这里踩过一个**很隐蔽**的坑（务必看清再改）：
  #
  #   交付包里 wrangler.toml 的 KV id 是**故意留空**的（`id = ""`），
  #   免得把作者的存储 id 泄露给下载的人。
  #
  #   但 wrangler 在**任何**命令启动时都会先解析 wrangler.toml。
  #   id 为空时，连 `wrangler whoami` 都会直接抛错退出：
  #     X [ERROR] "kv_namespaces[0]" bindings should have a string "id" field
  #
  #   后果是一条极难排查的连锁反应：
  #     1. `whoami` 因为配置错误而失败（不是没登录！）
  #     2. 脚本看不出来，误判成「没登录」→ 走「打开浏览器登录」分支
  #     3. `wrangler login` 同样因为配置错误而失败
  #     4. 用户看到的是「脚本卡住 / 登录失败」，
  #        完全想不到根因是「配置文件里一个空的 id」
  #
  #   实测（2026-10-11）：用户下载后就是这个表现，来问「为什么根本不弹窗」。
  #
  #   正确做法：**先判断配置是不是坏的**。如果 KV id 为空，
  #   就先用一个**不打扰用户**的修复函数把 id 补上
  #   （优先复用云端已有的同名存储，没有才新建）。
  if ! grep -qE '^id\s*=\s*"[0-9a-f]{32}"' wrangler.toml; then
    warn "配置文件里的存储 id 是空的 —— 这会让 wrangler 的所有命令都报错。"
    printf "     ${DIM}（交付包默认留空，防止泄露作者信息。现在自动帮你补上。）${RESET}\n\n"
    printf "     正在云端查找是否已有名为「%s」的存储...\n" "$KV_NAME"

    if ! ensure_kv_id; then
      err "存储 id 没能补上，登录无法继续。"
      printf "     你可以手动执行：${CYAN}wrangler kv namespace create %s${RESET}\n" "$KV_NAME"
      printf "     然后把输出里的 id 填进 wrangler.toml 的那一行。\n"
      return 1
    fi
    printf "\n"
    ok "存储 id 已就绪，现在检查登录状态。"
    printf "\n"
  fi

  # ⚠️ 原版检测到「已登录」时只打一行「已经登录过了，跳过。」就往下走。
  #    问题是菜单里写着「会打开浏览器让你登录」，用户没看到弹窗，
  #    第一反应就是「脚本坏了 / 卡住了」。
  #    所以现在**必须把已登录的账号明确打出来**，让用户知道：
  #      · 弹窗不是没出现，是根本不需要（已经登录过）
  #      · 登的是哪个账号（避免登错账号还不知道）
  if wrun whoami >/dev/null 2>&1; then
    local who
    who="$(wrun whoami 2>/dev/null)"

    # 从 whoami 输出里尽量抠出邮箱，抠不到也不影响主流程
    local email
    email="$(printf '%s' "$who" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | head -1)"

    printf "\n"
    ok "检测到你已经登录过 Cloudflare，${BOLD}不需要再弹窗登录${RESET}。"
    if [ -n "$email" ]; then
      printf "     当前账号：${CYAN}%s${RESET}\n" "$email"
    fi
    printf "     ${DIM}（所以这一步不会打开浏览器，直接往下走 —— 这是正常的）${RESET}\n\n"
    printf "     如果你想换一个账号登录，请先执行：${CYAN}wrangler logout${RESET}\n"
    printf "     然后再重新运行本脚本（或选菜单里的「重新部署」）。\n\n"
    return 0
  fi

  printf "接下来浏览器会自动打开，请在弹出的页面里点「允许」。\n"
  printf "如果浏览器没自动打开，把终端里显示的网址复制到浏览器里打开。\n\n"
  read -r -p "准备好了就按回车继续..." _

  if ! wrun login; then
    err "登录失败。可以改用「API 令牌」方式，或把报错发给我。"
    return 1
  fi
  ok "登录成功。"
}

# ---------------------------------------------------------------------------
# 第 3 步：创建 KV 存储
# ---------------------------------------------------------------------------
do_create_kv() {
  step "第 3 步 / 创建存储空间（KV）"

  # 先看看配置文件里是不是已经有真实的 id 了
  if grep -qE '^id\s*=\s*"[0-9a-f]{32}"' wrangler.toml; then
    local existing
    existing="$(grep -E '^id\s*=\s*"[0-9a-f]{32}"' wrangler.toml | head -1)"
    ok "配置文件里已经填好存储 id 了："
    printf "       %s\n" "$existing"
    read -r -p "要重新创建吗？(y/N) " answer
    case "$answer" in
      [Yy]*) ;;
      *) ok "保留现有存储，跳过。"; return 0 ;;
    esac
  fi

  # id 为空 → 复用公共的「补齐」逻辑（先找同名的，没有才建）
  if ! grep -qE '^id\s*=\s*"[0-9a-f]{32}"' wrangler.toml; then
    warn "配置文件里的存储 id 是空的（交付包默认如此，属正常）。"
    printf "     正在云端查找是否已有名为「%s」的存储...\n" "$KV_NAME"

    if ensure_kv_id; then
      return 0
    fi
    err "存储没能就绪。"
    return 1
  fi

  printf "正在创建存储空间「%s」...\n" "$KV_NAME"
  local output
  output="$(wrun kv namespace create "$KV_NAME" 2>&1)" || {
    err "创建失败，原始输出如下："
    printf "%s\n" "$output"
    return 1
  }
  printf "%s\n" "$output"

  # 从输出里抠出 id
  local kv_id
  kv_id="$(printf "%s" "$output" | grep -oE '[0-9a-f]{32}' | head -1)"

  if [ -z "$kv_id" ]; then
    warn "没能自动从输出里找出存储 id。"
    printf "请你手动看一眼上面输出里的 id（一串 32 位字母数字），\n"
    read -r -p "然后粘贴到这里： " kv_id
  fi

  [ -z "$kv_id" ] && { err "没有拿到存储 id，无法继续。"; return 1; }

  # 写回 wrangler.toml
  local backup="wrangler.toml.bak-$(date +%Y%m%d%H%M%S)"
  cp wrangler.toml "$backup"
  if sed -i.tmp -E "s|^id\s*=\s*\".*\"|id = \"$kv_id\"|" wrangler.toml; then
    rm -f wrangler.toml.tmp
    ok "存储 id 已写入配置文件（改动前的备份：$backup）"
    ok "存储 id：$kv_id"
  else
    err "写配置文件失败，已从备份恢复。"
    cp "$backup" wrangler.toml
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 第 4 步：写入密钥
# ---------------------------------------------------------------------------
# 记录「网址密钥」的全局变量。
# 为什么要记下来：第 6 步的自动自检要用它去访问 /setup 网址，
#   否则用户得手抄一遍密钥去拼网址 —— 这正是我们要消灭的麻烦。
# 为什么可以存盘：网址密钥是**我们自己编的**，不是云厂商发的凭据，
#   泄露了顶多被人访问自检页面（页面本身也不含敏感信息）。
#   ⚠️ 机器人令牌（TELEGRAM_BOT_TOKEN）是高敏感凭据，**绝不存盘**。
WEBHOOK_SECRET_VALUE=""

do_set_secrets() {
  step "第 4 步 / 写入密钥（只有你能看到）"

  printf "需要两项密钥。它们会被加密存进 Cloudflare，不会出现在代码里。\n\n"

  # ---- 机器人令牌 ----
  printf "${BOLD}① 机器人令牌${RESET}\n"
  printf "   找 @BotFather 要。它长得像：1234567890:AAxxxxxxxxxxxxxxxxxxxxxxx\n"
  printf "   如果你还没有机器人：在 Telegram 里找 @BotFather，发 /newbot，\n"
  printf "   按提示起个名字，它就会给你这串令牌。\n"
  local bot_token=""
  while true; do
    read -r -p "   粘贴机器人令牌（直接回车可跳过）： " bot_token || true
    [ -z "$bot_token" ] && break
    # 去掉首尾空格 —— 从聊天窗口复制令牌时极易带上空格或换行
    bot_token="$(printf '%s' "$bot_token" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$bot_token" ] && break

    # 🔴 格式校验：Telegram 机器人令牌的固定形态是「纯数字 : 一串字符」。
    #    老版本不校验，填错了也照样显示「已写入」——
    #    用户以为配好了，实际机器人一条消息都收不到，
    #    而且那个阶段很难判断到底是令牌错、还是网络错、还是代码错。
    #    这里在写之前就拦下来，并明确说清「哪里不对」。
    if printf '%s' "$bot_token" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{20,}$'; then
      break
    fi
    err "这不像一个机器人令牌：「${bot_token}」"
    printf "   正确形态是 ${CYAN}数字:一串字符${RESET}，例如：\n"
    printf "   ${CYAN}1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx${RESET}\n"
    printf "   常见错误：\n"
    printf "     · 只复制了冒号前面的数字部分（少了 : 和后半段）\n"
    printf "     · 复制时多了空格或换行（已自动帮你去掉首尾空格）\n"
    printf "     · 把「机器人用户名」当成令牌了（用户名不带冒号）\n"
    printf "   重试一次，或直接回车跳过（稍后可补）。\n"
  done

  if [ -n "$bot_token" ]; then
    if printf "%s" "$bot_token" | wrun secret put TELEGRAM_BOT_TOKEN >/dev/null 2>&1; then
      ok "机器人令牌已写入。"
    else
      err "机器人令牌写入失败。"
    fi
  else
    warn "跳过了。这会导致机器人收不到消息，稍后必须补上："
    printf "       npx wrangler secret put TELEGRAM_BOT_TOKEN\n"
  fi
  printf "\n"

  # ---- Webhook 密钥 ----
  printf "${BOLD}② 网址密钥（自己编一串随机字符）${RESET}\n"
  printf "   作用是让别人猜不到你的机器人入口。随便一串字母数字就行。\n"
  local suggested
  suggested="$(head -c 16 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || echo '')"
  [ -z "$suggested" ] && suggested="cdtguard$RANDOM$RANDOM"
  printf "   我帮你生成了一串，可以直接回车用它：${CYAN}%s${RESET}\n" "$suggested"
  read -r -p "   网址密钥： " webhook_secret
  [ -z "$webhook_secret" ] && webhook_secret="$suggested"
  if printf "%s" "$webhook_secret" | wrun secret put WEBHOOK_SECRET >/dev/null 2>&1; then
    ok "网址密钥已写入。"
    printf "   请记下它（自检要用）：${BOLD}%s${RESET}\n" "$webhook_secret"
    # 存进全局变量，供第 6 步自动自检使用（见本函数上方注释）
    WEBHOOK_SECRET_VALUE="$webhook_secret"
  else
    err "网址密钥写入失败。"
  fi
}

# ---------------------------------------------------------------------------
# 第 5 步：部署
# ---------------------------------------------------------------------------
# 关键改进：**部署时就把输出抓下来**。
# `wrangler deploy` 的输出里一定包含「上线后的网址」，这是唯一可靠的来源
# （`deployments list` 里没有，实测过）。
# 抓到的网址立刻写进 .worker-url 文件，第 6 步直接读，
# 也方便你以后忘了随时 `cat .worker-url` 查。
do_deploy() {
  step "第 5 步 / 上传部署"

  # ⚠️ 部署前的守卫（别删）：
  #    如果 KV id 还是空的，wrangler 会抛一条**英文**报错：
  #      X [ERROR] "kv_namespaces[0]" bindings should have a string "id" field
  #    用户看不懂，只会以为「包坏了」。
  #    这里提前拦下，用中文说清「该怎么办」——
  #    真正的原因几乎总是「跳过了第 3 步（创建存储）」。
  if ! grep -qE '^id\s*=\s*"[0-9a-f]{32}"' wrangler.toml; then
    err "配置文件里的存储 id 还是空的，现在部署一定失败。"
    printf "\n"
    printf "   原因：这一版交付包的 wrangler.toml 里，存储 id 是**故意留空**的，\n"
    printf "         需要先创建（或找回）一个存储空间，把 id 填进去。\n\n"
    printf "   怎么办（二选一）：\n"
    printf "     ${CYAN}·${RESET} 回到菜单选 ${BOLD}2) 一站式安装${RESET}，它会自动建好并填上；\n"
    printf "     ${CYAN}·${RESET} 或执行 ${CYAN}wrangler kv namespace create %s${RESET}，\n" "$KV_NAME"
    printf "       再把输出里的 id 填进 wrangler.toml 的那一行。\n\n"
    return 1
  fi

  local output=""
  local code=0
  output="$(wrun deploy 2>&1)" || code=$?

  printf '%s\n' "$output"

  if [ "$code" -ne 0 ]; then
    err "部署失败。把上面的报错发给我。"
    return 1
  fi

  # 从输出里抓网址（deploy 的输出格式是 ...  https://xxx.workers.dev）
  local url=""
  url="$(printf '%s\n' "$output" \
    | sed -n 's|.*\(https://[a-zA-Z0-9._-]*\.workers\.dev\).*|\1|p' 2>/dev/null || true)"
  url="${url%%$'\n'*}"

  if [ -n "$url" ]; then
    printf '%s\n' "$url" > .worker-url
    ok "部署成功。访问网址：$url"
  else
    ok "部署成功（没能自动识别网址，下一步会再试一次）"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 第 5.5 步：自动自检
# ---------------------------------------------------------------------------
# 为什么要有这一步（这是后来的改进）：
#     原来「自检」是让用户自己在浏览器里打开一串网址。
#     但那个网址长得像 `https://xxx.workers.dev/setup?key=一长串乱码`，
#     用户要么抄错、要么懒得抄，最后这一步等于没做 ——
#     出了问题也不知道是哪一步坏的。
#
#     现在由脚本自己用 curl 去打这个网址，**把结果直接打在终端里**：
#       · 全通过  -> 一眼看到「全好了」，不用做任何事
#       · 有失败  -> 直接看到是哪一项，而且下面会告诉你怎么办
#
#     它只做「读取」，不会修改云端任何东西，最坏情况也就是打不通。
do_selfcheck() {
  step "第 6 步 / 自动自检（你不用动，看着就行）"

  # ---- 先确认环境能不能做这件事 ----
  if ! command -v curl >/dev/null 2>&1; then
    warn "这台电脑没找到 curl，跳过了自动自检。"
    printf "   你可以自己打开浏览器访问自检网址（见最后一段）。\n"
    return 0
  fi

  local worker_url=""
  worker_url="$(probe_worker_url || true)"
  if [ -z "$worker_url" ]; then
    warn "没能确定程序的访问网址，跳过了自动自检。"
    printf "   部署本身是成功的，只是地址没自动认出来。\n"
    printf "   你可以到 Cloudflare 后台（dash.cloudflare.com）→ Workers 里\n"
    printf "   找到名为 cdt-guard 的项目，点进去就能看到它的网址。\n"
    return 0
  fi

  local secret="${WEBHOOK_SECRET_VALUE:-}"
  if [ -z "$secret" ] && [ -f .webhook-secret ]; then
    # 上次跑过、这次没重新输入密钥时，从本地记录里取
    secret="$(sed -n '1p' .webhook-secret 2>/dev/null | tr -d '\r\n' || true)"
  fi
  if [ -z "$secret" ]; then
    warn "手上没有网址密钥，跳过了自动自检。"
    printf "   自检网址是：${CYAN}%s/setup?key=你的网址密钥${RESET}\n" "$worker_url"
    return 0
  fi

  # ---- 真正去打这个自检网址 ----
  # ⚠️ 这里踩过两个坑，务必保留这段写法：
  #   1. 网址里的密钥含特殊字符时，必须整体用引号包住，否则 shell 会拆坏它；
  #   2. 不要用管道接 head 去截取响应 —— 上游 curl 会因「写入失败」退出，
  #      在 set -u 环境下会直接把整个脚本带崩（表现就是「脚本又关了」）。
  #      所以这里先把响应整个收进变量，再慢慢处理。
  printf "正在连接程序做自检，请稍等几秒...\n\n"

  local url="${worker_url}/setup?key=${secret}"
  local body=""
  local http_code=""
  body="$(curl -s --max-time 25 -w '\n__HTTP_CODE__%{http_code}' "$url" 2>/dev/null || true)"

  # 从响应末尾把状态码抠出来
  http_code="$(printf '%s' "$body" | sed -n 's/.*__HTTP_CODE__\([0-9]\{3\}\)$/\1/p' || true)"
  body="$(printf '%s' "$body" | sed 's/__HTTP_CODE__[0-9]\{3\}$//' || true)"

  if [ -z "$http_code" ] || [ "$http_code" = "000" ]; then
    warn "连不上自检网址（多半是网络问题，不是程序坏了）。"
    printf "   你可以稍后自己打开浏览器试试：\n"
    printf "   ${CYAN}%s${RESET}\n" "$url"
    return 0
  fi

  if [ "$http_code" = "403" ]; then
    err "自检被拒（403）——网址密钥对不上。"
    printf "   这说明程序里存的密钥，和你手上这串不一致。\n"
    printf "   最省事的解决办法：重跑一次密钥这一步，然后重新部署：\n"
    printf "     ${CYAN}bash deploy.sh${RESET}\n"
    return 0
  fi

  if [ "$http_code" = "404" ]; then
    err "自检网址不存在（404）——程序可能还是旧版本。"
    printf "   解决办法：重新部署一次：${CYAN}bash deploy.sh${RESET}\n"
    return 0
  fi

  if [ "$http_code" != "200" ]; then
    warn "自检返回了意外状态码：$http_code"
    printf "   把下面这段内容发给我看看：\n\n"
    printf "%s\n" "$body" | head -30
    return 0
  fi

  # ---- 200：把自检内容原样展示给用户 ----
  # 自检页面本身就是中文的，直接摊开给用户看最省事，
  # 也能让他自己核对「机器人令牌有没有、Webhook 通不通」。
  printf "%s\n" "$body" | head -60
  printf "\n"

  # 顺手帮用户判断「到底全好了没有」——
  # 页面里若有「失败 / 错误 / 没通过」这类字眼，就明确提示去看。
  if printf '%s' "$body" | grep -qE '失败|错误|没通过|未配置|不通'; then
    warn "自检里可能有没通过的项目，请对照上面内容看看。"
    printf "   上面标出问题的那一项，照着它的说明处理即可。\n"
  else
    ok "自检全部通过，程序已经跑起来了。"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 第 7 步：接着配置机器清单
# ---------------------------------------------------------------------------
# 为什么把配置并进一键流程（这是后来的改进）：
#     最初拆成两个脚本，理由是「先确认程序跑通再填数据」。
#     但实际用起来，用户分不清这两步的区别，只觉得「怎么还没弄完」；
#     而且部署完他刚登录 Cloudflare、注意力在线，
#     这时候顺口问机器信息是最省事的。分开跑意味着要重新进入状态。
#
#     配置逻辑本身在 configure.sh 里（run_configure 函数），
#     这里只是**引用**它，不复制代码 —— 两份实现早晚会走偏。
#     不想现在填的话，直接回车跳过，以后再跑 bash configure.sh。
do_configure() {
  step "第 7 步 / 告诉它要监控哪几台机器"

  printf "程序装好了，但它还不知道要盯哪几台机器。\n"
  printf "接下来会问你几台机器的信息（每项都有说明）。\n\n"
  printf "现在不想填也可以 —— 直接回车跳过，以后随时执行：\n"
  printf "%b\n\n" "   ${CYAN}bash configure.sh${RESET}"
  read -r -p "现在就填？(Y/n) " answer
  case "$answer" in
    [Nn]*) 
      warn "已跳过。机器人现在收不到任何机器信息，记得稍后补上。"
      return 0
      ;;
  esac

  # 引用配置脚本（它内部会判断「被引用时不自动跑 main」）
  if [ ! -f configure.sh ]; then
    err "找不到 configure.sh，无法引导配置。"
    printf "请确认它在同一个目录下。\n"
    return 0
  fi

  # shellcheck source=configure.sh
  . ./configure.sh

  # shellcheck disable=SC2034
  CONFIGURE_DONE_HINT=""
  if run_configure; then
    ok "机器清单已配好。"
    return 0
  else
    warn "机器清单没配完。想重试：bash configure.sh"
    return 0
  fi
}

# ---------------------------------------------------------------------------
# 最后一步：收尾指引
# ---------------------------------------------------------------------------
print_next_steps() {
  step "全部完成"

  local worker_url
  worker_url="$(probe_worker_url || true)"

  printf '%b\n' "${BOLD}接下来就能在手机上用了：${RESET}"
  printf '\n'

  printf '%s\n' "打开 Telegram，对你的机器人发送 /menu。"
  printf '%s\n' "底部应该跳出一排中文菜单按钮，那就全好了。"
  printf '\n'

  printf '%s\n' "如果没反应，用下面这条命令看它实时在干什么（Ctrl+C 退出）："
  printf '%b\n' "   ${CYAN}node_modules/.bin/wrangler tail${RESET}"
  printf '%s\n' "它会把你机器人的每一次响应打在屏幕上，报错也看得见。"
  printf '\n'

  printf '%s\n' "还有一个「自检网址」，随时可以在浏览器里打开核对："
  if [ -n "$worker_url" ]; then
    printf '%b\n' "   ${CYAN}${worker_url}/setup?key=你的网址密钥${RESET}"
  else
    printf '%b\n' "   ${CYAN}https://cdt-guard.你的账号名.workers.dev/setup?key=你的网址密钥${RESET}"
  fi
  printf '%s\n' "   （网址密钥在第 4 步给过你；忘了就重跑一次 bash deploy.sh 重设）"
  printf '\n'

  printf '%s\n' "常用管理命令："
  printf '%b\n' "   改机器清单   ${CYAN}bash configure.sh${RESET}"
  printf '%b\n' "   看当前配置   ${CYAN}bash configure.sh show${RESET}"
  printf '%b\n' "   看运行日志   ${CYAN}node_modules/.bin/wrangler tail${RESET}"
  printf '\n'

  printf '%s\n' "完整图文说明见同目录的「部署指南.md」。"
}

# ---------------------------------------------------------------------------
# 探测 Worker 的真实访问网址
# ---------------------------------------------------------------------------
# wrangler 3.x 不给网址，所以这里自己找：
#   1. 先从 .wrangler 缓存里翻（有时会记着上次部署的地址）
#   2. 不行就按 workers.dev 的命名规律构造候选，逐个实际访问
#   3. 哪个返回 200 就用哪个
# 全程失败也不要紧 —— 返回空串，调用方会给出兜底提示。
probe_worker_url() {
  # 0. 最可靠：第 5 步部署时抓下来的（这个文件就是为此存在的）
  if [ -f .worker-url ]; then
    local saved=""
    saved="$(sed -n 's|\(https://[a-zA-Z0-9._-]*\.workers\.dev\).*|\1|p' .worker-url 2>/dev/null | head -1 || true)"
    if [ -n "$saved" ]; then
      printf '%s' "$saved"
      return 0
    fi
  fi

  # 1. 从 .wrangler 缓存里翻
  local cached=""
  cached="$(find .wrangler -type f -name '*.json' -exec grep -l 'workers.dev' {} \; 2>/dev/null || true)"
  if [ -n "$cached" ]; then
    local found=""
    found="$(sed -n 's|.*\(https://[a-zA-Z0-9._-]*\.workers\.dev\).*|\1|p' $cached 2>/dev/null | head -1 || true)"
    if [ -n "$found" ]; then
      printf '%s' "$found"
      return 0
    fi
  fi

  # 2. 构造候选并实际访问（能连上才算）
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  # 账号名从 whoami 里取（形如 xxx.workers.dev 或邮件前缀）
  local account=""
  account="$(wrun whoami 2>/dev/null \
    | sed -n 's@.*[[:space:]]\([a-zA-Z0-9-]*\)\.workers\.dev.*@\1@p' 2>/dev/null | head -1 || true)"

  local candidates="cdt-guard.workers.dev"
  [ -n "$account" ] && candidates="cdt-guard.${account}.workers.dev ${candidates}"

  local candidate
  for candidate in $candidates; do
    local code=""
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${candidate}/" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      printf 'https://%s' "$candidate"
      printf 'https://%s\n' "$candidate" > .worker-url 2>/dev/null || true
      return 0
    fi
  done

  return 0
}

# ---------------------------------------------------------------------------
# 可复用的动作（由 menu.sh 调用，也可被单独执行）
# ---------------------------------------------------------------------------
# ⚠️ 设计变动说明（重要，别改回去）：
#   最初 deploy.sh 只有一个 main()，「打开就跑到底」。
#   后来加了交互式菜单，于是把 main() 拆成下面这些 **可组合的动作**：
#     run_full_deploy            完整安装（菜单里的「一站式安装」）
#     run_redeploy_only          只重新上传代码
#     run_login_only             只登录
#     run_selfcheck_only         只自检
#     run_reset_webhook_secret   只重设网址密钥
#
#   拆分的意义：菜单要能「只做其中一件事」。
#   如果还留着一个大 main()，菜单就只能整段调用，做不到分步。
#
#   所有动作都用 **return** 而不是 **exit** ——
#   因为它们是「被别人调用的」，一 exit 就把菜单也杀了
#   （这个坑在 configure.sh 里踩过一次，务必记住）。

# 把网址密钥存到本地（供自动自检使用）
# 为什么它能存：这是**我们自己编的**、不是云厂商发的凭据；
# 机器人令牌那种高敏感的东西**绝不存盘**。
save_webhook_secret_locally() {
  if [ -n "${WEBHOOK_SECRET_VALUE:-}" ]; then
    printf '%s\n' "$WEBHOOK_SECRET_VALUE" > .webhook-secret
    chmod 600 .webhook-secret 2>/dev/null || true
  fi
}

# ---- 只登录 ----
run_login_only() {
  do_login
}

# ---- 完整安装 ----
run_full_deploy() {
  if ! check_env; then
    err "环境检查没通过，请先解决上面标红的问题。"
    printf "提示：回到菜单选「1 环境体检」，它会用中文告诉你缺什么、怎么装。\n"
    return 1
  fi

  do_login       || return 1
  do_create_kv   || return 1
  do_set_secrets || return 1
  save_webhook_secret_locally

  do_deploy      || return 1
  do_selfcheck
  do_configure
  print_next_steps
}

# ---- 只重新上传代码 ----
run_redeploy_only() {
  if ! check_env; then
    err "环境检查没通过，先选「1 环境体检」。"
    return 1
  fi
  printf "这一步只重新上传代码，不动存储、不动密钥、不动机器配置。\n\n"
  do_deploy || return 1
  do_selfcheck
}

# ---- 只自检 ----
run_selfcheck_only() {
  do_selfcheck
}

# ---- 只重设网址密钥 ----
run_reset_webhook_secret() {
  printf "网址密钥的作用：让别人猜不到你的机器人入口。\n"
  printf "重设后需要重新部署一次，让 Telegram 知道新地址。\n\n"

  local suggested=""
  suggested="$(head -c 16 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || echo '')"
  [ -z "$suggested" ] && suggested="cdtguard$RANDOM$RANDOM"
  printf "我帮你生成了一串，直接回车用它：${CYAN}%s${RESET}\n" "$suggested"
  read -r -p "新网址密钥： " new_secret
  [ -z "$new_secret" ] && new_secret="$suggested"

  if printf "%s" "$new_secret" | wrun secret put WEBHOOK_SECRET >/dev/null 2>&1; then
    ok "新密钥已写入。"
    printf "   新密钥：${BOLD}%s${RESET}\n" "$new_secret"
    WEBHOOK_SECRET_VALUE="$new_secret"
    save_webhook_secret_locally
    printf "\n现在重新部署，让 Telegram 指向新地址...\n\n"
    do_deploy || return 1
    do_selfcheck
  else
    err "写入失败。请重试，或把报错发给我。"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 直接运行本脚本时的入口
# ---------------------------------------------------------------------------
# 两种用法：
#   1. 直接运行：bash deploy.sh          -> 跑完整安装
#   2. 被 menu.sh 引用：source 后调 run_* -> 由菜单决定做哪件事
# 靠下面这个「是否被直接执行」判断区分，被引用时不会自动跑。
main() {
  printf "${BOLD}==========================================${RESET}\n"
  printf "${BOLD} CDT 流量守护 · Cloudflare 一键部署${RESET}\n"
  printf "${BOLD}==========================================${RESET}\n"
  printf "全程中文提示，跟着走就行。\n"
  printf "${DIM}提示：直接运行本文件是「老手用法」。${RESET}\n"
  printf "${DIM}      第一次用建议跑 bash menu.sh，有菜单更好找。${RESET}\n"

  case "${1:-}" in
    check)
      check_env && ok "只做检查，到此结束。"
      return $?
      ;;
    login)     run_login_only ;;
    deploy|"") run_full_deploy ;;
    redeploy)  run_redeploy_only ;;
    selfcheck) run_selfcheck_only ;;
    *)
      printf "用法：bash deploy.sh            完整安装\n"
      printf "      bash deploy.sh check      只检查环境\n"
      printf "      bash deploy.sh login      只登录\n"
      printf "      bash deploy.sh redeploy   只重新上传代码\n"
      printf "      bash deploy.sh selfcheck  只自检\n"
      return 1
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
