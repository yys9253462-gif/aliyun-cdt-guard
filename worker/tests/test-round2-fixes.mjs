/**
 * 第二轮排查修复自检（不联网）
 * ===========================================================================
 *   1. 实例在阿里云找不到 → 推送一次「找不到实例」，带删除按钮
 *   2. 账单查询失败显示「查询失败」而不是 0；账号合计不当成单机账单、不触发单机警戒线
 *   3. 删除机器 / 全部关机先确认
 *   4. 关机遇到网络抖动立即重试一次
 *   5. Throttling.Api 等限流码按临时错误重试
 *   6. deploy.sh 自检把密钥放在请求头里
 */
import fs from 'node:fs';
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import * as api from '../src/aliyun-api.js';
import * as bot from '../src/bot-listener.js';
import { withRequestContext } from '../src/request-context.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${extra}`); }
}

class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key, type) {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') { try { return JSON.parse(raw); } catch (e) { return null; } }
    return raw;
  }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
}

const GB = 1024 ** 3;
let S;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  let body = String(init.body || '');
  try { body = decodeURIComponent(body); } catch (_) { /* Telegram JSON */ }
  const action = (body.match(/(?:^|&)Action=([^&]+)/) || [])[1] || '';
  let payload = { RequestId: 'x' };
  if (u.includes('api.telegram.org')) {
    S.tg.push(body);
    payload = { ok: true, result: { message_id: 1 } };
  } else {
    S.actions.push(action);
    const scripted = S.script[action] && S.script[action].shift();
    if (scripted === 'network') throw new Error('fetch failed');
    if (scripted) payload = scripted;
    else if (action === 'ListCdtInternetTraffic') payload = { TrafficDetails: [{ Traffic: S.gb * GB }] };
    else if (action === 'DescribeInstances') {
      payload = S.notFound
        ? { TotalCount: 0, Instances: { Instance: [] } }
        : { TotalCount: 1, Instances: { Instance: [{ InstanceId: 'i-a', Status: S.status }] } };
    }
  }
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};
const fresh = (o = {}) => ({ actions: [], tg: [], script: {}, gb: 10, status: 'Running', ...o });
const baseUser = { name: 'm', instance_id: 'i-a', region: 'ap-northeast-2', ak: 'LTAI-FAKE', sk: 'X', traffic_limit: 180 };
async function newEnv(user = {}, users = null) {
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  const config = { telegram: { chat_id: '1' }, users: users || [{ ...baseUser, ...user }] };
  await common.saveConfig(env, config);
  return { env, config };
}
const quiet = async (fn) => {
  const log = console.log; console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const run = (env) => quiet(() => withRequestContext(() => guard.runInspection(env, { force: true })));
const said = (word) => S.tg.filter((t) => t.includes(word)).length;
const ctx = (fn) => quiet(() => withRequestContext(fn));

console.log('--- 1. 找不到实例要提醒 ---');
{
  S = fresh({ notFound: true });
  const { env } = await newEnv();
  await run(env);
  check('推送「找不到实例」', said('找不到实例') === 1);
  check('提醒里带删除按钮', S.tg.some((t) => t.includes('找不到实例') && t.includes('del:i-a')));
  await run(env);
  check('7 天内不重复推送', said('找不到实例') === 1);
  S.notFound = false;
  await run(env);
  const state = await common.loadState(env);
  check('实例重新找到后清掉记录', !state['i-a:not_found']);
}

console.log('--- 2. 账单 ---');
{
  S = fresh({ script: {
    DescribeInstanceBill: [{ Success: false, Code: 'Forbidden.RAM' }],
    QueryBillOverview: [{ Success: false, Code: 'Forbidden.RAM' }],
  } });
  const r = await ctx(() => api.getInstanceBill('A', 'B', 'ap-northeast-2', 'i-a'));
  check('两个接口都失败：返回 -1（显示「查询失败」），不再是 0', r.amount === -1, JSON.stringify(r));
}
{
  S = fresh({ script: {
    DescribeInstanceBill: [{ Success: false, Code: 'Forbidden.RAM' }],
    QueryBillOverview: [{ Success: true, Data: { Items: { Item: [{ PretaxAmount: 50, Currency: 'USD' }] } } }],
  } });
  const r = await ctx(() => api.getInstanceBill('A', 'B', 'ap-northeast-2', 'i-a'));
  check('回退到账号账单：标记为账号合计', r.amount === 50 && r.scope === 'account', JSON.stringify(r));
}
{
  S = fresh({ script: {
    DescribeInstanceBill: [{ Success: true, Data: { Items: [{ PretaxAmount: 3, Currency: 'USD' }] } }],
  } });
  const r = await ctx(() => api.getInstanceBill('A', 'B', 'ap-northeast-2', 'i-a'));
  check('单机账单正常：标记为单机', r.amount === 3 && r.scope === 'instance', JSON.stringify(r));
}
{
  // 警戒线 10，账号合计 50（含其他产品）→ 不应按「这台机器超支」告警
  S = fresh({ script: {
    DescribeInstanceBill: [{ Success: false }],
    QueryBillOverview: [{ Success: true, Data: { Items: { Item: [{ PretaxAmount: 50, Currency: 'USD' }] } } }],
  } });
  const { env } = await newEnv({ bill_limit: 10 });
  await run(env);
  check('账号合计超过单机警戒线：不误报「本月账单超支」', said('本月账单超支') === 0);
}
{
  S = fresh({ script: { DescribeInstanceBill: [{ Success: true, Data: { Items: [{ PretaxAmount: 30, Currency: 'USD' }] } }] } });
  const { env } = await newEnv({ bill_limit: 10 });
  await run(env);
  check('单机账单真的超支：照常告警', said('本月账单超支') === 1);
}

console.log('--- 3. 删除 / 全部关机先确认 ---');
{
  S = fresh();
  const { env, config } = await newEnv({}, [{ ...baseUser }, { ...baseUser, name: 'n', instance_id: 'i-b' }]);
  await ctx(() => bot.handlePlainText(env, config, 'T', '1', '🛑 全部关机'));
  check('点「全部关机」：先弹确认，不下发关机', !S.actions.includes('StopInstance') && said('确认全部关机') === 1);
  check('确认里写明台数', said('全部 2 台') === 1);
  await ctx(() => bot.handleCallback(env, config, 'T', { id: 'c', data: 'cancelop', from: { id: 1 }, message: { chat: { id: 1 } } }));
  check('点「取消」：什么都不做', !S.actions.includes('StopInstance') && said('已取消') >= 1);
  await ctx(() => bot.handleCallback(env, config, 'T', { id: 'c', data: 'stopallok', from: { id: 1 }, message: { chat: { id: 1 } } }));
  check('点「确认全部关机」：两台都下发关机', S.actions.filter((a) => a === 'StopInstance').length === 2);
}
{
  S = fresh();
  const { env, config } = await newEnv();
  await common.setCurrentDevice(env, '1', 'i-a');
  await ctx(() => bot.handlePlainText(env, config, 'T', '1', '🗑 删除机器'));
  let saved = await common.loadConfig(env);
  check('单机菜单点「删除机器」：先弹确认，不直接删', saved.users.length === 1 && said('确认删除') === 1,
    S.tg.slice(-1)[0]?.slice(0, 120));
  await ctx(() => bot.handleCallback(env, saved, 'T', { id: 'c', data: 'delok:i-a', from: { id: 1 }, message: { chat: { id: 1 } } }));
  saved = await common.loadConfig(env);
  check('点「确认删除」：真的删掉', saved.users.length === 0);
}
{
  S = fresh();
  const { env, config } = await newEnv();
  await ctx(() => bot.handleCallback(env, config, 'T', { id: 'c', data: 'delok:i-a', from: { id: 999 }, message: { chat: { id: 1 } } }));
  const saved = await common.loadConfig(env);
  check('别人点「确认删除」：无效', saved.users.length === 1);
}

console.log('--- 4. 关机遇到网络抖动立即重试 ---');
{
  S = fresh({ script: { StopInstance: ['network'] } });
  await ctx(() => api.stopInstance('A', 'B', 'ap-northeast-2', 'i-a'));
  check('第一次网络失败，第二次成功', S.actions.filter((a) => a === 'StopInstance').length === 2);
}
{
  S = fresh({ script: { StopInstance: [{ Code: 'IncorrectInstanceStatus', Message: 'x' }] } });
  let err = null;
  try { await ctx(() => api.stopInstance('A', 'B', 'ap-northeast-2', 'i-a')); } catch (e) { err = e; }
  check('业务错误（状态不对）不重试，直接报错', err && S.actions.filter((a) => a === 'StopInstance').length === 1);
}

console.log('--- 5. 更多限流码按临时错误处理 ---');
for (const code of ['Throttling.Api', 'Throttling.Resource', 'ServiceUnavailable.Temp', 'Throttling']) {
  check(`${code} 视为临时错误`, api.isTransient({ Code: code }, 200) === true);
}
check('普通业务错误不算临时', api.isTransient({ Code: 'InvalidInstanceId.NotFound' }, 200) === false);

console.log('--- 6. 自检不把密钥放进网址 ---');
{
  const sh = fs.readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  check('deploy.sh 用请求头 X-CDT-Key 传密钥', sh.includes('-H "X-CDT-Key: ${secret}"'));
  check('deploy.sh 不再拼 /setup?key=${secret}', !sh.includes('/setup?key=${secret}'));
}

globalThis.fetch = realFetch;
console.log(`\n第二轮修复自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
