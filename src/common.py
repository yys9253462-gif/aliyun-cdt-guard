# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 公共工具库
================================
把「配置加载 / 日志 / 通知 / 阿里云接口封装」这些三个脚本都要用的东西收到一起，
避免像参考项目那样每个文件复制一份，改一处要改三处。
"""
import os
import sys
import json
import time
import logging
from logging.handlers import TimedRotatingFileHandler

# ----------------------------------------------------------------------------
# 目录与常量
# ----------------------------------------------------------------------------
BASE_DIR = os.environ.get('CDT_GUARD_DIR', '/opt/cdt-guard')
CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
STATE_FILE = os.path.join(BASE_DIR, 'state.json')
LOCK_FILE = os.path.join(BASE_DIR, 'guard.lock')

# 通知冷却：同一事件 1 小时内不重复发送
NOTIFY_COOLDOWN = 3600
# 流量超标提醒：24 小时只发一次
OVERLIMIT_COOLDOWN = 86400
# 账单超支 / 余额过低：6 小时只发一次（避免每小时都骚扰）
MONEY_COOLDOWN = 21600
# 免费额度进度提醒：同一档位（80% / 95%）在 24 小时内只发一次
QUOTA_COOLDOWN = 86400

# 免费额度进度提醒的触发档位（百分比）
QUOTA_WARN_LEVELS = (80, 95)

# 余额过低默认阈值（账户货币单位，可在 config.json 里按实例覆盖）
DEFAULT_BALANCE_LIMIT = 10.0
# 本月账单超支默认阈值（0 表示不启用账单告警）
DEFAULT_BILL_LIMIT = 0.0

# 时区（阿里云接口返回的时间按此时区解析；默认东八区）
TIMEZONE_OFFSET_HOURS = 8


# ----------------------------------------------------------------------------
# 日志
# ----------------------------------------------------------------------------
def build_logger(name, log_file, stream=False):
    """返回一个按天切割、保留 7 天的日志器。控制台输出用于交互式排障。"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger

    fmt = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler = TimedRotatingFileHandler(
        log_file, when='D', interval=1, backupCount=7, encoding='utf-8'
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    if stream:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        logger.addHandler(console)
    return logger


# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------
def load_config(logger=None):
    """读取配置文件；不存在时给出人话提示并退出，而不是抛一堆堆栈。"""
    if not os.path.exists(CONFIG_FILE):
        msg = ('找不到配置文件 %s\n'
               '原因：监控尚未初始化。\n'
               '解决：重新运行 install.sh 完成初始化。' % CONFIG_FILE)
        if logger:
            logger.error(msg)
        else:
            print('[错误] ' + msg)
        sys.exit(1)
    with open(CONFIG_FILE, 'r', encoding='utf-8') as fp:
        return json.load(fp)


def save_config(config):
    """保存配置，并强制收紧权限（内含密钥信息）。"""
    tmp = CONFIG_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fp:
        json.dump(config, fp, ensure_ascii=False, indent=4)
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


# ----------------------------------------------------------------------------
# 状态缓存（通知冷却 / 失败计数）
# ----------------------------------------------------------------------------
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as fp:
                return json.load(fp)
        except Exception:
            pass
    return {}


def save_state(state, logger=None):
    try:
        with open(STATE_FILE, 'w', encoding='utf-8') as fp:
            json.dump(state, fp, ensure_ascii=False, indent=2)
    except Exception as error:
        if logger:
            logger.error('保存状态文件失败: %s', error)


def event_allowed(state, key, event, cooldown=NOTIFY_COOLDOWN):
    """判断某个事件是否已过冷却期，可以再次通知。"""
    last = state.get(key, {}).get(event, 0)
    return (time.time() - last) >= cooldown


def mark_event(state, key, event):
    state.setdefault(key, {})[event] = time.time()


def bump_counter(state, key, counter, step=1):
    info = state.setdefault(key, {})
    info[counter] = info.get(counter, 0) + step
    return info[counter]


def clear_counter(state, key, counter):
    state.setdefault(key, {}).pop(counter, None)


# ----------------------------------------------------------------------------
# 文本安全处理
# ----------------------------------------------------------------------------
def sanitize(text):
    """实例名 / 报错信息里的特殊字符会让 Telegram 解析整条消息失败，统一清洗。"""
    text = str(text)
    for ch in ('_', '*', '`', '[', ']'):
        text = text.replace(ch, ' ')
    return text.strip()


_SECRET_KEYS = (
    'accesskeyid', 'accesskeysecret', 'signature', 'signaturenonce',
    'securitytoken', 'ststoken', 'authorization', 'credential', 'bot_token',
)


def redact(text):
    """日志里不能出现密钥，做一次粗粒度遮蔽后再入库。"""
    text = str(text)
    lowered = text.lower()
    for key in _SECRET_KEYS:
        idx = lowered.find(key)
        if idx == -1:
            continue
        # 找到 key 之后的等号或冒号，把其后到分隔符之间的值抹掉
        head = text[:idx]
        tail = text[idx:]
        for sep in ('=', ':'):
            pos = tail.find(sep)
            if pos != -1:
                tail = tail[:pos + 1] + '[已隐藏]' + tail[pos + 1:].split('&')[0][0:0] \
                       + tail[pos + 1 + len(tail[pos + 1:].split('&')[0]):]
                break
        text = head + tail
        lowered = text.lower()
    return text


# ----------------------------------------------------------------------------
# 时区
# ----------------------------------------------------------------------------
def now_local():
    """返回东八区的当前时间（阿里云控制台按东八区展示）。

    用 timezone-aware 写法而不是 datetime.utcnow()——
    后者在 Python 3.12 起已标记弃用，会在日志里刷一堆警告。
    """
    import datetime
    utc_now = datetime.datetime.now(datetime.timezone.utc)
    return (utc_now + datetime.timedelta(hours=TIMEZONE_OFFSET_HOURS)).replace(tzinfo=None)


def current_billing_cycle():
    """返回当前账期，形如 2026-10。"""
    return now_local().strftime('%Y-%m')
