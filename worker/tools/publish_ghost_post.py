#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ghost 文章发布器（幂等）

用法：
    python3 publish_ghost_post.py --meta-file post.meta.json

meta.json 字段：
    title           必填，标题
    markdown_file   必填，本地 Markdown 文件路径（也兼容 html_file）
    html_file       可选，直接给 HTML（与 markdown_file 二选一）
    slug            可选，不填由 Ghost 生成
    tags            可选，字符串数组
    custom_excerpt  可选，摘要
    status          可选，draft | published，默认 published
    post_id         可选，给了就按 id 更新（强烈建议更新时用）
    feature_image   可选，封面图 URL

设计要点（都是踩坑总结，不要改）：
  1. html 字段必须配 ?source=html，否则 Ghost 静默忽略 → 文章建出来但正文全空。
  2. POST/PUT 响应不返回 html，所以响应里 html 为空不代表失败。
  3. 更新必须带 updated_at（乐观锁），所以要先把当前值 GET 回来。
  4. 更新优先用 post_id；按 slug 找会被自动数字 slug 守护脚本改名，导致查不到又建一篇。
  5. Markdown 转换只认 ## 和 ###，h4 会被降级成 <p><strong>，别用 ####。
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

SITE = os.environ.get("GHOST_SITE", "https://isoziyuan.com")

SECRETS_FILES = ["/root/.env.secrets", os.path.expanduser("~/.env.secrets")]


def _b64url(raw):
    """JWT 用的 base64url（去掉 padding）。"""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def load_secrets():
    """从 .env.secrets 读 GHOST_ADMIN_API_KEY，返回 (id, secret_hex)。"""
    raw = ""
    for p in SECRETS_FILES:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                raw = f.read()
            break
    if not raw:
        print("找不到 .env.secrets", file=sys.stderr)
        sys.exit(1)
    m = re.search(r"^GHOST_ADMIN_API_KEY=(.+)$", raw, re.M)
    if not m:
        print(".env.secrets 里没有 GHOST_ADMIN_API_KEY", file=sys.stderr)
        sys.exit(1)
    val = m.group(1).strip().strip('"').strip("'")
    if ":" not in val:
        print("GHOST_ADMIN_API_KEY 格式应为 <id>:<secret_hex>", file=sys.stderr)
        sys.exit(1)
    kid, secret = val.split(":", 1)
    return kid, secret


def make_token(kid, secret_hex):
    """
    Ghost Admin API 的 JWT：HS256，header 带 kid，payload aud=/admin/。

    这里手写 HMAC-SHA256 而不用 PyJWT —— 服务器上没装这个库，
    为了发一篇文章去装个新依赖不值得，而 JWT 这三段拼装本来就没几行。
    """
    iat = int(time.time())
    header = {"alg": "HS256", "typ": "JWT", "kid": kid}
    payload = {"iat": iat, "exp": iat + 300, "aud": "/admin/"}
    seg = (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    )
    sig = hmac.new(bytes.fromhex(secret_hex), seg.encode("ascii"), hashlib.sha256).digest()
    return seg + "." + _b64url(sig)


