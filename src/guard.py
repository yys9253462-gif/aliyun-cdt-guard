# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 核心巡检（流量熔断 + 自动恢复）
=================================================
每 5 分钟由定时任务拉起一次，逐个实例执行：

    流量未超标 + 实例已停止  -> 自动开机（恢复业务）
    流量未超标 + 实例运行中  -> 记录日志，什么都不做
    流量已超标 + 实例运行中  -> 强制关机止损
    流量已超标 + 实例已停止  -> 保持关机，每天提醒一次

设计要点：
1. 单实例硬超时：某个实例的接口卡死不会拖垮整轮巡检。
2. 运行锁：上一轮没跑完时，本轮直接跳过，状态不会互相覆盖。
3. 启动失败不放弃：连续失败后降低重试频率（30 分钟一次），而非彻底躺平。
"""
import os
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import common
import aliyun_api
from notifier import send_alert

LOG = common.build_logger('cdt_guard', os.path.join(common.BASE_DIR, 'guard.log'))

# 等待实例进入 Running 的轮询参数
START_WAIT_TIMEOUT = 180
START_POLL_INTERVAL = 10
# 单实例巡检硬超时（覆盖正常的启动等待时间）
USER_CHECK_TIMEOUT = START_WAIT_TIMEOUT + 120
# 连续启动失败达到该次数后，降低重试频率
MAX_START_FAILURES = 3
RESOURCE_RETRY_COOLDOWN = 1800
# 连续巡检失败达到该次数，发出「监控失明」告警
CHECK_FAILURE_ALERT_THRESHOLD = 3
# 硬超时异常：必须穿透业务层的 broad except
USER_CHECK_TIMEOUT_FLAG = 'timeout'

try:
    import fcntl
except ImportError:
    fcntl = None


class CheckTimeout(BaseException):
    """单实例巡检超时信号。"""


def _raise_timeout(_signum, _frame):
    raise CheckTimeout()


def _fmt_balance(user):
    """查询余额并格式化成一行文本；失败返回空串（不影响主流程）。"""
    try:
        amount, currency = aliyun_api.get_account_balance(
            user['ak'], user['sk'], user['region'], user.get('bill_endpoint', ''))
        if amount is None:
            return ''
        symbol = {'CNY': '\u00a5', 'USD': '$'}.get(currency, user.get('currency', '$'))
        line = '\n账户余额: %s%.2f' % (symbol, amount)
        if amount < 0:
            line += ' [已欠费]'
        return line
    except Exception:
        return ''


def _fmt_money(amount, currency, default_symbol='$'):
    """把金额格式化成带货币符号的字符串；无效值返回「查询失败」。"""
    if amount is None or amount < 0:
        return '查询失败'
    symbol = {'CNY': '\u00a5', 'USD': '$'}.get(currency, default_symbol)
    return '%s%.2f' % (symbol, amount)


def _track_status_change(user, config, state, name, key, status, extra=''):
    """监控实例状态变化，从「运行中」掉到「已停止」时立刻推送。

    为什么要单独做这件事：
        巡检每 5 分钟跑一次，而脚本默认行为是「流量安全 + 已停止 = 自动开机」。
        如果实例是被别人（或系统）意外停掉的，自动开机虽然会救回来，
        但如果不告诉你，你根本不知道机器曾经掉线过 —— 可能业务已经受影响。
        所以这里在状态发生「运行中 -> 已停止」的切换那一刻就推一条消息。
    """
    record = state.setdefault(key, {})
    previous = record.get('last_status')

    # 首次见到这台机器只记状态，不报警（否则刚装完就报一堆「开机成功」的噪音）
    if previous is None:
        record['last_status'] = status
        return

    if previous != status:
        record['last_status'] = status
        LOG.info('[%s] 实例状态变化：%s -> %s', name, previous, status)

        # 只在「运行中 -> 已停止」这个方向告警，这是业务受影响的方向。
        # 反方向（已停止 -> 运行中）由 _try_start 的「已恢复运行」负责，不重复。
        if previous == 'Running' and status == 'Stopped':
            event_key = '%s:status_down' % key
            if common.event_allowed(state, event_key, 'status_down', common.NOTIFY_COOLDOWN):
                msg = ('机器: %s\n'
                       '状态变化: 运行中 -> 已停止%s\n'
                       '%s'
                       '如果这不是你主动关的，说明实例被意外停机了。\n'
                       '脚本会按现有规则处理（流量安全时自动开机）。'
                       % (common.sanitize(name), extra,
                          '说明: %s\n' % extra if extra else ''))
                if send_alert(config, '实例已停止', msg, 'warn', LOG):
                    common.mark_event(state, event_key, 'status_down')


def _check_quota_progress(user, config, state, name, key, traffic_gb, region):
    """免费额度进度提醒：用量跨过 80% / 95% 档位时各提醒一次。

    为什么有用：
        止损阈值是「你设的线」，而免费额度是「阿里云的钱包」。
        两者不一定重合 —— 如果阈值设得比免费额度高，你会在阈值内就开始花钱。
        所以在接近免费额度上限时提前打招呼，让你有时间决策。
    """
    if traffic_gb < 0:
        return
    free_gb = aliyun_api.get_free_quota_gb(region)
    if free_gb <= 0:
        return
    percent = traffic_gb / free_gb * 100.0

    for level in common.QUOTA_WARN_LEVELS:
        if percent < level:
            continue
        event_key = '%s:quota_%d' % (key, level)
        # 95% 档位一旦发过，就不再单独发 80% 的（避免同时补发两条）
        if level == 80 and not common.event_allowed(
                state, '%s:quota_95' % key, 'quota_95', common.QUOTA_COOLDOWN):
            break
        if not common.event_allowed(state, event_key, 'quota_%d' % level,
                                    common.QUOTA_COOLDOWN):
            continue
        area = '非中国内地' if aliyun_api.is_overseas_region(region) else '中国内地'
        remain = free_gb - traffic_gb
        msg = ('机器: %s\n'
               '本月已用流量: %.2f GB\n'
               '免费额度: %.0f GB/月（%s）\n'
               '已使用 %.1f%%，剩余 %.2f GB%s'
               % (common.sanitize(name), traffic_gb, free_gb, area, percent, remain,
                  '\n注意: 免费额度已用尽，继续跑将开始产生费用。' if remain <= 0 else ''))
        level_name = '免费额度已用尽' if remain <= 0 else '免费额度即将用尽'
        if send_alert(config, level_name, msg, 'warn' if level < 95 else 'danger', LOG):
            common.mark_event(state, event_key, 'quota_%d' % level)


def _check_money(user, config, state, name, key):
    """余额过低 + 本月账单超支，两个跟钱有关的告警。

    为什么合并在一起写：
        两者都要查财务接口、都要按「账户货币」格式化、冷却时间也一样，
        放一起能共用一次接口查询，少一次请求。
    """
    balance_limit = float(user.get('balance_limit', common.DEFAULT_BALANCE_LIMIT))
    bill_limit = float(user.get('bill_limit', common.DEFAULT_BILL_LIMIT))

    # --- 账户余额 ---
    if balance_limit > 0:
        try:
            amount, currency = aliyun_api.get_account_balance(
                user['ak'], user['sk'], user['region'], user.get('bill_endpoint', ''))
        except Exception:
            amount, currency = None, None

        if amount is not None and amount < balance_limit:
            event_key = '%s:balance_low' % key
            if common.event_allowed(state, event_key, 'balance_low', common.MONEY_COOLDOWN):
                msg = ('机器: %s\n'
                       '当前账户余额: %s\n'
                       '你设定的最低余额: %s\n'
                       '%s'
                       '余额不足会导致实例被停机、快照被释放，请及时充值。'
                       % (common.sanitize(name),
                          _fmt_money(amount, currency, user.get('currency', '$')),
                          _fmt_money(balance_limit, currency, user.get('currency', '$')),
                          '状态: 已欠费！\n' if amount < 0 else ''))
                level = 'danger' if amount < 0 else 'warn'
                title = '账户已欠费' if amount < 0 else '账户余额过低'
                if send_alert(config, title, msg, level, LOG):
                    common.mark_event(state, event_key, 'balance_low')

    # --- 本月账单 ---
    if bill_limit > 0:
        try:
            bill_amount, bill_currency = aliyun_api.get_instance_bill(
                user['ak'], user['sk'], user['region'], user['instance_id'],
                user.get('bill_endpoint', ''))
        except Exception:
            bill_amount, bill_currency = None, None

        if bill_amount is not None and bill_amount >= 0 and bill_amount > bill_limit:
            event_key = '%s:bill_over' % key
            if common.event_allowed(state, event_key, 'bill_over', common.MONEY_COOLDOWN):
                msg = ('机器: %s\n'
                       '本月账单已产生: %s\n'
                       '你设定的警戒线: %s\n'
                       '账单金额已超过警戒线，通常意味着流量已进入付费阶梯，'
                       '或者实例规格 / 磁盘产生了额外费用。\n'
                       '建议去阿里云控制台「费用中心」核对明细。'
                       % (common.sanitize(name),
                          _fmt_money(bill_amount, bill_currency, user.get('currency', '$')),
                          _fmt_money(bill_limit, bill_currency, user.get('currency', '$'))))
                if send_alert(config, '本月账单超支', msg, 'warn', LOG):
                    common.mark_event(state, event_key, 'bill_over')


def check_one(user, config, state):
    """巡检单个实例。"""
    instance_id = user['instance_id']
    name = user.get('name') or instance_id
    key = instance_id
    resource_group = (user.get('resgroup') or '').strip()

    if user.get('paused'):
        LOG.info('[%s] 监控已暂停，跳过', name)
        return

    ak, sk, region = user['ak'], user['sk'], user['region']
    limit_gb = float(user.get('traffic_limit', 180))

    # 安全护栏：若关机阈值高于本月免费额度，则超出的部分会真实产生费用。
    # 每人每账号每月免费额度：非中国内地 200GB、中国内地 20GB。
    # 这种情况必须提醒 —— 否则老大可能误以为「还没到阈值=不花钱」。
    free_gb = aliyun_api.get_free_quota_gb(region)
    if limit_gb > free_gb:
        warn_key = '%s:quota_warn' % key
        if common.event_allowed(state, warn_key, 'quota_warn', common.OVERLIMIT_COOLDOWN):
            msg = ('机器: %s\n'
                   '关机阈值设为 %.0fGB，但本区域免费额度只有 %.0fGB/月。\n'
                   '超出 %.0fGB 的部分会真实产生费用，阈值内也可能在花钱。\n'
                   '建议把阈值设到免费额度以内（例如 %.0fGB）。'
                   % (name, limit_gb, free_gb, limit_gb - free_gb, max(free_gb - 20, 1)))
            LOG.warning('[%s] 阈值 %.0fGB 高于免费额度 %.0fGB，存在付费风险',
                        name, limit_gb, free_gb)
            if send_alert(config, '流量阈值高于免费额度', msg, 'warn', LOG):
                common.mark_event(state, warn_key, 'quota_warn')

    try:
        traffic_gb = aliyun_api.get_cdt_traffic_gb(ak, sk, region)
        status = aliyun_api.get_instance_status(ak, sk, region, instance_id, resource_group)

        if status is None:
            LOG.error('[%s] 未找到实例 %s，请检查实例 ID 与地域是否匹配', name, instance_id)
            return

        # 流量与状态都拿到了，说明监控是「睁眼」的，清掉失败计数
        common.clear_counter(state, key, 'check_failures')

        # ---- 状态变化追踪（运行中 -> 已停止时报警）----
        # 必须在决策之前记录，否则自动开机一执行，就永远看不到「掉线」那一瞬。
        _track_status_change(user, config, state, name, key, status)

        # ---- 免费额度进度提醒（80% / 95%）----
        _check_quota_progress(user, config, state, name, key, traffic_gb, region)

        # ---- 余额 / 账单告警 ----
        _check_money(user, config, state, name, key)

        # ---- 记录流量台账（周报数据源）----
        # 按天去重，同一天只留最新一条，不会把磁盘写爆。
        common.append_traffic_history(instance_id, name, traffic_gb, LOG)

        if traffic_gb < limit_gb:
            if status == 'Stopped':
                _try_start(user, config, state, name, key, traffic_gb)
            elif status == 'Running':
                common.clear_counter(state, key, 'start_failures')
                LOG.info('[%s] 流量安全 %.2fGB / 阈值 %.0fGB，实例运行中', name, traffic_gb, limit_gb)
            else:
                LOG.info('[%s] 实例处于中间态 %s，本轮不干预', name, status)
        else:
            _enforce_stop(user, config, state, name, key, traffic_gb, status, limit_gb)

    except Exception as error:
        _handle_check_failure(state, config, name, key, error)


def _try_start(user, config, state, name, key, traffic_gb):
    """流量安全但实例已停止，自动开机。"""
    failures = state.get(key, {}).get('start_failures', 0)

    if failures >= MAX_START_FAILURES:
        last = state.get(key, {}).get('last_retry_ts', 0)
        elapsed = time.time() - last
        if elapsed < RESOURCE_RETRY_COOLDOWN:
            LOG.info('[%s] 已连续 %d 次开机失败，%d 秒后才会再试，本轮跳过',
                     name, failures, int(RESOURCE_RETRY_COOLDOWN - elapsed))
            return
        LOG.info('[%s] 已连续 %d 次开机失败，冷却结束，再次尝试', name, failures)

    state.setdefault(key, {})['last_retry_ts'] = time.time()

    try:
        aliyun_api.start_instance(user['ak'], user['sk'], user['region'], user['instance_id'])
        LOG.info('[%s] 已下发开机指令，等待进入 Running...', name)
    except Exception as error:
        count = common.bump_counter(state, key, 'start_failures')
        msg = ('机器: %s\n当前流量: %.2fGB%s\n'
               '开机指令下发失败: %s\n'
               '累计失败 %d 次，脚本将每 %d 分钟自动重试，无需手动干预。'
               % (common.sanitize(name), traffic_gb, _fmt_balance(user),
                  common.sanitize(error), count, RESOURCE_RETRY_COOLDOWN // 60))
        if common.event_allowed(state, key, 'start_failed'):
            if send_alert(config, '开机失败', msg, 'danger', LOG):
                common.mark_event(state, key, 'start_failed')
        return

    # 轮询确认是否真的起来了
    waited, started = 0, False
    while waited < START_WAIT_TIMEOUT:
        time.sleep(START_POLL_INTERVAL)
        waited += START_POLL_INTERVAL
        try:
            current = aliyun_api.get_instance_status(
                user['ak'], user['sk'], user['region'],
                user['instance_id'], (user.get('resgroup') or '').strip())
        except Exception:
            current = 'Unknown'
        LOG.info('[%s] 等待启动... 当前状态 %s (%ds)', name, current, waited)
        if current == 'Running':
            started = True
            break
        if current == 'Stopped':
            LOG.warning('[%s] 实例回落至 Stopped，开机被拒绝', name)
            break

    if started:
        common.clear_counter(state, key, 'start_failures')
        state.setdefault(key, {}).pop('last_retry_ts', None)
        LOG.info('[%s] 实例已恢复运行', name)
        if common.event_allowed(state, key, 'resumed'):
            msg = ('机器: %s\n当前流量: %.2fGB%s\n动作: 已自动开机恢复运行'
                   % (common.sanitize(name), traffic_gb, _fmt_balance(user)))
            if send_alert(config, '已恢复运行', msg, 'info', LOG):
                common.mark_event(state, key, 'resumed')
    else:
        count = common.bump_counter(state, key, 'start_failures')
        LOG.warning('[%s] 启动超时或被拒绝，累计失败 %d 次', name, count)
        if common.event_allowed(state, key, 'start_failed'):
            msg = ('机器: %s\n当前流量: %.2fGB%s\n'
                   '已下发开机指令，但 %d 秒内未进入 Running 状态。\n'
                   '通常为库存不足，累计失败 %d 次，脚本将每 %d 分钟自动重试。'
                   % (common.sanitize(name), traffic_gb, _fmt_balance(user),
                      START_WAIT_TIMEOUT, count, RESOURCE_RETRY_COOLDOWN // 60))
            if send_alert(config, '开机未成功', msg, 'danger', LOG):
                common.mark_event(state, key, 'start_failed')


def _enforce_stop(user, config, state, name, key, traffic_gb, status, limit_gb):
    """流量超标，强制关机止损。"""
    if status == 'Running':
        LOG.warning('[%s] 流量超标 %.2fGB / 阈值 %.0fGB，正在强制关机',
                    name, traffic_gb, limit_gb)
        try:
            aliyun_api.stop_instance(user['ak'], user['sk'], user['region'], user['instance_id'])
        except Exception as error:
            LOG.error('[%s] 关机指令下发失败: %s', name, common.redact(error))
            if common.event_allowed(state, key, 'stop_failed'):
                msg = ('机器: %s\n当前流量: %.2fGB\n'
                       '止损关机指令下发失败: %s\n'
                       '请立即登录阿里云控制台手动关机！'
                       % (common.sanitize(name), traffic_gb, common.sanitize(error)))
                if send_alert(config, '止损关机失败', msg, 'danger', LOG):
                    common.mark_event(state, key, 'stop_failed')
            return

        if common.event_allowed(state, key, 'overlimit', common.OVERLIMIT_COOLDOWN):
            msg = ('机器: %s\n当前流量: %.2fGB (阈值 %.0fGB)%s\n动作: 已强制关机止损'
                   % (common.sanitize(name), traffic_gb, limit_gb, _fmt_balance(user)))
            if send_alert(config, '流量超标已止损', msg, 'danger', LOG):
                common.mark_event(state, key, 'overlimit')
    else:
        LOG.info('[%s] 流量超标，实例已处于停止状态', name)
        if common.event_allowed(state, key, 'overlimit', common.OVERLIMIT_COOLDOWN):
            msg = ('机器: %s\n当前流量: %.2fGB (阈值 %.0fGB)%s\n状态: 流量超标，保持关机中'
                   % (common.sanitize(name), traffic_gb, limit_gb, _fmt_balance(user)))
            if send_alert(config, '流量超标提醒', msg, 'warn', LOG):
                common.mark_event(state, key, 'overlimit')


def _handle_check_failure(state, config, name, key, error):
    message = common.redact(error)
    LOG.error('[%s] 巡检出错: %s', name, message)
    count = common.bump_counter(state, key, 'check_failures')
    if count >= CHECK_FAILURE_ALERT_THRESHOLD and common.event_allowed(state, key, 'check_failed'):
        msg = ('机器: %s\n'
               '已连续 %d 次巡检失败，最近错误: %s\n'
               '期间流量监控与自动止损处于失效状态，请人工确认实例情况。'
               % (common.sanitize(name), count, common.sanitize(message)))
        if send_alert(config, '监控异常', msg, 'danger', LOG):
            common.mark_event(state, key, 'check_failed')


def check_with_timeout(user, config, state):
    """给单实例巡检加硬超时，避免 SDK 卡死长期占用运行锁。"""
    has_alarm = all(hasattr(signal, attr) for attr in
                    ('SIGALRM', 'ITIMER_REAL', 'setitimer', 'getitimer'))
    if not has_alarm:
        check_one(user, config, state)
        return

    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    signal.signal(signal.SIGALRM, _raise_timeout)
    signal.setitimer(signal.ITIMER_REAL, USER_CHECK_TIMEOUT)
    try:
        check_one(user, config, state)
    except CheckTimeout:
        name = user.get('name') or user.get('instance_id', '<未知>')
        key = user.get('instance_id', '<未知>')
        common.bump_counter(state, key, 'check_failures')
        LOG.error('[%s] 单实例巡检超过 %d 秒，已强制跳过以免阻塞其他实例',
                  name, USER_CHECK_TIMEOUT)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer != (0.0, 0.0):
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


def acquire_lock():
    """获取运行锁。返回锁句柄；已有实例在跑返回 None；不支持加锁的环境返回 True。"""
    if fcntl is None:
        return True
    try:
        handle = open(common.LOCK_FILE, 'w')
    except OSError:
        return True
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        handle.close()
        return None
    return handle


def main():
    lock = acquire_lock()
    if lock is None:
        LOG.info('上一轮巡检尚未结束，本轮跳过')
        return
    try:
        config = common.load_config(LOG)
        state = common.load_state()
        for user in config.get('users', []):
            check_with_timeout(user, config, state)
            common.save_state(state, LOG)
    finally:
        if hasattr(lock, 'close'):
            lock.close()


if __name__ == '__main__':
    main()
