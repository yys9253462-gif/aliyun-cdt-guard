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
 * 凭据类错误的提醒间隔（秒）—— 7 天。
 *
 * 为什么凭据类要单独一条通道、而且**不受普通冷却压制**：
 *   普通冷却（1 小时）是为「网络抖动」这类噪音设计的 —— 那种问题
 *   等一会儿自己会好，报多了纯属骚扰。
 *   但「AK 失效」不一样：**你不去换 Key，它就永远坏着**，
 *   而这段时间里流量监控和自动止损**全程失效**（可能一直在扣钱）。
 *
 * ⚠️ 间隔从 24 小时拉长到 7 天（2026-10-10，用户反馈后调整）：
 *   原因是「每 24 小时报一次」在**机器已被删除**这种场景下会变成
 *   永久骚扰 —— 用户没法让它停，因为 Key 永远修不好。
 *   现在首次告警里直接给了「删除这台机器」按钮，点一下就彻底解决；
 *   不去点的话，7 天内也不会再重复打扰。
 */
const CREDENTIAL_ALERT_COOLDOWN = 604800;
/** 单实例巡检软超时（毫秒）—— 覆盖正常的开机等待时间 */
const USER_CHECK_TIMEOUT_MS = 100000;
/** 等待实例进入 Running 的轮询参数 */
const START_WAIT_TIMEOUT_MS = 90000;
const START_POLL_INTERVAL_MS = 8000;

/**
 * 巡检软锁：手动巡检与定时巡检**共用**的互斥标记（存 state 的键名）。
 *
 * ⚠️ 键名必须与 bot-listener.js 读的是同一个，否则两边锁不到一起。
 *    已导出为常量，禁止在任何文件里另写字面量。
 */
export const MANUAL_INSPECTION_LOCK = 'manual_inspection_lock';
/**
 * 软锁时间窗（秒）—— 3 分钟。
 * 为什么是 3 分钟：定时巡检每 5 分钟一次，手动巡检一轮通常几秒到几十秒。
 * 设 3 分钟能挡住「刚跑完又手动点」和「手动跑着定时又进来」，
 * 又不会把正常的 5 分钟定时周期误挡掉。
 */
export const INSPECTION_LOCK_WINDOW = 180;

