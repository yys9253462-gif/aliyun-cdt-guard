import { FREE_QUOTA_MAINLAND_GB, FREE_QUOTA_OVERSEAS_GB, describeRegions, isOverseasRegion, listInstances } from './aliyun-api.js';
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
  for (let i = 0; i < regions.length; i += BATCH_SIZE) {
    const batch = regions.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (region) => {
        try {
          const list = await listInstances(accessKeyId, accessKeySecret, region);
          return list.map((item) => ({
            instanceId: item.instanceId || "",
            instanceName: item.instanceName || "",
            status: item.status || "",
            region,
            isOverseas: isOverseasRegion(region)
          }));
        } catch (_error) {
          return [];
        }
      })
    );
    for (const item of results) {
      instances.push(...item);
    }
  }
  instances.sort((a, b) => {
    if (a.region !== b.region) return a.region < b.region ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : 1;
  });
  return { credential: CRED_OK, message: "", instances };
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
function formatScanResult(instances, maxShow = 20) {
  const list = Array.isArray(instances) ? instances : [];
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
  return lines.join("\n");
}

export { BATCH_SIZE, CRED_BAD, CRED_OK, CRED_UNKNOWN, FALLBACK_REGIONS, MAX_REGIONS, formatScanResult, scanAccount };
