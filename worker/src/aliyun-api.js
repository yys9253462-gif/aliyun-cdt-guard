/**
 * 阿里云接口封装（Cloudflare Workers 版）
 *
 * 对应 Python 版的 aliyun_api.py。业务代码只调这里的语义化函数，
 * 不直接碰签名与 HTTP 细节。
 *
 * 和 Python 版的差异：
 *   · 不能用官方 SDK，全部走自己实现的 RPC 签名（见 aliyun-sign.js）
 *   · 没有 socket 层的 IPv4 强制 / SNI 补丁 —— Workers 自己处理这些
 *   · 保留了「瞬态错误重试」与「双端点回退」这两套容错机制
 */

import { signAliyunRpc, makeNonce, makeTimestamp } from './aliyun-sign.js';

// ---------------------------------------------------------------------------
// 常量（与 Python 版保持一致）
// ---------------------------------------------------------------------------
const CDT_ENDPOINT = 'cdt.aliyuncs.com';
const CDT_VERSION = '2021-08-13';
// CDT 接口固定走杭州接入点，某些海外地域直连会卡死 —— 这是实测结论
const CDT_REGION = 'cn-hangzhou';

const ECS_VERSION = '2014-05-26';

// ---------------------------------------------------------------------------
// 🔴 ECS 端点：必须用「地域专属端点」，不能用通用入口（真机实测踩坑）
// ---------------------------------------------------------------------------
// 2026-10-10 用真实账号实测发现：
//     用通用入口 https://ecs.aliyuncs.com/ 查菲律宾（ap-southeast-6）的机器，
//     返回 HTTP 404：
//       {"Code":"InvalidOperation.NotSupportedEndpoint",
//        "Message":"The specified endpoint cant operate this region."}
//     换成地域专属端点 https://ecs.ap-southeast-6.aliyuncs.com/ 立刻返回 200。
//
//     也就是说：**新建的海外地域（东南亚陆续在加）通用入口不覆盖**，
//     只有 `ecs.<地域>.aliyuncs.com` 这一个可靠写法。
//
//     所以下面所有涉及实例的接口（查列表 / 开机 / 关机 / 重启）
//     一律用 `ecs.${region}.aliyuncs.com`，**不要图省事改回通用入口**。
//
//     唯一的例外是 DescribeRegions（查地域列表本身）——它没有
//     「属于哪个地域」的概念，只能用通用入口，实测通用入口对它可用。

export const BSS_VERSION = '2017-12-14';
export const BSS_ENDPOINTS = [
  'business.aliyuncs.com',
  'business.ap-southeast-1.aliyuncs.com',
];

/**
 * CDT 免费额度（按账号统一计算，各产品共享）
 *
 * 中国内地地域 20 GB/月 + 非中国内地地域 200 GB/月
 *
 * ⚠️ 这是「免费」额度，不是计费阶梯上界。
 *    接口返回的 HighestTraffic（10TiB）是第一档计费阶梯的上界，与免费无关，
 *    切勿拿它当免费额度 —— 那会严重高估可用量（差 51 倍）。
 */
export const FREE_QUOTA_MAINLAND_GB = 20.0;
export const FREE_QUOTA_OVERSEAS_GB = 200.0;

// 亚太大区前缀（非中国内地）
const OVERSEAS_PREFIXES = ['ap-', 'us-', 'eu-', 'me-', 'na-', 'sa-', 'cn-hongkong'];

const RETRY_TIMES = 3;
const RETRY_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// 子请求预算保护（B5）
// ---------------------------------------------------------------------------
/**
 * 免费版 Worker 单次请求最多只能发起 **50 个子请求**（subrequest）。
 * 超过就直接抛错，整个请求失败 —— 最坏的结果是「一轮巡检跑到一半崩掉，
 * 前面的结果全丢，用户在机器人里什么回执都收不到」。
 *
 * 为什么很容易撞上这个上限：
 *     每次阿里云接口调用都是 1 个子请求，而 requestWithRetry 最多重试 3 次。
 *     单台机器一轮正常要查：流量 + 实例状态 + 本月账单 = 3 次；
 *     只要接口开始抖动（阿里云偶发超时是常态），每项都变成 3 次 = 9 次。
 *     再算上给 Telegram 发消息也占子请求，**四五台机器就足以打满 50**。
 *
 * 所以这里做「预算保护」，策略是**宁可少查几台，也不能整轮崩掉**：
 *   · 每次真正发起请求前先检查预算是否还够；
 *   · 预算不足时，直接让本次调用返回「查不到」而不是继续发请求 ——
 *     调用方本来就处理了「查不到」的情况（显示查询失败），
 *     所以降级是平滑的，不会产生新错误；
 *   · 单个接口本来要重试 3 次，预算紧张时只重试 1 次，
 *     把重试的机会让给后面的机器 —— 让尽可能多的机器被检查到。
 *
 * 上限取 42 而不是 50，是给「已发生但未计数」的请求留缓冲：
 * 账单查询内部可能走多个端点、Telegram 发送也占额度，
 * 留 8 个的余量能避免预算刚好卡在边界时被 Cloudflare 判超限。
 */
