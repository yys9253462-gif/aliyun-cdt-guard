import { handleAddAccountStep, startAddAccount } from './add-account.js';
import { getFreeQuotaGb, getInstanceStatus, isOverseasRegion, startInstance, stopInstance } from './aliyun-api.js';
import { clearDeviceState, clearLimitWizard, getCurrentDevice, getLimitWizard, getNavigation, loadConfig, nowLocal, redact, resetNavigation, sanitize, saveConfig, setCurrentDevice, setLimitWizard, setNavigation } from './common.js';
import { buildCredentialReport } from './credential-check.js';
import { parseTrafficLimit } from './guard.js';
import { LBL_ACCOUNTS, LBL_ADD_ACCOUNT, LBL_ADD_CANCEL, LBL_BACK_LIST, LBL_BACK_MAIN, LBL_BACK_PREV, LBL_BALANCE, LBL_CHECK_CRED, LBL_DEVICES, LBL_DEV_DELETE, LBL_DEV_PAUSE, LBL_DEV_RESUME, LBL_DEV_START, LBL_DEV_STATUS, LBL_DEV_STOP, LBL_HELP, LBL_HIDE, LBL_LIMIT_MANUAL, LBL_OVERVIEW, LBL_PAGE_NEXT, LBL_PAGE_PREV, LBL_REPORT, LBL_RUN, LBL_SET_LIMIT, LBL_START_ALL, LBL_STATUS, LBL_STATUS_OVERVIEW, LBL_STOP_ALL, LBL_TRAFFIC, LBL_WEEKLY, buildDeviceButton, matchMain, parseDeviceButton, shortIdTail } from './menu-labels.js';
import { answerCallback, hideMenu, sendMenu, sendText } from './telegram.js';
import { buildAccounts, buildBalance, buildReport, buildStatus, buildTraffic, buildWeekly, statusChinese } from './views.js';

