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

DIR="$(cd "$(dirname "$0")" && pwd)"
# 直接运行时（bash configure.sh）目录不对才需要退出；
# 被 menu.sh 引用时由调用方负责，这里不该杀进程。
cd "$DIR" 2>/dev/null || { echo "无法进入项目目录"; exit 1; }

# 颜色与输出函数：公共库，三个脚本共用同一份（见 lib-ui.sh 里的说明）
# shellcheck source=lib-ui.sh
. ./lib-ui.sh

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
  print_config_pretty "$raw"
  return 0
}

# ---------------------------------------------------------------------------
# 把配置 JSON 打成「人能看懂」的样子
# ---------------------------------------------------------------------------
# ⚠️ 这里踩过一个**安全隐患**：
#     最早的版本直接把整段 JSON 原样打印出来，结果**明文密钥（Secret）
#     直接暴露在屏幕上** —— 一截屏、一录屏、旁边有人看一眼，密钥就漏了。
#     而且一坨 JSON 对新手也完全看不懂「到底在监控什么机器」。
#
# 所以这里做两件事：
#   1. 密钥一律打码，只留头尾几位（不同账号一眼能区分，中间看不到）；
#   2. 逐台机器分行显示，一眼看清监控了哪些机器、限额多少。
print_config_pretty() {
  local raw="$1"
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"

  # 没有 node 就退回「打码后的原始 JSON」——
  # 虽然不好看，但**绝不再泄露明文密钥**。
  if [ -z "$node_bin" ]; then
    printf "%s\n" "$raw" | sed -E 's/"sk":"[^"]*"/"sk":"已隐藏"/g'
    printf "\n"
    warn "本机没装 Node.js，无法排版显示；密钥已隐藏。"
    return 0
  fi

  printf '%s' "$raw" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let cfg;
  try { cfg = JSON.parse(data); } catch (_e) {
    console.log(data.replace(/"sk":"[^"]*"/g, "\"sk\":\"已隐藏\""));
    return;
  }

  // 打码规则：短的不动，长的留前 6 位 + 后 4 位。
  // 阿里云的 AccessKey 前缀高度相似，只留前 6 位会导致两个账号
  // 看起来一模一样，分不清哪台机器属于哪个账号。
  const maskAk = (ak) => {
    const v = String(ak || "").trim();
    if (!v) return "未填写";
    if (v.length <= 10) return v;
    return v.slice(0, 6) + "****" + v.slice(-4);
  };

  const chat = (cfg.telegram && cfg.telegram.chat_id) || "";
  console.log("  授权用户（Telegram 数字 ID）： " + (chat || "未设置"));
  console.log("");

  const users = Array.isArray(cfg.users) ? cfg.users : [];
  if (users.length === 0) {
    console.log("  还没有配置任何机器。");
    return;
  }

  // 按账号分组（同一个密钥 = 同一个阿里云账号）
  const groups = new Map();
  for (const u of users) {
    const key = u.ak || "(未填写)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }

  console.log("  共 " + users.length + " 台机器，分属 " + groups.size + " 个阿里云账号：");
  console.log("");

  let accountNo = 0;
  for (const [ak, list] of groups) {
    accountNo += 1;
    console.log("  ── 账号 " + accountNo + "：" + maskAk(ak) + " ──");
    for (const u of list) {
      const state = u.paused ? "已暂停" : "监控中";
      console.log("     · " + (u.name || "(未命名)")
        + "  [" + state + "]");
      console.log("       实例 ID：" + (u.instance_id || "(未填写)"));
      console.log("       地域：  " + (u.region || "(未填写)"));
      console.log("       限额：  " + (u.traffic_limit ?? "(未设置)") + " GB");
    }
    console.log("");
  }
});
' || true
}

