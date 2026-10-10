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
// 一级菜单（主菜单）—— 共 13 项，排成 7 行
// ---------------------------------------------------------------------------
export const LBL_OVERVIEW = '\u{1F4CA} 总览';            // 📊
export const LBL_TRAFFIC = '\u{1F4C8} 流量额度';          // 📈
export const LBL_STATUS = '\u{1F4E1} 实例状态';           // 📡
export const LBL_REPORT = '\u{1F4CB} 完整报表';           // 📋
export const LBL_WEEKLY = '\u{1F4C5} 周报';              // 📅
export const LBL_BALANCE = '\u{1F4B0} 余额详情';          // 💰
export const LBL_ACCOUNTS = '\u{1F3E6} 账号汇总';         // 🏦
export const LBL_START_ALL = '\u{1F680} 全部开机';        // 🚀
export const LBL_STOP_ALL = '\u{1F6D1} 全部关机';         // 🛑
export const LBL_DEVICES = '\u{2699}\u{FE0F} 单机操作';   // ⚙️
export const LBL_ADD_ACCOUNT = '\u{2795} 添加账号';       // ➕
export const LBL_CHECK_CRED = '\u{1F511} 凭据体检';       // 🔑
export const LBL_RUN = '\u{1F504} 立即巡检';              // 🔄
export const LBL_HELP = '\u{2139}\u{FE0F} 使用说明';      // ℹ️
export const LBL_HIDE = '\u{274C} 收起菜单';              // ❌

// ---------------------------------------------------------------------------
// 二级菜单
// ---------------------------------------------------------------------------
export const LBL_BACK_MAIN = '\u{1F3E0} 返回主菜单';      // 🏠

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
 * 生成实例列表里的一个按钮文字。
 *
 * 形如「🖥 菲律宾节点」；已暂停的会在后面加个 ⏸️ 标记。
 */
export function buildDeviceButton(name, paused = false) {
  let shortName = String(name || '未命名');
  if (shortName.length > DEVICE_NAME_MAX) {
    shortName = `${shortName.slice(0, DEVICE_NAME_MAX)}…`;
  }
  const mark = paused ? ` ${PAUSED_MARK}` : '';
  return `${DEVICE_PREFIX}${shortName}${mark}`;
}

/**
 * 从按钮文字反查实例名。
 *
 * 不是实例按钮（没有 🖥 前缀）则返回 null。
 * 注意：返回的是**按钮上显示的短名**，可能被截断过，
 * 所以调用方要用「前缀匹配」去配置里找真实实例。
 */
export function parseDeviceButton(text) {
  const raw = String(text || '');
  if (!raw.startsWith(DEVICE_PREFIX)) {
    return null;
  }
  let name = raw.slice(DEVICE_PREFIX.length).trim();
  // 去掉尾部的暂停标记
  if (name.endsWith(PAUSED_MARK)) {
    name = name.slice(0, -PAUSED_MARK.length).trim();
  }
  // 去掉截断省略号（这个名字用于前缀匹配，不是用于精确相等）
  if (name.endsWith('…')) {
    name = name.slice(0, -1);
  }
  return name || null;
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
