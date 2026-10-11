/**
 * 菜单文案表（Cloudflare Workers 版）
 *
 * 对应 Python 版的 menu_labels.py。
 *
 * 为什么要把文案集中在一个文件里：
 *     菜单按钮文字和「文字 → 动作」的匹配逻辑必须一一对应。
 *     如果文案散落在各处，哪天改了菜单忘了改匹配，就会出现
 *     「点了按钮没反应」这种静默失效 —— 界面看着正常，功能是坏的。
 *     集中管理后，两边引用同一个常量，改一处就够。
 *
 * ⚠️ 转义写法注意：这里必须用 JavaScript 的 \u{...} 语法，
 *    不能照抄 Python 的 \U0001f4ca —— 后者在 JS 里会变成字面文本。
 */

// ---------------------------------------------------------------------------
// 一级菜单（主菜单）—— 精简为 8 项，排成 4 行（+ 收起单独一行）
// ---------------------------------------------------------------------------
// 🔴 精简原则（2026-10-11，用户反馈「好多功能都没用」）：
//   删掉的全是**与其它项重复**的，而不是砍能力：
//     · 「总览」    = 「实例状态」+「流量额度」一次发两条 → 合并进「状态总览」
//     · 「实例状态」 → 并入「状态总览」
//     · 「完整报表」 → 与「状态总览」内容高度重合，用 /report 命令保留
//     · 「周报」    → 低频查看，用 /weekly 命令保留
//     · 「余额详情」 → 与「账号汇总」重复（都查余额/账单），用 /balance 保留
//     · 「账号汇总」 → 并入「流量额度」（页面里本来就有账号维度）
//     · 「凭据体检」 → 巡检本身会盯凭据失效，用 /creds 命令保留
//     · 「使用说明」 → 用 /help 命令保留（菜单里少一项，少一分误点）
//   保留下来的都是**每天要用**的：看状态、看流量、管机器、加账号、
//   调阈值、立即巡检。命令（/report /weekly /balance /creds /help）一个没少。
export const LBL_STATUS_OVERVIEW = '\u{1F4CA} 状态总览';   // 📊
export const LBL_TRAFFIC = '\u{1F4C8} 流量额度';          // 📈
export const LBL_DEVICES = '\u{1F5A5} 单机操作';          // 🖥
export const LBL_START_ALL = '\u{1F680} 全部开机';        // 🚀
export const LBL_STOP_ALL = '\u{1F6D1} 全部关机';         // 🛑
export const LBL_ADD_ACCOUNT = '\u{2795} 添加账号';       // ➕
export const LBL_SET_LIMIT = '\u{1F39A} 设阈值';          // 🎚
export const LBL_RUN = '\u{1F504} 立即巡检';              // 🔄
export const LBL_HIDE = '\u{274C} 收起菜单';              // ❌

// ---- 以下旧标签保留为常量，供「文字直输」与命令路由继续识别 ----
// （菜单里不再显示，但用户手打「总览」「周报」等仍能命中，不算废掉功能）
export const LBL_OVERVIEW = '\u{1F4CA} 总览';            // 📊
export const LBL_STATUS = '\u{1F4E1} 实例状态';           // 📡
export const LBL_REPORT = '\u{1F4CB} 完整报表';           // 📋
export const LBL_WEEKLY = '\u{1F4C5} 周报';              // 📅
export const LBL_BALANCE = '\u{1F4B0} 余额详情';          // 💰
export const LBL_ACCOUNTS = '\u{1F3E6} 账号汇总';         // 🏦
export const LBL_CHECK_CRED = '\u{1F511} 凭据体检';       // 🔑
export const LBL_HELP = '\u{2139}\u{FE0F} 使用说明';      // ℹ️

// ---------------------------------------------------------------------------
// 二级菜单
// ---------------------------------------------------------------------------
export const LBL_BACK_MAIN = '\u{1F3E0} 返回主菜单';      // 🏠

// ---------------------------------------------------------------------------
// 三级菜单（设阈值）—— 选机器 → 快捷档位 / 手动输入
// ---------------------------------------------------------------------------
export const LBL_BACK_PREV = '\u{1F519} 返回上一步';      // 🔙
export const LBL_LIMIT_MANUAL = '\u{270F}\u{FE0F} 手动输入'; // ✏️
export const LBL_LIMIT_PRESETS_TITLE = '选择新的流量阈值';

