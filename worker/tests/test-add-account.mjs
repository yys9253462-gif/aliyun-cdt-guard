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

const CHAT = '123456789';

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
      // ⚠️ 这台已经在配置里了。注意：**不是完全相同的凭据**（AK 不同）——
      //    真实场景里这就是「用户换了一把新密钥，机器还是那台机器」。
      //    此时**必须原地更新凭据**，否则配置里留着失效旧密钥，
      //    之后巡检/账号汇总全部报 InvalidAccessKeyId.NotFound（实测踩过）。
      { instanceId: 'i-existing00000000001', instanceName: '菲律宾节点', region: 'ap-southeast-6', status: 'Running', isOverseas: true },
    ],
  });

  const wizard = await common.getWizard(env, CHAT);
  await addAccount.confirmAddAccount(env, TOKEN, CHAT, wizard);

  const after = await common.loadConfig(env);
  check('原有机器还在（配置没被覆盖）',
    after.users.some((u) => u.instance_id === 'i-existing00000000001'));
  check('原有机器的名字没被冲掉（保留用户设置）',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.name === '菲律宾节点');
  check('原有机器的阈值没被冲掉（保留用户设置）',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.traffic_limit === 180);
  // ⭐ 本轮修复的核心断言
  check('换密钥后：原机器的 AK 被原地更新为新值',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.ak === 'LTAI5tNEWaccount999xyz',
    `实际 ${after.users.find((u) => u.instance_id === 'i-existing00000000001')?.ak}`);
  check('换密钥后：原机器的 SK 被原地更新为新值',
    after.users.find((u) => u.instance_id === 'i-existing00000000001')?.sk === 'newSecretForSecondAccount1234567890');

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
  check('回执里写了更新凭据台数', allText(calls).includes('更新凭据 1 台'));
  check('回执里写了总台数', allText(calls).includes('3 台机器'));
  // 注意：这里原先是「2 个账号」，但本轮修复后，那台「已存在」的机器
  // 凭据被**原地更新成了新 AK** —— 于是三台机器都归到新 AK 名下，只剩 1 个账号。
  // 这正是修复的预期效果（同一台机器不可能同时属于两个账号）。
  check('回执里写了账号数（更新后只剩 1 个账号）',
    allText(calls).includes('1 个账号'), allText(calls).slice(-120));
}

