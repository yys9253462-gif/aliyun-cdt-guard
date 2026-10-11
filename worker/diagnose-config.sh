#!/usr/bin/env bash
# ===========================================================================
# 诊断「监控配置」为什么显示「还没配机器」（只读，不改任何东西）
# 用法：双击「诊断监控配置.bat」，或 bash 诊断监控配置.sh
# ===========================================================================
set -u
cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "   诊断：监控配置识别"
echo "============================================================"
echo ""

echo "--- 1) 运行环境 ---"
echo "  SHELL        : ${SHELL:-（未设置）}"
echo "  BASH_VERSION : ${BASH_VERSION:-（非 bash）}"
echo "  当前目录     : $(pwd)"
echo "  是否登录模式 : $(shopt -q login_shell && echo 是 || echo 否)"
echo ""

echo "--- 2) Node 探测 ---"
if [ -n "${CDT_NODE_DIR:-}" ]; then
  echo "  CDT_NODE_DIR : $CDT_NODE_DIR"
  if [ -x "$CDT_NODE_DIR/node.exe" ]; then
    echo "    该目录持有 node.exe（本地自装 Node）"
  elif [ -x "$CDT_NODE_DIR/bin/node" ]; then
    echo "    该目录持有 bin/node（本地自装 Node）"
  else
    echo "    该目录为空或不存在（=> 使用的是系统 Node）"
  fi
else
  echo "  CDT_NODE_DIR : （未设置，脚本尚未加载 preflight 时属正常）"
fi
echo "  command -v node : $(command -v node 2>/dev/null || echo '（找不到！这就是问题）')"
echo "  node -v         : $(node -v 2>/dev/null || echo '（无法执行！）')"
echo ""

echo "--- 3) wrangler 探测 ---"
echo "  node_modules/.bin/wrangler     : $([ -x node_modules/.bin/wrangler ] && echo 存在 || echo 不存在)"
echo "  node_modules/.bin/wrangler.cmd : $([ -x node_modules/.bin/wrangler.cmd ] && echo 存在 || echo 不存在)"
echo "  全局 wrangler                  : $(command -v wrangler 2>/dev/null || echo '无')"
if [ -x node_modules/.bin/wrangler ]; then
  echo "  实际使用                       : 项目内（版本 $(node_modules/.bin/wrangler --version 2>/dev/null | tail -1)）"
elif command -v wrangler >/dev/null 2>&1; then
  echo "  实际使用                       : 全局（版本 $(wrangler --version 2>/dev/null | tail -1)）"
fi
echo ""

# 载入版本兼容层（用来判断是否需要 --remote）
if [ -f ./lib-kv.sh ]; then
  # shellcheck source=lib-kv.sh
  . ./lib-kv.sh
  _rf="$(kv_remote_flag)"
  if [ "$_rf" = "set" ]; then
    echo "  ⚠️ 检测到 **wrangler 4.x**：KV 命令默认操作本地存储，"
    echo "     必须加 --remote 才是云端。（本脚本已自动处理）"
  else
    echo "  检测到 wrangler 3.x：KV 命令默认就是云端，无需 --remote。"
  fi
  echo ""
fi

echo "--- 4) 云端 KV 里到底有没有 config（最关键的一步）---"
echo "  执行：kvx kv key get config --binding CDT_GUARD_KV --text"
echo "       （kvx 会自动按 wrangler 版本补 --remote）"
echo "  --------------------------------------------"
if declare -F kvx >/dev/null 2>&1; then
  raw="$(kvx kv key get config --binding CDT_GUARD_KV --text 2>&1 || true)"
else
  echo "  ⚠️ 没找到 lib-kv.sh，退回直接调用（可能在 4.x 上读错存储）"
  raw="$(wrangler kv key get config --binding CDT_GUARD_KV --text 2>&1 || true)"
fi
if [ -z "$raw" ]; then
  echo "  （命令没有任何输出！）"
else
  printf '%s\n' "$raw" | head -8 | sed 's/^/  | /'
fi
echo "  --------------------------------------------"
echo ""

echo "--- 5) 模拟 config_stats 的完整读取过程 ---"
line="$(printf '%s\n' "$raw" | grep -E '^\{.*\}$' | head -1 || true)"
if [ -z "$line" ]; then
  echo "  正则过滤后为空！=> 说明 wrangler 的输出里没有标准 JSON 行"
  echo "  （常见原因：报错信息、警告行、或输出被换行拆散）"
else
  echo "  正则过滤后拿到：$(printf '%s' "$line" | head -c 100)..."
  echo ""
  echo "  用 node 解析它："
  printf '%s' "$line" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const o=JSON.parse(d);
        const users=Array.isArray(o.users)?o.users:[];
        const aks=new Set(users.map(u=>String(u.ak||"").trim()).filter(Boolean));
        console.log("    解析成功 => 机器数="+users.length+" 账号数="+aks.size);
        if(users.length>0){
          console.log("    机器清单：");
          users.forEach((u,i)=>console.log("      "+(i+1)+". "+(u.name||"(无名)")+"  ["+(u.paused?"已暂停":"监控中")+"]"));
        }else{
          console.log("    注意：users 数组是空的 => 配置里确实没有机器");
        }
      }catch(e){
        console.log("    解析失败："+e.message);
        console.log("    => JSON 被破坏或被截断");
      }
    });
  ' 2>&1 || echo "    （node 执行失败：$(command -v node 2>/dev/null || echo 'node 都找不到')）"
fi
echo ""

echo "============================================================"
echo "   诊断结束。请把上面全部内容截图或复制发给我。"
echo "============================================================"
echo ""
read -r -p "按回车键关闭..." _ || true