# ---------------------------------------------------------------------------
# 输入校验
# ---------------------------------------------------------------------------
# ⚠️ 为什么必须校验：
#     实测发现，如果完全不校验，用户随手输个「q」也会被当成实例 ID 写进配置。
#     后果是**每 5 分钟就去阿里云查一台不存在的机器** ——
#     接口一直报错、日志一直刷、机器人看起来像坏了，
#     而且用户自己完全不知道是哪一步填错了。
#     所以在「写进去之前」就拦住，并明确告诉用户「长什么样才对」。
#
# 返回 0 = 格式正确；返回 1 = 格式不对（并已打印原因）
check_instance_id() {
  local v="$1"
  # 阿里云实例 ID 形如 i-5ts7fo7n0ui3stsujw0r：
  # 必须以 i- 开头，后面只跟小写字母和数字，长度 10 位以上。
  case "$v" in
    i-[0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z][0-9a-z]*)
      # 再确认没有大写/符号混进来
      if printf '%s' "$v" | grep -qE '^i-[0-9a-z]+$'; then
        return 0
      fi
      ;;
  esac
  err "实例 ID 格式不对：「${v}」"
  printf "   正确格式是以 ${CYAN}i-${RESET} 开头、后面跟一串小写字母和数字，\n"
  printf "   例如：${CYAN}i-5ts7fo7n0ui3stsujw0r${RESET}\n"
  printf "   在阿里云控制台「实例列表」里，点进机器就能复制到这一串。\n"
  return 1
}

# 地域代码形如 cn-hangzhou / ap-southeast-6 / us-west-1：
# 全是小写字母、数字和短横线，且至少含一个短横线。
check_region() {
  local v="$1"
  if printf '%s' "$v" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)+$'; then
    return 0
  fi
  err "地域代码格式不对：「${v}」"
  printf "   正确格式是小写字母加短横线，例如：\n"
  printf "   ${CYAN}cn-hangzhou${RESET} 杭州 / ${CYAN}ap-southeast-1${RESET} 新加坡 / "
  printf "${CYAN}ap-southeast-6${RESET} 菲律宾 / ${CYAN}ap-northeast-1${RESET} 东京\n"
  return 1
}

# 流量阈值必须是正整数（GB）
check_limit() {
  local v="$1"
  if printf '%s' "$v" | grep -qE '^[0-9]+$' && [ "$v" -gt 0 ]; then
    return 0
  fi
  err "流量阈值必须是正整数（单位 GB），你填的是：「${v}」"
  return 1
}

# Telegram 数字 ID：必须是纯数字（且至少 5 位，太短肯定填错了）
check_chat_id() {
  local v="$1"
  if printf '%s' "$v" | grep -qE '^[0-9]{5,}$'; then
    return 0
  fi
  err "这不像一个 Telegram 数字 ID：「${v}」"
  printf "   它应该是一串纯数字，例如 ${CYAN}7912011729${RESET}。\n"
  return 1
}

# 带重试的输入：重复问直到填对，或用户输 q 放弃
# 参数：$1 提示文案；$2 校验函数名
# 结果写入全局 _INPUT_VALUE，返回 0 表示拿到合法值，1 表示用户放弃
ask_validated() {
  local prompt="$1" checker="$2" answer=""
  while true; do
    read -r -p "$prompt" answer
    if [ -z "$answer" ]; then
      warn "不能为空 —— 直接回车不会用默认值，请认真填一个。"
      printf "   （想放弃这一台，输入 ${CYAN}q${RESET} 再回车）\n"
      continue
    fi
    case "$answer" in
      q|Q) info "已放弃这台机器。"; return 1 ;;
    esac
    if "$checker" "$answer"; then
      _INPUT_VALUE="$answer"
      return 0
    fi
    printf "   请重新输入（想放弃就输 ${CYAN}q${RESET} 再回车）。\n"
  done
}

