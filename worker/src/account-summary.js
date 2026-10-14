import { getCdtTrafficGb, getFreeQuotaGb, isOverseasRegion } from './aliyun-api.js';
import { credentialReason, isCredentialError } from './credential-error.js';

function groupByAccount(users) {
  const groups = [];
  const index = /* @__PURE__ */ new Map();
  for (const user of users || []) {
    const ak = String(user?.ak || "").trim();
    if (!ak) continue;
    if (!index.has(ak)) {
      index.set(ak, groups.length);
      groups.push({ ak, members: [] });
    }
    groups[index.get(ak)].members.push(user);
  }
  return groups;
}
function maskAk(ak) {
  const value = String(ak || "").trim();
  if (!value) return "未填写";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}
function quotaForGroup(members) {
  let mainland = 0;
  let overseas = 0;
  let hasMainland = false;
  let hasOverseas = false;
  for (const user of members || []) {
    const region = user?.region || "";
    if (isOverseasRegion(region)) {
      if (!hasOverseas) {
        overseas += getFreeQuotaGb(region);
        hasOverseas = true;
      }
    } else {
      if (!hasMainland) {
        mainland += getFreeQuotaGb(region);
        hasMainland = true;
      }
    }
  }
  return { mainland, overseas };
}
async function trafficForGroup(ak, sk, members) {
  const region = members?.length ? members[0]?.region || "" : "";
  try {
    const value = await getCdtTrafficGb(ak, sk, region);
    return { trafficGb: value, error: null };
  } catch (error) {
    return { trafficGb: -1, error };
  }
}
async function summarizeAccounts(config) {
  const users = config?.users || [];
  const result = [];
  for (const { ak, members } of groupByAccount(users)) {
    const sk = String(members[0]?.sk || "").trim();
    const { mainland, overseas } = quotaForGroup(members);
    const { trafficGb, error } = await trafficForGroup(ak, sk, members);
    const names = [];
    for (const user of members) {
      let name = String(user?.name || user?.instance_id || "未命名").trim();
      if (user?.paused) name += "（已暂停）";
      names.push(name);
    }
    result.push({
      akDisplay: maskAk(ak),
      names,
      count: members.length,
      trafficGb,
      mainlandFree: mainland,
      overseasFree: overseas,
      error
    });
  }
  return result;
}
async function buildSummaryText(config) {
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const groups = await summarizeAccounts(config);
  if (!groups.length) return "当前没有配置任何机器。";
  const lines = [];
  lines.push("*按账号汇总*");
  lines.push("（免费额度按账号计算，同一账号下所有机器共享）");
  lines.push("");
  for (const info of groups) {
    const active = info.names.filter((n) => !n.includes("已暂停"));
    lines.push(`* 账号 ${info.akDisplay}（${info.count} 台机器）`);
    for (const name of info.names) {
      lines.push(`  \xB7 ${name}`);
    }
    if (info.trafficGb < 0) {
      if (info.error && isCredentialError(info.error)) {
        const full = credentialReason(info.error);
        const parts = String(full).split(/\n{2,}/);
        const human = (parts.length > 1 ? parts[parts.length - 1] : full).replace(/\n+/g, " ");
        lines.push(`  本月用量: 查不到 —— ${human}`);
        lines.push("  ↳ 点「➕ 添加账号」重新填一遍这把新密钥就行：填到同一台机器会**原地更新凭据**，不会多出一台。");
      } else {
        let reason = "";
        if (info.error !== null && info.error !== void 0) {
          reason = `（${String(info.error).slice(0, 60)}）`;
        }
        lines.push(`  本月用量: 查询失败${reason}`);
      }
      lines.push("");
      continue;
    }
    const used = info.trafficGb;
    lines.push(`  账号本月总用量: ${used.toFixed(2)} GB`);
    if (info.overseasFree > 0) {
      const remain = info.overseasFree - used;
      if (remain >= 0) {
        lines.push(
          `  非中国内地额度: ${info.overseasFree.toFixed(0)} GB，已用 ${(used / info.overseasFree * 100).toFixed(1)}%，剩 ${remain.toFixed(2)} GB`
        );
      } else {
        lines.push(
          `  非中国内地额度: ${info.overseasFree.toFixed(0)} GB，已超出 ${(-remain).toFixed(2)} GB（正在计费）`
        );
      }
    }
    if (info.mainlandFree > 0) {
      const remain = info.mainlandFree - used;
      if (remain >= 0) {
        lines.push(
          `  中国内地额度: ${info.mainlandFree.toFixed(0)} GB，已用 ${(used / info.mainlandFree * 100).toFixed(1)}%，剩 ${remain.toFixed(2)} GB`
        );
      } else {
        lines.push(
          `  中国内地额度: ${info.mainlandFree.toFixed(0)} GB，已超出 ${(-remain).toFixed(2)} GB（正在计费）`
        );
      }
    }
    if (info.count >= 2 && active.length) {
      const pool = Math.max(info.overseasFree, info.mainlandFree);
      if (pool > 0) {
        lines.push(
          `  提示: ${info.count} 台机器共享这一份额度，平均每台约 ${(pool / info.count).toFixed(0)} GB 才安全`
        );
      }
    }
    lines.push("");
  }
  if (groups.length >= 2) {
    lines.push("注意: 上面按 AccessKey 分组。若某两个账号其实是同一主账号下的不同子账号，");
    lines.push("它们的额度实际是共享的，请以阿里云控制台的「云数据传输」页面为准。");
  }
  return lines.join("\n");
}

export { buildSummaryText, groupByAccount, maskAk, quotaForGroup, summarizeAccounts, trafficForGroup };
