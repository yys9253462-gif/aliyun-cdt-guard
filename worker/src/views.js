/**
 * 页面文本构建（Cloudflare Workers 版）
 *
 * 对应 Python 版 bot_listener.py 里的 build_status / build_traffic /
 * build_balance / build_weekly 四个函数，把「文本生成」从「消息收发」里拆出来，
 * 这样单测时不需要网络即可验证格式。
 *
 * 设计约定（与 Python 版一致）：
 *   · 所有数字保留两位小数，避免 0.30000000000000004 这种丑数
 *   · 查询失败明确写「查询失败」并给出原因，**绝不用 0 糊弄**
 *   · 已暂停的机器标注「监控: 已暂停」，且不消耗接口调用
 */

import * as api from './aliyun-api.js';
import * as common from './common.js';
import { buildSummaryText } from './account-summary.js';
import { regionDisplayWithCode } from './region-names.js';

const STATUS_CN = { Running: '运行中', Stopped: '已停止' };

/** 状态英文转中文；认不出的原样返回（不编造） */
export function statusChinese(status) {
  if (!status) return '未知';
  return STATUS_CN[status] || status;
}

/** 保留两位小数，去掉多余的 0（1234.00 -> 1234.00 保留；用于大额展示） */
function gb(value) {
  return Number(value).toFixed(2);
}

