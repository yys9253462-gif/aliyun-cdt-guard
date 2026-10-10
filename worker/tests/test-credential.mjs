/**
 * 凭据失效处理自检（不联网）
 * ===========================================================================
 * 老大问过一个问题：「账号的 AccessKey 失效了现在是怎么处理的？」
 * 查完发现原来的机制有三个短板，本轮全补上了，这个测试就是钉死这些行为：
 *
 *   1. **巡检失败要说人话** —— 不能只把阿里云的英文原报错贴出来，
 *      要能告诉用户「是密钥失效了，去重新填一份」。
 *   2. **凭据类错误不受普通冷却压制** —— 网络抖动 1 小时冷却是对的，
 *      但密钥失效必须每天提醒，否则用户以为「没消息就是没事」。
 *   3. **绝不能因为凭据失效就删配置** —— 这是老大最担心的点。
 *
 * 全部离线：错误分类是纯函数，告警链路用假 Telegram 拦截。
 */

import * as credErr from '../src/credential-error.js';
import * as guard from '../src/guard.js';
import * as common from '../src/common.js';
import * as api from '../src/aliyun-api.js';

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

/**
 * 把 fetch 拦掉：既拦 Telegram（收告警），也拦阿里云（造错误）。
 *
 * ⚠️ 阿里云的 doRequest 会做三件事，假响应必须都满足：
 *   1. 调 response.text() 拿原始文本
 *   2. 读 response.status
 *   3. 失败时可能重试（瞬态错误才重试；业务错误立刻抛）
 *   所以这里返回的对象要带 text() 与 status。
 */
function installFakeFetch(aliyunHandler) {
  const calls = { sendMessage: [] };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    const method = u.split('/').pop();

    // Telegram
    if (method === 'sendMessage') {
      const body = JSON.parse(options?.body || '{}');
      calls.sendMessage.push(body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      };
    }

    // 阿里云
    if (aliyunHandler) {
      return aliyunHandler(u, options);
    }
    return {
      ok: true,
      status: 200,
      text: async () => '{"RequestId":"x"}',
      json: async () => ({ RequestId: 'x' }),
    };
  };
  return calls;
}

