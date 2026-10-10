/**
 * 主入口（Cloudflare Workers 版）
 * ================================
 *
 * 这个 Worker 同时承担三件事：
 *
 *   1. Telegram Webhook 接收端
 *      你在手机上点按钮 / 发命令，Telegram 把消息 POST 到这里。
 *
 *   2. Cron 定时巡检
 *      每 5 分钟自动拉起一次巡检（流量判断 + 止损 + 自动开机）。
 *
 *   3. 安装期的自检端点
 *      部署后先访问一次 /setup，它会注册命令菜单并告诉你当前状态。
 *
 * 为什么这条路能解决「机器关机后机器人也死了」的死锁：
 *   整套逻辑跑在 Cloudflare 边缘节点上，跟你的 ECS 完全无关。
 *   机器关机对它毫无影响 —— 它反而是唯一能把机器叫醒的东西。
 *
 * 路由：
 *   POST /webhook/<密钥>   Telegram 推送入口（密钥不对直接 404）
 *   GET  /                健康检查，用于部署后确认「活着」
 *   GET  /setup?key=<密钥> 安装向导：注册命令、回显 Webhook 状态
 */

import * as common from './common.js';
import * as tg from './telegram.js';
import { runInspection } from './guard.js';
import { handleUpdate } from './bot-listener.js';
import { buildReport } from './views.js';

/**
 * 常量小抄：
 *   WEBHOOK_SECRET —— 放在 URL 里的随机串，防止别人猜到你的 Webhook 地址。
 *                     Telegram 会把完整 URL 原样保留，所以路径里带密钥是有效的。
 */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 把 runInspection 的返回对象转成**人看得懂**的一行日志。
 *
 * 为什么需要这个：直接在模板字符串里插对象会得到 "[object Object]"，
 * 日志里看不出查了几台、有没有查完，出问题时等于没有日志。
 * （这个坑和机器人回执那个是同一个病根，只是分两处修。）
 *
 * 覆盖 runInspection 的全部四种返回形态：
 *   { ok:true, skipped:true }  —— 软锁拦住，本轮没跑
 *   { ok:true, checked:0 }     —— 配置里没有机器
 *   { ok:true, checked:N }     —— 正常跑完
 *   { ok:true, checked:N, partial:true, total:M } —— 子请求预算用完，没查完
 *   { ok:false, error }        —— 整体失败
 */
export function formatInspectionSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return `结果异常（${typeof summary}）`;
  }
  if (summary.ok === false) {
    return `失败：${summary.error || '未说明原因'}`;
  }
  if (summary.skipped) {
    return '跳过（距上轮巡检过近）';
  }
  const checked = Number(summary.checked);
  if (!Number.isFinite(checked) || checked <= 0) {
    return '没有需要检查的机器';
  }
  if (summary.partial) {
    // 预算用完时**必须如实说没查完**，否则运维会误以为一切正常
    const total = Number(summary.total);
    const totalStr = Number.isFinite(total) ? total : '?';
    return `部分完成：已检查 ${checked}/${totalStr} 台（子请求预算用完，剩余下一轮补上）`;
  }
  return `已检查 ${checked} 台`;
}

