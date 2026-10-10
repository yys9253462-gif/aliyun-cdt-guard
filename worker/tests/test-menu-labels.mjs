/**
 * menu-labels.js 自检
 *
 * 重点验证：
 *   1. emoji 转义是否真的被解释（而不是变成字面文本 "U0001f4ca"）
 *   2. 13 项一级菜单标签无重复、不含英文字母
 *   3. buildDeviceButton / parseDeviceButton / matchMain 往返正确
 */

import * as M from '../src/menu-labels.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2705 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u274C ${name}  ${extra}`);
  }
}

// ---------------------------------------------------------------------------
console.log('--- 1. emoji 转义是否被解释 ---');
const rawDump = JSON.stringify(M.LBL_OVERVIEW);
console.log(`  LBL_OVERVIEW 原始值: ${rawDump}`);
console.log(`  LBL_DEVICES  原始值: ${JSON.stringify(M.LBL_DEVICES)}`);
check('总览含 U+1F4CA', M.LBL_OVERVIEW.includes('\u{1F4CA}'), rawDump);
check('总览不含字面 U0001f4ca', !M.LBL_OVERVIEW.toLowerCase().includes('u0001f4ca'));
check('单机操作含 U+2699', M.LBL_DEVICES.includes('\u{2699}'));
check('实例按钮前缀含 U+1F5A5', M.DEVICE_PREFIX.includes('\u{1F5A5}'));
check('暂停标记含 U+23F8', M.PAUSED_MARK.includes('\u{23F8}'));

// ---------------------------------------------------------------------------
console.log('--- 2. 一级菜单 14 项 ---');
const mainLabels = [
  M.LBL_OVERVIEW, M.LBL_TRAFFIC, M.LBL_STATUS, M.LBL_REPORT,
  M.LBL_WEEKLY, M.LBL_BALANCE, M.LBL_ACCOUNTS, M.LBL_START_ALL,
  M.LBL_STOP_ALL, M.LBL_DEVICES, M.LBL_ADD_ACCOUNT, M.LBL_RUN,
  M.LBL_HELP, M.LBL_HIDE,
];
console.log(`  一级菜单项数: ${mainLabels.length}`);
check('项数为 14', mainLabels.length === 14);

const uniq = new Set(mainLabels);
check('无重复', uniq.size === mainLabels.length,
  `实际去重后 ${uniq.size}`);

// 是否所有标签都用了 emoji 前缀（前 2 个 UTF-16 码元里应含非 ASCII）
const badIcon = mainLabels.filter((l) => {
  const first = l.codePointAt(0);
  return first < 0x2000; // 第一个码点如果是普通 ASCII，说明没图标
});
check('每项都有 emoji 前缀', badIcon.length === 0, badIcon.join(' | '));

// 去掉图标后，剩下的文字不应含英文字母
const withLatin = mainLabels.filter((l) => /[A-Za-z]/.test(M.stripIcon(l)));
check('去掉图标后不含英文字母', withLatin.length === 0,
  `违规: ${withLatin.join(' , ')}`);

// 去掉图标后也不能还有 emoji 残留
const leftoverIcon = mainLabels.filter((l) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(M.stripIcon(l)));
check('去掉图标后无 emoji 残留', leftoverIcon.length === 0,
  `违规: ${leftoverIcon.join(' , ')}`);

// 打印一遍给人眼看
console.log('  菜单实际渲染:');
for (const l of mainLabels) {
  console.log(`    ${l}    \u2192 纯文字「${M.stripIcon(l)}」`);
}

// ---------------------------------------------------------------------------
console.log('--- 3. buildDeviceButton \u2192 parseDeviceButton 往返 ---');
const cases = [
  ['菲律宾节点', false, '\u{1F5A5} 菲律宾节点'],
  ['新加坡节点', true, '\u{1F5A5} 新加坡节点 \u{23F8}\u{FE0F}'],
  ['x'.repeat(20), false, null], // 超长会被截断，只校验前缀
];
for (const [name, paused, expect] of cases) {
  const btn = M.buildDeviceButton(name, paused);
  console.log(`    输入「${name}」暂停=${paused} \u2192 按钮「${btn}」`);
  if (expect !== null) {
    check(`按钮文字符合预期: ${expect}`, btn === expect, `实际「${btn}」`);
  }
  check(`按钮不以字母开头`, !/^[A-Za-z]/.test(btn));
}

