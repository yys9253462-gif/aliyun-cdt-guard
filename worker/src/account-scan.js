import { FREE_QUOTA_MAINLAND_GB, FREE_QUOTA_OVERSEAS_GB, describeRegions, isOverseasRegion, isSubrequestBudgetExhausted, listInstances } from './aliyun-api.js';
import { sanitize } from './common.js';
import { ERR_CREDENTIAL, classifyError } from './credential-error.js';
import { regionDisplayWithCode } from './region-names.js';

var BATCH_SIZE = 8;
var MAX_REGIONS = 30;
var CRED_OK = "ok";
var CRED_BAD = "bad";
var CRED_UNKNOWN = "unknown";
async function scanAccount(ak, sk) {
  const accessKeyId = String(ak || "").trim();
  const accessKeySecret = String(sk || "").trim();
  if (!accessKeyId || !accessKeySecret) {
    return {
      credential: CRED_BAD,
      message: "AccessKey 没填全（ID 和 Secret 都要）。",
      instances: []
    };
  }
  let regions = [];
  try {
    regions = await describeRegions(accessKeyId, accessKeySecret);
  } catch (error) {
    const { kind, reason } = classifyError(error);
    return {
      credential: kind === ERR_CREDENTIAL ? CRED_BAD : CRED_UNKNOWN,
      message: reason,
      instances: []
    };
  }
  if (!regions.length) {
    regions = FALLBACK_REGIONS.slice();
  }
  regions = regions.slice(0, MAX_REGIONS);
  const instances = [];
  // 查询失败的地域要记下来告诉用户。原来失败一律当成「这个地域没有机器」，
  // 限流时重试还会把单次请求的调用次数耗光，连后面正常的地域也扫不到，却照样显示「扫描完成」。
  // 现在：扫描不重试（失败了点「重新扫描」即可），调用次数不够时剩下的地域标成「未扫描」。
  const failedRegions = [];
  for (let i = 0; i < regions.length; i += BATCH_SIZE) {
    const batch = regions.slice(i, i + BATCH_SIZE);
    if (isSubrequestBudgetExhausted()) {
      for (const region of regions.slice(i)) failedRegions.push({ region, reason: "本次没来得及扫描" });
      break;
    }
    const results = await Promise.all(
      batch.map(async (region) => {
        try {
          const list = await listInstances(accessKeyId, accessKeySecret, region, 1);
          return list.map((item) => ({
            instanceId: item.instanceId || "",
            instanceName: item.instanceName || "",
            status: item.status || "",
            region,
            isOverseas: isOverseasRegion(region)
          }));
        } catch (error) {
          const { reason } = classifyError(error);
          failedRegions.push({ region, reason: String(reason || error && error.message || "查询失败").split("\n")[0].slice(0, 60) });
          return [];
        }
      })
    );
    for (const item of results) {
      instances.push(...item);
    }
  }
  if (failedRegions.length && failedRegions.length >= regions.length) {
    return {
      credential: CRED_UNKNOWN,
      message: `所有 ${regions.length} 个地域都没能查询成功（例如：${failedRegions[0].reason}）。`,
      instances: [],
      failedRegions
    };
  }
  instances.sort((a, b) => {
    if (a.region !== b.region) return a.region < b.region ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : 1;
  });
  return { credential: CRED_OK, message: "", instances, failedRegions };
}
var FALLBACK_REGIONS = [
  "cn-hangzhou",
  "cn-shanghai",
  "cn-beijing",
  "cn-shenzhen",
  "cn-guangzhou",
  "cn-chengdu",
  "cn-hongkong",
  "cn-zhangjiakou",
  "cn-qingdao",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "us-west-1",
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "me-east-1",
  "me-central-1",
  "ap-southeast-4"
];
function formatFailedRegions(failedRegions) {
  const list = Array.isArray(failedRegions) ? failedRegions : [];
  if (!list.length) return "";
  const shown = list.slice(0, 8).map((f) => `· ${regionDisplayWithCode(f.region)}：${sanitize(f.reason)}`);
  if (list.length > shown.length) shown.push(`· 以及另外 ${list.length - shown.length} 个地域`);
  return [
    "",
    `⚠️ 有 ${list.length} 个地域没扫到，这些地域里的机器不在上面的列表里：`,
    ...shown,
    "可以稍后点「🔄 重新扫描」再试；已经找到的机器可以先加入。"
  ].join("\n");
}
function formatScanResult(instances, maxShow = 20, failedRegions = []) {
  const list = Array.isArray(instances) ? instances : [];
  const warning = formatFailedRegions(failedRegions);
  if (!list.length && warning) {
    return `这次没有找到机器。${warning}`;
  }
  if (!list.length) {
    return "这个账号下没有找到任何 ECS 实例。\n\n如果你确定账号里有机器，通常是这两种情况：\n\xB7 这把 Key 是子账号的，但没授权能看到那些机器\n\xB7 机器在不常见的地域，超出了扫描范围";
  }
  const lines = [`共找到 ${list.length} 台机器：`, ""];
  const show = list.slice(0, maxShow);
  for (let i = 0; i < show.length; i += 1) {
    const item = show[i];
    const name = sanitize(item.instanceName || "(未命名)");
    const quota = `${isOverseasRegion(item.region) ? FREE_QUOTA_OVERSEAS_GB : FREE_QUOTA_MAINLAND_GB}GB 免费额度`;
    lines.push(`${i + 1}. ${name}`);
    lines.push(`   地域 ${regionDisplayWithCode(item.region)} \xB7 ${item.status || "未知状态"} \xB7 ${quota}`);
    lines.push(`   ${item.instanceId}`);
  }
  if (list.length > show.length) {
    lines.push("");
    lines.push(`（还有 ${list.length - show.length} 台没列出来，也可一并加入）`);
  }
  if (warning) lines.push(warning);
  return lines.join("\n");
}

export { formatFailedRegions, BATCH_SIZE, CRED_BAD, CRED_OK, CRED_UNKNOWN, FALLBACK_REGIONS, MAX_REGIONS, formatScanResult, scanAccount };
