#!/usr/bin/env bash
# ===========================================================================
# CDT 流量守护 · 环境体检（preflight）
# ===========================================================================
#
# 为什么单独开这个文件：
#   最初的版本把「检查环境」写在部署脚本里，一上来就要求 Node 装好，
#   没装就丢一句英文网址。对完全没接触过命令行的新手，这一步就卡死了 ——
#   他不知道自己缺什么、也不知道该装哪个版本、更不知道怎么验证装好了。
#
#   这个文件专门负责「用中文说清楚缺什么、怎么装、装完怎么验证」，
#   而且**逐项给分平台的命令**，而不是丢一个网址让他自己找。
#
# 被 menu.sh / deploy.sh 引用（source）。所有函数返回 0/1，不 exit。
# ===========================================================================

# ---------------------------------------------------------------------------
# 平台识别
# ---------------------------------------------------------------------------
# 输出：windows / macos / linux
detect_platform() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
    Darwin)               printf 'macos'   ;;
    Linux)                printf 'linux'   ;;
    *)                    printf 'unknown' ;;
  esac
}

# 中文平台名（给用户看的）
platform_name() {
  case "$(detect_platform)" in
    windows) printf 'Windows' ;;
    macos)   printf 'macOS'   ;;
    linux)   printf 'Linux'   ;;
    *)       printf '不认识的操作系统' ;;
  esac
}

# ---------------------------------------------------------------------------
# Node.js 自动安装（让完全没环境的小白也能一路走通）
# ---------------------------------------------------------------------------
# 设计取舍：
#   上一版只打印安装命令让用户自己跑 —— 对不懂命令行的人是死路。
#   这一版**先尝试自动装**：能自动就自动；自动不了才退回给指引。
#   自动装用的是「官方渠道 + 用户级目录」，不碰系统目录、不要 sudo，
#   装完不影响系统里已有的任何东西（万一用户已经有别的 Node）。
#
# 重要：装到 ~/.cdt-guard-node 下（用户目录），然后把 bin 目录加进
# PATH。这样既不需要管理员权限，也便于卸载（删一个目录就行）。

# 我们自己的 Node 安装位置
CDT_NODE_DIR="${CDT_NODE_DIR:-$HOME/.cdt-guard-node}"

# 把自动装的 Node 纳入 PATH（如果装过）
#
# 🔴 关键教训（踩了两次，务必记住）：
#   Windows 的 Node 包，可执行文件**在根目录**（node.exe / npm.cmd），
#   而 npm.cmd 内部会去 `%~dp0node_modules\npm\...` 找自己 ——
#   也就是说 **npm.cmd 必须和 node_modules 待在同一个目录才工作**。
#
#   我一开始想「把 node.exe 复制到 bin/ 统一路径」，结果：
#   · node 能跑（复制过来的是完整 exe）
#   · 但 npm 挂了（bin/ 下没有 node_modules）
#   ⇒ **不能拆散它们**。
#
#   正确做法：直接把 Node 的**根目录**加进 PATH。
#   Windows 上根目录里有 node.exe 和 npm.cmd，都能直接用。
preflight_use_local_node() {
  if [ -x "$CDT_NODE_DIR/node.exe" ]; then
    # Windows：根目录就是可执行目录
    export PATH="$CDT_NODE_DIR:$PATH"
    return 0
  fi
  if [ -x "$CDT_NODE_DIR/bin/node" ]; then
    # Linux / macOS：可执行文件在 bin/
    export PATH="$CDT_NODE_DIR/bin:$PATH"
    return 0
  fi
  return 1
}

# 当前生效的 Node 可执行目录（给需要绝对路径的地方用）
local_node_bindir() {
  if [ -x "$CDT_NODE_DIR/node.exe" ]; then
    printf '%s' "$CDT_NODE_DIR"
  elif [ -x "$CDT_NODE_DIR/bin/node" ]; then
    printf '%s' "$CDT_NODE_DIR/bin"
  fi
}

