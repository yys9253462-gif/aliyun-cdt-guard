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

// 往返
const btn1 = M.buildDeviceButton('菲律宾节点', false);
const back1 = M.parseDeviceButton(btn1);
console.log(`  带图标反查: ${JSON.stringify(back1)}`);
check('反查得到「菲律宾节点」', back1 === '菲律宾节点');

const btn2 = M.buildDeviceButton('新加坡节点', true);
const back2 = M.parseDeviceButton(btn2);
console.log(`  暂停态反查: ${JSON.stringify(back2)}`);
check('暂停态反查得到「新加坡节点」', back2 === '新加坡节点');

const btn3 = M.buildDeviceButton('美东备用服务器边节点', false);
const back3 = M.parseDeviceButton(btn3);
console.log(`  超长名按钮: ${JSON.stringify(btn3)} \u2192 反查 ${JSON.stringify(back3)}`);
check('超长名反查是原名的前缀', '美东备用服务器边节点'.startsWith(back3), `反查「${back3}」`);

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
console.log('');
console.log(`===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
