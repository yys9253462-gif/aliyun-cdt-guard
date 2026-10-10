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
# 逐项检查
# ---------------------------------------------------------------------------
# 每项返回 0=已就绪，1=缺失。**只报告，不安装** —— 安装由调用方决定。
preflight_node()  { command -v node  >/dev/null 2>&1; }
preflight_npm()   { command -v npm   >/dev/null 2>&1; }
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

  printf '%b\n' "${YELLOW}${BOLD}有项目还没就绪，按上面的说明处理后再来。${RESET}"
  # 缺 Node 是最常见的，直接把安装指引摊开
  if ! preflight_node; then
    print_node_install_guide
  else
    printf '\n处理完上面的问题后，回到菜单重新选「环境体检」即可。\n'
  fi
  return 1
}
