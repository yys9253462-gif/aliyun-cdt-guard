# -*- coding: utf-8 -*-
"""
新增推送项的触发逻辑测试
========================
覆盖三项新告警：免费额度进度提醒、状态变化推送、余额 / 账单告警。

测试策略：
    不真连阿里云。把 aliyun_api 的查询函数替换成假函数，
    把 send_alert 替换成「记录调用」的假函数，
    然后直接调 guard 里的私有函数，断言「该发的时候发了、不该发的时候没发」。

    关键要覆盖的坏情况（这些才是真会出问题的）：
      · 首次见到机器不该报「状态变化」（否则刚装完就一堆噪音）
      · 95% 档位发过了，就不该再补发 80% 的
      · 同一档位在冷却期内不该重复发
      · 流量查询失败（-1）时不该报额度进度（会算出负数百分比）
      · 余额为 None（查询失败）时不该误报「余额过低」
      · 冷却时间没到时不该重复发
"""
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

# guard / common 在导入时就会建日志文件并写入 BASE_DIR（默认 /opt/cdt-guard），
# 这个路径在 Windows 上不存在，会直接抛 FileNotFoundError。
# 所以在导入任何业务模块之前，先把工作目录指到一个临时目录。
_TEST_DIR = tempfile.mkdtemp(prefix='cdt-guard-test-')
os.environ['CDT_GUARD_DIR'] = _TEST_DIR

# ---------------------------------------------------------------------------
# 阿里云 SDK 桩模块
# ---------------------------------------------------------------------------
# 为什么需要：guard 模块导入时会连带导入阿里云 SDK，而本机（也是大部分
# 开发环境）没装。但这套测试根本不碰网络 —— 所有接口函数都会被替换掉，
# 所以只需要让「导入」这一步能过就行。造一个空的包结构顶上，比装几百 MB
# 依赖干净得多，也让测试能在任何机器上跑。
def _install_sdk_stubs():
    if 'aliyunsdkcore' in sys.modules:
        return

    modules = {}
    names = [
        'aliyunsdkcore',
        'aliyunsdkcore.client',
        'aliyunsdkcore.request',
        'aliyunsdkcore.vendored',
        'aliyunsdkcore.vendored.requests',
        'aliyunsdkcore.vendored.requests.packages',
        'aliyunsdkcore.vendored.requests.packages.urllib3',
        'aliyunsdkcore.vendored.requests.packages.urllib3.util',
        'aliyunsdkcore.vendored.requests.packages.urllib3.util.ssl_',
        'aliyunsdkecs',
        'aliyunsdkecs.request',
        'aliyunsdkecs.request.v20140526',
        'aliyunsdkecs.request.v20140526.StartInstanceRequest',
        'aliyunsdkecs.request.v20140526.StopInstanceRequest',
        'aliyunsdkecs.request.v20140526.RebootInstanceRequest',
        'aliyunsdkecs.request.v20140526.DescribeInstancesRequest',
    ]
    for name in names:
        modules[name] = types.ModuleType(name)

    # 需要用到的类：给个能接受任意参数的占位实现
    class _Placeholder:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, item):
            return lambda *a, **k: None

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

    # 建立父子关系
    for name, mod in modules.items():
        if '.' in name:
            parent_name, child = name.rsplit('.', 1)
            setattr(modules[parent_name], child, mod)
    for name, mod in modules.items():
        sys.modules[name] = mod


_install_sdk_stubs()

import common
import guard
import aliyun_api


# ---------------------------------------------------------------------------
# 测试替身
# ---------------------------------------------------------------------------
class AlertRecorder:
    """记录所有 send_alert 调用，替代真实的网络发送。"""

    def __init__(self):
        self.calls = []

    def __call__(self, config, title, message, level='info', logger=None):
        self.calls.append({'title': title, 'message': message, 'level': level})
        return True

    def titles(self):
        return [c['title'] for c in self.calls]

    def has(self, keyword):
        return any(keyword in t for t in self.titles())

    def reset(self):
        self.calls = []


