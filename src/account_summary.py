# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 按账号汇总
==============================
把「机器」维度换成「账号」维度重新汇总一次。

为什么需要这个模块：
    免费额度是**按账号**算的，不是按机器算的。
    一个账号下若有 3 台机器，它们**共享**同一份 200GB/月，
    而不是各有一份。所以「每台机器都用掉多少」这个视角是不够的 ——
    三台各用 70GB 看起来都很安全，加起来 210GB 其实已经超了。

    本模块按 AccessKey 把机器分组，逐个账号算出：
        · 这个账号本月总共用了多少流量
        · 免费额度还剩多少 / 超出多少
        · 旗下哪台机器贡献得最多

关键区分（务必读清楚）：
    用的是「按 AK 分组」，不是「按实例分组」。
    同一个主账号下的不同 RAM 子账号，AK 不同但**额度共享**。
    所以严格来说这里算的「账号」= 一个 AK，
    若你给同主账号建了两个子账号，它们会被算成两组，
    这时页面上会额外提醒你「注意：这些 AK 可能属于同一主账号」。

谁在用这个模块：
    · report.py   —— 每天 9 点的报表末尾追加「按账号汇总」
    · bot_listener.py —— 手机菜单「账号汇总」按钮
    两处共用，保证数字一致。改这里两边同时生效。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import aliyun_api


def group_by_account(users):
    """把机器按 AccessKey 分组。

    返回 [( ak, [user, user, ...] ), ...]，保持原有顺序便于阅读。

    注意：同一台机器可能出现在多个 user 条目里（比如同账号下多台实例），
    这里按 AK 精确分组，AK 不同就是两组。
    """
    groups = []
    index = {}
    for user in users:
        ak = (user.get('ak') or '').strip()
        if not ak:
            continue
        if ak not in index:
            index[ak] = len(groups)
            groups.append((ak, []))
        groups[index[ak]][1].append(user)
    return groups


def _mask_ak(ak):
    """把 AK 打码，只留前 6 位。

    为什么要打码：AK 属于敏感信息，报表可能被转发。
    前 6 位足够你自己认出是哪个账号，剩下的遮住不影响辨识。
    """
    ak = (ak or '').strip()
    if len(ak) <= 6:
        return ak or '未填写'
    return ak[:6] + '****'


def _quota_for_group(members):
    """算出这一组共享的免费额度（GB）。

    额度按「地域」区分（内地 20 / 非内地 200），而同一账号下可能
    既有内地机器又有非内地机器。阿里云的规则是**两部分分开计算**：
        中国内地 20GB 一份 + 非中国内地 200GB 一份，互不占用。
    所以这里分别加总，而不是取一个值。
    """
    mainland = 0.0
    overseas = 0.0
    for user in members:
        region = user.get('region', '')
        if aliyun_api.is_overseas_region(region):
            overseas += aliyun_api.get_free_quota_gb(region)
        else:
            mainland += aliyun_api.get_free_quota_gb(region)
    return mainland, overseas


def _traffic_for_group(ak, sk, members):
    """查出这一组账号在本月的流量。

    粒度说明（这是本模块最需要注意的地方）：
        CDT 的 ListCdtInternetTraffic 接口返回的是**整个账号**的用量，
        不是单台实例的用量。所以对同一账号下的多台机器，
        我们只查一次，然后把这份总量记在账号组上，
        **不要**去把每台机器的查询结果相加 —— 那会重复计算 N 倍。
    """
    region = members[0].get('region', '') if members else ''
    try:
        return aliyun_api.get_cdt_traffic_gb(ak, sk, region), None
    except Exception as error:
        return -1.0, error


def summarize_accounts(config, logger=None):
    """按账号汇总。返回结构化数据列表，供报表与菜单渲染。

    每个元素是一个 dict：
        ak_display   打码后的 AK
        names        组内机器名列表
        count        机器台数
        traffic_gb   账号本月总用量（-1 表示查询失败）
        mainland_free / overseas_free   两个池子的免费额度
        error        查询失败时的原因，正常为 None
    """
    users = config.get('users', [])
    result = []

    for ak, members in group_by_account(users):
        sk = (members[0].get('sk') or '').strip()
        mainland_free, overseas_free = _quota_for_group(members)
        traffic_gb, error = _traffic_for_group(ak, sk, members)

        names = []
        for user in members:
            name = (user.get('name') or user.get('instance_id') or '未命名').strip()
            if user.get('paused'):
                name += '（已暂停）'
            names.append(name)

        result.append({
            'ak_display': _mask_ak(ak),
            'names': names,
            'count': len(members),
            'traffic_gb': traffic_gb,
            'mainland_free': mainland_free,
            'overseas_free': overseas_free,
            'error': error,
        })

    return result


def build_summary_text(config, logger=None):
    """生成「按账号汇总」的纯文本段落，报表与菜单共用。

    只统计**未被暂停**的机器占用情况；全部暂停的账号会标注出来，
    避免你看到一堆「0 台在监控」却不知道发生了什么。
    """
    users = config.get('users', [])
    if not users:
        return '当前没有配置任何机器。'

    groups = summarize_accounts(config, logger)
    if not groups:
        return '当前没有配置任何机器。'

    lines = []
    lines.append('*按账号汇总*')
    lines.append('（免费额度按账号计算，同一账号下所有机器共享）')
    lines.append('')

    for info in groups:
        active = [n for n in info['names'] if '已暂停' not in n]
        lines.append('* 账号 %s（%d 台机器）' % (info['ak_display'], info['count']))

        for name in info['names']:
            lines.append('  · %s' % name)

        if info['traffic_gb'] < 0:
            reason = ''
            if info['error'] is not None:
                reason = '（%s）' % str(info['error'])[:60]
            lines.append('  本月用量: 查询失败%s' % reason)
            lines.append('')
            continue

        used = info['traffic_gb']
        lines.append('  账号本月总用量: %.2f GB' % used)

        # 按池子分别展示：内地池 / 非内地池
        if info['overseas_free'] > 0:
            remain = info['overseas_free'] - used
            if remain >= 0:
                lines.append('  非中国内地额度: %.0f GB，已用 %.1f%%，剩 %.2f GB'
                             % (info['overseas_free'],
                                used / info['overseas_free'] * 100, remain))
            else:
                lines.append('  非中国内地额度: %.0f GB，已超出 %.2f GB（正在计费）'
                             % (info['overseas_free'], -remain))
        if info['mainland_free'] > 0:
            remain = info['mainland_free'] - used
            if remain >= 0:
                lines.append('  中国内地额度: %.0f GB，已用 %.1f%%，剩 %.2f GB'
                             % (info['mainland_free'],
                                used / info['mainland_free'] * 100, remain))
            else:
                lines.append('  中国内地额度: %.0f GB，已超出 %.2f GB（正在计费）'
                             % (info['mainland_free'], -remain))

        # 台数提示：同账号多台时给出「均摊」参考，避免各自按满额设阈值
        if info['count'] >= 2 and active:
            pool = max(info['overseas_free'], info['mainland_free'])
            if pool > 0:
                lines.append('  提示: %d 台机器共享这一份额度，'
                             '平均每台约 %.0f GB 才安全'
                             % (info['count'], pool / info['count']))
        lines.append('')

    if len(groups) >= 2:
        lines.append('注意: 上面按 AccessKey 分组。若某两个账号其实是'
                     '同一主账号下的不同子账号，它们的额度实际是共享的，')
        lines.append('请以阿里云控制台的「云数据传输」页面为准。')

    return '\n'.join(lines)
