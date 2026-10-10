/**
 * 按账号汇总（Cloudflare Workers 版）
 *
 * 对应 Python 版的 account_summary.py。
 *
 * 为什么需要这个模块：
 *     免费额度是**按账号**算的，不是按机器算的。
 *     一个账号下若有 3 台机器，它们**共享**同一份 200GB/月，
 *     而不是各有一份。所以「每台机器都用掉多少」这个视角是不够的 ——
 *     三台各用 70GB 看起来都很安全，加起来 210GB 其实已经超了。
 *
 * 关键区分（务必读清楚）：
 *     用的是「按 AK 分组」，不是「按实例分组」。
 *     同一个主账号下的不同 RAM 子账号，AK 不同但**额度共享**。
 *     所以严格来说这里算的「账号」= 一个 AK。
 */

import {
  getCdtTrafficGb,
  isOverseasRegion,
  getFreeQuotaGb,
} from './aliyun-api.js';
import { isCredentialError, credentialReason } from './credential-error.js';

/**
 * 把机器按 AccessKey 分组。
 *
 * 返回 [{ ak, members: [user, ...] }, ...]，保持原有顺序便于阅读。
 */
export function groupByAccount(users) {
  const groups = [];
  const index = new Map();
  for (const user of users || []) {
    const ak = String(user?.ak || '').trim();
    if (!ak) continue;
    if (!index.has(ak)) {
      index.set(ak, groups.length);
      groups.push({ ak, members: [] });
    }
    groups[index.get(ak)].members.push(user);
  }
  return groups;
}

/**
 * 把 AK 打码，只留前 6 位 + 后 4 位。
 *
 * 为什么要打码：AK 属于敏感信息，报表可能被转发。
 *
 * ⚠️ 这里踩过一个真实的坑（多账号用户发现的）：
 *     最早只留前 6 位，结果**两个账号显示成一模一样** ——
 *     阿里云的 AccessKey ID 前缀高度相似（都是 LTAI5t...），
 *     多账号用户看到「账号 LTAI5t****」根本分不清哪个是哪个。
 *     留前 6 位的作用是「让你认出是哪个账号」，做不到这一点就失去意义了。
 *
 * 现在的做法：前 6 位 + 后 4 位。前 6 位用来识别账号，
 * 后 4 位用来**区分同前缀的不同账号**。中间遮住，仍然不可还原。
 */