def admin_request(token, method, path, body=None):
    """打 Ghost Admin API。Accept-Version 必须贴近运行版本（6.x → v6.0）。"""
    url = SITE.rstrip("/") + path
    data = None
    headers = {
        "Authorization": "Ghost " + token,
        "Accept-Version": "v6.0",
        "User-Agent": "cdt-guard-publisher/1.0",
    }
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        return e.code, {"_raw": detail}
    except Exception as e:
        return 0, {"_raw": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------------------
# Markdown → HTML（够用就好的子集，只认 ## 和 ###）
# ---------------------------------------------------------------------------
def md_to_html(md):
    lines = md.split("\n")
    out = []
    in_code = False
    in_ul = False
    in_ol = False
    in_table = False

    def close_lists():
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    def close_table():
        nonlocal in_table
        if in_table:
            out.append("</tbody></table>")
            in_table = False

    for raw in lines:
        line = raw.rstrip()

        # 代码块
        if line.strip().startswith("```"):
            close_lists(); close_table()
            if in_code:
                out.append("</code></pre>")
                in_code = False
            else:
                lang = line.strip()[3:].strip()
                cls = f' class="language-{lang}"' if lang else ""
                out.append(f"<pre><code{cls}>")
                in_code = True
            continue
        if in_code:
            out.append(line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            continue

        # 空行
        if not line.strip():
            close_lists(); close_table()
            continue

        # 表格
        if line.strip().startswith("|") and line.strip().endswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            # 分隔行 |---|---|
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue
            if not in_table:
                close_lists()
                out.append("<table><tbody>")
                in_table = True
                out.append("<tr>" + "".join(f"<th>{inline(c)}</th>" for c in cells) + "</tr>")
            else:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>")
            continue
        else:
            close_table()

        # 标题：只认 ## 和 ###
        if line.startswith("### "):
            close_lists()
            out.append(f"<h3>{inline(line[4:])}</h3>")
            continue
        if line.startswith("## "):
            close_lists()
            out.append(f"<h2>{inline(line[3:])}</h2>")
            continue
        if line.startswith("# "):
            close_lists()
            out.append(f"<h2>{inline(line[2:])}</h2>")
            continue

        # 引用
        if line.startswith("> "):
            close_lists()
            out.append(f"<blockquote><p>{inline(line[2:])}</p></blockquote>")
            continue

        # 无序列表
        m = re.match(r"^[-*]\s+(.*)$", line)
        if m:
            if not in_ul:
                close_table()
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{inline(m.group(1))}</li>")
            continue

        # 有序列表
        m = re.match(r"^\d+\.\s+(.*)$", line)
        if m:
            if not in_ol:
                close_table()
                out.append("<ol>")
                in_ol = True
            out.append(f"<li>{inline(m.group(1))}</li>")
            continue

        # 普通段落
        close_lists()
        out.append(f"<p>{inline(line)}</p>")

    if in_code:
        out.append("</code></pre>")
    close_lists()
    close_table()
    return "\n".join(out)


def inline(text):
    """行内元素：粗体 / 行内代码 / 链接。"""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta-file", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.meta_file, "r", encoding="utf-8") as f:
        meta = json.load(f)

    title = meta.get("title")
    if not title:
        print("meta 缺少 title", file=sys.stderr)
        sys.exit(1)

    # 正文：优先 markdown_file，兼容 html_file
    if meta.get("markdown_file"):
        with open(meta["markdown_file"], "r", encoding="utf-8") as f:
            html = md_to_html(f.read())
    elif meta.get("html_file"):
        with open(meta["html_file"], "r", encoding="utf-8") as f:
            html = f.read()
    else:
        print("meta 缺少 markdown_file / html_file", file=sys.stderr)
        sys.exit(1)

    post = {"title": title, "html": html,
            "status": meta.get("status", "published")}
    if meta.get("slug"):
        post["slug"] = meta["slug"]
    if meta.get("tags"):
        post["tags"] = [{"name": t} for t in meta["tags"]]
    if meta.get("custom_excerpt"):
        post["custom_excerpt"] = meta["custom_excerpt"]
    if meta.get("feature_image"):
        post["feature_image"] = meta["feature_image"]

    print(f"标题: {title}")
    print(f"正文 HTML: {len(html)} 字节")
    print(f"目标: {SITE}")

    if args.dry_run:
        print("[演练模式] 未发任何请求。")
        return

    kid, secret = load_secrets()
    token = make_token(kid, secret)

    post_id = meta.get("post_id")

    # 没给 post_id 就按 slug 找一次（有防重复：按标题复核）
    if not post_id and meta.get("slug"):
        st, data = admin_request(
            token, "GET",
            f"/ghost/api/admin/posts/?filter=slug:{meta['slug']}&limit=1&formats=html"
        )
        if st == 200 and data.get("posts"):
            post_id = data["posts"][0]["id"]
            print(f"按 slug 命中已有文章: {post_id}")
        else:
            # 按标题复核，防止 slug 被守护脚本改过
            st2, d2 = admin_request(
                token, "GET",
                f"/ghost/api/admin/posts/?filter=title:'{title}'&limit=1&formats=html"
            )
            if st2 == 200 and d2.get("posts"):
                post_id = d2["posts"][0]["id"]
                print(f"按标题命中已有文章: {post_id}")

    if post_id:
        # 更新：必须带 updated_at（乐观锁）
        st, cur = admin_request(
            token, "GET", f"/ghost/api/admin/posts/{post_id}/?formats=html"
        )
        if st != 200 or not cur.get("posts"):
            print(f"取当前文章失败 HTTP {st}: {cur.get('_raw', '')[:300]}", file=sys.stderr)
            sys.exit(2)
        post["updated_at"] = cur["posts"][0]["updated_at"]
        st, resp = admin_request(
            token, "PUT",
            f"/ghost/api/admin/posts/{post_id}/?source=html",
            {"posts": [post]}
        )
        action = "更新"
    else:
        st, resp = admin_request(
            token, "POST", "/ghost/api/admin/posts/?source=html", {"posts": [post]}
        )
        action = "新建"

    if st not in (200, 201):
        print(f"{action}失败 HTTP {st}", file=sys.stderr)
        print(json.dumps(resp, ensure_ascii=False)[:800], file=sys.stderr)
        sys.exit(2)

    pid = resp["posts"][0]["id"]
    slug = resp["posts"][0].get("slug", "")
    print(f"{action}成功")
    print(f"  post_id: {pid}")
    print(f"  slug:    {slug}")
    print(f"  链接:    {SITE}/p/{slug}/")
    print("注意：正文验收要用 GET ...&formats=html 或直接抓公网页面，")
    print("      响应体里 html 为空是正常的（Ghost 默认不回 html 格式）。")


if __name__ == "__main__":
    main()
