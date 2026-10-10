/**
 * 巡检核心（Cloudflare Workers 版）
 *
 * 对应 Python 版的 guard.py。每 5 分钟由 Cron Trigger 拉起，逐个实例执行：
 *
 *     流量未超标 + 实例已停止  -> 自动开机（恢复业务）
 *     流量未超标 + 实例运行中  -> 记录日志，什么都不做
 *     流量已超标 + 实例运行中  -> 强制关机止损
 *     流量已超标 + 实例已停止  -> 保持关机，每天提醒一次
 *
 * 与 Python 版的关键差异（也是本方案存在的意义）：
 *   Python 版跑在被监控的机器上，机器一关脚本就死了，开不了机。
 *   本版本跑在 Cloudflare 上，机器关了它照样在跑 —— **所以自动开机是真的能用**。
 *
 * 另外去掉了两个在无服务器环境里没意义的东西：
 *   · 文件锁：Cron 触发天然串行，不会有并发覆盖问题
 *   · 信号超时：没有 SIGALRM，改用 Promise.race 做软超时
 */

import * as api from './aliyun-api.js';
import * as common from './common.js';
import { sendAlert } from './telegram.js';
import { classifyError, ERR_CREDENTIAL } from './credential-error.js';

/** 连续开机失败达到该次数后，降低重试频率 */
const MAX_START_FAILURES = 3;
/** 降频后的重试间隔（秒）—— 30 分钟 */
const RESOURCE_RETRY_COOLDOWN = 1800;
/** 连续巡检失败达到该次数，发出「监控失明」告警 */
const CHECK_FAILURE_ALERT_THRESHOLD = 3;
/**
 * 凭据类错误的提醒间隔（秒）—— 24 小时。
 *
 * 为什么凭据类要单独一条通道、而且**不受普通冷却压制**：
 *   普通冷却（1 小时）是为「网络抖动」这类噪音设计的 —— 那种问题
 *   等一会儿自己会好，报多了纯属骚扰。
 *   但「AK 失效」不一样：**你不去换 Key，它就永远坏着**，
 *   而这段时间里流量监控和自动止损**全程失效**（可能一直在扣钱）。
 *   所以这类错误必须持续提醒 —— 每天一次，直到你处理掉。
 */
const CREDENTIAL_ALERT_COOLDOWN = 86400;
/** 单实例巡检软超时（毫秒）—— 覆盖正常的开机等待时间 */
const USER_CHECK_TIMEOUT_MS = 100000;
/** 等待实例进入 Running 的轮询参数 */
const START_WAIT_TIMEOUT_MS = 90000;
const START_POLL_INTERVAL_MS = 8000;

/** 简易日志器：Workers 里日志会进 Cloudflare 后台 */
function makeLogger(tag) {
  return (message) => console.log(`[${tag}] ${message}`);
}

/**
 * 追踪实例状态变化：从「运行中」掉到「已停止」时立刻推送。
 *
 * 为什么要单独做这件事：
 *     巡检每 5 分钟跑一次，而默认行为是「流量安全 + 已停止 = 自动开机」。
 *     如果实例是被别人（或系统）意外停掉的，自动开机虽然会救回来，
 *     但如果不告诉你，你根本不知道机器曾经掉线过 —— 可能业务已经受影响。
 *     所以这里在状态发生「运行中 -> 已停止」的切换那一刻就推一条消息。
 */
async function trackStatusChange(config, state, name, key, status, logger) {
  const record = state[key] || (state[key] = {});
  const previous = record.last_status;

  // 首次见到这台机器只记状态，不报警（否则刚装完就报一堆「开机成功」的噪音）
  if (previous === undefined || previous === null) {
    record.last_status = status;
    return;
  }

  if (previous !== status) {
    record.last_status = status;
    logger(`[${name}] 实例状态变化：${previous} -> ${status}`);

    // 只在「运行中 -> 已停止」这个方向告警，这是业务受影响的方向。
    // 反方向（已停止 -> 运行中）由 tryStart 的「已恢复运行」负责，不重复。
    if (previous === 'Running' && status === 'Stopped') {
      const eventKey = `${key}:status_down`;
      if (common.eventAllowed(state, eventKey, 'status_down', common.NOTIFY_COOLDOWN)) {
        const msg = `机器: ${common.sanitize(name)}\n` +
          `状态变化: 运行中 -> 已停止\n` +
          `如果这不是你主动关的，说明实例被意外停机了。\n` +
          `脚本会按现有规则处理（流量安全时自动开机）。`;
        if (await sendAlert(config, '实例已停止', msg, 'warn', logger)) {
          common.markEvent(state, eventKey, 'status_down');
        }
      }
    }
  }
}