# 从 nodejs.org 拉最新 LTS 的版本号
# 输出：如 v22.11.0；失败输出空串
#
# 为什么用 python3 解析而不是 grep/sed：
#   index.json 是一整行超长 JSON，靠正则抠「第一个 lts 不为 false 的版本」
#   极易抠错（字段顺序、转义都会坑）。用 JSON 解析器一行搞定。
#   没有 python3 就退回内置兜底版本，不影响主流程。
fetch_node_lts_version() {
  local v=""
  if command -v python3 >/dev/null 2>&1; then
    v="$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null \
        | python3 -c '
import sys, json
try:
    for item in json.load(sys.stdin):
        if item.get("lts"):
            print(item["version"])
            break
except Exception:
    pass
' 2>/dev/null || true)"
  fi
  printf '%s' "$v"
}


# 自动安装 Node（分平台）。返回 0=成功，1=失败（调用方退回指引）
#
# 🔴 踩过的两个坑（重写时务必保持修好状态）：
#   坑 1 —— 两个平台的包结构不同：
#          Linux/macOS 解压后是 node-vX-<os>/bin/node（可执行文件在 bin 子目录）
#          Windows     解压后是 node-vX-win-x64/node.exe（可执行文件就在根目录）
#          一开始按 bin/ 统一处理，Windows 上就找不到 —— 而且更糟的是
#          「找不到」被系统里已有的 node 掩盖了，验证居然"通过"。
#   坑 2 —— `cp -R "$tmpdir"/node-*/ "$CDT_NODE_DIR"/` 在有些 shell 下
#          会把整个目录搬进去（变成 .../node-vX-win-x64/node.exe），
#          而不是把目录**里的内容**铺开。必须用 `"$src"/.` 明确表示「内容」。
auto_install_node() {
  local plat ver pkg url tmpdir arch src

  plat="$(detect_platform)"

  printf '\n%b\n' "${BOLD}准备自动安装 Node.js（装在你的用户目录下，不影响系统里已有版本）${RESET}"

  if ! command -v curl >/dev/null 2>&1; then
    printf '  %b 没有 curl，无法自动下载。请看下面的手动安装方式。\n' "${YELLOW}[跳过]${RESET}"
    return 1
  fi

  # 版本号：优先问官方接口，问不到就用一个已知稳定的兜底版本
  ver="$(fetch_node_lts_version)"
  if [ -z "$ver" ]; then
    ver="v22.11.0"
    printf '  %b 取官方最新版号失败，改用内置稳定版 %s\n' "${YELLOW}[提示]${RESET}" "$ver"
  fi
  printf '  将安装版本：%s\n' "$ver"

  # 架构
  arch="$(uname -m)"
  case "$plat" in
    linux)
      case "$arch" in
        x86_64|amd64)  pkg="node-${ver}-linux-x64.tar.xz" ;;
        aarch64|arm64) pkg="node-${ver}-linux-arm64.tar.xz" ;;
        *) printf '  %b 不认识的架构 %s，请看下面的手动安装方式。\n' "${YELLOW}[跳过]${RESET}" "$arch"; return 1 ;;
      esac
      ;;
    macos)
      case "$arch" in
        x86_64) pkg="node-${ver}-darwin-x64.tar.gz" ;;
        arm64)  pkg="node-${ver}-darwin-arm64.tar.gz" ;;
        *) printf '  %b 不认识的架构 %s\n' "${YELLOW}[跳过]${RESET}" "$arch"; return 1 ;;
      esac
      ;;
    windows)
      case "$arch" in
        x86_64|amd64) pkg="node-${ver}-win-x64.zip" ;;
        *) printf '  %b 不认识的架构 %s\n' "${YELLOW}[跳过]${RESET}" "$arch"; return 1 ;;
      esac
      ;;
    *)
      printf '  %b 不支持的系统，请看下面的手动安装方式。\n' "${YELLOW}[跳过]${RESET}"
      return 1
      ;;
  esac

  tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t cdtguard 2>/dev/null)"
  [ -z "$tmpdir" ] && tmpdir="/tmp/cdtguard-$$"
  mkdir -p "$tmpdir" 2>/dev/null || true

  # ---- 下载 ----
  url="https://nodejs.org/dist/${ver}/${pkg}"
  printf '  正在下载 %s（约 30-40 兆，看网速可能要一两分钟）...\n' "$pkg"
  if ! curl -fL --max-time 600 -o "$tmpdir/$pkg" "$url"; then
    printf '  %b 下载失败 —— 可能是网络不通。\n' "${RED}[失败]${RESET}"
    rm -rf "$tmpdir" 2>/dev/null || true
    return 1
  fi

  # ---- 解压 ----
  printf '  正在解压 ...\n'
  local unpacked=""
  case "$plat" in
    linux)
      if command -v tar >/dev/null 2>&1 && tar -xJf "$tmpdir/$pkg" -C "$tmpdir" 2>/dev/null; then
        unpacked="ok"
      fi
      ;;
    macos)
      if command -v tar >/dev/null 2>&1 && tar -xzf "$tmpdir/$pkg" -C "$tmpdir" 2>/dev/null; then
        unpacked="ok"
      fi
      ;;
    windows)
      if command -v unzip >/dev/null 2>&1 && unzip -q "$tmpdir/$pkg" -d "$tmpdir" 2>/dev/null; then
        unpacked="ok"
      elif command -v python3 >/dev/null 2>&1 && \
           python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmpdir/$pkg" "$tmpdir" 2>/dev/null; then
        unpacked="ok"
      fi
      ;;
  esac

  if [ -z "$unpacked" ]; then
    printf '  %b 解压失败（可能缺少解压工具）。\n' "${RED}[失败]${RESET}"
    rm -rf "$tmpdir" 2>/dev/null || true
    return 1
  fi

  # ---- 定位解压出来的目录 ----
  src=""
  for d in "$tmpdir"/node-*/; do
    [ -d "$d" ] && src="$d" && break
  done
  if [ -z "$src" ]; then
    printf '  %b 解压后没找到 node 目录。\n' "${RED}[失败]${RESET}"
    rm -rf "$tmpdir" 2>/dev/null || true
    return 1
  fi

  # ---- 安装到用户目录 ----
  # 🔴 用 "$src"/. 表示「目录里的内容」，而不是目录本身 ——
  #    否则会多套一层 node-vX-xxx/，导致后面找不到可执行文件。
  mkdir -p "$CDT_NODE_DIR" 2>/dev/null || true
  if ! cp -R "$src"/. "$CDT_NODE_DIR"/ 2>/dev/null; then
    # cp -R .../. 在个别平台上不被支持，退回逐项拷贝
    rm -rf "$CDT_NODE_DIR" 2>/dev/null || true
    mkdir -p "$CDT_NODE_DIR" 2>/dev/null || true
    if ! ( cd "$src" && cp -R . "$CDT_NODE_DIR"/ ) 2>/dev/null; then
      printf '  %b 安装失败（写入 %s 出错）\n' "${RED}[失败]${RESET}" "$CDT_NODE_DIR"
      rm -rf "$tmpdir" 2>/dev/null || true
      return 1
    fi
  fi
  rm -rf "$tmpdir" 2>/dev/null || true

  # ---- 验证 ----
  # 🔴 必须验证「我们刚装的那个」，不能只 `command -v node` ——
  #    系统里可能本来就有 node，那样会让验证假通过（实测踩过）。
  #    注意 Windows 上可执行文件在根（node.exe），Linux/macOS 在 bin/（node）。
  preflight_use_local_node
  local bindir="" installed=""
  bindir="$(local_node_bindir)"
  if [ -n "$bindir" ]; then
    if [ -x "$bindir/node.exe" ]; then
      installed="$bindir/node.exe"
    else
      installed="$bindir/node"
    fi
  fi

  if [ -n "$installed" ] && "$installed" -v >/dev/null 2>&1; then
    printf '  %b Node 安装成功（%s）\n' "${GREEN}[成功]${RESET}" "$("$installed" -v)"
    printf '  安装位置：%s\n' "$CDT_NODE_DIR"

    # npm 一起验证 —— 它随 Node 自带，但 Windows 上必须和 node_modules 同目录
    #
    # ⚠️ Windows 的 npm 是 npm.cmd，Git Bash 的 command -v 有时认不出 .cmd，
    #    所以这里既看 PATH，也直接看安装目录里有没有 npm.cmd / npm。
    local npm_ok=0 npm_ver=""
    if command -v npm >/dev/null 2>&1; then
      npm_ok=1
      npm_ver="$(npm -v 2>/dev/null || true)"
    elif [ -f "$CDT_NODE_DIR/npm.cmd" ] || [ -f "$CDT_NODE_DIR/bin/npm" ]; then
      # 存在但 PATH 没认出来 —— 让用户知道它是可用的
      npm_ok=1
      npm_ver="（已随 Node 一起装好）"
    fi
    if [ "$npm_ok" -eq 1 ]; then
      printf '  %b npm 也可用 %s\n' "${GREEN}[成功]${RESET}" "$npm_ver"
    else
      printf '  %b npm 没找到 —— 稍后可重跑一次本菜单\n' "${YELLOW}[提示]${RESET}"
    fi

    printf '  %b 装的位置在这个终端里立刻生效；重开终端后若找不到，执行一次：\n' "${CYAN}[提示]${RESET}"
    printf '     export PATH="%s:$PATH"\n' "$bindir"
    return 0
  fi

  printf '  %b 装完了但还是找不到 node，请看下面的手动安装方式。\n' "${RED}[失败]${RESET}"
  return 1
}


