#!/usr/bin/env bash
# ===========================================================================
# KV 远端/本地 兼容层（wrangler 3.x / 4.x 通用）
# ===========================================================================
#
# 🔴 这个文件的由来（2026-10-11 用户实测定位的重大真凶）：
#
#   用户反馈：「我 cloudflare 已经配置了机器了，为什么还识别成没配」。
#   菜单状态栏显示「监控配置：还没配机器」，但云端 KV 里 config 明明有
#   一台机器（直接查得到）。
#
#   根因：**wrangler 4.x 把 KV 命令的默认作用域从「云端」改成了「本地」。**
#     · wrangler 3.x：`kv key get` 默认操作**云端**；要本地得显式 `--local`。
#     · wrangler 4.x：`kv key get` 默认操作**本地模拟存储**；要云端必须显式
#                      `--remote`（而且 `--local` 这个参数已被删除）。
#
#   项目里所有 KV 命令**都没写 --remote**，在 3.x 下是对的，
#   在 4.x 下就**全部打到了本地空存储**：读 config 得到「Value not found」，
#   于是菜单判定「还没配机器」。**不报错、不崩溃，静默错判** ——
#   这正是最危险的一类 bug。
#
#   更迷惑的是：「Worker 已部署」那一行**不受影响**（它靠访问网址判断，
#   不碰 KV），所以状态栏出现「已部署 + 还没配机器」这种自相矛盾的组合，
#   用户完全看不出是 wrangler 版本问题。
#
# 修法：所有 KV 的 **key 操作**统一走 kv_run，它会自动探测当前 wrangler
#       认不认 `--remote`：
#         · 认（4.x）  → 自动补上 --remote，确保操作云端
#         · 不认（3.x）→ 不加（3.x 默认就是云端）
#
# ⚠️ 注意：`kv namespace list` **不要**走 kv_run！
#    它没有「本地模拟版本」，不加 --remote 本来就对；加了反而报
#    「Unknown argument: remote」。所以只有 `kv key *` 系列才需要这层。
#
# 这个文件被 menu.sh / configure.sh / deploy.sh 共同引用，
# 保证「实现只有一份」，以后 wrangler 5.x 再改默认值，只改这里。
# ===========================================================================

# 探测当前 wrangler 是否需要显式 `--remote` 才能操作云端。
# 输出："set" = 需要加；"" = 不需要。
# 结论在进程内缓存（KV_REMOTE_PROBED），避免反复试跑。
KV_REMOTE_FLAG=""
KV_REMOTE_PROBED=""

kv_remote_flag() {
  if [ "$KV_REMOTE_PROBED" = "1" ]; then
    printf '%s' "$KV_REMOTE_FLAG"
    return 0
  fi
  KV_REMOTE_PROBED="1"
  KV_REMOTE_FLAG=""

  # 需要一个「能跑 wrangler 的命令」。优先复用调用方已有的解析函数，
  # 没有的话就自己找一遍（自包含，单独 source 本文件也能用）。
  local WC=""
  if declare -F kv_wrangler >/dev/null 2>&1; then
    WC="$(kv_wrangler)"
  elif [ -x "node_modules/.bin/wrangler" ]; then
    WC="node_modules/.bin/wrangler"
  elif [ -x "node_modules/.bin/wrangler.cmd" ]; then
    WC="node_modules/.bin/wrangler.cmd"
  elif command -v wrangler >/dev/null 2>&1; then
    WC="wrangler"
  fi

  if [ -z "$WC" ]; then
    printf '%s' ""
    return 0
  fi

  # 用 --help 探测（不产生网络请求、不读任何数据，最安全）
  local help_out=""
  help_out="$("$WC" kv key get --help 2>&1 || true)"
  if printf '%s' "$help_out" | grep -qE -- '--remote'; then
    KV_REMOTE_FLAG="set"
  fi
  printf '%s' "$KV_REMOTE_FLAG"
}

# 统一的 KV key 操作入口。
# 用法：kv_run <wrangler可执行文件> <kv 子命令...>
# 例：  kv_run "node_modules/.bin/wrangler" kv key get config --binding X --text
#
# 只给 **kv key *** 系列用（见文件头说明）。
kv_run() {
  local WC="$1"; shift
  local rf=""
  rf="$(kv_remote_flag)"
  if [ "$rf" = "set" ]; then
    "$WC" "$@" --remote
  else
    "$WC" "$@"
  fi
}

# 直接在当前目录跑（自动找 wrangler），省去调用方自己解析路径。
# 用法：kvx kv key get config --binding CDT_GUARD_KV --text
kvx() {
  local WC=""
  if declare -F kv_wrangler >/dev/null 2>&1; then
    WC="$(kv_wrangler)"
  elif [ -x "node_modules/.bin/wrangler" ]; then
    WC="node_modules/.bin/wrangler"
  elif [ -x "node_modules/.bin/wrangler.cmd" ]; then
    WC="node_modules/.bin/wrangler.cmd"
  elif command -v wrangler >/dev/null 2>&1; then
    WC="wrangler"
  else
    return 127
  fi
  kv_run "$WC" "$@"
}
