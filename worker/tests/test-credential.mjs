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

const CHAT = '123456789';
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
        instance_id: 'i-faketest0000stsujw0r',
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

console.log('--- 2b. 🔴 子串误伤排查（「ram」藏在普通单词里）---');
{
  // 补一个真实踩过的误报源：
  //   权限那条正则里原本写着裸的 `Ram`，而 i 标志让它匹配任何含 ram 的单词。
  //   阿里云的**参数校验错误**恰好大量带 parameter →
  //   用户把实例 ID 填错，会收到「这把密钥权限不够，去加 RAM 权限」，
  //   **指错方向**，白折腾一通。这类误报比漏报更坏：它把人引向错误的操作。
  const notCredential = [
    'Invalid parameter: InstanceId format',
    'InvalidParameter.InstanceId',
    'Parameter is required',
    'grammar error',
    'program failed',
    'dramatic change',
    'frame rate',
    'ram usage high',
    'RAM quota exceeded',
    'memory ram size',
  ];
  for (const raw of notCredential) {
    const r = credErr.classifyError(new Error(raw));
    check(`不被误判为凭据问题：${raw}`,
      r.kind !== credErr.ERR_CREDENTIAL, `实际 ${r.kind}`);
  }

  // 反向：真正该判成凭据问题的仍要判对（别为了修误报把功能修没了）
  const stillCredential = [
    'Forbidden',
    'Forbidden.RAM',
    'Forbidden: no permission to perform this action',
    'Forbidden.RAM: User not authorized to operate on the specified resource',
    'Access denied',
    'RAM: User not authorized',
  ];
  for (const raw of stillCredential) {
    const r = credErr.classifyError(new Error(raw));
    check(`仍能识别为凭据问题：${raw.slice(0, 40)}`,
      r.kind === credErr.ERR_CREDENTIAL, `实际 ${r.kind}`);
  }
}

console.log('--- 2c. 阿里云真实报错 Code 覆盖度 ---');
{
  // 用阿里云官方文档里各接口真实会返回的 Code 核对，防止「正则只认自己造的例子」。
  const realCodes = [
    ['InvalidAccessKeyId.NotFound', true],
    ['InvalidAccessKeyId', true],
    ['SignatureDoesNotMatch', true],
    ['InvalidAccessKeySecret', true],
    ['InvalidAccessKeySecret.Malformed', true],
    ['Forbidden.RAM', true],
    ['Forbidden', true],
    ['InvalidSecurityToken.Expired', true],
    ['InvalidSecurityToken.Malformed', true],
    ['Throttling', false],
    ['Throttling.User', false],
    ['ServiceUnavailable', false],
    ['InternalError', false],
    ['InvalidInstanceId.NotFound', false],
    ['InvalidRegionId', false],
  ];
  for (const [code, wantCred] of realCodes) {
    const r = credErr.classifyError(new Error(`${code} 失败：${code}`));
    const isCred = r.kind === credErr.ERR_CREDENTIAL;
    check(`报错码分类正确：${code}（${wantCred ? '应为凭据类' : '不应为凭据类'}）`,
      isCred === wantCred, `实际 ${r.kind}`);
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

  // 手动把冷却标记往前拨 25 小时 —— 按**新设计**这还不够，
  // 因为冷却期已从 24 小时拉长到 7 天（用户反馈「别一直报」）。
  // ⚠️ 注意键名：告警标记写在 `${key}:cred_failed` 这一层
  //    （因为 eventKey 就是 `${key}:cred_failed`），别写到 `${key}` 上。
  const key = user.instance_id;
  state[`${key}:cred_failed`] = { cred_failed: common.nowSeconds() - 90000 };
  await common.saveState(env, state);
  const before = calls.sendMessage.length;
  await guard.checkOne(env, user, config, state, () => {});
  check('过了 24 小时【不再】重复打扰（冷却已改为 7 天）',
    calls.sendMessage.length === before, `前 ${before} 后 ${calls.sendMessage.length}`);

  // 把标记拨到 8 天前，才应该再发一条（真的是「隔很久才提醒一次」）
  state[`${key}:cred_failed`] = { cred_failed: common.nowSeconds() - 8 * 86400 };
  await common.saveState(env, state);
  const before2 = calls.sendMessage.length;
  await guard.checkOne(env, user, config, state, () => {});
  check('过了 7 天会再提醒一次',
    calls.sendMessage.length > before2, `前 ${before2} 后 ${calls.sendMessage.length}`);
}

console.log('--- 5b. 🔴 凭据失效告警必须带「删除这台机器」按钮 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const calls = installFakeFetch(async () => aliyunError(
    'InvalidAccessKeyId.NotFound', 'not exist'
  ));
  const config = baseConfig();
  const state = {};
  const user = config.users[0];
  await guard.checkOne(env, user, config, state, () => {});

  check('发出了告警', calls.sendMessage.length >= 1, `实际 ${calls.sendMessage.length}`);
  const msg = calls.sendMessage[0] || {};
  const keyboard = msg.reply_markup && msg.reply_markup.inline_keyboard;
  check('告警带了内联按钮', Array.isArray(keyboard), `实际 ${typeof keyboard}`);

  const flat = (keyboard || []).flat();
  const delBtn = flat.find((b) => String(b.callback_data || '').startsWith('del:'));
  check('有「删除这台机器」按钮', Boolean(delBtn),
    `实际 ${JSON.stringify(flat.map((b) => b.callback_data))}`);
  check('按钮精确指向这台机器',
    Boolean(delBtn) && delBtn.callback_data === `del:${user.instance_id}`,
    `实际 ${delBtn && delBtn.callback_data}`);

  const addBtn = flat.find((b) => b.callback_data === 'addacct');
  check('同时给了「添加账号」的出口', Boolean(addBtn),
    `实际 ${JSON.stringify(flat.map((b) => b.callback_data))}`);

  // 文案要让用户明白「机器已经删了 / 不用了」该怎么办 ——
  // 这正是用户提这个需求时最在意的一句。
  const text = String(msg.text || '');
  check('文案告诉用户「已删除 / 不用了」可以删掉它',
    text.includes('已经不用') || text.includes('删掉') || text.includes('删除'),
    text.slice(0, 200));
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
    // 第一个账号的 AK 是 LTAI5tFakeKeyExample...，坏；第二个是 LTAI5tOther...，好
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

