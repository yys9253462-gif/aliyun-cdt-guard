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
  // ⚠️ 这里曾经写的是 '\U0001f6a8'（大写 U）—— 那是 **Python 的转义语法**，
  //    在 JavaScript 里 `\U` 不是有效转义，整个字符串会原样变成字面文本
  //    "U0001f6a8"，于是所有「严重」级告警的开头都挂着一串乱码。
  //    这个 bug 潜伏很久才被真机验证抓到（menu-labels.js 里专门警告过这个坑，
  //    结果 telegram.js 自己犯了）。现在用 JS 的 \u{...} 写法，并加测试钉死。
  danger: '\u{1F6A8}',       // 🚨
};

/**
 * Telegram 单条消息的**硬上限**：4096 个字符。
 * 超过会被直接拒收（报 "message is too long"），消息一个字都发不出去。
 *
 * 这里不贴着 4096 用，而是留出安全余量，原因有三：
 *   1. 字符计数口径不一定一致 —— Telegram 按 UTF-16 计，emoji 可能算 2 个，
 *      我这边按 JS 字符串长度计，两者在含 emoji 时会有偏差；
 *   2. 分片后还要追加「（第 N/M 段）」这样的续页标记，得预留位置；
 *   3. Markdown 模式下实体的计算方式也可能带来额外开销。
 * 3800 是留了约 7% 余量的保守值，足够安全。
 */
const TG_TEXT_LIMIT = 3800;

/**
 * 把过长的文本按行切成多段，每段都不超过 limit。
 *
 * 为什么按**行**切而不是按字符硬切：
 *     报表是一行一行拼出来的（机器名、状态、流量各占一行），
 *     按行切能保证「一行内容不会被拦腰截断」，
 *     否则会出现半截的机器名，反而更难读。
 *
 * 边界情况处理：
 *   · 单行本身就超长（例如阿里云返回的整段报错原文）：
 *     按字符硬切成多段，避免死循环；
 *   · 空文本：返回空数组，调用方自行决定怎么处理。
 *
 * @returns {string[]} 每段文本，至少 1 段（除非输入为空）
 */