class FakeLogger:
    def debug(self, *a, **k): pass
    def info(self, *a, **k): pass
    def warning(self, *a, **k): pass
    def error(self, *a, **k): pass
    def exception(self, *a, **k): pass


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.recorder = AlertRecorder()
        # 替换告警出口
        self._original_alert = guard.send_alert
        guard.send_alert = self.recorder
        # 替换日志器，避免往磁盘写
        self._original_log = guard.LOG
        guard.LOG = FakeLogger()
        self.state = {}
        self.config = {'telegram': {'bot_token': 'x', 'chat_id': '1'}}
        self.user = {
            'name': '测试机',
            'ak': 'ak', 'sk': 'sk',
            'region': 'ap-southeast-6',      # 菲律宾，非中国内地，免费额度 200GB
            'instance_id': 'i-test001',
            'traffic_limit': 180,
            'balance_limit': 10,
            'bill_limit': 0,
            'currency': '$',
        }

    def tearDown(self):
        guard.send_alert = self._original_alert
        guard.LOG = self._original_log


# ---------------------------------------------------------------------------
# 免费额度进度提醒
# ---------------------------------------------------------------------------
class TestQuotaProgress(BaseCase):
    def _set_traffic(self, gb):
        self._original_traffic = aliyun_api.get_cdt_traffic_gb
        aliyun_api.get_cdt_traffic_gb = lambda ak, sk, region: gb

    def tearDown(self):
        if hasattr(self, '_original_traffic'):
            aliyun_api.get_cdt_traffic_gb = self._original_traffic
        super().tearDown()

    def test_低于八成不提醒(self):
        """用量 100GB / 额度 200GB = 50%，不该有任何提醒。"""
        self._set_traffic(100.0)
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', 100.0, 'ap-southeast-6')
        self.assertEqual(self.recorder.calls, [])

    def test_达到八成提醒一次(self):
        """用量 165GB / 200GB = 82.5%，应触发 80% 档位提醒。"""
        self._set_traffic(165.0)
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', 165.0, 'ap-southeast-6')
        self.assertTrue(self.recorder.has('即将用尽'),
                        '应触发「免费额度即将用尽」，实际：%s' % self.recorder.titles())

    def test_达到九成五级别更高(self):
        """用量 192GB / 200GB = 96%，应触发 danger 级提醒。"""
        self._set_traffic(192.0)
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', 192.0, 'ap-southeast-6')
        levels = [c['level'] for c in self.recorder.calls]
        self.assertIn('danger', levels, '95% 档位应为 danger 级别')

    def test_超出额度提示用尽(self):
        """用量 210GB，已超出 200GB 免费额度。"""
        self._set_traffic(210.0)
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', 210.0, 'ap-southeast-6')
        self.assertTrue(any('用尽' in c['title'] for c in self.recorder.calls))

    def test_冷却期内不重复提醒(self):
        """连调两次，第二次应被冷却挡住。"""
        self._set_traffic(192.0)
        for _ in range(3):
            guard._check_quota_progress(self.user, self.config, self.state,
                                        '测试机', 'i-test001', 192.0, 'ap-southeast-6')
        # 80% 和 95% 各最多一条
        self.assertLessEqual(len(self.recorder.calls), 2,
                             '冷却期内不应重复发送，实际发了 %d 条'
                             % len(self.recorder.calls))

    def test_流量查询失败不提醒(self):
        """流量 -1 表示查询失败，不该算出奇怪的百分比去报警。"""
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', -1, 'ap-southeast-6')
        self.assertEqual(self.recorder.calls, [])

    def test_中国内地额度是二十GB(self):
        """内地地域 20GB 额度，用量 17GB 应该已过 80%。"""
        self.user['region'] = 'cn-hangzhou'
        gb = 17.0                       # 17/20 = 85%
        guard._check_quota_progress(self.user, self.config, self.state,
                                    '测试机', 'i-test001', gb, 'cn-hangzhou')
        self.assertTrue(self.recorder.calls, '内地 85% 应触发提醒')
        self.assertIn('20 GB', self.recorder.calls[0]['message'])


