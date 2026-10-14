import { getAccountBalance, getCdtTrafficGb, getFreeQuotaGb, getInstanceBill, getInstanceStatus, isOverseasRegion, isSubrequestBudgetExhausted, resetSubrequestCount, startInstance, stopInstance } from './aliyun-api.js';
import { DEFAULT_BALANCE_LIMIT, DEFAULT_BILL_LIMIT, MONEY_COOLDOWN, NOTIFY_COOLDOWN, OVERLIMIT_COOLDOWN, QUOTA_COOLDOWN, QUOTA_WARN_LEVELS, appendTrafficHistoryBatch, bumpCounter, clearCounter, eventAllowed, formatMoney, loadConfig, loadState, markEvent, nowSeconds, redact, sanitize, saveState } from './common.js';
import { ERR_CREDENTIAL, classifyError } from './credential-error.js';
import { sleep, throwIfCancelled, withOperationSignal } from './request-context.js';
import { sendAlert } from './telegram.js';

function makeLogger(tag) {
  return (message) => console.log(`[${tag}] ${message}`);
}
async function trackStatusChange(config, state, name, key, status, logger) {
  const record = state[key] || (state[key] = {});
  const previous = record.last_status;
  if (previous === void 0 || previous === null) {
    record.last_status = status;
    return;
  }
  if (previous !== status) {
    record.last_status = status;
    logger(`[${name}] 实例状态变化：${previous} -> ${status}`);
    if (previous === "Running" && status === "Stopped") {
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
async function checkQuotaProgress(config, state, name, key, trafficGb, region, logger) {
  if (trafficGb < 0) {
    return;
  }
  const freeGb = getFreeQuotaGb(region);
  if (freeGb <= 0) {
    return;
  }
  const percent = trafficGb / freeGb * 100;
  for (const level of QUOTA_WARN_LEVELS) {
    if (percent < level) {
      continue;
    }
    const eventKey = `${key}:quota_${level}`;
    if (level === 80 && !eventAllowed(
      state,
      `${key}:quota_95`,
      "quota_95",
      QUOTA_COOLDOWN
    )) {
      break;
    }
    if (!eventAllowed(state, eventKey, `quota_${level}`, QUOTA_COOLDOWN)) {
      continue;
    }
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
}
async function checkMoney(user, config, state, name, key, logger) {
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
      billAmount = result.amount;
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
  let waited = 0;
  let started = false;
  while (waited < START_WAIT_TIMEOUT_MS) {
    await sleep(START_POLL_INTERVAL_MS);
    waited += START_POLL_INTERVAL_MS;
    let current = "Unknown";
    try {
      current = await getInstanceStatus(user.ak, user.sk, user.region, user.instance_id);
    } catch (error) {
      throwIfCancelled();
      current = "Unknown";
    }
    logger(`[${name}] 等待启动... 当前状态 ${current} (${waited / 1e3}秒)`);
    if (current === "Running") {
      started = true;
      break;
    }
    if (current === "Stopped") {
      logger(`[${name}] 实例回落至 Stopped，开机被拒绝`);
      break;
    }
  }
  if (started) {
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
  } else {
    const count = bumpCounter(state, key, "start_failures");
    logger(`[${name}] 启动超时或被拒绝，累计失败 ${count} 次`);
    if (eventAllowed(state, key, "start_failed")) {
      const msg = `机器: ${sanitize(name)}
当前流量: ${trafficGb.toFixed(2)}GB
已下发开机指令，但 ${START_WAIT_TIMEOUT_MS / 1e3} 秒内未进入运行状态。
通常为库存不足（抢占式实例被回收后资源未释放），累计失败 ${count} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60} 分钟自动重试。`;
      if (await sendAlert(config, "开机未成功", msg, "danger", logger)) {
        markEvent(state, key, "start_failed");
      }
    }
  }
}
async function enforceStop(user, config, state, name, key, trafficGb, status, limitGb, logger) {
  if (status === "Running") {
    logger(`[${name}] 流量超标 ${trafficGb.toFixed(2)}GB / 阈值 ${limitGb.toFixed(0)}GB，正在强制关机`);
    try {
      await stopInstance(user.ak, user.sk, user.region, user.instance_id);
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
动作: 已强制关机止损`;
      if (await sendAlert(config, "流量超标已止损", msg, "danger", logger)) {
        markEvent(state, key, "overlimit");
      }
    }
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
    const trafficGb = await getCdtTrafficGb(ak, sk);
    const status = await getInstanceStatus(ak, sk, region, instanceId);
    if (status === null) {
      logger(`[${name}] 未找到实例 ${instanceId}，请检查实例编号与地域是否匹配`);
      return;
    }
    clearCounter(state, key, "check_failures");
    if (state[`${key}:cred_failed`]) {
      delete state[`${key}:cred_failed`].cred_failed;
    }
    await trackStatusChange(config, state, name, key, status, logger);
    await checkQuotaProgress(config, state, name, key, trafficGb, region, logger);
    await checkMoney(user, config, state, name, key, logger);
    if (collector) {
      collector.push({ instanceId, name, trafficGb });
    }
    if (trafficGb < limitGb) {
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
    await saveState(env, state);
    await appendTrafficHistoryBatch(env, collector);
    logger(`巡检结束（已检查 ${checked}/${users.length} 台）`);
    return { ok: true, checked, partial: budgetHit || timedOut, total: users.length };
  } catch (error) {
    logger(`巡检整体失败: ${redact(error && error.message)}`);
    return { ok: false, error: String(error && error.message) };
  }
}
var MAX_START_FAILURES, RESOURCE_RETRY_COOLDOWN, CHECK_FAILURE_ALERT_THRESHOLD, CREDENTIAL_ALERT_COOLDOWN, USER_CHECK_TIMEOUT_MS, START_WAIT_TIMEOUT_MS, START_POLL_INTERVAL_MS, MANUAL_INSPECTION_LOCK, INSPECTION_LOCK_WINDOW;
MAX_START_FAILURES = 3;
RESOURCE_RETRY_COOLDOWN = 1800;
CHECK_FAILURE_ALERT_THRESHOLD = 3;
CREDENTIAL_ALERT_COOLDOWN = 604800;
USER_CHECK_TIMEOUT_MS = 1e5;
START_WAIT_TIMEOUT_MS = 9e4;
START_POLL_INTERVAL_MS = 8e3;
MANUAL_INSPECTION_LOCK = "manual_inspection_lock";
INSPECTION_LOCK_WINDOW = 180;

export { CHECK_FAILURE_ALERT_THRESHOLD, CREDENTIAL_ALERT_COOLDOWN, INSPECTION_LOCK_WINDOW, MANUAL_INSPECTION_LOCK, MAX_START_FAILURES, RESOURCE_RETRY_COOLDOWN, START_POLL_INTERVAL_MS, START_WAIT_TIMEOUT_MS, USER_CHECK_TIMEOUT_MS, checkMoney, checkOne, checkQuotaProgress, checkWithTimeout, enforceStop, handleCheckFailure, makeLogger, parseTrafficLimit, runInspection, trackStatusChange, tryStart };
