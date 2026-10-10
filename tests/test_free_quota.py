# -*- coding: utf-8 -*-
"""免费额度与地域判断测试

核心事实（阿里云官方规则）：
  CDT 免费额度按**账号**统一计算，所有接入产品共享：
    中国内地地域  20 GB/月
    非中国内地地域 200 GB/月
    合计 220 GB/月

特别注意：接口返回的 HighestTraffic（10TiB）是**计费阶梯第一档上界**，
**不是免费额度**。这个混淆点会导致严重高估可用流量。
"""
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, 'src'))

import aliyun_api  # noqa: E402

PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print('  [通过] %s' % name)
    else:
        FAILED.append((name, detail))
        print('  [失败] %s  %s' % (name, detail))


def main():
    print('=== 用例 1：非中国内地地域 → 免费额度 200GB ===')
    overseas = [
        ('ap-southeast-6', '菲律宾(马尼拉)'),
        ('ap-southeast-1', '新加坡'),
        ('ap-southeast-3', '马来西亚'),
        ('ap-southeast-5', '印尼'),
        ('ap-southeast-7', '泰国'),
        ('ap-northeast-1', '日本东京'),
        ('ap-northeast-2', '韩国首尔'),
        ('us-west-1', '美国硅谷'),
        ('us-east-1', '美国弗吉尼亚'),
        ('eu-central-1', '德国'),
        ('eu-west-1', '英国'),
        ('cn-hongkong', '中国香港（属非内地）'),
    ]
    for rid, label in overseas:
        q = aliyun_api.get_free_quota_gb(rid)
        check('%s → 200GB' % label, q == 200.0, '实际 %r' % q)

    print('\n=== 用例 2：中国内地地域 → 免费额度 20GB ===')
    mainland = [
        ('cn-hangzhou', '杭州'), ('cn-shanghai', '上海'),
        ('cn-beijing', '北京'), ('cn-shenzhen', '深圳'),
        ('cn-guangzhou', '广州'), ('cn-chengdu', '成都'),
        ('cn-zhangjiakou', '张家口'),
    ]
    for rid, label in mainland:
        q = aliyun_api.get_free_quota_gb(rid)
        check('%s → 20GB' % label, q == 20.0, '实际 %r' % q)

    print('\n=== 用例 3：is_overseas_region 判断正确 ===')
    check('菲律宾属非内地', aliyun_api.is_overseas_region('ap-southeast-6') is True)
    check('杭州属内地', aliyun_api.is_overseas_region('cn-hangzhou') is False)
    check('香港属非内地', aliyun_api.is_overseas_region('cn-hongkong') is True)
    check('空地域不误判', aliyun_api.is_overseas_region('') is False)
    check('大小写不敏感',
          aliyun_api.is_overseas_region('AP-SOUTHEAST-6') is True)

    print('\n=== 用例 4：常量本身正确 ===')
    check('非内地常量 = 200', aliyun_api.FREE_QUOTA_OVERSEAS_GB == 200.0)
    check('内地常量 = 20', aliyun_api.FREE_QUOTA_MAINLAND_GB == 20.0)

    print('\n=== 用例 5：10TiB 阶梯上界 ≠ 免费额度（防混淆回归）===')
    tier_bytes = 10995116277760  # 接口实际返回的第一档上界
    tier_gb = tier_bytes / (1024 ** 3)
    check('10TiB 换算应为 10240GB', abs(tier_gb - 10240) < 1, '实际 %.2f' % tier_gb)
    check('它绝不能被当成免费额度',
          abs(tier_gb - aliyun_api.FREE_QUOTA_OVERSEAS_GB) > 1000,
          '若相等说明又把两者搞混了')
    check('免费额度远小于阶梯上界',
          aliyun_api.FREE_QUOTA_OVERSEAS_GB < tier_gb)

    print('\n' + '=' * 46)
    print('通过 %d 项，失败 %d 项' % (len(PASSED), len(FAILED)))
    if FAILED:
        for n, d in FAILED:
            print('  × %s  %s' % (n, d))
        print('=== 存在失败用例 ===')
        return 1
    print('=== 免费额度判定测试全部通过 ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
