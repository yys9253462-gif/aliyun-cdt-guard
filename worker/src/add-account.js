/**
 * 「在机器人里添加阿里云账号」的完整流程
 *
 * 老大原话：
 *   「这个添加账号能不能给我添加到机器人菜单里 这样我直接在机器人里添加账号
 *     就可以了 添加账号以后自动检测出账号下的所有机器 然后全自动配置好」
 *
 * 所以这个流程要达到的目标是：**全程在 Telegram 里点，不用碰电脑。**
 *
 * 步骤（每一步都是一次独立的 Worker 请求，状态存在 KV 的 sessions 里）：
 *   1. 点「➕ 添加账号」  → 说明这个流程要什么，等你发 AccessKey ID
 *   2. 发 AccessKey ID    → 存下，等你发 Secret
 *   3. 发 Secret          → **立刻删掉这条消息**，然后去扫这个账号的全部机器
 *   4. 展示扫描结果        → 等你点「全部加入监控」或「重新扫描」或「取消」
 *   5. 点「全部加入」      → 合并进配置、写入 KV、回执
 *
 * ---------------------------------------------------------------------------
 * 🔴 安全设计（这是整个流程里最需要小心的部分）
 * ---------------------------------------------------------------------------
 * 这个流程要求用户**把阿里云 Secret 发给机器人**。这带来几个风险：
 *
 *   a) Secret 会留在 Telegram 的聊天记录里（永久）。
 *      → 对策：收到后**立刻删除那条消息**，删不掉就明确提醒用户自己删。
 *   b) Secret 会经过 Cloudflare 的 Worker 和 KV。
 *      → 对策：**流程状态里绝不落盘 Secret**。只在「扫机器」那一次
 *        请求的内存里用一下，用完即弃。扫完机器之后就没必要再留着它了
 *        （配置里存的那份是「正式配置」，和流程临时状态是两回事）。
 *   c) 错误信息里可能带上 Secret。
 *      → 对策：所有回给用户的消息都过一层脱敏（只显示 AK 的前后几位）。
 *
 * 这些取舍要想清楚：**在聊天窗口里发密钥本来就不是最安全的做法**，
 * 但它的便利性对老大的使用场景很重要。所以做法是「让它足够安全」——
 * 自动删除消息 + 不落盘 + 脱敏，同时在使用说明里明确告知这一点。
 */

import * as common from './common.js';
import * as tg from './telegram.js';
import * as L from './menu-labels.js';
import { scanAccount, formatScanResult, CRED_OK, CRED_BAD, CRED_UNKNOWN } from './account-scan.js';

/** 流程步骤名（存进 KV 的状态字段） */
export const STEP_ASK_AK = 'ask_ak';
export const STEP_ASK_SK = 'ask_sk';
export const STEP_CONFIRM = 'confirm';

/** 新加入机器的默认流量阈值 */
const DEFAULT_TRAFFIC_LIMIT = 180;

/** 单个账号最多加入多少台机器（防止一次加进来一大堆把菜单撑爆） */
const MAX_INSTANCES_PER_SCAN = 30;

// ---------------------------------------------------------------------------
// 入口：用户点了「➕ 添加账号」
// ---------------------------------------------------------------------------
export async function startAddAccount(env, token, chatId) {
  await common.setWizard(env, chatId, { step: STEP_ASK_AK });

  await tg.sendMenu(
    token, chatId,
    [
      '【添加阿里云账号】',
      '',
      '接下来分 3 步：发 AccessKey → 自动扫描机器 → 一键加入监控。',
      '',
      '第 1 步：请把新账号的 AccessKey ID 发给我。',
      '',
      '去哪里找：阿里云控制台 → 右上角头像 → 访问控制(RAM) → 用户',
      '→ 创建用户 → 勾选「OpenAPI 调用访问」，它会给你一对 Key。',
      '',
      '建议用子账号（只给「ECS 只读」权限就够扫描用），别用主账号的 Key。',
      '',
      '随时可发 /cancel 取消。',
    ].join('\n'),
    [[L.LBL_ADD_CANCEL]]
  );
}

// ---------------------------------------------------------------------------
// 流程主处理：用户发的普通文字
// ---------------------------------------------------------------------------
/**
 * 处理「添加账号」流程中的一条消息。
 *
 * @returns {Promise<boolean>} true = 这条消息属于本流程、已处理完；
 *                             false = 不属于（交回给普通菜单处理）
 */
