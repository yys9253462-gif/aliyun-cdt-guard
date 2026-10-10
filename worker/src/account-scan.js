/**
 * 阿里云账号扫描（给「在机器人里添加账号」用的）
 *
 * 解决什么问题：
 *     以前要加一个阿里云账号，得打开电脑、进项目目录、跑 bash_menu configure，
 *     还得拿本子抄下实例 ID 和地域。老大希望的是：**在 Telegram 里点几下就完事**。
 *
 * 这个模块负责「拿到一对 AK/SK 之后，把这个账号下的机器全找出来」。
 *
 * ⚠️ 三条硬约束（Cloudflare Workers 环境）：
 *   1. **子请求有上限**。一个 Worker 请求最多 50 个子请求（免费版）。
 *      所以不能「拿 30 个地域全部 Promise.all 一起打」—— 会直接超限。
 *      这里用**分批并发**（BATCH_SIZE 个一批）控制住。
 *   2. **单个请求有总时长限制**。地域多的时候全扫一遍可能要几十秒，
 *      分批 + 每批并发是唯一能既快又不超限的做法。
 *   3. **不能吞异常**。某个地域查不到（比如没开、没权限）是**正常**的，
 *      要静默跳过；但「凭据本身就错」必须**单独识别出来并明确报给用户** ——
 *      否则用户会以为「我账号里没机器」，而真实原因是 Key 填错了。
 *      这两件事的处理方式完全不同，绝不能混为一谈。
 */

import * as common from './common.js';
import * as api from './aliyun-api.js';
import { credentialReason } from './credential-error.js';
import { regionDisplayWithCode } from './region-names.js';

// 把识别逻辑再导出一次，方便调用方从本模块一并取用（实际实现在 credential-error.js）
export { credentialReason };

/**
 * 每一批并发查多少个地域。
 *
 * 为什么是 8：
 *   免费版 Worker 单次请求最多 50 个子请求。除了扫地域，
 *   还要留出额度给「发消息给用户」等操作。
 *   8 个一批 × 最多 5 批 ≈ 40 个，留了安全余量。
 */
const BATCH_SIZE = 8;

/**
 * 最多扫多少个地域。
 *
 * 阿里云当前开放的地域大约 20 多个，设 30 是留足余量。
 * 上限的意义是**兜住极端情况**：万一接口返回异常长的列表，
 * 不至于让一次「加账号」把子请求额度耗光。
 */
const MAX_REGIONS = 30;

/**
 * 扫描结果里，凭据是否有效。
 */
export const CRED_OK = 'ok';
export const CRED_BAD = 'bad';
export const CRED_UNKNOWN = 'unknown';

/**
 * 用给定凭据扫出这个账号下的全部机器。
 *
 * @param {string} ak  AccessKeyId
 * @param {string} sk  AccessKeySecret
 * @returns {Promise<{credential: string, message: string, instances: Array}>}
 *   credential —— CRED_OK / CRED_BAD / CRED_UNKNOWN
 *   message    —— 凭据有问题时，给人看的中文原因（含阿里云原话）
 *   instances  —— [{ instanceId, instanceName, region, status, isOverseas }]
 */
