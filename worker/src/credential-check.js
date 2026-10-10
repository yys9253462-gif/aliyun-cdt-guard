/**
 * 凭据体检（Credentials Health Check）
 *
 * 解决什么问题：
 *     老大的疑问是「账号的 AccessKey 失效了现在怎么处理」。
 *     查完发现原来的机制是**被动**的 —— 只有等某台机器巡检失败、
 *     连续 3 次之后才会发一条告警，而且文案是通用的。
 *     更糟的是：如果某个账号的 Key 失效了，但那个账号下的机器
 *     恰好都在暂停状态，那**连巡检都不会跑**，你永远不知道 Key 坏了。
 *
 * 所以补一个**主动**体检：拿配置里每对 AK/SK 去问阿里云一句
 * 「你还认识我吗」，当场给出「有效 / 失效」的结论。
 *
 * 触发方式有两种：
 *     1. 手动 —— 机器人菜单点「🔑 凭据体检」
 *     2. 定时 —— 每天一次（cron），坏了主动推给你
 *
 * ⚠️ 为什么体检要比巡检更「敢用接口」：
 *     巡检是每 5 分钟一次，不能乱花子请求额度；
 *     体检一天才一次，而且是**只读**的（DescribeRegions），
 *     代价可控。所以这里可以放心地每个账号都验一遍。
 */

import * as api from './aliyun-api.js';
import { groupByAccount, maskAk } from './account-summary.js';
import { classifyError, ERR_CREDENTIAL } from './credential-error.js';

/** 体检单个账号（一对 AK/SK）。 */
async function checkOneAccount(ak, sk) {
  try {
    // 用 DescribeRegions 验凭据 —— 阿里云对这个接口鉴权最严，
    // 能过就基本能确定「这对 Key 是活的」。
    const regions = await api.describeRegions(ak, sk);
    const ok = Array.isArray(regions);
    return { ok, kind: ok ? 'ok' : 'unknown', reason: '', raw: '' };
  } catch (error) {
    const { kind, reason, raw } = classifyError(error);
    return { ok: false, kind, reason, raw };
  }
}

/**
 * 体检配置里的全部账号。
 *
 * @returns {Promise<{groups: Array, badCount: number, total: number}>}
 *   groups —— [{ akDisplay, count, names, ok, kind, reason }]
 *             kind: 'ok' | ERR_CREDENTIAL | ERR_TRANSIENT | ERR_UNKNOWN
 */
export async function checkAllCredentials(config) {
  const users = config?.users || [];
  const groups = [];
  let badCount = 0;

  for (const { ak, members } of groupByAccount(users)) {
    const sk = String(members[0]?.sk || '').trim();
    const result = await checkOneAccount(ak, sk);

    const names = members.map(
      (u) => String(u?.name || u?.instance_id || '未命名').trim()
    );

    if (!result.ok && result.kind === ERR_CREDENTIAL) {
      badCount += 1;
    }

    groups.push({
      akDisplay: maskAk(ak),
      count: members.length,
      names,
      ok: result.ok,
      kind: result.kind,
      reason: result.reason,
    });
  }

  return { groups, badCount, total: groups.length };
}

/**
 * 生成体检报告文本（给机器人消息用）。
 *
 * 排版原则：
 *   · 先给总结论（有几个坏、要不要处理），别再让人读完整段才知道好不好
 *   · 坏的账号**说清楚哪台机器受影响**，因为用户关心的其实是机器
 *   · 暂时性错误（网络抖）**和坏凭据分开说**，不要吓人
 */
export async function buildCredentialReport(config) {
  const users = config?.users || [];
  if (!users.length) {
    return '当前没有配置任何机器，没有凭据可检。\n\n先去「➕ 添加账号」加一个吧。';
  }

  const { groups, badCount, total } = await checkAllCredentials(config);
  const okCount = groups.filter((g) => g.ok).length;
  const tempFailed = groups.filter((g) => !g.ok && g.kind !== ERR_CREDENTIAL);

  const lines = [];
  lines.push('*🔑 凭据体检结果*');
  lines.push('');
  lines.push(`共 ${total} 个账号，其中 ${okCount} 个正常`
    + (badCount ? `，⚠️ ${badCount} 个凭据已失效` : '')
    + (tempFailed.length ? `，${tempFailed.length} 个暂时查不通` : '')
    + '。');
  lines.push('');

  for (const g of groups) {
    lines.push(`* 账号 ${g.akDisplay}（${g.count} 台机器）`);
    if (g.ok) {
      lines.push('  ✅ 凭据有效');
    } else if (g.kind === ERR_CREDENTIAL) {
      lines.push('  ❌ 凭据已失效 —— 该账号下的机器当前监控中断');
      lines.push('  影响的机器:');
      for (const n of g.names) {
        lines.push(`    · ${n}`);
      }
      lines.push('');
      lines.push(`  原因: ${g.reason.split('\n')[0]}`);
      lines.push('  怎么修: 点「➕ 添加账号」重新填一份有效凭据。'
        + '（同一账号下的机器会被认出，不会重复添加。）');
    } else {
      lines.push('  ⏳ 暂时查不通（不是凭据问题，稍后再试）');
      lines.push(`  原因: ${g.reason.split('\n')[0]}`);
    }
    lines.push('');
  }

  if (badCount) {
    lines.push('⚠️ 有凭据失效。在你修好之前，这些账号下的机器：');
    lines.push('· 流量超标不会自动关机（可能一直在扣钱）');
    lines.push('· 流量安全也不会自动开机');
    lines.push('请尽快处理。');
  }

  return lines.join('\n');
}

/**
 * 定时体检：只在**发现坏凭据**时推送，正常时静默。
 *
 * 为什么要静默：
 *     每天推一条「一切正常」是纯噪音，久了你会连真告警一起忽略。
 *     只在出问题时说话，消息才有分量。
 *
 * @returns {Promise<{ok: boolean, badCount: number, message: string}>}
 */
export async function runScheduledCredentialCheck(config) {
  const users = config?.users || [];
  if (!users.length) {
    return { ok: true, badCount: 0, message: '' };
  }

  const { groups, badCount } = await checkAllCredentials(config);
  if (!badCount) {
    return { ok: true, badCount: 0, message: '' };
  }

  const lines = [];
  lines.push('⚠️ *发现失效的阿里云凭据*');
  lines.push('');
  for (const g of groups) {
    if (g.ok || g.kind !== ERR_CREDENTIAL) continue;
    lines.push(`账号 ${g.akDisplay}（${g.count} 台机器）`);
    lines.push(`  原因: ${g.reason.split('\n')[0]}`);
  }
  lines.push('');
  lines.push('这些账号下的机器当前监控已中断（不会自动止损 / 自动开机）。');
  lines.push('请点「🔑 凭据体检」看详情，或点「➕ 添加账号」重新填凭据。');

  return { ok: false, badCount, message: lines.join('\n') };
}