/** 巡检轮转起点（state 里的键）：预算不够查完时，下一轮从这里开始 */
export const INSPECTION_CURSOR_KEY = 'inspection_cursor';

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
    // ---- A. 凭据类：只发一次，带「删除这台机器」按钮 ----
    //
    // ⚠️ 设计变更（2026-10-10，用户反馈）：
    //   用户原话：「凡是删除的或者失效的应该询问我是否删除，
    //             而不是一直报巡检失败」
    //
    //   旧行为：每 24 小时重复发一次「凭据失效」，永不停止。
    //     问题：如果这台机器在阿里云上**已经被删了**（用户换了账号、
    //     把旧实例释放了），那这个 Key 永远修不好 —— 告警就会
    //     **一天一次永远刷下去**，用户既无法消除它，也不知道能删掉它。
    //     截图实测：连续 16 次巡检失败后仍在报。
    //
    //   新行为：首次发现时发**一条**告警，并附上「删除这台机器」按钮。
    //     你点一下按钮就删掉了，告警彻底消失。
    //     如果不去点，它在 7 天内不会重复打扰（见 CREDENTIAL_ALERT_COOLDOWN）。
    //     如果真的只是密钥过期、你想换新的，点「➕ 添加账号」重填即可 ——
    //     换好之后状态恢复正常，这条记录也会自动清掉。
    const eventKey = `${key}:cred_failed`;
    if (common.eventAllowed(state, eventKey, 'cred_failed', CREDENTIAL_ALERT_COOLDOWN)) {
      const msg = `机器: ${common.sanitize(name)}\n`
        + `⚠️ 这对阿里云凭据出了问题，流量监控与自动止损当前处于失效状态。\n\n`
        + `${message}\n\n`
        + `怎么处理（二选一）：\n`
        + `  1. 机器还在用 → 点「➕ 添加账号」重新填一份有效凭据；\n`
        + `  2. 机器已经不用了 / 在阿里云上删掉了 → 点下面的`
        + `「🗑 删除这台机器」，把它从监控里摘掉，告警就不再出现。\n\n`
        + `（本提醒 7 天内只发一次，不会反复打扰。）`;
      // 带按钮：直接删除这台失效机器
      const keyboard = [[
        { text: '🗑 删除这台机器', callback_data: `del:${key}` },
        { text: '➕ 添加账号', callback_data: 'addacct' },
      ]];
      if (await sendAlert(config, '凭据失效（监控已中断）', msg, 'danger', logger, keyboard)) {
        common.markEvent(state, eventKey, 'cred_failed');
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

/**
 * 解析单台机器的「关机阈值」（GB）。
 *
 * 🔴 这是一个会造成**真金白银损失**的函数，务必读清楚为什么这么啰嗦：
 *
 *     最初的写法是一行：
 *         const limitGb = Number(user.traffic_limit === undefined ? 180 : user.traffic_limit);
 *
 *     它的问题：`=== undefined` 只挡住了「字段完全不存在」这一种情况。
 *     而实际上可能出现的坏值有：
 *         null      → Number(null)      = 0
 *         ''        → Number('')        = 0
 *         '   '     → Number('   ')     = 0
 *         'abc'     → Number('abc')     = NaN
 *         -5        → Number(-5)        = -5
 *         true      → Number(true)      = 1
 *     一旦算出来是 0 或负数，下游判断 `trafficGb < limitGb` 就变成
 *     「流量 < 0」→ 永假 → **直接跳进强制关机分支**，
 *     而且每 5 分钟一轮、轮轮都关，用户完全不知道为什么机器老是被关。
 *     算出来是 NaN 更糟：NaN 参与的任何比较都是 false，
 *     同样会掉进 else（关机）分支。
 *
 *     所以这里的策略是：**只要拿不准，就退回默认 180，绝不冒险关机。**
 *     宁可漏关一次（用户亏点流量钱），也不能乱关（用户业务直接挂）。
 *
 * @returns {{ limitGb: number, invalid: string|null }}
 *          invalid 非空表示入参非法、已回退默认值，原因写在这里供日志用。
 */
export function parseTrafficLimit(raw) {
  const DEFAULT_GB = 180;

  // 字段完全缺失（老版本配置里没有这个字段）→ 用默认值，不算异常
  if (raw === undefined) {
    return { limitGb: DEFAULT_GB, invalid: null };
  }

  // 布尔值不是合法阈值 —— 注意 Number(true)===1 这种坑
  if (typeof raw === 'boolean') {
    return { limitGb: DEFAULT_GB, invalid: `布尔值 ${raw}（不是数字）` };
  }

  // 字符串先去掉空白，再判断空串
  let value = raw;
  if (typeof raw === 'string') {
    value = raw.trim();
    if (value === '') {
      return { limitGb: DEFAULT_GB, invalid: '空字符串' };
    }
  }

  // null 单独挡 —— Number(null) 是 0，不是 NaN，最危险
  if (value === null) {
    return { limitGb: DEFAULT_GB, invalid: 'null' };
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

/**
 * 巡检单个实例。
 *
 * @param {Array} [collector] 可选的台账收集器。传了就把本机的流量快照 push 进去，
 *        由调用方在一轮结束后**批量写一次 KV**（省额度，见 appendTrafficHistoryBatch）。
 *        不传则跳过台账记录（单机调用场景）。
 */
async function checkOne(env, user, config, state, logger, collector) {
  const instanceId = user.instance_id;
  const name = user.name || instanceId;
  const key = instanceId;

  // 把 env 挂到 config 上带下去。
  //
  // 为什么这么做（而不是给每个子函数都加一个 env 参数）：
  //     「告警发不出去」那个坑的根因是 sendAlert 拿不到 env，
  //     所以它读不到 Cloudflare 上的 TELEGRAM_BOT_TOKEN。
  //     sendAlert 的调用点散布在 trackStatusChange / checkQuotaProgress /
  //     checkMoney / tryStart / enforceStop / handleCheckFailure 六个函数里，
  //     逐个加参数要改 6 个签名 + 全部调用处，改动面大且容易漏。
  //     而这些函数**都已经收到 config 了**，借用它带下去最省事。
  //
  // 为什么用 defineProperty 而不用 config.env = env：
  //     普通赋值会让 env 变成**可枚举属性**，一旦 config 被 JSON.stringify
  //     回写 KV，整个环境变量（含 Telegram 令牌、阿里云密钥）就会被写进 KV。
  //     不可枚举属性不会被 JSON.stringify 带走，既传下去了又不会泄漏。
  if (env && config && !Object.prototype.hasOwnProperty.call(config, '__env')) {
    Object.defineProperty(config, '__env', {
      value: env,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  if (user.paused) {
    logger(`[${name}] 监控已暂停，跳过`);
    return;
  }

  const { ak, sk, region } = user;

  // 阈值解析：非法值一律回退 180，并明确记一条日志。
  // 这条日志很重要 —— 否则用户只会看到「机器莫名其妙被关了」，
  // 完全想不到是阈值字段写坏了。
  const parsed = parseTrafficLimit(user.traffic_limit);
  const limitGb = parsed.limitGb;
  if (parsed.invalid) {
    logger(`[${name}] ⚠️ 关机阈值不合法（${parsed.invalid}），已按默认 ${limitGb}GB 处理，本轮不会因此关机`);
  }

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
    // 第三参传 CDT 端点（国际站账号可覆盖，为空 = 国内站默认）。
    // 同一个 AK 的多台机器在一轮里只会真正查一次 —— aliyun-api 里
    // 有按 AK+端点的请求级缓存（账号级数据，重复查纯属浪费预算）。
    const trafficGb = await api.getCdtTrafficGb(ak, sk, user.cdt_endpoint || '');
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
    // ⚠️ 这里**不再直接写 KV**，而是把数据交给调用方（collector）统一收集。
    //    原因：免费版 KV 每天只有 1000 次写入，而巡检每 5 分钟一轮。
    //    如果每台机器都写一次，额度占用 = 台数 × 288，3 台就逼近上限、
    //    4 台必然超额。改成一轮批量写一次后，与台数解耦（恒为 288 次/天）。
    if (collector) {
      collector.push({ instanceId, name, trafficGb });
    }

    if (trafficGb < limitGb) {
      if (status === 'Stopped' && user.manual_stopped) {
        // 你在机器人里手动关的，不自动开回来（手动开机后会清掉这个记号）
        logger(`[${name}] 流量安全，但实例是手动关机的，本轮不自动开机`);
      } else if (status === 'Stopped') {
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
async function checkWithTimeout(env, user, config, state, logger, collector) {
  const name = user.name || user.instance_id || '未知';
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger(`[${name}] 单实例巡检超过 ${USER_CHECK_TIMEOUT_MS / 1000} 秒，已强制跳过以免阻塞其他实例`);
      resolve('timeout');
    }, USER_CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([checkOne(env, user, config, state, logger, collector), timeout]);
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
 *
 * ⚠️ 关于「手动巡检软锁」的历史坑（第五轮发现并修复）：
 *     早先只有 bot-listener.js 的手动巡检检查 `manual_inspection_lock`，
 *     而**定时巡检完全不看这个锁** —— 于是「注释里写的双向互斥」根本没实现：
 *     你点「立即巡检」的同时，5 分钟一次的定时巡检照跑不误，
 *     两轮巡检会同时读写同一份 state，**后写的把先写的覆盖掉**。
 *     现在把锁收进本函数（两条路共用的唯一入口），真正做到双向互斥。
 */
export async function runInspection(env, options = {}) {
  const logger = makeLogger('巡检');
  const lockKey = MANUAL_INSPECTION_LOCK;
  const now = common.nowSeconds();

  // 每一轮巡检开始都重置子请求计数 —— 计数器的生命周期就是「一次请求」，
  // 不重置的话第二次工具调用会带着上一次的余量开始，预算判断就失真了。
  api.resetSubrequestCount();

  try {
    const config = await common.loadConfig(env);
    const state = await common.loadState(env);
    const users = config.users || [];

    // ---- 软锁：3 分钟内已有巡检跑过（不管是手动还是定时），本次让路 ----
    // 用「上次巡检开始时间」而非「正在运行」来判断：Worker 无常驻内存，
    // 无法可靠知道另一实例是否真的还在跑，只能用时间窗近似。
    //
    // ⚠️ 为什么锁值在**本轮结束时**才写入（而不是进函数就写）：
    //     进函数就写虽然互斥更强，但会让每轮多一次 KV 写入 ——
    //     定时巡检 288 轮/天，再多 1 次就是 864 次/天（额度 1000，占 86%）。
    //     改成「结束时随本轮 saveState 一起写」则**零额外写入**，
    //     互斥效果几乎相同：并发进来的那一方（相差几秒~几十秒）依然看得到
    //     上一轮留下的时间戳，因为窗口是 180 秒 >> 一轮耗时。
    const heldSince = Number(state[lockKey] || 0);
    if (!options.force && heldSince && now - heldSince < INSPECTION_LOCK_WINDOW) {
      logger(`距上次巡检仅 ${now - heldSince} 秒（< ${INSPECTION_LOCK_WINDOW} 秒），本次跳过以免状态冲突`);
      return { ok: true, skipped: true, checked: 0 };
    }

    if (!users.length) {
      logger('配置里没有机器，什么都不做');
      return { ok: true, checked: 0 };
    }

    // 记录本轮开始时间，等会儿随 state 一起落盘（见下方 saveState）
    state[lockKey] = now;

    logger(`开始巡检，共 ${users.length} 台机器`);

    // 台账收集器：逐台收集，一轮结束**批量写一次** KV。
    // 为什么不在循环里逐台写：免费版 KV 每天只有 1000 次写入，
    // 逐台写会让额度占用 = 台数 × 288/天，几台机器就把额度吃光。
    const collector = [];

    // ---- 子请求预算保护（B5）----
    // 免费版单次请求最多 50 个子请求。机器多 + 接口抖动重试时很容易撞上，
    // 撞上的后果是**整个请求崩掉、本轮结果全丢**。
    // 这里改成「预算不够就停下，把已检查的结果正常保存并如实汇报」——
    // 少查几台只是延误，整轮崩掉才是真的影响止损。
    // 轮转起点：上一轮预算用完时，从「没查到的那台」开始，
    // 否则每轮都从第 1 台查起，排在后面的机器会永远查不到（也就永远不会被止损）。
    let cursor = Number(state[INSPECTION_CURSOR_KEY] || 0);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= users.length) {
      cursor = 0;
    }
    let checked = 0;
    let budgetHit = false;
    let nextCursor = 0;
    for (let i = 0; i < users.length; i += 1) {
      const index = (cursor + i) % users.length;
      if (api.isSubrequestBudgetExhausted()) {
        budgetHit = true;
        nextCursor = index;
        logger(
          `子请求预算已用完（已检查 ${checked}/${users.length} 台），` +
          '本轮提前收尾以免整个请求失败。剩下的机器会在下一轮巡检优先补上。'
        );
        break;
      }
      await checkWithTimeout(env, users[index], config, state, logger, collector);
      checked += 1;
      // 这台查到一半预算就用完了，它的结果不完整，下一轮从它开始重查
      if (api.isSubrequestBudgetExhausted() && i < users.length - 1) {
        budgetHit = true;
        nextCursor = index;
        logger(`子请求预算在检查第 ${checked} 台时用完，下一轮从这台开始补查`);
        break;
      }
    }
    if (nextCursor) {
      state[INSPECTION_CURSOR_KEY] = nextCursor;
    } else {
      delete state[INSPECTION_CURSOR_KEY];
    }

    // 一轮结束统一落盘：状态一次 + 台账一次 = 恒定 2 次写入，
    // 与机器台数**解耦**（原来是每台各写一次，额度随台数线性增长）。
    // 注意：这次 saveState 同时把本轮开始时间（软锁）写进去了，
    //       所以互斥**不额外花额度**。
    //
    // 为什么可以一轮只写一次（原本是「每台存一次防丢」）：
    //   · 整个循环只跑几十秒，中途挂掉的概率低；
    //   · 真中途挂了，丢的也只是「本轮冷却时间戳」这种可自愈的数据，
    //     不会丢配置、不会丢机器；
    //   · 而 saveState / 台账都已做「写失败不抛」保护，不会中断巡检。
    //   用「极小概率丢一点可自愈的计时数据」换「额度不随台数爆掉」，值。
    await common.saveState(env, state);
    await common.appendTrafficHistoryBatch(env, collector);

    logger(`巡检结束（已检查 ${checked}/${users.length} 台）`);
    // budgetHit 透传给上层，让它能在回执里如实说明「本轮没查完」
    return { ok: true, checked, partial: budgetHit, total: users.length };
  } catch (error) {
    logger(`巡检整体失败: ${common.redact(error && error.message)}`);
    return { ok: false, error: String(error && error.message) };
  }
}

export { checkOne, tryStart, enforceStop };
