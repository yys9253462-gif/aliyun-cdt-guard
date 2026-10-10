/**
 * 机器人菜单与命令处理（Cloudflare Workers 版）
 *
 * 对应 Python 版的 bot_listener.py。但有一处**架构级差异**必须理解：
 *
 *   Python 版：常驻进程 + 长轮询（while True: getUpdates）
 *   Worker 版：Telegram 主动 POST 到你的 Worker（Webhook）
 *
 * 所以这里没有「主循环」，取而代之的是一个 handleUpdate() 函数，
 * 每次 Telegram 推来一条消息就调用一次。这不是缺陷 —— 恰恰是它能在
 * 被监控机器关机后依然工作的原因：Worker 跑在 Cloudflare 的机房里，
 * 跟你的 ECS 完全解耦。
 *
 * 另一处差异：三级菜单的「当前选中机器」在 Python 版里存内存
 * （_CURRENT_DEVICE 字典），Worker 无常驻内存，改存 KV。
 */

import * as common from './common.js';
import * as api from './aliyun-api.js';
import * as tg from './telegram.js';
import * as L from './menu-labels.js';
import {
  buildStatus,
  buildTraffic,
  buildBalance,
  buildWeekly,
  buildAccounts,
  buildReport,
  statusChinese,
} from './views.js';
import {
  startAddAccount,
  handleAddAccountStep,
} from './add-account.js';
import { buildCredentialReport } from './credential-check.js';

// ---------------------------------------------------------------------------
// 权限校验
// ---------------------------------------------------------------------------
/**
 * 校验来源是否是你本人。这是安全底线，绝不能省。
 *
 * 不通过時直接静默丢弃 —— 不回任何话，避免暴露机器人存在。
 */
export function isAuthorized(config, chatId) {
  const allowed = String(config?.telegram?.chat_id || '').trim();
  return Boolean(allowed) && String(chatId ?? '').trim() === allowed;
}

// ---------------------------------------------------------------------------
// 菜单构建
// ---------------------------------------------------------------------------
/**
 * 主菜单：回复键盘的行定义（每行一个文字列表）。
 *
 * 布局刻意做成两列 —— 整齐的方格观感，而且两列宽度比三列更宽松，
 * 中文按钮不会挤在一起换行。
 *
 * 14 项：前 7 行每行 2 个，最后「收起菜单」单独占一行（避免手滑点到）。
 */
export function mainMenuRows() {
  return [
    [L.LBL_OVERVIEW, L.LBL_TRAFFIC],
    [L.LBL_STATUS, L.LBL_REPORT],
    [L.LBL_WEEKLY, L.LBL_BALANCE],
    [L.LBL_ACCOUNTS, L.LBL_DEVICES],
    [L.LBL_ADD_ACCOUNT, L.LBL_CHECK_CRED],
    [L.LBL_RUN],
    [L.LBL_START_ALL, L.LBL_STOP_ALL],
    [L.LBL_HELP],
    [L.LBL_HIDE],
  ];
}

/** 二级菜单：实例列表。每台机器一行，加一个「返回主菜单」。 */
export function deviceMenuRows(config) {
  const rows = [];
  for (const user of (config?.users || []).slice(0, 20)) {
    const name = String(user?.name || user?.instance_id || '').trim();
    rows.push([L.buildDeviceButton(name, Boolean(user?.paused))]);
  }
  rows.push([L.LBL_BACK_MAIN]);
  return rows;
}

/** 三级菜单：单机操作。暂停状态不同，按钮文字不同。 */
export function deviceActionRows(user) {
  const paused = Boolean(user?.paused);
  // 删除单独占一行（放在最后、和「返回」隔开），避免和常用按钮挨着被手滑点中
  return [
    [L.LBL_DEV_STATUS, L.LBL_DEV_START],
    [L.LBL_DEV_STOP, paused ? L.LBL_DEV_RESUME : L.LBL_DEV_PAUSE],
    [L.LBL_DEV_DELETE],
    [L.LBL_BACK_LIST, L.LBL_BACK_MAIN],
  ];
}