// ---------------------------------------------------------------------------
// 「添加阿里云账号」流程用到的按钮（二级/三级混合，都在流程内）
// ---------------------------------------------------------------------------
export const LBL_ADD_CONFIRM = '\u{2705} 全部加入监控';   // ✅
export const LBL_ADD_RESCAN = '\u{1F504} 重新扫描';       // 🔄
export const LBL_ADD_CANCEL = '\u{274C} 取消添加';        // ❌

// ---------------------------------------------------------------------------
// 三级菜单（单机操作）
// ---------------------------------------------------------------------------
export const LBL_DEV_STATUS = '\u{1F4CA} 状态';           // 📊
export const LBL_DEV_START = '\u{1F680} 开机';            // 🚀
export const LBL_DEV_STOP = '\u{1F6D1} 关机';             // 🛑
export const LBL_DEV_PAUSE = '\u{23F8}\u{FE0F} 暂停监控'; // ⏸️
export const LBL_DEV_RESUME = '\u{25B6}\u{FE0F} 恢复监控'; // ▶️
export const LBL_DEV_DELETE = '\u{1F5D1} 删除机器';       // 🗑
export const LBL_BACK_LIST = '\u{1F519} 返回列表';        // 🔙

/** 实例按钮的图标前缀 */
export const DEVICE_PREFIX = '\u{1F5A5} ';                // 🖥

/**
 * 实例名在按钮里最多显示多少个字（太长会撑破布局）。
 *
 * 🔴 这个值从 12 提到 22 是有原因的，别随手改回去：
 *     自动生成的机器名是「中文地域-账号标识-机器尾号」三段式，
 *     例如 `马尼拉-LTAI5t-3stsujw0r`（中文 3 + 1 + 6 + 1 + 10 ≈ 23 字符）。
 *     若仍按 12 截断，会变成 `马尼拉-LTAI5t-3…` ——
 *     **把最关键的「机器尾号」正好截掉了**，同账号同地域的多台机器
 *     在菜单里会长得一模一样，用户根本分不清点的是哪台。
 *     三段里「机器尾号」是唯一区分同类机器的那一段，必须保住。
 *
 *     Telegram 回复键盘一行最多 3 个按钮，22 字符 × 3 仍在单行宽度内
 *     （实测不换行、不截断）。真遇到超长实例名（用户自己起的），
 *     仍会被截断到 22 —— 那时截掉的是用户自己起的后缀，不会丢关键信息。
 */
export const DEVICE_NAME_MAX = 22;

/** 暂停状态的标记（跟在名字后面） */
export const PAUSED_MARK = '\u{23F8}\u{FE0F}';            // ⏸️

/**
 * 实例 ID 在按钮里保留多少个尾字符。
 *
 * 🔴 为什么要在按钮文字里塞一段实例 ID（这是修一个「删错机器」的 BUG）：
 *
 *   按钮文字原来**只有名字**。而名字会被截断到 22 字，于是：
 *     机器 A：`香港-生产环境-新加坡中转节点-AAAA`
 *     机器 B：`香港-生产环境-新加坡中转节点-BBBB`
 *   两台截断后都显示成 `香港-生产环境-新加坡中转节点-A…` 之类，
 *   看上去几乎一样。用户点 B，程序却用「前缀匹配」找回了 A，
 *   于是「删 B」实际删掉的是 A —— 不可逆的错误。
 *
 *   实例 ID（`i-xxxxxxxxxxxxxxxx`）由阿里云分配、**保证唯一且绝不被截断**，
 *   是唯一可靠的定位依据。但整个 ID 太长（18+ 字符）放不下，
 *   所以只取**尾部 8 个字符** —— 它既足够区分（8 位 hex 的碰撞概率极低），
 *   又刚好是用户看得懂、能对上号的「机器尾号」。
 *
 *   这样按钮文字 = `🖥 名字… [尾号]`，点按钮即可直接精确定位到唯一实例。
 */
