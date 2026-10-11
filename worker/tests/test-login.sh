#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. ./lib-ui.sh
. ./lib-preflight.sh
eval "$(sed -n '/^do_login() {/,/^}/p' deploy.sh)"
fail=0
check() { if "$@"; then echo "PASS: $*"; else echo "FAIL: $*"; fail=$((fail+1)); fi; }
cf_auth_run() { printf 'You are not authenticated. Please run `wrangler login`.\n'; return 0; }
check bash -c 'true'
if cf_is_logged_in; then echo 'FAIL: unauthenticated exit 0'; fail=$((fail+1)); else echo 'PASS: unauthenticated exit 0 rejected'; fi
cf_auth_run() { echo 'You are logged in with an OAuth Token, associated with the email test@example.com!'; }
check cf_is_logged_in
ensure_kv_id() { echo 'FAIL: auth attempted KV repair'; return 1; }
check do_login
cf_auth_run() {
 case "$*" in
 'whoami') [ -f "$state" ] && echo 'You are logged in with an OAuth Token.' || echo 'You are not authenticated.' ;;
 'login --help') echo '--device' ;;
 'login --device') touch "$state" ;;
 *) return 1 ;;
 esac
}
state="$(mktemp)"; rm -f "$state"
check do_login <<< ''
rm -f "$state"
cf_auth_run() { return 1; }
if cf_is_logged_in; then fail=$((fail+1)); else echo 'PASS: command failure rejected'; fi
exit "$fail"