// 往返（不传实例 ID：按钮里没有尾号，反查只拿到名字）
const btn1 = M.buildDeviceButton('菲律宾节点', false);
const back1 = M.parseDeviceButton(btn1);
console.log(`  带图标反查: ${JSON.stringify(back1)}`);
check('反查得到「菲律宾节点」', back1 && back1.name === '菲律宾节点', JSON.stringify(back1));
check('没有实例 ID 时 idTail 为空', back1 && back1.idTail === '', JSON.stringify(back1));

const btn2 = M.buildDeviceButton('新加坡节点', true);
const back2 = M.parseDeviceButton(btn2);
console.log(`  暂停态反查: ${JSON.stringify(back2)}`);
check('暂停态反查得到「新加坡节点」', back2 && back2.name === '新加坡节点', JSON.stringify(back2));

const btn3 = M.buildDeviceButton('美东备用服务器边节点', false);
const back3 = M.parseDeviceButton(btn3);
console.log(`  超长名按钮: ${JSON.stringify(btn3)} \u2192 反查 ${JSON.stringify(back3)}`);
check('超长名反查是原名的前缀', back3 && '美东备用服务器边节点'.startsWith(back3.name), JSON.stringify(back3));

// ---- 带实例 ID 尾段：这是「不删错机器」的关键 ----
const btnId = M.buildDeviceButton('香港-生产环境-新加坡中转节点-AAAA', false, 'i-5ts7fo7n0ui3stsujw0r');
console.log(`  带实例ID按钮: ${JSON.stringify(btnId)}`);
const backId = M.parseDeviceButton(btnId);
check('按钮里带上了实例 ID 尾段', backId && backId.idTail === 'stsujw0r', JSON.stringify(backId));
check('按钮文字里肉眼可见尾号', btnId.includes('[stsujw0r]'), btnId);

// 两个「名字前缀完全相同」的机器，按钮必须能区分开
const nA = '香港-生产环境-新加坡中转节点-AAAA';
const nB = '香港-生产环境-新加坡中转节点-BBBB';
const btnA = M.buildDeviceButton(nA, false, 'i-1111111111aaaaaaaa');
const btnB = M.buildDeviceButton(nB, false, 'i-2222222222bbbbbbbb');
check('同名前缀的两台机器按钮文字不同', btnA !== btnB, `${btnA} vs ${btnB}`);
const ridA = M.parseDeviceButton(btnA);
const ridB = M.parseDeviceButton(btnB);
check('两台机器的 ID 尾段不同', ridA.idTail !== ridB.idTail, `${ridA.idTail} vs ${ridB.idTail}`);

console.log(`  非实例按钮反查: ${JSON.stringify(M.parseDeviceButton('\u{1F4CA} 总览'))}`);
check('非实例按钮反查为 null', M.parseDeviceButton('\u{1F4CA} 总览') === null);
// ---------------------------------------------------------------------------
console.log('--- 4. matchMain 两种输入都认 ---');
for (const l of mainLabels) {
  const stripped = M.stripIcon(l);
  const okIcon = M.matchMain(l, l);
  const okPlain = M.matchMain(stripped, l);
  if (!okIcon || !okPlain) {
    check(`匹配「${l}」`, false, `带图标=${okIcon} 纯文字=${okPlain}`);
  }
}
check('全部 14 项：带图标 / 纯文字 都能匹配',
  mainLabels.every((l) => M.matchMain(l, l) && M.matchMain(M.stripIcon(l), l)));

check('乱输入不误匹配', !M.matchMain('随便打点什么', M.LBL_OVERVIEW));
check('空字符串不误匹配', !M.matchMain('', M.LBL_OVERVIEW));

// ---------------------------------------------------------------------------
console.log('--- 4b. 「添加账号」流程按钮 ---');
// 这三个按钮是加账号流程里用的，它们也必须能「带图标 / 纯文字」两种都认，
// 否则用户手打「取消添加」时流程会卡住。
const addFlowLabels = [
  M.LBL_ADD_ACCOUNT, M.LBL_ADD_CONFIRM, M.LBL_ADD_RESCAN, M.LBL_ADD_CANCEL,
];
for (const l of addFlowLabels) {
  check(`流程按钮有图标: ${JSON.stringify(M.stripIcon(l))}`,
    l.codePointAt(0) >= 0x2000);
}
check('流程按钮全部可匹配',
  addFlowLabels.every((l) => M.matchMain(l, l) && M.matchMain(M.stripIcon(l), l)));
check('流程按钮不含英文字母',
  addFlowLabels.every((l) => !/[A-Za-z]/.test(M.stripIcon(l))));
check('「取消添加」和「收起菜单」不混淆',
  !M.matchMain(M.LBL_ADD_CANCEL, M.LBL_HIDE)
    && !M.matchMain(M.LBL_HIDE, M.LBL_ADD_CANCEL));