const SUBREQUEST_BUDGET = 42;

/** 当前请求已消耗的子请求数（模块级，生命周期 = 一次请求） */
let subrequestUsed = 0;

/** 重置子请求计数。每次巡检开始和测试用例开始时调用。 */
export function resetSubrequestCount() {
  subrequestUsed = 0;
}

/** 读取当前已消耗的子请求数（日志与测试用） */
export function getSubrequestCount() {
  return subrequestUsed;
}

/** 预算是否已耗尽（外部据此决定是否提前收尾） */
export function isSubrequestBudgetExhausted() {
  return subrequestUsed >= SUBREQUEST_BUDGET;
}

/**
 * 申请一次子请求额度。够则放行并计数，不够则返回 false。
 * @param {number} cost 本次要发起的请求数（重试时按实际要发的次数传）
 */
function acquireSubrequest(cost = 1) {
  if (subrequestUsed + cost > SUBREQUEST_BUDGET) {
    return false;
  }
  subrequestUsed += cost;
  return true;
}

/** 预算不足时抛出的错误 —— 与「接口报错」区分开，便于日志说明原因 */
export class BudgetExhaustedError extends Error {
  constructor(message = '本轮巡检的子请求预算已用完') {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/** 接口错误：带上阿里云返回的原始原因，便于日志与告警展示 */
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// 通用请求
// ---------------------------------------------------------------------------

/** 按阿里云规则做 URL 编码（+ 编 %20，* 编 %2A，~ 不编码） */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * 发一次阿里云 RPC 请求（含签名）。
 * 返回 { httpStatus, parsed, raw }。
 */
async function doRequest(options) {
  const {
    accessKeyId,
    accessKeySecret,
    endpoint,
    action,
    version,
    params = {},
  } = options;

  const nonce = makeNonce();
  const timestamp = makeTimestamp();

  const { signature, allParams } = await signAliyunRpc({
    action,
    version,
    accessKeyId,
    accessKeySecret,
    params,
    nonce,
    timestamp,
  });

  const finalParams = { ...allParams, Signature: signature };
  const body = Object.keys(finalParams)
    .map((key) => `${percentEncode(key)}=${percentEncode(finalParams[key])}`)
    .join('&');

  const response = await fetch(`https://${endpoint}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  return { httpStatus: response.status, parsed, raw: text.slice(0, 600) };
}

/** 判断是否属于「值得重试」的瞬态错误 */
function isTransient(parsed, httpStatus) {
  if (httpStatus >= 500) {
    return true;
  }
  if (!parsed) {
    // 不是 JSON，多半是网关错误页
    return true;
  }
  const code = parsed.Code || '';
  const transientCodes = [
    'Throttling', 'Throttling.User', 'ServiceUnavailable',
    'InternalError', 'RequestTimeout', 'Timeout',
  ];
  return transientCodes.includes(code);
}

/**
 * 带重试的请求。只对瞬态错误重试，业务错误立刻抛出。
 *
 * 为什么要重试：阿里云接口偶发限流（Throttling）与网关 5xx，
 * 巡检每 5 分钟一次，中间抖一下不该让整轮失败。
 */
async function requestWithRetry(options, retries = RETRY_TIMES) {
  // 预算不足时**根本不再发起请求**，直接抛 BudgetExhaustedError。
  // 调用方要么自己 catch 成「查不到」，要么让外层把本轮标记为「预算用完」，
  // 无论哪种都不会让 Worker 抛 subrequest 超限的致命错误。
  if (!acquireSubrequest(1)) {
    throw new BudgetExhaustedError();
  }

  // 预算紧张时主动降低重试次数：把剩下的额度留给还没被检查的机器。
  // 判断依据是「按最坏情况（每项 3 次）还能撑几台」，够 2 台就正常重试，
  // 否则退化成不重试 —— 少查一次总比整轮崩掉强。
  const remaining = SUBREQUEST_BUDGET - subrequestUsed;
  const effectiveRetries = remaining >= 6 ? retries : 1;

  let lastResult = null;
  for (let attempt = 1; attempt <= effectiveRetries; attempt += 1) {
    try {
      const result = await doRequest(options);
      lastResult = result;
      if (!isTransient(result.parsed, result.httpStatus)) {
        return result;
      }
    } catch (error) {
      lastResult = { httpStatus: 0, parsed: null, raw: String(error && error.message) };
    }
    if (attempt < effectiveRetries) {
      // 重试也要先申请额度，申请不到就到此为止（留着给后面的机器）
      if (!acquireSubrequest(1)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return lastResult;
}

/** 从请求结果里取业务数据；失败时抛 ApiError（带可读原因） */
function unwrap(result, action) {
  if (!result || !result.parsed) {
    throw new ApiError(`${action} 无响应或返回非 JSON：${result ? result.raw : '空'}`);
  }
  const data = result.parsed;
  // 阿里云成功时不带 Code；失败时带 Code 与 Message
  if (data.Code && data.Code !== 'Success') {
    throw new ApiError(`${action} 失败：${data.Code} ${data.Message || ''}`.trim());
  }
  return data;
}

// ---------------------------------------------------------------------------
// 地域与额度判定
// ---------------------------------------------------------------------------

/**
 * 判断地域是否属于「非中国内地」（影响免费额度是 200GB 还是 20GB）。
 *
 * 中国内地地域形如 cn-hangzhou / cn-shanghai；
 * 而中国香港是 cn-hongkong —— 它属于非内地，享 200GB。
 */
export function isOverseasRegion(region) {
  const rid = String(region || '').trim().toLowerCase();
  if (!rid) {
    return false;
  }
  if (rid === 'cn-hongkong') {
    return true;
  }
  return OVERSEAS_PREFIXES.some((prefix) => rid.startsWith(prefix));
}

/** 按地域返回该账号本月的 CDT 免费额度（GB） */
export function getFreeQuotaGb(region) {
  return isOverseasRegion(region) ? FREE_QUOTA_OVERSEAS_GB : FREE_QUOTA_MAINLAND_GB;
}

// ---------------------------------------------------------------------------
// 业务接口
// ---------------------------------------------------------------------------

/**
 * 查询账号当月 CDT 公网出流量，单位 GB。
 *
 * ⚠️ 接口返回的是**整个账号**的用量，不是单台实例的用量。
 *    同一账号下多台机器只能查一次，把每台的结果相加会重复计算 N 倍。
 */
export async function getCdtTrafficGb(accessKeyId, accessKeySecret) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: CDT_ENDPOINT,
    action: 'ListCdtInternetTraffic',
    version: CDT_VERSION,
    params: { PageSize: '50' },
  });
  const data = unwrap(result, '查询 CDT 流量');

  let totalBytes = 0;
  for (const item of data.TrafficDetails || []) {
    totalBytes += Number(item.Traffic || 0);
  }
  return totalBytes / (1024 ** 3);
}

/**
 * 查询 CDT 流量明细，返回结构化信息。
 *
 * 返回 { trafficGb, freeGb, tierMaxGb, overFree }
 *   tierMaxGb 是第一档阶梯上界（GB，仅供了解计费结构，不是免费量）
 */
export async function getCdtTrafficDetail(accessKeyId, accessKeySecret, region) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: CDT_ENDPOINT,
    action: 'ListCdtInternetTraffic',
    version: CDT_VERSION,
    params: { PageSize: '50' },
  });
  const data = unwrap(result, '查询 CDT 流量明细');

  let totalBytes = 0;
  let tierMaxBytes = 0;
  for (const item of data.TrafficDetails || []) {
    totalBytes += Number(item.Traffic || 0);
    for (const tier of item.TrafficTierDetails || []) {
      const highest = Number((tier && tier.HighestTraffic) || 0);
      if (highest > tierMaxBytes) {
        tierMaxBytes = highest;
      }
    }
  }

  const trafficGb = totalBytes / (1024 ** 3);
  const freeGb = getFreeQuotaGb(region);
  return {
    trafficGb,
    freeGb,
    tierMaxGb: tierMaxBytes / (1024 ** 3),
    overFree: trafficGb >= freeGb,
  };
}

/**
 * 查询实例状态，返回 Running / Stopped / Starting 等。
 * 找不到实例返回 null。
 */
export async function getInstanceStatus(accessKeyId, accessKeySecret, region, instanceId) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: 'DescribeInstances',
    version: ECS_VERSION,
    params: { RegionId: region, InstanceIds: JSON.stringify([instanceId]) },
  });
  const data = unwrap(result, '查询实例状态');
  const instances = (data.Instances && data.Instances.Instance) || [];
  if (!instances.length) {
    return null;
  }
  return instances[0].Status || null;
}

/** 查询实例详情（状态 / 公网 IP / 规格），用于日报 */
export async function getInstanceDetail(accessKeyId, accessKeySecret, region, instanceId) {
  let result = null;
  try {
    result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint: `ecs.${region}.aliyuncs.com`,
      action: 'DescribeInstances',
      version: ECS_VERSION,
      params: { RegionId: region, InstanceIds: JSON.stringify([instanceId]) },
    });
  } catch (error) {
    return { status: 'NotFound', ip: '无', spec: '无' };
  }

  const data = result && result.parsed;
  const instances = (data && data.Instances && data.Instances.Instance) || [];
  if (!instances.length) {
    return { status: 'NotFound', ip: '无', spec: '无' };
  }

  const inst = instances[0];
  const publicIps = (inst.PublicIpAddress && inst.PublicIpAddress.IpAddress) || [];
  const eip = (inst.EipAddress && inst.EipAddress.IpAddress) || '';
  const ip = eip || publicIps[0] || '无公网地址';

  const cpu = Number(inst.Cpu || 0);
  const memMb = Number(inst.Memory || 0);
  const mem = memMb && memMb % 1024 === 0
    ? String(memMb / 1024)
    : (memMb / 1024).toFixed(1);

  return {
    status: inst.Status || 'Unknown',
    ip,
    spec: `${cpu}核${mem}G`,
  };
}

/** 列出指定地域下的全部实例（安装向导用） */
export async function listInstances(accessKeyId, accessKeySecret, region) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: 'DescribeInstances',
    version: ECS_VERSION,
    params: { RegionId: region, PageSize: '100' },
  });
  const data = unwrap(result, '列出实例');
  const instances = (data.Instances && data.Instances.Instance) || [];
  return instances.map((inst) => ({
    instanceId: inst.InstanceId || '',
    instanceName: inst.InstanceName || '',
    status: inst.Status || '',
  }));
}

/**
 * 查询账号可见的全部地域编号。
 *
 * 走 ECS 的 DescribeRegions 接口，**动态获取而非硬编码**，
 * 这样阿里云将来新开地域（例如东南亚陆续新增的节点）会自动覆盖到。
 */
export async function describeRegions(accessKeyId, accessKeySecret) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: 'ecs.aliyuncs.com',
    action: 'DescribeRegions',
    version: ECS_VERSION,
    params: {},
  });
  const data = unwrap(result, '查询地域列表');
  const regions = (data.Regions && data.Regions.Region) || [];
  const ids = regions.map((item) => item.RegionId).filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

/** 开实例 */
export async function startInstance(accessKeyId, accessKeySecret, region, instanceId) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: 'StartInstance',
    version: ECS_VERSION,
    params: { RegionId: region, InstanceId: instanceId },
  }, 1);
  unwrap(result, '开机');
  return true;
}

/** 关实例 */
export async function stopInstance(accessKeyId, accessKeySecret, region, instanceId) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: 'StopInstance',
    version: ECS_VERSION,
    params: { RegionId: region, InstanceId: instanceId },
  }, 1);
  unwrap(result, '关机');
  return true;
}

/** 重启实例 */
export async function rebootInstance(accessKeyId, accessKeySecret, region, instanceId) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: 'RebootInstance',
    version: ECS_VERSION,
    params: { RegionId: region, InstanceId: instanceId },
  }, 1);
  unwrap(result, '重启');
  return true;
}

// ---------------------------------------------------------------------------
// 余额查询的请求级去重（B8）
// ---------------------------------------------------------------------------
/**
 * 余额查询的去重缓存 —— 同一个 AK 在一次请求生命周期内只查一次。
 *
 * 为什么必须做这个（实测踩到的浪费）：
 *     一次巡检里，余额会被查两遍：
 *       · guard.js 的 checkOne    —— 判断「余额是否低于设定下限」
 *       · views.js 的 buildReport —— 报表里要显示余额
 *     两边各自维护了一份缓存，互相不知道对方查过，
 *     于是同一账号的 QueryAccountBalance 被实实在在地调了 2 次。
 *
 *     更隐蔽的一层浪费在 getAccountBalance **内部**：
 *     它会依次尝试 billEndpoint、business.aliyuncs.com、
 *     business.ap-southeast-1.aliyuncs.com 三个端点，
 *     只要前一个失败就继续试下一个 —— **每个都是一次真实的接口调用**。
 *     调用方那一层的缓存根本挡不住这层内部重试。
 *     所以缓存要放在**函数入口**，而不是各个调用方。
 *
 * 为什么放在模块级变量里是安全的：
 *     Cloudflare Workers 每次请求是独立的执行环境，
 *     这个 Map 的生命周期天然就是「一次请求」（即一轮巡检），
 *     不会跨请求串数据，也不需要手动清理。
 *     换个说法：用 Map 做缓存，正好等价于「一轮巡检内共享」。
 *
 * 缓存什么：命中过就存结果（含失败结果 { amount: null }）。
 *     连失败也要缓存 —— 否则同一账号在一轮里会反复重试失败的端点，
 *     白白消耗本就紧张的子请求预算（见 B5）。
 */
const balanceCacheByAk = new Map();

/** 清空余额缓存。测试用，也可在需要强制刷新时调用。 */
export function clearBalanceCache() {
  balanceCacheByAk.clear();
}

/**
 * 查询账户可用余额，返回 { amount, currency }；失败返回 { amount: null }。
 *
 * 为什么要试两个端点：国内站走 business.aliyuncs.com，
 * 国际站可能只认 business.ap-southeast-1.aliyuncs.com。都试一遍最稳。
 *
 * ⚠️ 带请求级缓存：同一个 AK 在**一轮巡检内**只真正调用一次接口。
 *    见上方 balanceCacheByAk 的说明 —— 这是省配额的关键，
 *    不要为了「拿到最新值」把缓存去掉，那样会让同一个账号被查好几遍。
 */
export async function getAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint = '') {
  const cacheKey = String(accessKeyId || '');
  if (cacheKey && balanceCacheByAk.has(cacheKey)) {
    return balanceCacheByAk.get(cacheKey);
  }

  const result = await fetchAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint);
  if (cacheKey) {
    balanceCacheByAk.set(cacheKey, result);
  }
  return result;
}

/** 真正执行余额查询（不含缓存）。抽出来是为了让缓存逻辑一目了然。 */
async function fetchAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint = '') {
  const endpoints = [];
  if (billEndpoint) {
    endpoints.push(billEndpoint);
  }
  for (const endpoint of BSS_ENDPOINTS) {
    if (!endpoints.includes(endpoint)) {
      endpoints.push(endpoint);
    }
  }

  for (const endpoint of endpoints) {
    try {
      const result = await requestWithRetry({
        accessKeyId,
        accessKeySecret,
        endpoint,
        action: 'QueryAccountBalance',
        version: BSS_VERSION,
        params: {},
      }, 1);
      const data = result && result.parsed;
      if (!data || !data.Success) {
        continue;
      }
      const info = data.Data || {};
      if (info.AvailableAmount === undefined || info.AvailableAmount === null) {
        continue;
      }
      const amount = parseFloat(String(info.AvailableAmount).replace(/,/g, ''));
      if (Number.isNaN(amount)) {
        continue;
      }
      return { amount, currency: info.Currency || '' };
    } catch (error) {
      continue;
    }
  }
  return { amount: null, currency: '' };
}

/** 当前账期，形如 2026-10（东八区） */
export function currentBillingCycle() {
  const now = new Date();
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
  const year = shanghai.getUTCFullYear();
  const month = String(shanghai.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 查询该实例本月账单金额，返回 { amount, currency }；失败返回 { amount: -1 }。
 *
 * 先试 DescribeInstanceBill（能按实例过滤），失败再退回账单总览。
 */
export async function getInstanceBill(accessKeyId, accessKeySecret, region, instanceId, billEndpoint = '') {
  const cycle = currentBillingCycle();

  // 第一条路：按实例查明细
  try {
    const result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint: 'business.aliyuncs.com',
      action: 'DescribeInstanceBill',
      version: BSS_VERSION,
      params: { BillingCycle: cycle, InstanceID: instanceId },
    }, 1);
    const data = result && result.parsed;
    if (data && data.Success) {
      const items = (data.Data && data.Data.Items) || [];
      const amount = items.reduce((sum, item) => sum + Number(item.PretaxAmount || 0), 0);
      const currency = items.length ? items[0].Currency || '' : '';
      return { amount, currency };
    }
  } catch (error) {
    // 落到第二条路
  }

  // 第二条路：国际站退回账单总览
  const endpoint = billEndpoint || 'business.ap-southeast-1.aliyuncs.com';
  try {
    const result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint,
      action: 'QueryBillOverview',
      version: BSS_VERSION,
      params: { BillingCycle: cycle },
    }, 1);
    const data = result && result.parsed;
    const items = (data && data.Data && data.Data.Items && data.Data.Items.Item) || [];
    const amount = items.reduce((sum, item) => sum + Number(item.PretaxAmount || 0), 0);
    const currency = items.length ? items[0].Currency || '' : '';
    return { amount, currency };
  } catch (error) {
    return { amount: -1, currency: '' };
  }
}
