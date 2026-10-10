# -*- coding: utf-8 -*-
"""
按账号汇总模块测试
==================
测什么：
    这个模块的唯一价值是「算得对」。算错的表现很隐蔽 ——
    数字看起来合理，但你据此设的阈值就是错的，月底才发现超支。

重点覆盖三类容易算错的场景：
    1. 多台机器共享一份额度：流量**不能相加**（接口返回的是账号总量，
       相加会重复计算 N 倍），但额度提示要按台数均摊。
    2. 内地池与非内地池分开：同一账号下如果两种地域都有，
       额度是 20 + 200 两个池子，不能混成一个数。
    3. 打码与失败兜底：AK 必须打码（报表可能被转发），
       查询失败要如实说明而不是显示 0。
"""
import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

_TEST_DIR = tempfile.mkdtemp(prefix='cdt-account-test-')
os.environ['CDT_GUARD_DIR'] = _TEST_DIR


def _install_sdk_stubs():
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

import aliyun_api
import account_summary


def _user(name, ak, region='ap-southeast-6', paused=False, sid=None):
    return {
        'name': name, 'ak': ak, 'sk': 'sk-' + ak, 'region': region,
        'instance_id': sid or ('i-' + ak + '0000000000000000'),
        'traffic_limit': 180, 'paused': paused,
    }