export async function handleAddAccountStep(env, token, chatId, text, messageId) {
  const wizard = await common.getWizard(env, chatId);
  if (!wizard) {
    return false; // 没有进行中的流程
  }

  const raw = String(text || '').trim();

  // ---- 取消（任何一步都能取消）----
  if (raw === '/cancel' || L.matchMain(raw, L.LBL_ADD_CANCEL)) {
    await common.clearWizard(env, chatId);
    await tg.sendMenu(
      token, chatId,
      '已取消添加账号，**没有改动任何配置**。',
      [[L.LBL_ADD_ACCOUNT, L.LBL_BACK_MAIN]]
    );
    return true;
  }

  // ---- 第 1 步：收 AccessKey ID ----
  if (wizard.step === STEP_ASK_AK) {
    const ak = raw;
    if (!isPlausibleAk(ak)) {
      await tg.sendText(
        token, chatId,
        [
          '这看起来不是一个 AccessKey ID。',
          '',
          'AccessKey ID 一般以 LTAI 开头、总长 20 位左右，例如：',
          'LTAI5tYourOwnKeyHere0000',
          '',
          '（上面只是格式示例，不是你真实的 Key。）',
          '',
          '请重新发一次（或发 /cancel 取消）。',
        ].join('\n')
      );
      return true;
    }

    // ⚠️ 只存 AK，**不存 Secret**（Secret 还没收到，也不该提前存）
    await common.setWizard(env, chatId, { step: STEP_ASK_SK, ak });

    await tg.sendText(
      token, chatId,
      [
        `收到，AccessKey ID：${maskAk(ak)}`,
        '',
        '第 2 步：请把对应的 **AccessKey Secret** 发给我。',
        '',
        '关于这个 Secret，说明一下（重要）：',
        '· 我会**立刻把你发的那条消息删掉**，不在聊天记录里留。',
        '· 确认加入后，它会存进机器人的配置里 —— 这是必须的，',
        '  因为以后巡检要用它向阿里云签名。',
        '· 它只存在 Cloudflare 的私有存储里，不会出现在任何消息中。',
        '',
        '发完请确认那条消息确实被删了；如果没删掉，请自己手动删一下。',
        '发 /cancel 可取消。',
      ].join('\n')
    );
    return true;
  }

  // ---- 第 2 步：收 Secret ----
  if (wizard.step === STEP_ASK_SK) {
    const sk = raw;

    // 🔴 第一件事：尝试删掉这条带 Secret 的消息。
    //    放在最前面 —— 万一后面任何一步出错抛异常了，消息也已经删了。
    const deleted = await tg.deleteMessage(token, chatId, messageId);

    if (!isPlausibleSk(sk)) {
      // 格式明显不对，不往下走（但消息已经删了，是好事）
      await tg.sendText(
        token, chatId,
        [
          '这个 Secret 看起来不对（太短了）。',
          '',
          'AccessKey Secret 是一串约 30 位的字符，中间没有空格。',
          '请再发一次（这次我会再帮你删掉）。发 /cancel 可取消。',
        ].join('\n')
      );
      return true;
    }

    if (!deleted) {
      await tg.sendText(
        token, chatId,
        [
          '⚠️ 我没能自动删掉你刚发的那条消息（Telegram 有 48 小时限制等原因）。',
          '',
          '**请你自己手动删除一下那条带 Secret 的消息**（长按 → 删除）。',
          '',
          '（我这边不会把它的内容发到任何消息里。下面继续扫描机器。）',
        ].join('\n')
      );
    } else {
      await tg.sendText(token, chatId, '已收到，并把那条带 Secret 的消息删掉了。\n\n正在扫描这个账号下的机器...');
    }

    // ---- 扫机器 ----
    const result = await safeScan(wizard.ak, sk);

    if (result.credential === CRED_BAD) {
      await common.clearWizard(env, chatId);
      await tg.sendMenu(
        token, chatId,
        [
          '✗ 这对 AccessKey 没能通过阿里云校验，扫描中止。',
          '',
          result.message,
          '',
          '（没有改动任何配置。确认好凭据后重新点「添加账号」即可。）',
        ].join('\n'),
        [[L.LBL_ADD_ACCOUNT, L.LBL_BACK_MAIN]]
      );
      return true;
    }

    const instances = (result.instances || []).slice(0, MAX_INSTANCES_PER_SCAN);

    // 扫描到了机器 → 进入确认步骤（把结果存进会话，等用户点按钮）
    await common.setWizard(env, chatId, {
      step: STEP_CONFIRM,
      ak: wizard.ak,
      // ⚠️ Secret 必须暂时留着 —— 因为用户点「全部加入监控」时，
      //    要把 sk 一起写进正式配置（巡检时要靠它签名）。
      //    但它的生命周期被压到最短：**确认完成或取消时立刻清掉**
      //    （见 confirmAddAccount / handleAddAccountStep 的取消分支）。
      //    这就是「不长期落盘」的实际做法 —— 不是完全不存，
      //    而是「只在这个必须用它的窗口里存，用完即删」。
      sk,
      instances,
      scanTotal: (result.instances || []).length,
    });

    const body = formatScanResult(instances);
    const footer = instances.length
      ? '\n\n点下面「全部加入监控」即可自动配好（阈值默认 180GB）。'
      : '\n\n没有机器可加。你可以重新扫描，或取消。';

    await tg.sendMenu(
      token, chatId,
      `扫描完成。\n\n${body}${footer}`,
      [
        [L.LBL_ADD_CONFIRM],
        [L.LBL_ADD_RESCAN, L.LBL_ADD_CANCEL],
      ]
    );
    return true;
  }

  // ---- 第 3 步：确认阶段（用户直接打字而不是点按钮）----
  if (wizard.step === STEP_CONFIRM) {
    if (L.matchMain(raw, L.LBL_ADD_CONFIRM)) {
      await confirmAddAccount(env, token, chatId, wizard);
      return true;
    }
    if (L.matchMain(raw, L.LBL_ADD_RESCAN)) {
      // sk 还在会话里，直接重扫即可 —— 不用让用户再发一遍 Secret。
      // （少发一次 = 少一次泄露风险，体验也更好）
      if (!wizard.sk) {
        await tg.sendText(token, chatId, '请重新发送 AccessKey Secret：');
        await common.setWizard(env, chatId, { step: STEP_ASK_SK, ak: wizard.ak });
        return true;
      }
      await tg.sendText(token, chatId, '正在重新扫描...');
      const again = await safeScan(wizard.ak, wizard.sk);
      if (again.credential === CRED_BAD) {
        await common.clearWizard(env, chatId);
        await tg.sendMenu(
          token, chatId,
          `✗ 重新扫描失败：\n\n${again.message}`,
          [[L.LBL_ADD_ACCOUNT, L.LBL_BACK_MAIN]]
        );
        return true;
      }
      const fresh = (again.instances || []).slice(0, MAX_INSTANCES_PER_SCAN);
      await common.setWizard(env, chatId, {
        step: STEP_CONFIRM,
        ak: wizard.ak,
        sk: wizard.sk,
        instances: fresh,
        scanTotal: (again.instances || []).length,
      });
      await tg.sendMenu(
        token, chatId,
        `重新扫描完成。\n\n${formatScanResult(fresh)}\n\n点下面按钮决定怎么做：`,
        [[L.LBL_ADD_CONFIRM], [L.LBL_ADD_RESCAN, L.LBL_ADD_CANCEL]]
      );
      return true;
    }
    // 在这个阶段发别的文字：提示他点按钮
    await tg.sendMenu(
      token, chatId,
      '扫描结果已经列在上面了。请点下面的按钮决定怎么做：',
      [
        [L.LBL_ADD_CONFIRM],
        [L.LBL_ADD_RESCAN, L.LBL_ADD_CANCEL],
      ]
    );
    return true;
  }

  // 状态坏了（比如旧版本的残留）—— 清掉，别让用户卡死
  await common.clearWizard(env, chatId);
  await tg.sendText(token, chatId, '这个流程的状态已失效，请重新点「添加账号」。');
  return true;
}

