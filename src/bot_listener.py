# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - Telegram 交互式机器人（常驻进程）
======================================================
这是「手机端控制台」：让你在 Telegram 里点按钮就能查流量、看报表、
手动开关机、暂停监控，不用再 SSH 登进去敲命令。

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

try:
    import fcntl
except ImportError:
    fcntl = None

LOG = common.build_logger('cdt_bot', os.path.join(common.BASE_DIR, 'bot.log'))

API_BASE = 'https://api.telegram.org/bot%s/%s'
POLL_TIMEOUT = 30           # 长轮询等待时间（秒），Telegram 侧最多挂 50 秒
HTTP_TIMEOUT = POLL_TIMEOUT + 15
LOCK_FILE = os.path.join(common.BASE_DIR, 'bot.lock')

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
    """发送消息。keyboard 为内联键盘按钮定义。"""
    payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'Markdown'}
    if keyboard:
        payload['reply_markup'] = {'inline_keyboard': keyboard}
    result = _api(token, 'sendMessage', payload)
    if result is None:
        # Markdown 解析失败（实例名里带特殊字符）时降级为纯文本重发
        payload.pop('parse_mode', None)
        result = _api(token, 'sendMessage', payload)
    return result is not None


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


# ============================================================================
# 菜单构建
# ============================================================================
def main_menu_keyboard(config):
    """主菜单按钮。每台机器一行，带「开机/关机/暂停」三个操作。"""
    rows = []
    for user in config.get('users', [])[:8]:     # 按钮太多会刷屏，最多 8 台
        iid = user.get('instance_id', '')
        name = common.sanitize(user.get('name') or iid)
        # callback_data 最长 64 字节，实例 ID 约 20 字符，够用
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

*命令*
/menu   显示操作菜单
/status 查看所有机器实时状态
/traffic 查看流量与免费额度
/report 立即发送完整报表
/run    立即执行一次巡检
/help   显示本条说明

*按钮*
每台机器一行四个按钮：
· 「状态」查看该机器的实时状态
· 「开机」手动启动实例
· 「关机」手动停止实例
· 「暂停 / 恢复」是否让脚本自动管理它

*注意*
· 底部两个按钮作用于全部机器。
· 「暂停」只是让脚本不再自动开关机，手动按钮仍然可用。
· 自动止损（流量超标强制关机）由后台定时任务执行，不受这里影响。
· 只有你（配置里的 Chat ID）能操作，别人发消息不会有任何反应。"""


# ============================================================================
# 消息处理
# ============================================================================
def _authorized(config, chat_id):
    """校验来源是否是你本人。这是安全底线，绝不能省。"""
    allowed = str((config.get('telegram') or {}).get('chat_id', '')).strip()
    return allowed and str(chat_id).strip() == allowed


def handle_command(config, token, chat_id, text):
    """处理 / 命令。"""
    cmd = text.strip().split()[0].lower().lstrip('/')
    # 去掉 @BotName 后缀（群聊里发命令会带）
    cmd = cmd.split('@')[0]

    if cmd in ('start', 'menu'):
        send_text(token, chat_id, '*CDT 流量守护 · 控制台*\n\n选择下面的按钮操作：',
                  main_menu_keyboard(config))
    elif cmd == 'status':
        send_text(token, chat_id, build_status(config))
    elif cmd == 'traffic':
        send_text(token, chat_id, build_traffic(config))
    elif cmd == 'report':
        send_text(token, chat_id, '正在生成报表，可能需要十几秒...')
        import report as report_module
        try:
            content = report_module.build_report(config)
        except Exception as error:
            LOG.error('生成报表失败: %s', common.redact(error))
            send_text(token, chat_id,
                      '报表生成失败：%s\n通常某台机器的接口查不通，详见 bot.log。'
                      % common.sanitize(error))
            return
        send_text(token, chat_id, content)
    elif cmd == 'run':
        send_text(token, chat_id,
                  '正在执行巡检，如果某台机器需要开机等待，'
                  '最长约 3 分钟。这期间其他消息会排队，请稍候...')
        import guard as guard_module
        # 必须和 cron 巡检抢同一把锁：否则两边同时读写 state.json 会互相覆盖
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
    elif cmd == 'help':
        send_text(token, chat_id, HELP_TEXT)
    else:
        send_text(token, chat_id, '没听懂这个命令。发送 /help 查看用法，'
                                  '或发送 /menu 打开菜单。')


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

    elif action == 'report':
        answer_callback(token, callback_id, '正在生成报表，可能需要十几秒...')
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
            send_text(token, chat_id, '发送 /menu 打开控制台，或 /help 查看用法。')
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
