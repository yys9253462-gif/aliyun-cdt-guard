# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 菜单文案表
================================
把「菜单按钮文字」集中在这里，好处有两个：

1. 改文案只改一个文件，不用在十几个 if 分支里翻找。
2. 回复键盘的按钮**点一下等于替你发一条文字消息**，所以这些文字
   同时是「界面文案」和「通信协议」。两处必须一模一样，
   集中定义能彻底避免「界面改了、匹配没改」这种低级错误。

命名约定：
    LBL_xxx   回复键盘上的按钮文字（带 emoji）
    CMD_xxx   用户输入命令时也能用的纯文本别名（不带 emoji）
"""

# ---------------------------------------------------------------------------
# 一级菜单：主菜单（ReplyKeyboard，2 列 x 5 行）
# ---------------------------------------------------------------------------
LBL_OVERVIEW = '\U0001f4ca 总览'              # 📊
LBL_TRAFFIC = '\U0001f4c8 流量额度'            # 📈
LBL_STATUS = '\U0001f4e1 实例状态'             # 📡
LBL_REPORT = '\U0001f4cb 完整报表'             # 📋
LBL_WEEKLY = '\U0001f4c5 周报'                # 📅
LBL_BALANCE = '\U0001f4b0 余额详情'            # 💰
LBL_START_ALL = '\U0001f680 全部开机'          # 🚀
LBL_STOP_ALL = '\U0001f6d1 全部关机'           # 🛑
LBL_DEVICES = '\u2699\ufe0f 单机操作'          # ⚙️
LBL_RUN = '\U0001f504 立即巡检'               # 🔄
LBL_HELP = '\u2139\ufe0f 使用说明'             # ℹ️
LBL_HIDE = '\u274c 收起菜单'                  # ❌

# ---------------------------------------------------------------------------
# 二级菜单：实例列表
# ---------------------------------------------------------------------------
LBL_BACK_MAIN = '\U0001f3e0 返回主菜单'        # 🏠

# ---------------------------------------------------------------------------
# 三级菜单：单机操作
# ---------------------------------------------------------------------------
LBL_DEV_STATUS = '\U0001f4ca 状态'            # 📊
LBL_DEV_START = '\U0001f680 开机'             # 🚀
LBL_DEV_STOP = '\U0001f6d1 关机'              # 🛑
LBL_DEV_PAUSE = '\u23f8\ufe0f 暂停监控'       # ⏸️
LBL_DEV_RESUME = '\u25b6\ufe0f 恢复监控'      # ▶️
LBL_BACK_LIST = '\U0001f519 返回列表'          # 🔙

# ---------------------------------------------------------------------------
# 实例按钮前缀（用于从按钮文字反查是哪台机器）
# ---------------------------------------------------------------------------
DEVICE_PREFIX = '\U0001f5a5 '                # 🖥

# 实例按钮文字最多多少字（加上前缀后不宜过长，否则手机会折行）
DEVICE_NAME_MAX = 12


def build_device_button(name, paused=False):
    """生成实例列表里的一个按钮文字。

    paused 为真时前缀一个暂停标记，让你一眼看出哪台机器不在自动管理。
    """
    clean = (name or '').strip() or '未命名'
    if len(clean) > DEVICE_NAME_MAX:
        clean = clean[:DEVICE_NAME_MAX]
    mark = '\u23f8 ' if paused else ''
    return '%s%s%s' % (mark, DEVICE_PREFIX, clean)


def parse_device_button(text):
    """从按钮文字反查实例名。

    不是实例按钮则返回 None。用于「点击之后」「按钮消失了」的场景 ——
    用户可能直接手打或翻历史消息重发，这时靠文字也能对上。
    """
    if not text:
        return None
    raw = str(text).strip()
    # 去掉暂停标记
    if raw.startswith('\u23f8 '):
        raw = raw[2:].strip()
    if not raw.startswith(DEVICE_PREFIX):
        return None
    return raw[len(DEVICE_PREFIX):].strip()


def match_main(text, label):
    """判断一条输入是否等于某个主菜单按钮。

    同时接受「带 emoji 的按钮文字」和「去掉 emoji 的纯文字」，
    这样你既可以直接点按钮，也可以手打「总览」两个字。
    """
    if not text:
        return False
    raw = str(text).strip()
    if raw == label:
        return True
    # 纯文字别名：去掉 emoji 与空格后比较
    return _strip_icon(raw) == _strip_icon(label)


def _strip_icon(text):
    """去掉开头 emoji / 变体选择符 / 空格，只留文字部分。"""
    out = []
    started = False
    for ch in str(text):
        if not started and (not ch.isalnum() and ch not in '（）()'):
            continue
        started = True
        out.append(ch)
    return ''.join(out).strip()
