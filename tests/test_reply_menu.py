# -*- coding: utf-8 -*-
"""
回复键盘（底部菜单）逻辑测试
============================
测什么：
    新版菜单用的是「回复键盘」——按钮点一下等于替你发一条文字消息。
    这意味着**界面文案和匹配逻辑必须严格一致**，一旦有一边改了另一边没改，
    按钮就会点了没反应。这类 bug 不报错、不崩溃，只有人工点了才发现，
    所以必须用测试把「文案 <-> 动作」的对应关系钉死。

覆盖四类：
    1. 文案表自身：所有标签非空、互不重复、不含英文字母（老大要求全中文）。
    2. 菜单结构：一级 6 行 × 2 列、二级含所有机器、三级随暂停状态变化。
    3. 文字翻译：点每个按钮文字，都要走对分支且不抛异常。
    4. 三级菜单：必须记住「最近选中的机器」，否则开关机会张冠李戴。
"""
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

_TEST_DIR = tempfile.mkdtemp(prefix='cdt-replymenu-test-')
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

import menu_labels as L
import bot_listener as bot


MY_CHAT_ID = 7912011729
OTHER_CHAT_ID = 999999999


class SentMenu:
    def __init__(self, chat_id, text, rows):
        self.chat_id = chat_id
        self.text = text
        self.rows = rows