/**
 * 免费额度进度提醒：用量跨过 80% / 95% 档位时各提醒一次。
 *
 * 为什么有用：
 *     止损阈值是「你设的线」，而免费额度是「阿里云的钱包」。
 *     两者不一定重合 —— 如果阈值设得比免费额度高，你会在阈值内就开始花钱。
 *     所以在接近免费额度上限时提前打招呼，让你有时间决策。
 */
async function checkQuotaProgress(config, state, name, key, trafficGb, region, logger) {
  if (trafficGb < 0) {
    return;
  }
  const freeGb = api.getFreeQuotaGb(region);
  if (freeGb <= 0) {
    return;
  }
  const percent = (trafficGb / freeGb) * 100.0;

  for (const level of common.QUOTA_WARN_LEVELS) {
    if (percent < level) {
      continue;
    }
    const eventKey = `${key}:quota_${level}`;
    // 95% 档位一旦发过，就不再单独发 80% 的（避免同时补发两条）
    if (level === 80 && !common.eventAllowed(
      state, `${key}:quota_95`, 'quota_95', common.QUOTA_COOLDOWN
    )) {
      break;
    }
    if (!common.eventAllowed(state, eventKey, `quota_${level}`, common.QUOTA_COOLDOWN)) {
      continue;
    }
    const area = api.isOverseasRegion(region) ? '非中国内地' : '中国内地';
    const remain = freeGb - trafficGb;
    const msg = `机器: ${common.sanitize(name)}\n` +
      `本月已用流量: ${trafficGb.toFixed(2)} GB\n` +
      `免费额度: ${freeGb.toFixed(0)} GB/月（${area}）\n` +
      `已使用 ${percent.toFixed(1)}%，剩余 ${remain.toFixed(2)} GB` +
      (remain <= 0 ? '\n注意: 免费额度已用尽，继续跑将开始产生费用。' : '');
    const title = remain <= 0 ? '免费额度已用尽' : '免费额度即将用尽';
    const levelName = level < 95 ? 'warn' : 'danger';
    if (await sendAlert(config, title, msg, levelName, logger)) {
      common.markEvent(state, eventKey, `quota_${level}`);
    }
  }
}

/**
 * 余额过低 + 本月账单超支，两个跟钱有关的告警。
 *
 * 为什么合并在一起写：
 *     两者都要查财务接口、都要按「账户货币」格式化、冷却时间也一样，
 *     放一起能共用一次接口查询，少一次请求。
 */