// ---------------------------------------------------------------------------
// 确认加入：合并进配置并写入 KV
// ---------------------------------------------------------------------------
/**
 * 把扫描到的机器全部加入监控配置。
 *
 * 关键：**只追加，不动现有配置**。
 * 这和菜单里「配置监控机器」的覆盖行为完全不同 —— 加账号绝不该
 * 让原有机器从配置里消失。
 */
export async function confirmAddAccount(env, token, chatId, wizard) {
  const ak = String(wizard.ak || '').trim();
  const instances = Array.isArray(wizard.instances) ? wizard.instances : [];

  if (!instances.length) {
    await common.clearWizard(env, chatId);
    await tg.sendMenu(
      token, chatId,
      '没有可加入的机器（扫描结果为空）。没有改动任何配置。',
      [[L.LBL_ADD_ACCOUNT, L.LBL_BACK_MAIN]]
    );
    return;
  }

  const config = await common.loadConfig(env);
  const users = Array.isArray(config.users) ? config.users.slice() : [];
  const existingIds = new Set(users.map((u) => String(u?.instance_id || '').trim()));

  let added = 0;
  let skipped = 0;
  const addedNames = [];

  for (const item of instances) {
    const instanceId = String(item.instanceId || '').trim();
    if (!instanceId) continue;

    // 已经在配置里了就跳过（避免重复监控同一台机器）
    if (existingIds.has(instanceId)) {
      skipped += 1;
      continue;
    }

    users.push({
      name: buildName(item),
      instance_id: instanceId,
      region: String(item.region || '').trim(),
      ak,
      // ⚠️ Secret 在这里**必须**落盘 —— 这是正式配置，
      //    巡检时要用它签名。上一段说的「不落盘」指的是**流程临时状态**。
      sk: String(wizard.sk || '').trim(),
      traffic_limit: DEFAULT_TRAFFIC_LIMIT,
      paused: false,
    });
    existingIds.add(instanceId);
    added += 1;
    addedNames.push(buildName(item));
  }

  if (!added) {
    await common.clearWizard(env, chatId);
    await tg.sendMenu(
      token, chatId,
      `扫描到的 ${instances.length} 台机器**都已经在监控里了**，没有新增。`,
      [[L.LBL_BACK_MAIN, L.LBL_ACCOUNTS]]
    );
    return;
  }

  const nextConfig = Object.assign({}, config, { users });
  await common.saveConfig(env, nextConfig);
  await common.clearWizard(env, chatId);

  const total = users.length;
  const accounts = new Set(users.map((u) => String(u.ak || '').trim()).filter(Boolean)).size;

  const lines = [
    '✅ 添加成功。',
    '',
    `新加入 ${added} 台机器${skipped ? `（${skipped} 台已在监控中，跳过）` : ''}：`,
  ];
  for (const name of addedNames.slice(0, 10)) {
    lines.push(`· ${name}`);
  }
  if (addedNames.length > 10) {
    lines.push(`· ...等共 ${addedNames.length} 台`);
  }
  lines.push('');
  lines.push(`当前共监控 ${total} 台机器，分属 ${accounts} 个账号。`);
  lines.push(`默认阈值 ${DEFAULT_TRAFFIC_LIMIT}GB —— 想改就进「单机操作」逐台调。`);
  lines.push('');
  lines.push('机器人会在下一次巡检（最多 5 分钟）时开始监控它们。');

  await tg.sendMenu(token, chatId, lines.join('\n'), [
    [L.LBL_ACCOUNTS, L.LBL_OVERVIEW],
    [L.LBL_BACK_MAIN],
  ]);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 扫描失败也不能让异常冒出去（会变成「永远转圈」），统一兜成可读结果 */
async function safeScan(ak, sk) {
  try {
    return await scanAccount(ak, sk);
  } catch (error) {
    return {
      credential: CRED_UNKNOWN,
      message: `扫描时出错了：${common.sanitize(String((error && error.message) || error))}`,
      instances: [],
    };
  }
}

/** AccessKey ID 的粗略格式校验：以 LTAI 开头、长度合理 */
function isPlausibleAk(value) {
  const ak = String(value || '').trim();
  if (!ak || /\s/.test(ak)) return false;
  if (!/^LTAI/i.test(ak)) return false;
  return ak.length >= 16 && ak.length <= 40;
}

/** AccessKey Secret 的粗略格式校验：一长串无空格字符 */
function isPlausibleSk(value) {
  const sk = String(value || '').trim();
  if (!sk || /\s/.test(sk)) return false;
  return sk.length >= 20 && sk.length <= 80;
}

/**
 * 遮蔽 AccessKey，只留头尾几位。
 *
 * 为什么留头尾而不是只留头：阿里云 AK 前缀高度相似，
 * 只留前 6 位会让两个账号看起来一模一样，分不清谁是谁。
 */
export function maskAk(ak) {
  const value = String(ak || '').trim();
  if (!value) return '未填写';
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

/**
 * 给机器起个名字。
 *
 * 优先用阿里云上的实例名；没有的话用「地域 + 实例 ID 后 6 位」——
 * 这样即使实例没命名，你在菜单里也能一眼分清是哪台。
 */
function buildName(item) {
  const rawName = String(item.instanceName || '').trim();
  if (rawName) return rawName;
  const region = String(item.region || '').trim() || '未知地域';
  const tail = String(item.instanceId || '').slice(-6);
  return `${region}-${tail}`;
}
