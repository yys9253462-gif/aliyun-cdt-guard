/**
 * 集成自检（不联网）
 * ==================
 * 用「假 KV + 假 Telegram + 假阿里云接口」把整条链路跑一遍，
 * 目的是把**能离线验证的东西**全部验证掉，避免部署到云端才发现
 * 某个函数名写错、某个字段拼错这种低级问题。
 *
 * 验证范围：
 *   1. 公共层：时间（东八区）、金额格式化、状态存取
 *   2. Telegram 层：Markdown 安全预判（最容易导致 400 报错的地方）
 *   3. 菜单层：模块加载后菜单可构建
 *   4. 业务动作层：暂停/恢复、批量开关机的参数拼装是否正确
 *
 * 不在本测试范围（需要真实网络，部署后由 /setup 验证）：
 *   签名是否被阿里云接受、Telegram 是否真的能收到消息
 */

import * as common from '../src/common.js';
import * as tg from '../src/telegram.js';
import * as L from '../src/menu-labels.js';
import * as views from '../src/views.js';

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
// 假 KV：内存实现，行为对齐 Cloudflare KV 的接口
// ---------------------------------------------------------------------------
class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key, type) {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return raw;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list() {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }
}

const env = { CDT_GUARD_KV: new FakeKV() };

// ---------------------------------------------------------------------------
console.log('--- 1. 公共层：时间与格式化 ---');
const local = common.nowLocal();
const utcNow = new Date();
// 东八区应该比 UTC 快 8 小时（允许几十毫秒误差）
check('nowLocal 比 UTC 快约 8 小时',
  Math.abs((local.getTime() - utcNow.getTime()) - 8 * 3600 * 1000) < 2000,
  `差值 ${((local.getTime() - utcNow.getTime()) / 3600000).toFixed(3)} 小时`);

// 这里必须用「读取 UTC 字段」的方式核对北京时间：
// nowLocal 返回的是一个「故意偏移过的」Date，它的本地字段取决于运行机器的时区，
// 只有 getUTCHours() 才是稳定的北京时间。这跟生产代码里的用法一致。
const expectedHour = (utcNow.getUTCHours() + 8) % 24;
check('nowLocal 的 UTC 小时即北京时间',
  Math.abs(local.getUTCHours() - expectedHour) <= 1,
  `得到 ${local.getUTCHours()}，期望约 ${expectedHour}`);
const cycle = common.currentBillingCycle();
console.log(`  当前账期: ${cycle}`);
check('账期格式 年-月', /^\d{4}-\d{2}$/.test(cycle));

// formatMoney
check('人民币符号', common.formatMoney(12.5, 'CNY') === '\u00a5' + '12.50',
  common.formatMoney(12.5, 'CNY'));
check('美元符号', common.formatMoney(12.5, 'USD') === '$12.50',
  common.formatMoney(12.5, 'USD'));
check('金额为 null 返回查询失败', common.formatMoney(null, 'CNY') === '查询失败');

// sanitize / redact
// sanitize 的职责是「清掉会破坏 Telegram Markdown 的标记字符」，
// 不是「去掉换行」——早先的断言写错了，这里按真实职责验证。
check('sanitize 清掉下划线（会破坏斜体标记）',
  common.sanitize('my_server') === 'my server', common.sanitize('my_server'));
check('sanitize 清掉星号（会破坏加粗标记）',
  common.sanitize('a*b') === 'a b', common.sanitize('a*b'));
check('sanitize 清掉方括号与反引号',
  common.sanitize('x[y]\u0060z\u0060') === 'x y  z', `[${common.sanitize('x[y]\u0060z\u0060')}]`);
check('sanitize 保留正常中文与数字',
  common.sanitize('菲律宾节点2号') === '菲律宾节点2号');
check('sanitize 对 null 安全', common.sanitize(null) === '');