async function checkMoney(user, config, state, name, key, logger) {
  const balanceLimit = Number(user.balance_limit === undefined
    ? common.DEFAULT_BALANCE_LIMIT : user.balance_limit);
  const billLimit = Number(user.bill_limit === undefined
    ? common.DEFAULT_BILL_LIMIT : user.bill_limit);

  // --- 账户余额 ---
  if (balanceLimit > 0) {
    let amount = null;
    let currency = '';
    try {
      const result = await api.getAccountBalance(
        user.ak, user.sk, user.region, user.bill_endpoint || ''
      );
      amount = result.amount;
      currency = result.currency;
    } catch (error) {
      amount = null;
    }

    if (amount !== null && amount < balanceLimit) {
      const eventKey = `${key}:balance_low`;
      if (common.eventAllowed(state, eventKey, 'balance_low', common.MONEY_COOLDOWN)) {
        const msg = `机器: ${common.sanitize(name)}\n` +
          `当前账户余额: ${common.formatMoney(amount, currency, user.currency || '$')}\n` +
          `你设定的最低余额: ${common.formatMoney(balanceLimit, currency, user.currency || '$')}\n` +
          (amount < 0 ? '状态: 已欠费！\n' : '') +
          `余额不足会导致实例被停机、快照被释放，请及时充值。`;
        const levelName = amount < 0 ? 'danger' : 'warn';
        const title = amount < 0 ? '账户已欠费' : '账户余额过低';
        if (await sendAlert(config, title, msg, levelName, logger)) {
          common.markEvent(state, eventKey, 'balance_low');
        }
      }
    }
  }

  // --- 本月账单 ---
  if (billLimit > 0) {
    let billAmount = null;
    let billCurrency = '';
    try {
      const result = await api.getInstanceBill(
        user.ak, user.sk, user.region, user.instance_id, user.bill_endpoint || ''
      );
      billAmount = result.amount;
      billCurrency = result.currency;
    } catch (error) {
      billAmount = null;
    }

    if (billAmount !== null && billAmount >= 0 && billAmount > billLimit) {
      const eventKey = `${key}:bill_over`;
      if (common.eventAllowed(state, eventKey, 'bill_over', common.MONEY_COOLDOWN)) {
        const msg = `机器: ${common.sanitize(name)}\n` +
          `本月账单已产生: ${common.formatMoney(billAmount, billCurrency, user.currency || '$')}\n` +
          `你设定的警戒线: ${common.formatMoney(billLimit, billCurrency, user.currency || '$')}\n` +
          `账单金额已超过警戒线，通常意味着流量已进入付费阶梯，` +
          `或者实例规格 / 磁盘产生了额外费用。\n` +
          `建议去阿里云控制台「费用中心」核对明细。`;
        if (await sendAlert(config, '本月账单超支', msg, 'warn', logger)) {
          common.markEvent(state, eventKey, 'bill_over');
        }
      }
    }
  }
}

/**
 * 流量安全但实例已停止，自动开机。
 *
 * 这是本方案的核心价值所在：因为跑在 Cloudflare 上，
 * 就算目标机器关着，这个函数照样会被执行 —— 所以能真的把它叫醒。
 */
async function tryStart(user, config, state, name, key, trafficGb, logger) {
  const record = state[key] || (state[key] = {});
  const failures = Number(record.start_failures || 0);

  if (failures >= MAX_START_FAILURES) {
    const last = Number(record.last_retry_ts || 0);
    const elapsed = common.nowSeconds() - last;
    if (elapsed < RESOURCE_RETRY_COOLDOWN) {
      logger(`[${name}] 已连续 ${failures} 次开机失败，` +
        `${Math.floor(RESOURCE_RETRY_COOLDOWN - elapsed)} 秒后才会再试，本轮跳过`);
      return;
    }
    logger(`[${name}] 已连续 ${failures} 次开机失败，冷却结束，再次尝试`);
  }

  record.last_retry_ts = common.nowSeconds();

  try {
    await api.startInstance(user.ak, user.sk, user.region, user.instance_id);
    logger(`[${name}] 已下发开机指令，等待进入 Running...`);
  } catch (error) {
    const count = common.bumpCounter(state, key, 'start_failures');
    const msg = `机器: ${common.sanitize(name)}\n当前流量: ${trafficGb.toFixed(2)}GB\n` +
      `开机指令下发失败: ${common.sanitize(error.message)}\n` +
      `累计失败 ${count} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60} 分钟自动重试，无需手动干预。`;
    if (common.eventAllowed(state, key, 'start_failed')) {
      if (await sendAlert(config, '开机失败', msg, 'danger', logger)) {
        common.markEvent(state, key, 'start_failed');
      }
    }
    return;
  }

  // 轮询确认是否真的起来了
  let waited = 0;
  let started = false;
  while (waited < START_WAIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS));
    waited += START_POLL_INTERVAL_MS;
    let current = 'Unknown';
    try {
      current = await api.getInstanceStatus(user.ak, user.sk, user.region, user.instance_id);
    } catch (error) {
      current = 'Unknown';
    }
    logger(`[${name}] 等待启动... 当前状态 ${current} (${waited / 1000}秒)`);
    if (current === 'Running') {
      started = true;
      break;
    }
    if (current === 'Stopped') {
      logger(`[${name}] 实例回落至 Stopped，开机被拒绝`);
      break;
    }
  }

  if (started) {
    common.clearCounter(state, key, 'start_failures');
    delete record.last_retry_ts;
    logger(`[${name}] 实例已恢复运行`);
    if (common.eventAllowed(state, key, 'resumed')) {
      const msg = `机器: ${common.sanitize(name)}\n当前流量: ${trafficGb.toFixed(2)}GB\n` +
        `动作: 已自动开机恢复运行`;
      if (await sendAlert(config, '已恢复运行', msg, 'info', logger)) {
        common.markEvent(state, key, 'resumed');
      }
    }
  } else {
    const count = common.bumpCounter(state, key, 'start_failures');
    logger(`[${name}] 启动超时或被拒绝，累计失败 ${count} 次`);
    if (common.eventAllowed(state, key, 'start_failed')) {
      const msg = `机器: ${common.sanitize(name)}\n当前流量: ${trafficGb.toFixed(2)}GB\n` +
        `已下发开机指令，但 ${START_WAIT_TIMEOUT_MS / 1000} 秒内未进入运行状态。\n` +
        `通常为库存不足（抢占式实例被回收后资源未释放），` +
        `累计失败 ${count} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60} 分钟自动重试。`;
      if (await sendAlert(config, '开机未成功', msg, 'danger', logger)) {
        common.markEvent(state, key, 'start_failed');
      }
    }
  }
}

