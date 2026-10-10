# -*- coding: utf-8 -*-
"""通知模块健壮性回归测试

重点复现并锁死这个真实崩溃：
    AttributeError: 'NoneType' object has no attribute 'error'
场景：安装脚本自检时没传 logger，Telegram 推送失败后写日志的动作自己崩了。

本测试确保：**任何通知函数在 logger 为 None 时都不得抛异常**。
"""
import os
import sys
import threading

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, 'src'))

from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

import notifier  # noqa: E402

PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print('  [通过] %s' % name)
    else:
        FAILED.append((name, detail))
        print('  [失败] %s  %s' % (name, detail))


class Boom(BaseHTTPRequestHandler):
    """一律返回 500，逼出所有的错误分支。"""

    def do_POST(self):
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b'{"error":"forced failure"}')

    def do_GET(self):
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b'{"error":"forced failure"}')

    def log_message(self, *a):
        pass


def main():
    srv = HTTPServer(('127.0.0.1', 0), Boom)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    bad = 'http://127.0.0.1:%d' % port

    print('=== 用例 1：ensure_logger 兜底 ===')
    check('None 也能拿到可用日志器',
          notifier.ensure_logger(None) is not None)
    nl = notifier.ensure_logger(None)
    try:
        nl.info('x'); nl.warning('x'); nl.error('x'); nl.exception('x')
        nl.debug('x')
        check('空日志器各方法均不报错', True)
    except Exception as e:
        check('空日志器各方法均不报错', False, repr(e))
    check('传入真实日志器时原样返回',
          notifier.ensure_logger('MYLOG') == 'MYLOG')

    print('\n=== 用例 2：logger=None 时 _send_telegram 不崩 ===')
    try:
        r = notifier._send_telegram('fake:token', '123', '正文',
                                    None)  # 关键：logger 传 None
        check('返回布尔值而非抛异常', isinstance(r, bool), '实际 %r' % r)
        check('发送失败如实返回假', r is False, '实际 %r' % r)
    except Exception as e:
        check('返回布尔值而非抛异常', False, '%s: %s' % (type(e).__name__, e))

    print('\n=== 用例 3：logger=None 时 send_alert 不崩 ===')
    cfg = {
        'telegram': {'bot_token': 'fake:token', 'chat_id': '123'},
        'onebot': {'base_url': bad, 'token': '', 'target_id': '1',
                   'target_type': 'group'},
        'qq': {'app_id': 'x', 'app_secret': 'y', 'target_id': 'z',
               'target_type': 'group'},
    }
    try:
        r = notifier.send_alert(cfg, '标题', '正文', 'danger', None)
        check('返回布尔值而非抛异常', isinstance(r, bool), '实际 %r' % r)
    except Exception as e:
        check('返回布尔值而非抛异常', False, '%s: %s' % (type(e).__name__, e))

    print('\n=== 用例 4：logger=None 时 send_report 不崩 ===')
    try:
        r = notifier.send_report(cfg, '日报正文', None)
        check('返回布尔值而非抛异常', isinstance(r, bool), '实际 %r' % r)
    except Exception as e:
        check('返回布尔值而非抛异常', False, '%s: %s' % (type(e).__name__, e))

    print('\n=== 用例 5：OneBot 类 logger=None 时发送失败不崩 ===')
    try:
        ob = notifier.OneBot(bad, token='', target_id='1',
                             target_type='group', logger=None)
        r = ob.send('消息')
        check('返回假而非抛异常', r is False, '实际 %r' % r)
    except Exception as e:
        check('返回假而非抛异常', False, '%s: %s' % (type(e).__name__, e))

    print('\n=== 用例 6：QQBot 类 logger=None 时取token失败不崩 ===')
    try:
        qb = notifier.QQBot('appid', 'secret', 'target',
                            'group', logger=None)
        # 强制把 token 接口指向本地失败服务
        notifier.QQ_TOKEN_URL = bad
        notifier.QQ_API_BASE = bad
        r = qb.send('消息')
        check('返回假而非抛异常', r is False, '实际 %r' % r)
    except Exception as e:
        check('返回假而非抛异常', False, '%s: %s' % (type(e).__name__, e))

    srv.shutdown()

    print('\n' + '=' * 46)
    print('通过 %d 项，失败 %d 项' % (len(PASSED), len(FAILED)))
    if FAILED:
        for n, d in FAILED:
            print('  × %s  %s' % (n, d))
        print('=== 存在失败用例 ===')
        return 1
    print('=== 通知模块健壮性测试全部通过 ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