# ---------------------------------------------------------------------------
# 逐项检查
# ---------------------------------------------------------------------------
# 每项返回 0=已就绪，1=缺失。**只报告，不安装** —— 安装由调用方决定。
preflight_node() {
  preflight_use_local_node 2>/dev/null || true
  command -v node >/dev/null 2>&1
}

# npm 检测要同时认三种形态（实测踩坑）：
#   · command -v npm             —— Linux / macOS 正常情况
#   · 装好的 npm.cmd（Windows）  —— Git Bash 的 command -v 有时认不出 .cmd
#   · 装好的 bin/npm
preflight_npm() {
  preflight_use_local_node 2>/dev/null || true
  if command -v npm >/dev/null 2>&1; then
    return 0
  fi
  local bindir=""
  bindir="$(local_node_bindir)"
  [ -n "$bindir" ] && [ -f "$CDT_NODE_DIR/npm.cmd" ] && return 0
  [ -n "$bindir" ] && [ -f "$bindir/npm" ] && return 0
  return 1
}

preflight_curl()  { command -v curl  >/dev/null 2>&1; }
preflight_wrangler() {
  [ -x "node_modules/.bin/wrangler" ] || [ -x "node_modules/.bin/wrangler.cmd" ] \
    || command -v wrangler >/dev/null 2>&1
}