/** 流量超标，强制关机止损 */
async function enforceStop(user, config, state, name, key, trafficGb, status, limitGb, logger) {
  if (status === 'Running') {
    logger(`[${name}] 流量超标 ${trafficGb.toFixed(2)}GB / 阈值 ${limitGb.toFixed(0)}GB，正在强制关机`);
    try {
      await api.stopInstance(user.ak, user.sk, user.region, user.instance_id);
    } catch (error) {
      logger(`[${name}] 关机指令下发失败: ${common.redact(error.message)}`);
      if (common.eventAllowed(state, key, 'stop_failed')) {
        const msg = `机器: ${common.sanitize(name)}\n当前流量: ${trafficGb.toFixed(2)}GB\n` +
          `止损关机指令下发失败: ${common.sanitize(error.message)}\n` +
          `请立即登录阿里云控制台手动关机！`;
        if (await sendAlert(config, '止损关机失败', msg, 'danger', logger)) {
          common.markEvent(state, key, 'stop_failed');
        }
      }
      return;
    }

    if (common.eventAllowed(state, key, 'overlimit', common.OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${common.sanitize(name)}\n` +
        `当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)\n` +
        `动作: 已强制关机止损`;
      if (await sendAlert(config, '流量超标已止损', msg, 'danger', logger)) {
        common.markEvent(state, key, 'overlimit');
      }
    }
  } else {
    logger(`[${name}] 流量超标，实例已处于停止状态`);
    if (common.eventAllowed(state, key, 'overlimit', common.OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${common.sanitize(name)}\n` +
        `当前流量: ${trafficGb.toFixed(2)}GB (阈值 ${limitGb.toFixed(0)}GB)\n` +
        `状态: 流量超标，保持关机中`;
      if (await sendAlert(config, '流量超标提醒', msg, 'warn', logger)) {
        common.markEvent(state, key, 'overlimit');
      }
    }
  }
}

/**
 * 巡检失败的处理。
 *
 * 分两条路：
 *
 *   A. **凭据类错误**（AK 失效 / 权限不够 / Key 被删）
 *      — 不处理就永远好不了，且期间监控全程失效。
 *        单独走「高优先级」通道：**首次立刻报**，之后**每天提醒一次**，
 *        不受普通 1 小时冷却压制。宁可烦一点，也不能让你在扣钱时毫不知情。
 *
 *   B. **暂时性错误**（网络抖动 / 限流）
 *      — 等一会儿自己会好，按原来的「连续 3 次 + 1 小时冷却」处理，
 *        避免刷屏。
 *
 * 两种情况都会把**中文原因**带上（走 credential-error.js 的统一识别），
 * 而不是只贴阿里云的英文原话。
 */