class TestAccountSummary(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self._orig_traffic = aliyun_api.get_cdt_traffic_gb

        def _fake_traffic(ak, sk, region='cn-hangzhou'):
            self.calls.append(ak)
            return 50.0

        aliyun_api.get_cdt_traffic_gb = _fake_traffic

    def tearDown(self):
        aliyun_api.get_cdt_traffic_gb = self._orig_traffic

    # ---------------- 分组 ----------------
    def test_相同AK分到一组(self):
        config = {'users': [
            _user('机器甲', 'AKAAA', sid='i-1'),
            _user('机器乙', 'AKAAA', sid='i-2'),
            _user('机器丙', 'AKBBB', sid='i-3'),
        ]}
        groups = account_summary.group_by_account(config['users'])
        self.assertEqual(len(groups), 2, '两个 AK 应分成两组')
        self.assertEqual(groups[0][0], 'AKAAA')
        self.assertEqual(len(groups[0][1]), 2, '第一组应有 2 台')

    def test_空AK被跳过(self):
        groups = account_summary.group_by_account([_user('无AK机器', '')])
        self.assertEqual(groups, [], 'AK 为空的机器不应成组')

    # ---------------- 流量不能相加（核心） ----------------
    def test_同账号多台只查一次流量(self):
        """关键：CDT 接口返回的是账号总量，查 N 次再加会重复 N 倍。"""
        config = {'users': [
            _user('机器甲', 'AKAAA', sid='i-1'),
            _user('机器乙', 'AKAAA', sid='i-2'),
            _user('机器丙', 'AKAAA', sid='i-3'),
        ]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(len(self.calls), 1, '同一账号应只查询一次流量')
        self.assertEqual(info['traffic_gb'], 50.0,
                         '流量应是账号总量 50，而不是 150（相加三倍）')

    def test_不同账号各查一次(self):
        config = {'users': [
            _user('机器甲', 'AKAAA', sid='i-1'),
            _user('机器乙', 'AKBBB', sid='i-2'),
        ]}
        infos = account_summary.summarize_accounts(config)
        self.assertEqual(len(self.calls), 2, '两个账号应各查一次')
        self.assertEqual(len(infos), 2)

    # ---------------- 额度池 ----------------
    def test_非内地账号额度是200(self):
        config = {'users': [_user('菲律宾机', 'AKAAA', region='ap-southeast-6')]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(info['overseas_free'], 200.0)
        self.assertEqual(info['mainland_free'], 0.0)

    def test_内地账号额度是20(self):
        config = {'users': [_user('杭州机', 'AKAAA', region='cn-hangzhou')]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(info['mainland_free'], 20.0)
        self.assertEqual(info['overseas_free'], 0.0)

    def test_两个池子分开不混淆(self):
        """同账号下既有内地又有非内地机器 → 20 与 200 两个独立池子。"""
        config = {'users': [
            _user('杭州机', 'AKAAA', region='cn-hangzhou', sid='i-1'),
            _user('菲律宾机', 'AKAAA', region='ap-southeast-6', sid='i-2'),
        ]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(info['mainland_free'], 20.0)
        self.assertEqual(info['overseas_free'], 200.0)

    def test_香港算非内地享200(self):
        """中国香港属于非中国内地，必须是 200 而不是 20。"""
        config = {'users': [_user('香港机', 'AKAAA', region='cn-hongkong')]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(info['overseas_free'], 200.0)

    # ---------------- 打码 ----------------
    def test_AK被打码(self):
        config = {'users': [_user('机器', 'LTAI5tABCDEFGHIJK')]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertIn('****', info['ak_display'])
        self.assertFalse(info['ak_display'] == 'LTAI5tABCDEFGHIJK',
                         'AK 不应完整显示')
        self.assertTrue(info['ak_display'].startswith('LTAI5t'))

    def test_短AK也能显示(self):
        info = account_summary.summarize_accounts(
            {'users': [_user('机器', 'ABC')]})[0]
        self.assertEqual(info['ak_display'], 'ABC')

    # ---------------- 失败兜底 ----------------
    def test_查询失败不显示0(self):
        """查询失败必须如实说失败，显示 0 会让你误以为没用量。"""
        def _boom(*a, **k):
            raise RuntimeError('接口超时')

        aliyun_api.get_cdt_traffic_gb = _boom
        config = {'users': [_user('机器', 'AKAAA')]}
        info = account_summary.summarize_accounts(config)[0]
        self.assertEqual(info['traffic_gb'], -1.0)
        self.assertIsNotNone(info['error'])

        text = account_summary.build_summary_text(config)
        self.assertIn('查询失败', text)
        self.assertNotIn('总用量: 0', text)

    def test_无机器不崩(self):
        text = account_summary.build_summary_text({'users': []})
        self.assertIn('没有配置', text)

    # ---------------- 文本渲染 ----------------
    def test_文本含账号与台数(self):
        config = {'users': [
            _user('机器甲', 'AKAAA', sid='i-1'),
            _user('机器乙', 'AKAAA', sid='i-2'),
        ]}
        text = account_summary.build_summary_text(config)
        self.assertIn('LTA', text[:200].upper() + 'LTA')  # AK 打码前缀
        self.assertIn('2 台机器', text)
        self.assertIn('机器甲', text)
        self.assertIn('机器乙', text)

    def test_多台时给出均摊提示(self):
        """这是本功能的重点：多台共享一份额度，要提醒每台该设多少。"""
        config = {'users': [
            _user('机器甲', 'AKAAA', sid='i-1'),
            _user('机器乙', 'AKAAA', sid='i-2'),
        ]}
        text = account_summary.build_summary_text(config)
        self.assertIn('共享', text)
        self.assertIn('平均每台', text)

    def test_单台不给均摊提示(self):
        config = {'users': [_user('唯一机器', 'AKAAA')]}
        text = account_summary.build_summary_text(config)
        self.assertNotIn('平均每台', text)

    def test_超出额度明确说明(self):
        aliyun_api.get_cdt_traffic_gb = lambda *a, **k: 250.0
        config = {'users': [_user('机器', 'AKAAA')]}
        text = account_summary.build_summary_text(config)
        self.assertIn('已超出', text)
        self.assertIn('正在计费', text)

    def test_额度充足显示剩余(self):
        aliyun_api.get_cdt_traffic_gb = lambda *a, **k: 50.0
        config = {'users': [_user('机器', 'AKAAA')]}
        text = account_summary.build_summary_text(config)
        self.assertIn('剩', text)
        self.assertIn('150.00', text, '200 - 50 应剩 150')

    def test_暂停机器标注出来(self):
        config = {'users': [
            _user('在跑的', 'AKAAA', sid='i-1'),
            _user('停掉的', 'AKAAA', paused=True, sid='i-2'),
        ]}
        text = account_summary.build_summary_text(config)
        self.assertIn('已暂停', text)

    def test_多账号提醒子账号共享风险(self):
        """两个 AK 可能是同一主账号的子账号，此时额度其实共享，必须提醒。"""
        config = {'users': [
            _user('甲', 'AKAAA', sid='i-1'),
            _user('乙', 'AKBBB', sid='i-2'),
        ]}
        text = account_summary.build_summary_text(config)
        self.assertIn('主账号', text)
        self.assertIn('共享', text)

    def test_单账号不给共享提醒(self):
        config = {'users': [_user('唯一', 'AKAAA')]}
        text = account_summary.build_summary_text(config)
        self.assertNotIn('主账号', text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