// ---------------------------------------------------------------------------
// 实例状态
// ---------------------------------------------------------------------------
export async function buildStatus(config) {
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const lines = ['机器实时状态', ''];
  for (const user of users) {
    const name = common.sanitize(user?.name || user?.instance_id);
    if (user?.paused) {
      lines.push(`\u00b7 ${name}`);
      lines.push('  监控: 已暂停');
      continue;
    }
    let statusCn;
    try {
      const status = await api.getInstanceStatus(
        user.ak, user.sk, user.region, user.instance_id
      );
      statusCn = status ? statusChinese(status) : '未查到（实例可能已释放）';
    } catch (error) {
      statusCn = `查询失败（${common.sanitize(error)}）`;
    }
    lines.push(`\u00b7 ${name}`);
    lines.push(`  状态: ${statusCn}`);
    // 带上中文地域名：光看机器名有时认不出在哪（用户可能自己起过名字）
    lines.push(`  地域: ${regionDisplayWithCode(user?.region)}`);
  }
  lines.push('');
  lines.push(`时间: ${common.nowLocal().toISOString().replace('T', ' ').slice(0, 16)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 流量与额度
// ---------------------------------------------------------------------------
export async function buildTraffic(config) {
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const lines = ['流量与免费额度', ''];
  for (const user of users) {
    const name = common.sanitize(user?.name || user?.instance_id);
    const region = user?.region || '';
    const limit = Number(user?.traffic_limit ?? 180);

    if (user?.paused) {
      lines.push(`\u00b7 ${name}`);
      lines.push('  监控: 已暂停');
      continue;
    }

    let traffic;
    try {
      traffic = await api.getCdtTrafficGb(user.ak, user.sk, region);
    } catch (error) {
      lines.push(`\u00b7 ${name}`);
      lines.push(`  查询失败: ${common.sanitize(error)}`);
      continue;
    }

    const freeGb = api.getFreeQuotaGb(region);
    const area = api.isOverseasRegion(region) ? '非中国内地' : '中国内地';
    const remain = freeGb - traffic;

    lines.push(`\u00b7 ${name}`);
    lines.push(`  地域: ${regionDisplayWithCode(region)}`);
    lines.push(`  已用: ${gb(traffic)} GB / 阈值 ${limit.toFixed(0)} GB`);
    lines.push(`  免费额度: ${freeGb.toFixed(0)} GB（${area}）`);
    if (remain >= 0) {
      lines.push(`  额度剩余: ${gb(remain)} GB`);
    } else {
      lines.push(`  已超出免费额度 ${gb(-remain)} GB，正在产生费用`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 余额详情
// ---------------------------------------------------------------------------
/**
 * 余额详情 —— 逐账号显示余额、本月账单、免费额度消耗。
 *
 * 为什么单独做一页而不是塞进总览：
 *     余额和账单是「钱」的问题，跟流量是「量」是两回事。
 *     而且余额是按 **AK / 账号** 维度查的，同一个 AK 下的多台机器只需查一次。
 *     本函数按 AK 去重，避免多台机器重复请求财务接口（那接口有频控）。
 */
export async function buildBalance(config) {
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const lines = ['余额与账单详情', ''];
  const seen = new Map();

  for (const user of users) {
    const name = common.sanitize(user?.name || user?.instance_id);
    const ak = String(user?.ak || '').trim();
    const region = user?.region || '';
    const defaultSymbol = user?.currency || '$';

    // 同一 AK 只查一次余额，多台机器复用结果
    if (!seen.has(ak)) {
      try {
        const value = await api.getAccountBalance(
          ak, user?.sk || '', region, user?.bill_endpoint || ''
        );
        seen.set(ak, value);
      } catch (error) {
        seen.set(ak, { amount: null, currency: '' });
      }
    }
    const { amount } = seen.get(ak);
    const currency = seen.get(ak).currency;
    const symbol = { CNY: '\u00a5', USD: '$' }[currency] || defaultSymbol;

    let balanceLine;
    if (amount === null || amount === undefined) {
      balanceLine = '查询失败';
    } else if (amount < 0) {
      balanceLine = `${symbol}${gb(amount)} [已欠费，请立即充值]`;
    } else {
      balanceLine = `${symbol}${gb(amount)}`;
    }

    lines.push(`\u00b7 ${name}`);

    // 余额警戒线：告诉你离告警还有多远
    const limit = Number(user?.balance_limit ?? common.DEFAULT_BALANCE_LIMIT);
    if (limit > 0 && amount !== null && amount !== undefined) {
      if (amount < limit) {
        lines.push(`  账户余额: ${balanceLine}（警戒线 ${symbol}${gb(limit)}，已低于警戒线）`);
      } else {
        lines.push(`  账户余额: ${balanceLine}（警戒线 ${symbol}${gb(limit)}）`);
      }
    } else {
      lines.push(`  账户余额: ${balanceLine}`);
    }

    // 本月账单
    let billAmount = null;
    let billCurrency = '';
    try {
      const bill = await api.getInstanceBill(
        ak, user?.sk || '', region, user?.instance_id || '', user?.bill_endpoint || ''
      );
      billAmount = bill.amount;
      billCurrency = bill.currency;
    } catch (error) {
      billAmount = null;
    }
    const billSymbol = { CNY: '\u00a5', USD: '$' }[billCurrency] || defaultSymbol;
    if (billAmount === null || billAmount === undefined || billAmount < 0) {
      lines.push('  本月账单: 查询失败');
    } else {
      const billLimit = Number(user?.bill_limit ?? common.DEFAULT_BILL_LIMIT);
      let suffix = '';
      if (billLimit > 0 && billAmount > billLimit) {
        suffix = `（已超警戒线 ${billSymbol}${gb(billLimit)}）`;
      }
      lines.push(`  本月账单: ${billSymbol}${gb(billAmount)}${suffix}`);
    }

    // 免费额度消耗情况
    let trafficGb = -1;
    try {
      trafficGb = await api.getCdtTrafficGb(ak, user?.sk || '', region);
    } catch (error) {
      trafficGb = -1;
    }
    const freeGb = api.getFreeQuotaGb(region);
    const area = api.isOverseasRegion(region) ? '非中国内地' : '中国内地';
    if (trafficGb >= 0) {
      const remain = freeGb - trafficGb;
      const percent = freeGb > 0 ? (trafficGb / freeGb) * 100 : 0;
      if (remain >= 0) {
        lines.push(
          `  免费额度: 已用 ${percent.toFixed(1)}%（${gb(trafficGb)} / ${freeGb.toFixed(0)} GB，${area}）`
        );
      } else {
        lines.push(`  免费额度: 已用尽，超出 ${gb(-remain)} GB 正在计费`);
      }
    }
    lines.push('');
  }

  lines.push(`时间: ${common.nowLocal().toISOString().replace('T', ' ').slice(0, 16)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 流量周报
// ---------------------------------------------------------------------------
/**
 * 流量周报 —— 最近 7 天的用量变化。
 *
 * 数据来源是巡检每轮写进 KV 的流量台账。
 * 台账刚上线时是空的，所以这里会明确告诉你「还没攒够数据」，
 * 而不是拿零去糊弄你 —— 那会让人误以为「一周一点流量都没用」。
 */
export async function buildWeekly(env, config) {
  const history = await common.loadHistory(env);
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const now = common.nowLocal();
  const cutoffDate = new Date(now.getTime() - 7 * 86400 * 1000)
    .toISOString().slice(0, 10);

  const lines = [
    '流量周报（最近 7 天）',
    `统计区间: ${cutoffDate.slice(5)} ~ ${now.toISOString().slice(5, 10)}`,
    '',
  ];

  if (!history.length) {
    lines.push('台账里还没有数据。');
    lines.push('');
    lines.push('说明: 周报依赖巡检定期记录一次流量快照，');
    lines.push('运行满 1 天后就会有完整曲线。请稍后再看。');
    return lines.join('\n');
  }

  for (const user of users) {
    const iid = user?.instance_id || '';
    const name = common.sanitize(user?.name || iid);
    const points = history
      .filter((p) => p?.instance_id === iid && String(p?.date || '') >= cutoffDate)
      .sort((a, b) => {
        const ka = `${a?.date || ''} ${a?.time || ''}`;
        const kb = `${b?.date || ''} ${b?.time || ''}`;
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
      });

    lines.push(`\u00b7 ${name}`);
    if (points.length < 2) {
      lines.push('  数据点不足，暂无法计算增量。');
      lines.push('');
      continue;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const used = Number(last?.traffic_gb ?? 0) - Number(first?.traffic_gb ?? 0);

    if (used < 0) {
      // 账期重置会让流量归零，此时增量为负 —— 直接说明，不要显示负数糊弄人
      lines.push('  本区间内账期重置过，累计用量无法直接相减。');
      lines.push(`  当前已用: ${gb(last?.traffic_gb ?? 0)} GB`);
    } else {
      lines.push(`  区间新增: ${gb(used)} GB`);
      lines.push(`  当前已用: ${gb(last?.traffic_gb ?? 0)} GB`);
      const freeGb = api.getFreeQuotaGb(user?.region || '');
      if (freeGb > 0) {
        lines.push(
          `  免费额度占用: ${((Number(last?.traffic_gb ?? 0) / freeGb) * 100).toFixed(1)}%`
        );
      }
    }

    // 每天的平均用量，让你判断趋势
    const days = Math.max(new Set(points.map((p) => p?.date)).size, 1);
    if (used >= 0) {
      lines.push(`  日均约: ${gb(used / days)} GB/天（覆盖 ${days} 天）`);
    }
    lines.push('');
  }

  lines.push('提示: 周报数据来自本系统台账，不含阿里云控制台的手工调整。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 账号汇总
// ---------------------------------------------------------------------------
export async function buildAccounts(config) {
  return buildSummaryText(config);
}

// ---------------------------------------------------------------------------
// 完整报表
// ---------------------------------------------------------------------------
function money(amount, currency, defaultSymbol = '$') {
  if (amount === null || amount === undefined || amount < 0) return '查询失败';
  const symbol = { CNY: '\u00a5', USD: '$' }[currency] || defaultSymbol;
  return `${symbol}${gb(amount)}`;
}

/**
 * 逐台完整报表：状态 / 公网 IP / 规格 / 流量 / 本月账单 / 账户余额。
 *
 * 逐台看是「明细」，按账号看是「总账」。
 * 只有 2 个以上账号时才追加账号汇总 —— 单账号的汇总与明细完全重复。
 */
export async function buildReport(config) {
  const users = config?.users || [];
  const lines = [
    '[阿里云 CDT 流量守护 - 每日报表]',
    `日期: ${common.nowLocal().toISOString().slice(0, 10)}`,
    '',
  ];

  const balanceCache = new Map();

  for (const user of users) {
    const name = common.sanitize(String(user?.name || '').trim() || user?.instance_id || '未命名');
    const instanceId = String(user?.instance_id || '').trim();
    const region = String(user?.region || '').trim();
    const quota = Number(user?.traffic_limit ?? 180);

    if (user?.paused) {
      lines.push(`\u00b7 ${name}`);
      lines.push('  监控: 已暂停');
      lines.push('');
      continue;
    }

    const ak = String(user.ak || '').trim();
    const sk = String(user.sk || '').trim();

    // 1. 流量
    let trafficGb = -1;
    try {
      trafficGb = await api.getCdtTrafficGb(ak, sk, region);
    } catch (error) {
      trafficGb = -1;
    }

    // 2. 实例详情
    const detail = await api.getInstanceDetail(ak, sk, region, instanceId);

    // 3. 本月账单
    let billAmount = null;
    let billCurrency = '';
    try {
      const bill = await api.getInstanceBill(
        ak, sk, region, instanceId, user?.bill_endpoint || ''
      );
      billAmount = bill.amount;
      billCurrency = bill.currency;
    } catch (error) {
      billAmount = null;
    }

    // 4. 账户余额（同 AK 复用缓存）
    if (!balanceCache.has(ak)) {
      try {
        balanceCache.set(ak, await api.getAccountBalance(
          ak, sk, region, user?.bill_endpoint || ''
        ));
      } catch (error) {
        balanceCache.set(ak, { amount: null, currency: '' });
      }
    }
    const { amount: balanceAmount, currency: balanceCurrency } = balanceCache.get(ak);

    const percent = trafficGb >= 0 && quota > 0 ? (trafficGb / quota) * 100 : 0;
    let trafficStr;
    if (trafficGb < 0) {
      trafficStr = '查询失败';
    } else {
      trafficStr = `${gb(trafficGb)} GB（阈值的 ${percent.toFixed(1)}%）`;
    }

    let verdict;
    if (trafficGb < 0) verdict = '流量查询异常';
    else if (trafficGb > quota) verdict = '流量已超标，已止损';
    else if (percent >= 80) verdict = '流量接近阈值，注意';
    else verdict = '正常';

    lines.push(`\u00b7 ${name}（${detail.spec}）`);
    lines.push(`  状态: ${statusChinese(detail.status)}`);
    lines.push(`  地域: ${regionDisplayWithCode(region)}`);
    lines.push(`  公网IP: ${detail.ip}`);
    lines.push(`  流量: ${trafficStr} / 阈值 ${quota.toFixed(0)}GB`);

    if (trafficGb >= 0) {
      const freeGb = api.getFreeQuotaGb(region);
      const area = api.isOverseasRegion(region) ? '非中国内地' : '中国内地';
      const remain = freeGb - trafficGb;
      if (remain >= 0) {
        lines.push(`  免费额度: ${freeGb.toFixed(0)} GB/月（${area}）→ 免费额度剩 ${gb(remain)} GB`);
      } else {
        lines.push(
          `  免费额度: ${freeGb.toFixed(0)} GB/月（${area}）→ 已超出 ${gb(-remain)} GB，超出部分开始计费`
        );
      }
    }

    lines.push(`  本月账单: ${money(billAmount, billCurrency, user?.currency || '$')}`);
    lines.push(`  账户余额: ${money(balanceAmount, balanceCurrency, user?.currency || '$')}`);
    lines.push(`  评价: ${verdict}`);
    lines.push('');
  }

  lines.push('提示: 流量达到阈值会自动关机止损，次月流量重置后自动开机。');

  const { groupByAccount } = await import('./account-summary.js');
  if (groupByAccount(users).length >= 2) {
    lines.push('');
    lines.push('-'.repeat(30));
    lines.push('');
    lines.push(await buildSummaryText(config));
  }

  return lines.join('\n');
}