export default {
  /**
   * HTTP 请求处理 —— 也就是 Webhook 与自检端点。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secret = String(env.WEBHOOK_SECRET || '').trim();

    // ---- 健康检查 ----
    if (path === '/' || path === '') {
      return textResponse(
        'CDT 流量守护正在运行。\n' +
        `时间: ${common.nowLocal().toISOString().replace('T', ' ').slice(0, 19)}\n` +
        'Webhook 路径已在 /setup 里给出。'
      );
    }

    // ---- 安装/自检 ----
    if (path === '/setup') {
      const key = url.searchParams.get('key') || '';
      if (!secret || key !== secret) {
        return textResponse('密钥不正确。', 403);
      }
      return await handleSetup(request, env);
    }

    // ---- Telegram Webhook ----
    if (path === '/webhook' || path.startsWith('/webhook/')) {
      const provided = path.startsWith('/webhook/')
        ? decodeURIComponent(path.slice('/webhook/'.length))
        : '';
      // 密钥不对一律 404，不告诉对方「这里有个机器人」
      if (!secret || provided !== secret) {
        return textResponse('未找到。', 404);
      }
      if (request.method !== 'POST') {
        return textResponse('仅接受 POST。', 405);
      }

      let update;
      try {
        update = await request.json();
      } catch (error) {
        // 解析失败也要回 200，否则 Telegram 会无限重试同一条
        return jsonResponse({ ok: true, note: '请求体不是合法 JSON' });
      }

      // 交给业务层。注意这里必须吞掉所有异常：
      // 一旦回 5xx，Telegram 会认为投递失败并反复重发同一条消息。
      try {
        await handleUpdate(env, update);
      } catch (error) {
        console.log(`[webhook] 处理更新出错: ${common.redact(error)}`);
      }
      return jsonResponse({ ok: true });
    }

    return textResponse('未找到。', 404);
  },

  /**
   * Cron 定时任务处理。
   *
   * wrangler.toml 里配了三个触发器：
   *   每 5 分钟           -> 巡检（流量判断 / 止损 / 自动开机）
   *   每天 UTC 01:00      -> 发送每日报表（= 北京 09:00）
   *   每天 UTC 02:00      -> 凭据体检（只在发现坏凭据时推送，= 北京 10:00）
   *
   * Cloudflare 传进来的 cron 字段就是触发时的表达式，据此分流。
   *
   * 🔴 这里判断用的表达式**必须与 wrangler.toml 的 crons 逐字一致**。
   *    Cloudflare 的 cron 一律按 UTC 算，所以写 `0 2 * * *` 而不是 `0 10 * * *`
   *    （后者是「北京时间 10 点」的口语说法，不是 Cloudflare 能识别的值）。
   *    踩过的坑：曾把这里写成 '0 10 * * *' 而 toml 里是 '0 2 * * *' ——
   *    两边对不上，定时体检**永远不会触发，且不报错、不崩溃、日志一片正常**，
   *    只有把配置和代码横向对比才能发现。
   */
  async scheduled(event, env, ctx) {
    const cron = event?.cron || '';

    // 巡检固定是每 5 分钟，用「是不是这个表达式」来判断最稳妥。
    const isInspection = cron === '*\/5 * * * *' || cron === '*/5 * * * *';
    // 凭据体检：每天 UTC 02:00（北京 10:00）。⚠️ 与 wrangler.toml 保持一致。
    const isCredCheck = cron === '0 2 * * *';

    if (isInspection) {
      try {
        const summary = await runInspection(env);
        // ⚠️ 这里踩过一个坑（与机器人回执那个 [object Object] 是同一个病根）：
        //     原先写的是 `巡检完成: ${summary}` —— summary 是**对象**，
        //     插进模板字符串就变成 "巡检完成: [object Object]"，
        //     日志里一个有用的信息都没有，出问题时完全看不出查了几台、有没有查完。
        //     机器人回执那边第五轮已经修了，cron 日志这边当时漏了，
        //     是第六轮部署后从 wrangler tail 的实测日志里抓出来的。
        console.log(`[cron] 巡检完成: ${formatInspectionSummary(summary)}`);
      } catch (error) {
        console.log(`[cron] 巡检失败: ${common.redact(error)}`);
      }
      return;
    }

    if (isCredCheck) {
      await runCredentialCheckCron(env);
      return;
    }

    // 其余触发器按「每日报表」处理
    try {
      const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
      const config = await common.loadConfig(env);
      const chatId = config?.telegram?.chat_id;
      if (!token || !chatId) {
        console.log('[cron] 缺少机器人令牌或 Chat ID，跳过日报');
        return;
      }
      const content = await buildReport(config);
      await tg.sendText(token, chatId, content);
      console.log('[cron] 日报已发送');
    } catch (error) {
      console.log(`[cron] 日报发送失败: ${common.redact(error)}`);
    }
  },
};

/**
 * 定时凭据体检。
 *
 * 只在**发现坏凭据**时才推消息 —— 每天推一句「一切正常」是纯噪音，
 * 久了会连真告警一起被忽略。出问题才说话，消息才有分量。
 */
