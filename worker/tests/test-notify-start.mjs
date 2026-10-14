/**
 * 通知准确性 + 开机不阻塞 + 边缘分流 + 财务查询频率 自检（不联网）
 * ===========================================================================
 *   1. 机器人自己关的机（超标止损 / 手动关机）不再推送「实例已停止，可能被意外停机」
 *   2. 流量一轮跳过 80% 和 95% 两档时只推一条
 *   3. 自动开机不原地等待，由下一轮巡检确认结果
 *   4. 健康检查与无关路径不进 Durable Object
 *   5. 余额 / 账单每小时最多查一次
 */
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import * as bot from '../src/bot-listener.js';
import worker from '../src/index.js';
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
    S.titles.push((body.match(/\*([^*]+)\*/) || [])[1] || '');
    payload = { ok: true, result: { message_id: 1 } };
  } else {
    S.actions.push(action);
    if (action === 'ListCdtInternetTraffic') payload = { TrafficDetails: [{ Traffic: S.gb * GB }] };
    else if (action.startsWith('DescribeInstance')) {
      payload = { TotalCount: 1, Instances: { Instance: [{ InstanceId: 'i-a', Status: S.status }] } };
    } else if (action === 'QueryAccountBalance') payload = { Data: { AvailableAmount: '100', Currency: 'USD' } };
  }
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};
const fresh = (o = {}) => ({ actions: [], titles: [], gb: 10, status: 'Running', ...o });
const baseUser = { name: 'm', instance_id: 'i-a', region: 'ap-northeast-2', ak: 'LTAI-FAKE', sk: 'X', traffic_limit: 180 };
async function newEnv(user = {}) {
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  const config = { telegram: { chat_id: '1' }, users: [{ ...baseUser, ...user }] };
  await common.saveConfig(env, config);
  return { env, config };
}
const quiet = async (fn) => {
  const log = console.log; console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const run = (env) => quiet(() => withRequestContext(() => guard.runInspection(env, { force: true })));
const count = (title) => S.titles.filter((t) => t === title).length;
const starts = () => S.actions.filter((a) => a === 'StartInstance').length;

console.log('--- 1. 机器人自己关的机，不报「意外停机」---');
{
  S = fresh();
  const { env } = await newEnv();
  await run(env);
  S.gb = 190; await run(env);
  S.status = 'Stopped'; await run(env);
  check('超标止损后停下：不推「实例已停止」', count('实例已停止') === 0, S.titles.join(','));
  check('超标止损通知照常推送', count('流量超标已止损') === 1);
}
{
  S = fresh();
  const { env, config } = await newEnv();
  await run(env);
  await quiet(() => withRequestContext(() => bot.doStop(config, 'i-a', env)));
  S.status = 'Stopped'; await run(env);
  check('在机器人里手动关机后：不推「实例已停止」', count('实例已停止') === 0, S.titles.join(','));
}
{
  S = fresh();
  const { env } = await newEnv();
  await run(env);
  S.status = 'Stopped'; await run(env);
  check('被阿里云意外停机：照常推「实例已停止」', count('实例已停止') === 1, S.titles.join(','));
}

console.log('--- 2. 一轮跳过两档额度提醒只推一条 ---');
{
  S = fresh({ gb: 10 });
  const { env } = await newEnv({ traffic_limit: 250 });
  await run(env);
  S.gb = 195; await run(env); // 200GB 额度的 97.5%
  check('从 5% 直接到 97.5%：只推一条额度提醒', count('免费额度即将用尽') === 1, S.titles.join(','));
  await run(env);
  check('之后不再补发 80% 那条', count('免费额度即将用尽') === 1, S.titles.join(','));
}
{
  S = fresh({ gb: 170 }); // 85%
  const { env } = await newEnv();
  await run(env);
  check('只到 85%：推 80% 档提醒', count('免费额度即将用尽') === 1);
  const state = await common.loadState(env);
  const poolKey = guard.poolEventKey({ ak: baseUser.ak }, baseUser.region, 'i-a');
  check('记的是 80% 档（按账号 + 额度池记）', Boolean(state[`${poolKey}:quota_80`]?.quota_80) && !state[`${poolKey}:quota_95`],
    Object.keys(state).join(','));
}

console.log('--- 3. 自动开机不原地等待，下一轮确认 ---');
{
  S = fresh({ status: 'Stopped' });
  const { env } = await newEnv();
  await run(env); // 记下状态
  const t0 = Date.now();
  await run(env);
  const ms = Date.now() - t0;
  check('流量安全 + 已停止：下发开机', starts() >= 1);
  check(`下发后不原地轮询等待（本轮耗时 ${ms}ms）`, ms < 3000);
  const state = await common.loadState(env);
  check('记下开机下发时间', Number(state['i-a']?.start_sent_at) > 0);
  check('本轮还不推「已恢复运行」', count('已恢复运行') === 0);

  S.status = 'Running';
  await run(env);
  check('下一轮已运行：推「已恢复运行」', count('已恢复运行') === 1, S.titles.join(','));
  const after = await common.loadState(env);
  check('确认后清掉下发记录', !after['i-a']?.start_sent_at);
}
{
  S = fresh({ status: 'Stopped' });
  const { env } = await newEnv();
  await run(env);
  const first = starts();
  await run(env); // 仍是 Stopped → 上一次没成功
  check('下一轮仍已停止：推「开机未成功」', count('开机未成功') === 1, S.titles.join(','));
  check('并再次下发开机', starts() === first + 1, `${first} -> ${starts()}`);
  await run(env);
  await run(env);
  const state = await common.loadState(env);
  check('连续 3 次没成功后进入 30 分钟冷却', Number(state['i-a']?.start_failures) === 3,
    JSON.stringify(state['i-a']));
  const before = starts();
  await run(env);
  check('冷却期内不再下发开机', starts() === before);
}
{
  S = fresh({ status: 'Stopped' });
  const { env } = await newEnv();
  await run(env);
  S.status = 'Starting';
  await run(env);
  check('下一轮还在 Starting：不算失败、不重复下发', count('开机未成功') === 0 && starts() === 1,
    `${S.titles.join(',')} starts=${starts()}`);
}
{
  S = fresh({ status: 'Stopped' });
  const { env } = await newEnv();
  await run(env);
  S.gb = 190;
  await run(env);
  const state = await common.loadState(env);
  check('开机后流量变成超标：清掉开机记录，不误报', !state['i-a']?.start_sent_at && count('开机未成功') === 0);
}

console.log('--- 4. 健康检查与无关路径不进 Durable Object ---');
{
  let doCalls = 0;
  const env = {
    CDT_GUARD_KV: new FakeKV(), WEBHOOK_SECRET: 's', TELEGRAM_BOT_TOKEN: 'T',
    CDT_COORDINATOR: {
      idFromName: () => 'id',
      get: () => ({ fetch: async () => { doCalls += 1; return new Response('do'); } }),
    },
  };
  const r1 = await worker.fetch(new Request('https://x/'), env, {});
  check('GET / 在边缘直接返回 200', r1.status === 200 && (await r1.text()).includes('正在运行'));
  const r2 = await worker.fetch(new Request('https://x/wp-login.php'), env, {});
  check('乱扫的路径在边缘直接 404', r2.status === 404);
  check('以上都没进 Durable Object', doCalls === 0, `doCalls=${doCalls}`);
  await worker.fetch(new Request('https://x/webhook/s', { method: 'POST', body: '{}' }), env, {});
  await worker.fetch(new Request('https://x/setup?key=s'), env, {});
  await worker.fetch(new Request('https://x/control/config'), env, {});
  check('Webhook / setup / control 仍然进 Durable Object', doCalls === 3, `doCalls=${doCalls}`);
}

console.log('--- 5. 余额 / 账单每小时最多查一次 ---');
{
  S = fresh();
  const { env } = await newEnv({ bill_limit: 5 });
  for (let i = 0; i < 4; i += 1) await run(env);
  const balance = S.actions.filter((a) => a === 'QueryAccountBalance').length;
  const bill = S.actions.filter((a) => /Bill/.test(a)).length;
  check(`4 轮巡检只查一次余额（实际 ${balance} 次请求）`, balance >= 1 && balance <= 2);
  check(`4 轮巡检只查一次账单（实际 ${bill} 次请求）`, bill >= 1 && bill <= 2);
  const state = await common.loadState(env);
  state['i-a'].money_checked_at -= 3601;
  await common.saveState(env, state);
  await run(env);
  check('过了 1 小时会再查', S.actions.filter((a) => a === 'QueryAccountBalance').length > balance);
}

globalThis.fetch = realFetch;
console.log(`\n通知与开机自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