async function handleCheckFailure(state, config, name, key, error, logger) {
  const { kind, reason } = classifyError(error);
  const message = common.sanitize(reason);
  logger(`[${name}] 巡检出错: ${message}`);

  const count = common.bumpCounter(state, key, 'check_failures');

  if (kind === ERR_CREDENTIAL) {
    // ---- A. 凭据类：高优先级，每天提醒一次，直到修好 ----
    const eventKey = `${key}:cred_failed`;
    if (common.eventAllowed(state, eventKey, 'cred_failed', CREDENTIAL_ALERT_COOLDOWN)) {
      const msg = `机器: ${common.sanitize(name)}\n`
        + `⚠️ 这对阿里云凭据出了问题，流量监控与自动止损当前处于失效状态。\n\n`
        + `${message}\n\n`
        + `怎么修：在 Telegram 里点「➕ 添加账号」重新填一份有效凭据，`
        + `或点「🔑 凭据体检」查看所有账号的状态。\n`
        + `（在你处理之前，本提醒每天会发一次。）`;
      if (await sendAlert(config, '凭据失效（监控已中断）', msg, 'danger', logger)) {
        common.markEvent(state, eventKey, 'cred_failed');
        // 凭据问题解决了才该清这个标记，所以这里不动 check_failures 的冷却标记
      }
    }
    return;
  }

  // ---- B. 暂时性 / 未知：沿用原有阈值 + 冷却 ----
  if (count >= CHECK_FAILURE_ALERT_THRESHOLD
      && common.eventAllowed(state, key, 'check_failed')) {
    const msg = `机器: ${common.sanitize(name)}\n` +
      `已连续 ${count} 次巡检失败，最近错误: ${message}\n` +
      `期间流量监控与自动止损处于失效状态，请人工确认实例情况。`;
    if (await sendAlert(config, '监控异常', msg, 'danger', logger)) {
      common.markEvent(state, key, 'check_failed');
    }
  }
}