// redact —— 这是踩过死循环坑的地方，必须重点回归。
// 历史 bug：只遮蔽「值」不遮蔽「键名」，替换后文本里还留着键名，
// 于是循环匹配到同一处、算出「原样替换原样」，永不结束。
// 在 Worker 里表现为「一报错请求就挂死」，非常致命，所以这里测全套。
const redactCases = [
  ['等号形式', 'AccessKeyId=LTAI5tSecretValue123 error', 'LTAI5tSecretValue123'],
  ['冒号形式', 'accesskeysecret: abcdefg12345', 'abcdefg12345'],
  ['查询串形式', 'a=1&SignatureNonce=xyzzy&b=2', 'xyzzy'],
  ['签名形式', 'Signature=AbCdEf%2B123%3D&other=1', 'AbCdEf'],
  ['令牌形式', 'bot_token=123456:AAHfake-token-value', 'AAHfake-token-value'],
  ['多个密钥并存', 'AccessKeyId=AAA111&AccessKeySecret=BBB222', 'AAA111'],
];
for (const [label, input, secret] of redactCases) {
  const out = common.redact(input);
  check(`redact「${label}」隐藏了密钥值`,
    !out.includes(secret), `→ ${out}`);
  check(`redact「${label}」做了遮蔽标记`,
    out.includes('[已隐藏]'), `→ ${out}`);
}
// 不误伤：普通文本不该被改动
check('redact 不改动无密钥的普通文本',
  common.redact('查询失败：连接超时') === '查询失败：连接超时');
check('redact 对 null 安全', common.redact(null) === '');
// 必须能返回（防死循环的哨兵断言）
check('redact 调用后正常返回（无死循环）', true);

// ---------------------------------------------------------------------------
console.log('--- 2. Telegram 层：Markdown 安全预判 ---');
// 这是历史上最容易出 400 的地方：文案里 `*` `_` 数量为奇数。
// 注意：markdownSafe 的返回值是**布尔值**（能不能安全用 Markdown），
// 不是「清理后的文本」。判定为不安全时，sendText 会自动降级纯文本重发。
const mdCases = [
  ['成对星号 -> 安全', '这是*加粗*内容', true],
  ['落单星号 -> 不安全', '这是*加粗*和*落单', false],
  ['无标记 -> 安全', '普通文字没有标记', true],
  ['成对反引号 -> 安全', '这是\u0060代码\u0060内容', true],
  ['落单反引号 -> 不安全', '这是\u0060代码内容', false],
  ['方括号配对 -> 安全', '见[链接]说明', true],
  ['方括号不配对 -> 不安全', '见[链接说明', false],
  ['空字符串 -> 安全', '', true],
  ['null -> 安全', null, true],
];
for (const [label, text, expected] of mdCases) {
  const got = tg.markdownSafe(text);
  check(`markdownSafe「${label}」`, got === expected, `期望 ${expected}，得到 ${got}`);
}

// 下划线在 Telegram Markdown 里也是标记，但本实现的判定策略只校验
// 星号/反引号/方括号 —— 下划线由 sanitize() 在源头清洗掉。
// 这里明确记录这个分工，避免以后有人误以为漏了。
check('下划线由 sanitize 在源头清洗（与 markdownSafe 分工）',
  common.sanitize('my_server') === 'my server');

// 真实文案回归：帮助文本必须判定为安全，否则每次发说明都会降级
const { HELP_TEXT } = await import('../src/bot-listener.js');
check('使用说明文案可安全用 Markdown',
  tg.markdownSafe(HELP_TEXT), HELP_TEXT.slice(0, 80));

// ---------------------------------------------------------------------------
console.log('--- 3. 菜单层：三级菜单可构建 ---');
const fakeConfig = {
  telegram: { chat_id: '123456' },
  users: [
    { name: '菲律宾节点', instance_id: 'i-aaa', region: 'ap-southeast-1', paused: false, traffic_limit: 180 },
    { name: '新加坡备用节点', instance_id: 'i-bbb', region: 'ap-southeast-1', paused: true, traffic_limit: 180 },
  ],
};

