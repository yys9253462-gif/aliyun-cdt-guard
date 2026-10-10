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
import { parseTrafficLimit } from './guard.js';

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
 * 🔴 精简为 9 项（2026-10-11，用户反馈「好多功能都没用」）：
 *    原 14 项里有一半是重复入口（总览=状态+流量、完整报表≈状态总览、
 *    余额详情≈账号汇总）。精简后只留**每天真要用**的，
 *    被去掉的能力全都还在，只是改为命令访问（/report /weekly /balance /creds /help）。
 *
 *    新增「🎚 设阈值」—— 之前只能在电脑上改配置，现在手机里就能调。
 */
export function mainMenuRows() {
  return [
    [L.LBL_STATUS_OVERVIEW, L.LBL_TRAFFIC],
    [L.LBL_DEVICES, L.LBL_SET_LIMIT],
    [L.LBL_START_ALL, L.LBL_STOP_ALL],
    [L.LBL_ADD_ACCOUNT, L.LBL_RUN],
    [L.LBL_HIDE],
  ];
}

/**
 * 「设阈值」二级菜单：列出所有机器，点一台进三级。
 *
 * 复用实例按钮格式（带实例 ID 尾段），保证同名机器也能精确选中。
 */
export function limitDeviceRows(config) {
  const rows = [];
  for (const user of (config?.users || []).slice(0, 20)) {
    const name = String(user?.name || user?.instance_id || '').trim();
    rows.push([L.buildDeviceButton(name, Boolean(user?.paused), user?.instance_id)]);
  }
  rows.push([L.LBL_BACK_MAIN]);
  return rows;
}

/**
 * 「设阈值」三级菜单：对某台机器给快捷档位 + 手动输入。
 *
 * 档位按「海外免费 200GB / 内地免费 20GB」两种场景各给几个常用值，
 * 避免用户还要心算「设多少才安全」。
 */
export function limitPresetRows(user) {
  const current = Number(user?.traffic_limit);
  const cur = Number.isFinite(current) && current > 0 ? current : 180;
  // 六个常用档位：留足安全余量 + 贴近免费额度 + 当前值（方便回看）
  const presets = [50, 100, 150, 180, 190, 200];
  const rows = [];
  // 每行两个档位按钮
  for (let i = 0; i < presets.length; i += 2) {
    const pair = presets.slice(i, i + 2).map((gb) => {
      const mark = gb === cur ? '\u{2705} ' : '';   // ✅ 标出当前值
      return `${mark}${gb}GB`;
    });
    rows.push(pair);
  }
  rows.push([L.LBL_LIMIT_MANUAL]);
  rows.push([L.LBL_BACK_PREV, L.LBL_BACK_MAIN]);
  return rows;
}

