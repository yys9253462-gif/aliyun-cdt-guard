/**
 * Telegram 收发层（Cloudflare Workers 版）
 *
 * 对应 Python 版的 notifier.py + bot_listener.py 的收发部分。
 *
 * 与 Python 版最大的差异：**收消息方式从长轮询改为 Webhook**。
 *   Python 版：自己写 while 循环不停问 Telegram「有新消息吗」（需要常驻进程）
 *   本版本：你点按钮 -> Telegram 主动推给 Cloudflare -> 处理完就结束
 *          这就是 Workers 这种无服务器环境的正确用法。
 */

import { sanitize } from './common.js';

const API_BASE = 'https://api.telegram.org/bot%s/%s';

/** 每种通知级别对应的图标（全中文界面，图标也统一） */
const LEVEL_ICON = {
  info: '\u2139\ufe0f',      // ℹ️
  warn: '\u26a0\ufe0f',      // ⚠️
  danger: '\U0001f6a8',      // 🚨
};

/** 每种通知级别对应的前缀文字 */
const LEVEL_PREFIX = {
  info: '提示',
  warn: '注意',
  danger: '严重',
};

/**
 * 粗判文本能否安全用 Markdown 解析，避免白白浪费一次请求。
 *
 * 为什么要做这个判断：
 *     Telegram 的 Markdown 里 `*` `_` `[` 都是标记，
 *     一旦**出现奇数个**（没配对），整条消息会被拒
 *     （报 "can't parse entities"），我们只能降级纯文本重发。
 *     虽然降级能兜住，但会白跑一次请求，还在日志里留下噪音。
 *
 *     这里只做**保守**判断：星号与反引号必须成偶数个才算安全。
 *     宁可误判为不安全（退回纯文本，消息照样能发出），
 *     也不要误判为安全（那就直接报错重发了）。
 */
export function markdownSafe(text) {
  if (!text) {
    return true;
  }
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;
  if (countOf(text, '*') % 2 !== 0) {
    return false;
  }
  if (countOf(text, '`') % 2 !== 0) {
    return false;
  }
  const opens = countOf(text, '[');
  const closes = countOf(text, ']');
  if (opens !== closes) {
    return false;
  }
  return true;
}

/**
 * 调用 Telegram 接口。失败返回 null。
 *
 * 超时用 AbortController 实现 —— Workers 里没有 requests 那样的 timeout 参数。
 */
async function callApi(token, method, payload = null, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_BASE.replace('%s', token).replace('%s', method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!data.ok) {
      console.warn(`调用 ${method} 失败:`, JSON.stringify(data).slice(0, 300));
      return null;
    }
    return data;
  } catch (error) {
    console.error(`调用 ${method} 异常:`, error && error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发送纯文本消息。keyboard 为内联键盘按钮（长在消息气泡里的那种）。
 */
export async function sendText(token, chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text };
  if (markdownSafe(text)) {
    payload.parse_mode = 'Markdown';
  }
  if (keyboard) {
    payload.reply_markup = { inline_keyboard: keyboard };
  }
  let result = await callApi(token, 'sendMessage', payload);
  if (!result && payload.parse_mode) {
    // 极少数漏网情况（例如正文里混进了未转义的特殊字符）
    // 再降级为纯文本重发一次，确保消息一定发得出去
    delete payload.parse_mode;
    result = await callApi(token, 'sendMessage', payload);
  }
  return result !== null;
}

/**
 * 发送带**回复键盘**的消息 —— 也就是底部常驻菜单。
 *
 * 和 sendText 的区别（这是理解本项目菜单的关键）：
 *     sendText 用的内联键盘，按钮长在消息气泡里，消息删了按钮就没了。
 *     本函数用的回复键盘，按钮长在**输入框下面**，是持久存在的，
 *     而且 Telegram 会自动在左下角显示一个「菜单」图标用于展开 / 收起。
 *
 * 参数 rows 形如 [['按钮A','按钮B'], ['按钮C']] —— 每一行是一个列表，
 * 一行最多 3 个，超过会被 Telegram 截断（所以调用方要自己控制列数）。
 */
export async function sendMenu(token, chatId, text, rows) {
  const keyboard = rows.map((row) => row.map((item) => ({ text: item })));
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard,
      resize_keyboard: true,   // 按内容自适应高度，不占半屏
      is_persistent: true,     // 一直显示，不用每次点图标展开
    },
  };
  if (markdownSafe(text)) {
    payload.parse_mode = 'Markdown';
  }
  let result = await callApi(token, 'sendMessage', payload);
  if (!result && payload.parse_mode) {
    delete payload.parse_mode;
    result = await callApi(token, 'sendMessage', payload);
  }
  return result !== null;
}

/** 收起底部菜单（保留左下角那个图标，点一下还能展开） */
export async function hideMenu(token, chatId, text = '菜单已收起。发送 /menu 可以再打开。') {
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { remove_keyboard: true },
  };
  return (await callApi(token, 'sendMessage', payload)) !== null;
}

/** 回应按钮点击（内联键盘必须回应，否则客户端一直转圈） */
export async function answerCallback(token, callbackId, text = '') {
  return (await callApi(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
  })) !== null;
}

/** 注册命令菜单（输入框旁边那个「/」菜单） */
export async function registerCommands(token) {
  const commands = [
    { command: 'menu', description: '显示操作菜单' },
    { command: 'status', description: '查看所有机器状态' },
    { command: 'traffic', description: '查看流量与免费额度' },
    { command: 'balance', description: '查看账户余额与本月账单' },
    { command: 'accounts', description: '按账号汇总额度占用' },
    { command: 'weekly', description: '查看最近 7 天流量周报' },
    { command: 'report', description: '立即发送完整报表' },
    { command: 'run', description: '立即执行一次巡检' },
    { command: 'help', description: '查看使用说明' },
  ];
  return (await callApi(token, 'setMyCommands', { commands })) !== null;
}

/** 设置 Webhook（让 Telegram 把消息推给我们的地址） */
export async function setWebhook(token, url, secretToken = '') {
  const payload = {
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  if (secretToken) {
    payload.secret_token = secretToken;
  }
  return (await callApi(token, 'setWebhook', payload)) !== null;
}

/** 删除 Webhook（退回长轮询模式时用） */
export async function deleteWebhook(token) {
  return (await callApi(token, 'deleteWebhook', { drop_pending_updates: true })) !== null;
}

/** 查询 Webhook 当前状态（排障用） */
export async function getWebhookInfo(token) {
  return await callApi(token, 'getWebhookInfo', {});
}

/**
 * 发送带级别图标的结构化通知。
 *
 * 对应 Python 版的 send_alert：把「级别 + 标题 + 正文」组合成一条消息，
 * 并根据配置决定推到哪些渠道。本版本只推 Telegram。
 */
export async function sendAlert(config, title, body, level = 'info', logger = null) {
  const telegram = (config && config.telegram) || {};
  const token = (telegram.bot_token || '').trim();
  const chatId = telegram.chat_id;

  if (!token || !chatId) {
    if (logger) {
      logger('没有配置 Telegram，通知未发送');
    }
    return false;
  }

  const icon = LEVEL_ICON[level] || LEVEL_ICON.info;
  const prefix = LEVEL_PREFIX[level] || LEVEL_PREFIX.info;
  const text = `${icon} *${sanitize(title)}*\n\n${body}`;

  const ok = await sendText(token, chatId, text);
  if (logger) {
    logger(`通知「${title}」${ok ? '已发送' : '发送失败'}`);
  }
  return ok;
}
