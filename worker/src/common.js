/**
 * 公共工具（Cloudflare Workers 版）
 *
 * 对应 Python 版的 common.py。差异在于：
 *   · 配置存在 KV 里（不再读本地文件）
 *   · 没有文件锁（Workers 天然单实例）
 *   · 日志走 console（在 Cloudflare 后台看）
 *   · 时间统一用东八区（阿里云控制台按东八区展示）
 */

// ---------------------------------------------------------------------------
// 常量（与 Python 版保持一致）
// ---------------------------------------------------------------------------

/** 通知冷却：同一事件 1 小时内不重复发送 */
export const NOTIFY_COOLDOWN = 3600;
/** 流量超标提醒：24 小时只发一次 */
export const OVERLIMIT_COOLDOWN = 86400;
/** 账单超支 / 余额过低：6 小时只发一次（避免每小时都骚扰） */
export const MONEY_COOLDOWN = 21600;
/** 免费额度进度提醒：同一档位在 24 小时内只发一次 */
export const QUOTA_COOLDOWN = 86400;

/** 免费额度进度提醒的触发档位（百分比） */
export const QUOTA_WARN_LEVELS = [80, 95];

/** 余额过低默认阈值（账户货币单位，可在配置里按实例覆盖） */
export const DEFAULT_BALANCE_LIMIT = 10.0;
/** 本月账单超支默认阈值（0 表示不启用账单告警） */
export const DEFAULT_BILL_LIMIT = 0.0;

/** 时区偏移（东八区） */
export const TIMEZONE_OFFSET_HOURS = 8;

/** 流量台账最多保留多少天 */
export const HISTORY_KEEP_DAYS = 60;