/** 巡检单个实例 */
async function checkOne(env, user, config, state, logger) {
  const instanceId = user.instance_id;
  const name = user.name || instanceId;
  const key = instanceId;

  if (user.paused) {
    logger(`[${name}] 监控已暂停，跳过`);
    return;
  }

  const { ak, sk, region } = user;
  const limitGb = Number(user.traffic_limit === undefined ? 180 : user.traffic_limit);

  // 安全护栏：若关机阈值高于本月免费额度，则超出的部分会真实产生费用。
  // 这种情况必须提醒 —— 否则可能误以为「还没到阈值 = 不花钱」。
  const freeGb = api.getFreeQuotaGb(region);
  if (limitGb > freeGb) {
    const warnKey = `${key}:quota_warn`;
    if (common.eventAllowed(state, warnKey, 'quota_warn', common.OVERLIMIT_COOLDOWN)) {
      const msg = `机器: ${common.sanitize(name)}\n` +
        `关机阈值设为 ${limitGb.toFixed(0)}GB，但本区域免费额度只有 ${freeGb.toFixed(0)}GB/月。\n` +
        `超出 ${(limitGb - freeGb).toFixed(0)}GB 的部分会真实产生费用，阈值内也可能在花钱。\n` +
        `建议把阈值设到免费额度以内（例如 ${Math.max(freeGb - 20, 1).toFixed(0)}GB）。`;
      logger(`[${name}] 阈值 ${limitGb.toFixed(0)}GB 高于免费额度 ${freeGb.toFixed(0)}GB，存在付费风险`);
      if (await sendAlert(config, '流量阈值高于免费额度', msg, 'warn', logger)) {
        common.markEvent(state, warnKey, 'quota_warn');
      }
    }
  }

  try {
    const trafficGb = await api.getCdtTrafficGb(ak, sk);
    const status = await api.getInstanceStatus(ak, sk, region, instanceId);

    if (status === null) {
      logger(`[${name}] 未找到实例 ${instanceId}，请检查实例编号与地域是否匹配`);
      return;
    }

    // 流量与状态都拿到了，说明监控是「睁眼」的，清掉失败计数
    common.clearCounter(state, key, 'check_failures');
    // 同时清掉「凭据失效」标记 —— 否则修好之后标记还留着，
    // 下次再出问题时会受 24 小时冷却影响而漏报。
    // ⚠️ 注意键名：markEvent 写的是 `${key}:cred_failed` 这一层，
    //    不是 `${key}` 这一层 —— 拿错层就清不掉（这个坑被测试抓到过）。
    if (state[`${key}:cred_failed`]) {
      delete state[`${key}:cred_failed`].cred_failed;
    }

    // ---- 状态变化追踪（运行中 -> 已停止时报警）----
    // 必须在决策之前记录，否则自动开机一执行，就永远看不到「掉线」那一瞬。
    await trackStatusChange(config, state, name, key, status, logger);

    // ---- 免费额度进度提醒（80% / 95%）----
    await checkQuotaProgress(config, state, name, key, trafficGb, region, logger);

    // ---- 余额 / 账单告警 ----
    await checkMoney(user, config, state, name, key, logger);

    // ---- 记录流量台账（周报数据源）----
    await common.appendTrafficHistory(env, instanceId, name, trafficGb);

    if (trafficGb < limitGb) {
      if (status === 'Stopped') {
        await tryStart(user, config, state, name, key, trafficGb, logger);
      } else if (status === 'Running') {
        common.clearCounter(state, key, 'start_failures');
        logger(`[${name}] 流量安全 ${trafficGb.toFixed(2)}GB / 阈值 ${limitGb.toFixed(0)}GB，实例运行中`);
      } else {
        logger(`[${name}] 实例处于中间态 ${status}，本轮不干预`);
      }
    } else {
      await enforceStop(user, config, state, name, key, trafficGb, status, limitGb, logger);
    }
  } catch (error) {
    await handleCheckFailure(state, config, name, key, error, logger);
  }
}

/**
 * 给单实例巡检加软超时，避免某个实例卡死拖垮整轮。
 *
 * 为什么用 Promise.race 而不是信号：
 *    Workers 里没有 SIGALRM 这种进程级信号，
 *    所以在超时点「放弃等待这个 Promise」是唯一可行的做法。
 */
async function checkWithTimeout(env, user, config, state, logger) {
  const name = user.name || user.instance_id || '未知';
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger(`[${name}] 单实例巡检超过 ${USER_CHECK_TIMEOUT_MS / 1000} 秒，已强制跳过以免阻塞其他实例`);
      resolve('timeout');
    }, USER_CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([checkOne(env, user, config, state, logger), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 巡检入口（由 Cron Trigger 调用）。
 *
 * 为什么要单独暴露这个函数：Worker 的 scheduled 事件会调它，
 * 同时机器人菜单的「立即巡检」也会调它 —— 两条路复用同一份逻辑。
 */
export async function runInspection(env) {
  const logger = makeLogger('巡检');

  try {
    const config = await common.loadConfig(env);
    const state = await common.loadState(env);
    const users = config.users || [];

    if (!users.length) {
      logger('配置里没有机器，什么都不做');
      return { ok: true, checked: 0 };
    }

    logger(`开始巡检，共 ${users.length} 台机器`);

    for (const user of users) {
      await checkWithTimeout(env, user, config, state, logger);
      // 每台跑完就存一次状态，避免后面的机器出错导致前面的记录丢失
      await common.saveState(env, state);
    }

    logger('巡检结束');
    return { ok: true, checked: users.length };
  } catch (error) {
    logger(`巡检整体失败: ${common.redact(error && error.message)}`);
    return { ok: false, error: String(error && error.message) };
  }
}

export { checkOne, tryStart, enforceStop };
