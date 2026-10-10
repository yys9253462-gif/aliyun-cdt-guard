# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - Telegram 交互式机器人（常驻进程）
======================================================
这是「手机端控制台」：让你在 Telegram 里点按钮就能查流量、看报表、
查余额、看周报、手动开关机、暂停监控，不用再 SSH 登进去敲命令。

菜单形态（这是本项目与旧版最大的区别）：
    用的是**回复键盘（ReplyKeyboard）**，也就是按钮长在输入框下面、
    左下角有「菜单」图标可以展开收起的那种（和截图一致）。
    旧版用的是内联键盘（按钮长在消息气泡里），现在两者并存：
    回复键盘承担日常操作，内联键盘只在少数需要「带隐藏数据」的场景用。

    回复键盘有个硬限制必须知道：**按钮点一下等于替你发一条文字消息**，
    它没法像内联按钮那样携带隐藏的数据。所以：
        · 一级菜单 -> 按文字匹配功能（「总览」「流量额度」…）
        · 二级菜单 -> 按钮文字里带上机器名（「[小图标] 香港节点」）
        · 三级菜单 -> 按钮文字不带机器名，改从会话状态里取「最近选中的机器」
    这也是为什么菜单文案必须和匹配逻辑严格一致 —— 见 menu_labels.py。

与 guard.py / report.py 的关系：
    那两个是 cron 定时任务，跑完就退出，是无状态的短进程。
    本文件是**常驻进程**，因为它必须一直「在听」你发的消息。
    两者分工明确、互不干扰：本文件只负责接收指令 + 执行 + 回复，
    绝不参与自动止损决策（那是 guard.py 的职责）。

为什么用长轮询（getUpdates）而不是 Webhook：
    Webhook 需要公网 HTTPS + 有效证书，且只支持 443/80/88/8443 端口。
    长轮询只需要机器能主动连出去，配置简单、无证书负担，适合本项目场景。
    代价是必须有一个进程一直活着 —— 所以用 systemd / OpenRC 拉起并自动重启。

硬性注意事项（踩过的坑）：
    1. 同一个 Bot 不能同时用长轮询和 Webhook，会互相踢下线。
    2. 同一个 Bot 不能同时跑两个长轮询进程，会报
       "Conflict: terminated by other getUpdates request"。所以本进程启动时
       加文件锁，第二个实例会直接退出。
    3. 点击内联按钮会产生 callback_query 事件，**必须**调
       answerCallbackQuery 回应，否则客户端按钮上会一直转圈。
       回复键盘的按钮不产生该事件（它走普通消息），所以不需要回应 ——
       但必须在 handle_plain_text 里翻译成动作，否则点了没反应。
    4. 只有白名单里的 Chat ID 才能操作，否则任何人知道 Bot 名字都能关你的机器。