/** KV 里的键名 */
export const KV_CONFIG = 'config';
export const KV_STATE = 'state';
export const KV_HISTORY = 'traffic_history';
export const KV_SESSION = 'sessions';

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** 返回东八区的当前时间（阿里云控制台按东八区展示） */
export function nowLocal() {
  const now = new Date();
  return new Date(now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
}

/** 格式化时间为「年-月-日」 */
export function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 格式化时间为「时:分」 */
export function formatTime(date) {
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

/** 当前账期，形如 2026-10 */
export function currentBillingCycle() {
  return formatDate(nowLocal()).slice(0, 7);
}

/** 当前时间戳（秒） */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// 文本安全处理
// ---------------------------------------------------------------------------

/**
 * 清洗实例名 / 报错信息里的特殊字符。
 *
 * 为什么必须做：Telegram 的 Markdown 里 _ * ` [ ] 都是标记字符，
 * 用户给实例起名带了下划线（如 my_server）就会让整条消息解析失败。
 */
export function sanitize(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[_*`\[\]]/g, ' ')
    .trim();
}

const SECRET_KEYS = [
  'accesskeyid', 'accesskeysecret', 'signature', 'signaturenonce',
  'securitytoken', 'ststoken', 'authorization', 'credential', 'bot_token',
];

/**
 * 日志里不能出现密钥，做一次粗粒度遮蔽后再输出。
 *
 * 注意：Workers 的日志会保留在 Cloudflare 后台，
 * 所以这里必须屏蔽 —— 否则密钥会散落到日志系统里。
 *
 * ⚠️ 实现上踩过一个致命坑（务必看清再改）：
 *     曾经写成「找到 key 后，向后找等号，把等号后面的值换成 [已隐藏]」。
 *     看起来对，实际会**死循环**：因为 key 名本身没被遮蔽，
 *     替换完一轮后文本里还留着 key，下一轮又匹配到它，
 *     而这次等号后面的内容已经是 [已隐藏] 了、不含分隔符，
 *     于是算出的替换是「原样替换原样」——文本一个字都没变，循环永不结束。
 *
 *     在 Worker 里这意味着：任何一次接口报错都会让请求挂死到 CPU 超时。
 *     本地不联网测试时表现为「测试脚本跑到这里就没有输出了」。
 *
 * 现在改为**正则一次性替换，并且连 key 名一起吃掉**：
 *     AccessKeyId=LTAI5tSecretValue123  ->  [已隐藏]
 * 这样替换结果里不再含 key，天然不会重复匹配。
 */
export function redact(text) {
  let result = String(text === undefined || text === null ? '' : text);
  for (const key of SECRET_KEYS) {
    // 匹配「key 名 + 等号/冒号 + 值」，值到空白、& , } 或行尾为止。
    // 用 'gi' 一次性替换全部出现，不做 while 循环 —— 从根上消灭死循环的可能。
    const pattern = new RegExp(
      `${key}\\s*[=:]\\s*[^&\\s,}\\]]*`,
      'gi'
    );
    result = result.replace(pattern, '[已隐藏]');
  }
  return result;
}

/** 把金额格式化成带货币符号的字符串；无效值返回「查询失败」 */
export function formatMoney(amount, currency, defaultSymbol = '$') {
  if (amount === null || amount === undefined || amount < 0) {
    return '查询失败';
  }
  const symbols = { CNY: '¥', USD: '$' };
  const symbol = symbols[currency] || defaultSymbol;
  return `${symbol}${Number(amount).toFixed(2)}`;
}

/** 把余额格式化成一行文本；失败返回空串（不影响主流程） */
export function formatBalanceLine(amount, currency, defaultSymbol = '$', negativeNote = ' [已欠费]') {
  if (amount === null || amount === undefined) {
    return '';
  }
  const line = `\n账户余额: ${formatMoney(amount, currency, defaultSymbol)}`;
  return amount < 0 ? line + negativeNote : line;
}

// ---------------------------------------------------------------------------
// KV 绑定
// ---------------------------------------------------------------------------

/**
 * 取出 KV 命名空间。
 *
 * 为什么包一层而不是到处写 env.CDT_GUARD_KV：
 *     这种「绑定名」是最容易出低级错误的地方 ——
 *     wrangler.toml 里叫一个名字、代码里写另一个名字，
 *     部署时不会有任何报错，全都会静默变成「读不到数据」，
 *     表现是「配置莫名其妙变空了」，极难排查。
 *     集中在一处，改名字只需要动一行。
 *
 * 绑定名的唯一事实来源是 wrangler.toml 的 [[kv_namespaces]] binding 字段。
 * 现在两边统一为 CDT_GUARD_KV。
 */
function bucket(env) {
  return (env && env.CDT_GUARD_KV) || null;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 读取配置。
 *
 * 优先从环境变量读（部署时配置的），否则从 KV 读。
 * 环境变量的优先级更高 —— 这样改密钥不用动 KV。
 */
export async function loadConfig(env) {
  let config = null;

  if (env.CONFIG_JSON) {
    try {
      config = JSON.parse(env.CONFIG_JSON);
    } catch (error) {
      console.error('环境变量里的配置不是合法 JSON:', error.message);
    }
  }

  if (!config && bucket(env)) {
    config = await bucket(env).get(KV_CONFIG, 'json');
  }

  if (!config) {
    return { users: [], telegram: {} };
  }

  // 兼容顶层直接放 telegram 字段的写法
  if (!config.telegram && config.bot_token) {
    config.telegram = {
      bot_token: config.bot_token,
      chat_id: config.chat_id,
      admin_ids: config.admin_ids || [config.chat_id],
    };
  }

  if (!Array.isArray(config.users)) {
    config.users = [];
  }
  return config;
}

/** 保存配置到 KV */
export async function saveConfig(env, config) {
  if (!bucket(env)) {
    throw new Error('未绑定 KV 存储，无法保存配置');
  }
  await bucket(env).put(KV_CONFIG, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// 状态（通知冷却 / 失败计数）
// ---------------------------------------------------------------------------

/** 读取巡检状态 */
export async function loadState(env) {
  if (!bucket(env)) {
    return {};
  }
  const state = await bucket(env).get(KV_STATE, 'json');
  return state || {};
}

/** 保存巡检状态 */
export async function saveState(env, state) {
  if (!bucket(env)) {
    return;
  }
  await bucket(env).put(KV_STATE, JSON.stringify(state));
}

/** 判断某个事件是否已过冷却期，可以再次通知 */
export function eventAllowed(state, key, event, cooldown = NOTIFY_COOLDOWN) {
  const record = state[key] || {};
  const last = Number(record[event] || 0);
  return nowSeconds() - last >= cooldown;
}

/** 记录事件发生时间（用于冷却判断） */
export function markEvent(state, key, event) {
  if (!state[key]) {
    state[key] = {};
  }
  state[key][event] = nowSeconds();
}

/** 自增计数器，返回自增后的值 */
export function bumpCounter(state, key, counter, step = 1) {
  if (!state[key]) {
    state[key] = {};
  }
  state[key][counter] = Number(state[key][counter] || 0) + step;
  return state[key][counter];
}

/** 清零计数器 */
export function clearCounter(state, key, counter) {
  if (state[key]) {
    delete state[key][counter];
  }
}

// ---------------------------------------------------------------------------
// 流量历史台账（周报数据源）
// ---------------------------------------------------------------------------

/**
 * 读取流量台账（数组）。
 *
 * 台账记录每天的流量快照，供周报统计。
 */
export async function loadHistory(env) {
  if (!bucket(env)) {
    return [];
  }
  const history = await bucket(env).get(KV_HISTORY, 'json');
  return Array.isArray(history) ? history : [];
}

/**
 * 记录一次流量快照，供周报统计使用。
 *
 * 设计取舍：
 *   每次巡检（5 分钟）都追加一条会让数据膨胀得很快（一天 288 条 × 台数）。
 *   所以同一台机器**同一天只保留最新一条**，粒度按天 —— 周报看的是
 *   每日用量趋势，5 分钟级精度既没必要也浪费存储。
 */
export async function appendTrafficHistory(env, instanceId, name, trafficGb) {
  if (!bucket(env) || trafficGb === null || trafficGb === undefined || trafficGb < 0) {
    return;
  }

  const now = nowLocal();
  const day = formatDate(now);
  const record = {
    instance_id: instanceId,
    name,
    date: day,
    time: formatTime(now),
    traffic_gb: Math.round(Number(trafficGb) * 10000) / 10000,
  };

  let history = await loadHistory(env);

  // 同一天同一台机器只留最新一条
  history = history.filter(
    (item) => !(item.instance_id === instanceId && item.date === day)
  );
  history.push(record);

  // 裁掉过老的记录，防止数据无限增长
  const cutoffDate = new Date(now.getTime() - HISTORY_KEEP_DAYS * 86400 * 1000);
  const cutoff = formatDate(cutoffDate);
  history = history.filter((item) => String(item.date || '') >= cutoff);
  history.sort((a, b) => {
    const left = `${a.date || ''} ${a.time || ''}`;
    const right = `${b.date || ''} ${b.time || ''}`;
    return left < right ? -1 : (left > right ? 1 : 0);
  });

  await bucket(env).put(KV_HISTORY, JSON.stringify(history));
}

// ---------------------------------------------------------------------------
// 会话状态（三级菜单需要记住「刚点的是哪台机器」）
// ---------------------------------------------------------------------------

/**
 * 读取某个聊天会话的临时状态。
 *
 * 为什么要存这个：回复键盘的按钮文字不能携带隐藏数据，
 * 三级菜单（状态/开机/关机）的按钮不带机器名，
 * 所以只能记住「你刚点的是哪台机器」。
 */
export async function loadSessions(env) {
  if (!bucket(env)) {
    return {};
  }
  const sessions = await bucket(env).get(KV_SESSION, 'json');
  return sessions || {};
}

/** 记住某个会话当前选中的机器 */
export async function setCurrentDevice(env, chatId, instanceId) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  // ⚠️ 必须用**合并**而不是整体覆盖。
  //    原来这里是 sessions[key] = {instanceId, at}，一旦有了别的会话字段
  //    （比如「添加账号」这个多步流程的中间状态），就会被这一行**抹掉**。
  //    表现是：填到一半去点了台机器，回来发现流程状态没了。
  sessions[key] = Object.assign({}, sessions[key] || {}, {
    instanceId,
    at: nowSeconds(),
  });
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}

/** 读取某个会话当前选中的机器编号 */
export async function getCurrentDevice(env, chatId) {
  const sessions = await loadSessions(env);
  const record = sessions[String(chatId)];
  return record ? record.instanceId : null;
}

// ---------------------------------------------------------------------------
// 多步会话（向导）状态
// ---------------------------------------------------------------------------
/**
 * 存/取「正在进行的多步操作」的中间状态。
 *
 * 什么场景需要：像「添加阿里云账号」这种要连问好几步的流程
 * （先要 AK、再要 Secret、然后确认要不要加）。
 * Worker 没有任何常驻内存，每一步都是**独立的一次请求**，
 * 所以「上一步问到哪了」必须落盘，否则下一条消息来了不知道该怎么接。
 *
 * ⚠️ 为什么把流程状态和「当前选中的机器」放在同一个会话对象里：
 *    它们都是「这个聊天窗口的临时状态」，生命周期一样（都是几分钟的临时数据）。
 *    分开存会让 KV 里多出一堆 keys，还容易漏清理。
 *
 * 自动过期（TTL）：加账号流程里会经过用户的 Secret。
 *    我们**不把 Secret 落盘**（下一个函数专门说这事），但流程状态本身
 *    也不该长期留着 —— 所以超过 WIZARD_TTL_SECONDS 就当作过期作废。
 */
const WIZARD_TTL_SECONDS = 900; // 15 分钟：够慢慢填，又不至于一直挂着

/** 读取多步流程状态；不存在、或已过期，都返回 null */
export async function getWizard(env, chatId) {
  const sessions = await loadSessions(env);
  const record = sessions[String(chatId)] || {};
  const wizard = record.wizard;
  if (!wizard || typeof wizard !== 'object') {
    return null;
  }
  const at = Number(wizard.at || 0);
  if (nowSeconds() - at > WIZARD_TTL_SECONDS) {
    await clearWizard(env, chatId);
    return null;
  }
  return wizard;
}

/** 写入多步流程状态（自动带上时间戳） */
export async function setWizard(env, chatId, wizard) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  sessions[key] = Object.assign({}, sessions[key] || {}, {
    wizard: Object.assign({}, wizard, { at: nowSeconds() }),
  });
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}

/** 清掉多步流程状态（流程结束或取消时调用） */
export async function clearWizard(env, chatId) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  if (!sessions[key]) {
    return;
  }
  delete sessions[key].wizard;
  // 如果这个会话已经没有任何状态了，整个删掉，别在 KV 里留空对象
  if (!Object.keys(sessions[key]).length) {
    delete sessions[key];
  }
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