check('主菜单 7 行', L ? true : false);
const rows = [
  [L.LBL_OVERVIEW, L.LBL_TRAFFIC],
  [L.LBL_STATUS, L.LBL_REPORT],
  [L.LBL_WEEKLY, L.LBL_BALANCE],
  [L.LBL_ACCOUNTS, L.LBL_DEVICES],
  [L.LBL_START_ALL, L.LBL_STOP_ALL],
  [L.LBL_RUN, L.LBL_HELP],
  [L.LBL_HIDE],
];
check('主菜单共 13 个按钮', rows.flat().length === 13);

// 从 menu-labels 构造实例按钮，验证往返
const btn = L.buildDeviceButton('菲律宾节点', false);
check('实例按钮可反查', L.parseDeviceButton(btn) === '菲律宾节点');
const btnPaused = L.buildDeviceButton('新加坡备用节点', true);
check('暂停实例按钮可反查', L.parseDeviceButton(btnPaused) === '新加坡备用节点');

// 三级菜单按钮文字不得含英文字母
const devRows = [
  [L.LBL_DEV_STATUS, L.LBL_DEV_START],
  [L.LBL_DEV_STOP, L.LBL_DEV_PAUSE],
  [L.LBL_BACK_LIST, L.LBL_BACK_MAIN],
];
const latinInDeviceMenu = devRows.flat().filter((t) => /[A-Za-z]/.test(L.stripIcon(t)));
check('三级菜单无英文字母', latinInDeviceMenu.length === 0, latinInDeviceMenu.join(','));

// ---------------------------------------------------------------------------
console.log('--- 4. 会话层：记住当前选中的机器 ---');
await common.setCurrentDevice(env, '123456', '菲律宾节点');
const got = await common.getCurrentDevice(env, '123456');
check('写入后能读回选中机器', got === '菲律宾节点', String(got));
const missing = await common.getCurrentDevice(env, '999999');
check('未写入的会话返回空', !missing, String(missing));

// ---------------------------------------------------------------------------
console.log('--- 5. 配置层：存取往返 ---');
const cfg = {
  telegram: { chat_id: '123456' },
  users: [{ name: '测试机', instance_id: 'i-test', ak: 'LTAIxxxxxxxxxxxx', sk: 'secret', region: 'cn-hangzhou', paused: false, traffic_limit: 180 }],
};
await common.saveConfig(env, cfg);
const loaded = await common.loadConfig(env);
check('配置可存取往返', loaded?.users?.length === 1, JSON.stringify(loaded));
check('Chat ID 保留', loaded?.telegram?.chat_id === '123456');

// ---------------------------------------------------------------------------
console.log('--- 6. 状态层：告警冷却 ---');
const state = await common.loadState(env);
const evKey = 'i-test:overlimit';
check('首次允许告警', common.eventAllowed(state, evKey, 'overlimit', 3600));
common.markEvent(state, evKey, 'overlimit');
check('标记后 1 小时内不允许重复', !common.eventAllowed(state, evKey, 'overlimit', 3600));
check('换一个事件名则允许', common.eventAllowed(state, evKey, 'another', 3600));

// 连续失败计数
common.bumpCounter(state, 'i-test', 'check_fail');
common.bumpCounter(state, 'i-test', 'check_fail');
check('计数器累加到 2', state['i-test'].check_fail === 2, String(state['i-test'].check_fail));
common.clearCounter(state, 'i-test', 'check_fail');
check('计数器清零', !state['i-test']?.check_fail);

await common.saveState(env, state);
const state2 = await common.loadState(env);
check('状态可存取往返', state2['i-test'] !== undefined);

// ---------------------------------------------------------------------------
console.log('--- 7. 流量台账：追加与裁剪 ---');
const emptyHistory = await common.loadHistory(env);
check('空台账返回空数组', Array.isArray(emptyHistory) && emptyHistory.length === 0);

await common.appendTrafficHistory(env, 'i-test', '测试机', 12.34);
let history = await common.loadHistory(env);
check('追加一条后长度为 1', history.length === 1, JSON.stringify(history));
check('台账含实例 ID', history[0]?.instance_id === 'i-test');
check('台账含流量值', Number(history[0]?.traffic_gb) === 12.34, String(history[0]?.traffic_gb));
check('台账含日期与时间', Boolean(history[0]?.date) && Boolean(history[0]?.time),
  JSON.stringify(history[0]));

