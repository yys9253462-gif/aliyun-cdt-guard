import { handleUpdate } from './bot-listener.js';
import { loadConfig, loadState, nowLocal, redact } from './common.js';
import { heartbeatSummary, runInspection } from './guard.js';
import { withRequestContext } from './request-context.js';
import { getWebhookInfo, registerCommands, sendText, setWebhook } from './telegram.js';
import { buildReport } from './views.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
function formatInspectionSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return `结果异常（${typeof summary}）`;
  }
  if (summary.ok === false) {
    return `失败：${summary.error || "未说明原因"}`;
  }
  if (summary.skipped) {
    return "跳过（距上轮巡检过近）";
  }
  const checked = Number(summary.checked);
  if (!Number.isFinite(checked) || checked <= 0) {
    return "没有需要检查的机器";
  }
  if (summary.partial) {
    const total = Number(summary.total);
    const totalStr = Number.isFinite(total) ? total : "?";
    return `部分完成：已检查 ${checked}/${totalStr} 台（子请求预算用完，剩余下一轮补上）`;
  }
  return `已检查 ${checked} 台`;
}
var localWorker = {
  /**
   * HTTP 请求处理 —— 也就是 Webhook 与自检端点。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secret = String(env.WEBHOOK_SECRET || "").trim();
    if (path === "/" || path === "") {
      return textResponse(
        `CDT 流量守护正在运行。
时间: ${nowLocal().toISOString().replace("T", " ").slice(0, 19)}
Webhook 路径已在 /setup 里给出。`
      );
    }
    if (path === "/setup") {
      const key = request.headers.get("X-CDT-Key") || url.searchParams.get("key") || "";
      if (!secret || key !== secret) {
        return textResponse("密钥不正确。", 403);
      }
      return await handleSetup(request, env);
    }
    if (path === "/webhook" || path.startsWith("/webhook/")) {
      let provided = "";
      try {
        provided = path.startsWith("/webhook/") ? decodeURIComponent(path.slice("/webhook/".length)) : "";
      } catch (_) {
        return textResponse("未找到。", 404);
      }
      if (!secret || provided !== secret) {
        return textResponse("未找到。", 404);
      }
      if (request.method !== "POST") {
        return textResponse("仅接受 POST。", 405);
      }
      let update;
      try {
        update = await request.json();
      } catch (error) {
        return jsonResponse({ ok: true, note: "请求体不是合法 JSON" });
      }
      try {
        await handleUpdate(env, update);
      } catch (error) {
        console.log(`[webhook] 处理更新出错: ${redact(error)}`);
      }
      return jsonResponse({ ok: true });
    }
    return textResponse("未找到。", 404);
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
    const cron = event?.cron || "";
    const isInspection = cron === "*/5 * * * *" || cron === "*/5 * * * *";
    const isCredCheck = cron === "0 2 * * *";
    if (isInspection) {
      try {
        const summary = await runInspection(env);
        console.log(`[cron] 巡检完成: ${formatInspectionSummary(summary)}`);
      } catch (error) {
        console.log(`[cron] 巡检失败: ${redact(error)}`);
      }
      return;
    }
    if (isCredCheck) {
      await runCredentialCheckCron(env);
      return;
    }
    try {
      const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
      const config = await loadConfig(env);
      const chatId = config?.telegram?.chat_id;
      if (!token || !chatId) {
        console.log("[cron] 缺少机器人令牌或 Chat ID，跳过日报");
        return;
      }
      let content = await buildReport(config);
      try {
        content += `\n\n${heartbeatSummary(await loadState(env)).text}`;
      } catch (error) {
        content += "\n\n巡检心跳: 读取失败（状态存储异常）";
      }
      await sendText(token, chatId, content);
      console.log("[cron] 日报已发送");
    } catch (error) {
      console.log(`[cron] 日报发送失败: ${redact(error)}`);
    }
  }
};
async function runCredentialCheckCron(env) {
  try {
    const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
    const config = await loadConfig(env);
    const chatId = config?.telegram?.chat_id;
    if (!token || !chatId) {
      console.log("[cron] 缺少机器人令牌或 Chat ID，跳过凭据体检");
      return;
    }
    const { runScheduledCredentialCheck: runScheduledCredentialCheck2 } = await import('./credential-check.js');
    const result = await runScheduledCredentialCheck2(config);
    if (result.badCount > 0 && result.message) {
      await sendText(token, chatId, result.message);
      console.log(`[cron] 凭据体检发现 ${result.badCount} 个失效账号，已推送`);
    } else {
      console.log("[cron] 凭据体检通过，无需推送");
    }
  } catch (error) {
    console.log(`[cron] 凭据体检失败: ${redact(error)}`);
  }
}
async function handleSetup(request, env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const secret = String(env.WEBHOOK_SECRET || "").trim();
  const origin = new URL(request.url).origin;
  const expected = `${origin}/webhook/${encodeURIComponent(secret)}`;
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: redact(detail) });
  add("机器人令牌", Boolean(token), token ? "已配置" : "未配置 TELEGRAM_BOT_TOKEN");
  if (token) {
    if (request.method === "POST") {
      add("设置 Webhook", await setWebhook(token, expected), "保留尚未处理的更新");
    }
    const info = await getWebhookInfo(token);
    add("回读 Webhook", Boolean(info?.ok && info.result?.url === expected), info?.ok ? info.result?.url === expected ? "地址匹配" : "地址不匹配，请用菜单7重新注册" : "Telegram 查询失败");
    if (request.method === "POST") add("注册命令菜单", await registerCommands(token), "Telegram 命令入口");
    var historicalError = info?.result?.last_error_message || "";
  }
  try {
    const config = await loadConfig(env);
    add("授权 ID", Boolean(config?.telegram?.chat_id), config?.telegram?.chat_id ? "已配置" : "未配置 Chat ID");
    add("监控配置", Array.isArray(config?.users), `共 ${config?.users?.length || 0} 台；空列表可稍后添加`);
  } catch (error) {
    add("监控配置", false, redact(error));
  }
  const report = { ok: checks.every((c) => c.ok), checks, historicalError: redact(historicalError || "") };
  if (request.headers.get("Accept")?.includes("application/json")) return jsonResponse(report, report.ok ? 200 : 503);
  return textResponse(checks.map((c) => `[${c.ok ? "成功" : "失败"}] ${c.name}: ${c.detail}`).join("\n") + (report.historicalError ? `
[提示] Telegram 历史错误（仅参考）: ${report.historicalError}` : ""), report.ok ? 200 : 503);
}
function coordinator(env) {
  return env.CDT_COORDINATOR.get(env.CDT_COORDINATOR.idFromName("cdt-guard"));
}
var index_default = {
  fetch(request, env, ctx) {
    // 只有需要读写配置/状态的请求才进 Durable Object（它是串行的，巡检时会排队）。
    // 健康检查和随便乱扫的路径在边缘直接回，既不排队，也不给协调器添负担。
    const path = new URL(request.url).pathname;
    const needsCoordinator = path === "/setup" || path === "/webhook" || path.startsWith("/webhook/");
    if (!needsCoordinator) return withRequestContext(() => localWorker.fetch(request, env, ctx));
    if (env.CDT_COORDINATOR) return coordinator(env).fetch(request);
    return withRequestContext(() => localWorker.fetch(request, env, ctx));
  },
  scheduled(event, env, ctx) {
    if (env.CDT_COORDINATOR) return coordinator(env).fetch(new Request("https://internal.invalid/internal/cron", {
      method: "POST",
      headers: { "X-CDT-Internal": env.WEBHOOK_SECRET || "" },
      body: JSON.stringify({ cron: event.cron })
    })).then(async (r) => {
      if (!r.ok) throw new Error(`巡检协调失败 ${r.status}`);
    });
    return withRequestContext(() => localWorker.scheduled(event, env, ctx));
  }
};
export { GuardCoordinator } from './coordinator.js';

export { index_default as default, formatInspectionSummary, handleSetup, localWorker, coordinator, jsonResponse, runCredentialCheckCron, textResponse };