async function runCredentialCheckCron(env) {
  try {
    const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    const config = await common.loadConfig(env);
    const chatId = config?.telegram?.chat_id;
    if (!token || !chatId) {
      console.log('[cron] 缺少机器人令牌或 Chat ID，跳过凭据体检');
      return;
    }

    const { runScheduledCredentialCheck } = await import('./credential-check.js');
    const result = await runScheduledCredentialCheck(config);

    if (result.badCount > 0 && result.message) {
      await tg.sendText(token, chatId, result.message);
      console.log(`[cron] 凭据体检发现 ${result.badCount} 个失效账号，已推送`);
    } else {
      console.log('[cron] 凭据体检通过，无需推送');
    }
  } catch (error) {
    console.log(`[cron] 凭据体检失败: ${common.redact(error)}`);
  }
}

/**
 * 安装向导：注册命令菜单、回显 Webhook 状态、给出下一步指引。
 *
 * 为什么用「访问一次网页」而不是让用户自己敲命令：
 *     这套东西的用户不是运维，是租服务器的人。让他们记 curl 命令不现实。
 *     部署完点一下链接，能自己看到是不是装好了，比什么都强。
 */
async function handleSetup(request, env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(env.WEBHOOK_SECRET || '').trim();
  const url = new URL(request.url);
  const workerOrigin = `${url.protocol}//${url.host}`;
  const webhookUrl = `${workerOrigin}/webhook/${secret}`;

  const report = [];
  report.push('=== CDT 流量守护 · 安装自检 ===');
  report.push(`时间: ${common.nowLocal().toISOString().replace('T', ' ').slice(0, 19)}`);
  report.push('');

  if (!token) {
    report.push('[失败] 没有找到 TELEGRAM_BOT_TOKEN。');
    report.push('       请在 Cloudflare 后台的「设置 → 变量」里添加这个加密变量。');
    return textResponse(report.join('\n'), 500);
  }

  // 1. 注册命令菜单
  try {
    const ok = await tg.registerCommands(token);
    report.push(ok
      ? '[成功] 命令菜单已注册（在输入框打 / 会看到提示）'
      : '[警告] 命令菜单注册未成功，但不影响按钮使用');
  } catch (error) {
    report.push(`[警告] 命令菜单注册出错: ${common.sanitize(error)}`);
  }

  // 2. 设置 Webhook
  try {
    const result = await tg.setWebhook(token, webhookUrl);
    if (result) {
      report.push('[成功] Webhook 已设置');
      report.push(`       ${webhookUrl}`);
    } else {
      report.push('[失败] Webhook 设置失败。');
      report.push('       常见原因：令牌写错、或 Worker 还没部署完成。');
      return textResponse(report.join('\n'), 500);
    }
  } catch (error) {
    report.push(`[失败] Webhook 设置出错: ${common.sanitize(error)}`);
    return textResponse(report.join('\n'), 500);
  }

  // 3. 回读确认
  try {
    const info = await tg.getWebhookInfo(token);
    if (info && info.ok) {
      const r = info.result || {};
      report.push('');
      report.push('--- Telegram 侧的确认信息 ---');
      report.push(`当前 Webhook: ${r.url || '（空）'}`);
      report.push(`待处理消息数: ${r.pending_update_count ?? '未知'}`);
      if (r.last_error_message) {
        report.push(`最近一次错误: ${r.last_error_message}`);
      }
    }
  } catch (error) {
    report.push(`[提示] 回读 Webhook 信息失败: ${common.sanitize(error)}`);
  }

  // 4. 配置检查
  report.push('');
  report.push('--- 配置检查 ---');
  try {
    const config = await common.loadConfig(env);
    const users = config?.users || [];
    const chatId = config?.telegram?.chat_id;
    report.push(`受监控机器数量: ${users.length}`);
    for (const user of users) {
      const name = common.sanitize(user?.name || user?.instance_id || '未命名');
      const paused = user?.paused ? '（已暂停监控）' : '';
      report.push(`  \u00b7 ${name}${paused}`);
    }
    report.push(`授权用户 Chat ID: ${chatId || '（未配置）'}`);
    if (!chatId) {
      report.push('');
      report.push('[重要] 还没配置 Chat ID，机器人不会响应任何人。');
      report.push('       请把你的数字 ID 写进配置的 telegram.chat_id。');
    }
  } catch (error) {
    report.push(`读取配置失败: ${common.sanitize(error)}`);
  }

  report.push('');
  report.push('--- 下一步 ---');
  report.push('打开 Telegram，对你的机器人发送 /menu。');
  report.push('如果没反应，说明上面某一步失败了，请把本页内容发给我。');

  return textResponse(report.join('\n'));
}
