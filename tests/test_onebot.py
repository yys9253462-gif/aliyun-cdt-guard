# -*- coding: utf-8 -*-
"""OneBot 通道功能测试

用本地模拟服务器真实验证：
  1) 群聊发送 —— 路径 /send_group_msg、请求体 group_id、鉴权头
  2) 私聊发送 —— 路径 /send_private_msg、请求体 user_id
  3) 完整 send_alert 链路 —— Telegram 失败时 OneBot 仍能送达
  4) 服务不可达 —— 必须优雅降级（返回 False，不抛异常）

运行：隔离环境 python tests/test_onebot.py
"""
import json
import os
import sys
import threading

# 让测试能 import 到 src 下的模块
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, 'src'))

from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

import notifier  # noqa: E402

# ---------------------------------------------------------------- 模拟服务器

REQUESTS = []          # 记录收到的所有请求
FAIL_MODE = {'on': False}   # 打开后一律返回 500，测降级


class MockOneBot(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length).decode('utf-8') if length else ''
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {'__unparsed__': raw}

        REQUESTS.append({
            'path': self.path,
            'auth': self.headers.get('Authorization') or '',
            'body': body,
        })

        if FAIL_MODE['on']:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"status":"failed","retcode":100}')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok","retcode":0,"data":{"message_id":123}}')

    def log_message(self, *a):
        pass  # 静音


def start_server():
    srv = HTTPServer(('127.0.0.1', 0), MockOneBot)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, port


# ---------------------------------------------------------------- 断言工具

PASSED = []
FAILED = []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print('  [通过] %s' % name)
    else:
        FAILED.append((name, detail))
        print('  [失败] %s  %s' % (name, detail))


def reset():
    REQUESTS.clear()
    FAIL_MODE['on'] = False


# ---------------------------------------------------------------- 测试用例

def test_group_send(base):
    print('\n用例 1：群聊发送')
    reset()
    ob = notifier.OneBot(base, token='test-token', target_id='9527',
                         target_type='group')
    ok = ob.send('群聊测试消息')

    check('返回值为真', ok is True, '实际返回 %r' % ok)
    check('恰好发出 1 个请求', len(REQUESTS) == 1,
          '实际 %d 个' % len(REQUESTS))
    if not REQUESTS:
        return
    r = REQUESTS[0]
    check('路径为 /send_group_msg', r['path'] == '/send_group_msg',
          '实际 %s' % r['path'])
    check('group_id 为整数 9527', r['body'].get('group_id') == 9527,
          '实际 %r' % r['body'].get('group_id'))
    check('消息体正确', r['body'].get('message') == '群聊测试消息',
          '实际 %r' % r['body'].get('message'))
    # NapCat 常见鉴权方式是 body 里的 access_token
    check('鉴权令牌已带上', r['body'].get('access_token') == 'test-token',
          '实际 %r' % r['body'].get('access_token'))


def test_private_send(base):
    print('\n用例 2：私聊发送')
    reset()
    ob = notifier.OneBot(base, token='', target_id='10086',
                         target_type='private')
    ok = ob.send('私聊测试消息')

    check('返回值为真', ok is True, '实际返回 %r' % ok)
    check('恰好发出 1 个请求', len(REQUESTS) == 1,
          '实际 %d 个' % len(REQUESTS))
    if not REQUESTS:
        return
    r = REQUESTS[0]
    check('路径为 /send_private_msg', r['path'] == '/send_private_msg',
          '实际 %s' % r['path'])
    check('user_id 为整数 10086', r['body'].get('user_id') == 10086,
          '实际 %r' % r['body'].get('user_id'))
    check('无令牌时不下发 access_token',
          'access_token' not in r['body'],
          '实际 %r' % r['body'].get('access_token'))


def test_alert_pipeline(base):
    print('\n用例 3：完整告警链路（OneBot 参与告警）')
    reset()
    cfg = {
        'telegram': {'enabled': False, 'bot_token': '', 'chat_id': ''},
        'onebot': {'enabled': True, 'base_url': base,
                   'token': 'tk', 'target_id': '9527',
                   'target_type': 'group'},
        # QQ 官方不参与告警（只能发日报摘要），这里显式关掉
        'qq': {'enabled': False},
    }
    logger = notifier.build_silent_logger() if hasattr(
        notifier, 'build_silent_logger') else None

    ok = notifier.send_alert(cfg, '抢占式实例已自动开机',
                            '实例 i-abc 检测到停机，已拉起。', logger)
    check('send_alert 返回真', ok is True, '实际返回 %r' % ok)
    check('OneBot 收到告警', len(REQUESTS) >= 1,
          '实际 %d 个请求' % len(REQUESTS))
    if REQUESTS:
        body = REQUESTS[0]['body'].get('message', '')
        check('告警正文含标题关键词', '自动开机' in body,
              '实际正文 %r' % body[:80])


def test_unreachable(base):
    print('\n用例 4：服务不可达时优雅降级')
    reset()
    # 127.0.0.1:1 必然连不上
    ob = notifier.OneBot('http://127.0.0.1:1', token='tk',
                         target_id='9527', target_type='group')
    try:
        ok = ob.send('这条发不出去')
        check('返回假而不是抛异常', ok is False, '实际返回 %r' % ok)
    except Exception as e:
        check('返回假而不是抛异常', False,
              '抛出了 %s: %s' % (type(e).__name__, e))

    print('\n用例 5：服务返回 500 时优雅降级')
    reset()
    FAIL_MODE['on'] = True
    ob2 = notifier.OneBot(base, token='tk', target_id='9527',
                          target_type='group')
    try:
        ok = ob2.send('服务端故障')
        check('返回假而不是抛异常', ok is False, '实际返回 %r' % ok)
    except Exception as e:
        check('返回假而不是抛异常', False,
              '抛出了 %s: %s' % (type(e).__name__, e))


# ---------------------------------------------------------------- 主流程

def main():
    srv, port = start_server()
    base = 'http://127.0.0.1:%d' % port
    print('模拟 OneBot 服务已启动：%s' % base)

    try:
        test_group_send(base)
        test_private_send(base)
        test_alert_pipeline(base)
        test_unreachable(base)
    finally:
        srv.shutdown()

    print('\n' + '=' * 46)
    print('通过 %d 项，失败 %d 项' % (len(PASSED), len(FAILED)))
    if FAILED:
        for n, d in FAILED:
            print('  × %s  %s' % (n, d))
        print('=== 存在失败用例 ===')
        return 1
    print('=== 全部功能测试通过 ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
