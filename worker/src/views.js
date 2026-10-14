import { buildSummaryText } from './account-summary.js';
import { getAccountBalance, getCdtTrafficGb, getFreeQuotaGb, getInstanceBill, getInstanceDetail, getInstanceStatus, isOverseasRegion } from './aliyun-api.js';
import { DEFAULT_BALANCE_LIMIT, DEFAULT_BILL_LIMIT, loadHistory, nowLocal, sanitize } from './common.js';
import { regionDisplayWithCode } from './region-names.js';

var STATUS_CN = { Running: "运行中", Stopped: "已停止" };
function statusChinese(status) {
  if (!status) return "未知";
  return STATUS_CN[status] || status;
}
function gb(value) {
  return Number(value).toFixed(2);
}
async function buildStatus(config) {
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const lines = ["机器实时状态", ""];
  for (const user of users) {
    const name = sanitize(user?.name || user?.instance_id);
    if (user?.paused) {
      lines.push(`\xB7 ${name}`);
      lines.push("  监控: 已暂停");
      continue;
    }
    let statusCn;
    try {
      const status = await getInstanceStatus(
        user.ak,
        user.sk,
        user.region,
        user.instance_id
      );
      statusCn = status ? statusChinese(status) : "未查到（实例可能已释放）";
    } catch (error) {
      statusCn = `查询失败（${sanitize(error)}）`;
    }
    lines.push(`\xB7 ${name}`);
    lines.push(`  状态: ${statusCn}`);
    lines.push(`  地域: ${regionDisplayWithCode(user?.region)}`);
  }
  lines.push("");
  lines.push(`时间: ${nowLocal().toISOString().replace("T", " ").slice(0, 16)}`);
  return lines.join("\n");
}
async function buildTraffic(config) {
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const lines = ["流量与免费额度", ""];
  for (const user of users) {
    const name = sanitize(user?.name || user?.instance_id);
    const region = user?.region || "";
    const limit = Number(user?.traffic_limit ?? 180);
    if (user?.paused) {
      lines.push(`\xB7 ${name}`);
      lines.push("  监控: 已暂停");
      continue;
    }
    let traffic;
    try {
      traffic = await getCdtTrafficGb(user.ak, user.sk, region);
    } catch (error) {
      lines.push(`\xB7 ${name}`);
      lines.push(`  查询失败: ${sanitize(error)}`);
      continue;
    }
    const freeGb = getFreeQuotaGb(region);
    const area = isOverseasRegion(region) ? "非中国内地" : "中国内地";
    const remain = freeGb - traffic;
    lines.push(`\xB7 ${name}`);
    lines.push(`  地域: ${regionDisplayWithCode(region)}`);
    lines.push(`  已用: ${gb(traffic)} GB / 阈值 ${limit.toFixed(0)} GB`);
    lines.push(`  免费额度: ${freeGb.toFixed(0)} GB（${area}）`);
    if (remain >= 0) {
      lines.push(`  额度剩余: ${gb(remain)} GB`);
    } else {
      lines.push(`  已超出免费额度 ${gb(-remain)} GB，正在产生费用`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
async function buildBalance(config) {
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const lines = ["余额与账单详情", ""];
  const seen = /* @__PURE__ */ new Map();
  for (const user of users) {
    const name = sanitize(user?.name || user?.instance_id);
    const ak = String(user?.ak || "").trim();
    const region = user?.region || "";
    const defaultSymbol = user?.currency || "$";
    if (!seen.has(ak)) {
      try {
        const value = await getAccountBalance(
          ak,
          user?.sk || "",
          region,
          user?.bill_endpoint || ""
        );
        seen.set(ak, value);
      } catch (error) {
        seen.set(ak, { amount: null, currency: "" });
      }
    }
    const { amount } = seen.get(ak);
    const currency = seen.get(ak).currency;
    const symbol = { CNY: "\xA5", USD: "$" }[currency] || defaultSymbol;
    let balanceLine;
    if (amount === null || amount === void 0) {
      balanceLine = "查询失败";
    } else if (amount < 0) {
      balanceLine = `${symbol}${gb(amount)} [已欠费，请立即充值]`;
    } else {
      balanceLine = `${symbol}${gb(amount)}`;
    }
    lines.push(`\xB7 ${name}`);
    const limit = Number(user?.balance_limit ?? DEFAULT_BALANCE_LIMIT);
    if (limit > 0 && amount !== null && amount !== void 0) {
      if (amount < limit) {
        lines.push(`  账户余额: ${balanceLine}（警戒线 ${symbol}${gb(limit)}，已低于警戒线）`);
      } else {
        lines.push(`  账户余额: ${balanceLine}（警戒线 ${symbol}${gb(limit)}）`);
      }
    } else {
      lines.push(`  账户余额: ${balanceLine}`);
    }
    let billAmount = null;
    let billCurrency = "";
    try {
      const bill = await getInstanceBill(
        ak,
        user?.sk || "",
        region,
        user?.instance_id || "",
        user?.bill_endpoint || ""
      );
      billAmount = bill.amount;
      billCurrency = bill.currency;
    } catch (error) {
      billAmount = null;
    }
    const billSymbol = { CNY: "\xA5", USD: "$" }[billCurrency] || defaultSymbol;
    if (billAmount === null || billAmount === void 0 || billAmount < 0) {
      lines.push("  本月账单: 查询失败");
    } else {
      const billLimit = Number(user?.bill_limit ?? DEFAULT_BILL_LIMIT);
      let suffix = "";
      if (billLimit > 0 && billAmount > billLimit) {
        suffix = `（已超警戒线 ${billSymbol}${gb(billLimit)}）`;
      }
      lines.push(`  本月账单: ${billSymbol}${gb(billAmount)}${suffix}`);
    }
    let trafficGb = -1;
    try {
      trafficGb = await getCdtTrafficGb(ak, user?.sk || "", region);
    } catch (error) {
      trafficGb = -1;
    }
    const freeGb = getFreeQuotaGb(region);
    const area = isOverseasRegion(region) ? "非中国内地" : "中国内地";
    if (trafficGb >= 0) {
      const remain = freeGb - trafficGb;
      const percent = freeGb > 0 ? trafficGb / freeGb * 100 : 0;
      if (remain >= 0) {
        lines.push(
          `  免费额度: 已用 ${percent.toFixed(1)}%（${gb(trafficGb)} / ${freeGb.toFixed(0)} GB，${area}）`
        );
      } else {
        lines.push(`  免费额度: 已用尽，超出 ${gb(-remain)} GB 正在计费`);
      }
    }
    lines.push("");
  }
  lines.push(`时间: ${nowLocal().toISOString().replace("T", " ").slice(0, 16)}`);
  return lines.join("\n");
}
async function buildWeekly(env, config) {
  const history = await loadHistory(env);
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const now = nowLocal();
  const cutoffDate = new Date(now.getTime() - 7 * 86400 * 1e3).toISOString().slice(0, 10);
  const lines = [
    "流量周报（最近 7 天）",
    `统计区间: ${cutoffDate.slice(5)} ~ ${now.toISOString().slice(5, 10)}`,
    ""
  ];
  if (!history.length) {
    lines.push("台账里还没有数据。");
    lines.push("");
    lines.push("说明: 周报依赖巡检定期记录一次流量快照，");
    lines.push("运行满 1 天后就会有完整曲线。请稍后再看。");
    return lines.join("\n");
  }
  for (const user of users) {
    const iid = user?.instance_id || "";
    const name = sanitize(user?.name || iid);
    const points = history.filter((p) => p?.instance_id === iid && String(p?.date || "") >= cutoffDate).sort((a, b) => {
      const ka = `${a?.date || ""} ${a?.time || ""}`;
      const kb = `${b?.date || ""} ${b?.time || ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    lines.push(`\xB7 ${name}`);
    if (points.length < 2) {
      lines.push("  数据点不足，暂无法计算增量。");
      lines.push("");
      continue;
    }
    const first = points[0];
    const last = points[points.length - 1];
    const used = Number(last?.traffic_gb ?? 0) - Number(first?.traffic_gb ?? 0);
    if (used < 0) {
      lines.push("  本区间内账期重置过，累计用量无法直接相减。");
      lines.push(`  当前已用: ${gb(last?.traffic_gb ?? 0)} GB`);
    } else {
      lines.push(`  区间新增: ${gb(used)} GB`);
      lines.push(`  当前已用: ${gb(last?.traffic_gb ?? 0)} GB`);
      const freeGb = getFreeQuotaGb(user?.region || "");
      if (freeGb > 0) {
        lines.push(
          `  免费额度占用: ${(Number(last?.traffic_gb ?? 0) / freeGb * 100).toFixed(1)}%`
        );
      }
    }
    const days = Math.max(new Set(points.map((p) => p?.date)).size, 1);
    if (used >= 0) {
      lines.push(`  日均约: ${gb(used / days)} GB/天（覆盖 ${days} 天）`);
    }
    lines.push("");
  }
  lines.push("提示: 周报数据来自本系统台账，不含阿里云控制台的手工调整。");
  return lines.join("\n");
}
async function buildAccounts(config) {
  return buildSummaryText(config);
}
function money(amount, currency, defaultSymbol = "$") {
  if (amount === null || amount === void 0 || amount < 0) return "查询失败";
  const symbol = { CNY: "\xA5", USD: "$" }[currency] || defaultSymbol;
  return `${symbol}${gb(amount)}`;
}
async function buildReport(config) {
  const users = config?.users || [];
  const lines = [
    "[阿里云 CDT 流量守护 - 每日报表]",
    `日期: ${nowLocal().toISOString().slice(0, 10)}`,
    ""
  ];
  for (const user of users) {
    const name = sanitize(String(user?.name || "").trim() || user?.instance_id || "未命名");
    const instanceId = String(user?.instance_id || "").trim();
    const region = String(user?.region || "").trim();
    const quota = Number(user?.traffic_limit ?? 180);
    if (user?.paused) {
      lines.push(`\xB7 ${name}`);
      lines.push("  监控: 已暂停");
      lines.push("");
      continue;
    }
    const ak = String(user.ak || "").trim();
    const sk = String(user.sk || "").trim();
    let trafficGb = -1;
    try {
      trafficGb = await getCdtTrafficGb(ak, sk, region);
    } catch (error) {
      trafficGb = -1;
    }
    const detail = await getInstanceDetail(ak, sk, region, instanceId);
    let billAmount = null;
    let billCurrency = "";
    try {
      const bill = await getInstanceBill(
        ak,
        sk,
        region,
        instanceId,
        user?.bill_endpoint || ""
      );
      billAmount = bill.amount;
      billCurrency = bill.currency;
    } catch (error) {
      billAmount = null;
    }
    let balanceAmount = null;
    let balanceCurrency = "";
    try {
      const balance = await getAccountBalance(ak, sk, region, user?.bill_endpoint || "");
      balanceAmount = balance.amount;
      balanceCurrency = balance.currency;
    } catch (error) {
      balanceAmount = null;
      balanceCurrency = "";
    }
    const percent = trafficGb >= 0 && quota > 0 ? trafficGb / quota * 100 : 0;
    let trafficStr;
    if (trafficGb < 0) {
      trafficStr = "查询失败";
    } else {
      trafficStr = `${gb(trafficGb)} GB（阈值的 ${percent.toFixed(1)}%）`;
    }
    let verdict;
    if (trafficGb < 0) verdict = "流量查询异常";
    else if (trafficGb > quota) verdict = "流量已超标，已止损";
    else if (percent >= 80) verdict = "流量接近阈值，注意";
    else verdict = "正常";
    lines.push(`\xB7 ${name}（${detail.spec}）`);
    lines.push(`  状态: ${statusChinese(detail.status)}`);
    lines.push(`  地域: ${regionDisplayWithCode(region)}`);
    lines.push(`  公网IP: ${detail.ip}`);
    lines.push(`  流量: ${trafficStr} / 阈值 ${quota.toFixed(0)}GB`);
    if (trafficGb >= 0) {
      const freeGb = getFreeQuotaGb(region);
      const area = isOverseasRegion(region) ? "非中国内地" : "中国内地";
      const remain = freeGb - trafficGb;
      if (remain >= 0) {
        lines.push(`  免费额度: ${freeGb.toFixed(0)} GB/月（${area}）→ 免费额度剩 ${gb(remain)} GB`);
      } else {
        lines.push(
          `  免费额度: ${freeGb.toFixed(0)} GB/月（${area}）→ 已超出 ${gb(-remain)} GB，超出部分开始计费`
        );
      }
    }
    lines.push(`  本月账单: ${money(billAmount, billCurrency, user?.currency || "$")}`);
    let balanceStr;
    if (balanceAmount === null || balanceAmount === void 0) {
      balanceStr = "查询失败";
    } else {
      const balanceSymbol = { CNY: "\xA5", USD: "$" }[balanceCurrency] || user?.currency || "$";
      balanceStr = `${balanceSymbol}${gb(balanceAmount)}`;
      if (balanceAmount < 0) balanceStr += " [已欠费，请立即充值]";
    }
    lines.push(`  账户余额: ${balanceStr}`);
    lines.push(`  评价: ${verdict}`);
    lines.push("");
  }
  lines.push("提示: 流量达到阈值会自动关机止损，次月流量重置后自动开机。");
  const { groupByAccount: groupByAccount2 } = await import('./account-summary.js');
  if (groupByAccount2(users).length >= 2) {
    lines.push("");
    lines.push("-".repeat(30));
    lines.push("");
    lines.push(await buildSummaryText(config));
  }
  return lines.join("\n");
}

export { STATUS_CN, buildAccounts, buildBalance, buildReport, buildStatus, buildTraffic, buildWeekly, gb, money, statusChinese };