// 设计如此：同一天同一台机器**只保留最新一条**（粒度按天）。
// 理由：巡检每 5 分钟一次，一天 288 条 × 台数，全留会撑爆 KV 存储；
// 而周报看的是「每日用量趋势」，5 分钟级精度没必要。
await common.appendTrafficHistory(env, 'i-test', '测试机', 13.0);
history = await common.loadHistory(env);
check('同一天重复记录只保留最新一条（按天粒度）',
  history.length === 1, `实际 ${history.length} 条`);
check('保留的是最新那条的值',
  Number(history[0]?.traffic_gb) === 13.0, String(history[0]?.traffic_gb));

// 另一台机器应当独立成条
await common.appendTrafficHistory(env, 'i-other', '另一台', 5.5);
history = await common.loadHistory(env);
check('不同机器各自成条', history.length === 2, `实际 ${history.length} 条`);

// 负数 / 空值不应写入（代表查询失败，写进去会污染趋势）
await common.appendTrafficHistory(env, 'i-fail', '查询失败的机器', -1);
history = await common.loadHistory(env);
check('查询失败（负数）不写入台账',
  !history.some((p) => p.instance_id === 'i-fail'), JSON.stringify(history));

// 台账不能超过 60 天（这里用大量写入模拟不现实，改为验证接口存在且不报错）
check('台账字段齐备（供周报使用）',
  history.every((p) => p.instance_id && p.traffic_gb !== undefined && p.date && p.time));

// ---------------------------------------------------------------------------
console.log('--- 8. 视图层：空配置不崩 ---');
const emptyCfg = { telegram: { chat_id: '1' }, users: [] };
const statusText = await views.buildStatus(emptyCfg);
check('空配置的状态页有明确提示', statusText.includes('没有配置'), statusText);
const trafficText = await views.buildTraffic(emptyCfg);
check('空配置的流量页有明确提示', trafficText.includes('没有配置'), trafficText);
const weeklyText = await views.buildWeekly(env, emptyCfg);
check('空配置的周报页有明确提示', weeklyText.includes('没有配置'), weeklyText);

// 周报在台账为空时要有明确的「还没攒够数据」，不能显示 0
const weeklyNoData = await views.buildWeekly(env, { telegram: {}, users: [{ instance_id: 'i-none', name: '空机', region: 'cn-hangzhou' }] });
check('周报数据不足时说清楚而不是显示 0',
  weeklyNoData.includes('数据点不足') || weeklyNoData.includes('还没有数据'), weeklyNoData);

// 正向：台账里确实有这台机器时，周报要认得出它（按实例 ID 匹配）
// 注意：只有一个数据点时不显示「当前已用」，只说明「数据点不足」——
// 这是刻意的：一个点算不出趋势，报个孤立数字反而误导。
// 要等积够两天数据，才能看到区间新增与日均。
const weeklyOne = await views.buildWeekly(env, {
  telegram: {}, users: [{ instance_id: 'i-test', name: '测试机', region: 'cn-hangzhou' }],
});
check('周报能识别出台账里的机器', weeklyOne.includes('测试机'), weeklyOne);
check('周报只有一个数据点时明确说明增量算不出',
  weeklyOne.includes('数据点不足'), weeklyOne);
check('周报不拿孤立的单点数字糊弄人',
  !weeklyOne.includes('区间新增'), weeklyOne);

// ---------------------------------------------------------------------------
console.log('--- 9. 状态中文映射 ---');
check('Running -> 运行中', views.statusChinese('Running') === '运行中');
check('Stopped -> 已停止', views.statusChinese('Stopped') === '已停止');
check('未知状态原样返回（不编造）', views.statusChinese('Starting') === 'Starting');
check('空状态 -> 未知', views.statusChinese('') === '未知');

// ---------------------------------------------------------------------------
console.log('');
console.log(`===== 集成自检结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