// ---------------------------------------------------------------------------
// 6b. 换密钥后重新添加：凭据必须被原地更新（本轮修的 BUG 的专项回归）
//     用户实际操作：删掉旧 AccessKey -> 新建一把 -> 在机器人里添加 ->
//     扫描到还是那台机器 -> 旧代码按 instance_id 去重直接跳过 ->
//     配置里留着**失效的旧密钥** -> 账号汇总 / 巡检报
//     InvalidAccessKeyId.NotFound。
// ---------------------------------------------------------------------------
{
  console.log('--- 6b. 换密钥后重新添加（BUG 专项回归）---');
  const env = freshEnv();
  const calls = installFakeFetch();
  const CHAT = '30003';
  await common.saveConfig(env, {
    telegram: { chat_id: CHAT, admin_ids: [CHAT] },
    users: [
      // 用户原来配的：旧密钥，机器 i-faketest0000stsujw0r
      {
        name: '菲律宾节点', instance_id: 'i-faketest0000stsujw0r',
        region: 'ap-southeast-6', ak: 'LTAI5tOLDdeleted000000',
        sk: 'OLDsecretWhichWasDeleted00000000',
        traffic_limit: 180, paused: false,
      },
    ],
  });

  // 用户换了一把全新密钥，扫描到的**还是同一台机器**
  await common.setWizard(env, CHAT, {
    step: addAccount.STEP_CONFIRM,
    ak: 'LTAI5tBRANDnewkey111111',
    sk: 'BRANDnewSecretValue0000000000000',
    instances: [
      { instanceId: 'i-faketest0000stsujw0r', instanceName: 'launch-advisor-20261010', region: 'ap-southeast-6', status: 'Running', isOverseas: true },
    ],
  });

  const w = await common.getWizard(env, CHAT);
  await addAccount.confirmAddAccount(env, TOKEN, CHAT, w);

  const cfg = await common.loadConfig(env);
  const m = cfg.users.find((u) => u.instance_id === 'i-faketest0000stsujw0r');

  check('换密钥后 AK 已更新（不再是失效的旧 AK）',
    m?.ak === 'LTAI5tBRANDnewkey111111', `实际 ${m?.ak}`);
  check('换密钥后 SK 已更新（不再是失效的旧 SK）',
    m?.sk === 'BRANDnewSecretValue0000000000000', `实际 ${m?.sk}`);
  check('没有产生第二台机器（仍是 1 台）',
    cfg.users.length === 1, `实际 ${cfg.users.length} 台`);
  check('用户改过的机器名没被扫描结果覆盖',
    m?.name === '菲律宾节点', `实际 ${m?.name}`);
  check('用户改过的阈值没被冲掉',
    m?.traffic_limit === 180, `实际 ${m?.traffic_limit}`);
  check('回执说明了「凭据已更新」而不是「没有新增」',
    allText(calls).includes('凭据已更新'), allText(calls).slice(0, 120));
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
console.log('--- 13. 地域中文名映射（本轮新增）---');
{
  const R = await import('../src/region-names.js');

  // 13a. 老大自己的机器所在地域 —— 最该对的一条
  check('ap-southeast-6 是「马尼拉」', R.regionDisplayName('ap-southeast-6') === '马尼拉',
    R.regionDisplayName('ap-southeast-6'));

  // 13b. 逐个抽查关键地域（覆盖内地/香港/亚太/欧美/中东）
  const spot = [
    ['cn-hangzhou', '杭州'],
    ['cn-beijing', '北京'],
    ['cn-wulanchabu', '乌兰察布'],
    ['cn-wuhan-lr', '武汉本地'],
    ['cn-hongkong', '中国香港'],
    ['ap-southeast-1', '新加坡'],
    ['ap-northeast-1', '东京'],
    ['ap-northeast-2', '首尔'],
    ['ap-southeast-7', '曼谷'],
    ['us-west-1', '硅谷'],
    ['us-east-1', '弗吉尼亚'],
    ['eu-central-1', '法兰克福'],
    ['me-east-1', '迪拜'],
    ['sa-east-1', '圣保罗'],
  ];
  for (const [code, cn] of spot) {
    check(`${code} → ${cn}`, R.regionDisplayName(code) === cn, R.regionDisplayName(code));
  }

  // 13c. 大小写不敏感（接口万一返回大写也不该失效）
  check('大小写不敏感', R.regionDisplayName('AP-SOUTHEAST-6') === '马尼拉');

  // 13d. 🔴 未知地域必须回退成**原代码**，不能回退成「未知地域」四个字。
  //      回退成代码至少还能查；回退成「未知地域」等于把信息抹掉。
  check('未知地域回退成原代码（不是「未知地域」）',
    R.regionDisplayName('xx-future-9') === 'xx-future-9',
    R.regionDisplayName('xx-future-9'));
  check('带代码渲染时未知地域不重复括号',
    R.regionDisplayWithCode('xx-future-9') === 'xx-future-9',
    R.regionDisplayWithCode('xx-future-9'));
  check('空值与 null 有兜底', R.regionDisplayName('') === '未知地域'
    && R.regionDisplayName(null) === '未知地域');

  // 13e. 带代码渲染：中文名在前、代码在后（两个都要给，用户既认得出也不会用错）
  check('regionDisplayWithCode 形如「马尼拉（ap-southeast-6）」',
    R.regionDisplayWithCode('ap-southeast-6') === '马尼拉（ap-southeast-6）',
    R.regionDisplayWithCode('ap-southeast-6'));

  // 13f. 表本身的质量：键必须全小写（否则查表时的 toLowerCase 会让某些条目永远命不中）
  const badKeys = Object.keys(R.REGION_CN).filter((k) => k !== k.toLowerCase());
  check('映射表所有键都是小写', badKeys.length === 0, badKeys.join(','));

  // 13g. 值里不能有英文字母（这是给老大看的，必须全中文）
  const latinValues = Object.entries(R.REGION_CN)
    .filter(([, v]) => /[A-Za-z]/.test(v));
  check('映射表所有中文名不含英文字母', latinValues.length === 0,
    latinValues.map(([k, v]) => `${k}=${v}`).join(' , '));

  // 13h. 不能有重复的中文名（否则两个地域显示一样，用户分不清）
  const names = Object.values(R.REGION_CN);
  check('中文名无重复', new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(','));

  // 13i. 覆盖度：扫描兜底清单里的地域必须**全部**有中文名
  //      （否则扫描时会出现「地域 ap-southeast-2」这种半中半英的尴尬）
  const scanMod = await import('../src/account-scan.js');
  const missing = scanMod.FALLBACK_REGIONS.filter((r) => !R.isKnownRegion(r));
  check('扫描用的兜底地域清单全部有中文名', missing.length === 0,
    `缺: ${missing.join(', ')}`);

  // 13j. 扫描结果排版里必须出现中文地域名 + 代码
  const scanText = scanMod.formatScanResult([
    { instanceId: 'i-abc', instanceName: '马尼拉节点', region: 'ap-southeast-6', status: 'Running' },
  ]);
  check('扫描文案显示中文地域名', scanText.includes('马尼拉'), scanText);
  check('扫描文案同时保留地域代码', scanText.includes('ap-southeast-6'));
}

// ---------------------------------------------------------------------------
console.log('--- 14. 无名机器的自动命名：中文地域 + 账号标识 + 尾号 ---');
{
  const R = await import('../src/region-names.js');

  // 走完整流程拿到真实产物（buildName 是内部函数，只能从 confirmAddAccount 观察）
  async function nameOf(region, instanceId, ak) {
    const env = freshEnv();
    installFakeFetch();
    const chat = `name-${region}-${instanceId}-${ak}`.slice(0, 40);
    await common.setWizard(env, chat, {
      step: addAccount.STEP_CONFIRM,
      ak, sk: 'fakeSecretForTesting0000000000',
      instances: [{ instanceId, instanceName: '', region, status: 'Running' }],
    });
    const w = await common.getWizard(env, chat);
    await addAccount.confirmAddAccount(env, TOKEN, chat, w);
    const cfg = await common.loadConfig(env);
    return cfg.users[0]?.name;
  }

  const AK = 'LTAI5tTestKeyFakeValue0';

  // 14a. 三段式：中文地域名 - 账号标识 - 尾号
  //      注意 i-faketest0000stsujw0r 的最后 6 位是 **sujw0r**（不是 3stsujw0r）
  const n1 = await nameOf('ap-southeast-6', 'i-faketest0000stsujw0r', AK);
  console.log(`    ap-southeast-6 无名机器 → 「${n1}」`);
  check('用中文地域名而不是代码', n1.includes('马尼拉') && !n1.includes('ap-southeast-6'), n1);
  check('尾巴带上了账号标识（打码 AK 前 6 位）', n1.includes('LTAI5t'), n1);
  check('带上了机器 ID 尾号（后 6 位 sujw0r）', n1.endsWith('sujw0r'), n1);
  check('完整形态是「马尼拉-LTAI5t-sujw0r」',
    n1 === '马尼拉-LTAI5t-sujw0r', n1);
  check('三段用短横线连接', n1.split('-').length === 3, n1);

  // 14b. 同地域、**不同账号** → 名字必须能区分开（这正是老大要的效果）
  const n2 = await nameOf('ap-southeast-6', 'i-faketest0000stsujw0r', 'LTAI5tOtherAccount9999');
  console.log(`    同地域换账号 → 「${n2}」`);
  // ⚠️ 这里刻意**不**断言 n1 !== n2：两个假 AK 的「前 6 位」本来就是同一个 LTAI5t，
  //    按设计它们会得到同样的账号标识。真正能区分账号的是「账号汇总」里的
  //    akDisplay（前 6 + **** + 后 4）。见 14b2。
  check('同前缀账号的标识相同（这是设计的取舍，靠汇总页的后 4 位区分）',
    n1 === n2, `${n1} vs ${n2}`);

  // 14b2. ⭐ 真正要保证的是：**不同前 6 位**的账号一定区分得开
  const n2b = await nameOf('ap-southeast-6', 'i-faketest0000stsujw0r', 'LTAI9xAnotherAcc000000');
  console.log(`    换一个前缀不同的账号 → 「${n2b}」`);
  check('前缀不同的账号，机器名能区分', n2b.includes('LTAI9x') && n2b !== n1, n2b);

  // 14c. 同账号、**同地域**、不同机器 → 靠尾号区分
  const n3 = await nameOf('ap-southeast-6', 'i-faketest0000zzzzzz', AK);
  console.log(`    同地域同账号另一台 → 「${n3}」`);
  check('同账号同地域靠尾号区分', n3 !== n1, `${n3} vs ${n1}`);
  check('尾号确实是新机器的尾号（zzzzzz）', n3.endsWith('zzzzzz'), n3);

  // 14d. 内地地域也用中文
  const n4 = await nameOf('cn-hangzhou', 'i-abcdefghijklmnop', AK);
  console.log(`    内地无名机器 → 「${n4}」`);
  check('内地地域也中文化', n4.startsWith('杭州-'), n4);

  // 14e. AK 为空时不能拼出双横线的怪名字
  const n5 = await nameOf('cn-beijing', 'i-xyzxyzxyzxyzxyz', '');
  console.log(`    AK 为空 → 「${n5}」`);
  check('AK 为空时不出现双横线', !n5.includes('--'), n5);
  check('AK 为空时仍是「地域-尾号」两段', n5 === '北京-xyzxyz', n5);

  // 14f. ⭐ 最关键：已经在监控里的机器**不能**因为本轮改动被改名。
  //      用户可能已经手动改成了「菲律宾节点」——换密钥时也必须保住。
  {
    const env = freshEnv();
    installFakeFetch();
    const chat = 'keep-name-0001';
    await common.saveConfig(env, {
      telegram: { chat_id: chat },
      users: [{
        name: '菲律宾节点', instance_id: 'i-faketest0000stsujw0r',
        region: 'ap-southeast-6', ak: 'LTAI5tOLDdeleted000000',
        sk: 'OLDsecretWhichWasDeleted00000000', traffic_limit: 180, paused: false,
      }],
    });
    await common.setWizard(env, chat, {
      step: addAccount.STEP_CONFIRM,
      ak: AK, sk: 'fakeSecretForTesting0000000000',
      instances: [{ instanceId: 'i-faketest0000stsujw0r', instanceName: '', region: 'ap-southeast-6', status: 'Running' }],
    });
    const w = await common.getWizard(env, chat);
    await addAccount.confirmAddAccount(env, TOKEN, chat, w);
    const cfg = await common.loadConfig(env);
    check('换密钥时已有机器名不被新命名规则覆盖',
      cfg.users[0]?.name === '菲律宾节点', cfg.users[0]?.name);
  }

  // 14g. 阿里云上用户自己起了名字 → 必须原样用，不能套我们的三段式
  {
    const n6 = await nameOf('ap-southeast-6', 'i-faketest0000stsujw0r', AK).then(async () => {
      const env = freshEnv();
      installFakeFetch();
      const chat = 'named-by-user-001';
      await common.setWizard(env, chat, {
        step: addAccount.STEP_CONFIRM,
        ak: AK, sk: 'fakeSecretForTesting0000000000',
        instances: [{
          instanceId: 'i-faketest0000stsujw0r', instanceName: '我的生产机',
          region: 'ap-southeast-6', status: 'Running',
        }],
      });
      const w = await common.getWizard(env, chat);
      await addAccount.confirmAddAccount(env, TOKEN, chat, w);
      const cfg = await common.loadConfig(env);
      return cfg.users[0]?.name;
    });
    check('阿里云已有实例名时原样沿用', n6 === '我的生产机', n6);
  }

  // 14h. 地域映射表必须真的被用上（防止「改了表但没接线」）
  check('页面渲染函数与命名规则用的是同一张表',
    R.regionDisplayName('ap-southeast-6') === '马尼拉');

  // 14i. 🔴 横向一致性：configure.sh 里内联了一份**同口径**的地域映射表
  //      （因为那个脚本独立跑 node，没法 import 项目模块）。
  //      两份必须一致 —— 否则会出现「机器人里显示马尼拉、脚本里显示 ap-southeast-6」
  //      这种同一件事两种说法的情况，而这属于「不报错、只是前后矛盾」的静默问题。
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const sh = fs.readFileSync(path.join(here, '..', 'configure.sh'), 'utf8');

    const mismatched = [];
    for (const [code, cn] of Object.entries(R.REGION_CN)) {
      // 只在脚本里**声明过**的键上比对（金融云等脚本没写的键跳过）
      const m = sh.match(new RegExp(`"${code}"\\s*:\\s*"([^"]+)"`));
      if (m && m[1] !== cn) mismatched.push(`${code}: 模块=${cn} 脚本=${m[1]}`);
    }
    check('configure.sh 里的地域中文名与模块一致', mismatched.length === 0,
      mismatched.join(' | '));

    // 脚本里也必须全中文（不能有漏掉没翻译的）
    const shScope = sh.slice(sh.indexOf('const REGION_CN = {'));
    const shTable = shScope.slice(0, shScope.indexOf('};'));
    const latinInSh = [...shTable.matchAll(/"[^"]+"\s*:\s*"([A-Za-z][^"]*)"/g)]
      .map((x) => x[1]);
    check('configure.sh 的地域名不含英文残留', latinInSh.length === 0,
      latinInSh.join(','));
  }
}

// ---------------------------------------------------------------------------
console.log('--- 15. 🔴 删除失效机器（用户诉求：失效/已删的别一直报警）---');
{
  const bot = await import('../src/bot-listener.js');

  function cfg() {
    return {
      telegram: { bot_token: TOKEN, chat_id: CHAT },
      users: [
        { name: '菲律宾节点', instance_id: 'i-aaa111', region: 'ap-southeast-6',
          ak: 'LTAI-FAKE-AAAA', sk: 'S1', traffic_limit: 180, paused: false },
        { name: '北京机器', instance_id: 'i-bbb222', region: 'cn-beijing',
          ak: 'LTAI-FAKE-BBBB', sk: 'S2', traffic_limit: 20, paused: false },
      ],
    };
  }

  // 15a. 直接调 deleteDevice：删掉一台、另一台必须原封不动
  {
    const env = freshEnv();
    const config = cfg();
    await common.saveConfig(env, config);

    const msg = await bot.deleteDevice(env, config, 'i-aaa111');
    check('删除后给回了说明文案', typeof msg === 'string' && msg.length > 0);

    const after = await common.loadConfig(env);
    check('被删的机器从配置里消失了',
      !after.users.some((u) => u.instance_id === 'i-aaa111'));
    check('🔴 另一台机器绝不能被误删',
      after.users.length === 1 && after.users[0].instance_id === 'i-bbb222',
      `实际剩 ${after.users.length} 台`);
    check('保留下来的机器字段完整（阈值没被冲掉）',
      after.users[0].traffic_limit === 20 && after.users[0].name === '北京机器');

    // 文案必须明确「阿里云上的实例没删」—— 避免用户误以为实例被销毁了
    check('文案说明「阿里云上的实例没有被删除」',
      msg.includes('阿里云') && (msg.includes('没有') || msg.includes('没动')),
      msg);
  }

  // 15b. 删除不存在的机器要温柔报错，不能抛
  {
    const env = freshEnv();
    const config = cfg();
    await common.saveConfig(env, config);
    const msg = await bot.deleteDevice(env, config, 'i-不存在');
    check('删不存在的机器不抛异常，只给提示',
      typeof msg === 'string' && msg.length > 0, msg);
    const after = await common.loadConfig(env);
    check('删不存在的机器时，原有两台都不动', after.users.length === 2);
  }

  // 15c. 🔴 删除时必须清掉 state 里的痕迹（否则重加同 ID 会「继承」旧计数）
  {
    const env = freshEnv();
    const config = cfg();
    await common.saveConfig(env, config);

    // 造一份「这台机器已经连续失败 16 次」的状态
    const state = {
      'i-aaa111': { check_failures: 16, last_status: 'Running' },
      'i-aaa111:cred_failed': { cred_failed: common.nowSeconds() },
      'i-bbb222': { last_status: 'Running' },
    };
    await common.saveState(env, state);

    await bot.deleteDevice(env, config, 'i-aaa111');

    const after = await common.loadState(env);
    check('删机器后，该机器的失败计数被清掉',
      !after['i-aaa111'], JSON.stringify(after['i-aaa111']));
    check('删机器后，该机器的凭据冷却标记被清掉',
      !after['i-aaa111:cred_failed'], JSON.stringify(after['i-aaa111:cred_failed']));
    check('🔴 其他机器的状态不受影响',
      after['i-bbb222'] && after['i-bbb222'].last_status === 'Running');
  }

  // 15d. purgeDeviceState 单元级：前缀派生键要一并清掉
  {
    const state = {
      'i-x1': { a: 1 },
      'i-x1:cred_failed': { cred_failed: 1 },
      'i-x1:quota_warn': { quota_warn: 1 },
      'i-x10': { keep: true },       // 前缀相同但**不是**同一台（前面是 i-x1 后接 0）
    };
    const changed = common.purgeDeviceState(state, 'i-x1');
    check('purge 返回 true（确实删了东西）', changed === true);
    check('主键被清掉', !state['i-x1']);
    check('派生键 cred_failed 被清掉', !state['i-x1:cred_failed']);
    check('派生键 quota_warn 被清掉', !state['i-x1:quota_warn']);
    check('🔴 前缀相似但不是同一台机器的键必须保住',
      state['i-x10'] && state['i-x10'].keep === true);
  }

  // 15e. 🔴 回调链路：点「删除」按钮 → 真的删掉 → 回话
  {
    const env = freshEnv();
    const config = cfg();
    await common.saveConfig(env, config);
    const calls = installFakeFetch();

    await bot.handleCallback(env, config, TOKEN, {
      id: 'cb-1',
      data: 'del:i-aaa111',
      message: { chat: { id: CHAT }, message_id: 5 },
    });

    check('按钮被立刻回应（不转圈）', calls.answerCallbackQuery.length === 1,
      `实际 ${calls.answerCallbackQuery.length}`);

    const after = await common.loadConfig(env);
    check('🔴 点按钮后配置里真的删掉了',
      !after.users.some((u) => u.instance_id === 'i-aaa111'),
      `实际剩 ${after.users.map((u) => u.instance_id).join(',')}`);
    check('回复了删除结果文案',
      allText(calls).includes('删除') || allText(calls).includes('已把'),
      allText(calls).slice(0, 120));
  }

  // 15f. 🔴 越权保护：非本人点击「删除」必须无效
  {
    const env = freshEnv();
    const config = cfg();
    await common.saveConfig(env, config);
    const calls = installFakeFetch();

    await bot.handleCallback(env, config, TOKEN, {
      id: 'cb-2',
      data: 'del:i-aaa111',
      message: { chat: { id: '999999999' }, message_id: 6 },   // 不是本人
    });

    const after = await common.loadConfig(env);
    check('🔴 外人点删除按钮，机器不能被删掉', after.users.length === 2,
      `实际剩 ${after.users.length} 台`);
    check('外人点击只得到「无权操作」，没有执行删除',
      calls.answerCallbackQuery.some((c) => String(c.text || '').includes('无权')),
      JSON.stringify(calls.answerCallbackQuery.map((c) => c.text)));
  }

  // 15g. 三级菜单里必须有「删除机器」这一项（否则用户找不到入口）
  {
    const rows = bot.deviceActionRows({ instance_id: 'i-x', paused: false });
    const flat = rows.flat();
    check('三级菜单含「删除机器」按钮', flat.includes(L.LBL_DEV_DELETE),
      flat.join(' | '));
    check('删除按钮与常用按钮分开（单独占一行，防手滑）',
      rows.some((r) => r.length === 1 && r[0] === L.LBL_DEV_DELETE),
      JSON.stringify(rows));
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('==========================================');
console.log(`添加账号流程自检: 通过 ${pass} / 失败 ${fail}`);
console.log('==========================================');

process.exit(fail === 0 ? 0 : 1);
