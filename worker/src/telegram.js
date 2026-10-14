import { sanitize } from './common.js';
import { operationSignal, requestContext, throwIfCancelled } from './request-context.js';

function splitMessage(text, limit = TG_TEXT_LIMIT) {
  const raw = String(text === void 0 || text === null ? "" : text);
  if (!raw) {
    return [];
  }
  if (raw.length <= limit) {
    return [raw];
  }
  const RESERVE = 24;
  const bodyLimit = Math.max(1, limit - RESERVE);
  const segments = [];
  let current = "";
  for (const line of raw.split("\n")) {
    if (line.length > bodyLimit) {
      if (current) {
        segments.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += bodyLimit) {
        segments.push(line.slice(i, i + bodyLimit));
      }
      continue;
    }
    const candidate = current ? `${current}
${line}` : line;
    if (candidate.length > bodyLimit) {
      segments.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) {
    segments.push(current);
  }
  return segments.length ? segments : [raw];
}
function neutralizeMarkdown(text) {
  const raw = String(text === void 0 || text === null ? "" : text);
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/_/g, "-").replace(/\*/g, "\xB7").replace(/`/g, "'").replace(/~/g, "-").replace(/\[/g, "(").replace(/\]/g, ")");
}
function withPageMarker(segment, index, total) {
  if (total <= 1) {
    return segment;
  }
  return `${segment}

（第 ${index + 1}/${total} 段）`;
}
function markdownSafe(text) {
  if (!text) {
    return true;
  }
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;
  for (const mark of ["*", "_", "`", "~"]) {
    if (countOf(text, mark) % 2 !== 0) {
      return false;
    }
  }
  const opens = countOf(text, "[");
  const closes = countOf(text, "]");
  if (opens !== closes) {
    return false;
  }
  return true;
}
async function callApi(token, method, payload = null, timeoutMs = 15e3) {
  try {
    throwIfCancelled();
    const response = await fetch(API_BASE.replace("%s", token).replace("%s", method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: operationSignal(timeoutMs)
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
  }
}
async function sendText(token, chatId, text, keyboard = null) {
  const segments = splitMessage(text);
  if (!segments.length) {
    return false;
  }
  let allOk = true;
  for (let i = 0; i < segments.length; i += 1) {
    const isLast = i === segments.length - 1;
    const payload = {
      chat_id: chatId,
      text: withPageMarker(segments[i], i, segments.length)
    };
    if (markdownSafe(payload.text)) {
      payload.parse_mode = "Markdown";
    } else {
      payload.text = neutralizeMarkdown(payload.text);
    }
    if (keyboard && isLast) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }
    let result = await callApi(token, "sendMessage", payload);
    if (!result && payload.parse_mode) {
      delete payload.parse_mode;
      payload.text = neutralizeMarkdown(payload.text);
      result = await callApi(token, "sendMessage", payload);
    }
    if (result === null) {
      allOk = false;
    }
  }
  if (!allOk && requestContext().outbox) {
    requestContext().outbox.push({ kind: "text", token, chatId, text, keyboard });
  }
  return allOk;
}
async function sendMenu(token, chatId, text, rows) {
  const keyboard = rows.map((row) => row.map((item) => ({ text: item })));
  const segments = splitMessage(text);
  if (!segments.length) {
    return false;
  }
  let allOk = true;
  for (let i = 0; i < segments.length; i += 1) {
    const payload = {
      chat_id: chatId,
      text: withPageMarker(segments[i], i, segments.length)
    };
    if (i === 0) {
      payload.reply_markup = {
        keyboard,
        resize_keyboard: true,
        // 按内容自适应高度，不占半屏
        is_persistent: true
        // 一直显示，不用每次点图标展开
      };
    }
    if (markdownSafe(payload.text)) {
      payload.parse_mode = "Markdown";
    } else {
      payload.text = neutralizeMarkdown(payload.text);
    }
    let result = await callApi(token, "sendMessage", payload);
    if (!result && payload.parse_mode) {
      delete payload.parse_mode;
      payload.text = neutralizeMarkdown(payload.text);
      result = await callApi(token, "sendMessage", payload);
    }
    if (result === null) {
      allOk = false;
    }
  }
  if (!allOk && requestContext().outbox) {
    requestContext().outbox.push({ kind: "menu", token, chatId, text, rows });
  }
  return allOk;
}
async function hideMenu(token, chatId, text = "菜单已收起。发送 /menu 可以再打开。") {
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { remove_keyboard: true }
  };
  return await callApi(token, "sendMessage", payload) !== null;
}
async function deleteMessage(token, chatId, messageId) {
  if (!messageId) return false;
  const result = await callApi(token, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
  return result !== null;
}
async function answerCallback(token, callbackId, text = "") {
  return await callApi(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text
  }) !== null;
}
async function registerCommands(token) {
  const commands = [
    { command: "menu", description: "显示操作菜单" },
    { command: "status", description: "查看所有机器状态" },
    { command: "traffic", description: "查看流量与免费额度" },
    { command: "balance", description: "查看账户余额与本月账单" },
    { command: "accounts", description: "按账号汇总额度占用" },
    { command: "weekly", description: "查看最近 7 天流量周报" },
    { command: "report", description: "立即发送完整报表" },
    { command: "creds", description: "检查各账号访问密钥是否有效" },
    { command: "run", description: "立即执行一次巡检" },
    { command: "cancel", description: "取消正在进行的操作（如添加账号）" },
    { command: "help", description: "查看使用说明" }
  ];
  return await callApi(token, "setMyCommands", { commands }) !== null;
}
async function setWebhook(token, url, secretToken = "") {
  const payload = {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  };
  if (secretToken) {
    payload.secret_token = secretToken;
  }
  return await callApi(token, "setWebhook", payload) !== null;
}
async function getWebhookInfo(token) {
  return await callApi(token, "getWebhookInfo", {});
}
async function sendAlert(config, title, body, level = "info", logger = null, keyboard = null, env = null) {
  const telegram = config && config.telegram || {};
  const effectiveEnv = env || config && config.__env || null;
  const token = String(
    telegram.bot_token || effectiveEnv && effectiveEnv.TELEGRAM_BOT_TOKEN || ""
  ).trim();
  const chatId = telegram.chat_id || effectiveEnv && effectiveEnv.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    if (logger) {
      logger(
        "没有配置 Telegram（令牌与 Chat ID 至少要各有一个来源），通知未发送"
      );
    }
    return false;
  }
  const icon = LEVEL_ICON[level] || LEVEL_ICON.info;
  const safeTitle = sanitize(title);
  let safeBody = String(body === void 0 || body === null ? "" : body);
  if (!markdownSafe(`${safeTitle}
${safeBody}`)) {
    safeBody = neutralizeMarkdown(safeBody);
  }
  const text = `${icon} *${safeTitle}*

${safeBody}`;
  const ok = await sendText(token, chatId, text, keyboard);
  if (logger) {
    logger(`通知「${safeTitle}」${ok ? "已发送" : "发送失败"}`);
  }
  return ok;
}
var API_BASE, LEVEL_ICON, TG_TEXT_LIMIT;
API_BASE = "https://api.telegram.org/bot%s/%s";
LEVEL_ICON = {
  info: "\u2139️",
  // ℹ️
  warn: "⚠️",
  // ⚠️
  // ⚠️ 这里曾经写的是 '\U0001f6a8'（大写 U）—— 那是 **Python 的转义语法**，
  //    在 JavaScript 里 `\U` 不是有效转义，整个字符串会原样变成字面文本
  //    "U0001f6a8"，于是所有「严重」级告警的开头都挂着一串乱码。
  //    这个 bug 潜伏很久才被真机验证抓到（menu-labels.js 里专门警告过这个坑，
  //    结果 telegram.js 自己犯了）。现在用 JS 的 \u{...} 写法，并加测试钉死。
  danger: "\u{1F6A8}"
  // 🚨
};
TG_TEXT_LIMIT = 3800;

export { API_BASE, LEVEL_ICON, TG_TEXT_LIMIT, answerCallback, callApi, deleteMessage, getWebhookInfo, hideMenu, markdownSafe, neutralizeMarkdown, registerCommands, sendAlert, sendMenu, sendText, setWebhook, splitMessage, withPageMarker };
