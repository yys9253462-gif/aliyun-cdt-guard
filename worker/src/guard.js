import { getAccountBalance, getCdtTrafficGb, getFreeQuotaGb, getInstanceBill, getInstanceStatus, isOverseasRegion, isSubrequestBudgetExhausted, resetSubrequestCount, startInstance, stopInstance } from './aliyun-api.js';
import { DEFAULT_BALANCE_LIMIT, DEFAULT_BILL_LIMIT, MONEY_COOLDOWN, NOTIFY_COOLDOWN, OVERLIMIT_COOLDOWN, QUOTA_COOLDOWN, QUOTA_WARN_LEVELS, appendTrafficHistoryBatch, bumpCounter, clearCounter, eventAllowed, formatMoney, formatDate, loadConfig, loadState, markEvent, nowLocal, nowSeconds, redact, sanitize, saveState } from './common.js';
import { ERR_CREDENTIAL, classifyError } from './credential-error.js';
import { sleep, throwIfCancelled, withOperationSignal } from './request-context.js';
import { sendAlert } from './telegram.js';

function makeLogger(tag) {
  return (message) => console.log(`[${tag}] ${message}`);
}
async function trackStatusChange(config, state, name, key, status, logger, user = null) {
  const record = state[key] || (state[key] = {});
  const previous = record.last_status;
  if (previous === void 0 || previous === null) {
    record.last_status = status;
    return;
  }
  if (previous !== status) {
    record.last_status = status;
    logger(`[${name}] 实例状态变化：${previous} -> ${status}`);
    // 机器人自己关的（超标止损 / 在机器人里手动关机）不算「意外停机」，不再推送误导性的提醒
    const botStopped = Boolean(record.stop_sent_at) || Boolean(user && user.manual_stopped);
    if (previous === "Running" && status === "Stopped" && botStopped) {
      logger(`[${name}] 已按机器人的关机指令停止`);
    } else if (previous === "Running" && status === "Stopped") {
      const eventKey = `${key}:status_down`;
      if (eventAllowed(state, eventKey, "status_down", NOTIFY_COOLDOWN)) {
        const msg = `机器: ${sanitize(name)}
状态变化: 运行中 -> 已停止
如果这不是你主动关的，说明实例被意外停机了。
脚本会按现有规则处理（流量安全时自动开机）。`;
        if (await sendAlert(config, "实例已停止", msg, "warn", logger)) {
          markEvent(state, eventKey, "status_down");
        }
      }
    }
  }
}
// 额度提醒和突增预警是「额度池」级别的事：同一账号、同一池的多台机器看到的是同一个数，
// 按机器各推一条就是重复。事件键按「账号 + 池」算，一个池只推一条。
function poolEventKey(user, region, fallbackKey) {
  const ak = String(user && user.ak || "").trim();
  if (!ak) return fallbackKey;
  let h = 5381;
  for (let i = 0; i < ak.length; i += 1) h = (h * 33 ^ ak.charCodeAt(i)) >>> 0;
  return `acct:${h.toString(36)}:${isOverseasRegion(region) ? "overseas" : "mainland"}`;
}
async function checkQuotaProgress(config, state, name, key, trafficGb, region, logger, user = null) {
  if (trafficGb < 0) {
    return;
  }
  const freeGb = getFreeQuotaGb(region);
  if (freeGb <= 0) {
    return;
  }
  const percent = trafficGb / freeGb * 100;
  // 从高档往低档看，只处理「已经达到的最高一档」：
  // 一轮里从 70% 跳到 96% 时只发 95% 那条；95% 发过以后也不再补发 80%。
  const levels = [...QUOTA_WARN_LEVELS].sort((x, y) => y - x);
  const level = levels.find((lv) => percent >= lv);
  if (level === void 0) return;
  const eventKey = `${poolEventKey(user, region, key)}:quota_${level}`;
  if (!eventAllowed(state, eventKey, `quota_${level}`, QUOTA_COOLDOWN)) return;
  const area = isOverseasRegion(region) ? "非中国内地" : "中国内地";
  const remain = freeGb - trafficGb;
  const msg = `机器: ${sanitize(name)}
本月已用流量: ${trafficGb.toFixed(2)} GB
免费额度: ${freeGb.toFixed(0)} GB/月（${area}）
已使用 ${percent.toFixed(1)}%，剩余 ${remain.toFixed(2)} GB` + (remain <= 0 ? "\n注意: 免费额度已用尽，继续跑将开始产生费用。" : "");
  const title = remain <= 0 ? "免费额度已用尽" : "免费额度即将用尽";
  const levelName = level < 95 ? "warn" : "danger";
  if (await sendAlert(config, title, msg, levelName, logger)) {
    markEvent(state, eventKey, `quota_${level}`);
  }
}
async function checkMoney(user, config, state, name, key, logger) {
  // 余额和账单变化很慢，没必要每 5 分钟查一次（原来每台每天约 576 次财务接口调用）。
  // 改成每小时最多查一次，省下的子请求留给流量与开关机。
  const record = state[key] || (state[key] = {});
  if (nowSeconds() - Number(record.money_checked_at || 0) < MONEY_CHECK_INTERVAL) return;
  record.money_checked_at = nowSeconds();
  const balanceLimit = Number(user.balance_limit === void 0 ? DEFAULT_BALANCE_LIMIT : user.balance_limit);
  const billLimit = Number(user.bill_limit === void 0 ? DEFAULT_BILL_LIMIT : user.bill_limit);
  if (balanceLimit > 0) {
    let amount = null;
    let currency = "";
    try {
      const result = await getAccountBalance(
        user.ak,
        user.sk,
        user.region,
        user.bill_endpoint || ""
      );
      amount = result.amount;
      currency = result.currency;
    } catch (error) {
      amount = null;
    }
    if (amount !== null && amount < balanceLimit) {
      const eventKey = `${key}:balance_low`;
      if (eventAllowed(state, eventKey, "balance_low", MONEY_COOLDOWN)) {
        const msg = `机器: ${sanitize(name)}
当前账户余额: ${formatMoney(amount, currency, user.currency || "$")}
你设定的最低余额: ${formatMoney(balanceLimit, currency, user.currency || "$")}
` + (amount < 0 ? "状态: 已欠费！\n" : "") + `余额不足会导致实例被停机、快照被释放，请及时充值。`;
        const levelName = amount < 0 ? "danger" : "warn";
        const title = amount < 0 ? "账户已欠费" : "账户余额过低";
        if (await sendAlert(config, title, msg, levelName, logger)) {
          markEvent(state, eventKey, "balance_low");
        }
      }
    }
  }
  if (billLimit > 0) {
    let billAmount = null;
    let billCurrency = "";
    try {
      const result = await getInstanceBill(
        user.ak,
        user.sk,
        user.region,
        user.instance_id,
        user.bill_endpoint || ""
      );
      // 只有拿到的是这台机器自己的账单才判断警戒线；账号合计里有其他产品，会误报
      billAmount = result.scope === "account" ? null : result.amount;
      billCurrency = result.currency;
    } catch (error) {
      billAmount = null;
    }
    if (billAmount !== null && billAmount >= 0 && billAmount > billLimit) {
      const eventKey = `${key}:bill_over`;
      if (eventAllowed(state, eventKey, "bill_over", MONEY_COOLDOWN)) {
        const msg = `机器: ${sanitize(name)}
本月账单已产生: ${formatMoney(billAmount, billCurrency, user.currency || "$")}
你设定的警戒线: ${formatMoney(billLimit, billCurrency, user.currency || "$")}
账单金额已超过警戒线，通常意味着流量已进入付费阶梯，或者实例规格 / 磁盘产生了额外费用。
建议去阿里云控制台「费用中心」核对明细。`;
        if (await sendAlert(config, "本月账单超支", msg, "warn", logger)) {
          markEvent(state, eventKey, "bill_over");
        }
      }
    }
  }
}
async function tryStart(user, config, state, name, key, trafficGb, logger) {
  const record = state[key] || (state[key] = {});
  const failures = Number(record.start_failures || 0);
  if (failures >= MAX_START_FAILURES) {
    const last = Number(record.last_retry_ts || 0);
    const elapsed = nowSeconds() - last;
    if (elapsed < RESOURCE_RETRY_COOLDOWN) {
      logger(`[${name}] 已连续 ${failures} 次开机失败，${Math.floor(RESOURCE_RETRY_COOLDOWN - elapsed)} 秒后才会再试，本轮跳过`);
      return;
    }
    logger(`[${name}] 已连续 ${failures} 次开机失败，冷却结束，再次尝试`);
  }
  record.last_retry_ts = nowSeconds();
  try {
    await startInstance(user.ak, user.sk, user.region, user.instance_id);
    logger(`[${name}] 已下发开机指令，等待进入 Running...`);
  } catch (error) {
    const count = bumpCounter(state, key, "start_failures");
    const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB
开机指令下发失败: ${sanitize(error.message)}
累计失败 ${count} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60} 分钟自动重试，无需手动干预。`;
    if (eventAllowed(state, key, "start_failed")) {
      if (await sendAlert(config, "开机失败", msg, "danger", logger)) {
        markEvent(state, key, "start_failed");
      }
    }
    return;
  }
  // 不再原地轮询等它启动（原来最多等 90 秒，期间整个机器人都在排队、按钮没反应）。
  // 记下下发时间，由下一轮巡检确认结果：见 confirmStart。
  record.start_sent_at = nowSeconds();
  logger(`[${name}] 已下发开机指令，下一轮巡检确认是否启动成功`);
}
// 确认上一轮的自动开机结果。返回 true 表示本轮已处理完这台机器（不需要再走开机逻辑）。
async function confirmStart(user, config, state, name, key, trafficGb, status, logger) {
  const record = state[key] || (state[key] = {});
  if (!record.start_sent_at) return false;
  if (status === "Running") {
    delete record.start_sent_at;
    clearCounter(state, key, "start_failures");
    delete record.last_retry_ts;
    logger(`[${name}] 实例已恢复运行`);
    if (eventAllowed(state, key, "resumed")) {
      const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB
动作: 已自动开机恢复运行`;
      if (await sendAlert(config, "已恢复运行", msg, "info", logger)) {
        markEvent(state, key, "resumed");
      }
    }
    return true;
  }
  if (status === "Stopped") {
    const mins = Math.max(1, Math.round((nowSeconds() - Number(record.start_sent_at)) / 60));
    delete record.start_sent_at;
    const count = bumpCounter(state, key, "start_failures");
    logger(`[${name}] ${mins} 分钟前下发的开机没有成功，累计失败 ${count} 次`);
    if (eventAllowed(state, key, "start_failed")) {
      const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB
${mins} 分钟前已下发开机指令，但实例仍是「已停止」。
通常为库存不足（抢占式实例被回收后资源未释放），累计失败 ${count} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60} 分钟自动重试。`;
      if (await sendAlert(config, "开机未成功", msg, "danger", logger)) {
        markEvent(state, key, "start_failed");
      }
    }
    return false;
  }
  // Starting / Pending 等中间态：还在启动，下一轮再看
  logger(`[${name}] 开机中（${status}），下一轮再确认`);
  return true;
}
async function enforceStop(user, config, state, name, key, trafficGb, status, limitGb, logger) {
  if (status === "Running") {
    logger(`[${name}] 流量超标 ${trafficGb.toFixed(2)}GB / 阈值 ${limitGb.toFixed(0)}GB，正在强制关机`);
    // 上一轮已经下发过关机，这一轮查到还在 Running：关机没生效，必须告警
    const record = state[key] || (state[key] = {});
    if (record.stop_sent_at) {
      const mins = Math.max(1, Math.round((nowSeconds() - Number(record.stop_sent_at)) / 60));
      logger(`[${name}] ${mins} 分钟前已下发关机，但实例仍在运行，再次下发`);
      if (eventAllowed(state, key, "stop_ineffective")) {
        const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)
${mins} 分钟前已经下发了关机指令，但实例仍然是「运行中」。
脚本会每 5 分钟继续重试；请尽快登录阿里云控制台确认并手动关机。`;
        if (await sendAlert(config, "关机未生效", msg, "danger", logger)) {
          markEvent(state, key, "stop_ineffective");
        }
      }
    }
    try {
      await stopInstance(user.ak, user.sk, user.region, user.instance_id);
      if (!record.stop_sent_at) record.stop_sent_at = nowSeconds();
    } catch (error) {
      logger(`[${name}] 关机指令下发失败: ${redact(error.message)}`);
      if (eventAllowed(state, key, "stop_failed")) {
        const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB
止损关机指令下发失败: ${sanitize(error.message)}
请立即登录阿里云控制台手动关机！`;
        if (await sendAlert(config, "止损关机失败", msg, "danger", logger)) {
          markEvent(state, key, "stop_failed");
        }
      }
      return;
    }
    if (eventAllowed(state, key, "overlimit", OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)
动作: 已下发关机指令（下一轮巡检会确认是否真的停了）`;
      if (await sendAlert(config, "流量超标已止损", msg, "danger", logger)) {
        markEvent(state, key, "overlimit");
      }
    }
  } else if (status === "Starting" || status === "Pending") {
    // 中间态（正在启动 / 创建中）：原来会被当成「已停止」跳过，机器起来后要等下一轮才关。
    // 现在直接下发关机；阿里云不接受时（状态不对）不告警，下一轮（5 分钟后）再关。
    logger(`[${name}] 流量超标，实例处于中间态 ${status}，尝试关机`);
    try {
      await stopInstance(user.ak, user.sk, user.region, user.instance_id);
      logger(`[${name}] 中间态关机指令已下发`);
    } catch (error) {
      logger(`[${name}] 中间态暂不能关机（${redact(error.message)}），下一轮重试`);
    }
  } else if (status === "Stopping") {
    logger(`[${name}] 流量超标，实例正在停止中`);
  } else {
    logger(`[${name}] 流量超标，实例已处于停止状态`);
    if (eventAllowed(state, key, "overlimit", OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)
状态: 流量超标，保持关机中`;
      if (await sendAlert(config, "流量超标提醒", msg, "warn", logger)) {
        markEvent(state, key, "overlimit");
      }
    }
  }
}
// 暂停监控的机器不会被自动关机。如果流量已经超过阈值，每天提醒一次，
// 免得「暂停后忘了恢复」一直在花钱。只查流量（同账号有缓存），查不到就静默跳过。
async function remindPausedOverLimit(user, config, state, name, key, logger) {
  const { limitGb } = parseTrafficLimit(user.traffic_limit);
  const eventKey = `${key}:paused_over`;
  if (!eventAllowed(state, eventKey, "paused_over", OVERLIMIT_COOLDOWN)) return;
  let trafficGb;
  try {
    trafficGb = await getCdtTrafficGb(user.ak, user.sk, user.cdt_endpoint || "", user.region);
  } catch (error) {
    throwIfCancelled();
    return;
  }
  if (!(trafficGb >= limitGb)) return;
  const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)
这台机器的监控处于「暂停」状态，所以不会被自动关机。
如果不是有意为之，请在「单机操作」里点「▶️ 恢复监控」。`;
  if (await sendAlert(config, "已暂停的机器流量超标", msg, "warn", logger)) {
    markEvent(state, eventKey, "paused_over");
  }
}
// 记录流量采样并估算最近的增长速度（GB/小时）。
// 每 30 分钟最多记一个点、只保留最近 SURGE_WINDOW_HOURS 小时；跨月清零（流量回落）时重新开始。
// 跟着本轮 state 一起保存，不额外占用写入次数。
function trackTrafficRate(state, key, trafficGb, now = nowSeconds()) {
  const sampleKey = `${key}:samples`;
  let samples = Array.isArray(state[sampleKey]) ? state[sampleKey] : [];
  const last = samples[samples.length - 1];
  if (last && trafficGb < last[1]) samples = [];
  if (!last || now - last[0] >= SURGE_SAMPLE_INTERVAL || trafficGb < last[1]) {
    samples.push([now, Math.round(trafficGb * 1e3) / 1e3]);
  }
  samples = samples.filter(([ts]) => now - ts <= SURGE_WINDOW_HOURS * 3600);
  state[sampleKey] = samples;
  const oldest = samples[0];
  const hours = oldest ? (now - oldest[0]) / 3600 : 0;
  if (hours < SURGE_MIN_SPAN_HOURS) return null;
  return { rateGbPerHour: (trafficGb - oldest[1]) / hours, hours };
}
// 流量突增预警：阿里云的流量数据滞后 1~6 小时，阈值反应不过来。
// 按最近的增长速度推算「滞后时间内」会不会冲过免费额度，会的话提前告警（不自动关机）。
async function checkSurge(config, state, name, key, trafficGb, region, limitGb, logger, user = null) {
  const rate = trackTrafficRate(state, key, trafficGb);
  if (!rate || rate.rateGbPerHour < SURGE_MIN_RATE_GB_PER_HOUR) return;
  const freeGb = getFreeQuotaGb(region);
  const projected = trafficGb + rate.rateGbPerHour * SURGE_LAG_HOURS;
  if (projected < Math.min(freeGb, limitGb)) return;
  logger(`[${name}] 流量增长 ${rate.rateGbPerHour.toFixed(1)}GB/小时，${SURGE_LAG_HOURS} 小时后约 ${projected.toFixed(0)}GB`);
  const eventKey = `${poolEventKey(user, region, key)}:surge`;
  if (!eventAllowed(state, eventKey, "surge", SURGE_COOLDOWN)) return;
  const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB，免费额度 ${freeGb.toFixed(0)}GB)
最近 ${rate.hours.toFixed(1)} 小时增长约 ${rate.rateGbPerHour.toFixed(1)} GB/小时
阿里云流量数据通常滞后 1~${SURGE_LAG_HOURS} 小时，按这个速度实际用量可能已接近 ${projected.toFixed(0)}GB。
等数字显示超标再关机可能来不及；如果不是预期中的大流量，建议现在手动关机或调低阈值。`;
  if (await sendAlert(config, "流量突增预警", msg, "warn", logger)) {
    markEvent(state, eventKey, "surge");
  }
}
async function handleCheckFailure(state, config, name, key, error, logger) {
  const { kind, reason } = classifyError(error);
  const message = sanitize(reason);
  logger(`[${name}] 巡检出错: ${message}`);
  const count = bumpCounter(state, key, "check_failures");
  if (kind === ERR_CREDENTIAL) {
    const eventKey = `${key}:cred_failed`;
    if (eventAllowed(state, eventKey, "cred_failed", CREDENTIAL_ALERT_COOLDOWN)) {
      const msg = `机器: ${sanitize(name)}
⚠️ 这对阿里云凭据出了问题，流量监控与自动止损当前处于失效状态。

${message}

怎么处理（二选一）：
  1. 机器还在用 → 点「➕ 添加账号」重新填一份有效凭据；
  2. 机器已经不用了 / 在阿里云上删掉了 → 点下面的「\u{1F5D1} 删除这台机器」，把它从监控里摘掉，告警就不再出现。

（本提醒 7 天内只发一次，不会反复打扰。）`;
      const keyboard = [[
        { text: "\u{1F5D1} 删除这台机器", callback_data: `del:${key}` },
        { text: "➕ 添加账号", callback_data: "addacct" }
      ]];
      if (await sendAlert(config, "凭据失效（监控已中断）", msg, "danger", logger, keyboard)) {
        markEvent(state, eventKey, "cred_failed");
      }
    }
    return;
  }
  if (count >= CHECK_FAILURE_ALERT_THRESHOLD && eventAllowed(state, key, "check_failed")) {
    const msg = `机器: ${sanitize(name)}
已连续 ${count} 次巡检失败，最近错误: ${message}
期间流量监控与自动止损处于失效状态，请人工确认实例情况。`;
    if (await sendAlert(config, "监控异常", msg, "danger", logger)) {
      markEvent(state, key, "check_failed");
    }
  }
}
function parseTrafficLimit(raw) {
  const DEFAULT_GB = 180;
  if (raw === void 0) {
    return { limitGb: DEFAULT_GB, invalid: null };
  }
  if (typeof raw === "boolean") {
    return { limitGb: DEFAULT_GB, invalid: `布尔值 ${raw}（不是数字）` };
  }
  let value = raw;
  if (typeof raw === "string") {
    value = raw.trim();
    if (value === "") {
      return { limitGb: DEFAULT_GB, invalid: "空字符串" };
    }
  }
  if (value === null) {
    return { limitGb: DEFAULT_GB, invalid: "null" };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { limitGb: DEFAULT_GB, invalid: `无法转成数字（原值 ${JSON.stringify(raw)}）` };
  }
  if (num <= 0) {
    return { limitGb: DEFAULT_GB, invalid: `不是正数（${num}）` };
  }
  return { limitGb: num, invalid: null };
}
async function checkOne(env, user, config, state, logger, collector) {
  const instanceId = user.instance_id;
  const name = user.name || instanceId;
  const key = instanceId;
  if (env && config && !Object.prototype.hasOwnProperty.call(config, "__env")) {
    Object.defineProperty(config, "__env", {
      value: env,
      enumerable: false,
      writable: false,
      configurable: true
    });
  }
  if (user.paused) {
    logger(`[${name}] 监控已暂停，跳过`);
    await remindPausedOverLimit(user, config, state, name, key, logger);
    return;
  }
  const { ak, sk, region } = user;
  const parsed = parseTrafficLimit(user.traffic_limit);
  const limitGb = parsed.limitGb;
  if (parsed.invalid) {
    logger(`[${name}] ⚠️ 关机阈值不合法（${parsed.invalid}），已按默认 ${limitGb}GB 处理，本轮不会因此关机`);
  }
  const freeGb = getFreeQuotaGb(region);
  if (limitGb > freeGb) {
    const warnKey = `${key}:quota_warn`;
    if (eventAllowed(state, warnKey, "quota_warn", OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${sanitize(name)}
关机阈值设为 ${limitGb.toFixed(0)}GB，但本区域免费额度只有 ${freeGb.toFixed(0)}GB/月。
超出 ${(limitGb - freeGb).toFixed(0)}GB 的部分会真实产生费用，阈值内也可能在花钱。
建议把阈值设到免费额度以内（例如 ${Math.max(freeGb - 20, 1).toFixed(0)}GB）。`;
      logger(`[${name}] 阈值 ${limitGb.toFixed(0)}GB 高于免费额度 ${freeGb.toFixed(0)}GB，存在付费风险`);
      if (await sendAlert(config, "流量阈值高于免费额度", msg, "warn", logger)) {
        markEvent(state, warnKey, "quota_warn");
      }
    }
  }
  try {
    const trafficGb = await getCdtTrafficGb(ak, sk, user.cdt_endpoint || "", region);
    const status = await getInstanceStatus(ak, sk, region, instanceId);
    if (status === null) {
      // 实例在阿里云上找不到（已释放 / 编号或地域填错）：这台机器实际上已经没有任何保护，
      // 原来只写日志，现在推送一次（7 天内不重复），附「删除这台机器」按钮
      logger(`[${name}] 未找到实例 ${instanceId}，请检查实例编号与地域是否匹配`);
      const eventKey = `${key}:not_found`;
      if (eventAllowed(state, eventKey, "not_found", CREDENTIAL_ALERT_COOLDOWN)) {
        const msg = `机器: ${sanitize(name)}
在阿里云「${sanitize(region)}」地域找不到实例 ${sanitize(instanceId)}。
可能是实例已经释放，或者实例编号 / 地域填错了。这台机器目前没有任何流量保护。

· 机器已经不用了 → 点下面的「删除这台机器」把它从监控里摘掉；
· 机器还在 → 点「➕ 添加账号」重新扫描并加入。
（本提醒 7 天内只发一次。）`;
        const keyboard = [[
          { text: "🗑 删除这台机器", callback_data: `del:${key}` },
          { text: "➕ 添加账号", callback_data: "addacct" }
        ]];
        if (await sendAlert(config, "找不到实例（监控已失效）", msg, "danger", logger, keyboard)) {
          markEvent(state, eventKey, "not_found");
        }
      }
      return;
    }
    if (state[`${key}:not_found`]) delete state[`${key}:not_found`];
    clearCounter(state, key, "check_failures");
    if (state[`${key}:cred_failed`]) {
      delete state[`${key}:cred_failed`].cred_failed;
    }
    await trackStatusChange(config, state, name, key, status, logger, user);
    await checkQuotaProgress(config, state, name, key, trafficGb, region, logger, user);
    await checkMoney(user, config, state, name, key, logger);
    if (collector) {
      collector.push({ instanceId, name, trafficGb });
    }
    if (status === "Stopped" && state[key]) delete state[key].stop_sent_at;
    if ((trafficGb >= limitGb || user.manual_stopped) && state[key]) delete state[key].start_sent_at;
    if (trafficGb < limitGb && await confirmStart(user, config, state, name, key, trafficGb, status, logger)) {
      await checkSurge(config, state, name, key, trafficGb, region, limitGb, logger, user);
    } else if (trafficGb < limitGb) {
      if (state[key]) delete state[key].stop_sent_at;
      await checkSurge(config, state, name, key, trafficGb, region, limitGb, logger, user);
      if (status === "Stopped" && user.manual_stopped) {
        logger(`[${name}] 用户手动停机，保持停止，不自动开机`);
      } else if (status === "Stopped") {
        await tryStart(user, config, state, name, key, trafficGb, logger);
      } else if (status === "Running") {
        clearCounter(state, key, "start_failures");
        logger(`[${name}] 流量安全 ${trafficGb.toFixed(2)}GB / 阈值 ${limitGb.toFixed(0)}GB，实例运行中`);
      } else {
        logger(`[${name}] 实例处于中间态 ${status}，本轮不干预`);
      }
    } else {
      await enforceStop(user, config, state, name, key, trafficGb, status, limitGb, logger);
    }
  } catch (error) {
    throwIfCancelled();
    await handleCheckFailure(state, config, name, key, error, logger);
  }
}
async function checkWithTimeout(env, user, config, state, logger, collector) {
  const name = user.name || user.instance_id || "未知";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("单实例巡检超时")), USER_CHECK_TIMEOUT_MS);
  try {
    await withOperationSignal(controller.signal, () => checkOne(env, user, config, state, logger, collector));
    return true;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    logger(`[${name}] 单实例巡检超时，已中止请求与后续动作`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
// 整轮巡检失败（读不到配置/状态、存储写入失败等）时，所有机器的止损都停了。
// 原来只写日志，没人知道。现在连续失败 INSPECTION_FAIL_ALERT_THRESHOLD 轮就推送告警，
// 之后每小时最多一条；恢复后清零。计数单独存一个键，不依赖可能已经读不出来的 state。
async function reportInspectionFailure(env, error, logger) {
  try {
    const kv = env && env.CDT_GUARD_KV;
    if (!kv) return;
    const health = await kv.get(INSPECTION_HEALTH_KEY, "json") || {};
    health.failures = Number(health.failures || 0) + 1;
    // 先记下失败次数：如果下面读配置也失败（存储坏了），计数至少不会丢
    await kv.put(INSPECTION_HEALTH_KEY, JSON.stringify(health));
    const now = nowSeconds();
    if (health.failures >= INSPECTION_FAIL_ALERT_THRESHOLD && now - Number(health.last_alert || 0) >= NOTIFY_COOLDOWN) {
      const config = await loadConfig(env);
      Object.defineProperty(config, "__env", { value: env, enumerable: false, configurable: true });
      const msg = `已连续 ${health.failures} 轮巡检整体失败，所有机器的流量监控与自动止损都已停止。
最近错误: ${sanitize(error && error.message || "未知")}
请到 Cloudflare 仪表盘查看 cdt-guard 的实时日志。`;
      if (await sendAlert(config, "巡检整体失败（止损已停止）", msg, "danger", logger)) {
        health.last_alert = now;
        await kv.put(INSPECTION_HEALTH_KEY, JSON.stringify(health));
      }
    }
  } catch (e) {
    logger(`巡检失败告警本身也失败了: ${redact(e && e.message)}`);
  }
}
async function clearInspectionHealth(env) {
  try {
    const kv = env && env.CDT_GUARD_KV;
    if (!kv) return;
    const health = await kv.get(INSPECTION_HEALTH_KEY, "json");
    if (health && Number(health.failures || 0) > 0) await kv.delete(INSPECTION_HEALTH_KEY);
  } catch (_) {
  }
}
// 心跳：按小时记录巡检次数，日报里报「过去 24 小时巡检了几次」。
// Worker 整个不跑了它自己没法告警，所以把次数摆到日报里；次数偏少就说明有问题。
function hourBucket(date = nowLocal()) {
  return `${formatDate(date)}T${String(date.getUTCHours()).padStart(2, "0")}`;
}
function recordHeartbeat(state) {
  const hours = state.run_hours && typeof state.run_hours === "object" ? state.run_hours : {};
  const bucket = hourBucket();
  hours[bucket] = Number(hours[bucket] || 0) + 1;
  if (!state.heartbeat_since) state.heartbeat_since = nowSeconds();
  const keep = Object.keys(hours).sort().slice(-HEARTBEAT_KEEP_HOURS);
  state.run_hours = Object.fromEntries(keep.map((k) => [k, hours[k]]));
}
function heartbeatSummary(state, now = nowLocal()) {
  const hours = state && state.run_hours || {};
  let count = 0;
  for (let i = 0; i < 24; i += 1) {
    count += Number(hours[hourBucket(new Date(now.getTime() - i * 3600 * 1e3))] || 0);
  }
  // 刚开始统计时不足 24 小时，按已统计的时长折算应有次数，避免部署后第一份日报误报「偏少」
  const since = Number(state && state.heartbeat_since || 0);
  const elapsedHours = since ? Math.max(0, (now.getTime() - (since * 1e3 + 8 * 3600e3)) / 3600e3) : 24;
  const expected = Math.round(12 * Math.min(24, elapsedHours));
  const ok = count >= expected * 0.8;
  if (elapsedHours < 24) {
    return {
      count,
      ok,
      text: (ok ? "巡检心跳" : "⚠️ 巡检心跳偏少") + `: 统计开始 ${elapsedHours.toFixed(1)} 小时，已巡检 ${count} 次（应约 ${expected} 次）`
    };
  }
  return {
    count,
    ok,
    text: ok
      ? `巡检心跳: 过去 24 小时巡检 ${count} 次（正常约 ${expected} 次）`
      : `⚠️ 巡检心跳偏少: 过去 24 小时只巡检了 ${count} 次（正常约 ${expected} 次），请到 Cloudflare 仪表盘检查定时任务与日志`
  };
}
// 可选：配置了 HEARTBEAT_URL（例如 healthchecks.io 的地址）就在每轮巡检成功后访问一次，
// 长时间收不到时由对方通知你 —— 这样连 Worker 整个停了也能知道。失败不影响巡检。
async function pingHeartbeat(env, logger) {
  const url = String(env && env.HEARTBEAT_URL || "").trim();
  if (!/^https:\/\//.test(url)) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(5e3) });
  } catch (error) {
    logger(`心跳上报失败: ${redact(error && error.message)}`);
  }
}
async function runInspection(env, options = {}) {
  const logger = makeLogger("巡检");
  const lockKey = MANUAL_INSPECTION_LOCK;
  const now = nowSeconds();
  resetSubrequestCount();
  try {
    const config = await loadConfig(env);
    const state = await loadState(env);
    const users = config.users || [];
    const heldSince = Number(state[lockKey] || 0);
    if (!options.force && heldSince && now - heldSince < INSPECTION_LOCK_WINDOW) {
      logger(`距上次巡检仅 ${now - heldSince} 秒（< ${INSPECTION_LOCK_WINDOW} 秒），本次跳过以免状态冲突`);
      return { ok: true, skipped: true, checked: 0 };
    }
    if (!users.length) {
      logger("配置里没有机器，什么都不做");
      return { ok: true, checked: 0 };
    }
    state[lockKey] = now;
    logger(`开始巡检，共 ${users.length} 台机器`);
    const collector = [];
    let checked = 0;
    let budgetHit = false;
    let timedOut = false;
    const cursor = Math.max(0, Number(state.inspection_cursor) || 0) % users.length;
    const ordered = users.slice(cursor).concat(users.slice(0, cursor));
    for (const user of ordered) {
      if (isSubrequestBudgetExhausted()) {
        budgetHit = true;
        logger(
          `子请求预算已用完（已检查 ${checked}/${users.length} 台），本轮提前收尾以免整个请求失败。剩下的机器会在下一轮巡检补上。`
        );
        break;
      }
      if (!await checkWithTimeout(env, user, config, state, logger, collector)) timedOut = true;
      checked += 1;
    }
    state.inspection_cursor = (cursor + checked) % users.length;
    recordHeartbeat(state);
    await saveState(env, state);
    await appendTrafficHistoryBatch(env, collector);
    await pingHeartbeat(env, logger);
    await clearInspectionHealth(env);
    logger(`巡检结束（已检查 ${checked}/${users.length} 台）`);
    return { ok: true, checked, partial: budgetHit || timedOut, total: users.length };
  } catch (error) {
    logger(`巡检整体失败: ${redact(error && error.message)}`);
    await reportInspectionFailure(env, error, logger);
    return { ok: false, error: String(error && error.message) };
  }
}
var MAX_START_FAILURES, RESOURCE_RETRY_COOLDOWN, CHECK_FAILURE_ALERT_THRESHOLD, CREDENTIAL_ALERT_COOLDOWN, USER_CHECK_TIMEOUT_MS, START_WAIT_TIMEOUT_MS, START_POLL_INTERVAL_MS, MANUAL_INSPECTION_LOCK, INSPECTION_LOCK_WINDOW, INSPECTION_HEALTH_KEY, INSPECTION_FAIL_ALERT_THRESHOLD, SURGE_SAMPLE_INTERVAL, SURGE_WINDOW_HOURS, SURGE_MIN_SPAN_HOURS, SURGE_MIN_RATE_GB_PER_HOUR, SURGE_LAG_HOURS, SURGE_COOLDOWN, HEARTBEAT_KEEP_HOURS, MONEY_CHECK_INTERVAL;
MAX_START_FAILURES = 3;
RESOURCE_RETRY_COOLDOWN = 1800;
CHECK_FAILURE_ALERT_THRESHOLD = 3;
CREDENTIAL_ALERT_COOLDOWN = 604800;
USER_CHECK_TIMEOUT_MS = 1e5;
START_WAIT_TIMEOUT_MS = 9e4;
START_POLL_INTERVAL_MS = 8e3;
MANUAL_INSPECTION_LOCK = "manual_inspection_lock";
INSPECTION_LOCK_WINDOW = 180;
INSPECTION_HEALTH_KEY = "inspection_health";
INSPECTION_FAIL_ALERT_THRESHOLD = 3;
SURGE_SAMPLE_INTERVAL = 1800;
SURGE_WINDOW_HOURS = 6;
SURGE_MIN_SPAN_HOURS = 2;
SURGE_MIN_RATE_GB_PER_HOUR = 1;
SURGE_LAG_HOURS = 6;
SURGE_COOLDOWN = 10800;
HEARTBEAT_KEEP_HOURS = 26;
MONEY_CHECK_INTERVAL = 3600;

export { poolEventKey, MONEY_CHECK_INTERVAL, confirmStart, SURGE_LAG_HOURS, SURGE_MIN_RATE_GB_PER_HOUR, checkSurge, heartbeatSummary, hourBucket, pingHeartbeat, recordHeartbeat, trackTrafficRate, INSPECTION_FAIL_ALERT_THRESHOLD, INSPECTION_HEALTH_KEY, clearInspectionHealth, remindPausedOverLimit, reportInspectionFailure, CHECK_FAILURE_ALERT_THRESHOLD, CREDENTIAL_ALERT_COOLDOWN, INSPECTION_LOCK_WINDOW, MANUAL_INSPECTION_LOCK, MAX_START_FAILURES, RESOURCE_RETRY_COOLDOWN, START_POLL_INTERVAL_MS, START_WAIT_TIMEOUT_MS, USER_CHECK_TIMEOUT_MS, checkMoney, checkOne, checkQuotaProgress, checkWithTimeout, enforceStop, handleCheckFailure, makeLogger, parseTrafficLimit, runInspection, trackStatusChange, tryStart };