export function splitMessage(text, limit = TG_TEXT_LIMIT) {
  const raw = String(text === undefined || text === null ? '' : text);
  if (!raw) {
    return [];
  }
  // 没超长就直接返回，不做任何包装（保持原样，避免多余改动）
  if (raw.length <= limit) {
    return [raw];
  }

  // 续页标记的预留长度：形如 "\n\n（第 12/34 段）" 最多约 20 字符，
  // 统一按 24 预留，确保加上标记后仍然不超限。
  const RESERVE = 24;
  const bodyLimit = Math.max(1, limit - RESERVE);

  const segments = [];
  let current = '';
  for (const line of raw.split('\n')) {
    // 单行就超长：先把当前缓冲冲掉，再把这行硬切
    if (line.length > bodyLimit) {
      if (current) {
        segments.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += bodyLimit) {
        segments.push(line.slice(i, i + bodyLimit));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
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

/**
 * 把文本里会干扰 Telegram 解析的字符替换成**视觉等价的安全字符**（B9/B10）。
 *
 * 为什么需要这一步（而不是直接删掉特殊字符）：
 *     特殊字符多半来自「机器名」和「阿里云返回的报错原文」，
 *     直接删掉会让文字变得残缺难读，例如 `web_server` 变成 `webserver`，
 *     用户很难对上号。
 *
 * 替换规则（保持视觉相近，只去掉「有语法含义」的性质）：
 *     `_` -> `-`   下划线最容易踩，机器名里很常见
 *     `*` -> `·`   星号是加粗标记，换成中点，视觉上还是分隔符号
 *     `` ` `` -> `'`   反引号是代码标记，换成单引号
 *     `~` -> `-`   波浪号是删除线标记
 *     `[` `]` -> `(` `)`   方括号是链接标记，换成圆括号
 *     控制字符（\x00-\x08 等）-> 空格   这些字符会让 Telegram 拒收或显示异常
 *
 * 注意：只在**确定要退回纯文本**时才调用，不要无差别地用在所有消息上 ——
 * 那样会把正常的 Markdown 格式（如告警标题的 *加粗*）也破坏掉。
 */
export function neutralizeMarkdown(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  return raw
    // 控制字符（保留 \n 换行与 \t 制表，其余会让 Telegram 显示异常）
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/_/g, '-')
    .replace(/\*/g, '\u00b7')
    .replace(/`/g, "'")
    .replace(/~/g, '-')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
}

/**
 * 给分片加上「（第 N/M 段）」标记。
 *
 * 只在**确实分了多片**时才加 —— 单条消息加标记纯属噪音。
 * 用中文括号而不是 Markdown 标记，避免干扰正文的格式解析。
 */
export function withPageMarker(segment, index, total) {
  if (total <= 1) {
    return segment;
  }
  return `${segment}\n\n（第 ${index + 1}/${total} 段）`;
}

/**
 * 粗判文本能否安全用 Markdown 解析，避免白白浪费一次请求。
 *
 * 为什么要做这个判断：
 *     Telegram 的 Markdown 里 `*` `_` `[` 都是标记，
 *     一旦**出现奇数个**（没配对），整条消息会被拒
 *     （报 "can't parse entities"），我们只能降级纯文本重发。
 *     虽然降级能兜住，但会白跑一次请求，还在日志里留下噪音。
 *
 *     这里只做**保守**判断：成对出现的标记必须成偶数个才算安全。
 *     宁可误判为不安全（退回纯文本，消息照样能发出），
 *     也不要误判为安全（那就直接报错重发了）。
 *
 * ⚠️ 这里踩过一个坑，务必看清再改：
 *     最初的版本只检查了 `*` 和反引号，**漏掉了下划线 `_`**。
 *     后果非常隐蔽 —— 因为检测不出来，就带着 parse_mode=Markdown 发了出去，
 *     Telegram 直接拒收，然后才降级重发。表面上「消息最终发出去了」，
 *     但每一次都白跑一个请求，而且日志里持续刷报错。
 *     最容易踩到的场景：机器名里带下划线（例如按地域自动生成的
 *     `cn-hongkong_主账号_1a2b`，或用户自己起的 `web_server`），
 *     一个 `_` 就足够让整条消息被拒。
 *     所以下划线必须和星号同等对待。
 */
export function markdownSafe(text) {
  if (!text) {
    return true;
  }
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;
  // 成对标记：出现次数必须为偶数，否则视为未配对
  for (const mark of ['*', '_', '`', '~']) {
    if (countOf(text, mark) % 2 !== 0) {
      return false;
    }
  }
  // 方括号：开闭数量必须一致
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
 *
 * 超长自动分片（B7）：
 *     报表类消息（buildReport / buildStatus / buildTraffic）会随机器台数增长，
 *     机器一多就会超过 Telegram 的 4096 字符硬上限，整条消息被拒、一个字都发不出去。
 *     与其在十几个调用点各写一遍分片，不如在**发送层统一兜底** ——
 *     以后新增任何报表都自动获得分片能力，不会再漏。
 *
 *     分片时键盘只挂在**最后一片**上：用户在最后一段读到结论后正好能点按钮，
 *     中间那些片段挂按钮既没用又会让按钮重复出现好几次。
 *
 * @returns {boolean} 全部片段都发送成功才返回 true
 */
export async function sendText(token, chatId, text, keyboard = null) {
  const segments = splitMessage(text);
  if (!segments.length) {
    return false;
  }
  let allOk = true;
  for (let i = 0; i < segments.length; i += 1) {
    const isLast = i === segments.length - 1;
    const payload = {
      chat_id: chatId,
      text: withPageMarker(segments[i], i, segments.length),
    };
    if (markdownSafe(payload.text)) {
      payload.parse_mode = 'Markdown';
    } else {
      // 检测到 Markdown 不安全（例如机器名里有个落单的下划线）：
      // **主动**先把特殊字符净化掉再发，不要等 Telegram 拒收后再补救。
      //
      // 为什么要主动净化（B9/B10）：
      //     原来的做法是「先按 Markdown 发，失败了再删掉 parse_mode 重发」——
      //     能兜住，但代价是每次白跑一个请求，日志里持续刷报错，
      //     而且退回纯文本时特殊字符是**原样**发出去的，
      //     用户会看到没头没尾的 `[` `]`，比净化后更难读。
      payload.text = neutralizeMarkdown(payload.text);
    }
    if (keyboard && isLast) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }
    let result = await callApi(token, 'sendMessage', payload);
    if (!result && payload.parse_mode) {
      // 极少数漏网情况（例如正文里混进了未转义的特殊字符）
      // 再降级为纯文本重发一次，确保消息一定发得出去。
      // 注意这次要把特殊字符也净化掉，否则纯文本模式下它们仍是原文。
      delete payload.parse_mode;
      payload.text = neutralizeMarkdown(payload.text);
      result = await callApi(token, 'sendMessage', payload);
    }
    if (result === null) {
      allOk = false;
    }
  }
  return allOk;
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
 *
 * 超长同样自动分片，但菜单只挂在**第一片**上：
 *     回复键盘是「持久显示」的，只要挂一次就会一直在输入框下面。
 *     如果每片都挂，Telegram 会重复设置同一个键盘（纯浪费请求）。
 */
export async function sendMenu(token, chatId, text, rows) {
  const keyboard = rows.map((row) => row.map((item) => ({ text: item })));
  const segments = splitMessage(text);
  if (!segments.length) {
    return false;
  }
  let allOk = true;
  for (let i = 0; i < segments.length; i += 1) {
    const payload = {
      chat_id: chatId,
      text: withPageMarker(segments[i], i, segments.length),
    };
    if (i === 0) {
      payload.reply_markup = {
        keyboard,
        resize_keyboard: true,   // 按内容自适应高度，不占半屏
        is_persistent: true,     // 一直显示，不用每次点图标展开
      };
    }
    if (markdownSafe(payload.text)) {
      payload.parse_mode = 'Markdown';
    } else {
      // 与 sendText 同理：主动净化，不等 Telegram 拒收（B9/B10）
      payload.text = neutralizeMarkdown(payload.text);
    }
    let result = await callApi(token, 'sendMessage', payload);
    if (!result && payload.parse_mode) {
      delete payload.parse_mode;
      payload.text = neutralizeMarkdown(payload.text);
      result = await callApi(token, 'sendMessage', payload);
    }
    if (result === null) {
      allOk = false;
    }
  }
  return allOk;
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

/**
 * 删除一条消息。
 *
 * ⚠️ 为什么需要这个（安全相关，不是功能需要）：
 *    「在机器人里添加阿里云账号」这个流程要求用户**把 Secret 发给机器人**。
 *    而 Telegram 的聊天记录是**永久保存**的 —— 那条带 Secret 的消息
 *    会一直躺在你的聊天里，翻历史就能看到，截屏也会带上。
 *    所以收到之后第一件事就是**把它删掉**。
 *
 * 约束（Telegram 的硬限制，删不掉是正常的）：
 *   · 只能删「48 小时内」的消息，更早的删不掉；
 *   · 机器人只能删自己收到的、以及自己发出的消息，删不了用户其它消息；
 *   · 需要满足一定条件（对方不是匿名管理员等），否则返回 400 或 403。
 * 所以这个函数**失败是正常情况**，调用方不要把它当错误处理 ——
 * 删不掉时应该提醒用户「请自己手动删除那条消息」。
 */
export async function deleteMessage(token, chatId, messageId) {
  if (!messageId) return false;
  const result = await callApi(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  return result !== null;
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
    { command: 'creds', description: '检查各账号访问密钥是否有效' },
    { command: 'run', description: '立即执行一次巡检' },
    { command: 'cancel', description: '取消正在进行的操作（如添加账号）' },
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
 *
 * @param {Array|null} keyboard 可选的内联按钮，形如
 *        `[[{ text, callback_data }]]`。传了就让告警消息自带操作按钮
 *        （例如「凭据失效」告警带一个「🗑 删除这台机器」）——
 *        用户可以直接在告警里点按钮处理，不用再去翻菜单。
 */
export async function sendAlert(config, title, body, level = 'info', logger = null, keyboard = null) {
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

  // ⚠️ 这里踩过一个隐蔽的坑（B10），务必看清：
  //     title 走了 sanitize（会清掉 * _ [ ]），但 body **没有**。
  //     而 body 是由调用方一行行拼出来的，里面会插机器名、阿里云返回的
  //     报错原文等**不可控内容**。只要其中出现一个落单的 `*`，
  //     它就会和标题的加粗标记 `*标题*` 配成一对 ——
  //     结果是标题的加粗被「吃掉」，标题和正文黏成一段，或者整条消息被拒。
  //
  //     修法：先判断「标题 + 正文」合起来是否安全。
  //     不安全时把 body 净化（标题保留加粗，因为它是我们自己写的、可控），
  //     这样才能既保住标题样式，又不让正文把格式搞乱。
  const safeTitle = sanitize(title);
  let safeBody = String(body === undefined || body === null ? '' : body);
  if (!markdownSafe(`${safeTitle}\n${safeBody}`)) {
    safeBody = neutralizeMarkdown(safeBody);
  }

  const text = `${icon} *${safeTitle}*\n\n${safeBody}`;
  const ok = await sendText(token, chatId, text, keyboard);
  if (logger) {
    logger(`通知「${safeTitle}」${ok ? '已发送' : '发送失败'}`);
  }
  return ok;
}
