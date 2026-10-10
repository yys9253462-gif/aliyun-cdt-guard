# -*- coding: utf-8 -*-
"""
Telegram 机器人菜单逻辑测试
===========================
测什么：
    bot_listener.py 是常驻进程，无法在测试里真的连 Telegram。
    所以把「发送消息」和「调用阿里云接口」全部替换成记录型假函数，
    然后验证三件事：

      1. 权限校验：只有配置里的 Chat ID 能操作，别人发消息完全无反应。
         —— 这是安全底线。如果这里漏了，任何人知道 Bot 名字就能关你的机器。
      2. 按钮分发：点不同按钮走不同逻辑，且必须调 answerCallbackQuery
         —— 不调的话客户端按钮会一直转圈。
      3. 菜单内容：按钮数与机器数一致，callback_data 不超 64 字节
         —— 超了 Telegram 会直接拒绝整个键盘。

    特别要覆盖的坏情况：
      · 未授权用户点按钮 → 不能真的关机，且要回应「无权操作」
      · callback_data 超长 → 按钮会静默失效，必须提前发现
      · 机器名带下划线/星号 → Telegram Markdown 解析失败导致整条消息发不出去
"""
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

_TEST_DIR = tempfile.mkdtemp(prefix='cdt-bot-test-')
os.environ['CDT_GUARD_DIR'] = _TEST_DIR


def _install_sdk_stubs():
    """造阿里云 SDK 桩模块，让导入能过（本测试不碰网络）。"""
    if 'aliyunsdkcore' in sys.modules:
        return
    modules = {}
    names = [
        'aliyunsdkcore', 'aliyunsdkcore.client', 'aliyunsdkcore.request',
        'aliyunsdkcore.vendored', 'aliyunsdkcore.vendored.requests',
        'aliyunsdkcore.vendored.requests.packages',
        'aliyunsdkcore.vendored.requests.packages.urllib3',
        'aliyunsdkcore.vendored.requests.packages.urllib3.util',
        'aliyunsdkcore.vendored.requests.packages.urllib3.util.ssl_',
        'aliyunsdkecs', 'aliyunsdkecs.request',
        'aliyunsdkecs.request.v20140526',
        'aliyunsdkecs.request.v20140526.StartInstanceRequest',
        'aliyunsdkecs.request.v20140526.StopInstanceRequest',
        'aliyunsdkecs.request.v20140526.RebootInstanceRequest',
        'aliyunsdkecs.request.v20140526.DescribeInstancesRequest',
    ]
    for name in names:
        modules[name] = types.ModuleType(name)

    class _Placeholder:
        def __init__(self, *a, **k): pass
        def __getattr__(self, item): return lambda *a, **k: None

    modules['aliyunsdkcore.client'].AcsClient = _Placeholder
    modules['aliyunsdkcore.request'].CommonRequest = _Placeholder
    for mod_name, cls_name in [
        ('aliyunsdkecs.request.v20140526.StartInstanceRequest', 'StartInstanceRequest'),
        ('aliyunsdkecs.request.v20140526.StopInstanceRequest', 'StopInstanceRequest'),
        ('aliyunsdkecs.request.v20140526.RebootInstanceRequest', 'RebootInstanceRequest'),
        ('aliyunsdkecs.request.v20140526.DescribeInstancesRequest', 'DescribeInstancesRequest'),
    ]:
        setattr(modules[mod_name], cls_name, _Placeholder)
    modules['aliyunsdkcore.vendored.requests.packages.urllib3.util.ssl_'].HAS_SNI = False

    for name, mod in modules.items():
        if '.' in name:
            parent_name, child = name.rsplit('.', 1)
            setattr(modules[parent_name], child, mod)
    for name, mod in modules.items():
        sys.modules[name] = mod


_install_sdk_stubs()

import common
import aliyun_api
import bot_listener as bot


MY_CHAT_ID = 7912011729
OTHER_CHAT_ID = 999999999


class SentMessage:
    def __init__(self, chat_id, text, keyboard):
        self.chat_id = chat_id
        self.text = text
        self.keyboard = keyboard


