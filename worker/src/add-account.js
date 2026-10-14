import { CRED_BAD, CRED_UNKNOWN, formatScanResult, scanAccount } from './account-scan.js';
import { maskAk } from './account-summary.js';
import { clearWizard, getWizard, loadConfig, resetNavigation, sanitize, saveConfig, setWizard } from './common.js';
import { LBL_ACCOUNTS, LBL_ADD_ACCOUNT, LBL_ADD_CANCEL, LBL_ADD_CONFIRM, LBL_ADD_RESCAN, LBL_BACK_MAIN, LBL_OVERVIEW, matchMain } from './menu-labels.js';
import { regionDisplayName } from './region-names.js';
import { deleteMessage, sendMenu, sendText } from './telegram.js';

var STEP_ASK_AK = "ask_ak";
var STEP_ASK_SK = "ask_sk";
var STEP_CONFIRM = "confirm";
var DEFAULT_TRAFFIC_LIMIT = 180;
var MAX_INSTANCES_PER_SCAN = 30;
async function startAddAccount(env, token, chatId) {
  await resetNavigation(env, chatId);
  await setWizard(env, chatId, { step: STEP_ASK_AK });
  await sendMenu(
    token,
    chatId,
    [
      "【添加阿里云账号】",
      "",
      "接下来分 3 步：发 AccessKey → 自动扫描机器 → 一键加入监控。",
      "",
      "第 1 步：请把新账号的 AccessKey ID 发给我。",
      "",
      "去哪里找：阿里云控制台 → 右上角头像 → 访问控制(RAM) → 用户",
      "→ 创建用户 → 勾选「OpenAPI 调用访问」，它会给你一对 Key。",
      "",
      "建议用子账号（只给「ECS 只读」权限就够扫描用），别用主账号的 Key。",
      "",
      "随时可发 /cancel 取消。",
      // ⚠️ 超时规则必须写出来（2026-10-12）：流程状态 15 分钟自动作废，
      //    但旧文案从没提过 —— 用户中途去忙别的，回来接着发密钥，
      //    只会收到一句「这个流程的状态已失效」，完全不知道等了多久。
      "（本流程 15 分钟内有效，超时需要重新点「添加账号」。）"
    ].join("\n"),
    [[LBL_ADD_CANCEL]]
  );
}
async function handleAddAccountStep(env, token, chatId, text, messageId) {
  const wizard = await getWizard(env, chatId);
  if (!wizard) {
    return false;
  }
  const raw = String(text || "").trim();
  if (raw === "/cancel" || matchMain(raw, LBL_ADD_CANCEL)) {
    await clearWizard(env, chatId);
    await sendMenu(
      token,
      chatId,
      "已取消添加账号，**没有改动任何配置**。",
      [[LBL_ADD_ACCOUNT, LBL_BACK_MAIN]]
    );
    return true;
  }
  if (wizard.step === STEP_ASK_AK) {
    const ak = raw;
    if (!isPlausibleAk(ak)) {
      await sendText(
        token,
        chatId,
        [
          "这看起来不是一个 AccessKey ID。",
          "",
          "AccessKey ID 一般以 LTAI 开头、总长 20 位左右，例如：",
          "LTAI5tYourOwnKeyHere0000",
          "",
          "（上面只是格式示例，不是你真实的 Key。）",
          "",
          "请重新发一次（或发 /cancel 取消）。"
        ].join("\n")
      );
      return true;
    }
    await setWizard(env, chatId, { step: STEP_ASK_SK, ak });
    await sendText(
      token,
      chatId,
      [
        `收到，AccessKey ID：${maskAk(ak)}`,
        "",
        "第 2 步：请把对应的 **AccessKey Secret** 发给我。",
        "",
        "关于这个 Secret，说明一下（重要）：",
        "\xB7 我会**立刻把你发的那条消息删掉**，不在聊天记录里留。",
        "\xB7 确认加入后，它会存进机器人的配置里 —— 这是必须的，",
        "  因为以后巡检要用它向阿里云签名。",
        "\xB7 它只存在 Cloudflare 的私有存储里，不会出现在任何消息中。",
        "",
        "发完请确认那条消息确实被删了；如果没删掉，请自己手动删一下。",
        "发 /cancel 可取消。"
      ].join("\n")
    );
    return true;
  }
  if (wizard.step === STEP_ASK_SK) {
    const sk = raw;
    const deleted = await deleteMessage(token, chatId, messageId);
    if (!isPlausibleSk(sk)) {
      await sendText(
        token,
        chatId,
        [
          "这个 Secret 看起来不对（太短了）。",
          "",
          "AccessKey Secret 是一串约 30 位的字符，中间没有空格。",
          "请再发一次（这次我会再帮你删掉）。发 /cancel 可取消。"
        ].join("\n")
      );
      return true;
    }
    if (!deleted) {
      await sendText(
        token,
        chatId,
        [
          "⚠️ 我没能自动删掉你刚发的那条消息（Telegram 有 48 小时限制等原因）。",
          "",
          "**请你自己手动删除一下那条带 Secret 的消息**（长按 → 删除）。",
          "",
          "（我这边不会把它的内容发到任何消息里。下面继续扫描机器。）"
        ].join("\n")
      );
    } else {
      await sendText(token, chatId, "已收到，并把那条带 Secret 的消息删掉了。\n\n正在扫描这个账号下的机器...");
    }
    const result = await safeScan(wizard.ak, sk);
    if (result.credential === CRED_BAD) {
      await clearWizard(env, chatId);
      await sendMenu(
        token,
        chatId,
        [
          "✗ 这对 AccessKey 没能通过阿里云校验，扫描中止。",
          "",
          result.message,
          "",
          "（没有改动任何配置。确认好凭据后重新点「添加账号」即可。）"
        ].join("\n"),
        [[LBL_ADD_ACCOUNT, LBL_BACK_MAIN]]
      );
      return true;
    }
    if (result.credential === CRED_UNKNOWN) {
      await sendMenu(
        token,
        chatId,
        [
          "⚠️ 扫描没能完成（不是凭据的问题）。",
          "",
          result.message,
          "",
          "你的密钥没有改动任何配置。稍后点下面的「重新扫描」即可重试。"
        ].join("\n"),
        [[LBL_ADD_RESCAN, LBL_ADD_CANCEL]]
      );
      return true;
    }
    const instances = (result.instances || []).slice(0, MAX_INSTANCES_PER_SCAN);
    await setWizard(env, chatId, {
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
      scanTotal: (result.instances || []).length
    });
    const body = formatScanResult(instances, 20, result.failedRegions);
    const footer = instances.length ? "\n\n点下面「全部加入监控」即可自动配好（内地默认 18GB，非内地默认 180GB）。" : "\n\n没有机器可加。你可以重新扫描，或取消。";
    await sendMenu(
      token,
      chatId,
      `扫描完成。

${body}${footer}`,
      [
        [LBL_ADD_CONFIRM],
        [LBL_ADD_RESCAN, LBL_ADD_CANCEL]
      ]
    );
    return true;
  }
  if (wizard.step === STEP_CONFIRM) {
    if (matchMain(raw, LBL_ADD_CONFIRM)) {
      await confirmAddAccount(env, token, chatId, wizard);
      return true;
    }
    if (matchMain(raw, LBL_ADD_RESCAN)) {
      if (!wizard.sk) {
        await sendText(token, chatId, "请重新发送 AccessKey Secret：");
        await setWizard(env, chatId, { step: STEP_ASK_SK, ak: wizard.ak });
        return true;
      }
      await sendText(token, chatId, "正在重新扫描...");
      const again = await safeScan(wizard.ak, wizard.sk);
      if (again.credential === CRED_BAD) {
        await clearWizard(env, chatId);
        await sendMenu(
          token,
          chatId,
          `✗ 重新扫描失败：

${again.message}`,
          [[LBL_ADD_ACCOUNT, LBL_BACK_MAIN]]
        );
        return true;
      }
      if (again.credential === CRED_UNKNOWN) {
        await sendMenu(
          token,
          chatId,
          `⚠️ 重新扫描没能完成（不是凭据的问题）：

${again.message}

请稍后再点一次「重新扫描」。`,
          [[LBL_ADD_RESCAN, LBL_ADD_CANCEL]]
        );
        return true;
      }
      const fresh = (again.instances || []).slice(0, MAX_INSTANCES_PER_SCAN);
      await setWizard(env, chatId, {
        step: STEP_CONFIRM,
        ak: wizard.ak,
        sk: wizard.sk,
        instances: fresh,
        scanTotal: (again.instances || []).length
      });
      await sendMenu(
        token,
        chatId,
        `重新扫描完成。

${formatScanResult(fresh, 20, again.failedRegions)}

点下面按钮决定怎么做：`,
        [[LBL_ADD_CONFIRM], [LBL_ADD_RESCAN, LBL_ADD_CANCEL]]
      );
      return true;
    }
    await sendMenu(
      token,
      chatId,
      "扫描结果已经列在上面了。请点下面的按钮决定怎么做：",
      [
        [LBL_ADD_CONFIRM],
        [LBL_ADD_RESCAN, LBL_ADD_CANCEL]
      ]
    );
    return true;
  }
  await clearWizard(env, chatId);
  await sendText(token, chatId, "这个流程的状态已失效，请重新点「添加账号」。");
  return true;
}
async function confirmAddAccount(env, token, chatId, wizard) {
  const ak = String(wizard.ak || "").trim();
  const instances = Array.isArray(wizard.instances) ? wizard.instances : [];
  if (!instances.length) {
    await clearWizard(env, chatId);
    await sendMenu(
      token,
      chatId,
      "没有可加入的机器（扫描结果为空）。没有改动任何配置。",
      [[LBL_ADD_ACCOUNT, LBL_BACK_MAIN]]
    );
    return;
  }
  const config = await loadConfig(env);
  const users = Array.isArray(config.users) ? config.users.slice() : [];
  const existingIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < users.length; i += 1) {
    const id = String(users[i]?.instance_id || "").trim();
    if (id) existingIndex.set(id, i);
  }
  let added = 0;
  let skipped = 0;
  let updated = 0;
  const addedNames = [];
  const updatedNames = [];
  for (const item of instances) {
    const instanceId = String(item.instanceId || "").trim();
    if (!instanceId) continue;
    const pos = existingIndex.get(instanceId);
    if (pos === void 0) {
      const name = buildName(item, ak);
      users.push({
        name,
        instance_id: instanceId,
        region: String(item.region || "").trim(),
        ak,
        // ⚠️ Secret 在这里**必须**落盘 —— 这是正式配置，
        //    巡检时要用它签名。上一段说的「不落盘」指的是**流程临时状态**。
        sk: String(wizard.sk || "").trim(),
        traffic_limit: item.isOverseas === false || String(item.region).startsWith("cn-") && item.region !== "cn-hongkong" ? 18 : DEFAULT_TRAFFIC_LIMIT,
        paused: false
      });
      existingIndex.set(instanceId, users.length - 1);
      added += 1;
      addedNames.push(name);
      continue;
    }
    const old = users[pos] || {};
    const oldAk = String(old.ak || "").trim();
    const newSk = String(wizard.sk || "").trim();
    const oldSk = String(old.sk || "").trim();
    if (oldAk !== ak || oldSk !== newSk) {
      users[pos] = Object.assign({}, old, {
        ak,
        sk: newSk,
        // 机器名以「用户现有配置」为准：只有原来没名字时才用扫描结果补一个。
        // ⚠️ 尤其注意：**换密钥时绝对不能覆盖已有的名字** ——
        //    用户可能已经手动改成了「菲律宾节点」这种好记的名字，
        //    而且旧名字里的账号标识（LTAI5t）本来也还是旧 AK 的，
        //    虽然对不上新 AK，但那也是用户自己的选择，不该被系统改掉。
        name: String(old.name || "").trim() || buildName(item, ak),
        region: String(old.region || "").trim() || String(item.region || "").trim()
      });
      updated += 1;
      updatedNames.push(String(users[pos].name || instanceId));
      continue;
    }
    skipped += 1;
  }
  if (!added && !updated) {
    await clearWizard(env, chatId);
    await sendMenu(
      token,
      chatId,
      `扫描到的 ${instances.length} 台机器**都已经在监控里了**（凭据也没有变化），没有改动。`,
      [[LBL_BACK_MAIN, LBL_ACCOUNTS]]
    );
    return;
  }
  const nextConfig = Object.assign({}, config, { users });
  await saveConfig(env, nextConfig);
  await clearWizard(env, chatId);
  const total = users.length;
  const accounts = new Set(users.map((u) => String(u.ak || "").trim()).filter(Boolean)).size;
  const lines = [];
  const parts = [];
  if (added) parts.push(`新加入 ${added} 台`);
  if (updated) parts.push(`更新凭据 ${updated} 台`);
  if (skipped) parts.push(`已是同样配置 ${skipped} 台`);
  lines.push(updated && !added ? "✅ 凭据已更新。" : "✅ 添加成功。");
  lines.push("");
  lines.push(`${parts.join("，")}：`);
  for (const name of addedNames.concat(updatedNames).slice(0, 10)) {
    lines.push(`\xB7 ${name}`);
  }
  if (addedNames.length + updatedNames.length > 10) {
    lines.push(`\xB7 ...等共 ${addedNames.length + updatedNames.length} 台`);
  }
  lines.push("");
  lines.push(`当前共监控 ${total} 台机器，分属 ${accounts} 个账号。`);
  lines.push(`默认阈值 ${DEFAULT_TRAFFIC_LIMIT}GB —— 内地新增机器使用 18GB；想改就进「设阈值」逐台调。`);
  if (added) {
    lines.push("");
    lines.push("（阿里云上没起名字的机器，我按「中文地域-账号标识-机器尾号」自动命名，");
    lines.push("  比如「马尼拉-LTAI5t-3stsujw0r」。账号标识就是「账号汇总」里显示的前 6 位。）");
  }
  lines.push("");
  lines.push("机器人会在下一次巡检（最多 5 分钟）时按新凭据开始工作。");
  await sendMenu(token, chatId, lines.join("\n"), [
    [LBL_ACCOUNTS, LBL_OVERVIEW],
    [LBL_BACK_MAIN]
  ]);
}
async function safeScan(ak, sk) {
  try {
    return await scanAccount(ak, sk);
  } catch (error) {
    return {
      credential: CRED_UNKNOWN,
      message: `扫描时出错了：${sanitize(String(error && error.message || error))}`,
      instances: []
    };
  }
}
function isPlausibleAk(value) {
  const ak = String(value || "").trim();
  if (!ak || /\s/.test(ak)) return false;
  if (!/^LTAI/i.test(ak)) return false;
  return ak.length >= 16 && ak.length <= 40;
}
function isPlausibleSk(value) {
  const sk = String(value || "").trim();
  if (!sk || /\s/.test(sk)) return false;
  return sk.length >= 20 && sk.length <= 80;
}
function buildName(item, ak) {
  const rawName = String(item.instanceName || "").trim();
  if (rawName) return rawName;
  const regionCn = regionDisplayName(item.region);
  const accountTag = accountTagOf(ak);
  const tail = String(item.instanceId || "").slice(-6);
  const parts = [regionCn];
  if (accountTag) parts.push(accountTag);
  if (tail) parts.push(tail);
  return parts.join("-");
}
function accountTagOf(ak) {
  const value = String(ak || "").trim();
  if (!value) return "";
  return maskAk(value).slice(0, 6);
}

export { DEFAULT_TRAFFIC_LIMIT, MAX_INSTANCES_PER_SCAN, STEP_ASK_AK, STEP_ASK_SK, STEP_CONFIRM, accountTagOf, buildName, confirmAddAccount, handleAddAccountStep, isPlausibleAk, isPlausibleSk, safeScan, startAddAccount };
// 兼容旧调用方：maskAk 现在住在 account-summary.js
export { maskAk };