# Node 大版本号（取不到输出空串）
node_major() {
  local v=""
  v="$(node -v 2>/dev/null || true)"
  v="${v#v}"
  printf '%s' "${v%%.*}"
}

# ---------------------------------------------------------------------------
# 缺 Node 时，怎么装：逐平台给**可直接复制粘贴**的命令
# ---------------------------------------------------------------------------
# 设计要点：
#   · 不只给网址，要给「具体做什么」——新手要的是动作，不是链接。
#   · 每个平台都注明「装完怎么验证」，否则他装完还是不确定。
print_node_install_guide() {
  printf '\n'
  printf "%b\n" "${BOLD}你还没装 Node.js —— 它是这套程序运行的基础，必须先装。${RESET}"
  printf '\n'
  printf "根据你的系统，选一种装法：\n"

  case "$(detect_platform)" in
    windows)
      printf '\n%b\n' "${BOLD}【Windows】二选一${RESET}"
      printf '\n方案一（推荐，最省心）：\n'
      printf '  1. 打开 https://nodejs.org\n'
      printf '  2. 点绿色的 LTS 按钮下载（选 Windows Installer .msi）\n'
      printf '  3. 双击安装包，一路点「下一步」，不用改任何选项\n'
      printf '  4. %b\n' "${YELLOW}装完必须关掉当前这个终端窗口、重新打开一个${RESET}"
      printf '     （否则它认不出新装的 Node）\n'
      printf '\n方案二（如果你装了 winget，在终端里跑这一条）：\n'
      printf '  %b\n' "${CYAN}winget install OpenJS.NodeJS.LTS${RESET}"
      ;;
    macos)
      printf '\n%b\n' "${BOLD}【macOS】二选一${RESET}"
      printf '\n方案一（推荐，如果你装了 Homebrew）：\n'
      printf '  %b\n' "${CYAN}brew install node${RESET}"
      printf '\n方案二（没装 Homebrew）：\n'
      printf '  1. 打开 https://nodejs.org\n'
      printf '  2. 下载 macOS Installer (.pkg)\n'
      printf '  3. 双击按提示装完\n'
      ;;
    linux)
      printf '\n%b\n' "${BOLD}【Linux】按你的发行版选一条${RESET}"
      printf '\nUbuntu / Debian：\n'
      printf '  %b\n' "${CYAN}curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs${RESET}"
      printf '\nCentOS / RHEL / Alma / Rocky：\n'
      printf '  %b\n' "${CYAN}curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - && sudo yum install -y nodejs${RESET}"
      printf '\n任意发行版（用 nvm 管理器，最干净）：\n'
      printf '  %b\n' "${CYAN}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install --lts${RESET}"
      ;;
    *)
      printf '\n请到 https://nodejs.org 下载对应你系统的安装包。\n'
      ;;
  esac

  printf '\n%b\n' "${BOLD}装完怎么验证（重要）：${RESET}"
  printf '  在这个终端里敲：%b\n' "${CYAN}node -v${RESET}"
  printf '  能显示出类似 %b 的版本号，就说明装好了。\n' "v22.11.0"
  printf '  如果提示「找不到命令」，多半是没重开终端 —— 关掉重开再试。\n'
  printf '\n装好之后，回到这个菜单重新选一次就行。\n'
}