// ---------------------------------------------------------------------------
// 机器查找
// ---------------------------------------------------------------------------
export function findUserById(config, instanceId) {
  for (const user of config?.users || []) {
    if (user?.instance_id === instanceId) return user;
  }
  return null;
}

/**
 * 按备注名查机器（按钮文字里存的是名字，不是实例 ID）。
 *
 * 名字被截断过时（按钮上只显示前 12 字），退化为前缀匹配。
 */
export function findUserByName(config, name) {
  const target = String(name || '').trim();
  if (!target) return null;
  for (const user of config?.users || []) {
    if (String(user?.name || '').trim() === target) return user;
  }
  for (const user of config?.users || []) {
    const full = String(user?.name || '').trim();
    if (full && (full.startsWith(target) || target.startsWith(full))) return user;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 动作实现
// ---------------------------------------------------------------------------
/**
 * 从监控配置里删除一台机器。返回结果说明文本。
 *
 * ⚠️ 为什么需要这个（2026-10-10 用户反馈）：
 *   当凭据失效**且**那台机器在阿里云上已经被删除时，用户既不能让
 *   巡检成功、也无法消除告警 —— 唯一出路就是把它从监控列表里摘掉。
 *   以前没有这个入口，用户只能眼睁睁看着告警一直刷。
 *
 * 安全设计：
 *   · 只删配置里的这一条记录，**绝不会去阿里云删实例**
 *     （远程销毁资源是不可逆操作，不该由一个通知按钮触发）；
 *   · 顺手清掉这台机器在 state 里的所有痕迹（失败计数、冷却标记、
 *     状态快照），否则这些记录会一直留着；
 *   · 返回文案里明确说「阿里云上的机器没动」，避免误以为实例被删了。
 */
export async function deleteDevice(env, config, instanceId) {
  const list = Array.isArray(config?.users) ? config.users : [];
  const idx = list.findIndex((u) => String(u?.instance_id || '') === String(instanceId || ''));
  if (idx < 0) {
    return '这台机器已经不在监控列表里了。';
  }

  const removed = list[idx];
  const name = common.sanitize(removed?.name || instanceId);
  const region = removed?.region || '';

  list.splice(idx, 1);
  await common.saveConfig(env, config);

  // 清掉这台机器在 state 里的痕迹，避免残留计数 / 冷却标记
  // 影响以后同名或同 ID 的机器。
  await common.clearDeviceState(env, instanceId);

  const lines = [
    `已把 ${name} 从监控列表里删除。`,
    region ? `（地域 ${region}，实例 ${instanceId}）` : `（实例 ${instanceId}）`,
    '',
    '注意：**阿里云上的 ECS 实例本身没有被删除**，监控只是不再管它。',
    '如果这台机器确实不用了，记得去阿里云控制台释放实例，避免继续计费。',
  ];
  return lines.join('\n');
}

/** 暂停 / 恢复某台机器的监控。返回结果说明文本。 */
export async function togglePause(env, config, instanceId) {
  const user = findUserById(config, instanceId);
  if (!user) return '没找到这台机器。';
  user.paused = !user.paused;
  await common.saveConfig(env, config);
  const name = common.sanitize(user.name || instanceId);
  const state = user.paused ? '已暂停' : '监控中';
  return `机器 ${name} 现在是：${state}`;
}

/** 手动开机。 */
export async function doStart(config, instanceId) {
  const user = findUserById(config, instanceId);
  if (!user) return '没找到这台机器。';
  const name = common.sanitize(user.name || instanceId);
  try {
    await api.startInstance(user.ak, user.sk, user.region, instanceId);
  } catch (error) {
    return `开机指令下发失败：${common.sanitize(error)}`;
  }
  return `已向 ${name} 下发开机指令。\n注意：如果是抢占式实例且库存不足，可能开不起来。`;
}

/** 手动关机（不影响自动止损逻辑）。 */
export async function doStop(config, instanceId) {
  const user = findUserById(config, instanceId);
  if (!user) return '没找到这台机器。';
  const name = common.sanitize(user.name || instanceId);
  try {
    await api.stopInstance(user.ak, user.sk, user.region, instanceId);
  } catch (error) {
    return `关机指令下发失败：${common.sanitize(error)}`;
  }
  return `已向 ${name} 下发关机指令。`;
}

/**
 * 批量开机 / 关机。返回结果说明文本。
 *
 * 跳过已暂停的机器 —— 你按过「暂停」就说明不想让脚本碰它，
 * 批量操作也必须尊重这个意愿，否则暂停就形同虚设。
 */
export async function doBatchPower(config, action) {
  const users = config?.users || [];
  if (!users.length) return '当前没有配置任何机器。';

  const verb = action === 'start' ? '开机' : '关机';
  const okList = [];
  const skipList = [];
  const failList = [];

  for (const user of users) {
    const name = common.sanitize(user?.name || user?.instance_id);
    if (user?.paused) {
      skipList.push(name);
      continue;
    }
    try {
      if (action === 'start') {
        await api.startInstance(user.ak, user.sk, user.region, user.instance_id);
      } else {
        await api.stopInstance(user.ak, user.sk, user.region, user.instance_id);
      }
      okList.push(name);
    } catch (error) {
      failList.push(`${name}（${common.sanitize(error)}）`);
    }
  }

  const lines = [`批量${verb}完成`, ''];
  if (okList.length) {
    lines.push('已下发指令:');
    for (const name of okList) lines.push(`  \u00b7 ${name}`);
  }
  if (skipList.length) {
    lines.push('已跳过（监控处于暂停）:');
    for (const name of skipList) lines.push(`  \u00b7 ${name}`);
  }
  if (failList.length) {
    lines.push('失败:');
    for (const name of failList) lines.push(`  \u00b7 ${name}`);
  }
  lines.push('');
  lines.push(`时间: ${common.nowLocal().toISOString().slice(11, 19)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 使用说明
// ---------------------------------------------------------------------------
export const HELP_TEXT = `CDT 流量守护 · 使用说明

这个机器人让你在手机上就能管理流量守护。
它跑在 Cloudflare 上，**不依赖被你监控的那台机器** ——
所以哪怕机器已经被关机，你照样能用它把机器开起来。

菜单怎么用
发送 /menu 打开底部菜单。菜单分三层：
· 第一层是功能总入口
· 点「单机操作」进第二层，列出所有机器
· 点某台机器进第三层，对它做状态查询 / 开机 / 关机 / 暂停

按钮就是快捷输入 —— 点一下等于替你发一句话，机器人再按这句话执行。

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
/cancel   取消正在进行的操作（比如添加账号）
/help     显示本条说明

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
· 界面文字不带任何英文，全部中文。
· 「暂停」只是让脚本不再自动开关机，手动按钮仍然可用。
· 自动止损（流量超标强制关机）由定时任务执行，不受这里影响。
· 只有你（配置里的 Chat ID）能操作，别人发消息不会有任何反应。
· 想收起底部菜单，点「收起菜单」。`;

// ---------------------------------------------------------------------------
// 菜单发送
// ---------------------------------------------------------------------------
export async function sendMainMenu(token, chatId) {
  await tg.sendMenu(
    token, chatId,
    'CDT 流量守护 · 控制台\n\n请从下面的菜单选择操作：',
    mainMenuRows()
  );
}

export async function sendDeviceList(token, chatId, config) {
  const users = config?.users || [];
  if (!users.length) {
    await tg.sendMenu(token, chatId, '当前没有配置任何机器。', [[L.LBL_BACK_MAIN]]);
    return;
  }
  await tg.sendMenu(
    token, chatId,
    '选择要操作的机器\n\n点一台机器进入操作菜单：',
    deviceMenuRows(config)
  );
}

export async function sendDeviceActions(token, chatId, user) {
  const name = common.sanitize(user?.name || user?.instance_id);
  const state = user?.paused ? '已暂停监控' : '监控中';
  await tg.sendMenu(
    token, chatId,
    `· ${name}\n当前: ${state}\n\n选择操作：`,
    deviceActionRows(user)
  );
}

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------
export async function handleCommand(env, config, token, chatId, text) {
  let cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/^\//, '');
  // 去掉 @BotName 后缀（群聊里发命令会带）
  cmd = cmd.split('@')[0];

  switch (cmd) {
    case 'start':
    case 'menu':
      await sendMainMenu(token, chatId);
      return;

    case 'status':
      await tg.sendText(token, chatId, await buildStatus(config));
      return;

    case 'traffic':
      await tg.sendText(token, chatId, await buildTraffic(config));
      return;

    case 'balance':
      await tg.sendText(token, chatId, '正在查询余额与账单，可能需要十几秒...');
      await tg.sendText(token, chatId, await buildBalance(config));
      return;

    case 'weekly':
      await tg.sendText(token, chatId, await buildWeekly(env, config));
      return;

    case 'accounts':
      await tg.sendText(token, chatId, '正在按账号汇总，可能需要十几秒...');
      await tg.sendText(token, chatId, await buildAccounts(config));
      return;

    case 'report':
      await sendReport(env, config, token, chatId);
      return;

    case 'creds':
      await tg.sendText(token, chatId, '正在逐个验证账号凭据，可能需要十几秒...');
      await tg.sendText(token, chatId, await buildCredentialReport(config));
      return;

    case 'run':
      await runInspection(env, config, token, chatId);
      return;

    case 'help':
      await tg.sendText(token, chatId, HELP_TEXT);
      return;

    case 'cancel':
      // 取消正在进行的多步流程（目前只有「添加账号」）
      // 注意：/cancel 是命令（以 / 开头），走的是 handleCommand 这条路，
      // 而流程的文字处理在 handlePlainText 里，所以这里必须单独接一下。
      if (await common.getWizard(env, chatId)) {
        await common.clearWizard(env, chatId);
        await tg.sendText(token, chatId, '已取消当前操作，没有改动任何配置。');
      } else {
        await tg.sendText(token, chatId, '当前没有进行中的操作。');
      }
      return;

    default:
      await tg.sendText(
        token, chatId,
        '没听懂这个命令。发送 /help 查看用法，或发送 /menu 打开菜单。'
      );
  }
}

/** 生成并发送完整报表。任何异常都要回话，不能沉默。 */
async function sendReport(env, config, token, chatId) {
  try {
    const content = await buildReport(config);
    await tg.sendText(token, chatId, content);
  } catch (error) {
    await tg.sendText(
      token, chatId,
      `报表生成失败：${common.sanitize(error)}\n` +
      '通常是因为某台机器的接口查不通。'
    );
  }
}

/**
 * 手动执行一次巡检（菜单里的「🔄 立即巡检」）。
 *
 * ⚠️ 软锁已收敛到 guard.runInspection（第五轮重构，务必看清）：
 *     这里**不再**自己读写 manual_inspection_lock。早先本函数有一份独立锁判断，
 *     而 guard.runInspection 里完全没有锁 —— 定时巡检根本不认这个锁，
 *     所谓「定时与手动互斥」是假的：手动跑着，定时照样进来，状态互相覆盖。
 *     现在锁只在 guard.runInspection 实现一次，本函数单纯转发结果。
 */
export async function runInspection(env, config, token, chatId) {
  const { runInspection: guardRun } = await import('./guard.js');

  try {
    const summary = await guardRun(env);
    if (summary && summary.skipped) {
      await tg.sendText(
        token, chatId,
        '上一次巡检刚跑过（3 分钟内），为避免状态冲突，本次已取消。\n' +
        '请稍后再试，或过一会儿再点。'
      );
      return;
    }
    await tg.sendText(
      token, chatId,
      `巡检完成\n\n${summary}\n\n详细过程见 Cloudflare 的实时日志。`
    );
  } catch (error) {
    await tg.sendText(token, chatId, `巡检执行失败：${common.sanitize(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 普通文字（回复键盘按钮点出来的）
// ---------------------------------------------------------------------------
/**
 * 处理非命令的输入 —— 也就是回复键盘按钮点出来的那些文字。
 *
 * 这是新版菜单的核心：回复键盘的按钮点一下就等于替你发一条消息，
 * 所以这里要做「文字 → 动作」的翻译。找不到对应动作时给出菜单，
 * 而不是装作没看见。
 *
 * ⚠️ messageId 是「添加账号」流程要用的：收到 Secret 那条消息后
 *    必须立刻把它删掉，而删除需要 message_id。
 */
export async function handlePlainText(env, config, token, chatId, text, messageId = null) {
  const raw = String(text || '').trim();

  // ---- 【最高优先级】正在进行的「添加账号」流程 ----
  // 必须放在所有菜单匹配**之前**。
  // 原因：这个流程进行中时，用户发过来的是一串 AccessKey（不是菜单文字），
  // 如果先走菜单匹配，会被判成「没听懂」并打断流程 —— 用户就卡住了。
  // 流程自己会判断「这条消息属不属于我」，不属于才返回 false 交回下面处理。
  const consumed = await handleAddAccountStep(env, token, chatId, raw, messageId);
  if (consumed) {
    return;
  }

  // ---- 收起菜单 ----
  if (L.matchMain(raw, L.LBL_HIDE)) {
    await tg.hideMenu(token, chatId);
    return;
  }

  // ---- 一级菜单 ----
  if (L.matchMain(raw, L.LBL_OVERVIEW)) {
    await tg.sendText(token, chatId, await buildStatus(config));
    await tg.sendText(token, chatId, await buildTraffic(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_TRAFFIC)) {
    await tg.sendText(token, chatId, await buildTraffic(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_STATUS)) {
    await tg.sendText(token, chatId, await buildStatus(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_REPORT)) {
    await sendReport(env, config, token, chatId);
    return;
  }
  if (L.matchMain(raw, L.LBL_WEEKLY)) {
    await tg.sendText(token, chatId, await buildWeekly(env, config));
    return;
  }
  if (L.matchMain(raw, L.LBL_BALANCE)) {
    await tg.sendText(token, chatId, '正在查询余额与账单，可能需要十几秒...');
    await tg.sendText(token, chatId, await buildBalance(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_ACCOUNTS)) {
    await tg.sendText(token, chatId, '正在按账号汇总，可能需要十几秒...');
    await tg.sendText(token, chatId, await buildAccounts(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_START_ALL)) {
    await tg.sendText(token, chatId, await doBatchPower(config, 'start'));
    return;
  }
  if (L.matchMain(raw, L.LBL_STOP_ALL)) {
    await tg.sendText(token, chatId, await doBatchPower(config, 'stop'));
    return;
  }
  if (L.matchMain(raw, L.LBL_DEVICES)) {
    await sendDeviceList(token, chatId, config);
    return;
  }
  if (L.matchMain(raw, L.LBL_ADD_ACCOUNT)) {
    await startAddAccount(env, token, chatId);
    return;
  }
  if (L.matchMain(raw, L.LBL_CHECK_CRED)) {
    await tg.sendText(token, chatId, '正在逐个验证账号凭据，可能需要十几秒...');
    await tg.sendText(token, chatId, await buildCredentialReport(config));
    return;
  }
  if (L.matchMain(raw, L.LBL_RUN)) {
    await tg.sendText(
      token, chatId,
      '正在执行巡检，如果某台机器需要开机等待，最长约 3 分钟，请稍候...'
    );
    await runInspection(env, config, token, chatId);
    return;
  }
  if (L.matchMain(raw, L.LBL_HELP)) {
    await tg.sendText(token, chatId, HELP_TEXT);
    return;
  }

  // ---- 二级菜单 ----
  if (L.matchMain(raw, L.LBL_BACK_MAIN)) {
    await sendMainMenu(token, chatId);
    return;
  }
  const deviceName = L.parseDeviceButton(raw);
  if (deviceName) {
    const user = findUserByName(config, deviceName);
    if (!user) {
      await tg.sendText(token, chatId, '没找到这台机器，可能在配置里被删掉了。');
      await sendDeviceList(token, chatId, config);
      return;
    }
    // 记住选中的机器，三级菜单的按钮要靠它才知道作用于哪台
    await common.setCurrentDevice(env, chatId, user.name || user.instance_id || '');
    await sendDeviceActions(token, chatId, user);
    return;
  }

  // ---- 三级菜单 ----
  // 三级菜单的按钮要作用在「某台机器」上，而按钮文字本身不带机器名，
  // 所以这里从会话状态里取「最近一次选中的机器」。
  const currentName = await common.getCurrentDevice(env, chatId);
  const current = findUserByName(config, currentName);
  if (current) {
    if (L.matchMain(raw, L.LBL_BACK_LIST)) {
      await sendDeviceList(token, chatId, config);
      return;
    }
    if (L.matchMain(raw, L.LBL_DEV_STATUS)) {
      const name = common.sanitize(current.name || current.instance_id);
      let statusCn;
      try {
        const status = await api.getInstanceStatus(
          current.ak, current.sk, current.region, current.instance_id
        );
        statusCn = status ? statusChinese(status) : '未查到';
      } catch (error) {
        statusCn = `查询失败（${common.sanitize(error)}）`;
      }
      await tg.sendText(
        token, chatId,
        `· ${name}\n状态: ${statusCn}\n时间: ${common.nowLocal().toISOString().slice(11, 19)}`
      );
      return;
    }
    if (L.matchMain(raw, L.LBL_DEV_START)) {
      await tg.sendText(token, chatId, await doStart(config, current.instance_id));
      return;
    }
    if (L.matchMain(raw, L.LBL_DEV_STOP)) {
      await tg.sendText(token, chatId, await doStop(config, current.instance_id));
      return;
    }
    if (L.matchMain(raw, L.LBL_DEV_PAUSE) || L.matchMain(raw, L.LBL_DEV_RESUME)) {
      const message = await togglePause(env, config, current.instance_id);
      await tg.sendText(token, chatId, message);
      // 暂停状态变了，重绘三级菜单让按钮文字跟上
      const refreshed = findUserById(config, current.instance_id);
      if (refreshed) await sendDeviceActions(token, chatId, refreshed);
      return;
    }
    if (L.matchMain(raw, L.LBL_DEV_DELETE)) {
      const message = await deleteDevice(env, config, current.instance_id);
      await tg.sendText(token, chatId, message);
      // 这台机器已经没了，把「当前选中」清掉并回到列表，
      // 否则三级菜单还挂着一台不存在的机器，后面点什么都找不到。
      await common.setCurrentDevice(env, chatId, '');
      await sendDeviceList(token, chatId, config);
      return;
    }
  }

  // ---- 什么都没匹配上 ----
  await tg.sendMenu(
    token, chatId,
    `没听懂「${common.sanitize(raw).slice(0, 40)}」。\n发送 /menu 打开菜单，或 /help 查看用法。`,
    mainMenuRows()
  );
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------
/**
 * 分发一条 Telegram 更新。
 *
 * 这是 Webhook 的处理器，任何时候都不能往外抛异常 ——
 * 抛出去 Telegram 会认为投递失败并反复重试，导致同一条消息被处理多次。
 * 所以最外层统一兜住。
 */
export async function handleUpdate(env, update) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return;

  const config = await common.loadConfig(env);

  const message = update?.message;
  if (message) {
    const chatId = message?.chat?.id;
    const text = message?.text || '';
    // messageId 传下去是给「添加账号」流程用的 ——
    // 收到 Secret 那条消息后要立刻删掉，删除需要 message_id。
    const messageId = message?.message_id || null;
    if (!isAuthorized(config, chatId)) {
      // 静默丢弃，不暴露机器人存在
      return;
    }
    if (text.startsWith('/')) {
      await handleCommand(env, config, token, chatId, text);
    } else {
      await handlePlainText(env, config, token, chatId, text, messageId);
    }
    return;
  }

  const callback = update?.callback_query;
  if (callback) {
    await handleCallback(env, config, token, callback);
  }
}

/**
 * 处理按钮点击。
 *
 * 内部任何异常都不能往外抛 —— 一旦抛出去，用户看到的是永远转圈。
 * 所以统一兜底：先回应按钮（否则一直转圈），再把失败原因回给你。
 */
export async function handleCallback(env, config, token, callback) {
  const callbackId = callback?.id || '';
  const chatId = callback?.message?.chat?.id;

  try {
    await dispatchCallback(env, config, token, callback);
  } catch (error) {
    try {
      await tg.answerCallback(token, callbackId, '处理失败');
    } catch (_) { /* 忽略：回应失败也不能再抛 */ }
    if (chatId) {
      try {
        await tg.sendText(
          token, chatId,
          `这个操作执行失败：${common.sanitize(error)}\n机器人没有崩溃，其他功能仍可正常使用。`
        );
      } catch (_) { /* 忽略 */ }
    }
  }
}

async function dispatchCallback(env, config, token, callback) {
  const callbackId = callback?.id || '';
  const chatId = callback?.message?.chat?.id;
  const data = callback?.data || '';

  if (!isAuthorized(config, chatId)) {
    await tg.answerCallback(token, callbackId, '无权操作');
    return;
  }

  let action;
  let instanceId;
  if (data.includes(':')) {
    const idx = data.indexOf(':');
    action = data.slice(0, idx);
    instanceId = data.slice(idx + 1);
  } else {
    action = data;
    instanceId = '';
  }

  // 先回应按钮，让转圈立刻停下，再干活
  switch (action) {
    case 'menu':
      await tg.answerCallback(token, callbackId);
      await sendMainMenu(token, chatId);
      return;

    case 'help':
      await tg.answerCallback(token, callbackId);
      await tg.sendText(token, chatId, HELP_TEXT);
      return;

    case 'traffic':
      await tg.answerCallback(token, callbackId, '查询中...');
      await tg.sendText(token, chatId, await buildTraffic(config));
      return;

    case 'balance':
      await tg.answerCallback(token, callbackId, '正在查询余额与账单...');
      await tg.sendText(token, chatId, await buildBalance(config));
      return;

    case 'weekly':
      await tg.answerCallback(token, callbackId, '正在汇总周报...');
      await tg.sendText(token, chatId, await buildWeekly(env, config));
      return;

    case 'accounts':
      await tg.answerCallback(token, callbackId, '正在按账号汇总...');
      await tg.sendText(token, chatId, await buildAccounts(config));
      return;

    case 'report':
      await tg.answerCallback(token, callbackId, '正在生成报表，可能需要十几秒...');
      await sendReport(env, config, token, chatId);
      return;

    case 'run':
      await tg.answerCallback(token, callbackId, '巡检执行中，请稍候...');
      await runInspection(env, config, token, chatId);
      return;

    case 'st': {
      await tg.answerCallback(token, callbackId, '查询中...');
      const user = findUserById(config, instanceId);
      if (!user) {
        await tg.sendText(token, chatId, '没找到这台机器。');
        return;
      }
      const name = common.sanitize(user.name || instanceId);
      let statusCn;
      try {
        const status = await api.getInstanceStatus(
          user.ak, user.sk, user.region, instanceId
        );
        statusCn = status ? statusChinese(status) : '未查到';
      } catch (error) {
        statusCn = `查询失败（${common.sanitize(error)}）`;
      }
      await tg.sendText(
        token, chatId,
        `· ${name}\n状态: ${statusCn}\n时间: ${common.nowLocal().toISOString().slice(11, 19)}`
      );
      return;
    }

    case 'up':
      await tg.answerCallback(token, callbackId, '正在下发开机指令...');
      await tg.sendText(token, chatId, await doStart(config, instanceId));
      return;

    case 'dn':
      await tg.answerCallback(token, callbackId, '正在下发关机指令...');
      await tg.sendText(token, chatId, await doStop(config, instanceId));
      return;

    case 'pz':
      await tg.answerCallback(token, callbackId, '正在切换...');
      await tg.sendText(token, chatId, await togglePause(env, config, instanceId));
      return;

    case 'del': {
      // 「凭据失效」告警里的「删除这台机器」按钮。
      // 用户诉求：失效/已删除的机器要能一键摘掉，而不是被反复报警。
      await tg.answerCallback(token, callbackId, '正在删除...');
      await tg.sendText(token, chatId, await deleteDevice(env, config, instanceId));
      return;
    }

    case 'addacct':
      // 告警里的「添加账号」按钮 —— 直接进入添加账号流程
      await tg.answerCallback(token, callbackId, '开始添加账号');
      await startAddAccount(env, token, chatId);
      return;

    default:
      await tg.answerCallback(token, callbackId, '这个按钮暂时没实现');
  }
}