export const DEVICE_ID_TAIL = 8;

/**
 * 取实例 ID 的尾段（用于按钮显示与精确定位）。
 *
 * `i-faketest0000stsujw0r` → `stsujw0r`（取最后 8 位）
 */
export function shortIdTail(instanceId) {
  const id = String(instanceId || '').trim();
  if (!id) return '';
  return id.length <= DEVICE_ID_TAIL ? id : id.slice(-DEVICE_ID_TAIL);
}

/**
 * 生成实例列表里的一个按钮文字。
 *
 * 形如「🖥 菲律宾节点 [3stsujw0r]」；已暂停的会在后面加个 ⏸️ 标记。
 *
 * 尾部的 `[xxxxxxxx]` 是实例 ID 的尾段（见 DEVICE_ID_TAIL 的长注释）——
 * 它既是给用户看的「机器尾号」，也是程序精确定位的依据。
 * 名字重名 / 被截断都不再导致找错机器。
 */
export function buildDeviceButton(name, paused = false, instanceId = '') {
  let shortName = String(name || '未命名');
  if (shortName.length > DEVICE_NAME_MAX) {
    shortName = `${shortName.slice(0, DEVICE_NAME_MAX)}…`;
  }
  const mark = paused ? ` ${PAUSED_MARK}` : '';
  const tail = shortIdTail(instanceId);
  const idPart = tail ? ` [${tail}]` : '';
  return `${DEVICE_PREFIX}${shortName}${mark}${idPart}`;
}

/**
 * 从按钮文字反查「实例名 + 实例 ID 尾段」。
 *
 * 不是实例按钮（没有 🖥 前缀）则返回 null。
 *
 * 返回 { name, idTail }：
 *   name    按钮上显示的短名（可能被截断，仅用于显示与兜底匹配）
 *   idTail  实例 ID 尾段；为空表示这是个老格式按钮（没有 ID 信息）
 *
 * ⚠️ 调用方**应当优先用 idTail 精确匹配**，只有拿不到 idTail 时才退回
 *    按名字前缀匹配。原因见 DEVICE_ID_TAIL 的注释（否则会删错机器）。
 */
export function parseDeviceButton(text) {
  const raw = String(text || '');
  if (!raw.startsWith(DEVICE_PREFIX)) {
    return null;
  }
  let rest = raw.slice(DEVICE_PREFIX.length).trim();

  // 先把尾部的「 [xxxxxxxx]」摘出来
  let idTail = '';
  const m = rest.match(/\s*\[([0-9a-zA-Z-]{1,64})\]\s*$/);
  if (m) {
    idTail = m[1];
    rest = rest.slice(0, m.index).trim();
  }

  // 去掉尾部的暂停标记
  if (rest.endsWith(PAUSED_MARK)) {
    rest = rest.slice(0, -PAUSED_MARK.length).trim();
  }
  // 去掉截断省略号
  if (rest.endsWith('…')) {
    rest = rest.slice(0, -1);
  }
  if (!rest && !idTail) return null;
  return { name: rest, idTail };
}

/**
 * 去掉开头的图标与空格，只留文字部分。
 *
 * 为什么要做这个：
 *     用户可能直接手打「总览」两个字，而不是点按钮（按钮文字是「📊 总览」）。
 *     两种都得认，所以匹配前统一把图标剥掉。
 */
export function stripIcon(text) {
  let result = String(text || '').trim();
  // 去掉开头的 emoji / 符号 / 变体选择符 / 零宽连接符 / 空格
  result = result.replace(
    /^[\p{Extended_Pictographic}\p{Emoji_Component}\u{FE0F}\u{200D}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]+\s*/u,
    ''
  );
  return result.trim();
}

/**
 * 同时接受「带图标的按钮文字」和「去掉图标的纯文字」。
 *
 * 返回 true 表示这个输入应该触发 label 对应的动作。
 */
export function matchMain(text, label) {
  const raw = String(text || '').trim();
  if (raw === label) {
    return true;
  }
  const strippedInput = stripIcon(raw);
  const strippedLabel = stripIcon(label);
  return strippedInput !== '' && strippedInput === strippedLabel;
}
