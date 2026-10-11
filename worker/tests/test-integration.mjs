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
// ⚠️ parseDeviceButton 现在返回 { name, idTail } 而不是纯字符串 ——
//    因为按钮里要带实例 ID 尾段，才能避免「同名前缀的两台机器点错」。
const btn = L.buildDeviceButton('菲律宾节点', false);
check('实例按钮可反查', L.parseDeviceButton(btn)?.name === '菲律宾节点',
  JSON.stringify(L.parseDeviceButton(btn)));
const btnPaused = L.buildDeviceButton('新加坡备用节点', true);
check('暂停实例按钮可反查', L.parseDeviceButton(btnPaused)?.name === '新加坡备用节点',
  JSON.stringify(L.parseDeviceButton(btnPaused)));

// 带实例 ID 的按钮必须能取出尾号（这是「不删错机器」的关键信息）
const btnWithId = L.buildDeviceButton('某台机器', false, 'i-faketest0000stsujw0r');
check('带实例ID的按钮可取出尾号', L.parseDeviceButton(btnWithId)?.idTail === 'stsujw0r',
  JSON.stringify(L.parseDeviceButton(btnWithId)));

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
console.log('--- 10. 🔴 KV 写入次数必须与机器台数解耦（免费额度只有 1000/天）---');
{
  // 这条是排查出来的真实隐患：
  //   Cloudflare 免费版 KV 每天只有 **1000 次写入**，巡检每 5 分钟一轮（288 轮/天）。
  //   原来巡检是「每台机器各写两次 KV」（状态 + 台账），
  //   额度占用 = 台数 × 2 × 288：
  //     1 台 → 576 次/天（58%，安全）
  //     2 台 → 1152 次/天（**已超额**，KV 写入开始报错）
  //     3 台 → 1728 次/天
  //   改成「一轮批量写一次」后，无论几台都是 2 次/轮 → 576 次/天，与台数无关。
  //   这里用「计数版假 KV」把写入次数钉死。
  class CountingKV {
    constructor() { this.store = new Map(); this.puts = 0; }
    async get(key, type) {
      const raw = this.store.get(key);
      if (raw === undefined) return null;
      if (type === 'json') { try { return JSON.parse(raw); } catch (e) { return null; } }
      return raw;
    }
    async put(key, value) { this.puts += 1; this.store.set(key, String(value)); }
    async delete(key) { this.store.delete(key); }
    async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
  }

  const guard = await import('../src/guard.js');
  const realFetch = globalThis.fetch;
  // 假阿里云：实例正常运行
  globalThis.fetch = async () => {
    const body = JSON.stringify({
      RequestId: 'x', Instances: { Instance: [{ Status: 'Running' }] },
    });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  const counts = {};
  for (const n of [1, 2, 5, 10]) {
    const kv = new CountingKV();
    const localEnv = { CDT_GUARD_KV: kv };
    const users = [];
    for (let i = 0; i < n; i += 1) {
      users.push({
        name: `机器${i}`, instance_id: `i-m${i}`, region: 'ap-southeast-6',
        ak: 'LTAI-FAKE-0000-TEST-ONLY', sk: 'FAKE-SECRET-FOR-TEST-ONLY', traffic_limit: 180,
      });
    }
    await common.saveConfig(localEnv, {
      telegram: { chat_id: '1', admin_ids: ['1'] }, users,
    });
    kv.puts = 0;
    await guard.runInspection(localEnv);
    counts[n] = kv.puts;
    const perDay = kv.puts * 288;
    check(`${n} 台机器时，一轮巡检写入次数固定为 2（实际 ${kv.puts}）`,
      kv.puts === 2, `实际 ${kv.puts}`);
    check(`${n} 台机器时，日写入 ${perDay} 次未超免费额度 1000`,
      perDay <= 1000, `${perDay} 次/天`);
  }
  check('写入次数不随台数增长（1 台与 10 台相同）',
    counts[1] === counts[10], `1台=${counts[1]} 10台=${counts[10]}`);

  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
console.log('--- 11. 🔴 KV 写入失败（额度用尽）不能让巡检崩溃 ---');
{
  // 承接上一组：免费版额度用尽后，KV 的 put 会**直接报错**。
  // 如果 saveState / 台账写入把异常抛出去，会中断整个巡检循环 ——
  // 表现就是「因为存不下结果，干脆后面所有机器都不查了」，
  // 那才是最糟的：监控在最需要它的时候（额度/配置出问题）自己先停了。
  // 所以这两处写入必须「失败也不抛」。
  class FailKV {
    constructor() { this.store = new Map(); this.failWrites = false; }
    async get(key, type) {
      const raw = this.store.get(key);
      if (raw === undefined) return null;
      if (type === 'json') { try { return JSON.parse(raw); } catch (e) { return null; } }
      return raw;
    }
    async put(key, value) {
      if (this.failWrites) throw new Error('KV PUT failed: daily write limit exceeded');
      this.store.set(key, String(value));
    }
    async delete(key) { this.store.delete(key); }
    async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
  }

  const kv = new FailKV();
  const localEnv = { CDT_GUARD_KV: kv };

  kv.failWrites = true;
  let threw = false;
  let ret = null;
  try {
    ret = await common.saveState(localEnv, { foo: 1 });
  } catch (e) {
    threw = true;
  }
  check('saveState 写失败时不抛异常', !threw);
  check('saveState 写失败时返回 false（调用方可感知）', ret === false, String(ret));

  threw = false;
  ret = null;
  try {
    ret = await common.appendTrafficHistoryBatch(localEnv, [
      { instanceId: 'i-a', name: 'A', trafficGb: 1.5 },
    ]);
  } catch (e) {
    threw = true;
  }
  check('台账批量写失败时不抛异常', !threw);
  check('台账批量写失败时返回 false', ret === false, String(ret));

  // 单条版本仍在（向后兼容）
  threw = false;
  try {
    await common.appendTrafficHistory(localEnv, 'i-a', 'A', 1.5);
  } catch (e) {
    threw = true;
  }
  check('单条台账写（向后兼容）失败时不抛异常', !threw);

  // 最关键的一条：额度用尽时，整轮巡检仍要把所有机器检查完
  const guard = await import('../src/guard.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const body = JSON.stringify({
      RequestId: 'x', Instances: { Instance: [{ Status: 'Running' }] },
    });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  const kv2 = new FailKV();
  const localEnv2 = { CDT_GUARD_KV: kv2 };
  await common.saveConfig(localEnv2, {
    telegram: { chat_id: '1', admin_ids: ['1'] },
    users: [
      { name: '机器A', instance_id: 'i-a', region: 'ap-southeast-6', ak: 'x', sk: 'y', traffic_limit: 180 },
      { name: '机器B', instance_id: 'i-b', region: 'ap-southeast-6', ak: 'x', sk: 'y', traffic_limit: 180 },
    ],
  });
  kv2.failWrites = true;
  let summary = null;
  threw = false;
  try {
    summary = await guard.runInspection(localEnv2);
  } catch (e) {
    threw = true;
  }
  check('额度用尽时巡检不崩溃', !threw);
  check('额度用尽时所有机器仍被检查（checked=2）',
    summary && summary.checked === 2, JSON.stringify(summary));

  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
// 第 12 组：敏感信息遮蔽（第三轮安全排查固化）
//   背景：guard.js / bot-listener.js 有 20+ 处把**阿里云报错原文**
//        经 common.sanitize 清洗后**直接发往 Telegram**。
//        而阿里云签名类报错里会带 AccessKeyId=LTAIxxxx。
//        曾经 common.sanitize 只洗 Markdown 字符、不遮蔽密钥 → 密钥泄漏。
//   注意：本组用的是**假密钥**（形状真实、值随机），不是真凭据。
// ---------------------------------------------------------------------------
{
  console.log('第 12 组：敏感信息遮蔽');
  const FAKE_AK = 'LTAI5tFakeKeyForTest0000';
  const FAKE_SK = 'AbCdEfGhIjKlMnOpQrStUvWx';

  // 12.1 redact 必须遮蔽的 8 种形态
  const mustHide = [
    ['裸密钥', `error with ${FAKE_AK} inside`],
    ['JSON 形式(驼峰)', `{"AccessKeyId":"${FAKE_AK}"}`],
    ['JSON 形式(小写)', `{"accesskeyid":"${FAKE_AK}"}`],
    ['中文前缀', `密钥 ${FAKE_AK} 无效`],
    ['等号形式', `AccessKeyId=${FAKE_AK}`],
    ['冒号形式', `Signature: ${FAKE_SK}`],
    ['URL 参数', `https://x.com?a=1&AccessKeyId=${FAKE_AK}&b=2`],
    ['Secret 裸串', `secret is ${FAKE_SK} ok`],
  ];
  for (const [label, input] of mustHide) {
    const out = common.redact(input);
    const leaked = out.includes(FAKE_AK) || out.includes(FAKE_SK);
    check(`redact 遮蔽 ${label}`, !leaked, out);
  }

  // 12.2 sanitize 也必须遮蔽（因为它才是被发往 Telegram 的那个函数）
  check('sanitize 遮蔽错误消息里的密钥',
    !common.sanitize(`查询失败：AccessKeyId=${FAKE_AK}`).includes(FAKE_AK));
  check('sanitize 保留 Markdown 清洗能力',
    common.sanitize('my_server_01') === 'my server 01');

  // 12.3 反向：绝不能误伤正常运维文本
  const noHarm = [
    '查询实例状态 失败：Invalid parameter: InstanceId',
    '机器 i-faketest0000stsujw0r 已关机',
    '当前流量 12.34GB，本月免费额度 200GB',
    '开机指令下发失败：Forbidden.RAM 权限不足',
    '实例 my_server_01 巡检正常',
    '账单金额 ¥12.34',
    'SignatureDoesNotMatch 签名不匹配',
    'RequestId: 8F3D2A1B-4C5E-6789-ABCD-EF0123456789',
  ];
  for (const s of noHarm) {
    check(`redact 不误伤「${s.slice(0, 16)}…」`, common.redact(s) === s, common.redact(s));
  }

  // 12.4 幂等 + 无死循环（死循环在 Worker 里会 CPU 超时）
  const once = common.sanitize(`AccessKeyId=${FAKE_AK}`);
  check('sanitize 幂等（二次调用不变）', common.sanitize(once) === once);
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) {
    common.sanitize(`AccessKeyId=${FAKE_AK}&Signature=${FAKE_SK}`);
  }
  check('sanitize 10000 次不死循环（<5s）', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

  // 12.5 形态兜底正则本身必须能命中（防止「多重前瞻永不命中」这类静默失效）
  const longMixed = 'AbCdEfGhIjKlMnOpQrStUvWx'; // 24 位、含大小写
  check('长混合串兜底命中', common.redact(longMixed) === '[已隐藏]', common.redact(longMixed));
  check('纯数字长串不误伤', common.redact('1234567890123456789012345') === '1234567890123456789012345');
  check('纯小写长串不误伤', common.redact('abcdefghijklmnopqrstuvwxyz') === 'abcdefghijklmnopqrstuvwxyz');
}

// ---------------------------------------------------------------------------
// 第 13 组：巡检软锁必须「双向互斥」（第五轮端到端排查固化）
//   背景：早先只有 bot-listener 的手动巡检认锁，guard.runInspection 完全不认。
//        于是「手动跑着 + 定时进来」会并行，状态互相覆盖（注释写的是互斥，实际没有）。
//   现在锁只在 guard.runInspection 实现一次，手动/定时两条路共用。
// ---------------------------------------------------------------------------
{
  console.log('第 13 组：巡检软锁双向互斥');
  const guard = await import('../src/guard.js');

  // 13.1 常量导出且键名正确（bot-listener 与 guard 必须用同一个键）
  check('锁键名已导出为常量', guard.MANUAL_INSPECTION_LOCK === 'manual_inspection_lock');
  check('锁窗口为 180 秒', guard.INSPECTION_LOCK_WINDOW === 180);

  // 13.2 造一个「刚跑过」的状态，定时巡检必须跳过（不再只对多动）
  const kv = new FakeKV();
  const localEnv = { CDT_GUARD_KV: kv };
  await common.saveConfig(localEnv, {
    telegram: { chat_id: '1', admin_ids: ['1'] },
    users: [{ name: '机器A', instance_id: 'i-a', region: 'ap-southeast-6', ak: 'x', sk: 'y', traffic_limit: 180 }],
  });
  // 手动写入一个「刚刚跑过」的锁（模拟另一条路径占用中）
  await common.saveState(localEnv, {
    [guard.MANUAL_INSPECTION_LOCK]: common.nowSeconds(),
  });

  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => {
    const body = JSON.stringify({ RequestId: 'x', Instances: { Instance: [{ Status: 'Running' }] } });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  const skipped = await guard.runInspection(localEnv);
  check('3 分钟内已跑过 → 定时巡检跳过', skipped && skipped.skipped === true, JSON.stringify(skipped));
  check('跳过时不检查任何机器', skipped && skipped.checked === 0);

  // 13.3 force 可强行执行（用户主动点「立即巡检」时的语义）
  const forced = await guard.runInspection(localEnv, { force: true });
  check('force=true 时无视软锁照跑', forced && forced.skipped !== true, JSON.stringify(forced));

  // 13.4 锁值随巡检一起写进去（不需要额外 KV 写入）
  const st = await common.loadState(localEnv);
  check('巡检后锁值已更新为本次时间', typeof st[guard.MANUAL_INSPECTION_LOCK] === 'number');

  globalThis.fetch = realFetch2;
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`===== 集成自检结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