// ---------------------------------------------------------------------------
console.log('--- 5. stripIcon 边界 ---');
check('无图标原样返回', M.stripIcon('总览') === '总览');
check('带空格也能剥', M.stripIcon('  \u{1F4CA}  总览  ') === '总览');
check('变体选择符一起剥', M.stripIcon('\u{2699}\u{FE0F} 单机操作') === '单机操作');
check('空串安全', M.stripIcon('') === '');
check('null 安全', M.stripIcon(null) === '');

// ---------------------------------------------------------------------------
console.log('--- 6. 设备名截断长度（自动命名是「中文地域-账号标识-尾号」三段式）---');
// ⚠️ 这组断言是为了钉死一个真实的坑：DEVICE_NAME_MAX 若太小（曾为 12），
//    会把三段式名字里**唯一用来区分同类机器的那一段（尾号）**截掉，
//    导致菜单里同账号同地域的多台机器长得一模一样。
{
  const autoName = '马尼拉-LTAI5t-3stsujw0r'; // buildName 的产物
  console.log(`  自动命名: ${autoName}（${[...autoName].length} 字符）`);
  check('自动命名不会被截断',
    !M.buildDeviceButton(autoName).includes('\u2026'),
    M.buildDeviceButton(autoName));
  check('截断长度容得下三段式名字',
    M.DEVICE_NAME_MAX >= [...autoName].length,
    `DEVICE_NAME_MAX=${M.DEVICE_NAME_MAX}，名字 ${[...autoName].length} 字符`);

  // 最关键的一条：同为马尼拉、同账号的两台机器，按钮必须能区分开
  const a = M.buildDeviceButton('马尼拉-LTAI5t-3stsujw0r');
  const b = M.buildDeviceButton('马尼拉-LTAI5t-9abcdefghij');
  console.log(`    机器A按钮: ${a}`);
  console.log(`    机器B按钮: ${b}`);
  check('同地域同账号的两台机器，按钮能区分', a !== b);

  // 最长的中文地域名（武汉本地 4 字）也不该被截断
  const longest = '武汉本地-LTAI5t-3stsujw0r';
  check('最长的中文地域名也不被截断',
    !M.buildDeviceButton(longest).includes('\u2026'),
    `「${longest}」共 ${[...longest].length} 字符`);
}

// ---------------------------------------------------------------------------
console.log('--- 7. 🔴 全源码扫描：不得出现 Python 风格的 \\U 转义 ---');
{
  // 这个坑的真实案例（2026-10-10 真机验证时抓到）：
  //   telegram.js 里写着 `danger: '\U0001f6a8'` —— 大写 U。
  //   那是 **Python 的转义语法**，在 JavaScript 里 `\U` 不是有效转义，
  //   整个字符串会原样变成字面文本 "U0001f6a8"。
  //   后果：所有「严重」级告警开头都挂着一串乱码，
  //   而且**不报错、不崩溃** —— 只有把消息打出来看才能发现。
  //
  //   讽刺的是 menu-labels.js 的注释里专门警告过这个坑，
  //   结果 telegram.js 自己犯了。所以这里做全目录扫描，钉死它。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');

  const offenders = [];
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    // 逐行扫：`\U` 后面跟 8 位十六进制 —— 合法的 JS 里几乎不会这么写
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      // 跳过整行注释：`//` 开头、`*` 开头（块注释体）、`/*` 开头。
      // 注释里正是我们记录这个坑的地方，不该被误判。
      if (trimmed.startsWith('//') || trimmed.startsWith('*')
          || trimmed.startsWith('/*')) {
        return;
      }
      // 行内注释也要切掉
      const code = line.split('//')[0];
      if (/\\U[0-9a-fA-F]{8}/.test(code)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  check('源码里没有 \\U 大写转义（会被 JS 当成字面文本）',
    offenders.length === 0, offenders.join(', '));

  // 反过来：确认 danger 图标现在真的是个 emoji，而不是 "U0001f6a8"
  const tg = await import('../src/telegram.js');
  const { sendAlert } = tg;
  // 直接看它发出的消息首字符（用假 fetch 抓一条）
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push(JSON.parse(options?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendAlert(
    { telegram: { bot_token: '1:FAKE', chat_id: '1' } },
    '测试标题', '测试正文', 'danger'
  );
  globalThis.fetch = realFetch;

  const text = String(captured[0]?.text || '');
  check('danger 级告警的图标是真正的 emoji（不是字面 U0001f6a8）',
    !text.includes('U0001f6a8'), text.slice(0, 40));
  check('danger 级告警图标是 🚨',
    text.includes('\u{1F6A8}'), text.slice(0, 40));
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