console.log('--- 10. 配置与代码一致性：定时凭据体检有没有被「静默关掉」 ---');
{
  // 这个检查是补一个真实踩过的坑：
  //   wrangler.toml 里配 cron 是 `0 2 * * *`，
  //   但 index.js 分流判断写成了 `cron === '0 10 * * *'`。
  //   两边对不上 → 定时体检**永远不会触发**，而且不报错、不崩溃、日志正常。
  //   这类「配置值与代码常量对不上」的静默失效，只有横向对比才能发现，
  //   所以在这里钉死。
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');

  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const root = path.dirname(here);

  const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

  // 取 wrangler.toml 里的 crons 数组
  const m = toml.match(/crons\s*=\s*\[([^\]]*)\]/);
  const crons = m
    ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : [];

  check('wrangler.toml 里配了 3 个定时任务', crons.length === 3,
    JSON.stringify(crons));
  check('其中包含每 5 分钟的巡检', crons.includes('*/5 * * * *'),
    JSON.stringify(crons));

  // 找出 index.js 里 isCredCheck 用的那个表达式
  const cm = src.match(/isCredCheck\s*=\s*cron\s*===\s*['"]([^'"]+)['"]/);
  const codeCron = cm ? cm[1] : '';

  check('index.js 里能读到凭据体检的 cron 判断', Boolean(codeCron), codeCron);
  check('🔴 凭据体检的 cron 值在「配置」与「代码」里完全一致',
    Boolean(codeCron) && crons.includes(codeCron),
    `代码=${codeCron} 配置=${JSON.stringify(crons)} —— 不一致则定时体检永远不触发`);

  // 顺带核一下巡检那个值（同一个坑的另一个面）
  const im = src.match(/isInspection\s*=\s*cron\s*===\s*['\"][^'\"]*['\"]\s*\|\|\s*cron\s*===\s*['\"]([^'\"]+)['\"]/);
  const inspCron = im ? im[1] : '';
  check('🔴 巡检的 cron 值在「配置」与「代码」里完全一致',
    Boolean(inspCron) && crons.includes(inspCron),
    `代码=${inspCron} 配置=${JSON.stringify(crons)}`);

  // 日报走的是「其余触发器」兜底分支，只要不是前两个就行，不用单独判值
  check('凭据体检与巡检用的是两个不同的表达式（不会互相顶掉）',
    Boolean(codeCron) && Boolean(inspCron) && codeCron !== inspCron,
    `体检=${codeCron} 巡检=${inspCron}`);
}

console.log('');
console.log('==========================================');
console.log(`凭据失效处理自检: 通过 ${pass} / 失败 ${fail}`);
console.log('==========================================');
process.exit(fail === 0 ? 0 : 1);
