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


def add_file(tf, full, arcname, exec_names):
    # arcname 形如 "cdt-guard-worker/menu.sh"，比较时要去掉顶层目录前缀
    rel = arcname.split("/", 1)[1] if "/" in arcname else arcname
    mode = 0o755 if (rel in exec_names or full.endswith(".sh")) else 0o644
    ti = tarfile.TarInfo(arcname)
    ti.size = os.path.getsize(full)
    ti.mode = mode
    ti.mtime = int(os.path.getmtime(full))
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    with open(full, "rb") as fh:
        tf.addfile(ti, fh)


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
    with open(out, "wb") as fh:
        fh.write(data)
    sha = hashlib.sha256(data).hexdigest()

    if missing:
        print("[警告] 以下内容不存在，没打进包：")
        for m in missing:
            print("   -", m)

    print("打包完成")
    print("  文件：", out)
    print("  大小：", len(data), "字节")
    print("  校验：", sha)

    # 列一下包内清单，方便核对
    print("  条目数：", len(tarfile.open(fileobj=io.BytesIO(data)).getnames()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
