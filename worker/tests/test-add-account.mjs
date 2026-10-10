/**
 * 「在机器人里添加阿里云账号」流程自检（不联网）
 * ===========================================================================
 * 这条流程比其他菜单项复杂得多（要连问 3 步、要把 Secret 删掉、
 * 要合并配置），而且**一旦出错就是安全或数据问题**（密钥泄露 / 配置被覆盖）。
 * 所以它有独立的测试。
 *
 * 验证范围（全部离线，用假 KV + 假 Telegram）：
 *   1. 会话状态机：每一步接得对、状态能存能取能过期
 *   2. 输入校验：AK / Secret 格式不对要拦住
 *   3. **配置合并**：新账号只追加、绝不动已有机器（最关键）
 *   4. **重复防护**：同一台机器不会被加两次
 *   5. **Secret 处理**：收到后立刻删消息；删不掉要提醒用户
 *   6. 安全：回给用户的消息里不得出现完整 Secret
 *   7. 取消：任何一步都能干净退出，不留状态
 *
 * 不在本测试范围（需要真实网络）：阿里云是否真的认这对 Key。
 */

import * as common from '../src/common.js';
import * as addAccount from '../src/add-account.js';
import * as scan from '../src/account-scan.js';
import * as L from '../src/menu-labels.js';

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
// 假 KV
// ---------------------------------------------------------------------------
class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key, type) {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return raw;
  }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
}

const CHAT = '7912011729';

function freshEnv() {
  return { CDT_GUARD_KV: new FakeKV() };
}

// ---------------------------------------------------------------------------
// 假 Telegram：把机器人「发出去的每条消息」记录下来供断言
// ---------------------------------------------------------------------------
function makeFakeTg() {
  const sent = [];
  const deleted = [];
  const original = {
    sendText: null, sendMenu: null, deleteMessage: null,
  };
  return {
    sent,
    deleted,
    install() {
      // 动态替换模块导出的函数（ESM 里不能直接改，用 monkey patch 需要
      // 通过 import 的对象属性赋值；这里改用「注入」的方式，
      // 见下方 patchTg()）
    },
    text() { return sent.map((m) => m.text).join('\n'); },
  };
}

