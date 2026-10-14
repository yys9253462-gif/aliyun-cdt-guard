/**
 * 「该关没关」三个缺口自检（不联网）
 * ===========================================================================
 *   1. 流量超标时实例处于中间态（Starting / Pending）—— 原来被当成「已停止」跳过。
 *   2. 整轮巡检失败（读不到配置/状态）—— 原来只写日志，没人知道止损已经停了。
 *   3. 暂停监控的机器流量超标 —— 原来完全不查，暂停后忘了恢复就一直花钱。
 */
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import { withRequestContext } from '../src/request-context.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${extra}`); }
}

class FakeKV {
  constructor() { this.store = new Map(); this.failGet = null; }
  async get(key, type) {
    if (this.failGet && this.failGet(key)) throw new Error(`KV get ${key} failed`);
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
  try { body = decodeURIComponent(body); } catch (_) { /* Telegram 发的是 JSON，可能含 % */ }
  const action = (body.match(/(?:^|&)Action=([^&]+)/) || [])[1] || '';
  let payload = { RequestId: 'x' };
  if (u.includes('api.telegram.org')) {
    S.telegram.push(body + String(init.body || ''));
    payload = { ok: true, result: { message_id: 1 } };
  } else {
    S.actions.push(action);
    if (action === 'ListCdtInternetTraffic') {
      payload = { TrafficDetails: [{ Traffic: S.gb * GB }] };
    } else if (action.startsWith('DescribeInstance')) {
      payload = { TotalCount: 1, Instances: { Instance: [{ InstanceId: 'i-a', Status: S.status }] } };
    } else if (action === 'StopInstance' && S.stopRejects) {
      payload = { Code: 'IncorrectInstanceStatus', Message: 'The current status of the resource does not support this operation.' };
    }
  }
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};

const user = (extra = {}) => ({
  name: 'm', instance_id: 'i-a', region: 'ap-northeast-2',
  ak: 'LTAI-FAKE-TEST', sk: 'FAKE', traffic_limit: 180, ...extra,
});
async function newEnv(users) {
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users });
  return env;
}
// 每轮都放进独立的请求上下文里跑，和线上一致（缓存、预算不跨轮）
const run = (env) => withRequestContext(() => guard.runInspection(env, { force: true }));
const quiet = async (fn) => {
  const log = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), lines }; } finally { console.log = log; }
};

console.log('--- 1. 超标时实例处于中间态，也要下发关机 ---');
for (const status of ['Starting', 'Pending']) {
  S = { actions: [], telegram: [], gb: 190, status };
  const env = await newEnv([user()]);
  await quiet(() => run(env));
  check(`${status}：下发了 StopInstance`, S.actions.includes('StopInstance'), S.actions.join(','));
}
{
  S = { actions: [], telegram: [], gb: 190, status: 'Starting', stopRejects: true };
  const env = await newEnv([user()]);
  const { result, lines } = await quiet(() => run(env));
  check('中间态被阿里云拒绝：巡检不崩', result.ok === true, JSON.stringify(result));
  check('中间态被拒绝：不发「止损关机失败」告警（下一轮会重试）',
    !S.telegram.some((t) => t.includes('止损关机失败')));
  check('中间态被拒绝：日志写明下一轮重试', lines.some((l) => l.includes('下一轮重试')));
}
{
  S = { actions: [], telegram: [], gb: 190, status: 'Stopping' };
  const env = await newEnv([user()]);
  await quiet(() => run(env));
  check('Stopping：不重复下发关机', !S.actions.includes('StopInstance'));
}
{
  S = { actions: [], telegram: [], gb: 190, status: 'Running' };
  const env = await newEnv([user()]);
  await quiet(() => run(env));
  check('Running（原有路径）：仍然下发关机', S.actions.includes('StopInstance'));
}
{
  S = { actions: [], telegram: [], gb: 50, status: 'Starting' };
  const env = await newEnv([user()]);
  await quiet(() => run(env));
  check('流量安全 + 中间态：不关机', !S.actions.includes('StopInstance'));
}

console.log('--- 2. 整轮巡检连续失败要告警 ---');
{
  S = { actions: [], telegram: [], gb: 10, status: 'Running' };
  const env = await newEnv([user()]);
  env.CDT_GUARD_KV.failGet = (key) => key === 'state';
  for (let i = 1; i <= 2; i += 1) {
    const { result } = await quiet(() => run(env));
    check(`第 ${i} 轮失败：返回 ok:false`, result.ok === false, JSON.stringify(result));
  }
  check('连续 2 轮：还不告警（避免偶发抖动刷屏）',
    !S.telegram.some((t) => t.includes('巡检整体失败')));
  await quiet(() => run(env));
  check('连续 3 轮：发出「巡检整体失败」告警',
    S.telegram.filter((t) => t.includes('巡检整体失败')).length === 1);
  await quiet(() => run(env));
  check('1 小时内不重复告警',
    S.telegram.filter((t) => t.includes('巡检整体失败')).length === 1);
  const health = JSON.parse(env.CDT_GUARD_KV.store.get(guard.INSPECTION_HEALTH_KEY));
  check('失败次数被记下', health.failures === 4, JSON.stringify(health));

  env.CDT_GUARD_KV.failGet = null;
  const { result } = await quiet(() => run(env));
  check('恢复后巡检成功', result.ok === true && result.checked === 1, JSON.stringify(result));
  check('恢复后失败计数清零', !env.CDT_GUARD_KV.store.has(guard.INSPECTION_HEALTH_KEY));
}
{
  S = { actions: [], telegram: [], gb: 10, status: 'Running' };
  const env = await newEnv([user()]);
  env.CDT_GUARD_KV.failGet = (key) => key === 'config' || key === 'state';
  for (let i = 0; i < 3; i += 1) await quiet(() => run(env));
  const health = JSON.parse(env.CDT_GUARD_KV.store.get(guard.INSPECTION_HEALTH_KEY) || '{}');
  check('连配置都读不到时：不崩，失败次数照样累计', health.failures === 3, JSON.stringify(health));
}

console.log('--- 3. 暂停监控的机器超标要提醒（但不关机）---');
{
  S = { actions: [], telegram: [], gb: 190, status: 'Running' };
  const env = await newEnv([user({ paused: true })]);
  await quiet(() => run(env));
  check('发出「已暂停的机器流量超标」提醒',
    S.telegram.filter((t) => t.includes('已暂停的机器流量超标')).length === 1);
  check('暂停的机器不被关机', !S.actions.includes('StopInstance'));
  await quiet(() => run(env));
  check('一天内不重复提醒',
    S.telegram.filter((t) => t.includes('已暂停的机器流量超标')).length === 1);
}
{
  S = { actions: [], telegram: [], gb: 50, status: 'Running' };
  const env = await newEnv([user({ paused: true })]);
  await quiet(() => run(env));
  check('暂停 + 流量安全：不提醒', S.telegram.length === 0);
}

globalThis.fetch = realFetch;
console.log(`\n「该关没关」缺口自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