export function maskAk(ak) {
  const value = String(ak || '').trim();
  if (!value) return '未填写';
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

/**
 * 算出这一组共享的免费额度（GB）。
 *
 * 额度按「地域」区分（内地 20 / 非内地 200），而同一账号下可能
 * 既有内地机器又有非内地机器。阿里云的规则是**两部分分开计算**：
 *     中国内地 20GB 一份 + 非中国内地 200GB 一份，互不占用。
 * 所以这里分别加总，而不是取一个值。
 */
export function quotaForGroup(members) {
  let mainland = 0.0;
  let overseas = 0.0;
  for (const user of members || []) {
    const region = user?.region || '';
    if (isOverseasRegion(region)) {
      overseas += getFreeQuotaGb(region);
    } else {
      mainland += getFreeQuotaGb(region);
    }
  }
  return { mainland, overseas };
}

/**
 * 查出这一组账号在本月的流量。
 *
 * 粒度说明（这是本模块最需要注意的地方）：
 *     CDT 的查询接口返回的是**整个账号**的用量，不是单台实例的用量。
 *     所以对同一账号下的多台机器，我们只查一次，然后把这份总量记在
 *     账号组上，**不要**去把每台机器的查询结果相加 —— 那会重复计算 N 倍。
 */
async function trafficForGroup(ak, sk, members) {
  const region = members?.length ? members[0]?.region || '' : '';
  try {
    const value = await getCdtTrafficGb(ak, sk, region);
    return { trafficGb: value, error: null };
  } catch (error) {
    return { trafficGb: -1.0, error };
  }
}

/**
 * 按账号汇总。返回结构化数据列表，供报表与菜单渲染。
 *
 * 每个元素：
 *   akDisplay     打码后的 AK
 *   names         组内机器名列表
 *   count         机器台数
 *   trafficGb     账号本月总用量（-1 表示查询失败）
 *   mainlandFree / overseasFree   两个池子的免费额度
 *   error         查询失败时的原因，正常为 null
 */
export async function summarizeAccounts(config) {
  const users = config?.users || [];
  const result = [];

  for (const { ak, members } of groupByAccount(users)) {
    const sk = String(members[0]?.sk || '').trim();
    const { mainland, overseas } = quotaForGroup(members);
    const { trafficGb, error } = await trafficForGroup(ak, sk, members);

    const names = [];
    for (const user of members) {
      let name = String(user?.name || user?.instance_id || '未命名').trim();
      if (user?.paused) name += '（已暂停）';
      names.push(name);
    }

    result.push({
      akDisplay: maskAk(ak),
      names,
      count: members.length,
      trafficGb,
      mainlandFree: mainland,
      overseasFree: overseas,
      error,
    });
  }

  return result;
}

/**
 * 生成「按账号汇总」的纯文本段落，报表与菜单共用。
 *
 * 只统计**未被暂停**的机器占用情况；全部暂停的账号会标注出来，
 * 避免你看到一堆「0 台在监控」却不知道发生了什么。
 */
export async function buildSummaryText(config) {
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const groups = await summarizeAccounts(config);
  if (!groups.length) return '当前没有配置任何机器。';

  const lines = [];
  lines.push('*按账号汇总*');
  lines.push('（免费额度按账号计算，同一账号下所有机器共享）');
  lines.push('');

  for (const info of groups) {
    const active = info.names.filter((n) => !n.includes('已暂停'));
    lines.push(`* 账号 ${info.akDisplay}（${info.count} 台机器）`);

    for (const name of info.names) {
      lines.push(`  \u00b7 ${name}`);
    }

    if (info.trafficGb < 0) {
      // 凭据类错误要**说人话 + 给动作**，不能把阿里云英文原样丢给用户。
      // 历史上这里直接 slice(0,60) 打印原始报错，用户看到的是一串
      // 「ApiError: 查询 CDT 流量 失败：InvalidAccessKeyId.NotFound Specified」
      // —— 完全不知道该怎么办（实测踩过）。
      if (info.error && isCredentialError(info.error)) {
        // credentialReason 的结构是「阿里云原话 + 空行 + 中文说明」，
        // 汇总这里只要**中文说明那半段**（原话在巡检告警里已经给过，这里不必重复）。
        const full = credentialReason(info.error);
        const parts = String(full).split(/\n{2,}/);
        const human = (parts.length > 1 ? parts[parts.length - 1] : full).replace(/\n+/g, ' ');
        lines.push(`  本月用量: 查不到 —— ${human}`);
        lines.push('  ↳ 点「➕ 添加账号」重新填一遍这把新密钥就行：'
          + '填到同一台机器会**原地更新凭据**，不会多出一台。');
      } else {
        let reason = '';
        if (info.error !== null && info.error !== undefined) {
          reason = `（${String(info.error).slice(0, 60)}）`;
        }
        lines.push(`  本月用量: 查询失败${reason}`);
      }
      lines.push('');
      continue;
    }

    const used = info.trafficGb;
    lines.push(`  账号本月总用量: ${used.toFixed(2)} GB`);

    // 按池子分别展示：内地池 / 非内地池
    if (info.overseasFree > 0) {
      const remain = info.overseasFree - used;
      if (remain >= 0) {
        lines.push(
          `  非中国内地额度: ${info.overseasFree.toFixed(0)} GB，` +
          `已用 ${((used / info.overseasFree) * 100).toFixed(1)}%，剩 ${remain.toFixed(2)} GB`
        );
      } else {
        lines.push(
          `  非中国内地额度: ${info.overseasFree.toFixed(0)} GB，` +
          `已超出 ${(-remain).toFixed(2)} GB（正在计费）`
        );
      }
    }
    if (info.mainlandFree > 0) {
      const remain = info.mainlandFree - used;
      if (remain >= 0) {
        lines.push(
          `  中国内地额度: ${info.mainlandFree.toFixed(0)} GB，` +
          `已用 ${((used / info.mainlandFree) * 100).toFixed(1)}%，剩 ${remain.toFixed(2)} GB`
        );
      } else {
        lines.push(
          `  中国内地额度: ${info.mainlandFree.toFixed(0)} GB，` +
          `已超出 ${(-remain).toFixed(2)} GB（正在计费）`
        );
      }
    }

    // 台数提示：同账号多台时给出「均摊」参考，避免各自按满额设阈值
    if (info.count >= 2 && active.length) {
      const pool = Math.max(info.overseasFree, info.mainlandFree);
      if (pool > 0) {
        lines.push(
          `  提示: ${info.count} 台机器共享这一份额度，` +
          `平均每台约 ${(pool / info.count).toFixed(0)} GB 才安全`
        );
      }
    }
    lines.push('');
  }

  if (groups.length >= 2) {
    lines.push('注意: 上面按 AccessKey 分组。若某两个账号其实是同一主账号下的不同子账号，');
    lines.push('它们的额度实际是共享的，请以阿里云控制台的「云数据传输」页面为准。');
  }

  return lines.join('\n');
}
