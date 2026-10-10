#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包发布：把 cdt-guard-worker 打成 tar.gz 交付包。

为什么不用 `tar czf`：
  Windows 上 Git Bash 的 tar 会丢可执行位 —— 解压到 Linux 后
  .sh 脚本没有 x 权限，直接跑会 Permission denied。
  这里用 Python 的 tarfile 手工构造条目，手动设置 mode，
  保证跨平台解压后权限是对的。

只做一件事：打包 + 算 SHA256 + 打印结果。
"""
import hashlib
import io
import os
import re
import sys
import tarfile

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(os.path.dirname(PROJ), "交付物")
NAME = "cdt-guard-worker-20261010.tar.gz"
TOP = "cdt-guard-worker"

# 打进包里的内容（相对项目根）。目录会递归。
INCLUDE_FILES = [
    "README.md",
    "部署指南.md",
    "menu.sh",
    "安装.ps1",
    "启动.bat",
    "deploy.sh",
    "configure.sh",
    "lib-ui.sh",
    "lib-preflight.sh",
    "wrangler.toml",
    "package.json",
    "package-lock.json",
]
INCLUDE_DIRS = ["src", "tests"]

# 哪些要可执行
EXEC_FILES = {
    "menu.sh", "deploy.sh", "configure.sh",
    "lib-ui.sh", "lib-preflight.sh",
    "tests/run-all.sh", "tests/test-scripts.sh",
}

# ---------------------------------------------------------------------------
# 发布前脱敏：把「只有作者本机才该有的东西」替换成占位符
# ---------------------------------------------------------------------------
# 教训：曾经打出去的交付包里带着作者自己的 KV 命名空间 id、Worker 网址、
# Telegram Chat ID。任何人下载解压都能看到，既泄露隐私，又会让新手
# 把机器配到别人的存储上去。所以打包时强制抹掉，并做泄漏自检。
#
# 每条规则：(正则, 替换文本, 说明)
SCRUB_RULES = [
    # KV 命名空间 id 一律抹空 —— 一键脚本会自己创建并填好
    (r'^(\s*id\s*=\s*)"[^"]*"', r'\1""', "KV 命名空间 id"),
    # 作者的 Worker 网址 / 账号子域（子域里可能带点，字符类要含 .）
    (r'https://[A-Za-z0-9_.-]+\.workers\.dev', "https://<你的-worker>.workers.dev", "Worker 网址"),
]

# 这些模式一旦在包里出现，说明脱敏没生效，直接报错终止
LEAK_PATTERNS = [
    (r'\b[0-9a-f]{32}\b', "疑似 KV 命名空间 id（32 位十六进制）"),
    (r'https://[A-Za-z0-9_.-]+\.workers\.dev', "真实 Worker 网址"),
    (r'\bLTAI[0-9A-Za-z]{12,}\b', "疑似阿里云 AccessKey ID"),
]

# 允许出现的例外：说明文档 / 测试夹具里**一眼就是假的**占位符。
# 判定方式是「不区分大小写地包含这些词」，命中即放行。
LEAK_ALLOW_WORDS = [
    "fake", "example", "test", "your", "own", "dummy", "sample",
    "placeholder", "xxxx", "0000", "9999", "1234", "another",
    "account", "newacct", "brandnew", "deleted", "secret",
]
LEAK_ALLOW = [
    "https://<你的-worker>.workers.dev",
]


def _looks_fake(hit):
    low = hit.lower()
    return any(w in low for w in LEAK_ALLOW_WORDS)

# 哪些文件做文本脱敏
SCRUB_EXT = (".toml", ".md", ".sh", ".mjs", ".js", ".py", ".ps1", ".json")


# 这些扩展名的文件**必须保持原样换行**，不能被脱敏流程改写。
#   .bat  —— cmd.exe 只认 CRLF；一旦变成 LF，rem 注释行会被当命令执行，
#            实测表现为满屏「'xxx' 不是内部或外部命令」。这是踩过的真坑：
#            用 Git Bash 写 .bat 默认是 LF，双击立刻报一堆错。
CRLF_EXT = (".bat", ".cmd")


def scrub_bytes(rel, data):
    """对文本文件做脱敏，返回 (新内容, 命中说明列表)。"""
    # .bat/.cmd 逐行重拼会把 CRLF 压成 LF → 破坏文件。
    # 这里对它们只做「原样返回」，不参与脱敏（本来也不含敏感信息）。
    if rel.endswith(CRLF_EXT):
        return data, []
    if not rel.endswith(SCRUB_EXT):
        return data, []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data, []
    hits = []
    lines = text.split("\n")
    for i, line in enumerate(lines):
        for pat, rep, desc in SCRUB_RULES:
            new = re.sub(pat, rep, line)
            if new != line:
                hits.append(f"{rel}:{i + 1} 抹掉 {desc}")
                line = new
        lines[i] = line
    return "\n".join(lines).encode("utf-8"), hits


def scan_leaks(rel, data):
    """扫描是否残留敏感信息。"""
    if not rel.endswith(SCRUB_EXT):
        return []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return []
    found = []
    for pat, desc in LEAK_PATTERNS:
        for m in re.finditer(pat, text):
            hit = m.group(0)
            # 命中白名单整串、或整串命中白名单，都放行
            if any(a in hit or hit in a for a in LEAK_ALLOW):
                continue
            # 一眼即假的占位符放行（fake / example / test / xxxx ...）
            if _looks_fake(hit):
                continue
            line_no = text[:m.start()].count("\n") + 1
            found.append(f"{rel}:{line_no} 残留 {desc}：{hit}")
    return found


def add_file(tf, full, arcname, exec_names):
    # arcname 形如 "cdt-guard-worker/menu.sh"，比较时要去掉顶层目录前缀
    rel = arcname.split("/", 1)[1] if "/" in arcname else arcname
    mode = 0o755 if (rel in exec_names or full.endswith(".sh")) else 0o644
    with open(full, "rb") as fh:
        raw = fh.read()
    data, _ = scrub_bytes(rel, raw)
    ti = tarfile.TarInfo(arcname)
    ti.size = len(data)
    ti.mode = mode
    ti.mtime = int(os.path.getmtime(full))
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    tf.addfile(ti, io.BytesIO(data))
    return data


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, NAME)

    missing = []
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tf:
        # 顶层目录条目
        d = tarfile.TarInfo(TOP + "/")
        d.type = tarfile.DIRTYPE
        d.mode = 0o755
        d.mtime = 0
        d.uid = d.gid = 0
        d.uname = d.gname = "root"
        tf.addfile(d)

        for rel in INCLUDE_FILES:
            full = os.path.join(PROJ, rel)
            if not os.path.exists(full):
                missing.append(rel)
                continue
            add_file(tf, full, TOP + "/" + rel, EXEC_FILES)

        for sub in INCLUDE_DIRS:
            base = os.path.join(PROJ, sub)
            if not os.path.isdir(base):
                missing.append(sub)
                continue
            di = tarfile.TarInfo(TOP + "/" + sub + "/")
            di.type = tarfile.DIRTYPE
            di.mode = 0o755
            di.mtime = 0
            di.uid = di.gid = 0
            di.uname = di.gname = "root"
            tf.addfile(di)
            for root, dirs, files in os.walk(base):
                dirs[:] = [x for x in dirs if x != "__pycache__"]
                for fn in sorted(files):
                    if fn.endswith(".pyc"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, PROJ).replace(os.sep, "/")
                    add_file(tf, full, TOP + "/" + rel, EXEC_FILES)

    data = buf.getvalue()
    sha = hashlib.sha256(data).hexdigest()

    # ---- 二次自检：把整包解出来再过一遍脱敏扫描 ----
    # 不信任「打包时替换过了」，直接对着**产出物**再查一遍，这才算证据。
    leaks = []
    scrub_log = []
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        for ti in tf.getmembers():
            if not ti.isfile():
                continue
            rel = ti.name.split("/", 1)[1] if "/" in ti.name else ti.name
            raw = tf.extractfile(ti).read()
            _, hits = scrub_bytes(rel, raw)
            scrub_log.extend(hits)
            leaks.extend(scan_leaks(rel, raw))

    if missing:
        print("[警告] 以下内容不存在，没打进包：")
        for m in missing:
            print("   -", m)

    if scrub_log:
        print("[脱敏] 打包时抹掉了以下作者信息：")
        for h in sorted(set(scrub_log)):
            print("   -", h)

    print("打包完成")
    print("  文件：", out)
    print("  大小：", len(data), "字节")
    print("  校验：", sha)
    print("  条目数：", len(tarfile.open(fileobj=io.BytesIO(data)).getnames()))

    if leaks:
        print("")
        print("[严重] 包里仍残留敏感信息，已终止（不写出文件）：")
        for x in sorted(set(leaks)):
            print("   -", x)
        print("  请修掉源头后重新打包。交付包**没有**更新，仍是上一版。")
        return 2

    with open(out, "wb") as fh:
        fh.write(data)

    print("  泄漏自检：通过（未发现 KV id / Worker 网址 / AccessKey）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