# ---------------------------------------------------------------------------
# 一键补齐环境：缺什么装什么，全程自动
# ---------------------------------------------------------------------------
# 返回 0=全部就绪，1=还有缺项（并已打印后续指引）
#
# 这是给「完全没环境的小白」的主入口 —— 他不该被要求先装这个再装那个，
# 脚本应该自己把能装的装上。
auto_setup_env() {
  printf '\n'
  printf '%b\n' "${BOLD}════ 一键补齐运行环境 ════${RESET}"
  printf '  脚本会自己下载安装缺的东西，你不用管。\n'

  # ---- Node ----
  if preflight_node; then
    printf '  %b Node.js 已在（%s），跳过\n' "${GREEN}[就绪]${RESET}" "$(node -v)"
  else
    printf '\n  Node.js 没装，现在自动装。\n'
    if auto_install_node; then
      :
    else
      printf '\n%b\n' "${YELLOW}自动安装没成功 —— 请按下面的方式手动装一次：${RESET}"
      print_node_install_guide
      return 1
    fi
  fi

  # ---- npm（随 Node 一起，应该已经有了）----
  if preflight_npm; then
    printf '  %b npm 已在（%s）\n' "${GREEN}[就绪]${RESET}" "$(npm -v)"
  else
    # 自动装的 Node 自带 npm；如果没有，说明路径没生效
    printf '  %b npm 没找到 —— 关掉终端重开一次，再跑一遍本菜单\n' "${RED}[缺失]${RESET}"
    return 1
  fi

  # ---- 部署工具（wrangler）：装到项目里 ----
  if preflight_wrangler; then
    printf '  %b 部署工具已在\n' "${GREEN}[就绪]${RESET}"
  else
    printf '\n  正在安装部署工具（首次会下载几十兆，稍等一两分钟）...\n'
    if npm install --no-audit --no-fund >/dev/null 2>&1; then
      printf '  %b 部署工具装好了\n' "${GREEN}[成功]${RESET}"
    else
      printf '  %b 部署工具没装上 —— 稍后在「一站式安装」里会自动重试\n' "${YELLOW}[待装]${RESET}"
      printf '     也可以手动跑一次：%b\n' "${CYAN}npm install${RESET}"
    fi
  fi

  # ---- 结论 ----
  printf '\n'
  if preflight_node && preflight_npm; then
    printf '%b\n' "${GREEN}${BOLD}环境已就绪，可以回去选「2 一站式安装」了。${RESET}"
    return 0
  fi
  printf '%b\n' "${YELLOW}${BOLD}还有项目没就绪，请按上面的说明处理后重来。${RESET}"
  return 1
}