# ---------------------------------------------------------------------------
# 询问一台机器（把结果追加进临时 JSON）
# ---------------------------------------------------------------------------
# 参数：
#   $1  序号（显示用）
#   $2  预设的 AccessKey ID（可选）—— 加账号时会传，就不重复问了
#   $3  预设的 AccessKey Secret（可选）
ask_one_machine() {
  local index="$1"
  local preset_ak="${2:-}"
  local preset_sk="${3:-}"
  printf "\n${BOLD}--- 第 %s 台机器 ---${RESET}\n" "$index"

  printf "① 给它起个名字（你认得出来就行，比如「菲律宾节点」）\n"
  read -r -p "   名字： " name
  [ -z "$name" ] && { warn "名字不能为空，跳过这台。"; return 1; }

  printf "② 实例 ID。在阿里云控制台实例列表里能找到，以 i- 开头，\n"
  printf "   比如 i-5ts7fo7n0ui3stsujw0r\n"
  ask_validated "   实例 ID： " check_instance_id || return 1
  local instance_id="$_INPUT_VALUE"

  printf "③ 地域代码。在控制台实例详情里能看到，比如：\n"
  printf "   cn-hangzhou 杭州 / ap-southeast-1 新加坡 / ap-southeast-6 菲律宾\n"
  printf "   ap-northeast-1 东京 / us-west-1 硅谷\n"
  ask_validated "   地域： " check_region || return 1
  local region="$_INPUT_VALUE"

  # AK/SK：加账号时已经问过了，直接沿用，不再重复问
  local ak="$preset_ak" sk="$preset_sk"
  if [ -n "$preset_ak" ] && [ -n "$preset_sk" ]; then
    printf "④ 这个账号的 AccessKey 已在前面填过，自动沿用。\n"
  else
    printf "④ AccessKey ID 与 Secret。在阿里云「访问控制」里创建，\n"
    printf "   建议用只读+开关机权限的子账号。\n"
    read -r -p "   AccessKey ID： " ak
    [ -z "$ak" ] && { warn "AccessKey ID 不能为空，跳过这台。"; return 1; }
    read -r -s -p "   AccessKey Secret（输入时不显示）： " sk
    printf "\n"
    [ -z "$sk" ] && { warn "AccessKey Secret 不能为空，跳过这台。"; return 1; }
  fi

  printf "⑤ 流量阈值（GB）。超过这个数就自动关机止损。\n"
  printf "   非中国内地免费额度是 200GB，建议填 180 留点缓冲。\n"
  read -r -p "   阈值（直接回车用 180）： " limit
  [ -z "$limit" ] && limit="180"
  # 阈值同样要校验：填个「abc」就会写进 JSON 变成非法数字，
  # 后端比较时比不出来，机器等于没被监控。所以也拦一下。
  if ! check_limit "$limit"; then
    warn "阈值用了默认值 180。想改的话，配完后在 Telegram 里点「单机操作」。"
    limit="180"
  fi

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
# 用一个账号的凭据，列出它下面有哪些机器
# ---------------------------------------------------------------------------
# 为什么要这个：让用户从列表里「认」机器，而不是去控制台手抄实例 ID。
#   手抄那串 i-5ts7fo7n0ui3stsujw0r 极度容易抄错，且抄错了不会立刻报错
#   （表现为「查不到数据」），排查起来很痛苦。
#
# 实现说明：这里直接调阿里云 API，签名逻辑与 Worker 里那份**必须一致**，
#   所以复用同一个思路（RPC 签名 + SignatureType 空值参与签名）。
#   用 node 跑一段内联脚本，逐地域扫一遍。
scan_account_instances() {
  local ak="$1" sk="$2"

  AK="$ak" SK="$sk" node -e '
    const crypto = require("crypto");
    const AK = process.env.AK, SK = process.env.SK;
    const pe = s => encodeURIComponent(s)
      .replace(/\+/g,"%20").replace(/\*/g,"%2A").replace(/%7E/g,"~");

    async function call(endpoint, action, version, extra) {
      const params = Object.assign({
        Format:"JSON", Version:version, AccessKeyId:AK, SignatureMethod:"HMAC-SHA1",
        Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),
        SignatureVersion:"1.0", SignatureNonce:crypto.randomUUID(),
        Action:action, SignatureType:""
      }, extra||{});
      const qs = Object.keys(params).sort()
        .map(k=>pe(k)+"="+pe(params[k])).join("&");
      const sig = crypto.createHmac("sha1", SK+"&")
        .update("POST&%2F&"+pe(qs)).digest("base64");
      const res = await fetch(endpoint, {
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body: qs+"&Signature="+pe(sig),
      });
      return JSON.parse(await res.text());
    }

    (async () => {
      // ---- 第 0 步：先验证凭据本身能不能用 ----
      // 这一步很关键：如果 AK/SK 就是错的，后面逐个地域扫会全部失败，
      // 最终输出「没扫到实例」—— 用户会以为「我账号里没机器」，
      // 其实是「你凭据填错了」。这两种情况的处理方式完全不同，
      // 所以必须先区分开，明确告诉用户是哪一种。
      const regions = [];
      let credOk = false;
      let credMsg = "";
      try {
        const r = await call("https://ecs.aliyuncs.com/","DescribeRegions","2014-05-26",{});
        if (r && r.Code) {
          // 有 Code 字段说明是错误响应（比如 SignatureDoesNotMatch / InvalidAccessKeyId）
          credMsg = r.Code + (r.Message ? ("：" + r.Message) : "");
        } else {
          credOk = true;
          for (const x of (((r.Regions||{}).Region)||[])) {
            if (x && x.RegionId) regions.push(x.RegionId);
          }
        }
      } catch (e) {
        credMsg = String(e && e.message || e);
      }

      if (!credOk) {
        console.log("  ✗ 这对 AccessKey 没能通过阿里云校验。");
        console.log("    阿里云的原话：" + (credMsg || "(无)"));
        console.log("");
        console.log("    常见原因（按可能性排序）：");
        console.log("      1. Secret 复制时漏了字符或带了空格 —— 重新复制一次；");
        console.log("      2. 这对 Key 已被禁用或删除 —— 去 RAM 控制台看一眼状态；");
        console.log("      3. 用了别的东西当 Key（比如账号 ID、登录密码）。");
        console.log("");
        console.log("    提示：查验完凭据再回来，扫不扫得到机器不影响配置。");
        return;
      }

      // 凭据没问题，但一个地域都拿不到（极罕见）→ 用常见地域兜底
      if (!regions.length) {
        regions.push("cn-hangzhou","cn-shanghai","cn-beijing","cn-shenzhen","cn-guangzhou",
                     "cn-hongkong","ap-southeast-1","ap-southeast-6","ap-northeast-1",
                     "us-west-1","us-east-1","eu-central-1");
      }

      let total = 0;
      const lines = [];
      for (const region of regions) {
        try {
          // ⚠️ 必须用地域专属端点：通用入口对新建海外地域返回 404
          const r = await call("https://ecs."+region+".aliyuncs.com/",
            "DescribeInstances","2014-05-26",{RegionId:region,PageSize:"100"});
          const list = ((r.Instances||{}).Instance)||[];
          for (const i of list) {
            total++;
            const ip = (i.EipAddress&&i.EipAddress.IpAddress)
              || ((i.PublicIpAddress||{}).IpAddress||[])[0] || "无公网IP";
            lines.push("    · "+(i.InstanceName||"(未命名)"));
            lines.push("       实例ID: "+i.InstanceId);
            lines.push("       地域:   "+region+"   状态: "+i.Status+"   IP: "+ip);
          }
        } catch(e) { /* 该地域无机器或没权限，跳过 */ }
      }

      // ---- 先给结论，再列明细 ----
      // 为什么不直接刷明细：用户第一眼要知道的是「有没有、几台」，
      // 如果没有，还得知道「是空账号还是别的原因」。先结论后明细
      // 能让「没扫到」这件事一眼可见，而不是淹没在一屏刷过去的输出里。
      if (total === 0) {
        console.log("  结论：凭据校验通过，但这个账号下没有扫到 ECS 实例。");
        console.log("        （如果你确定账号里有机器，可能是这把 Key 的分组/");
        console.log("          权限没覆盖到那些机器，不影响继续手工填写。）");
      } else {
        console.log("  结论：这个账号下共扫到 " + total + " 台 ECS 实例：");
        console.log("");
        for (const l of lines) console.log(l);
        console.log("");
        console.log("  提示：填下面那几项时，把「实例ID」和「地域」原样复制过来即可。");
      }
    })();
  ' 2>&1
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
  printf "接下来会问你几台机器的信息。${YELLOW}填完会覆盖上面的旧配置${RESET}。\n"
  printf "（如果只是想「再加一个账号」、不动现有机器，请改用菜单里的\n"
  printf "  ${CYAN}4 添加阿里云账号${RESET}，那个不会覆盖。）\n"
  printf "\n"
  # 明确给一个反悔点，而不是一进来就让人填 ——
  # 这是破坏性操作，必须先让人知道后果、再由他决定要不要开始。
  if ! confirm "确实要用新填的清单覆盖现有配置吗？"; then
    info "已取消，没有修改任何配置。"
    return 1
  fi

  : > "$TEMP_JSON"

  # ---- Telegram 数字 ID ----
  step "你的 Telegram 数字 ID"
  printf "这是用来确认「只有你能操作机器人」的。\n"
  printf "获取方法：在 Telegram 里搜索 ${CYAN}@userinfobot${RESET}，点开始，\n"
  printf "它会回你一条消息，里面的 Id 那串数字就是。\n"
  # 用重试循环，而不是「一次填错就整盘作废」——
  # 新手手滑多按一下回车很正常，不该因此从头再来一遍。
  local chat_id=""
  while true; do
    read -r -p "你的数字 ID（不想配了就输 q）： " chat_id
    case "$chat_id" in
      q|Q)
        info "已取消，没有修改任何配置。"
        return 1
        ;;
    esac
    if check_chat_id "$chat_id"; then
      break
    fi
    printf "   请重新输入。\n"
  done

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

  # 演练模式：只展示不写入。给测试和新手「先看一遍」用。
  if [ -n "${CDT_GUARD_DRY_RUN:-}" ]; then
    warn "演练模式（只看不写）：配置没有真的写入。"
    printf "   如果去掉演练开关，会写入上面确认过的那份内容。\n"
    rm -f "$cfg_file" "$TEMP_JSON"
    return 0
  fi

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
# 追加一个新阿里云账号（不动现有配置）
# ---------------------------------------------------------------------------
# 为什么单独做这个功能（老大的需求）：
#   run_configure 是「全量重填」，填错一个字就得从头再来，
#   而且想把第二个账号加进来时，会要求你把第一个账号的信息也重敲一遍 ——
#   对已经配好的人是纯折磨。
#
#   这个函数只做一件事：**往现有配置里追加**，现有机器一台都不碰。
#
# 多账号是怎么实现的（不用改后端）：
#   配置里的 users 是一个数组，每台机器自带自己的 ak/sk。
#   后端按 ak 自动分组（见 src/account-summary.js 的 groupByAccount），
#   ak 不同就是不同账号，各算各的免费额度。
#   所以「加账号」本质上就是「往数组里加几条带新 ak 的记录」。
run_add_account() {
  ensure_wrangler || return 1

  step "添加一个阿里云账号"
  printf "这个功能只**新增**，不会动你现有的机器配置。\n"
  printf "适合：你还有另一个阿里云账号，想一起监控。\n\n"

  # ---- 1. 先读出现有配置（要保留它）----
  # ⚠️ 这里原先写死了 node 的绝对路径，换台机器就找不到 node 直接报错。
  #    统一用 command -v 动态取，取不到再给出人话提示。
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ]; then
    err "没找到 Node.js，无法解析现有配置。"
    printf "   请先在菜单里选「1 环境体检」，按提示装好 Node.js。\n"
    return 1
  fi

  local raw=""
  raw="$(wrun kv key get config --binding CDT_GUARD_KV --text 2>/dev/null || true)"
  raw="$(printf '%s\n' "$raw" | grep -E '^\{.*\}$' | head -1 || true)"

  local existing_users="[]"
  local existing_chat=""
  if [ -n "$raw" ]; then
    existing_users="$(printf '%s' "$raw" | "$node_bin" -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        try{const o=JSON.parse(d);console.log(JSON.stringify(Array.isArray(o.users)?o.users:[]));}
        catch(e){console.log("[]");}})')"
    existing_chat="$(printf '%s' "$raw" | "$node_bin" -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        try{const o=JSON.parse(d);console.log(String(o.telegram?.chat_id||""));}
        catch(e){console.log("");}})')"

    local cnt=0
    cnt="$(printf '%s' "$existing_users" | "$node_bin" -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        try{console.log(JSON.parse(d).length);}catch(e){console.log(0);}})')"

    if [ "$cnt" -gt 0 ] 2>/dev/null; then
      printf "现有配置里有 ${BOLD}%s${RESET} 台机器：\n" "$cnt"
      printf '%s' "$existing_users" | "$node_bin" -e '
        let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
          try{
            const u=JSON.parse(d);
            const seen=new Set();
            for(const m of u){
              const ak=String(m.ak||"").trim();
              const label = ak ? (ak.slice(0,6)+"****"+ak.slice(-4)) : "未填AK";
              console.log("    · "+m.name+"  ("+m.region+")  ["+label+"]");
              seen.add(label);
            }
            if(seen.size>1) console.log("\n  → 当前已有 "+seen.size+" 个账号，新账号会并列显示在「账号汇总」里。");
          }catch(e){}})'
      printf "\n"
    fi
  else
    warn "当前还没有任何配置。"
    printf "      这会是第一个账号。\n\n"
  fi

  # ---- 2. 问新账号的凭据 ----
  step "新账号的凭据"
  printf "去这个账号的阿里云控制台 → 右上角头像 → 访问控制(RAM) → 用户 → 创建用户。\n"
  printf "勾选「OpenAPI 调用访问」，它会给你一对 AccessKey。\n"
  printf "${YELLOW}建议给子账号，只放开机和查询权限，别用主账号的。${RESET}\n\n"

  local ak="" sk=""
  read -r -p "AccessKey ID： " ak
  [ -z "$ak" ] && { err "AccessKey ID 不能为空。"; return 1; }
  read -r -s -p "AccessKey Secret（输入时不显示）： " sk
  printf "\n"
  [ -z "$sk" ] && { err "AccessKey Secret 不能为空。"; return 1; }

  # ---- 3. 用这对凭据去查这个账号下有哪些机器 ----
  step "正在查这个账号下有哪些机器..."
  printf "（用你刚给的凭据实际去连一次阿里云，请稍等）\n\n"

  local found=""
  found="$(scan_account_instances "$ak" "$sk" 2>&1 || true)"

  if [ -z "$found" ]; then
    warn "没能自动列出机器（可能是权限不够，或这个账号下确实没有 ECS）。"
    printf "      你可以手动填一台（后面还会问你）。\n\n"
  else
    printf "%s\n\n" "$found"
  fi

  # ---- 4. 逐台填（自动带好新账号的 AK/SK）----
  : > "$TEMP_JSON"
  local added=0 index=1
  while true; do
    if ask_one_machine "$index" "$ak" "$sk"; then
      added=$((added + 1))
      index=$((index + 1))
    fi
    printf "\n还要再加一台吗？(y/N) "
    read -r answer
    case "$answer" in
      [Yy]*) ;;
      *) break ;;
    esac
  done

  if [ "$added" -eq 0 ]; then
    warn "一台都没加，什么都没改。"
    rm -f "$TEMP_JSON"
    return 1
  fi

  # ---- 5. 追加到现有配置（关键：保留旧机器）----
  local new_users=""
  new_users="$(paste -sd, "$TEMP_JSON")"

  # chat_id：原来有就沿用，没有就问一次（同样支持重试）
  local chat="$existing_chat"
  if [ -z "$chat" ]; then
    printf "\n还需要你的 Telegram 数字 ID（只有你能操作机器人）。\n"
    printf "在 Telegram 搜 ${CYAN}@userinfobot${RESET}，它会回你一串数字。\n"
    while true; do
      read -r -p "数字 ID（不想配了就输 q）： " chat
      case "$chat" in
        q|Q) info "已取消，未做任何修改。"; rm -f "$TEMP_JSON"; return 1 ;;
      esac
      if check_chat_id "$chat"; then break; fi
      printf "   请重新输入。\n"
    done
  fi

  # 用 node 安全合并（避免手拼 JSON 出错）
  local merged=""
  merged="$(EXISTING="$existing_users" NEW="$new_users" CHAT="$chat" \
    "$node_bin" -e '
      const oldUsers = JSON.parse(process.env.EXISTING || "[]");
      const newUsers = JSON.parse("[" + (process.env.NEW || "") + "]");
      const merged = oldUsers.concat(newUsers);
      console.log(JSON.stringify({telegram:{chat_id:process.env.CHAT}, users: merged}));
    ')"

  if [ -z "$merged" ]; then
    err "合并配置出错，未做任何修改。"
    rm -f "$TEMP_JSON"
    return 1
  fi

  # ---- 6. 展示确认 ----
  step "写入前确认"
  # ⚠️ 这里原先写死了 node 的绝对路径（某台机器的本地路径），
  #    换台机器就找不到 node，会直接报错。必须用 command -v 动态取。
  local node_bin=""
  node_bin="$(command -v node 2>/dev/null || true)"
  local total="?"
  if [ -n "$node_bin" ]; then
    total="$(printf '%s' "$merged" | "$node_bin" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).users.length)}catch(e){console.log("?")}})')"
  fi
  printf "新配置共 %s 台机器（原有 + 新增）。密钥已打码：\n\n" "$total"
  printf '%s\n' "$merged" \
    | sed -E 's/"sk":"[^"]*"/"sk":"[已隐藏]"/g; s/"ak":"([^"]{6})[^"]{6,}(")/"ak":"\1****\2/g; s/"ak":"([^"]{6})[^"]*"/"ak":"\1****"/g'
  printf "\n"

  if ! confirm "确认写入？"; then
    info "已取消，未做任何修改。"
    rm -f "$TEMP_JSON"
    return 1
  fi

  # ---- 7. 写入 ----
  local cfg_file=".config-payload.json"
  printf '%s' "$merged" > "$cfg_file"

  # 演练模式：只展示不写入
  if [ -n "${CDT_GUARD_DRY_RUN:-}" ]; then
    warn "演练模式（只看不写）：新账号没有真的写入。"
    rm -f "$cfg_file" "$TEMP_JSON"
    return 0
  fi

  if wrun kv key put config --binding CDT_GUARD_KV --path "$cfg_file" >/dev/null 2>&1; then
    rm -f "$cfg_file"
    rm -f "$TEMP_JSON"
    ok "新账号已添加，共新增 $added 台机器。"
    printf "\n"
    printf "在 Telegram 里点「${CYAN}账号汇总${RESET}」就能看到两个账号各自的用量了。\n"
    return 0
  else
    err "写入失败。配置文件已留在 %s，方便重试。" "$cfg_file"
    rm -f "$TEMP_JSON"
    return 1
  fi
}


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