function isAuthorized(config, chatId, senderId = chatId) {
  const allowed = String(config?.telegram?.chat_id || "").trim();
  if (!allowed || String(chatId ?? "").trim() !== allowed) return false;
  if (!allowed.startsWith("-")) return String(senderId ?? "").trim() === allowed;
  const admins = (config?.telegram?.admin_ids || []).map(String);
  return admins.includes(String(senderId ?? ""));
}
function mainMenuRows() {
  return [
    [LBL_STATUS_OVERVIEW, LBL_TRAFFIC],
    [LBL_DEVICES, LBL_SET_LIMIT],
    [LBL_START_ALL, LBL_STOP_ALL],
    [LBL_ADD_ACCOUNT, LBL_RUN],
    [LBL_HIDE]
  ];
}
function limitDeviceRows(config, page = 0) {
  const rows = [];
  for (const user of (config?.users || []).slice(page * 20, (page + 1) * 20)) {
    const name = String(user?.name || user?.instance_id || "").trim();
    rows.push([buildDeviceButton(name, Boolean(user?.paused), user?.instance_id)]);
  }
  const paging = [];
  if (page > 0) paging.push(LBL_PAGE_PREV);
  if ((page + 1) * 20 < (config?.users || []).length) paging.push(LBL_PAGE_NEXT);
  if (paging.length) rows.push(paging);
  rows.push([LBL_BACK_MAIN]);
  return rows;
}
function limitPresetRows(user) {
  const current = Number(user?.traffic_limit);
  const cur = Number.isFinite(current) && current > 0 ? current : 180;
  const presets = isOverseasRegion(user?.region) ? [50, 100, 150, 180, 190, 200] : [5, 10, 15, 18, 19, 20];
  if (!presets.includes(cur)) presets.push(cur);
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) {
    const pair = presets.slice(i, i + 2).map((gb2) => {
      const mark = gb2 === cur ? "✅ " : "";
      return `${mark}${gb2}GB`;
    });
    rows.push(pair);
  }
  rows.push([LBL_LIMIT_MANUAL]);
  rows.push([LBL_BACK_PREV, LBL_BACK_MAIN]);
  return rows;
}
function deviceMenuRows(config, page = 0) {
  const rows = [];
  for (const user of (config?.users || []).slice(page * 20, (page + 1) * 20)) {
    const name = String(user?.name || user?.instance_id || "").trim();
    rows.push([buildDeviceButton(name, Boolean(user?.paused), user?.instance_id)]);
  }
  const paging = [];
  if (page > 0) paging.push(LBL_PAGE_PREV);
  if ((page + 1) * 20 < (config?.users || []).length) paging.push(LBL_PAGE_NEXT);
  if (paging.length) rows.push(paging);
  rows.push([LBL_BACK_MAIN]);
  return rows;
}
function deviceActionRows(user) {
  const paused = Boolean(user?.paused);
  return [
    [LBL_DEV_STATUS, LBL_DEV_START],
    [LBL_DEV_STOP, paused ? LBL_DEV_RESUME : LBL_DEV_PAUSE],
    [LBL_DEV_DELETE],
    [LBL_BACK_LIST, LBL_BACK_MAIN]
  ];
}
function findUserById(config, instanceId) {
  for (const user of config?.users || []) {
    if (user?.instance_id === instanceId) return user;
  }
  return null;
}
function findUserByName(config, name) {
  const target = String(name || "").trim();
  if (!target) return null;
  const users = config?.users || [];
  const exact = users.filter((u) => String(u?.name || "").trim() === target);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const matches = users.filter((u) => String(u?.name || "").trim().startsWith(target));
  return matches.length === 1 ? matches[0] : null;
  return null;
}
function resolveCurrentDevice(config, currentKey) {
  const key = String(currentKey || "").trim();
  if (!key) return null;
  const byId = findUserById(config, key);
  if (byId) return byId;
  return key.startsWith("i-") ? null : findUserByName(config, key);
}
async function deleteDevice(env, config, instanceId) {
  const list = Array.isArray(config?.users) ? config.users : [];
  const idx = list.findIndex((u) => String(u?.instance_id || "") === String(instanceId || ""));
  if (idx < 0) {
    return "这台机器已经不在监控列表里了。";
  }
  const removed = list[idx];
  const name = sanitize(removed?.name || instanceId);
  const region = removed?.region || "";
  list.splice(idx, 1);
  await saveConfig(env, config);
  await clearDeviceState(env, instanceId);
  const lines = [
    `已把 ${name} 从监控列表里删除。`,
    region ? `（地域 ${region}，实例 ${instanceId}）` : `（实例 ${instanceId}）`,
    "",
    "注意：**阿里云上的 ECS 实例本身没有被删除**，监控只是不再管它。",
    "如果这台机器确实不用了，记得去阿里云控制台释放实例，避免继续计费。"
  ];
  return lines.join("\n");
}
async function togglePause(env, config, instanceId, desired = null) {
  const user = findUserById(config, instanceId);
  if (!user) return "没找到这台机器。";
  user.paused = desired === null ? !user.paused : Boolean(desired);
  await saveConfig(env, config);
  const name = sanitize(user.name || instanceId);
  const state = user.paused ? "已暂停" : "监控中";
  return `机器 ${name} 现在是：${state}`;
}
async function doStart(config, instanceId, env = null) {
  const user = findUserById(config, instanceId);
  if (!user) return "没找到这台机器。";
  const name = sanitize(user.name || instanceId);
  try {
    await startInstance(user.ak, user.sk, user.region, instanceId);
  } catch (error) {
    return `开机指令下发失败：${sanitize(error)}`;
  }
  if (env) {
    user.manual_stopped = false;
    await saveConfig(env, config);
  }
  return `已向 ${name} 下发开机指令。
注意：如果是抢占式实例且库存不足，可能开不起来。`;
}
async function doStop(config, instanceId, env = null) {
  const user = findUserById(config, instanceId);
  if (!user) return "没找到这台机器。";
  const name = sanitize(user.name || instanceId);
  try {
    await stopInstance(user.ak, user.sk, user.region, instanceId);
  } catch (error) {
    return `关机指令下发失败：${sanitize(error)}`;
  }
  if (env) {
    user.manual_stopped = true;
    await saveConfig(env, config);
  }
  return `已向 ${name} 下发关机指令。
已记录手动停机，巡检不会自动开机；点开机可恢复。`;
}
async function doBatchPower(config, action, env = null) {
  const users = config?.users || [];
  if (!users.length) return "当前没有配置任何机器。";
  const verb = action === "start" ? "开机" : "关机";
  const okList = [];
  const skipList = [];
  const failList = [];
  for (const user of users) {
    const name = sanitize(user?.name || user?.instance_id);
    if (user?.paused) {
      skipList.push(name);
      continue;
    }
    try {
      if (action === "start") {
        await startInstance(user.ak, user.sk, user.region, user.instance_id);
      } else {
        await stopInstance(user.ak, user.sk, user.region, user.instance_id);
      }
      user.manual_stopped = action !== "start";
      okList.push(name);
    } catch (error) {
      failList.push(`${name}（${sanitize(error)}）`);
    }
  }
  if (env && okList.length) await saveConfig(env, config);
  const lines = [`批量${verb}完成`, ""];
  if (okList.length) {
    lines.push("已下发指令:");
    for (const name of okList) lines.push(`  \xB7 ${name}`);
  }
  if (skipList.length) {
    lines.push("已跳过（监控处于暂停）:");
    for (const name of skipList) lines.push(`  \xB7 ${name}`);
  }
  if (failList.length) {
    lines.push("失败:");
    for (const name of failList) lines.push(`  \xB7 ${name}`);
  }
  lines.push("");
  lines.push(`时间: ${nowLocal().toISOString().slice(11, 19)}`);
  return lines.join("\n");
}
var HELP_TEXT = `CDT 流量守护 \xB7 使用说明

这个机器人让你在手机上就能管理流量守护。
它跑在 Cloudflare 上，**不依赖被你监控的那台机器** ——
所以哪怕机器已经被关机，你照样能用它把机器开起来。

菜单怎么用
发送 /menu 打开底部菜单。菜单分三层：
\xB7 第一层是功能总入口
\xB7 点「单机操作」进第二层，列出所有机器
\xB7 点某台机器进第三层，对它做状态查询 / 开机 / 关机 / 暂停

按钮就是快捷输入 —— 点一下等于替你发一句话，机器人再按这句话执行。

设置流量阈值（手机里就能改）
点菜单里的「设阈值」→ 选一台机器 → 选一个新阈值。
每个档位都标了当前值（✅），也可以点「手动输入」直接发一个数字。
阈值含义：当月流量达到这个数就**强制关机止损**。
建议设在免费额度以内（非中国内地 200GB / 中国内地 20GB），超了才会花钱。

命令
/menu     显示操作菜单
/status   查看所有机器实时状态
/traffic  查看流量与免费额度
/balance  查看账户余额与本月账单
/accounts 按账号汇总流量与额度
/weekly   查看最近 7 天流量周报
/report   立即发送完整报表
/creds    检查各账号访问密钥是否还有效
/run      立即执行一次巡检
/cancel   取消正在进行的操作（比如添加账号、设阈值）
/help     显示本条说明

说明：菜单里只放最常用的功能；上面的命令对应能力都还在，
低频功能（周报 / 完整报表 / 余额 / 凭据体检 / 说明）改为命令访问。

添加阿里云账号（在手机里就能做）
点菜单里的「添加账号」，然后按提示走：
  1. 把新账号的 AccessKey ID 发给我
  2. 把 AccessKey Secret 发给我（我会立刻删掉那条消息）
  3. 我自动扫出这个账号下的所有机器，列给你看
  4. 点「全部加入监控」—— 自动配好，不用碰电脑
原则：只新增，绝不动你已有的机器配置。

关于「凭据体检」
访问密钥失效后，那个账号下的机器就不再受保护（不会自动止损）。
我每天会自动体检一次，一旦发现失效就立刻通知你。
你也可以随时点「凭据体检」主动查 —— 它会逐个账号问阿里云
「这对密钥还能用吗」，并告诉你哪几台机器受影响、该怎么修。

关于「账号汇总」
免费额度是按账号算的，一个账号下多台机器共享一份额度。
所以「账号汇总」这一页比逐台看更准 ——
它会把同一个访问密钥的机器合并计算，告诉你这个账号额度还剩多少。

注意
\xB7 界面文字不带任何英文，全部中文。
\xB7 「暂停」只是让脚本不再自动开关机，手动按钮仍然可用。
\xB7 自动止损（流量超标强制关机）由定时任务执行，不受这里影响。
\xB7 只有你（配置里的 Chat ID）能操作，别人发消息不会有任何反应。
\xB7 目前仅支持私聊使用；群聊需要单独配置管理员名单，安装流程不会代填。
\xB7 想收起底部菜单，点「收起菜单」。`;
async function sendMainMenu(token, chatId, env = null) {
  if (env) await resetNavigation(env, chatId);
  await sendMenu(
    token,
    chatId,
    "CDT 流量守护 \xB7 控制台\n\n请从下面的菜单选择操作：",
    mainMenuRows()
  );
}
async function sendDeviceList(token, chatId, config, env = null, page = 0) {
  if (env) {
    await clearLimitWizard(env, chatId);
    await setNavigation(env, chatId, { mode: "devices", page });
  }
  const users = config?.users || [];
  if (!users.length) {
    await sendMenu(token, chatId, "当前没有配置任何机器。", [[LBL_BACK_MAIN]]);
    return;
  }
  await sendMenu(
    token,
    chatId,
    "选择要操作的机器\n\n点一台机器进入操作菜单：",
    deviceMenuRows(config, page)
  );
}
async function sendDeviceActions(token, chatId, user) {
  const name = sanitize(user?.name || user?.instance_id);
  const state = user?.paused ? "已暂停监控" : "监控中";
  await sendMenu(
    token,
    chatId,
    // ⚠️ 会话 15 分钟有效要写在界面上（2026-10-12）：回复键盘是常驻的，
    //    用户隔了半小时点「开机」，旧实现只会回一句「没听懂『开机』」。
    `\xB7 ${name}
当前: ${state}

选择操作：
（选中状态 15 分钟内有效，超时请重新选择机器）`,
    deviceActionRows(user)
  );
}
async function sendLimitDeviceList(token, chatId, config, env = null, page = 0) {
  if (env) {
    await setLimitWizard(env, chatId, { step: "pick" });
    await setNavigation(env, chatId, { mode: "limit", page });
  }
  const users = config?.users || [];
  if (!users.length) {
    await sendMenu(token, chatId, "当前没有配置任何机器。", [[LBL_BACK_MAIN]]);
    return;
  }
  await sendMenu(
    token,
    chatId,
    "设置流量阈值\n\n选一台机器，再选新的阈值：",
    limitDeviceRows(config, page)
  );
}
async function sendLimitPresets(token, chatId, user) {
  const name = sanitize(user?.name || user?.instance_id);
  const parsed = parseTrafficLimit(user?.traffic_limit);
  const limit = parsed.limitGb;
  const region = String(user?.region || "");
  const freeGb = getFreeQuotaGb(region);
  const freeCn = isOverseasRegion(region) ? "非中国内地" : "中国内地";
  const lines = [
    `\xB7 ${name}`,
    `当前阈值: ${limit}GB`,
    `本区域免费额度: ${freeGb}GB（${freeCn}）`,
    ""
  ];
  if (limit > freeGb) {
    lines.push(`⚠️ 当前阈值高于免费额度，超出部分会真实产生费用。`);
  } else {
    lines.push(`建议设在免费额度以内（如 ${Math.max(freeGb - 20, 1)}GB），超了才会花钱。`);
  }
  if (parsed.invalid) {
    lines.push(`（原阈值不合法：${parsed.invalid}，已按默认 ${limit}GB 处理）`);
  }
  lines.push("");
  lines.push("选一个新的阈值：");
  await sendMenu(token, chatId, lines.join("\n"), limitPresetRows(user));
}
function parseLimitChoice(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (matchMain(text, LBL_LIMIT_MANUAL)) return "manual";
  const m = text.replace(/[✅\u{FE0F}\s]/gu, "").match(/^(\d+(?:\.\d+)?)\s*(?:gb|g)?$/i);
  if (m) {
    const num = Number(m[1]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}
async function setDeviceLimit(env, config, instanceId, newLimit) {
  const user = findUserById(config, instanceId);
  if (!user) return "没找到这台机器。";
  const parsed = parseTrafficLimit(newLimit);
  if (parsed.invalid) {
    return `阈值不合法（${parsed.invalid}），已取消，未做修改。
请输入一个 5\u20132000 之间的数字，例如 180。`;
  }
  const gb2 = parsed.limitGb;
  if (gb2 < 5 || gb2 > 2e3) {
    return `阈值 ${gb2}GB 超出合理范围（5\u20132000GB），已取消，未做修改。`;
  }
  const name = sanitize(user.name || instanceId);
  const oldGb = parseTrafficLimit(user.traffic_limit).limitGb;
  user.traffic_limit = gb2;
  await saveConfig(env, config);
  const region = String(user.region || "");
  const freeGb = getFreeQuotaGb(region);
  const lines = [
    `已把 ${name} 的流量阈值改为 ${gb2}GB（原 ${oldGb}GB）。`,
    "",
    `本区域免费额度 ${freeGb}GB —— 超了才会花钱。`
  ];
  if (gb2 > freeGb) {
    lines.push(`⚠️ 注意：新阈值高于免费额度，进入付费阶梯后不会自动停，会一直扣到 ${gb2}GB 才关。`);
  }
  lines.push("下一轮巡检（最长 5 分钟）就会按新阈值执行。");
  return lines.join("\n");
}
async function handleCommand(env, config, token, chatId, text) {
  let cmd = String(text || "").trim().split(/\s+/)[0].toLowerCase().replace(/^\//, "");
  cmd = cmd.split("@")[0];
  switch (cmd) {
    case "start":
    case "menu":
      await sendMainMenu(token, chatId, env);
      return;
    case "status":
      await sendText(token, chatId, await buildStatus(config));
      return;
    case "traffic":
      await sendText(token, chatId, await buildTraffic(config));
      return;
    case "balance":
      await sendText(token, chatId, "正在查询余额与账单，可能需要十几秒...");
      await sendText(token, chatId, await buildBalance(config));
      return;
    case "weekly":
      await sendText(token, chatId, await buildWeekly(env, config));
      return;
    case "accounts":
      await sendText(token, chatId, "正在按账号汇总，可能需要十几秒...");
      await sendText(token, chatId, await buildAccounts(config));
      return;
    case "report":
      await sendReport(env, config, token, chatId);
      return;
    case "creds":
      await sendText(token, chatId, "正在逐个验证账号凭据，可能需要十几秒...");
      await sendText(token, chatId, await buildCredentialReport(config));
      return;
    case "run":
      await runInspection2(env, config, token, chatId);
      return;
    case "help":
      await sendText(token, chatId, HELP_TEXT);
      return;
    case "cancel":
      await resetNavigation(env, chatId);
      await sendText(token, chatId, "已取消当前操作，没有改动任何配置。");
      await sendMainMenu(token, chatId, env);
      return;
    default:
      if (await getLimitWizard(env, chatId)) {
        await sendText(
          token,
          chatId,
          "正在设置流量阈值：请直接发一个数字（不要加 /），例如 180。\n发送 /cancel 可以取消。"
        );
        return;
      }
      await sendText(
        token,
        chatId,
        "没听懂这个命令。发送 /help 查看用法，或发送 /menu 打开菜单。"
      );
  }
}
async function sendReport(env, config, token, chatId) {
  try {
    const content = await buildReport(config);
    await sendText(token, chatId, content);
  } catch (error) {
    await sendText(
      token,
      chatId,
      `报表生成失败：${sanitize(error)}
通常是因为某台机器的接口查不通。`
    );
  }
}
async function runInspection2(env, config, token, chatId) {
  const { runInspection: guardRun } = await import('./guard.js');
  try {
    const summary = await guardRun(env);
    if (summary && summary.skipped) {
      await sendText(
        token,
        chatId,
        "上一次巡检刚跑过（3 分钟内），为避免状态冲突，本次已取消。\n请稍后再试，或过一会儿再点。"
      );
      return;
    }
    await sendText(token, chatId, buildInspectionReply(summary));
  } catch (error) {
    await sendText(token, chatId, `巡检执行失败：${sanitize(error)}`);
  }
}
function buildInspectionReply(summary) {
  const s = summary || {};
  const parts = [];
  if (s.ok === false) {
    parts.push("⚠️ 巡检没能完成");
    parts.push("");
    parts.push(`原因：${sanitize(s.error || "未知错误")}`);
    parts.push("");
    parts.push("常见原因：配置损坏、存储暂时不可用。");
    parts.push("可稍后重试；若一直失败，请到 Cloudflare 仪表盘看实时日志。");
    return parts.join("\n");
  }
  if (s.partial) {
    return `⚠️ 巡检部分完成
已检查 ${s.checked}/${s.total} 台，未查完的机器会轮转到下一轮。`;
  }
  if (s.skipped) return "本轮巡检已跳过（距上轮过近）。";
  if (s.ok !== true) return "⚠️ 巡检结果异常，无法确认完成。";
  parts.push("✅ 巡检完成");
  if (s.checked === 0) {
    parts.push("");
    parts.push("当前配置里没有正在监控的机器。");
    parts.push("发送 /menu 打开菜单，选「➕ 添加账号」把机器加进来。");
  } else if (typeof s.checked === "number" && s.checked > 0) {
    parts.push("");
    parts.push(`本次检查了 ${s.checked} 台机器。`);
    parts.push("如有流量超标或机器异常，稍后会单独发提醒。");
  } else {
    parts.push("");
    parts.push("本轮巡检已执行。");
  }
  parts.push("");
  parts.push("详细过程见 Cloudflare 的实时日志（仪表盘 → Workers → 日志）。");
  return parts.join("\n");
}
async function handlePlainText(env, config, token, chatId, text, messageId = null) {
  const raw = String(text || "").trim();
  if (matchMain(raw, LBL_BACK_MAIN) || matchMain(raw, LBL_ADD_CANCEL)) {
    await resetNavigation(env, chatId);
    await sendMainMenu(token, chatId, env);
    return;
  }
  if (matchMain(raw, LBL_DEVICES)) {
    await resetNavigation(env, chatId);
    await sendDeviceList(token, chatId, config, env);
    return;
  }
  if (matchMain(raw, LBL_SET_LIMIT)) {
    await resetNavigation(env, chatId);
    await sendLimitDeviceList(token, chatId, config, env);
    return;
  }
  if (matchMain(raw, LBL_BACK_PREV) && await getLimitWizard(env, chatId)) {
    await sendLimitDeviceList(token, chatId, config, env);
    return;
  }
  if (matchMain(raw, LBL_PAGE_PREV) || matchMain(raw, LBL_PAGE_NEXT)) {
    const nav = await getNavigation(env, chatId);
    const last = Math.max(0, Math.ceil((config.users || []).length / 20) - 1);
    const page = Math.max(0, Math.min(last, (nav.page || 0) + (matchMain(raw, LBL_PAGE_NEXT) ? 1 : -1)));
    if (nav.mode === "limit") await sendLimitDeviceList(token, chatId, config, env, page);
    else await sendDeviceList(token, chatId, config, env, page);
    return;
  }
  const consumed = await handleAddAccountStep(env, token, chatId, raw, messageId);
  if (consumed) {
    return;
  }
  const limitWizard = await getLimitWizard(env, chatId);
  if (limitWizard && limitWizard.step === "manual") {
    const currentKey2 = await getCurrentDevice(env, chatId);
    const target = resolveCurrentDevice(config, currentKey2);
    if (!target) {
      await clearLimitWizard(env, chatId);
      await sendText(token, chatId, "这台机器已不在配置里，流程已取消。");
      return;
    }
    const num = parseLimitChoice(raw);
    if (typeof num === "number") {
      const result = await setDeviceLimit(env, config, target.instance_id, num);
      await clearLimitWizard(env, chatId);
      await sendText(token, chatId, result);
      await sendMainMenu(token, chatId, env);
      return;
    }
    await sendText(
      token,
      chatId,
      `「${sanitize(raw).slice(0, 20)}」不是一个有效数字。
请发一个 5\u20132000 之间的数字（单位 GB），例如 180。
发送 /cancel 可以取消。`
    );
    return;
  }
  if (matchMain(raw, LBL_HIDE)) {
    await hideMenu(token, chatId);
    return;
  }
  if (matchMain(raw, LBL_STATUS_OVERVIEW) || matchMain(raw, LBL_OVERVIEW) || matchMain(raw, LBL_STATUS)) {
    await sendText(token, chatId, await buildStatus(config));
    await sendText(token, chatId, await buildTraffic(config));
    return;
  }
  if (matchMain(raw, LBL_TRAFFIC)) {
    await sendText(token, chatId, await buildTraffic(config));
    return;
  }
  if (matchMain(raw, LBL_REPORT)) {
    await sendReport(env, config, token, chatId);
    return;
  }
  if (matchMain(raw, LBL_WEEKLY)) {
    await sendText(token, chatId, await buildWeekly(env, config));
    return;
  }
  if (matchMain(raw, LBL_BALANCE)) {
    await sendText(token, chatId, "正在查询余额与账单，可能需要十几秒...");
    await sendText(token, chatId, await buildBalance(config));
    return;
  }
  if (matchMain(raw, LBL_ACCOUNTS)) {
    await sendText(token, chatId, "正在按账号汇总，可能需要十几秒...");
    await sendText(token, chatId, await buildAccounts(config));
    return;
  }
  if (matchMain(raw, LBL_START_ALL)) {
    await sendText(token, chatId, await doBatchPower(config, "start", env));
    return;
  }
  if (matchMain(raw, LBL_STOP_ALL)) {
    await sendText(token, chatId, await doBatchPower(config, "stop", env));
    return;
  }
  if (matchMain(raw, LBL_DEVICES)) {
    await sendDeviceList(token, chatId, config, env);
    return;
  }
  if (matchMain(raw, LBL_SET_LIMIT)) {
    await setLimitWizard(env, chatId, { step: "pick" });
    await sendLimitDeviceList(token, chatId, config, env);
    return;
  }
  if (matchMain(raw, LBL_ADD_ACCOUNT)) {
    await startAddAccount(env, token, chatId);
    return;
  }
  if (matchMain(raw, LBL_CHECK_CRED)) {
    await sendText(token, chatId, "正在逐个验证账号凭据，可能需要十几秒...");
    await sendText(token, chatId, await buildCredentialReport(config));
    return;
  }
  if (matchMain(raw, LBL_RUN)) {
    await sendText(
      token,
      chatId,
      "正在执行巡检，如果某台机器需要开机等待，最长约 3 分钟，请稍候..."
    );
    await runInspection2(env, config, token, chatId);
    return;
  }
  if (matchMain(raw, LBL_HELP)) {
    await sendText(token, chatId, HELP_TEXT);
    return;
  }
  if (matchMain(raw, LBL_BACK_MAIN)) {
    await sendMainMenu(token, chatId, env);
    return;
  }
  const parsedBtn = parseDeviceButton(raw);
  if (parsedBtn) {
    let user = null;
    if (parsedBtn.idTail) {
      const candidates = (config?.users || []).filter((u) => shortIdTail(u?.instance_id) === parsedBtn.idTail);
      user = candidates.length === 1 ? candidates[0] : null;
      if (user && parsedBtn.name) {
        const fullName = String(user?.name || "").trim();
        if (fullName && parsedBtn.name && !fullName.startsWith(parsedBtn.name)) {
          user = null;
        }
      }
    }
    if (!parsedBtn.idTail && parsedBtn.name) {
      user = findUserByName(config, parsedBtn.name);
    }
    if (!user) {
      await sendText(token, chatId, "没找到这台机器，可能在配置里被删掉了。");
      await sendDeviceList(token, chatId, config, env);
      return;
    }
    await setCurrentDevice(env, chatId, user.instance_id || "");
    if (await getLimitWizard(env, chatId)) {
      await sendLimitPresets(token, chatId, user);
      return;
    }
    await sendDeviceActions(token, chatId, user);
    return;
  }
  if (await getLimitWizard(env, chatId)) {
    const currentKey2 = await getCurrentDevice(env, chatId);
    const current2 = resolveCurrentDevice(config, currentKey2);
    if (!current2) {
      await clearLimitWizard(env, chatId);
      await sendText(token, chatId, "这台机器已不在配置里，流程已取消。");
      await sendMainMenu(token, chatId, env);
      return;
    }
    if (matchMain(raw, LBL_BACK_PREV)) {
      await clearLimitWizard(env, chatId);
      await sendLimitDeviceList(token, chatId, config, env);
      return;
    }
    const choice = parseLimitChoice(raw);
    if (choice === "manual") {
      await setLimitWizard(env, chatId, { step: "manual" });
      await sendText(
        token,
        chatId,
        "请直接发一个数字（单位 GB），例如 180。\n发送 /cancel 可以取消。"
      );
      return;
    }
    if (typeof choice === "number") {
      const result = await setDeviceLimit(env, config, current2.instance_id, choice);
      await clearLimitWizard(env, chatId);
      await sendText(token, chatId, result);
      await sendMainMenu(token, chatId, env);
      return;
    }
    await sendText(
      token,
      chatId,
      "没看懂这个阈值。请点上面的档位，或点「手动输入」直接发一个数字。"
    );
    await sendLimitPresets(token, chatId, current2);
    return;
  }
  const currentKey = await getCurrentDevice(env, chatId);
  const current = resolveCurrentDevice(config, currentKey);
  if (current) {
    if (matchMain(raw, LBL_BACK_LIST)) {
      await sendDeviceList(token, chatId, config, env);
      return;
    }
    if (matchMain(raw, LBL_DEV_STATUS)) {
      const name = sanitize(current.name || current.instance_id);
      let statusCn;
      try {
        const status = await getInstanceStatus(
          current.ak,
          current.sk,
          current.region,
          current.instance_id
        );
        statusCn = status ? statusChinese(status) : "未查到";
      } catch (error) {
        statusCn = `查询失败（${sanitize(error)}）`;
      }
      await sendText(
        token,
        chatId,
        `\xB7 ${name}
状态: ${statusCn}
时间: ${nowLocal().toISOString().slice(11, 19)}`
      );
      return;
    }
    if (matchMain(raw, LBL_DEV_START)) {
      await sendText(token, chatId, await doStart(config, current.instance_id, env));
      return;
    }
    if (matchMain(raw, LBL_DEV_STOP)) {
      await sendText(token, chatId, await doStop(config, current.instance_id, env));
      return;
    }
    if (matchMain(raw, LBL_DEV_PAUSE) || matchMain(raw, LBL_DEV_RESUME)) {
      const message = await togglePause(env, config, current.instance_id, matchMain(raw, LBL_DEV_PAUSE));
      await sendText(token, chatId, message);
      const refreshed = findUserById(config, current.instance_id);
      if (refreshed) await sendDeviceActions(token, chatId, refreshed);
      return;
    }
    if (matchMain(raw, LBL_DEV_DELETE)) {
      const message = await deleteDevice(env, config, current.instance_id);
      await sendText(token, chatId, message);
      await setCurrentDevice(env, chatId, "");
      await sendDeviceList(token, chatId, config, env);
      return;
    }
  }
  const DEV_ACTION_LABELS = [
    LBL_DEV_STATUS,
    LBL_DEV_START,
    LBL_DEV_STOP,
    LBL_DEV_PAUSE,
    LBL_DEV_RESUME,
    LBL_DEV_DELETE,
    LBL_BACK_LIST
  ];
  if (DEV_ACTION_LABELS.some((label) => matchMain(raw, label))) {
    await sendText(
      token,
      chatId,
      "距离上次选择机器已经超过 15 分钟，会话过期了。\n请重新选择一台机器："
    );
    await sendDeviceList(token, chatId, config, env);
    return;
  }
  await sendMenu(
    token,
    chatId,
    `没听懂「${sanitize(raw).slice(0, 40)}」。
发送 /menu 打开菜单，或 /help 查看用法。`,
    mainMenuRows()
  );
}
async function handleUpdate(env, update) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return;
  const config = await loadConfig(env);
  const message = update?.message;
  if (message) {
    const chatId = message?.chat?.id;
    const text = message?.text || "";
    const messageId = message?.message_id || null;
    if (!isAuthorized(config, chatId, message?.from?.id ?? (String(chatId).startsWith("-") ? null : chatId))) {
      return;
    }
    try {
      if (text.startsWith("/")) {
        await handleCommand(env, config, token, chatId, text);
      } else {
        await handlePlainText(env, config, token, chatId, text, messageId);
      }
    } catch (error) {
      console.log(`[交互] 处理消息出错: ${redact(error)}`);
      try {
        await sendText(
          token,
          chatId,
          "这个操作没能完成（可能是网络或存储临时不可用）。\n机器人没有崩溃，请稍后再试一次；如果一直失败，把上面的操作内容发给我排查。"
        );
      } catch (_) {
      }
    }
    return;
  }
  const callback = update?.callback_query;
  if (callback) {
    await handleCallback(env, config, token, callback);
  }
}
async function handleCallback(env, config, token, callback) {
  const callbackId = callback?.id || "";
  const chatId = callback?.message?.chat?.id;
  try {
    await dispatchCallback(env, config, token, callback);
  } catch (error) {
    try {
      await answerCallback(token, callbackId, "处理失败");
    } catch (_) {
    }
    if (chatId) {
      try {
        await sendText(
          token,
          chatId,
          `这个操作执行失败：${sanitize(error)}
机器人没有崩溃，其他功能仍可正常使用。`
        );
      } catch (_) {
      }
    }
  }
}
async function dispatchCallback(env, config, token, callback) {
  const callbackId = callback?.id || "";
  const chatId = callback?.message?.chat?.id;
  const data = callback?.data || "";
  if (!isAuthorized(config, chatId, callback?.from?.id ?? (String(chatId).startsWith("-") ? null : chatId))) {
    await answerCallback(token, callbackId, "无权操作");
    return;
  }
  let action;
  let instanceId;
  if (data.includes(":")) {
    const idx = data.indexOf(":");
    action = data.slice(0, idx);
    instanceId = data.slice(idx + 1);
  } else {
    action = data;
    instanceId = "";
  }
  switch (action) {
    case "menu":
      await answerCallback(token, callbackId);
      await sendMainMenu(token, chatId, env);
      return;
    case "help":
      await answerCallback(token, callbackId);
      await sendText(token, chatId, HELP_TEXT);
      return;
    case "traffic":
      await answerCallback(token, callbackId, "查询中...");
      await sendText(token, chatId, await buildTraffic(config));
      return;
    case "balance":
      await answerCallback(token, callbackId, "正在查询余额与账单...");
      await sendText(token, chatId, await buildBalance(config));
      return;
    case "weekly":
      await answerCallback(token, callbackId, "正在汇总周报...");
      await sendText(token, chatId, await buildWeekly(env, config));
      return;
    case "accounts":
      await answerCallback(token, callbackId, "正在按账号汇总...");
      await sendText(token, chatId, await buildAccounts(config));
      return;
    case "report":
      await answerCallback(token, callbackId, "正在生成报表，可能需要十几秒...");
      await sendReport(env, config, token, chatId);
      return;
    case "run":
      await answerCallback(token, callbackId, "巡检执行中，请稍候...");
      await runInspection2(env, config, token, chatId);
      return;
    case "st": {
      await answerCallback(token, callbackId, "查询中...");
      const user = findUserById(config, instanceId);
      if (!user) {
        await sendText(token, chatId, "没找到这台机器。");
        return;
      }
      const name = sanitize(user.name || instanceId);
      let statusCn;
      try {
        const status = await getInstanceStatus(
          user.ak,
          user.sk,
          user.region,
          instanceId
        );
        statusCn = status ? statusChinese(status) : "未查到";
      } catch (error) {
        statusCn = `查询失败（${sanitize(error)}）`;
      }
      await sendText(
        token,
        chatId,
        `\xB7 ${name}
状态: ${statusCn}
时间: ${nowLocal().toISOString().slice(11, 19)}`
      );
      return;
    }
    case "up":
      await answerCallback(token, callbackId, "正在下发开机指令...");
      await sendText(token, chatId, await doStart(config, instanceId, env));
      return;
    case "dn":
      await answerCallback(token, callbackId, "正在下发关机指令...");
      await sendText(token, chatId, await doStop(config, instanceId, env));
      return;
    case "pz":
      await answerCallback(token, callbackId, "正在切换...");
      await sendText(token, chatId, await togglePause(env, config, instanceId));
      return;
    case "del": {
      await answerCallback(token, callbackId, "正在删除...");
      await sendText(token, chatId, await deleteDevice(env, config, instanceId));
      return;
    }
    case "addacct":
      await answerCallback(token, callbackId, "开始添加账号");
      await startAddAccount(env, token, chatId);
      return;
    default:
      await answerCallback(token, callbackId, "这个按钮暂时没实现");
  }
}

export { HELP_TEXT, buildInspectionReply, deleteDevice, deviceActionRows, deviceMenuRows, dispatchCallback, doBatchPower, doStart, doStop, findUserById, findUserByName, handleCallback, handleCommand, handlePlainText, handleUpdate, isAuthorized, limitDeviceRows, limitPresetRows, mainMenuRows, parseLimitChoice, resolveCurrentDevice, runInspection2, sendDeviceActions, sendDeviceList, sendLimitDeviceList, sendLimitPresets, sendMainMenu, sendReport, setDeviceLimit, togglePause };
