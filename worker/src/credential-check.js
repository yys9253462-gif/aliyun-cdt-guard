import { groupByAccount, maskAk } from './account-summary.js';
import { describeRegions } from './aliyun-api.js';
import { ERR_CREDENTIAL, classifyError } from './credential-error.js';
import { LBL_ADD_ACCOUNT, LBL_DEVICES } from './menu-labels.js';

async function checkOneAccount(ak, sk) {
  try {
    const regions = await describeRegions(ak, sk);
    const ok = Array.isArray(regions);
    return { ok, kind: ok ? "ok" : "unknown", reason: "", raw: "" };
  } catch (error) {
    const { kind, reason, raw } = classifyError(error);
    return { ok: false, kind, reason, raw };
  }
}
async function checkAllCredentials(config) {
  const users = config?.users || [];
  const groups = [];
  let badCount = 0;
  for (const { ak, members } of groupByAccount(users)) {
    const sk = String(members[0]?.sk || "").trim();
    const result = await checkOneAccount(ak, sk);
    const names = members.map(
      (u) => String(u?.name || u?.instance_id || "未命名").trim()
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
      reason: result.reason
    });
  }
  return { groups, badCount, total: groups.length };
}
async function buildCredentialReport(config) {
  const users = config?.users || [];
  if (!users.length) {
    return "当前没有配置任何机器，没有凭据可检。\n\n先去「➕ 添加账号」加一个吧。";
  }
  const { groups, badCount, total } = await checkAllCredentials(config);
  const okCount = groups.filter((g) => g.ok).length;
  const tempFailed = groups.filter((g) => !g.ok && g.kind !== ERR_CREDENTIAL);
  const lines = [];
  lines.push("*\u{1F511} 凭据体检结果*");
  lines.push("");
  lines.push(`共 ${total} 个账号，其中 ${okCount} 个正常` + (badCount ? `，⚠️ ${badCount} 个凭据已失效` : "") + (tempFailed.length ? `，${tempFailed.length} 个暂时查不通` : "") + "。");
  lines.push("");
  for (const g of groups) {
    lines.push(`* 账号 ${g.akDisplay}（${g.count} 台机器）`);
    if (g.ok) {
      lines.push("  ✅ 凭据有效");
    } else if (g.kind === ERR_CREDENTIAL) {
      lines.push("  ❌ 凭据已失效 —— 该账号下的机器当前监控中断");
      lines.push("  影响的机器:");
      for (const n of g.names) {
        lines.push(`    \xB7 ${n}`);
      }
      lines.push("");
      lines.push(`  原因: ${g.reason.split("\n")[0]}`);
      lines.push("  怎么处理（二选一）:");
      lines.push(`   1. 机器还在用 → 点「${LBL_ADD_ACCOUNT}」重新填一份有效凭据。`);
      lines.push("      （同一账号下的机器会被认出，不会重复添加。）");
      lines.push("   2. 机器已经不用了 / 在阿里云上删掉了 →");
      lines.push(`      点「${LBL_DEVICES}」选中该机器，把它从监控里删除。`);
    } else {
      lines.push("  ⏳ 暂时查不通（不是凭据问题，稍后再试）");
      lines.push(`  原因: ${g.reason.split("\n")[0]}`);
    }
    lines.push("");
  }
  if (badCount) {
    lines.push("⚠️ 有凭据失效。在你修好之前，这些账号下的机器：");
    lines.push("\xB7 流量超标不会自动关机（可能一直在扣钱）");
    lines.push("\xB7 流量安全也不会自动开机");
    lines.push("请尽快处理。");
  }
  return lines.join("\n");
}
async function runScheduledCredentialCheck(config) {
  const users = config?.users || [];
  if (!users.length) {
    return { ok: true, badCount: 0, message: "" };
  }
  const { groups, badCount } = await checkAllCredentials(config);
  if (!badCount) {
    return { ok: true, badCount: 0, message: "" };
  }
  const lines = [];
  lines.push("⚠️ *发现失效的阿里云凭据*");
  lines.push("");
  for (const g of groups) {
    if (g.ok || g.kind !== ERR_CREDENTIAL) continue;
    lines.push(`账号 ${g.akDisplay}（${g.count} 台机器）`);
    lines.push(`  原因: ${g.reason.split("\n")[0]}`);
  }
  lines.push("");
  lines.push("这些账号下的机器当前监控已中断（不会自动止损 / 自动开机）。");
  lines.push("请点「\u{1F511} 凭据体检」看详情，或点「➕ 添加账号」重新填凭据。");
  return { ok: false, badCount, message: lines.join("\n") };
}

export { buildCredentialReport, checkAllCredentials, checkOneAccount, runScheduledCredentialCheck };