// ---------------------------------------------------------------------------
// 因为 ESM 的导出是只读绑定，无法直接 monkey patch，
// 所以这里用「假 fetch」的方式拦掉所有对 Telegram API 的调用 ——
// 这样连 telegram.js 的真实代码都一起被测到了，覆盖更完整。
// ---------------------------------------------------------------------------
function installFakeFetch() {
  const calls = { sendMessage: [], deleteMessage: [], answerCallbackQuery: [] };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    const method = String(url).split('/').pop();

    if (method === 'sendMessage') {
      calls.sendMessage.push(body);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    if (method === 'deleteMessage') {
      calls.deleteMessage.push(body);
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    if (method === 'answerCallbackQuery') {
      calls.answerCallbackQuery.push(body);
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  return calls;
}

/** 取「机器人发出去的所有消息正文」拼起来，方便找关键词 */
function allText(calls) {
  return calls.sendMessage.map((m) => m.text || '').join('\n');
}

const TOKEN = 'fake-token:ABC';

// ---------------------------------------------------------------------------
console.log('--- 1. 会话状态机（getWizard / setWizard / clearWizard）---');
{
  const env = freshEnv();
  check('初始没有进行中的流程', (await common.getWizard(env, CHAT)) === null);

  await common.setWizard(env, CHAT, { step: addAccount.STEP_ASK_AK });
  const got = await common.getWizard(env, CHAT);
  check('写入后能读回', got && got.step === addAccount.STEP_ASK_AK);
  check('自动带了时间戳', got && typeof got.at === 'number' && got.at > 0);

  await common.clearWizard(env, CHAT);
  check('清除后读不到', (await common.getWizard(env, CHAT)) === null);
}

console.log('--- 2. 会话状态与「当前选中机器」互不干扰 ---');
{
  const env = freshEnv();
  await common.setCurrentDevice(env, CHAT, 'i-aaaa1111');
  await common.setWizard(env, CHAT, { step: addAccount.STEP_ASK_AK, ak: 'LTAIxxxx' });

  check('写 wizard 之后，当前选中机器还在',
    (await common.getCurrentDevice(env, CHAT)) === 'i-aaaa1111');
  check('wizard 也在',
    (await common.getWizard(env, CHAT))?.ak === 'LTAIxxxx');

  // 反过来再写一次选中机器，wizard 不该被抹掉
  await common.setCurrentDevice(env, CHAT, 'i-bbbb2222');
  check('再写选中机器后，wizard 仍在',
    (await common.getWizard(env, CHAT))?.ak === 'LTAIxxxx',
    '这正是 setCurrentDevice 必须用合并而非覆盖的原因');
  check('选中机器已更新',
    (await common.getCurrentDevice(env, CHAT)) === 'i-bbbb2222');
}

console.log('--- 3. 过期保护（超过 15 分钟自动作废）---');
{
  const env = freshEnv();
  // 手动塞一个「老」状态：时间戳往前拨 20 分钟
  await common.setWizard(env, CHAT, { step: addAccount.STEP_ASK_AK, ak: 'LTAIold' });
  const sessions = await common.loadSessions(env);
  sessions[CHAT].wizard.at = common.nowSeconds() - 20 * 60;
  await env.CDT_GUARD_KV.put('sessions', JSON.stringify(sessions));

  check('过期状态读不出来', (await common.getWizard(env, CHAT)) === null);
  // 过期后应被顺手清掉，不留垃圾
  const after = await common.loadSessions(env);
  check('过期状态被清理掉', !(after[CHAT] && after[CHAT].wizard));
}

// ---------------------------------------------------------------------------
console.log('--- 4. AccessKey / Secret 格式校验 ---');
{
  const env = freshEnv();
  const calls = installFakeFetch();

  // 4a. 明显不对的 AK 要被拦住
  await addAccount.startAddAccount(env, TOKEN, CHAT);
  await addAccount.handleAddAccountStep(env, TOKEN, CHAT, '随便打的', 100);
  check('非法 AK 被拦住（没有进入下一步）',
    (await common.getWizard(env, CHAT))?.step === addAccount.STEP_ASK_AK);
  check('并且告诉了用户正确格式', allText(calls).includes('LTAI'));

  // 4b. 合法的 AK 进入下一步
  await addAccount.handleAddAccountStep(env, TOKEN, CHAT, 'LTAI5tTestKeyFakeValue0', 101);
  const w2 = await common.getWizard(env, CHAT);
  check('合法 AK 后被要求发 Secret', w2?.step === addAccount.STEP_ASK_SK);
  check('AK 已存进会话', w2?.ak === 'LTAI5tTestKeyFakeValue0');
  check('回显里的 AK 是打码的',
    allText(calls).includes('LTAI5t****lue0') && !allText(calls).includes('LTAI5tTestKeyFakeValue0'));
}

// ---------------------------------------------------------------------------
console.log('--- 5. Secret 处理：立刻删消息 ---');
{
  const env = freshEnv();
  const calls = installFakeFetch();
  await addAccount.startAddAccount(env, TOKEN, CHAT);
  await addAccount.handleAddAccountStep(env, TOKEN, CHAT, 'LTAI5tTestKeyFakeValue0', 200);

  // 发一个「太短」的 Secret：应被删掉、且不往下走
  await addAccount.handleAddAccountStep(env, TOKEN, CHAT, 'short', 201);
  check('收到 Secret 后调用了删除接口',
    calls.deleteMessage.length === 1,
    `实际 ${calls.deleteMessage.length} 次`);
  check('删除的是收到 Secret 那条消息',
    calls.deleteMessage[0].message_id === 201);
  check('太短的 Secret 不往下走',
    (await common.getWizard(env, CHAT))?.step === addAccount.STEP_ASK_SK);
}

// ---------------------------------------------------------------------------
console.log('--- 6. 配置合并：只追加、绝不动已有机器（最关键）---');
{
  const env = freshEnv();
  const calls = installFakeFetch();

  // 预置一份「已有的」配置（模拟老大现在线上的那台菲律宾机器）
  await common.saveConfig(env, {
    telegram: { chat_id: CHAT },
    users: [{
      name: '菲律宾节点',
      instance_id: 'i-existing00000000001',
      region: 'ap-southeast-6',
      ak: 'LTAI5tTestKeyFakeValue0',
      sk: 'fakeSecretForTesting0000000000',
      traffic_limit: 180,
      paused: false,
    }],
  });

  // 模拟「已经扫完，等确认」的状态：两台新机器（含一台重复的）
  await common.setWizard(env, CHAT, {
    step: addAccount.STEP_CONFIRM,
    ak: 'LTAI5tNEWaccount999xyz',
    sk: 'newSecretForSecondAccount1234567890',
    instances: [
      { instanceId: 'i-new1111111111111', instanceName: '东京节点', region: 'ap-northeast-1', status: 'Running', isOverseas: true },
      { instanceId: 'i-new2222222222222', instanceName: '', region: 'cn-hangzhou', status: 'Running', isOverseas: false },
      // 这台已经在配置里了 —— 必须被跳过，不能重复加
      { instanceId: 'i-existing00000000001', instanceName: '菲律宾节点', region: 'ap-southeast-6', status: 'Running', isOverseas: true },
    ],
  });

  const wizard = await common.getWizard(env, CHAT);
  await addAccount.confirmAddAccount(env, TOKEN, CHAT, wizard);

  const after = await common.loadConfig(env);
  check('原有机器还在（配置没被覆盖）',
    after.users.some((u) => u.instance_id === 'i-existing00000000001'));
  check('原有机器的名字没变',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.name === '菲律宾节点');
  check('原有机器的阈值没变',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.traffic_limit === 180);

  check('新机器加进来了（东京）',
    after.users.some((u) => u.instance_id === 'i-new1111111111111'));
  check('新机器加进来了（杭州）',
    after.users.some((u) => u.instance_id === 'i-new2222222222222'));
  check('重复的机器没有被加两次',
    after.users.filter((u) => u.instance_id === 'i-existing00000000001').length === 1,
    `实际出现 ${after.users.filter((u) => u.instance_id === 'i-existing00000000001').length} 次`);
  check('总台数为 3（1 原有 + 2 新增）', after.users.length === 3, `实际 ${after.users.length}`);

  check('新机器带上了新账号的 AK',
    after.users.find((u) => u.instance_id === 'i-new1111111111111')?.ak === 'LTAI5tNEWaccount999xyz');
  check('新机器带上了新账号的 SK',
    after.users.find((u) => u.instance_id === 'i-new1111111111111')?.sk === 'newSecretForSecondAccount1234567890');
  check('新机器默认阈值 180',
    after.users.find((u) => u.instance_id === 'i-new1111111111111')?.traffic_limit === 180);
  check('新机器默认不暂停',
    after.users.find((u) => u.instance_id === 'i-new1111111111111')?.paused === false);

  check('没名字的机器自动起了个名',
    Boolean(after.users.find((u) => u.instance_id === 'i-new2222222222222')?.name),
    '否则菜单里会出现空白按钮');

  check('telegram chat_id 保留',
    after.telegram?.chat_id === CHAT);

  check('流程状态已清除（不再占着会话）',
    (await common.getWizard(env, CHAT)) === null);

  check('回执里写了新增台数', allText(calls).includes('新加入 2 台'));
  check('回执里写了总台数', allText(calls).includes('3 台机器'));
  check('回执里写了账号数', allText(calls).includes('2 个账号'));
}

// ---------------------------------------------------------------------------
console.log('--- 7. 安全：回给用户的消息绝不出现完整 Secret ---');
{
  const env = freshEnv();
  const calls = installFakeFetch();
  const SECRET = 'superSecretValueThatMustNeverAppear123456';

  await common.setWizard(env, CHAT, {
    step: addAccount.STEP_CONFIRM,
    ak: 'LTAI5tNEWaccount999xyz',
    sk: SECRET,
    instances: [
      { instanceId: 'i-x1111111111111', instanceName: '测试机', region: 'ap-southeast-1', status: 'Running', isOverseas: true },
    ],
  });
  const wizard = await common.getWizard(env, CHAT);
  await addAccount.confirmAddAccount(env, TOKEN, CHAT, wizard);

  check('回执里没有完整 Secret', !allText(calls).includes(SECRET));
  check('回执里也不该出现 Secret 的一半以上',
    !allText(calls).includes(SECRET.slice(0, 20)));
}

// ---------------------------------------------------------------------------
console.log('--- 8. 取消：任何一步都能干净退出 ---');
{
  const env = freshEnv();
  const calls = installFakeFetch();
  await common.saveConfig(env, {
    telegram: { chat_id: CHAT },
    users: [{ name: '原有', instance_id: 'i-orig', region: 'cn-hangzhou', ak: 'LTAIold', sk: 'oldsk0000000000000000000', traffic_limit: 180, paused: false }],
  });

  await addAccount.startAddAccount(env, TOKEN, CHAT);
  const consumed = await addAccount.handleAddAccountStep(env, TOKEN, CHAT, '/cancel', 300);

  check('取消被流程接住', consumed === true);
  check('流程状态清掉了', (await common.getWizard(env, CHAT)) === null);
  const cfg = await common.loadConfig(env);
  check('取消后配置一字未动', cfg.users.length === 1 && cfg.users[0].instance_id === 'i-orig');
  check('明确告知没有改动配置', allText(calls).includes('没有改动任何配置'));
}

// ---------------------------------------------------------------------------
console.log('--- 9. 不是流程中的消息要交回给主菜单处理 ---');
{
  const env = freshEnv();
  installFakeFetch();
  // 没有进行中的流程 → 应该返回 false（交给普通菜单）
  const consumed = await addAccount.handleAddAccountStep(env, TOKEN, CHAT, '总览', 400);
  check('无流程时返回 false（不吞掉普通消息）', consumed === false);
}

// ---------------------------------------------------------------------------
console.log('--- 10. 扫描结果排版（中文、含关键信息）---');
{
  const text = scan.formatScanResult([
    { instanceId: 'i-aaa1111111111111', instanceName: '东京节点', region: 'ap-northeast-1', status: 'Running', isOverseas: true },
    { instanceId: 'i-bbb2222222222222', instanceName: '杭州节点', region: 'cn-hangzhou', status: 'Stopped', isOverseas: false },
  ]);
  check('写了总台数', text.includes('共找到 2 台'));
  check('写了机器名', text.includes('东京节点') && text.includes('杭州节点'));
  check('写了实例 ID', text.includes('i-aaa1111111111111'));
  check('写了地域', text.includes('ap-northeast-1'));
  check('境外机器标了 200GB', text.includes('200GB'));
  check('内地机器标了 20GB', text.includes('20GB'));
  check('不含英文字母单词（除地域/ID 这类必要标识）',
    !/Error|error|undefined|null/.test(text));
}

{
  const empty = scan.formatScanResult([]);
  check('空结果有专门文案', empty.includes('没有找到'));
  check('空结果给了排查方向', empty.includes('权限') || empty.includes('授权'));
}

// ---------------------------------------------------------------------------
console.log('--- 11. maskAk 打码规则（多账号要能区分）---');
{
  const a = addAccount.maskAk('LTAI5tTestKeyFakeValue0');
  const b = addAccount.maskAk('LTAI5tANOTHER_account_999');
  check('长 AK 打码为前6+后4', a === 'LTAI5t****lue0', a);
  check('两个不同账号打码后能区分', a !== b, `${a} vs ${b}`);
  check('短 AK 原样返回（不画蛇添足）', addAccount.maskAk('LTAI123') === 'LTAI123');
  check('空值有兜底文案', addAccount.maskAk('') === '未填写');
  check('null 安全', addAccount.maskAk(null) === '未填写');
}

// ---------------------------------------------------------------------------
console.log('--- 12. 契约一致性：免费额度必须来自单一来源（第四轮固化）---');
{
  // 背景：额度数值曾有 3 处硬编码（20 / 200），改一处漏两处的风险。
  // 现在统一从 aliyun-api.js 的 FREE_QUOTA_* 常量取。
  // 这组断言「常量值」与「扫描结果文案」严格对应，任一处写死新数字都会报红。
  const api = await import('../src/aliyun-api.js');
  const scan = await import('../src/account-scan.js');

  check('内地额度常量为 20', api.FREE_QUOTA_MAINLAND_GB === 20);
  check('非内地额度常量为 200', api.FREE_QUOTA_OVERSEAS_GB === 200);

  const out = scan.formatScanResult([
    { instanceName: '香港节点', region: 'cn-hongkong', status: 'Running', instanceId: 'i-hk' },
    { instanceName: '北京节点', region: 'cn-beijing', status: 'Running', instanceId: 'i-bj' },
  ]);
  check('扫描文案：非内地显示 200GB', out.includes('200GB 免费额度'));
  check('扫描文案：内地显示 20GB', out.includes('20GB 免费额度'));
  // 中国香港必须走 200 这一支（不是内地）
  check('中国香港按非内地算', api.isOverseasRegion('cn-hongkong') === true);
  check('北京按内地算', api.isOverseasRegion('cn-beijing') === false);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('==========================================');
console.log(`添加账号流程自检: 通过 ${pass} / 失败 ${fail}`);
console.log('==========================================');

process.exit(fail === 0 ? 0 : 1);