/** 造一个「阿里云返回业务错误」的假响应 */
function aliyunError(code, message) {
  const body = JSON.stringify({ Code: code, Message: message, RequestId: 'x' });
  return {
    ok: false,
    status: 400,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 造一个「阿里云成功」的假响应（可用于 describeRegions） */
function aliyunOk(bodyObj) {
  const body = JSON.stringify(bodyObj || { RequestId: 'x' });
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function allText(calls) {
  return calls.sendMessage.map((m) => m.text || '').join('\n');
}

const CHAT = '7912011729';
const TOKEN = 'fake-token:ABC';

// ⚠️ 测试里一律用「一眼就是假的」占位密钥，绝不写真实凭据。
//    曾经这里贴的是真密钥，被 GitHub 密钥扫描拦下、推送直接被拒 ——
//    而且真密钥进版本库本身就是安全事故。测试只需要「有个字符串」，
//    用假的完全等价。
const FAKE_AK = 'LTAI-FAKE-0000-TEST-ONLY';
const FAKE_SK = 'FAKE-SECRET-FOR-TEST-ONLY-0000000000';

function baseConfig() {
  return {
    bot_token: TOKEN,
    chat_id: CHAT,
    telegram: { bot_token: TOKEN, chat_id: CHAT, admin_ids: [CHAT] },
    users: [
      {
        name: '菲律宾节点',
        instance_id: 'i-5ts7fo7n0ui3stsujw0r',
        region: 'ap-southeast-6',
        ak: FAKE_AK,
        sk: FAKE_SK,
        traffic_limit: 180,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
console.log('--- 1. 错误分类：能不能准确认出「密钥失效」---');
{
  const cases = [
    ['InvalidAccessKeyId.NotFound', credErr.ERR_CREDENTIAL],
    ['SignatureDoesNotMatch', credErr.ERR_CREDENTIAL],
    ['InvalidAccessKeySecret: the secret is invalid', credErr.ERR_CREDENTIAL],
    ['Forbidden: no permission to perform this action', credErr.ERR_CREDENTIAL],
    ['SecurityToken expired', credErr.ERR_CREDENTIAL],
  ];
  for (const [raw, expect] of cases) {
    const r = credErr.classifyError(new Error(raw));
    check(`识别为「凭据问题」：${raw.slice(0, 30)}`, r.kind === expect, `实际 ${r.kind}`);
  }
}

console.log('--- 2. 暂时性错误不能被误报成「密钥失效」（否则用户白折腾）---');
{
  const transients = [
    'Throttling: request too frequent',
    'TooManyRequests',
    'fetch failed',
    'connect ETIMEDOUT',
    'getaddrinfo ENOTFOUND',
  ];
  for (const raw of transients) {
    const r = credErr.classifyError(new Error(raw));
    check(`不误报为凭据问题：${raw.slice(0, 30)}`,
      r.kind === credErr.ERR_TRANSIENT, `实际 ${r.kind}`);
    check(`  且 isCredentialError 返回 false：${raw.slice(0, 20)}`,
      credErr.isCredentialError(new Error(raw)) === false);
  }
}

console.log('--- 3. 中文原因要能指导下一步（不能只有英文原话）---');
{
  const r = credErr.classifyError(new Error('InvalidAccessKeyId.NotFound'));
  check('保留了阿里云原话（便于排障）', r.reason.includes('InvalidAccessKeyId'));
  check('给了中文解释', /阿里云不认识|删除/.test(r.reason));
  check('文案里没有裸露的英文技术名词 Key/Secret',
    !/\bSecret\b/.test(r.reason) && !/\bKey\b/.test(r.reason), r.reason);

  const perm = credErr.classifyError(new Error('Forbidden: no permission'));
  check('权限不足给了中文动作指引', /权限|只读/.test(perm.reason), perm.reason);
}

console.log('--- 4. 巡检遇到凭据错误：发告警，且文案说人话 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  // 阿里云所有接口都返回「密钥不存在」
  const calls = installFakeFetch(async () => aliyunError(
    'InvalidAccessKeyId.NotFound',
    'The AccessKeyId provided does not exist in our records.'
  ));

  const config = baseConfig();
  const state = {};
  const user = config.users[0];

  await guard.checkOne(env, user, config, state, () => {});

  const text = allText(calls);
  check('发出了一条告警', calls.sendMessage.length >= 1, `实际 ${calls.sendMessage.length} 条`);
  check('告警标题点明「凭据失效」', /凭据/.test(text), text.slice(0, 120));
  check('告警说明「监控已中断」', /失效|中断/.test(text));
  check('告警带了中文原因', /阿里云不认识|已被删除/.test(text), text.slice(0, 200));
  check('告警告诉用户怎么修', /添加账号|凭据体检/.test(text));

  // 🔴 最关键：配置绝不能被改
  check('🔴 巡检后机器配置原封不动',
    config.users.length === 1 && config.users[0].instance_id === user.instance_id);
}

console.log('--- 5. 凭据告警不受普通冷却压制（网络抖动才压）---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const calls = installFakeFetch(async () => aliyunError(
    'InvalidAccessKeyId.NotFound', 'not exist'
  ));

  const config = baseConfig();
  const state = {};
  const user = config.users[0];

  // 跑 5 轮（相当于 25 分钟）。普通告警有 1 小时冷却，只会发 1 条；
  // 凭据告警首轮必须立刻发，不能被「连续 3 次」阈值卡住。
  for (let i = 0; i < 5; i += 1) {
    await guard.checkOne(env, user, config, state, () => {});
    await common.saveState(env, state);
  }
  check('首轮就发了（不需要等连续 3 次）', calls.sendMessage.length >= 1,
    `实际 ${calls.sendMessage.length} 条`);
  check('冷却生效，不会 5 轮发 5 条', calls.sendMessage.length <= 2,
    `实际 ${calls.sendMessage.length} 条`);

  // 手动把冷却标记往前拨 25 小时，应该能再发一条。
  // ⚠️ 注意键名：告警标记写在 `${key}:cred_failed` 这一层
  //    （因为 eventKey 就是 `${key}:cred_failed`），别写到 `${key}` 上。
  const key = user.instance_id;
  state[`${key}:cred_failed`] = { cred_failed: common.nowSeconds() - 90000 };
  await common.saveState(env, state);
  const before = calls.sendMessage.length;
  await guard.checkOne(env, user, config, state, () => {});
  check('过了 24 小时会再提醒一次（不会「安静地一直坏着」）',
    calls.sendMessage.length > before, `前 ${before} 后 ${calls.sendMessage.length}`);
}

console.log('--- 6. 密钥修好后，冷却标记要清掉（否则下次漏报）---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  // 让阿里云接口「恢复正常」。
  // ⚠️ 必须带回 Instances.Instance（带 Status），否则 getInstanceStatus 返回 null，
  //    checkOne 会在「未找到实例」处提前 return，根本走不到清标记那一段 ——
  //    测试就会假失败（这个坑真踩过）。
  installFakeFetch(async () => aliyunOk({
    RequestId: 'x',
    Instances: { Instance: [{ Status: 'Running' }] },
  }));

  const config = baseConfig();
  const state = {};
  const key = config.users[0].instance_id;
  // 先塞一个「曾经坏过」的标记（注意写在 `${key}:cred_failed` 这一层）
  state[`${key}:cred_failed`] = { cred_failed: common.nowSeconds() - 100 };
  await guard.checkOne(env, config.users[0], config, state, () => {});
  check('巡检成功后，cred_failed 标记被清除',
    state[`${key}:cred_failed`] && state[`${key}:cred_failed`].cred_failed === undefined,
    JSON.stringify(state[`${key}:cred_failed`]));
}

console.log('--- 7. 凭据体检报告：要点名受影响的机器 ---');
{
  const credCheck = await import('../src/credential-check.js');
  installFakeFetch(async () => aliyunError(
    'InvalidAccessKeyId.NotFound', 'not exist'
  ));

  const config = baseConfig();
  const report = await credCheck.buildCredentialReport(config);
  check('报告点出「凭据已失效」', /失效/.test(report), report.slice(0, 150));
  check('报告列出了受影响的机器名', report.includes('菲律宾节点'));
  check('报告说明监控已中断', /中断/.test(report));
  check('报告给了修复方法', /添加账号|重新填/.test(report));
  check('报告里 AK 打了码（不出现完整密钥）',
    !report.includes(FAKE_AK));
}

console.log('--- 8. 定时体检：一切正常时保持安静（不推噪音）---');
{
  const credCheck = await import('../src/credential-check.js');
  installFakeFetch(async () => aliyunOk({
    RequestId: 'x',
    Regions: { Region: [{ RegionId: 'ap-southeast-6' }] },
  }));

  const config = baseConfig();
  const result = await credCheck.runScheduledCredentialCheck(config);
  check('凭据正常时不产生消息', result.badCount === 0 && result.message === '',
    JSON.stringify(result));

  // 坏了才说话
  installFakeFetch(async () => aliyunError('InvalidAccessKeyId.NotFound', 'not exist'));
  const bad = await credCheck.runScheduledCredentialCheck(baseConfig());
  check('凭据坏了要产生消息', bad.badCount === 1 && bad.message.length > 0);
  check('消息里点出哪个账号坏了', /账号/.test(bad.message));
}

console.log('--- 9. 多个账号：逐个独立判断（一个坏不牵连另一个）---');
{
  const credCheck = await import('../src/credential-check.js');
  // 按请求体里的 AccessKeyId 区分是哪个账号 —— 这样不受重试次数影响。
  installFakeFetch(async (u, options) => {
    const body = String(options?.body || '');
    // 第一个账号的 AK 是 LTAI5tEh86...，坏；第二个是 LTAI5tOther...，好
    if (body.includes('LTAI5tOtherAccountKey99')) {
      return aliyunOk({
        RequestId: 'x',
        Regions: { Region: [{ RegionId: 'cn-hangzhou' }] },
      });
    }
    return aliyunError('InvalidAccessKeyId.NotFound', 'not exist');
  });

  const config = baseConfig();
  config.users.push({
    name: '杭州节点',
    instance_id: 'i-hangzhou001',
    region: 'cn-hangzhou',
    ak: 'LTAI5tOtherAccountKey99',
    sk: 'AnotherSecretValue1234567890abcdef',
    traffic_limit: 20,
  });

  const { groups } = await credCheck.checkAllCredentials(config);
  check('两个账号各出一条结果', groups.length === 2, `实际 ${groups.length}`);
  const bad = groups.filter((g) => !g.ok);
  const good = groups.filter((g) => g.ok);
  check('只有坏的那个被标为失效', bad.length === 1 && good.length === 1,
    `坏 ${bad.length} 好 ${good.length}`);
  if (bad.length === 1) {
    check('失效账号关联到正确的那台机器',
      bad[0].names.includes('菲律宾节点'), JSON.stringify(bad[0].names));
  }
  if (good.length === 1) {
    check('正常账号不受牵连', good[0].names.includes('杭州节点'),
      JSON.stringify(good[0].names));
  }
}

console.log('');
console.log('==========================================');
console.log(`凭据失效处理自检: 通过 ${pass} / 失败 ${fail}`);
console.log('==========================================');
process.exit(fail === 0 ? 0 : 1);
