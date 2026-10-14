/**
 * 机器身份定位自检（不联网）
 * ===========================================================================
 * 钉死一个**会删错机器**的高危问题。
 *
 * 背景：三级菜单的按钮（状态/开关机/暂停/删除）本身不带机器信息，
 *      靠「会话里记住的当前机器」来定位。老实现存的是**名字**，
 *      而名字在按钮上会被截断到 22 字；两台机器名字前 22 字一样时，
 *      按名字的前缀匹配会返回**第一台**，于是：
 *          点 B 的「删除」→ 实际删掉了 A。
 *      删除配置是不可逆的，用户会以为删的是那台不用的机器。
 *
 * 修法：会话里存**实例 ID**（唯一、不截断），精确查找；
 *      按钮文字里也带上实例 ID 尾段，连二级菜单也不靠名字猜。
 */
import * as L from '../src/menu-labels.js';
import { resolveCurrentDevice, findUserByName, findUserById } from '../src/bot-listener.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274C ${name}  ${extra}`); }
}

// 两台「名字前 22 字完全相同」的机器 —— 这是最容易串台的构造。
// ⚠️ 两个关键点，缺一测不出问题：
//    1. 名字必须**超过** DEVICE_NAME_MAX(22) 字，否则不会被截断；
//    2. 差异必须落在**第 23 字之后** —— 否则截断后仍能区分。
// 这里让前 24 字完全一样（都是「主线路-甲/乙」之前的公共部分），
// 差异（甲/乙）落在第 25 字，截断后必然撞车。
const PREFIX = '香港-生产环境-新加坡中转节点-主线路-一号机房-';  // 25 字
const NAME_A = `${PREFIX}甲节点AAAA`;
const NAME_B = `${PREFIX}乙节点BBBB`;
const ID_A = 'i-1111111111aaaaaaaa';
const ID_B = 'i-2222222222bbbbbbbb';

const config = {
  users: [
    { instance_id: ID_A, name: NAME_A, region: 'cn-hongkong', ak: 'LTAIfake000000000000' },
    { instance_id: ID_B, name: NAME_B, region: 'cn-hongkong', ak: 'LTAIfake000000000000' },
  ],
};

console.log('\n【第一组】按钮文字必须能区分同名前缀的两台机器');
{
  const btnA = L.buildDeviceButton(NAME_A, false, ID_A);
  const btnB = L.buildDeviceButton(NAME_B, false, ID_B);
  console.log(`    机器A按钮：${btnA}`);
  console.log(`    机器B按钮：${btnB}`);
  check('两台按钮文字不相同', btnA !== btnB);
  check('按钮A 带 A 的尾号', btnA.includes(`[${L.shortIdTail(ID_A)}]`), btnA);
  check('按钮B 带 B 的尾号', btnB.includes(`[${L.shortIdTail(ID_B)}]`), btnB);

  const pA = L.parseDeviceButton(btnA);
  const pB = L.parseDeviceButton(btnB);
  check('反查出 A 的尾号', pA.idTail === L.shortIdTail(ID_A), JSON.stringify(pA));
  check('反查出 B 的尾号', pB.idTail === L.shortIdTail(ID_B), JSON.stringify(pB));
}

console.log('\n【第二组】会话存实例 ID → 精确命中，不串台');
{
  // 这是修复后的正确路径：会话里存的是 ID
  const gotA = resolveCurrentDevice(config, ID_A);
  const gotB = resolveCurrentDevice(config, ID_B);
  check('按 ID_A 取回的是 A', gotA && gotA.instance_id === ID_A, JSON.stringify(gotA));
  check('按 ID_B 取回的是 B', gotB && gotB.instance_id === ID_B, JSON.stringify(gotB));
  check('两台取回的实例确实不同', gotA.instance_id !== gotB.instance_id);
}

console.log('\n【第三组】老会话兼容（会话里存的是名字）');
{
  // 升级前用户在会话里留下的是名字，不能因为改版就找不到
  const got = resolveCurrentDevice(config, NAME_B);
  check('老会话存名字也能取回（全名精确命中）', got && got.instance_id === ID_B,
    JSON.stringify(got));
}

console.log('\n【第四组】🔴 对照：证明「按名字匹配」确实会串台（所以要弃用）');
{
  // 取两台机器被截断后的样子（按钮上真实显示的文字）
  const truncA = NAME_A.slice(0, L.DEVICE_NAME_MAX);
  const truncB = NAME_B.slice(0, L.DEVICE_NAME_MAX);
  check('两台机器名字确实都超过 22 字（会被截断）',
    NAME_A.length > L.DEVICE_NAME_MAX && NAME_B.length > L.DEVICE_NAME_MAX,
    `A ${NAME_A.length} 字 / B ${NAME_B.length} 字`);
  check('截断后两段文字完全相同（这就是祸根）', truncA === truncB,
    `${truncA} vs ${truncB}`);

  // 老实现拿「截断后的名字」去前缀匹配，想找 B 也会拿到 A（删错机器）。
  // 现在 findUserByName 只认全名精确匹配：截断名一律查不到，宁可找不到也不串台。
  const foundA = findUserByName(config, truncA);
  const foundB = findUserByName(config, truncB);
  check('截断名不再前缀匹配到任何机器（不会串台）', !foundA && !foundB,
    `A→${foundA && foundA.instance_id} / B→${foundB && foundB.instance_id}`);

  // 而按 ID 查就绝对不会错
  check('按 ID 查 B 一定拿得到 B（新实现的做法）',
    findUserById(config, ID_B)?.instance_id === ID_B);
  check('按 ID 查 A 一定拿得到 A',
    findUserById(config, ID_A)?.instance_id === ID_A);
}

console.log('\n【第五组】ID 尾段工具函数');
{
  check('短 ID 原样返回', L.shortIdTail('i-abc') === 'i-abc');
  check('长 ID 取末 8 位', L.shortIdTail('i-faketest0000stsujw0r') === 'stsujw0r');
  check('空值安全', L.shortIdTail('') === '' && L.shortIdTail(null) === '');
  check('末 8 位长度恒定', L.shortIdTail('i-1234567890abcdef').length === L.DEVICE_ID_TAIL);
}

console.log(`\n机器身份定位自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
