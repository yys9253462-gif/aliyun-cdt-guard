# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 每日报表
============================
每天早上 9 点发送，逐台汇总：状态 / 公网 IP / 规格 / 流量占用 / 本月账单 / 账户余额。
同一账号下多台实例的余额只查一次，避免重复请求浪费额度。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import common
import aliyun_api
from notifier import send_report

LOG = common.build_logger('cdt_report', os.path.join(common.BASE_DIR, 'report.log'), stream=True)


def _traffic_line(traffic_gb, quota):
    if traffic_gb < 0:
        return '查询失败', 0.0
    percent = (traffic_gb / quota * 100) if quota > 0 else 0.0
    return '%.2f GB (阈值的 %.1f%%)' % (traffic_gb, percent), percent


def _free_quota_line(traffic_gb, region):
    """生成「免费额度」提示行 —— 让老大清楚距离开始收费还有多少。"""
    if traffic_gb < 0:
        return None, ''
    free_gb = aliyun_api.get_free_quota_gb(region)
    area = '非中国内地' if aliyun_api.is_overseas_region(region) else '中国内地'
    remain = free_gb - traffic_gb
    if remain >= 0:
        tip = '免费额度剩 %.2f GB' % remain
        return '  免费额度: %.0f GB/月（%s）→ %s' % (free_gb, area, tip), 'ok'
    return ('  免费额度: %.0f GB/月（%s）→ 已超出 %.2f GB，超出部分开始计费'
            % (free_gb, area, -remain)), 'over'


def _money(amount, currency, default_symbol='$'):
    if amount is None or amount < 0:
        return '查询失败'
    symbol = {'CNY': '\u00a5', 'USD': '$'}.get(currency, default_symbol)
    return '%s%.2f' % (symbol, amount)


def build_report(config):
    users = config.get('users', [])
    lines = ['[阿里云 CDT 流量守护 - 每日报表]', '日期: %s' % common.now_local().strftime('%Y-%m-%d'), '']

    balance_cache = {}

    for user in users:
        name = (user.get('name') or '').strip() or user.get('instance_id', 'Unknown')
        instance_id = user.get('instance_id', '').strip()
        region = user.get('region', '').strip()
        resource_group = (user.get('resgroup') or '').strip()
        quota = float(user.get('traffic_limit', 180))

        if user.get('paused'):
            lines.append('* %s\n  监控: 已暂停' % common.sanitize(name))
            lines.append('')
            continue

        ak, sk = user['ak'].strip(), user['sk'].strip()

        # 1. 流量
        try:
            traffic_gb = aliyun_api.get_cdt_traffic_gb(ak, sk, region)
        except Exception as error:
            LOG.warning('[%s] 流量查询失败: %s', name, common.redact(error))
            traffic_gb = -1

        # 2. 实例详情
        detail = aliyun_api.get_instance_detail(ak, sk, region, instance_id, resource_group)

        # 3. 本月账单
        bill_amount, bill_currency = aliyun_api.get_instance_bill(
            ak, sk, region, instance_id, user.get('bill_endpoint', ''))

        # 4. 账户余额（同 AK 复用缓存）
        if ak not in balance_cache:
            balance_cache[ak] = aliyun_api.get_account_balance(
                ak, sk, region, user.get('bill_endpoint', ''))
        balance_amount, balance_currency = balance_cache[ak]

        traffic_str, percent = _traffic_line(traffic_gb, quota)

        if traffic_gb < 0:
            verdict = '流量查询异常'
        elif traffic_gb > quota:
            verdict = '流量已超标，已止损'
        elif percent >= 80:
            verdict = '流量接近阈值，注意'
        else:
            verdict = '正常'

        status_icon = {'Running': '运行中', 'Stopped': '已停止'}.get(detail['status'], detail['status'])

        lines.append('* %s (%s)' % (common.sanitize(name), detail['spec']))
        lines.append('  状态: %s' % status_icon)
        lines.append('  公网IP: %s' % detail['ip'])
        lines.append('  流量: %s / 阈值 %.0fGB' % (traffic_str, quota))
        free_line, free_state = _free_quota_line(traffic_gb, region)
        if free_line:
            lines.append(free_line)
        lines.append('  本月账单: %s' % _money(bill_amount, bill_currency, user.get('currency', '$')))
        lines.append('  账户余额: %s' % _money(balance_amount, balance_currency, user.get('currency', '$')))
        lines.append('  评价: %s' % verdict)
        lines.append('')

    lines.append('提示: 流量达到阈值会自动关机止损，次月流量重置后自动开机。')
    return '\n'.join(lines)


def main():
    config = common.load_config(LOG)
    message = build_report(config)
    LOG.info('报表内容:\n%s', message)
    send_report(config, message, LOG)


if __name__ == '__main__':
    main()
