# 测试地域自动选择的解析逻辑（不依赖真实阿里云）
# 做法：把 install.sh 里的 auto_pick_instance 抽出，喂给它预制的 JSON 输出
# 说明：抽函数用「花括号配平」而非正则，避免被函数体内的缩进 } 截断

set -u
cd "$(dirname "$0")/.."
PY=/c/Users/small/.workbuddy/binaries/python/envs/default/Scripts/python.exe
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# ------------------------------------------------ 构建假的运行环境

# 假 python：忽略参数，回放 3 台实例（含菲律宾）
cat > "$WORK/bin/replay" << 'PYBIN'
#!/bin/bash
cat << 'JSON'
{"region":"ap-southeast-6","region_name":"菲律宾(马尼拉) ap-southeast-6","instance_id":"i-ph123456","name":"马尼拉节点","status":"Running"}
{"region":"cn-hongkong","region_name":"中国香港 cn-hongkong","instance_id":"i-hk7890","name":"","status":"Stopped"}
{"region":"ap-southeast-1","region_name":"新加坡 ap-southeast-1","instance_id":"i-sg5555","name":"新加坡机","status":"Running"}
JSON
PYBIN
chmod +x "$WORK/bin/replay"

mkdir -p "$WORK/fakepy"
# 假的 python3：探测调用放行，其余转发给回放器
cat > "$WORK/fakepy/python3" << PYBIN
#!/bin/bash
if [ "\$1" = "-c" ]; then exit 0; fi
exec "$WORK/bin/replay" "\$@"
PYBIN
chmod +x "$WORK/fakepy/python3"

printf 'placeholder' > "$WORK/list_instances.py"

# ------------------------------------------------ 抽取被测函数（花括号配平）

"$PY" - "$WORK" << 'EXTRACT'
import sys
work = sys.argv[1]
src = open('install.sh', encoding='utf-8').read()


def grab(name):
    """从源码里抓取一个 shell 函数，用花括号配平确定结束位置。"""
    start = src.find('\n%s() {' % name)
    if start < 0:
        raise SystemExit('找不到函数：%s' % name)
    i = src.find('{', start)
    depth = 0
    for j in range(i, len(src)):
        c = src[j]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return src[start + 1:j + 1]
    raise SystemExit('函数未闭合：%s' % name)


names = ['ask', 'find_working_python', 'auto_pick_instance']
body = '\n'.join(grab(n) for n in names)
header = (
    'set -u\n'
    'WORK_DIR="%s"\n'
    'VENV_DIR="${WORK_DIR}/venv"\n'
    "CYAN=''; GREEN=''; YELLOW=''; NC=''\n"
    'info(){ echo "[完成] $1"; }\n'
    'warn(){ echo "[注意] $1"; }\n'
) % work
open(work + '/funcs.sh', 'w', encoding='utf-8').write(header + body + '\n')
print('已抽取函数：' + '、'.join(names))
EXTRACT

# ------------------------------------------------ 断言工具

PASS=0
FAIL=0

run_case() {
    local label="$1" choice="$2" expect_region="$3" expect_id="$4"
    echo ""
    echo "===== $label ====="
    local out
    out=$( PATH="$WORK/fakepy:$PATH" bash -c "
        source '$WORK/funcs.sh'
        echo '$choice' | auto_pick_instance AK SK
    " 2>&1 )
    echo "$out" | sed 's/^/    /'
    local got_region got_id
    got_region=$(echo "$out" | grep -E '^(ap-|cn-|us-|eu-|me-)' | sed -n '1p')
    got_id=$(echo "$out" | grep -E '^i-' | sed -n '1p')
    if [ "$expect_region" = "NONE" ]; then
        if [ -z "$got_region" ] && [ -z "$got_id" ]; then
            echo "    [通过] 已正确退回手动填写"; PASS=$((PASS+1))
        else
            echo "    [失败] 应退回手动，实际 region=$got_region id=$got_id"; FAIL=$((FAIL+1))
        fi
    elif [ "$got_region" = "$expect_region" ] && [ "$got_id" = "$expect_id" ]; then
        echo "    [通过] 解析正确：$got_region / $got_id"; PASS=$((PASS+1))
    else
        echo "    [失败] 期望 $expect_region / $expect_id，实际 $got_region / $got_id"
        FAIL=$((FAIL+1))
    fi
}

run_case "场景 1：选第 1 台（菲律宾）" "1" "ap-southeast-6" "i-ph123456"
run_case "场景 2：选第 2 台（香港）" "2" "cn-hongkong" "i-hk7890"
run_case "场景 3：选第 3 台（新加坡）" "3" "ap-southeast-1" "i-sg5555"
run_case "场景 4：选 0（改为手动）" "0" "NONE" ""
run_case "场景 5：输入超范围编号 9" "9" "NONE" ""

echo ""
echo "=============================================="
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
if [ "$FAIL" -eq 0 ]; then
    echo "=== 地域自动选择解析测试全部通过 ==="
    exit 0
fi
exit 1