/** 二级菜单：实例列表。每台机器一行，加一个「返回主菜单」。 */
export function deviceMenuRows(config) {
  const rows = [];
  for (const user of (config?.users || []).slice(0, 20)) {
    const name = String(user?.name || user?.instance_id || '').trim();
    // 第三个参数把实例 ID 尾段带进按钮文字 —— 点按钮时就能精确锁定这一台，
    // 不再靠「名字前缀匹配」（那会串台，详见 parseDeviceButton 的注释）
    rows.push([L.buildDeviceButton(name, Boolean(user?.paused), user?.instance_id)]);
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
 * ⚠️ 这个函数**只该用在「把用户输入的名字翻译成机器」**这一种场景
 *   （例如菜单列表里点按钮）。
 *
 * 🔴 绝对不要用它来还原「三级菜单当前选中的是哪台机器」！
 *    原因见下面 `resolveCurrentDevice` 的注释 —— 那是删错机器的根源。
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

/**
 * 还原「三级菜单里当前选中的是哪台机器」。
 *
 * 🔴 这里修的是一个**会删错机器**的高危 BUG，务必看清来龙去脉：
 *
 *   旧做法：二级菜单点某台机器时，把 `user.name` 存进会话；
 *          三级菜单里再用 `findUserByName` 按名字查回来。
 *
 *   问题出在「名字会被截断」上：
 *     · 菜单按钮上有长度上限（DEVICE_NAME_MAX = 22），超长会截断加「…」；
 *     · 而 `findUserByName` 的第一轮精确匹配匹配不到截断名，
 *       于是退化为第二轮「前缀模糊匹配」——**返回第一个前缀相符的机器**。
 *
 *   于是只要有两台机器的名字前 22 个字一样：
 *     机器 A 名字：`我的生产环境服务器-新加坡节点-AAAA`
 *     机器 B 名字：`我的生产环境服务器-新加坡节点-BBBB`
 *   按钮上两台都显示成 `我的生产环境服务器-新加坡节点…`（一模一样），
 *   点 B 进去，`findUserByName` 会返回 **A**（因为 A 在前面）。
 *   结果：你想删 B、想关 B、想看 B 的状态，**实际全作用在 A 上**。
 *   删机器是不可逆的 —— 用户会以为「我删的是那台不用的」，
 *   结果把正在跑业务的那台从监控里摘掉了。
 *
 *   正确做法：会话里存**实例 ID**（阿里云保证唯一，且绝不被截断），
 *   用 `findUserById` 精确查回来。
 *
 * 兼容性：老会话里存的是名字。检测到「按 id 查不到」时，
 *        退回用名字查一次，保证升级后用户不用重新点一遍。
 */
export function resolveCurrentDevice(config, currentKey) {
  const key = String(currentKey || '').trim();
  if (!key) return null;
  // 首选：当成实例 ID 精确查找（新逻辑）
  const byId = findUserById(config, key);
  if (byId) return byId;
  // 兜底：老会话存的是名字（升级兼容）
  return findUserByName(config, key);
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
// 「设阈值」菜单
// ---------------------------------------------------------------------------
/** 二级：选要调阈值的机器。 */
export async function sendLimitDeviceList(token, chatId, config) {
  const users = config?.users || [];
  if (!users.length) {
    await tg.sendMenu(token, chatId, '当前没有配置任何机器。', [[L.LBL_BACK_MAIN]]);
    return;
  }
  await tg.sendMenu(
    token, chatId,
    '设置流量阈值\n\n选一台机器，再选新的阈值：',
    limitDeviceRows(config)
  );
}

/** 三级：对某台机器选阈值档位。 */
export async function sendLimitPresets(token, chatId, user) {
  const name = common.sanitize(user?.name || user?.instance_id);
  const parsed = parseTrafficLimit(user?.traffic_limit);
  const limit = parsed.limitGb;
  const region = String(user?.region || '');
  const freeGb = api.getFreeQuotaGb(region);
  const freeCn = api.isOverseasRegion(region) ? '非中国内地' : '中国内地';

  const lines = [
    `· ${name}`,
    `当前阈值: ${limit}GB`,
    `本区域免费额度: ${freeGb}GB（${freeCn}）`,
    '',
  ];
  // 给一句人话提示：阈值与免费额度的关系
  if (limit > freeGb) {
    lines.push(`⚠️ 当前阈值高于免费额度，超出部分会真实产生费用。`);
  } else {
    lines.push(`建议设在免费额度以内（如 ${Math.max(freeGb - 20, 1)}GB），超了才会花钱。`);
  }
  if (parsed.invalid) {
    lines.push(`（原阈值不合法：${parsed.invalid}，已按默认 ${limit}GB 处理）`);
  }
  lines.push('');
  lines.push('选一个新的阈值：');

  await tg.sendMenu(token, chatId, lines.join('\n'), limitPresetRows(user));
}

/**
 * 解析用户在「设阈值」流程里发的档位文字（如「150GB」「✅ 180GB」「手动输入」）。
 *
 * @returns {number|null|'manual'}
 *   · 数字  —— 识别出的新阈值（GB）
 *   · 'manual' —— 用户点了「手动输入」，进入等待输入状态
 *   · null  —— 不是阈值相关输入
 */
export function parseLimitChoice(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (L.matchMain(text, L.LBL_LIMIT_MANUAL)) return 'manual';
  // 「✅ 180GB」/「180GB」/「180 gb」/「180」都能识别
  const m = text.replace(/[\u2705\u{FE0F}\s]/gu, '').match(/^(\d+(?:\.\d+)?)\s*(?:gb|g)?$/i);
  if (m) {
    const num = Number(m[1]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

/**
 * 把某台机器的阈值改成 newLimit（GB）。返回给用户的结果说明。
 *
 * 🔴 会校验合法性：不合法直接拒绝并说明，绝不写入坏值。
 *    理由见 guard.js 的 parseTrafficLimit 长注释 —— 阈值一旦变成 0/负数，
 *    下游判断会变成「流量 < 0」永假 → 每 5 分钟强制关机一次。
 */
export async function setDeviceLimit(env, config, instanceId, newLimit) {
  const user = findUserById(config, instanceId);
  if (!user) return '没找到这台机器。';

  const parsed = parseTrafficLimit(newLimit);
  if (parsed.invalid) {
    return `阈值不合法（${parsed.invalid}），已取消，未做修改。\n请输入一个 5–2000 之间的数字，例如 180。`;
  }
  // 再兜一道上下限：太小会误关机，太大等于不设防
  const gb = parsed.limitGb;
  if (gb < 5 || gb > 2000) {
    return `阈值 ${gb}GB 超出合理范围（5–2000GB），已取消，未做修改。`;
  }

  const name = common.sanitize(user.name || instanceId);
  const oldGb = parseTrafficLimit(user.traffic_limit).limitGb;
  user.traffic_limit = gb;
  await common.saveConfig(env, config);

  const region = String(user.region || '');
  const freeGb = api.getFreeQuotaGb(region);
  const lines = [
    `已把 ${name} 的流量阈值改为 ${gb}GB（原 ${oldGb}GB）。`,
    '',
    `本区域免费额度 ${freeGb}GB —— 超了才会花钱。`,
  ];
  if (gb > freeGb) {
    lines.push(`⚠️ 注意：新阈值高于免费额度，进入付费阶梯后不会自动停，会一直扣到 ${gb}GB 才关。`);
  }
  lines.push('下一轮巡检（最长 5 分钟）就会按新阈值执行。');
  return lines.join('\n');
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
      // 取消正在进行的多步流程（「添加账号」或「设阈值」）
      // 注意：/cancel 是命令（以 / 开头），走的是 handleCommand 这条路，
      // 而流程的文字处理在 handlePlainText 里，所以这里必须单独接一下。
      if (await common.getWizard(env, chatId)) {
        await common.clearWizard(env, chatId);
        await tg.sendText(token, chatId, '已取消当前操作，没有改动任何配置。');
      } else if (await common.getLimitWizard(env, chatId)) {
        await common.clearLimitWizard(env, chatId);
        await tg.sendText(token, chatId, '已取消设置阈值，没有改动任何配置。');
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
    await tg.sendText(token, chatId, buildInspectionReply(summary));
  } catch (error) {
    await tg.sendText(token, chatId, `巡检执行失败：${common.sanitize(error)}`);
  }
}

/**
 * 把 runInspection 的返回值翻译成给人看的一句话。
 *
 * 🔴 这里修过一个很丢脸的显示 BUG：
 *     老代码写的是 `` `巡检完成\n\n${summary}\n\n...` ``，
 *     而 summary 是个**对象** `{ ok, checked, skipped }`。
 *     对象插进模板字符串会被转成 `[object Object]`，
 *     于是用户收到的回执是：
 *         「巡检完成  |  | [object Object]」
 *     用户看到这行字完全不知道发生了什么 —— 到底查了几台？
 *     成功了没有？一个字都读不出来。
 *
 * 教训：**模板字符串里永远不要直接插对象**。
 *     哪怕当下看起来能跑，将来返回值一改结构就会变成这句话。
 *     这里改成显式判断每一种返回形态，每种都有一个明确的中文说法。
 *
 * runInspection 的四种返回值（见 guard.js）：
 *   { ok: true,  skipped: true, checked: 0 }   软锁拦住，本轮没跑
 *   { ok: true,  checked: 0 }                  配置里没有机器
 *   { ok: true,  checked: N }                  正常查了 N 台
 *   { ok: false, error: '...' }                巡检过程出错
 */
export function buildInspectionReply(summary) {
  const s = summary || {};
  const parts = [];

  // 🔴 失败必须先判 —— 否则会显示成「✅ 巡检完成」，
  //    而实际上一条记录都没查。这种「假装成功」比报错更害人。
  if (s.ok === false) {
    parts.push('\u26A0\uFE0F 巡检没能完成');
    parts.push('');
    parts.push(`原因：${common.sanitize(s.error || '未知错误')}`);
    parts.push('');
    parts.push('常见原因：配置损坏、存储暂时不可用。');
    parts.push('可稍后重试；若一直失败，请到 Cloudflare 仪表盘看实时日志。');
    return parts.join('\n');
  }

  parts.push('\u2705 巡检完成');

  if (s.checked === 0) {
    // 没有机器可查 —— 这是新手最常见的情况（还没添加任何机器）
    parts.push('');
    parts.push('当前配置里没有正在监控的机器。');
    parts.push('发送 /menu 打开菜单，选「\u2795 添加账号」把机器加进来。');
  } else if (typeof s.checked === 'number' && s.checked > 0) {
    parts.push('');
    parts.push(`本次检查了 ${s.checked} 台机器。`);
    parts.push('如有流量超标或机器异常，稍后会单独发提醒。');
  } else {
    parts.push('');
    parts.push('本轮巡检已执行。');
  }

  parts.push('');
  parts.push('详细过程见 Cloudflare 的实时日志（仪表盘 \u2192 Workers \u2192 日志）。');
  return parts.join('\n');
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

  // ---- 【高优先级】「设阈值」手动输入：用户正在直接发一个数字 ----
  // 必须放在菜单匹配之前，否则「180」会被判成「没听懂」。
  const limitWizard = await common.getLimitWizard(env, chatId);
  if (limitWizard && limitWizard.step === 'manual') {
    const currentKey = await common.getCurrentDevice(env, chatId);
    const target = resolveCurrentDevice(config, currentKey);
    if (!target) {
      await common.clearLimitWizard(env, chatId);
      await tg.sendText(token, chatId, '这台机器已不在配置里，流程已取消。');
      return;
    }
    const num = parseLimitChoice(raw);
    if (typeof num === 'number') {
      const result = await setDeviceLimit(env, config, target.instance_id, num);
      await common.clearLimitWizard(env, chatId);
      await tg.sendText(token, chatId, result);
      await sendMainMenu(token, chatId);
      return;
    }
    // 用户发的不是数字 —— 提示一下，但**保持流程不退出**，方便他重发
    if (String(raw).startsWith('/')) {
      // 命令交给下面正常处理（例如 /cancel 取消）
    } else {
      await tg.sendText(
        token, chatId,
        `「${common.sanitize(raw).slice(0, 20)}」不是一个有效数字。\n` +
        '请发一个 5–2000 之间的数字（单位 GB），例如 180。\n发送 /cancel 可以取消。'
      );
      return;
    }
  }

  // ---- 收起菜单 ----
  if (L.matchMain(raw, L.LBL_HIDE)) {
    await tg.hideMenu(token, chatId);
    return;
  }

  // ---- 一级菜单 ----
  // 「状态总览」= 老「总览」+「实例状态」的合并（一次发两条）
  if (L.matchMain(raw, L.LBL_STATUS_OVERVIEW) || L.matchMain(raw, L.LBL_OVERVIEW)
      || L.matchMain(raw, L.LBL_STATUS)) {
    await tg.sendText(token, chatId, await buildStatus(config));
    await tg.sendText(token, chatId, await buildTraffic(config));
    return;
  }
  // 「流量额度」现在连账号维度一起给（老「账号汇总」已并入）
  if (L.matchMain(raw, L.LBL_TRAFFIC)) {
    await tg.sendText(token, chatId, await buildTraffic(config));
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
  if (L.matchMain(raw, L.LBL_SET_LIMIT)) {
    await common.setLimitWizard(env, chatId, { step: 'pick' });
    await sendLimitDeviceList(token, chatId, config);
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
  const parsedBtn = L.parseDeviceButton(raw);
  if (parsedBtn) {
    // 优先用按钮里的实例 ID 尾段精确锁定机器；
    // 老格式按钮（没有 ID）才退回按名字匹配。
    // 这样「两台机器名字前 22 字相同」也不会再点错。
    let user = null;
    if (parsedBtn.idTail) {
      user = (config?.users || []).find(
        (u) => L.shortIdTail(u?.instance_id) === parsedBtn.idTail
      ) || null;
      if (user && parsedBtn.name) {
        // 双保险：尾段撞车时（概率极低）再用名字确认一下；
        // 名字对不上就说明尾段碰撞了，此时宁可不认，也不要认错。
        const fullName = String(user?.name || '').trim();
        if (fullName && parsedBtn.name && !fullName.startsWith(parsedBtn.name)) {
          user = null;
        }
      }
    }
    if (!user && parsedBtn.name) {
      user = findUserByName(config, parsedBtn.name);
    }
    if (!user) {
      await tg.sendText(token, chatId, '没找到这台机器，可能在配置里被删掉了。');
      await sendDeviceList(token, chatId, config);
      return;
    }
    // 记住选中的机器，三级菜单的按钮要靠它才知道作用于哪台。
    // ⚠️ 存的是 **instance_id**（唯一、不会被截断），不是 name ——
    //    存名字会导致两台同名前缀的机器互相串台，甚至删错机器。
    //    详见 resolveCurrentDevice 的注释。
    await common.setCurrentDevice(env, chatId, user.instance_id || '');

    // 区分「从哪个入口进来的这台机器」：
    //   · 设阈值入口 → 给阈值档位菜单
    //   · 单机操作入口 → 给操作菜单
    if (await common.getLimitWizard(env, chatId)) {
      await sendLimitPresets(token, chatId, user);
      return;
    }
    await sendDeviceActions(token, chatId, user);
    return;
  }

  // ---- 三级菜单（设阈值）：档位 / 手动输入 ----
  if (await common.getLimitWizard(env, chatId)) {
    const currentKey = await common.getCurrentDevice(env, chatId);
    const current = resolveCurrentDevice(config, currentKey);
    if (!current) {
      await common.clearLimitWizard(env, chatId);
      await tg.sendText(token, chatId, '这台机器已不在配置里，流程已取消。');
      await sendMainMenu(token, chatId);
      return;
    }
    if (L.matchMain(raw, L.LBL_BACK_PREV)) {
      await common.clearLimitWizard(env, chatId);
      await sendLimitDeviceList(token, chatId, config);
      return;
    }
    const choice = parseLimitChoice(raw);
    if (choice === 'manual') {
      // 进入「等用户直接发一个数字」的状态，保持 limitWizard
      await common.setLimitWizard(env, chatId, { step: 'manual' });
      await tg.sendText(
        token, chatId,
        '请直接发一个数字（单位 GB），例如 180。\n发送 /cancel 可以取消。'
      );
      return;
    }
    if (typeof choice === 'number') {
      const result = await setDeviceLimit(env, config, current.instance_id, choice);
      await common.clearLimitWizard(env, chatId);
      await tg.sendText(token, chatId, result);
      await sendMainMenu(token, chatId);
      return;
    }
    // 没匹配上任何档位
    await tg.sendText(
      token, chatId,
      '没看懂这个阈值。请点上面的档位，或点「手动输入」直接发一个数字。'
    );
    await sendLimitPresets(token, chatId, current);
    return;
  }

  // ---- 三级菜单 ----
  // 三级菜单的按钮要作用在「某台机器」上，而按钮文字本身不带机器名，
  // 所以这里从会话状态里取「最近一次选中的机器」。
  // 用 resolveCurrentDevice 的**实例 ID 精确匹配**，不用名字模糊匹配。
  const currentKey = await common.getCurrentDevice(env, chatId);
  const current = resolveCurrentDevice(config, currentKey);
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
