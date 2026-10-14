import { makeNonce, makeTimestamp, signAliyunRpc } from './aliyun-sign.js';
import { operationSignal, requestContext, sleep, throwIfCancelled } from './request-context.js';

function resetSubrequestCount() {
  requestContext().budget.used = 0;
}
function isSubrequestBudgetExhausted() {
  return requestContext().budget.used >= SUBREQUEST_BUDGET;
}
function acquireSubrequest(cost = 1) {
  if (requestContext().budget.used + cost > SUBREQUEST_BUDGET) {
    return false;
  }
  requestContext().budget.used += cost;
  return true;
}
function percentEncode2(value) {
  return encodeURIComponent(String(value)).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}
async function doRequest(options) {
  const {
    accessKeyId,
    accessKeySecret,
    endpoint,
    action,
    version,
    params = {}
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
    timestamp
  });
  const finalParams = { ...allParams, Signature: signature };
  const body = Object.keys(finalParams).map((key) => `${percentEncode2(key)}=${percentEncode2(finalParams[key])}`).join("&");
  throwIfCancelled();
  const response = await fetch(`https://${endpoint}/`, {
    signal: operationSignal(),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
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
function isTransient(parsed, httpStatus) {
  if (httpStatus >= 500) {
    return true;
  }
  if (!parsed) {
    return true;
  }
  const code = parsed.Code || "";
  const transientCodes = [
    "Throttling",
    "Throttling.User",
    "ServiceUnavailable",
    "InternalError",
    "RequestTimeout",
    "Timeout"
  ];
  return transientCodes.includes(code);
}
async function requestWithRetry(options, retries = RETRY_TIMES) {
  throwIfCancelled();
  if (!acquireSubrequest(1)) {
    throw new BudgetExhaustedError();
  }
  const remaining = SUBREQUEST_BUDGET - requestContext().budget.used;
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
      throwIfCancelled();
      lastResult = { httpStatus: 0, parsed: null, raw: String(error && error.message) };
    }
    if (attempt < effectiveRetries) {
      if (!acquireSubrequest(1)) {
        break;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  return lastResult;
}
function unwrap(result, action) {
  if (!result || !result.parsed) {
    throw new ApiError(`${action} 无响应或返回非 JSON：${result ? result.raw : "空"}`);
  }
  const data = result.parsed;
  if (data.Code && data.Code !== "Success") {
    throw new ApiError(`${action} 失败：${data.Code} ${data.Message || ""}`.trim());
  }
  return data;
}
function isOverseasRegion(region) {
  const rid = String(region || "").trim().toLowerCase();
  if (!rid) {
    return false;
  }
  if (rid === "cn-hongkong") {
    return true;
  }
  return OVERSEAS_PREFIXES.some((prefix) => rid.startsWith(prefix));
}
function getFreeQuotaGb(region) {
  return isOverseasRegion(region) ? FREE_QUOTA_OVERSEAS_GB : FREE_QUOTA_MAINLAND_GB;
}
async function getCdtTrafficGb(accessKeyId, accessKeySecret) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: CDT_ENDPOINT,
    action: "ListCdtInternetTraffic",
    version: CDT_VERSION,
    params: { PageSize: "50" }
  });
  const data = unwrap(result, "查询 CDT 流量");
  let totalBytes = 0;
  for (const item of data.TrafficDetails || []) {
    totalBytes += Number(item.Traffic || 0);
  }
  return totalBytes / 1024 ** 3;
}
async function getInstanceStatus(accessKeyId, accessKeySecret, region, instanceId) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: "DescribeInstances",
    version: ECS_VERSION,
    params: { RegionId: region, InstanceIds: JSON.stringify([instanceId]) }
  });
  const data = unwrap(result, "查询实例状态");
  const instances = data.Instances && data.Instances.Instance || [];
  if (!instances.length) {
    return null;
  }
  return instances[0].Status || null;
}
async function getInstanceDetail(accessKeyId, accessKeySecret, region, instanceId) {
  let result = null;
  try {
    result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint: `ecs.${region}.aliyuncs.com`,
      action: "DescribeInstances",
      version: ECS_VERSION,
      params: { RegionId: region, InstanceIds: JSON.stringify([instanceId]) }
    });
  } catch (error) {
    return { status: "NotFound", ip: "无", spec: "无" };
  }
  const data = result && result.parsed;
  const instances = data && data.Instances && data.Instances.Instance || [];
  if (!instances.length) {
    return { status: "NotFound", ip: "无", spec: "无" };
  }
  const inst = instances[0];
  const publicIps = inst.PublicIpAddress && inst.PublicIpAddress.IpAddress || [];
  const eip = inst.EipAddress && inst.EipAddress.IpAddress || "";
  const ip = eip || publicIps[0] || "无公网地址";
  const cpu = Number(inst.Cpu || 0);
  const memMb = Number(inst.Memory || 0);
  const mem = memMb && memMb % 1024 === 0 ? String(memMb / 1024) : (memMb / 1024).toFixed(1);
  return {
    status: inst.Status || "Unknown",
    ip,
    spec: `${cpu}核${mem}G`
  };
}
async function listInstances(accessKeyId, accessKeySecret, region) {
  const instances = [];
  for (let page = 1; page <= 100; page++) {
    const result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint: `ecs.${region}.aliyuncs.com`,
      action: "DescribeInstances",
      version: ECS_VERSION,
      params: { RegionId: region, PageSize: "100", PageNumber: String(page) }
    });
    const data = unwrap(result, "列出实例");
    const list = data.Instances?.Instance || [];
    instances.push(...list.map((inst) => ({ instanceId: inst.InstanceId || "", instanceName: inst.InstanceName || "", status: inst.Status || "" })));
    if (list.length < 100 || instances.length >= Number(data.TotalCount || 0)) return instances;
  }
  throw new Error("实例分页超过上限，请分地域添加");
}
async function describeRegions(accessKeyId, accessKeySecret) {
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: "ecs.aliyuncs.com",
    action: "DescribeRegions",
    version: ECS_VERSION,
    params: {}
  });
  const data = unwrap(result, "查询地域列表");
  const regions = data.Regions && data.Regions.Region || [];
  const ids = regions.map((item) => item.RegionId).filter(Boolean);
  return Array.from(new Set(ids)).sort();
}
async function startInstance(accessKeyId, accessKeySecret, region, instanceId) {
  const journal = requestContext().actionJournal;
  const journalKey = JSON.stringify(["StartInstance", accessKeyId, region, instanceId]);
  if (journal && await journal.has(journalKey)) return;
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: "StartInstance",
    version: ECS_VERSION,
    params: { RegionId: region, InstanceId: instanceId }
  }, 1);
  unwrap(result, "开机");
  if (journal) await journal.mark(journalKey);
  return true;
}
async function stopInstance(accessKeyId, accessKeySecret, region, instanceId) {
  const journal = requestContext().actionJournal;
  const journalKey = JSON.stringify(["StopInstance", accessKeyId, region, instanceId]);
  if (journal && await journal.has(journalKey)) return;
  const result = await requestWithRetry({
    accessKeyId,
    accessKeySecret,
    endpoint: `ecs.${region}.aliyuncs.com`,
    action: "StopInstance",
    version: ECS_VERSION,
    params: { RegionId: region, InstanceId: instanceId }
  }, 1);
  unwrap(result, "关机");
  if (journal) await journal.mark(journalKey);
  return true;
}
async function getAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint = "") {
  const cacheKey = JSON.stringify([accessKeyId, accessKeySecret, region, billEndpoint]);
  if (cacheKey && balanceCacheByAk().has(cacheKey)) {
    return balanceCacheByAk().get(cacheKey);
  }
  const result = await fetchAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint);
  if (cacheKey) {
    balanceCacheByAk().set(cacheKey, result);
  }
  return result;
}
async function fetchAccountBalance(accessKeyId, accessKeySecret, region, billEndpoint = "") {
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
        action: "QueryAccountBalance",
        version: BSS_VERSION,
        params: {}
      }, 1);
      const data = result && result.parsed;
      if (!data || !data.Success) {
        continue;
      }
      const info = data.Data || {};
      if (info.AvailableAmount === void 0 || info.AvailableAmount === null) {
        continue;
      }
      const amount = parseFloat(String(info.AvailableAmount).replace(/,/g, ""));
      if (Number.isNaN(amount)) {
        continue;
      }
      return { amount, currency: info.Currency || "" };
    } catch (error) {
      continue;
    }
  }
  return { amount: null, currency: "" };
}
function currentBillingCycle() {
  const now = /* @__PURE__ */ new Date();
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1e3);
  const year = shanghai.getUTCFullYear();
  const month = String(shanghai.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
async function getInstanceBill(accessKeyId, accessKeySecret, region, instanceId, billEndpoint = "") {
  const cycle = currentBillingCycle();
  try {
    const result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint: "business.aliyuncs.com",
      action: "DescribeInstanceBill",
      version: BSS_VERSION,
      params: { BillingCycle: cycle, InstanceID: instanceId }
    }, 1);
    const data = result && result.parsed;
    if (data && data.Success) {
      const items = data.Data && data.Data.Items || [];
      const amount = items.reduce((sum, item) => sum + Number(item.PretaxAmount || 0), 0);
      const currency = items.length ? items[0].Currency || "" : "";
      return { amount, currency };
    }
  } catch (error) {
  }
  const endpoint = billEndpoint || "business.ap-southeast-1.aliyuncs.com";
  try {
    const result = await requestWithRetry({
      accessKeyId,
      accessKeySecret,
      endpoint,
      action: "QueryBillOverview",
      version: BSS_VERSION,
      params: { BillingCycle: cycle }
    }, 1);
    const data = result && result.parsed;
    const items = data && data.Data && data.Data.Items && data.Data.Items.Item || [];
    const amount = items.reduce((sum, item) => sum + Number(item.PretaxAmount || 0), 0);
    const currency = items.length ? items[0].Currency || "" : "";
    return { amount, currency };
  } catch (error) {
    return { amount: -1, currency: "" };
  }
}
var CDT_ENDPOINT, CDT_VERSION, ECS_VERSION, BSS_VERSION, BSS_ENDPOINTS, FREE_QUOTA_MAINLAND_GB, FREE_QUOTA_OVERSEAS_GB, OVERSEAS_PREFIXES, RETRY_TIMES, RETRY_DELAY_MS, SUBREQUEST_BUDGET, BudgetExhaustedError, ApiError, balanceCacheByAk;
CDT_ENDPOINT = "cdt.aliyuncs.com";
CDT_VERSION = "2021-08-13";
ECS_VERSION = "2014-05-26";
BSS_VERSION = "2017-12-14";
BSS_ENDPOINTS = [
  "business.aliyuncs.com",
  "business.ap-southeast-1.aliyuncs.com"
];
FREE_QUOTA_MAINLAND_GB = 20;
FREE_QUOTA_OVERSEAS_GB = 200;
OVERSEAS_PREFIXES = ["ap-", "us-", "eu-", "me-", "na-", "sa-", "cn-hongkong"];
RETRY_TIMES = 3;
RETRY_DELAY_MS = 2e3;
SUBREQUEST_BUDGET = 42;
BudgetExhaustedError = class extends Error {
  constructor(message = "本轮巡检的子请求预算已用完") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
};
ApiError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiError";
  }
};
balanceCacheByAk = () => requestContext().balanceCache;

export { ApiError, BSS_ENDPOINTS, BSS_VERSION, BudgetExhaustedError, CDT_ENDPOINT, CDT_VERSION, ECS_VERSION, FREE_QUOTA_MAINLAND_GB, FREE_QUOTA_OVERSEAS_GB, OVERSEAS_PREFIXES, RETRY_DELAY_MS, RETRY_TIMES, SUBREQUEST_BUDGET, acquireSubrequest, balanceCacheByAk, currentBillingCycle, describeRegions, doRequest, fetchAccountBalance, getAccountBalance, getCdtTrafficGb, getFreeQuotaGb, getInstanceBill, getInstanceDetail, getInstanceStatus, isOverseasRegion, isSubrequestBudgetExhausted, isTransient, listInstances, percentEncode2, requestWithRetry, resetSubrequestCount, startInstance, stopInstance, unwrap };