# ---------------------------------------------------------------------------
# 状态变化推送
# ---------------------------------------------------------------------------
class TestStatusChange(BaseCase):
    def test_首次见到不报警(self):
        """第一次见到机器只记录状态，不报警（避免刚装完满屏噪音）。"""
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Running')
        self.assertEqual(self.recorder.calls, [])
        self.assertEqual(self.state['i-test001']['last_status'], 'Running')

    def test_运行转停止要报警(self):
        """运行中 -> 已停止，这是业务受影响的方向，必须报。"""
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Running')
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Stopped')
        self.assertTrue(self.recorder.has('实例已停止'),
                        '应报「实例已停止」，实际：%s' % self.recorder.titles())

    def test_停止转运行不报警(self):
        """已停止 -> 运行中由「已恢复运行」负责，这里不该重复报。"""
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Stopped')
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Running')
        self.assertEqual(self.recorder.calls, [])

    def test_状态不变不报警(self):
        """状态一直是运行中，不该报任何东西。"""
        for _ in range(3):
            guard._track_status_change(self.user, self.config, self.state,
                                       '测试机', 'i-test001', 'Running')
        self.assertEqual(self.recorder.calls, [])

    def test_冷却期内不重复报警(self):
        """来回切换也不该刷屏。"""
        guard._track_status_change(self.user, self.config, self.state,
                                   '测试机', 'i-test001', 'Running')
        for _ in range(5):
            guard._track_status_change(self.user, self.config, self.state,
                                       '测试机', 'i-test001', 'Stopped')
            guard._track_status_change(self.user, self.config, self.state,
                                       '测试机', 'i-test001', 'Running')
        self.assertLessEqual(len(self.recorder.calls), 1,
                             '冷却期内最多一条，实际 %d 条' % len(self.recorder.calls))


# ---------------------------------------------------------------------------
# 余额 / 账单告警
# ---------------------------------------------------------------------------
class TestMoneyAlerts(BaseCase):
    def _set_balance(self, amount, currency='USD'):
        self._original_balance = aliyun_api.get_account_balance
        aliyun_api.get_account_balance = lambda *a, **k: (amount, currency)

    def _set_bill(self, amount, currency='USD'):
        self._original_bill = aliyun_api.get_instance_bill
        aliyun_api.get_instance_bill = lambda *a, **k: (amount, currency)

    def tearDown(self):
        if hasattr(self, '_original_balance'):
            aliyun_api.get_account_balance = self._original_balance
        if hasattr(self, '_original_bill'):
            aliyun_api.get_instance_bill = self._original_bill
        super().tearDown()

    def test_余额充足不报警(self):
        self._set_balance(100.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_余额过低报警(self):
        self._set_balance(5.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertTrue(self.recorder.has('余额过低'))

    def test_余额为负报欠费(self):
        self._set_balance(-3.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertTrue(self.recorder.has('欠费'))
        self.assertEqual(self.recorder.calls[0]['level'], 'danger')

    def test_余额查询失败不误报(self):
        """查不到余额（None）时绝不能报「余额过低」，否则天天误报。"""
        self._set_balance(None)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_余额告警可关闭(self):
        """balance_limit 填 0 表示关闭这项提醒。"""
        self.user['balance_limit'] = 0
        self._set_balance(-5.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_账单超支报警(self):
        self._set_balance(100.0)
        self.user['bill_limit'] = 5.0
        self._set_bill(8.5)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertTrue(self.recorder.has('账单超支'))

    def test_账单未超不报警(self):
        self._set_balance(100.0)
        self.user['bill_limit'] = 50.0
        self._set_bill(8.5)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_账单告警默认关闭(self):
        """bill_limit 默认 0，不该报警。"""
        self._set_balance(100.0)
        self._set_bill(999.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_账单查询失败不误报(self):
        self._set_balance(100.0)
        self.user['bill_limit'] = 5.0
        self._set_bill(-1)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(self.recorder.calls, [])

    def test_冷却期内不重复(self):
        self._set_balance(1.0)
        for _ in range(5):
            guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertEqual(len(self.recorder.calls), 1,
                         '冷却期内只应发一条，实际 %d 条' % len(self.recorder.calls))

    def test_余额与账单可同时触发(self):
        """两个都在警戒线内，各自发一条。"""
        self._set_balance(3.0)
        self.user['bill_limit'] = 5.0
        self._set_bill(9.0)
        guard._check_money(self.user, self.config, self.state, '测试机', 'i-test001')
        self.assertTrue(self.recorder.has('余额过低'))
        self.assertTrue(self.recorder.has('账单超支'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