class TestBot(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.answered = []
        self.start_calls = []
        self.stop_calls = []
        self.config = {
            'telegram': {'bot_token': '123:ABC', 'chat_id': str(MY_CHAT_ID)},
            'users': [
                {'name': '香港节点', 'ak': 'ak1', 'sk': 'sk1',
                 'region': 'cn-hongkong', 'instance_id': 'i-hk0000000000000001',
                 'traffic_limit': 180, 'paused': False},
                {'name': '菲律宾_主_节点*', 'ak': 'ak2', 'sk': 'sk2',
                 'region': 'ap-southeast-6', 'instance_id': 'i-ph0000000000000002',
                 'traffic_limit': 180, 'paused': True},
            ],
        }

        # 替换发送与回应
        self._orig_send = bot.send_text
        self._orig_send_menu = bot.send_menu
        self._orig_answer = bot.answer_callback
        bot.send_text = lambda token, chat_id, text, keyboard=None: (
            self.sent.append(SentMessage(chat_id, text, keyboard)) or True)
        # 新版 /menu 用的是回复键盘（send_menu），这里一并拦住，
        # 否则「发 /menu 有没有回应」这类断言会误判成失败。
        bot.send_menu = lambda token, chat_id, text, rows, placeholder='': (
            self.sent.append(SentMessage(chat_id, text, rows)) or True)
        bot.answer_callback = lambda token, cid, text='': self.answered.append(
            {'id': cid, 'text': text})

        # 替换阿里云操作
        self._orig_start = aliyun_api.start_instance
        self._orig_stop = aliyun_api.stop_instance
        self._orig_status = aliyun_api.get_instance_status
        self._orig_traffic = aliyun_api.get_cdt_traffic_gb
        aliyun_api.start_instance = lambda *a, **k: self.start_calls.append(a)
        aliyun_api.stop_instance = lambda *a, **k: self.stop_calls.append(a)
        aliyun_api.get_instance_status = lambda *a, **k: 'Running'
        aliyun_api.get_cdt_traffic_gb = lambda *a, **k: 100.0

        # 报表模块要单独替换：它依赖更多接口，在测试环境里跑不通。
        # 替换成固定文本，这样能专心验证「按钮分发」而不是「报表内容」。
        import report as report_module
        self._orig_build_report = report_module.build_report
        self.report_should_fail = False

        def _fake_build_report(cfg):
            if self.report_should_fail:
                raise RuntimeError('模拟报表生成失败')
            return '[模拟报表]\n一切正常'

        report_module.build_report = _fake_build_report

        # 替换配置保存，避免污染
        self._orig_save = common.save_config
        common.save_config = lambda cfg: None

        # 替换日志
        self._orig_log = bot.LOG

        class _L:
            def debug(self, *a, **k): pass
            def info(self, *a, **k): pass
            def warning(self, *a, **k): pass
            def error(self, *a, **k): pass
            def exception(self, *a, **k): pass

        bot.LOG = _L()

    def tearDown(self):
        bot.send_text = self._orig_send
        bot.send_menu = self._orig_send_menu
        bot.answer_callback = self._orig_answer
        aliyun_api.start_instance = self._orig_start
        aliyun_api.stop_instance = self._orig_stop
        aliyun_api.get_instance_status = self._orig_status
        aliyun_api.get_cdt_traffic_gb = self._orig_traffic
        common.save_config = self._orig_save
        bot.LOG = self._orig_log
        import report as report_module
        report_module.build_report = self._orig_build_report

    # ---------------- 权限校验 ----------------
    def test_未授权消息被忽略(self):
        """陌生人发 /menu，不应收到任何回复，也不该触发任何动作。"""
        bot.handle_command(self.config, 'tok', OTHER_CHAT_ID, '/menu')
        # handle_command 本身不校验，校验在 handle_update 层
        self.sent.clear()
        bot.handle_update(self.config, 'tok',
                          {'message': {'chat': {'id': OTHER_CHAT_ID}, 'text': '/menu'}})
        self.assertEqual(self.sent, [], '陌生人不应收到任何回复')

    def test_未授权点按钮被拒(self):
        """陌生人点「关机」按钮，绝不能真的关机。"""
        bot.handle_update(self.config, 'tok', {
            'callback_query': {
                'id': 'cb1',
                'data': 'dn:i-hk0000000000000001',
                'message': {'chat': {'id': OTHER_CHAT_ID}},
            }
        })
        self.assertEqual(self.stop_calls, [], '陌生人不能触发关机！这是安全底线')
        self.assertTrue(self.answered, '必须回应按钮，否则客户端一直转圈')
        self.assertIn('无权', self.answered[0]['text'])

    def test_本人消息正常处理(self):
        bot.handle_update(self.config, 'tok',
                          {'message': {'chat': {'id': MY_CHAT_ID}, 'text': '/menu'}})
        self.assertTrue(self.sent, '本人发 /menu 应收到菜单')

    def test_chat_id_字符串数字都能识别(self):
        """配置里 Chat ID 存成字符串，Telegram 传的是数字，必须能对上。"""
        self.assertTrue(bot._authorized(self.config, MY_CHAT_ID))
        self.assertTrue(bot._authorized(self.config, str(MY_CHAT_ID)))
        self.assertFalse(bot._authorized(self.config, OTHER_CHAT_ID))

    # ---------------- 菜单构建 ----------------
    def test_菜单按钮数与机器数对应(self):
        kb = bot.main_menu_keyboard(self.config)
        # 每台机器一行 + 两行功能按钮 = 4 行
        self.assertEqual(len(kb), 4, '两台机器应有 4 行按钮')

    def test_callback_data_不超64字节(self):
        """超长会导致整个键盘被 Telegram 拒绝，必须卡死在这里。"""
        kb = bot.main_menu_keyboard(self.config)
        for row in kb:
            for btn in row:
                data = btn['callback_data'].encode('utf-8')
                self.assertLessEqual(
                    len(data), 64,
                    '按钮 %r 的 callback_data 有 %d 字节，超过 Telegram 上限 64'
                    % (btn['text'], len(data)))

    def test_机器超过8台只显示8台(self):
        """按钮太多会刷屏，且 callback_data 会重复，限制最多 8 台。"""
        many = {'telegram': {'chat_id': str(MY_CHAT_ID)},
                'users': [{'name': 'M%d' % i, 'instance_id': 'i-%019d' % i}
                          for i in range(20)]}
        kb = bot.main_menu_keyboard(many)
        # 8 台机器 + 2 行功能 = 10 行
        self.assertEqual(len(kb), 10)

    def test_暂停机器按钮显示已暂停(self):
        kb = bot.main_menu_keyboard(self.config)
        texts = [btn['text'] for row in kb for btn in row]
        self.assertTrue(any('已暂停' in t for t in texts),
                        '暂停的机器按钮上应有标记，实际：%s' % texts)

    # ---------------- 按钮分发 ----------------
    def _click(self, data, chat_id=MY_CHAT_ID):
        bot.handle_update(self.config, 'tok', {
            'callback_query': {
                'id': 'cb-x',
                'data': data,
                'message': {'chat': {'id': chat_id}},
            }
        })

    def test_点状态按钮查状态(self):
        self._click('st:i-hk0000000000000001')
        self.assertTrue(self.answered, '必须回应按钮点击')
        self.assertTrue(any('状态' in m.text for m in self.sent))

    def test_点开机按钮真开机(self):
        self._click('up:i-hk0000000000000001')
        self.assertEqual(len(self.start_calls), 1, '应调用一次开机接口')

    def test_点关机按钮真关机(self):
        self._click('dn:i-hk0000000000000001')
        self.assertEqual(len(self.stop_calls), 1, '应调用一次关机接口')

    def test_所有按钮都有回应(self):
        """遍历所有按钮，确认每个都会调 answerCallbackQuery。

        这是最容易漏的地方 —— 漏了客户端就一直转圈，用户以为卡死了。
        """
        kb = bot.main_menu_keyboard(self.config)
        for row in kb:
            for btn in row:
                self.sent.clear()
                self.answered.clear()
                self._click(btn['callback_data'])
                self.assertTrue(self.answered,
                                '按钮 %r（%s）没有调 answerCallbackQuery'
                                % (btn['text'], btn['callback_data']))

    def test_每个按钮都不抛异常(self):
        """按钮处理逻辑不能因参数异常而崩溃，否则整个机器人会挂。"""
        kb = bot.main_menu_keyboard(self.config)
        for row in kb:
            for btn in row:
                try:
                    self._click(btn['callback_data'])
                except Exception as error:
                    self.fail('按钮 %r 处理时抛异常: %s' % (btn['text'], error))

    def test_点未知按钮不崩(self):
        self._click('zz:i-xxx')
        self.assertTrue(self.answered, '未知按钮也要回应，否则一直转圈')

    def test_报表生成失败机器人不崩(self):
        """这是常驻进程最危险的场景：一个按钮出错整个进程挂掉，
        之后你发什么它都不理。必须有兜底。
        """
        self.report_should_fail = True
        self._click('report')
        # 关键断言：没抛异常，且回了话
        self.assertTrue(self.answered, '失败时也必须回应按钮')
        self.assertTrue(
            any('失败' in m.text for m in self.sent),
            '应把失败原因回给用户，实际消息：%s' % [m.text for m in self.sent])

    def test_开关机接口抛错也能回话(self):
        """开机接口报错（如库存不足）时，要回一句原因，而不是沉默或崩溃。"""
        def _boom(*a, **k):
            raise RuntimeError('库存不足')

        aliyun_api.start_instance = _boom
        self._click('up:i-hk0000000000000001')
        self.assertTrue(self.answered, '接口报错时也必须回应按钮')
        self.assertTrue(any('库存不足' in m.text for m in self.sent),
                        '应把接口报错原因回给用户')

    def test_接口报错机器人继续可用(self):
        """出错之后再点别的按钮，仍然要正常工作。"""
        aliyun_api.start_instance = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError('模拟失败'))
        self._click('up:i-hk0000000000000001')
        self.sent.clear()
        self.answered.clear()
        # 换一个正常按钮
        self._click('st:i-hk0000000000000001')
        self.assertTrue(self.answered, '出错后机器人应继续可用')
        self.assertTrue(self.sent, '出错后其他按钮仍应正常响应')

    def test_开关机目标机器正确(self):
        """点第二台机器的按钮，必须操作第二台，不能张冠李戴。"""
        self._click('dn:i-ph0000000000000002')
        self.assertEqual(len(self.stop_calls), 1)
        args = self.stop_calls[0]
        self.assertIn('i-ph0000000000000002', args, '应操作第二台机器')

    # ---------------- 命令处理 ----------------
    def test_命令带机器人后缀能识别(self):
        """群聊里发 /menu@MyBot 必须能识别，否则群聊里没法用。"""
        bot.handle_command(self.config, 'tok', MY_CHAT_ID, '/menu@CDTGuardBot')
        self.assertTrue(self.sent, '带 @后缀 的命令应能识别')

    def test_未知命令给提示(self):
        bot.handle_command(self.config, 'tok', MY_CHAT_ID, '/xyzzy')
        self.assertTrue(self.sent)
        self.assertIn('help', self.sent[0].text.lower())

    # ---------------- 文本内容安全 ----------------
    def test_机器名特殊字符被清洗(self):
        """机器名里的下划线/星号会让 Markdown 解析失败，必须清洗。"""
        text = bot.build_status(self.config)
        # sanitize 会把 _ * ` [ ] 替换成空格
        self.assertNotIn('_主_', text, '下划线未被清洗，会导致 Telegram 解析失败')

    def test_状态文本包含两台机器(self):
        text = bot.build_status(self.config)
        self.assertIn('香港', text)
        self.assertIn('菲律宾', text)

    def test_流量文本包含免费额度(self):
        text = bot.build_traffic(self.config)
        self.assertIn('免费额度', text)
        self.assertIn('200', text, '菲律宾属非中国内地，额度应为 200GB')


if __name__ == '__main__':
    unittest.main(verbosity=2)
