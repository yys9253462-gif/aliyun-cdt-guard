# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 通知模块
==============================
支持三个渠道：Telegram、QQ 官方机器人、OneBot（NapCat / Lagrange 等）。

渠道定位：
    Telegram   —— 主力渠道。承担全部告警与日报，无频控限制。
    OneBot     —— 推荐自建方案。NapCat / Lagrange 等框架，走 HTTP 接口，
                  无配额限制、无需审核，可以直接发告警。
    QQ 官方机器人 —— 备选。腾讯对主动消息有严格频控（群聊每月仅 4 条），
                  因此只用于发送日报摘要，不承担告警。

    三者可以同时启用，互不影响；任意一个发送失败都不会中断止损主流程。
"""
import json
import time
import requests

from common import redact

REQUEST_TIMEOUT = 15
QQ_API_BASE = 'https://api.bot.qq.com'
QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'


class _NullLogger:
    """空日志器：当调用方没传 logger 时兜底使用。

    为什么需要它：本模块所有出错分支都会写日志，若 logger 为 None，
    写日志这个动作本身会抛 AttributeError，把「通知失败」升级成「程序崩溃」。
    安装脚本自检时就是踩了这个坑 —— 恰好在没有 logger 的场景下调用，
    结果 Telegram 一发失败就整个堆栈炸出来，掩盖了真实原因。
    """
    def debug(self, *a, **k):
        pass

    def info(self, *a, **k):
        pass

    def warning(self, *a, **k):
        pass

    def error(self, *a, **k):
        pass

    def exception(self, *a, **k):
        pass


_NULL_LOGGER = _NullLogger()


def ensure_logger(logger):
    """保证返回一个可用的日志对象，杜绝 None.xxx 崩溃。"""
    return logger if logger is not None else _NULL_LOGGER



# ============================================================================
# Telegram
# ============================================================================
def _split_message(text, limit=3900):
    """Telegram 单条消息上限 4096 字符，按行切分成多段。"""
    chunks, current = [], ''
    for line in str(text).split('\n'):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ''
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = line if not current else current + '\n' + line
        if len(candidate) > limit and current:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _send_telegram(bot_token, chat_id, text, logger, parse_markdown=True):
    """发送 Telegram 消息。Markdown 解析失败时自动降级为纯文本重试一次。

    返回 True / False。失败原因会记入日志，便于安装自检时诊断。
    """
    logger = ensure_logger(logger)
    url = 'https://api.telegram.org/bot%s/sendMessage' % bot_token
    for chunk in _split_message(text):
        payloads = [{'chat_id': chat_id, 'text': chunk}]
        if parse_markdown:
            payloads.insert(0, {'chat_id': chat_id, 'text': chunk, 'parse_mode': 'Markdown'})
        sent = False
        for payload in payloads:
            try:
                resp = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 200:
                    sent = True
                    break
                logger.error('Telegram 推送失败: HTTP %s %s',
                             resp.status_code, redact(resp.text))
            except requests.exceptions.ProxyError as error:
                logger.error('Telegram 推送异常（代理不可用）: %s', redact(error))
            except requests.exceptions.ConnectTimeout:
                logger.error('Telegram 推送超时：无法连到 api.telegram.org，'
                             '本机可能处于受限网络，需要配置代理')
            except requests.exceptions.SSLError as error:
                logger.error('Telegram 推送异常（TLS 握手失败，可能被拦截）: %s',
                             redact(error))
            except Exception as error:
                logger.error('Telegram 推送异常: %s', redact(error))
        if not sent:
            return False
    return True


def telegram_reachable(timeout=5):
    """探测本机能否连上 Telegram API，用于安装自检给出准确提示。

    返回 (是否可达, 说明文字)。只做 TCP/TLS 探测，不发送任何消息。
    """
    try:
        resp = requests.get('https://api.telegram.org/', timeout=timeout)
        return True, 'HTTP %s' % resp.status_code
    except requests.exceptions.ProxyError:
        return False, '代理不可用'
    except requests.exceptions.ConnectTimeout:
        return False, '连接超时（网络受限，可能需要代理）'
    except requests.exceptions.SSLError:
        return False, 'TLS 握手失败（可能被中间设备拦截）'
    except Exception as error:
        return False, redact(error)



# ============================================================================
# OneBot 协议（NapCat / Lagrange / go-cqhttp 等）
# ============================================================================
class OneBot:
    """OneBot v11 HTTP 客户端。

    为什么推荐这条路：
        NapCat / Lagrange 这类框架是自己搭的，不经过腾讯官方审核，
        也没有「每月 4 条」的主动消息配额，可以直接承担全部告警。

    鉴权方式（二选一，看框架配置）：
        1. Authorization: Bearer <token>
        2. 请求体里带 access_token 字段

    常用接口：
        发送群消息：POST {base}/send_group_msg   {"group_id": 123, "message": "文本"}
        发送私聊：  POST {base}/send_private_msg {"user_id": 123, "message": "文本"}
    """

    def __init__(self, base_url, token, target_id, target_type='group', logger=None):
        self.base_url = (base_url or '').strip().rstrip('/')
        self.token = (token or '').strip()
        self.target_id = str(target_id).strip()
        self.target_type = target_type  # group 或 private
        self.logger = ensure_logger(logger)

    def _headers(self):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer %s' % self.token
        return headers

    def send(self, text):
        """发送文本消息，返回 True/False。"""
        if not self.base_url or not self.target_id:
            return False

        if self.target_type == 'private':
            path = '/send_private_msg'
            try:
                body = {'user_id': int(self.target_id), 'message': str(text)}
            except ValueError:
                body = {'user_id': self.target_id, 'message': str(text)}
        else:
            path = '/send_group_msg'
            try:
                body = {'group_id': int(self.target_id), 'message': str(text)}
            except ValueError:
                body = {'group_id': self.target_id, 'message': str(text)}

        # 部分框架用请求体传 token，两种都带上以提高兼容性
        if self.token:
            body['access_token'] = self.token

        try:
            resp = requests.post(self.base_url + path, headers=self._headers(),
                                 json=body, timeout=REQUEST_TIMEOUT)
            data = {}
            try:
                data = resp.json()
            except ValueError:
                pass

            # OneBot 返回 {"status":"ok","retcode":0} 表示成功
            if resp.status_code == 200 and (data.get('retcode') == 0
                                            or data.get('status') == 'ok'):
                return True

            if self.logger:
                self.logger.error('OneBot 推送失败: HTTP %s %s',
                                  resp.status_code, redact(resp.text))
            return False
        except Exception as error:
            if self.logger:
                self.logger.error('OneBot 推送异常: %s', redact(error))
            return False


# ============================================================================
# QQ 官方机器人
# ============================================================================
class QQBot:
    """QQ 官方机器人客户端。

    鉴权流程：
        1. 用 AppID + AppSecret 换 access_token（有效期约 7200 秒）
        2. 请求头带 Authorization: QQBot <access_token>

    消息接口（v2）：
        群聊：POST /v2/groups/{group_openid}/messages
        单聊：POST /v2/users/{user_openid}/messages
        消息体：{"msg_type": 0, "content": "文本", "msg_id": "...", "msg_seq": 1}
        注意：不带 msg_id 就是「主动消息」，受每月配额限制。
    """

    def __init__(self, app_id, app_secret, target_id, target_type='group', logger=None):
        self.app_id = app_id
        self.app_secret = app_secret
        self.target_id = target_id
        self.target_type = target_type  # group 或 user
        self.logger = ensure_logger(logger)
        self._token = None
        self._token_expire_at = 0

    def _get_token(self):
        """获取或复用 access_token，提前 60 秒刷新。"""
        now = time.time()
        if self._token and now < self._token_expire_at - 60:
            return self._token

        try:
            resp = requests.post(
                QQ_TOKEN_URL,
                json={'appId': self.app_id, 'clientSecret': self.app_secret},
                timeout=REQUEST_TIMEOUT,
            )
            data = resp.json()
            token = data.get('access_token')
            if not token:
                if self.logger:
                    self.logger.error('QQ 获取 token 失败: %s', redact(resp.text))
                return None
            expires_in = int(data.get('expires_in', 7200))
            self._token = token
            self._token_expire_at = now + expires_in
            return token
        except Exception as error:
            if self.logger:
                self.logger.error('QQ 获取 token 异常: %s', redact(error))
            return None

    def send(self, text):
        """发送文本消息。返回 True/False。"""
        token = self._get_token()
        if not token:
            return False

        if self.target_type == 'user':
            path = '/v2/users/%s/messages' % self.target_id
        else:
            path = '/v2/groups/%s/messages' % self.target_id
        url = QQ_API_BASE + path

        headers = {
            'Authorization': 'QQBot %s' % token,
            'Content-Type': 'application/json',
        }
        payload = {'msg_type': 0, 'content': str(text)[:1500]}

        try:
            resp = requests.post(url, headers=headers, json=payload,
                                 timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return True

            body = resp.text
            # 40034102 表示主动消息配额已用尽或无权限，属于预期内情况
            if '40034102' in body:
                if self.logger:
                    self.logger.warning(
                        'QQ 主动消息配额已用尽或无权限（官方限制每月仅 4 条），本次跳过。'
                        '这是预期行为，告警不受影响。')
            else:
                if self.logger:
                    self.logger.error('QQ 推送失败: HTTP %s %s',
                                      resp.status_code, redact(body))
            return False
        except Exception as error:
            if self.logger:
                self.logger.error('QQ 推送异常: %s', redact(error))
            return False


# ============================================================================
# 对外统一接口
# ============================================================================
def _qq_config(config):
    qq = config.get('qq') or {}
    if not qq.get('app_id') or not qq.get('app_secret') or not qq.get('target_id'):
        return None
    return qq


def _onebot_config(config):
    ob = config.get('onebot') or {}
    if not ob.get('base_url') or not ob.get('target_id'):
        return None
    return ob


def _build_onebot(config, logger):
    ob = _onebot_config(config)
    if not ob:
        return None
    return OneBot(ob['base_url'], ob.get('token', ''), ob['target_id'],
                  ob.get('target_type', 'group'), logger)


def send_alert(config, title, message, level='info', logger=None):
    """发送告警（高频事件）。

    走 Telegram 和 OneBot。这两条通道都没有主动消息配额限制。
    QQ 官方通道不参与告警（配额只有每月 4 条）。
    返回 True 表示至少一个渠道发送成功。
    """
    logger = ensure_logger(logger)
    icon = {'info': '\u2705', 'warn': '\u26a0\ufe0f', 'danger': '\U0001f6a8'}.get(level, '\u2139\ufe0f')
    text = '%s *%s*\n\n%s' % (icon, title, message)
    plain = '%s %s\n\n%s' % (
        {'info': '[正常]', 'warn': '[提醒]', 'danger': '[告警]'}.get(level, '[通知]'),
        title, message,
    )

    ok = False

    tg = config.get('telegram') or {}
    if tg.get('bot_token') and tg.get('chat_id'):
        ok = _send_telegram(tg['bot_token'], tg['chat_id'], text, logger) or ok

    onebot = _build_onebot(config, logger)
    if onebot:
        ok = onebot.send(plain) or ok

    if not ok and logger:
        logger.warning('告警未能通过任何渠道发出，请检查 Telegram / OneBot 配置')
    return ok


def send_report(config, message, logger=None):
    """发送日报（低频，每天一次）。

    Telegram 与 OneBot 发全文；QQ 官方通道发摘要（配额紧张）。
    """
    logger = ensure_logger(logger)
    ok = False

    tg = config.get('telegram') or {}
    if tg.get('bot_token') and tg.get('chat_id'):
        ok = _send_telegram(tg['bot_token'], tg['chat_id'], message, logger,
                            parse_markdown=False) or ok

    onebot = _build_onebot(config, logger)
    if onebot:
        ok = onebot.send(message) or ok

    qq = _qq_config(config)
    if qq:
        bot = QQBot(qq['app_id'], qq['app_secret'], qq['target_id'],
                    qq.get('target_type', 'group'), logger)
        if bot.send(_qq_summary(message)):
            if logger:
                logger.info('QQ 官方日报已发送')
            ok = True

    if not ok and logger:
        logger.warning('日报未通过任何渠道发出，请检查配置')
    return ok


def _qq_summary(message, max_lines=12):
    """截取报表关键行作为 QQ 摘要，控制长度避免超限。"""
    lines = [line for line in str(message).split('\n') if line.strip()]
    head = lines[:max_lines]
    if len(lines) > max_lines:
        head.append('...（完整报表请查看 Telegram）')
    return '\n'.join(head)