"""
import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests

import common
import aliyun_api
import menu_labels as L

try:
    import fcntl
except ImportError:
    fcntl = None

LOG = common.build_logger('cdt_bot', os.path.join(common.BASE_DIR, 'bot.log'))

API_BASE = 'https://api.telegram.org/bot%s/%s'
POLL_TIMEOUT = 30           # 长轮询等待时间（秒），Telegram 侧最多挂 50 秒
HTTP_TIMEOUT = POLL_TIMEOUT + 15
LOCK_FILE = os.path.join(common.BASE_DIR, 'bot.lock')

# 「最近一次选中的机器名」的会话状态。
# 为什么需要它：三级菜单的按钮文字（状态 / 开机 / 关机）本身不带机器名，
# 而回复键盘又没法携带隐藏数据，所以只能记住「你刚点的是哪台机器」。
# 只存内存不落盘 —— 机器人重启后回到主菜单即可，不需要持久化。
_CURRENT_DEVICE = {}

# 运行标志：收到退出信号后置 False，让主循环优雅结束
_RUNNING = True


def _stop(_signum, _frame):
    global _RUNNING
    _RUNNING = False


# ============================================================================
# Telegram 接口调用
# ============================================================================
def _api(token, method, payload=None, timeout=HTTP_TIMEOUT):
    """调用 Telegram Bot 接口。返回解析后的 JSON；失败返回 None。"""
    url = API_BASE % (token, method)
    try:
        resp = requests.post(url, json=payload or {}, timeout=timeout)
        data = resp.json()
        if not data.get('ok'):
            LOG.warning('调用 %s 失败: %s', method, common.redact(resp.text))
            return None
        return data
    except requests.exceptions.ConnectTimeout:
        # 长轮询无消息时会正常超时，不算错误，静默返回
        return None
    except requests.exceptions.ProxyError as error:
        LOG.error('无法连接 Telegram（代理不可用）: %s', common.redact(error))
        return None
    except Exception as error:
        LOG.error('调用 %s 异常: %s', method, common.redact(error))
        return None


def send_text(token, chat_id, text, keyboard=None):
    """发送消息。keyboard 为内联键盘按钮定义（长在消息气泡里的那种）。"""
    payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'Markdown'}
    if keyboard:
        payload['reply_markup'] = {'inline_keyboard': keyboard}
    result = _api(token, 'sendMessage', payload)
    if result is None:
        # Markdown 解析失败（实例名里带特殊字符）时降级为纯文本重发
        payload.pop('parse_mode', None)
        result = _api(token, 'sendMessage', payload)
    return result is not None


def send_menu(token, chat_id, text, rows, placeholder='点下面的按钮操作'):
    """发送带**回复键盘**的消息 —— 也就是截图里那种底部菜单。

    和 send_text 的区别（这是理解本项目菜单的关键）：
        send_text 用的内联键盘，按钮长在消息气泡里，消息删了按钮就没了。
        本函数用的回复键盘，按钮长在**输入框下面**，是持久存在的，
        而且 Telegram 会自动在左下角显示一个「菜单」图标用于展开 / 收起。

    两种键盘可以同时出现在一条消息里：这里把回复键盘放在 reply_markup 里，
    不冲突。注意 reply_markup 一次只能承载一种键盘，所以这里只能给回复键盘。

    参数 rows 形如 [['按钮A','按钮B'], ['按钮C']] —— 每一行是一个列表，
    一行最多 3 个，超过会被 Telegram 截断（所以调用方要自己控制列数）。
    """
    keyboard = []
    for row in rows:
        keyboard.append([{'text': item} for item in row])
    payload = {
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'Markdown',
        'reply_markup': {
            'keyboard': keyboard,
            'resize_keyboard': True,      # 按内容自适应高度，不占半屏
            'is_persistent': True,        # 一直显示，不用每次点图标展开
        },
    }
    result = _api(token, 'sendMessage', payload)
    if result is None:
        # Markdown 解析失败（机器名带下划线等）时降级纯文本重发
        payload.pop('parse_mode', None)
        result = _api(token, 'sendMessage', payload)
    return result is not None


def hide_menu(token, chat_id, text='菜单已收起。发送 /menu 可以再打开。'):
    """收起底部菜单（保留左下角那个图标，点一下还能展开）。"""
    payload = {
        'chat_id': chat_id,
        'text': text,
        'reply_markup': {'remove_keyboard': True},
    }
    return _api(token, 'sendMessage', payload) is not None


def answer_callback(token, callback_id, text=''):
    """回应按钮点击。不调这个，客户端按钮会一直转圈。"""
    _api(token, 'answerCallbackQuery',
         {'callback_query_id': callback_id, 'text': text[:200]}, timeout=15)


def register_commands(token):
    """注册 Bot 命令菜单 —— 让你在聊天框输入 / 时能看到命令列表。

    这是纯注册动作，只需调一次，不需要接收消息。
    """
    commands = [
        {'command': 'start', 'description': '打开菜单'},
        {'command': 'menu', 'description': '显示操作菜单'},
        {'command': 'status', 'description': '查看所有机器实时状态'},
        {'command': 'traffic', 'description': '查看流量与免费额度'},
        {'command': 'balance', 'description': '查看账户余额与本月账单'},
        {'command': 'weekly', 'description': '查看本周流量周报'},
        {'command': 'report', 'description': '立即发送完整报表'},
        {'command': 'run', 'description': '立即执行一次巡检'},
        {'command': 'help', 'description': '查看使用说明'},
    ]
    result = _api(token, 'setMyCommands', {'commands': commands}, timeout=15)
    if result:
        LOG.info('Bot 命令菜单注册成功')
    return result is not None


# ============================================================================
# 业务查询（复用现有模块，不重复造轮子）
# ============================================================================
def _find_user(config, instance_id):
    for user in config.get('users', []):
        if user.get('instance_id') == instance_id:
            return user
    return None


def build_status(config):
    """所有机器的实时状态文本。"""
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    lines = ['*机器实时状态*', '']
    for user in users:
        name = common.sanitize(user.get('name') or user.get('instance_id'))
        if user.get('paused'):
            lines.append('* %s\n  监控: 已暂停' % name)
            continue
        try:
            status = aliyun_api.get_instance_status(
                user['ak'], user['sk'], user['region'], user['instance_id'],
                (user.get('resgroup') or '').strip())
            status_cn = {'Running': '运行中', 'Stopped': '已停止'}.get(status, status or '未知')
        except Exception as error:
            status_cn = '查询失败（%s）' % common.sanitize(error)
        lines.append('* %s\n  状态: %s' % (name, status_cn))
    lines.append('')
    lines.append('时间: %s' % common.now_local().strftime('%Y-%m-%d %H:%M'))
    return '\n'.join(lines)


def build_traffic(config):
    """流量与免费额度文本。"""
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    lines = ['*流量与免费额度*', '']
    for user in users:
        name = common.sanitize(user.get('name') or user.get('instance_id'))
        region = user.get('region', '')
        limit = float(user.get('traffic_limit', 180))
        if user.get('paused'):
            lines.append('* %s\n  监控: 已暂停' % name)
            continue
        try:
            traffic = aliyun_api.get_cdt_traffic_gb(user['ak'], user['sk'], region)
        except Exception as error:
            lines.append('* %s\n  查询失败: %s' % (name, common.sanitize(error)))
            continue

        free_gb = aliyun_api.get_free_quota_gb(region)
        area = '非中国内地' if aliyun_api.is_overseas_region(region) else '中国内地'
        remain = free_gb - traffic
        lines.append('* %s' % name)
        lines.append('  已用: %.2f GB / 阈值 %.0f GB' % (traffic, limit))
        lines.append('  免费额度: %.0f GB（%s）' % (free_gb, area))
        if remain >= 0:
            lines.append('  额度剩余: %.2f GB' % remain)
        else:
            lines.append('  已超出免费额度 %.2f GB，正在产生费用' % -remain)
        lines.append('')
    return '\n'.join(lines)


def build_balance(config):
    """余额详情 —— 逐账号显示余额、本月账单、免费额度消耗。

    为什么单独做一页而不是塞进总览：
        余额和账单是「钱」的问题，跟流量是两回事（流量是「用量」）。
        而且余额是按 **AK / 账号** 维度查的，同一个 AK 下的多台机器只需查一次。
        本函数按 AK 去重，避免多台机器重复请求财务接口（那接口有频控）。
    """
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    lines = ['*余额与账单详情*', '']
    seen = {}
    for user in users:
        name = common.sanitize(user.get('name') or user.get('instance_id'))
        ak = (user.get('ak') or '').strip()
        region = user.get('region', '')

        # 同一 AK 只查一次余额，多台机器复用结果
        if ak not in seen:
            try:
                seen[ak] = aliyun_api.get_account_balance(
                    ak, user.get('sk', ''), region, user.get('bill_endpoint', ''))
            except Exception as error:
                LOG.warning('查询余额失败: %s', common.redact(error))
                seen[ak] = (None, None)
        amount, currency = seen[ak]

        symbol = {'CNY': '\u00a5', 'USD': '$'}.get(currency, user.get('currency', '$'))
        if amount is None:
            balance_line = '查询失败'
        elif amount < 0:
            balance_line = '%s%.2f [已欠费，请立即充值]' % (symbol, amount)
        else:
            balance_line = '%s%.2f' % (symbol, amount)

        lines.append('* %s' % name)

        # 余额警戒线：告诉你离告警还有多远
        limit = float(user.get('balance_limit', common.DEFAULT_BALANCE_LIMIT))
        if limit > 0 and amount is not None:
            if amount < limit:
                lines.append('  账户余额: %s（警戒线 %s%.2f，已低于警戒线）'
                             % (balance_line, symbol, limit))
            else:
                lines.append('  账户余额: %s（警戒线 %s%.2f）'
                             % (balance_line, symbol, limit))
        else:
            lines.append('  账户余额: %s' % balance_line)

        # 本月账单
        try:
            bill_amount, bill_currency = aliyun_api.get_instance_bill(
                ak, user.get('sk', ''), region,
                user.get('instance_id', ''), user.get('bill_endpoint', ''))
        except Exception:
            bill_amount, bill_currency = None, None
        bill_symbol = {'CNY': '\u00a5', 'USD': '$'}.get(
            bill_currency, user.get('currency', '$'))
        if bill_amount is None or bill_amount < 0:
            lines.append('  本月账单: 查询失败')
        else:
            bill_limit = float(user.get('bill_limit', common.DEFAULT_BILL_LIMIT))
            suffix = ''
            if bill_limit > 0 and bill_amount > bill_limit:
                suffix = '（已超警戒线 %s%.2f）' % (bill_symbol, bill_limit)
            lines.append('  本月账单: %s%.2f%s' % (bill_symbol, bill_amount, suffix))

        # 免费额度消耗情况
        try:
            traffic_gb = aliyun_api.get_cdt_traffic_gb(ak, user.get('sk', ''), region)
        except Exception:
            traffic_gb = -1
        free_gb = aliyun_api.get_free_quota_gb(region)
        area = '非中国内地' if aliyun_api.is_overseas_region(region) else '中国内地'
        if traffic_gb >= 0:
            remain = free_gb - traffic_gb
            percent = traffic_gb / free_gb * 100 if free_gb > 0 else 0
            if remain >= 0:
                lines.append('  免费额度: 已用 %.1f%%（%.2f / %.0f GB，%s）'
                             % (percent, traffic_gb, free_gb, area))
            else:
                lines.append('  免费额度: 已用尽，超出 %.2f GB 正在计费' % -remain)
        lines.append('')

    lines.append('时间: %s' % common.now_local().strftime('%Y-%m-%d %H:%M'))
    return '\n'.join(lines)


def _read_weekly_history():
    """读取流量历史台账（由 guard.py 每轮巡检追加）。读不到返回空列表。"""
    path = os.path.join(common.BASE_DIR, 'traffic_history.json')
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r', encoding='utf-8') as fp:
            data = json.load(fp)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def build_weekly(config):
    """流量周报 —— 最近 7 天的用量变化。

    数据来源是 guard.py 每轮巡检写的流量台账（traffic_history.json）。
    台账刚上线时是空的，所以这里会明确告诉你「还没攒够数据」，
    而不是拿零去糊弄你 —— 那会让人误以为「一周一点流量都没用」。
    """
    history = _read_weekly_history()
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    lines = ['*流量周报（最近 7 天）*',
             '统计区间: %s ~ %s' % (
                 (common.now_local() - __import__('datetime').timedelta(days=7)
                  ).strftime('%m-%d'),
                 common.now_local().strftime('%m-%d')),
             '']

    if not history:
        lines.append('台账里还没有数据。')
        lines.append('')
        lines.append('说明: 周报依赖巡检每 5 分钟记录一次流量快照，')
        lines.append('运行满 1 天后就会有完整曲线。请稍后再看。')
        return '\n'.join(lines)

    # 按实例分组，取每台机器最近 7 天的记录
    import datetime
    cutoff = (common.now_local() - datetime.timedelta(days=7)).strftime('%Y-%m-%d')

    for user in users:
        iid = user.get('instance_id', '')
        name = common.sanitize(user.get('name') or iid)
        points = [p for p in history
                  if p.get('instance_id') == iid and str(p.get('date', '')) >= cutoff]
        points.sort(key=lambda p: (str(p.get('date', '')), str(p.get('time', ''))))

        lines.append('* %s' % name)
        if len(points) < 2:
            lines.append('  数据点不足，暂无法计算增量。')
            lines.append('')
            continue

        first, last = points[0], points[-1]
        used = float(last.get('traffic_gb', 0)) - float(first.get('traffic_gb', 0))
        if used < 0:
            # 账期重置会让流量归零，此时增量为负 —— 直接说明，不要显示负数糊弄人
            lines.append('  本区间内账期重置过，累计用量无法直接相减。')
            lines.append('  当前已用: %.2f GB' % float(last.get('traffic_gb', 0)))
        else:
            lines.append('  区间新增: %.2f GB' % used)
            lines.append('  当前已用: %.2f GB' % float(last.get('traffic_gb', 0)))
            free_gb = aliyun_api.get_free_quota_gb(user.get('region', ''))
            if free_gb > 0:
                lines.append('  免费额度占用: %.1f%%'
                             % (float(last.get('traffic_gb', 0)) / free_gb * 100))

        # 每天的平均用量，让你判断趋势
        days = max(len({p.get('date') for p in points}), 1)
        if used >= 0:
            lines.append('  日均约: %.2f GB/天（覆盖 %d 天）' % (used / days, days))
        lines.append('')

    lines.append('提示: 周报数据来自本地台账，不含阿里云控制台的手工调整。')
    return '\n'.join(lines)


def toggle_pause(config, instance_id):
    """暂停 / 恢复某台机器的监控。返回结果说明文本。"""
    user = _find_user(config, instance_id)
    if user is None:
        return '没找到这台机器。'
    user['paused'] = not bool(user.get('paused'))
    common.save_config(config)
    name = common.sanitize(user.get('name') or instance_id)
    state = '已暂停' if user['paused'] else '监控中'
    LOG.info('通过机器人切换监控状态: %s -> %s', instance_id, state)
    return '机器 %s 现在是：%s' % (name, state)


def do_start(config, instance_id):
    """手动开机。"""
    user = _find_user(config, instance_id)
    if user is None:
        return '没找到这台机器。'
    name = common.sanitize(user.get('name') or instance_id)
    try:
        aliyun_api.start_instance(user['ak'], user['sk'], user['region'], instance_id)
    except Exception as error:
        LOG.error('机器人手动开机失败: %s', common.redact(error))
        return '开机指令下发失败：%s' % common.sanitize(error)
    LOG.info('通过机器人手动开机: %s', instance_id)
    return '已向 %s 下发开机指令。\n注意：如果是抢占式实例且库存不足，可能开不起来。' % name


def do_stop(config, instance_id):
    """手动关机（不影响自动止损逻辑）。"""
    user = _find_user(config, instance_id)
    if user is None:
        return '没找到这台机器。'
    name = common.sanitize(user.get('name') or instance_id)
    try:
        aliyun_api.stop_instance(user['ak'], user['sk'], user['region'], instance_id)
    except Exception as error:
        LOG.error('机器人手动关机失败: %s', common.redact(error))
        return '关机指令下发失败：%s' % common.sanitize(error)
    LOG.info('通过机器人手动关机: %s', instance_id)
    return '已向 %s 下发关机指令。' % name


def _find_user_by_name(config, name):
    """按备注名查机器（按钮文字里存的是名字，不是实例 ID）。"""
    target = (name or '').strip()
    if not target:
        return None
    for user in config.get('users', []):
        if (user.get('name') or '').strip() == target:
            return user
    # 名字被截断过时（按钮上只显示前 12 字），退化为前缀匹配
    for user in config.get('users', []):
        full = (user.get('name') or '').strip()
        if full.startswith(target) or target.startswith(full):
            return user
    return None


def do_batch_power(config, action):
    """批量开机 / 关机。返回结果说明文本。

    action 取 'start' 或 'stop'。
    跳过已暂停的机器 —— 你按过「暂停」就说明不想让脚本碰它，
    批量操作也必须尊重这个意愿，否则暂停就形同虚设。
    """
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    verb = '开机' if action == 'start' else '关机'
    ok_list, skip_list, fail_list = [], [], []
    for user in users:
        name = common.sanitize(user.get('name') or user.get('instance_id'))
        if user.get('paused'):
            skip_list.append(name)
            continue
        try:
            if action == 'start':
                aliyun_api.start_instance(user['ak'], user['sk'],
                                          user['region'], user['instance_id'])
            else:
                aliyun_api.stop_instance(user['ak'], user['sk'],
                                         user['region'], user['instance_id'])
            ok_list.append(name)
        except Exception as error:
            LOG.error('批量%s失败 [%s]: %s', verb, name, common.redact(error))
            fail_list.append('%s（%s）' % (name, common.sanitize(error)))

    lines = ['*批量%s完成*' % verb, '']
    if ok_list:
        lines.append('已下发指令:')
        for name in ok_list:
            lines.append('  · %s' % name)
    if skip_list:
        lines.append('已跳过（监控处于暂停）:')
        for name in skip_list:
            lines.append('  · %s' % name)
    if fail_list:
        lines.append('失败:')
        for name in fail_list:
            lines.append('  · %s' % name)
    lines.append('')
    lines.append('时间: %s' % common.now_local().strftime('%H:%M:%S'))
    return '\n'.join(lines)


# ============================================================================
# 菜单构建
# ============================================================================
def main_menu_rows():
    """主菜单：回复键盘的行定义（每行一个文字列表）。

    布局刻意做成两列 —— 截图里那种整齐的方格观感，
    而且两列宽度比三列更宽松，中文按钮不会挤在一起换行。
    """
    return [
        [L.LBL_OVERVIEW, L.LBL_TRAFFIC],
        [L.LBL_STATUS, L.LBL_REPORT],
        [L.LBL_WEEKLY, L.LBL_BALANCE],
        [L.LBL_START_ALL, L.LBL_STOP_ALL],
        [L.LBL_DEVICES, L.LBL_RUN],
        [L.LBL_HELP, L.LBL_HIDE],
    ]


def device_menu_rows(config):
    """二级菜单：实例列表。每台机器一行，加一个「返回主菜单」。"""
    rows = []
    for user in config.get('users', [])[:20]:
        name = (user.get('name') or user.get('instance_id') or '').strip()
        rows.append([L.build_device_button(name, bool(user.get('paused')))])
    rows.append([L.LBL_BACK_MAIN])
    return rows


def device_action_rows(user):
    """三级菜单：单机操作。暂停状态不同，按钮文字不同。"""
    paused = bool(user.get('paused'))
    return [
        [L.LBL_DEV_STATUS, L.LBL_DEV_START],
        [L.LBL_DEV_STOP, L.LBL_DEV_RESUME if paused else L.LBL_DEV_PAUSE],
        [L.LBL_BACK_LIST, L.LBL_BACK_MAIN],
    ]


def main_menu_keyboard(config):
    """兼容旧版的内联按钮菜单（保留，供 /menu 命令以消息形式发送）。"""
    rows = []
    for user in config.get('users', [])[:8]:
        iid = user.get('instance_id', '')
        name = common.sanitize(user.get('name') or iid)
        label = name if len(name) <= 12 else name[:12]
        paused = user.get('paused')
        rows.append([
            {'text': ('[已暂停] ' if paused else '') + label + ' 状态',
             'callback_data': 'st:%s' % iid},
            {'text': '开机', 'callback_data': 'up:%s' % iid},
            {'text': '关机', 'callback_data': 'dn:%s' % iid},
            {'text': '暂停' if not paused else '恢复', 'callback_data': 'pz:%s' % iid},
        ])
    rows.append([
        {'text': '流量与额度', 'callback_data': 'traffic'},
        {'text': '发送报表', 'callback_data': 'report'},
    ])
    rows.append([
        {'text': '立即巡检', 'callback_data': 'run'},
        {'text': '使用说明', 'callback_data': 'help'},
    ])
    return rows


HELP_TEXT = """*CDT 流量守护 · 使用说明*