export async function scanAccount(ak, sk) {
  const accessKeyId = String(ak || '').trim();
  const accessKeySecret = String(sk || '').trim();

  if (!accessKeyId || !accessKeySecret) {
    return {
      credential: CRED_BAD,
      message: 'AccessKey 没填全（ID 和 Secret 都要）。',
      instances: [],
    };
  }

  // -------------------------------------------------------------------------
  // 第 1 步：先单独验证凭据本身
  // -------------------------------------------------------------------------
  // 为什么要单独做这一步，而不是直接开始扫机器：
  //   如果 AK/SK 是错的，扫地域时会**每个地域都失败**，
  //   最终结果就是「0 台机器」。用户看到这个会以为「我这个账号里
  //   确实没机器」，然后去别处瞎找原因 —— 实际上就是 Key 复制错了。
  //   所以先把「凭据对不对」和「有没有机器」这两件事分开。
  let regions = [];
  try {
    regions = await api.describeRegions(accessKeyId, accessKeySecret);
  } catch (error) {
    // 这里抛出来的就是「凭据被拒绝」或「网络不通」，细节都在 message 里
    return {
      credential: CRED_BAD,
      message: credentialReason(error),
      instances: [],
    };
  }

  // describeRegions 成功说明凭据是有效的（阿里云对这个接口鉴权最严）
  if (!regions.length) {
    // 极少见：凭据通过了，但一个地域都没返回。用常见地域兜底。
    regions = FALLBACK_REGIONS.slice();
  }
  regions = regions.slice(0, MAX_REGIONS);

  // -------------------------------------------------------------------------
  // 第 2 步：分批并发扫各地的实例
  // -------------------------------------------------------------------------
  const instances = [];
  for (let i = 0; i < regions.length; i += BATCH_SIZE) {
    const batch = regions.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (region) => {
        try {
          const list = await api.listInstances(accessKeyId, accessKeySecret, region);
          return list.map((item) => ({
            instanceId: item.instanceId || '',
            instanceName: item.instanceName || '',
            status: item.status || '',
            region,
            isOverseas: api.isOverseasRegion(region),
          }));
        } catch (_error) {
          // 这个地域查不到就跳过 —— 可能没开通、没权限、或本来就没机器。
          // 这是**正常情况**，不该打扰用户，也不该让整次扫描失败。
          return [];
        }
      })
    );
    for (const item of results) {
      instances.push(...item);
    }
  }

  // 按「地域 + 实例 ID」排序，让结果稳定可预期（同一账号每次扫出来顺序一致）
  instances.sort((a, b) => {
    if (a.region !== b.region) return a.region < b.region ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : 1;
  });

  return { credential: CRED_OK, message: '', instances };
}

/**
 * 兜底地域清单。
 *
 * 只在「凭据通过但拿不到地域列表」这种极罕见情况下用。
 * 之所以要兜底：宁可多扫几个确定存在的地域，也不要因为一个接口异常
 * 就让用户完全看不到自己的机器。
 *
 * ⚠️ 导出是为了让测试能断言「这里面每个地域都有中文名」——
 *    否则扫描结果会出现「地域 ap-southeast-2」这种半中半英的尴尬。
 */
export const FALLBACK_REGIONS = [
  'cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen', 'cn-guangzhou',
  'cn-chengdu', 'cn-hongkong', 'cn-zhangjiakou', 'cn-qingdao',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-5',
  'ap-southeast-6', 'ap-southeast-7', 'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1', 'us-west-1', 'us-east-1', 'eu-west-1', 'eu-central-1',
  'me-east-1', 'me-central-1', 'ap-southeast-4',
];

/**
 * 把扫描结果排版成一段能直接发到 Telegram 的中文说明。
 *
 * @param {Array} instances  scanAccount 返回的 instances
 * @param {number} maxShow   最多列几台（Telegram 单条消息有长度上限）
 */
export function formatScanResult(instances, maxShow = 20) {
  const list = Array.isArray(instances) ? instances : [];
  if (!list.length) {
    return '这个账号下没有找到任何 ECS 实例。\n\n'
      + '如果你确定账号里有机器，通常是这两种情况：\n'
      + '· 这把 Key 是子账号的，但没授权能看到那些机器\n'
      + '· 机器在不常见的地域，超出了扫描范围';
  }

  const lines = [`共找到 ${list.length} 台机器：`, ''];

  const show = list.slice(0, maxShow);
  for (let i = 0; i < show.length; i += 1) {
    const item = show[i];
    const name = common.sanitize(item.instanceName || '(未命名)');
    // 额度数值统一从 aliyun-api 取，避免这里写死 20/200 后哪天改了常量漏改此处
    const quota = `${api.isOverseasRegion(item.region)
      ? api.FREE_QUOTA_OVERSEAS_GB
      : api.FREE_QUOTA_MAINLAND_GB}GB 免费额度`;
    // 地域给「中文名（代码）」：中文名让你一眼认得出是哪个机房，
    // 代码是唯一标识（查控制台/搜索/开工单都要用），两个都给才够用。
    lines.push(`${i + 1}. ${name}`);
    lines.push(`   地域 ${regionDisplayWithCode(item.region)} · ${item.status || '未知状态'} · ${quota}`);
    lines.push(`   ${item.instanceId}`);
  }

  if (list.length > show.length) {
    lines.push('');
    lines.push(`（还有 ${list.length - show.length} 台没列出来，也可一并加入）`);
  }

  return lines.join('\n');
}