class TestReplyMenu(unittest.TestCase):
    def setUp(self):
        self.menus = []
        self.texts = []
        self.start_calls = []
        self.stop_calls = []
        self.hidden = []
        self.config = {
            'telegram': {'bot_token': '123:ABC', 'chat_id': str(MY_CHAT_ID)},
            'users': [
                {'name': '香港节点', 'ak': 'ak1', 'sk': 'sk1',
                 'region': 'cn-hongkong', 'instance_id': 'i-hk0000000000000001',
                 'traffic_limit': 180, 'balance_limit': 10.0, 'paused': False},
                {'name': '菲律宾节点', 'ak': 'ak2', 'sk': 'sk2',
                 'region': 'ap-southeast-6', 'instance_id': 'i-ph0000000000000002',
                 'traffic_limit': 180, 'balance_limit': 10.0, 'paused': True},
            ],
        }

        self._orig_send = bot.send_text
        self._orig_send_menu = bot.send_menu
        self._orig_hide = bot.hide_menu
        self._orig_answer = bot.answer_callback

        bot.send_text = lambda token, chat_id, text, keyboard=None: (
            self.texts.append(text) or True)
        bot.send_menu = lambda token, chat_id, text, rows, placeholder='': (
            self.menus.append(SentMenu(chat_id, text, rows)) or True)
        bot.hide_menu = lambda token, chat_id, text='': (
            self.hidden.append(True) or True)
        bot.answer_callback = lambda token, cid, text='': None

        self._orig_start = bot.do_start
        self._orig_stop = bot.do_stop
        self._orig_toggle = bot.toggle_pause
        self._orig_batch = bot.do_batch_power
        bot.do_start = lambda cfg, iid: (self.start_calls.append(iid) or '已下发起开机')
        bot.do_stop = lambda cfg, iid: (self.stop_calls.append(iid) or '已下发起关机')

        import aliyun_api
        self._orig_status = aliyun_api.get_instance_status
        self._orig_traffic = aliyun_api.get_cdt_traffic_gb
        self._orig_balance = aliyun_api.get_account_balance
        self._orig_bill = aliyun_api.get_instance_bill
        aliyun_api.get_instance_status = lambda *a, **k: 'Running'
        aliyun_api.get_cdt_traffic_gb = lambda *a, **k: 100.0
        aliyun_api.get_account_balance = lambda *a, **k: (0.0, 'USD')
        aliyun_api.get_instance_bill = lambda *a, **k: (0.0, 'USD')

        import common
        self._orig_save = common.save_config
        common.save_config = lambda cfg: None

        class _L:
            def debug(self, *a, **k): pass
            def info(self, *a, **k): pass
            def warning(self, *a, **k): pass
            def error(self, *a, **k): pass
            def exception(self, *a, **k): pass

        self._orig_log = bot.LOG
        bot.LOG = _L()
        bot._CURRENT_DEVICE.clear()

    def tearDown(self):
        bot.send_text = self._orig_send
        bot.send_menu = self._orig_send_menu
        bot.hide_menu = self._orig_hide
        bot.answer_callback = self._orig_answer
        bot.do_start = self._orig_start
        bot.do_stop = self._orig_stop
        bot.toggle_pause = self._orig_toggle
        bot.do_batch_power = self._orig_batch
        import aliyun_api
        aliyun_api.get_instance_status = self._orig_status
        aliyun_api.get_cdt_traffic_gb = self._orig_traffic
        aliyun_api.get_account_balance = self._orig_balance
        aliyun_api.get_instance_bill = self._orig_bill
        import common
        common.save_config = self._orig_save
        bot.LOG = self._orig_log
        bot._CURRENT_DEVICE.clear()

    # ---------------- 文案表自身 ----------------
    def test_所有标签非空(self):
        labels = [v for k, v in vars(L).items()
                  if k.startswith('LBL_') and isinstance(v, str)]
        self.assertTrue(labels)
        for lbl in labels:
            self.assertTrue(lbl.strip(), '存在空标签')

    def test_一级标签不重复(self):
        """重复会导致点了按钮匹配到错误分支（先匹配到的赢）。"""
        labels = [L.LBL_OVERVIEW, L.LBL_TRAFFIC, L.LBL_STATUS, L.LBL_REPORT,
                  L.LBL_WEEKLY, L.LBL_BALANCE, L.LBL_START_ALL, L.LBL_STOP_ALL,
                  L.LBL_DEVICES, L.LBL_RUN, L.LBL_HELP, L.LBL_HIDE]
        self.assertEqual(len(labels), len(set(labels)), '一级菜单标签有重复')

    def test_标签不含英文字母(self):
        """老大要求界面全中文，一个英文字母都不能露。"""
        labels = [v for k, v in vars(L).items()
                  if k.startswith('LBL_') and isinstance(v, str)]
        for lbl in labels:
            for ch in lbl:
                self.assertFalse(
                    ('a' <= ch <= 'z') or ('A' <= ch <= 'Z'),
                    '标签 %r 里出现了英文字母 %r' % (lbl, ch))

    def test_match_main_同时接受带图标与纯文字(self):
        self.assertTrue(L.match_main(L.LBL_TRAFFIC, L.LBL_TRAFFIC))
        self.assertTrue(L.match_main('流量额度', L.LBL_TRAFFIC),
                        '去掉 emoji 手打也应能识别')
        self.assertFalse(L.match_main('别的什么', L.LBL_TRAFFIC))

    def test_实例按钮可反查名字(self):
        btn = L.build_device_button('香港节点')
        self.assertEqual(L.parse_device_button(btn), '香港节点')

    def test_暂停机器按钮带标记(self):
        btn = L.build_device_button('香港节点', paused=True)
        self.assertIn('\u23f8', btn, '暂停的机器应有标记')
        # 标记不影响反查
        self.assertEqual(L.parse_device_button(btn), '香港节点')

    def test_超长机器名被截断(self):
        btn = L.build_device_button('这是一个非常非常非常长的机器名字')
        self.assertLessEqual(len(L.parse_device_button(btn)), L.DEVICE_NAME_MAX)

    # ---------------- 菜单结构 ----------------
    def test_主菜单是6行2列(self):
        rows = bot.main_menu_rows()
        self.assertEqual(len(rows), 6, '主菜单应为 6 行')
        for row in rows:
            self.assertEqual(len(row), 2, '主菜单每行应为 2 列')

    def test_一行不超过3个(self):
        """Telegram 回复键盘一行最多 3 个，超过会被静默截断。"""
        for row in bot.main_menu_rows():
            self.assertLessEqual(len(row), 3)
        for row in bot.device_action_rows({'paused': False}):
            self.assertLessEqual(len(row), 3)

    def test_实例列表含所有机器与返回(self):
        rows = bot.device_menu_rows(self.config)
        flat = [item for row in rows for item in row]
        self.assertTrue(any('香港节点' in t for t in flat))
        self.assertTrue(any('菲律宾节点' in t for t in flat))
        self.assertIn(L.LBL_BACK_MAIN, flat, '实例列表必须有返回主菜单')

    def test_三级菜单暂停状态影响按钮(self):
        running = bot.device_action_rows({'paused': False})
        paused = bot.device_action_rows({'paused': True})
        flat_running = [t for row in running for t in row]
        flat_paused = [t for row in paused for t in row]
        self.assertIn(L.LBL_DEV_PAUSE, flat_running)
        self.assertIn(L.LBL_DEV_RESUME, flat_paused)

    def test_主菜单含周报与余额两项(self):
        flat = [t for row in bot.main_menu_rows() for t in row]
        self.assertIn(L.LBL_WEEKLY, flat, '主菜单应有周报')
        self.assertIn(L.LBL_BALANCE, flat, '主菜单应有余额详情')

    # ---------------- 文字翻译 ----------------
    def _send(self, text, chat_id=MY_CHAT_ID):
        bot.handle_plain_text(self.config, 'tok', chat_id, text)

    def test_点总览有回复(self):
        self._send(L.LBL_OVERVIEW)
        self.assertTrue(self.texts, '点总览应有回复')

    def test_点流量额度有回复(self):
        self._send(L.LBL_TRAFFIC)
        self.assertTrue(self.texts)

    def test_点实例状态有回复(self):
        self._send(L.LBL_STATUS)
        self.assertTrue(self.texts)

    def test_点周报有回复(self):
        self._send(L.LBL_WEEKLY)
        self.assertTrue(self.texts)
        self.assertTrue(any('周报' in t for t in self.texts))

    def test_点余额详情有回复(self):
        self._send(L.LBL_BALANCE)
        self.assertTrue(self.texts, '点余额详情应有回复（含查询中提示）')

    def test_点单机操作出实例列表(self):
        self._send(L.LBL_DEVICES)
        self.assertTrue(self.menus, '点单机操作应弹出实例列表')
        self.assertIn(L.LBL_BACK_MAIN,
                      [t for row in self.menus[-1].rows for t in row])

    def test_点帮助有回复(self):
        self._send(L.LBL_HELP)
        self.assertTrue(self.texts)

    def test_点收起菜单真的收起(self):
        self._send(L.LBL_HIDE)
        self.assertTrue(self.hidden, '点收起菜单应调用收起动作')

    def test_点返回主菜单出主菜单(self):
        self._send(L.LBL_BACK_MAIN)
        self.assertTrue(self.menus)
        self.assertEqual(self.menus[-1].rows, bot.main_menu_rows())

    def test_未知文字给主菜单提示(self):
        """乱打字不能装作没看见，要给出菜单。"""
        self._send('随便打的一段话')
        self.assertTrue(self.menus, '未知输入应回一个菜单')

    # ---------------- 三级菜单：必须记住选中的机器 ----------------
    def test_选中机器后能查它的状态(self):
        self._send(L.build_device_button('香港节点'))
        self.assertTrue(self.menus, '点机器应进三级菜单')
        self.texts.clear()
        self._send(L.LBL_DEV_STATUS)
        self.assertTrue(any('香港节点' in t for t in self.texts),
                        '状态应查的是刚刚选中的机器，实际消息：%s' % self.texts)

    def test_选中机器后开机作用于该机器(self):
        self._send(L.build_device_button('香港节点'))
        self._send(L.LBL_DEV_START)
        self.assertEqual(self.start_calls, ['i-hk0000000000000001'],
                         '开机必须作用在选中的那台机器上')

    def test_切换选中机器后开机作用于新机器(self):
        """这是最容易出错的地方：换了机器还去操作上一台。"""
        self._send(L.build_device_button('香港节点'))
        self._send(L.LBL_BACK_LIST)
        self._send(L.build_device_button('菲律宾节点'))
        self._send(L.LBL_DEV_START)
        self.assertEqual(self.start_calls, ['i-ph0000000000000002'],
                         '换了机器后必须操作新的那台')

    def test_未选机器时点开机不乱操作(self):
        """没选机器就点「开机」这种按钮，绝不能瞎开机。"""
        self._send(L.LBL_DEV_START)
        self.assertEqual(self.start_calls, [], '没选机器不能执行开机')

    def test_三级菜单里关机走对分支(self):
        self._send(L.build_device_button('香港节点'))
        self._send(L.LBL_DEV_STOP)
        self.assertEqual(self.stop_calls, ['i-hk0000000000000001'])

    def test_三级菜单所有按钮都不抛异常(self):
        self._send(L.build_device_button('香港节点'))
        for row in bot.device_action_rows({'paused': False}):
            for btn in row:
                try:
                    self._send(btn)
                except Exception as error:
                    self.fail('三级按钮 %r 抛异常: %s' % (btn, error))

    def test_主菜单所有按钮都不抛异常(self):
        for row in bot.main_menu_rows():
            for btn in row:
                try:
                    self._send(btn)
                except Exception as error:
                    self.fail('主菜单按钮 %r 抛异常: %s' % (btn, error))

    def test_机器被删掉后点它不崩(self):
        self._send(L.build_device_button('已经不存在的机器'))
        self.assertTrue(self.texts or self.menus, '应有提示而不是卡死')

    # ---------------- 权限 ----------------
    def test_陌生人点按钮被忽略(self):
        """安全底线：走 handle_update 才会做权限校验。"""
        bot.handle_update(self.config, 'tok', {
            'message': {'chat': {'id': OTHER_CHAT_ID}, 'text': L.LBL_STOP_ALL}})
        self.assertEqual(self.texts, [], '陌生人不应收到任何回复')
        self.assertEqual(self.menus, [], '陌生人不应收到菜单')

    def test_本人点批量关机有反馈(self):
        self._send(L.LBL_STOP_ALL)
        self.assertTrue(self.texts or self.menus, '批量关机应有反馈')


if __name__ == '__main__':
    unittest.main(verbosity=2)