这个机器人让你在手机上就能管理流量守护。

*菜单怎么用*
发送 /menu 打开底部菜单。菜单分三层：
· 第一层是功能总入口
· 点「单机操作」进第二层，列出所有机器
· 点某台机器进第三层，对它做状态查询 / 开机 / 关机 / 暂停

按钮就是快捷输入 —— 点一下等于替你发一句话，机器人再按这句话执行。

*命令*
/menu    显示操作菜单
/status  查看所有机器实时状态
/traffic 查看流量与免费额度
/balance 查看账户余额与本月账单
/weekly  查看最近 7 天流量周报
/report  立即发送完整报表
/run     立即执行一次巡检
/help    显示本条说明

*注意*
· 界面文字不带任何英文，全部中文。
· 「暂停」只是让脚本不再自动开关机，手动按钮仍然可用。
· 自动止损（流量超标强制关机）由后台定时任务执行，不受这里影响。
· 只有你（配置里的 Chat ID）能操作，别人发消息不会有任何反应。
· 想收起底部菜单，点「收起菜单」。"""


# ============================================================================
# 消息处理
# ============================================================================
def _authorized(config, chat_id):
    """校验来源是否是你本人。这是安全底线，绝不能省。"""
    allowed = str((config.get('telegram') or {}).get('chat_id', '')).strip()
    return allowed and str(chat_id).strip() == allowed


def send_main_menu(token, chat_id, config):
    """发送一级菜单（主菜单）。"""
    send_menu(token, chat_id,
              '*CDT 流量守护 · 控制台*\n\n请从下面的菜单选择操作：',
              main_menu_rows())


def send_device_list(token, chat_id, config):
    """发送二级菜单（实例列表）。"""
    users = config.get('users', [])
    if not users:
        send_menu(token, chat_id, '当前没有配置任何机器。', [[L.LBL_BACK_MAIN]])
        return
    send_menu(token, chat_id,
              '*选择要操作的机器*\n\n点一台机器进入操作菜单：',
              device_menu_rows(config))


def send_device_actions(token, chat_id, user):
    """发送三级菜单（单机操作）。"""
    name = common.sanitize(user.get('name') or user.get('instance_id'))
    state = '已暂停监控' if user.get('paused') else '监控中'
    send_menu(token, chat_id,
              '*%s*\n当前: %s\n\n选择操作：' % (name, state),
              device_action_rows(user))


def handle_command(config, token, chat_id, text):
    """处理 / 命令。"""
    cmd = text.strip().split()[0].lower().lstrip('/')
    # 去掉 @BotName 后缀（群聊里发命令会带）
    cmd = cmd.split('@')[0]

    if cmd in ('start', 'menu'):
        send_main_menu(token, chat_id, config)
    elif cmd == 'status':
        send_text(token, chat_id, build_status(config))
    elif cmd == 'traffic':
        send_text(token, chat_id, build_traffic(config))
    elif cmd == 'balance':
        send_text(token, chat_id, '正在查询余额与账单，可能需要十几秒...')
        send_text(token, chat_id, build_balance(config))
    elif cmd == 'weekly':
        send_text(token, chat_id, build_weekly(config))
    elif cmd == 'report':
        _send_report(config, token, chat_id)
    elif cmd == 'run':
        _run_inspection(config, token, chat_id)
    elif cmd == 'help':
        send_text(token, chat_id, HELP_TEXT)
    else:
        send_text(token, chat_id, '没听懂这个命令。发送 /help 查看用法，'
                                  '或发送 /menu 打开菜单。')


def _send_report(config, token, chat_id):
    """生成并发送完整报表。任何异常都要回话，不能沉默。"""
    import report as report_module
    try:
        content = report_module.build_report(config)
    except Exception as error:
        LOG.error('生成报表失败: %s', common.redact(error))
        send_text(token, chat_id,
                  '报表生成失败：%s\n'
                  '通常是因为某台机器的接口查不通，具体见 bot.log。'
                  % common.sanitize(error))
        return
    send_text(token, chat_id, content)


def _run_inspection(config, token, chat_id):
    """手动执行一次巡检。必须和定时任务抢同一把锁，否则状态会互相覆盖。"""
    import guard as guard_module
    lock = guard_module.acquire_lock()
    if lock is None:
        send_text(token, chat_id,
                  '定时巡检正在运行中，为避免状态冲突，本次手动巡检已取消。\n'
                  '请等 1 分钟后再试。')
        return
    try:
        state = common.load_state()
        results = []
        for user in config.get('users', []):
            before = json.dumps(state.get(user.get('instance_id', ''), {}), sort_keys=True)
            guard_module.check_with_timeout(user, config, state)
            common.save_state(state, LOG)
            after = json.dumps(state.get(user.get('instance_id', ''), {}), sort_keys=True)
            name = common.sanitize(user.get('name') or user.get('instance_id'))
            results.append('* %s: %s' % (name, '有动作' if before != after else '无变化'))
    finally:
        if hasattr(lock, 'close'):
            lock.close()
    send_text(token, chat_id, '*巡检完成*\n\n' + '\n'.join(results)
              + '\n\n详细日志见机器上的 guard.log')


def handle_plain_text(config, token, chat_id, text):
    """处理非命令的输入 —— 也就是回复键盘按钮点出来的那些文字。

    这是新版菜单的核心：回复键盘的按钮点一下就等于替你发一条消息，
    所以这里要做「文字 → 动作」的翻译。找不到对应动作时给出菜单，
    而不是装作没看见。
    """
    raw = text.strip()

    # ---- 收起菜单 ----
    if L.match_main(raw, L.LBL_HIDE):
        hide_menu(token, chat_id)
        return

    # ---- 一级菜单 ----
    if L.match_main(raw, L.LBL_OVERVIEW):
        send_text(token, chat_id, build_status(config))
        send_text(token, chat_id, build_traffic(config))
        return
    if L.match_main(raw, L.LBL_TRAFFIC):
        send_text(token, chat_id, build_traffic(config))
        return
    if L.match_main(raw, L.LBL_STATUS):
        send_text(token, chat_id, build_status(config))
        return
    if L.match_main(raw, L.LBL_REPORT):
        _send_report(config, token, chat_id)
        return
    if L.match_main(raw, L.LBL_WEEKLY):
        send_text(token, chat_id, build_weekly(config))
        return
    if L.match_main(raw, L.LBL_BALANCE):
        send_text(token, chat_id, '正在查询余额与账单，可能需要十几秒...')
        send_text(token, chat_id, build_balance(config))
        return
    if L.match_main(raw, L.LBL_START_ALL):
        send_text(token, chat_id, do_batch_power(config, 'start'))
        return
    if L.match_main(raw, L.LBL_STOP_ALL):
        send_text(token, chat_id, do_batch_power(config, 'stop'))
        return
    if L.match_main(raw, L.LBL_DEVICES):
        send_device_list(token, chat_id, config)
        return
    if L.match_main(raw, L.LBL_RUN):
        send_text(token, chat_id,
                  '正在执行巡检，如果某台机器需要开机等待，'
                  '最长约 3 分钟。这期间其他消息会排队，请稍候...')
        _run_inspection(config, token, chat_id)
        return
    if L.match_main(raw, L.LBL_HELP):
        send_text(token, chat_id, HELP_TEXT)
        return

    # ---- 二级菜单 ----
    if L.match_main(raw, L.LBL_BACK_MAIN):
        send_main_menu(token, chat_id, config)
        return
    device_name = L.parse_device_button(raw)
    if device_name:
        user = _find_user_by_name(config, device_name)
        if user is None:
            send_text(token, chat_id, '没找到这台机器，可能在配置里被删掉了。')
            send_device_list(token, chat_id, config)
            return
        # 记住选中的机器，三级菜单的按钮要靠它才知道作用于哪台
        _CURRENT_DEVICE[chat_id] = (user.get('name') or user.get('instance_id') or '')
        send_device_actions(token, chat_id, user)
        return

    # ---- 三级菜单 ----
    # 三级菜单的按钮要作用在「某台机器」上，而按钮文字本身不带机器名，
    # 所以这里从会话状态里取「最近一次选中的机器」。
    current = _find_user_by_name(config, _CURRENT_DEVICE.get(chat_id, ''))
    if current is not None:
        if L.match_main(raw, L.LBL_BACK_LIST):
            send_device_list(token, chat_id, config)
            return
        if L.match_main(raw, L.LBL_DEV_STATUS):
            name = common.sanitize(current.get('name') or current.get('instance_id'))
            try:
                status = aliyun_api.get_instance_status(
                    current['ak'], current['sk'], current['region'],
                    current['instance_id'], (current.get('resgroup') or '').strip())
                status_cn = {'Running': '运行中', 'Stopped': '已停止'}.get(
                    status, status or '未知')
            except Exception as error:
                status_cn = '查询失败（%s）' % common.sanitize(error)
            send_text(token, chat_id, '*%s*\n状态: %s\n时间: %s'
                      % (name, status_cn, common.now_local().strftime('%H:%M:%S')))
            return
        if L.match_main(raw, L.LBL_DEV_START):
            send_text(token, chat_id, do_start(config, current['instance_id']))
            return
        if L.match_main(raw, L.LBL_DEV_STOP):
            send_text(token, chat_id, do_stop(config, current['instance_id']))
            return
        if L.match_main(raw, L.LBL_DEV_PAUSE) or L.match_main(raw, L.LBL_DEV_RESUME):
            message = toggle_pause(config, current['instance_id'])
            send_text(token, chat_id, message)
            # 暂停状态变了，重绘三级菜单让按钮文字跟上
            refreshed = _find_user(config, current['instance_id'])
            if refreshed is not None:
                send_device_actions(token, chat_id, refreshed)
            return

    # ---- 什么都没匹配上 ----
    send_menu(token, chat_id,
              '没听懂「%s」。\n发送 /menu 打开菜单，或 /help 查看用法。'
              % common.sanitize(raw)[:40],
              main_menu_rows())


def handle_callback(config, token, callback):
    """处理按钮点击。

    这个函数是**常驻进程的关键路径**，内部任何异常都不能往外抛 ——
    一旦抛出去，整个机器人进程就挂了，之后你发什么它都不理。
    所以把主体逻辑拆到 _dispatch_callback 里，这里统一兜底：
    先回应按钮（否则一直转圈），再把失败原因回给你，最后记日志。
    """
    callback_id = callback.get('id', '')
    chat_id = (callback.get('message') or {}).get('chat', {}).get('id')

    try:
        _dispatch_callback(config, token, callback)
    except Exception as error:
        LOG.error('处理按钮点击出错: %s', common.redact(error))
        try:
            answer_callback(token, callback_id, '处理失败')
        except Exception:
            pass
        if chat_id:
            try:
                send_text(token, chat_id,
                          '这个操作执行失败：%s\n'
                          '机器人没有崩溃，其他功能仍可正常使用。\n'
                          '详细原因见机器上的 bot.log。'
                          % common.sanitize(error))
            except Exception:
                pass


def _dispatch_callback(config, token, callback):
    """按钮点击的实际分发逻辑。"""
    callback_id = callback.get('id', '')
    chat_id = (callback.get('message') or {}).get('chat', {}).get('id')
    data = callback.get('data', '')

    if not _authorized(config, chat_id):
        answer_callback(token, callback_id, '无权操作')
        LOG.warning('收到未授权按钮点击，chat_id=%s', chat_id)
        return

    if ':' in data:
        action, instance_id = data.split(':', 1)
    else:
        action, instance_id = data, ''

    # 先回应按钮，让转圈立刻停下，再干活
    if action == 'st':
        answer_callback(token, callback_id, '查询中...')
        user = _find_user(config, instance_id)
        if user is None:
            send_text(token, chat_id, '没找到这台机器。')
            return
        name = common.sanitize(user.get('name') or instance_id)
        try:
            status = aliyun_api.get_instance_status(
                user['ak'], user['sk'], user['region'], instance_id,
                (user.get('resgroup') or '').strip())
            status_cn = {'Running': '运行中', 'Stopped': '已停止'}.get(status, status or '未知')
        except Exception as error:
            status_cn = '查询失败（%s）' % common.sanitize(error)
        send_text(token, chat_id, '*%s*\n状态: %s\n时间: %s'
                  % (name, status_cn, common.now_local().strftime('%H:%M:%S')))

    elif action == 'up':
        answer_callback(token, callback_id, '正在下发开机指令...')
        send_text(token, chat_id, do_start(config, instance_id))

    elif action == 'dn':
        answer_callback(token, callback_id, '正在下发关机指令...')
        send_text(token, chat_id, do_stop(config, instance_id))

    elif action == 'pz':
        answer_callback(token, callback_id, '正在切换...')
        send_text(token, chat_id, toggle_pause(config, instance_id))
        # 状态变了，刷新菜单让按钮文字跟上
        send_text(token, chat_id, '菜单已刷新：', main_menu_keyboard(config))

    elif action == 'traffic':
        answer_callback(token, callback_id, '查询中...')
        send_text(token, chat_id, build_traffic(config))

    elif action == 'balance':
        answer_callback(token, callback_id, '正在查询余额与账单...')
        send_text(token, chat_id, build_balance(config))

    elif action == 'weekly':
        answer_callback(token, callback_id, '正在汇总周报...')
        send_text(token, chat_id, build_weekly(config))

    elif action == 'menu':
        answer_callback(token, callback_id)
        send_main_menu(token, chat_id, config)

    elif action == 'report':
        answer_callback(token, callback_id, '正在生成报表，可能需要十几秒...')
        _send_report(config, token, chat_id)

    elif action == 'run':
        answer_callback(token, callback_id, '巡检执行中，请稍候...')
        handle_command(config, token, chat_id, '/run')

    elif action == 'help':
        answer_callback(token, callback_id)
        send_text(token, chat_id, HELP_TEXT)

    else:
        answer_callback(token, callback_id, '这个按钮暂时没实现')


def handle_update(config, token, update):
    """分发一条更新。"""
    message = update.get('message')
    if message:
        chat_id = (message.get('chat') or {}).get('id')
        text = message.get('text') or ''
        if not _authorized(config, chat_id):
            LOG.warning('忽略未授权消息，chat_id=%s', chat_id)
            return
        if text.startswith('/'):
            handle_command(config, token, chat_id, text)
        else:
            # 非命令的普通文字：可能是回复键盘按钮点出来的，走菜单翻译
            handle_plain_text(config, token, chat_id, text)
        return

    callback = update.get('callback_query')
    if callback:
        handle_callback(config, token, callback)


# ============================================================================
# 主循环
# ============================================================================
def acquire_lock():
    """防止同时跑两个轮询进程（会互相冲突导致消息丢失）。"""
    if fcntl is None:
        return True
    try:
        handle = open(LOCK_FILE, 'w')
    except OSError:
        return True
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        handle.close()
        return None
    return handle


def main():
    config = common.load_config(LOG)
    token = ((config.get('telegram') or {}).get('bot_token') or '').strip()
    if not token:
        LOG.error('没有配置 Telegram Bot Token，机器人无法启动。'
                  '请重新运行 install.sh 配置通知渠道。')
        sys.exit(1)

    lock = acquire_lock()
    if lock is None:
        LOG.error('已有一个机器人在运行。同一个 Bot 不能开两个轮询进程，'
                  '本进程退出。如需重启请先停止旧服务。')
        sys.exit(1)

    # 遇到停止信号时优雅退出（否则 systemd 要等超时才强杀）
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    # 注册命令菜单（失败不影响主循环）
    register_commands(token)

    # 清掉历史积压消息：如果机器人停了很久，重启后不该把旧消息重放一遍
    LOG.info('正在清理历史消息...')
    _api(token, 'getUpdates', {'offset': -1, 'timeout': 0}, timeout=20)

    LOG.info('机器人已启动，开始接收消息（长轮询）')

    offset = 0
    while _RUNNING:
        try:
            payload = {'offset': offset, 'timeout': POLL_TIMEOUT}
            url = API_BASE % (token, 'getUpdates')
            resp = requests.post(url, json=payload, timeout=HTTP_TIMEOUT)
            data = resp.json()

            if not data.get('ok'):
                # 409 表示有另一个进程在轮询，或同时配了 Webhook
                description = data.get('description', '')
                if 'Conflict' in description or 'webhook' in description.lower():
                    LOG.error('轮询冲突：%s。'
                              '可能原因：另一个机器人在跑，或这个 Bot 被设了 Webhook。',
                              description)
                    time.sleep(30)
                else:
                    LOG.warning('getUpdates 返回异常: %s', common.redact(resp.text))
                    time.sleep(5)
                continue

            config = common.load_config(LOG)   # 每轮重读配置，改了配置无需重启

            for update in data.get('result', []):
                offset = update.get('update_id', 0) + 1
                try:
                    handle_update(config, token, update)
                except Exception as error:
                    LOG.error('处理消息出错: %s', common.redact(error))

        except requests.exceptions.ConnectTimeout:
            # 正常：长轮询时间到了没消息
            continue
        except requests.exceptions.ProxyError as error:
            LOG.error('网络异常（代理不可用），30 秒后重试: %s', common.redact(error))
            time.sleep(30)
        except Exception as error:
            LOG.error('主循环异常，5 秒后重试: %s', common.redact(error))
            time.sleep(5)

    LOG.info('机器人已退出')
    if hasattr(lock, 'close'):
        lock.close()


if __name__ == '__main__':
    main()
