#!/usr/bin/env bash
# 部署守卫自检（不联网）：缺少 Durable Object 时必须拒绝部署
# ===========================================================================
# 线上数据主存储在 DO「GuardCoordinator」里。用缺少它的旧代码部署，
# Cloudflare 会把 DO 和里面的配置、状态一起删掉。这里钉死 do_deploy 的守卫。
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "  ✅ $1"; }
bad() { fail=$((fail + 1)); echo "  ❌ $1"; }

# 在临时目录里用假的 wrangler.toml / src 跑 do_deploy，wrun 打桩成「记录被调用」
run_case() {
  local toml="$1" with_src="$2"
  local tmp
  tmp="$(mktemp -d)"
  cp "$DIR"/deploy.sh "$DIR"/lib-*.sh "$tmp"/
  mkdir -p "$tmp/src"
  printf '%s\n' "$toml" > "$tmp/wrangler.toml"
  if [ "$with_src" = "yes" ]; then
    printf 'export class GuardCoordinator {}\n' > "$tmp/src/coordinator.js"
  fi
  # deploy.sh 用 $0 定位自己的目录，所以要在临时目录里用 bash -c 加载它
  (
    cd "$tmp" || exit 99
    bash -c '. ./deploy.sh >/dev/null 2>&1
      wrun() { echo WRUN_CALLED > ./called; echo "https://x.workers.dev"; return 0; }
      do_deploy >/dev/null 2>&1'
  )
  local code=$?
  local called=no
  [ -f "$tmp/called" ] && called=yes
  rm -rf "$tmp"
  echo "$code $called"
}

KV='id = "0123456789abcdef0123456789abcdef"'
DO='[[durable_objects.bindings]]
name = "CDT_COORDINATOR"
class_name = "GuardCoordinator"'

echo "--- 1. 缺少 DO 绑定：拒绝部署 ---"
read -r code called <<< "$(run_case "$KV" yes)"
[ "$code" != "0" ] && ok "返回失败（退出码 $code）" || bad "竟然返回成功"
[ "$called" = "no" ] && ok "没有调用 wrangler deploy" || bad "调用了 wrangler deploy"

echo "--- 2. 有绑定但缺 src/coordinator.js：拒绝部署 ---"
read -r code called <<< "$(run_case "$KV
$DO" no)"
[ "$code" != "0" ] && ok "返回失败（退出码 $code）" || bad "竟然返回成功"
[ "$called" = "no" ] && ok "没有调用 wrangler deploy" || bad "调用了 wrangler deploy"

echo "--- 3. 绑定与类都在：放行 ---"
read -r code called <<< "$(run_case "$KV
$DO" yes)"
[ "$called" = "yes" ] && ok "通过守卫并调用了 wrangler deploy" || bad "被误拦（退出码 $code）"

echo ""
echo "部署守卫自检：通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ]