# ---------------------------------------------------------------------------
# 一键体检：把「缺什么、怎么办」一次性讲清楚
# ---------------------------------------------------------------------------
# 返回值：0=全部就绪，1=有缺项（并已打印指引）
preflight_all() {
  local ready=1

  printf '\n%b\n' "${BOLD}环境体检${RESET}"
  printf '  你的系统：%s\n\n' "$(platform_name)"

  # ---- Node ----
  if preflight_node; then
    local major
    major="$(node_major)"
    if [ -n "$major" ] && [ "$major" -lt 18 ] 2>/dev/null; then
      printf '  %b Node.js 装了，但版本偏旧（%s）\n' "${YELLOW}[注意]${RESET}" "$(node -v)"
      printf '         建议 18 或以上。如果你的系统包管理器只能装到旧版，\n'
      printf '         用 nvm 装新版：%b\n' "${CYAN}https://github.com/nvm-sh/nvm${RESET}"
      ready=0
    else
      printf '  %b Node.js 已就绪（%s）\n' "${GREEN}[就绪]${RESET}" "$(node -v)"
    fi
  else
    printf '  %b Node.js %b没装%b —— 这是必须的\n' "${RED}[缺失]${RESET}" "${BOLD}" "${RESET}"
    printf '         %b（不用你操心：菜单里选「1」可以自动装）%b\n' "${CYAN}" "${RESET}"
    ready=0
  fi

  # ---- npm ----
  if preflight_npm; then
    printf '  %b npm 已就绪（%s）\n' "${GREEN}[就绪]${RESET}" "$(npm -v)"
  else
    if preflight_node; then
      printf '  %b npm 没找到 —— 它一般随 Node 一起装，建议重装 Node\n' "${RED}[缺失]${RESET}"
    else
      printf '  %b npm 没找到（先把 Node 装好，npm 会一起来）\n' "${RED}[缺失]${RESET}"
    fi
    ready=0
  fi

  # ---- 部署工具 ----
  if preflight_wrangler; then
    printf '  %b 部署工具已就绪\n' "${GREEN}[就绪]${RESET}"
  else
    if preflight_npm; then
      printf '  %b 部署工具没装 —— 不用担心，安装时会自动帮你装\n' "${YELLOW}[待装]${RESET}"
    else
      printf '  %b 部署工具没装（先装 Node/npm）\n' "${RED}[缺失]${RESET}"
    fi
    # 「待装」不算失败：安装流程会自动装它
  fi

  # ---- curl（可选，只影响自动自检）----
  if preflight_curl; then
    printf '  %b 网络工具已就绪（自动自检会用到）\n' "${GREEN}[就绪]${RESET}"
  else
    printf '  %b 没找到 curl —— 不影响安装，只是最后「自动自检」要你手动开浏览器\n' "${YELLOW}[可选]${RESET}"
  fi

  # ---- 项目文件是否齐全 ----
  printf '\n'
  if [ -f wrangler.toml ] && [ -f src/index.js ]; then
    printf '  %b 程序文件完整\n' "${GREEN}[就绪]${RESET}"
  else
    printf '  %b 程序文件不完整 —— 请确认在项目目录里运行（缺 wrangler.toml 或 src/index.js）\n' "${RED}[缺失]${RESET}"
    printf '         当前目录：%s\n' "$(pwd)"
    ready=0
  fi

  # ---- 结论 ----
  printf '\n'
  if [ "$ready" -eq 1 ]; then
    printf '%b\n' "${GREEN}${BOLD}体检通过，可以开始安装了。${RESET}"
    return 0
  fi

  printf '%b\n' "${YELLOW}${BOLD}有项目还没就绪。${RESET}"

  # 缺 Node 是最常见的 —— 直接问要不要自动装，而不是丢一堆命令让人自己选
  if ! preflight_node; then
    printf '\n%b\n' "${BOLD}Node.js 缺失。要现在自动安装吗？${RESET}"
    printf '  （装在你的用户目录下，不动系统里已有的东西，也不需要管理员密码）\n\n'
    local ans=""
    read -r -p "  输入 y 回车 = 自动装 / 直接回车 = 看手动安装方式： " ans
    printf '\n'
    case "$ans" in
      y|Y|yes|YES)
        if auto_setup_env; then
          return 0
        fi
        return 1
        ;;
      *)
        print_node_install_guide
        ;;
    esac
  else
    printf '\n处理完上面的问题后，回到菜单重新选「环境体检」即可。\n'
  fi
  return 1
}
