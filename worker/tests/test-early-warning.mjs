/**
 * 预警与确认自检（不联网）
 * ===========================================================================
 *   1. 流量突增预警：按最近增长速度推算滞后时间内会不会冲过额度
 *   2. 关机确认：下发关机后下一轮仍在运行 → 「关机未生效」告警
 *   3. 巡检心跳：日报里报过去 24 小时巡检次数；可选 HEARTBEAT_URL 外部上报
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
    S.telegram.push(body);
    payload = { ok: true, result: { message_id: 1 } };
  } else if (u.startsWith('https://hc.example')) {
    S.pings += 1;
    if (S.pingFails) throw new Error('network down');
    payload = {};
  } else {
    S.actions.push(action);
    if (action === 'ListCdtInternetTraffic') payload = { TrafficDetails: [{ Traffic: S.gb * GB }] };
    else if (action.startsWith('DescribeInstance')) {
      payload = { TotalCount: 1, Instances: { Instance: [{ InstanceId: 'i-a', Status: S.status }] } };
    }
  }
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};
const fresh = (o = {}) => ({ actions: [], telegram: [], pings: 0, gb: 10, status: 'Running', ...o });
const user = { name: 'm', instance_id: 'i-a', region: 'ap-northeast-2', ak: 'LTAI-FAKE', sk: 'X', traffic_limit: 180 };
async function newEnv(extra = {}) {
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T', ...extra };
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [user] });
  return env;
}
const run = async (env) => {
  const log = console.log; console.log = () => {};
  try { return await withRequestContext(() => guard.runInspection(env, { force: true })); }
  finally { console.log = log; }
};
const sent = (word) => S.telegram.filter((t) => t.includes(word)).length;
const now = () => Math.floor(Date.now() / 1000);

console.log('--- 1. 流量突增预警 ---');
{
  // 3 小时前 100GB，现在 130GB → 10GB/小时，6 小时后约 190GB > 阈值 180
  S = fresh({ gb: 130 });
  const env = await newEnv();
  await common.saveState(env, { 'i-a:samples': [[now() - 3 * 3600, 100]] });
  await run(env);
  check('增长 10GB/小时：发出「流量突增预警」', sent('流量突增预警') === 1);
  check('预警不自动关机', !S.actions.includes('StopInstance'));
  await run(env);
  check('3 小时内不重复预警', sent('流量突增预警') === 1);
}
{
  // 3 小时前 100GB，现在 101GB → 0.3GB/小时，远到不了额度
  S = fresh({ gb: 101 });
  const env = await newEnv();
  await common.saveState(env, { 'i-a:samples': [[now() - 3 * 3600, 100]] });
  await run(env);
  check('缓慢增长：不预警', sent('流量突增预警') === 0);
}
{
  // 采样不到 2 小时，不下结论
  S = fresh({ gb: 150 });
  const env = await newEnv();
  await common.saveState(env, { 'i-a:samples': [[now() - 1800, 100]] });
  await run(env);
  check('采样跨度不足 2 小时：不预警（数据不够）', sent('流量突增预警') === 0);
}
{
  // 月初流量重置：新数字比旧样本小，样本要清空重来
  const state = { 'i-a:samples': [[now() - 3 * 3600, 150], [now() - 3600, 170]] };
  const r = guard.trackTrafficRate(state, 'i-a', 2);
  check('跨月流量回落：样本清空，不算出负增长', r === null && state['i-a:samples'].length === 1,
    JSON.stringify(state['i-a:samples']));
}
{
  const state = {};
  const t0 = now();
  for (let i = 0; i < 12; i += 1) guard.trackTrafficRate(state, 'i-a', i, t0 + i * 300);
  check('5 分钟一轮，30 分钟内只记一个点', state['i-a:samples'].length === 2,
    JSON.stringify(state['i-a:samples']));
  guard.trackTrafficRate(state, 'i-a', 50, t0 + 8 * 3600);
  check('超过 6 小时的旧样本被丢掉', state['i-a:samples'].every(([ts]) => t0 + 8 * 3600 - ts <= 6 * 3600));
}

console.log('--- 2. 关机后确认真的停了 ---');
{
  S = fresh({ gb: 190, status: 'Running' });
  const env = await newEnv();
  await run(env);
  check('第 1 轮超标：下发关机', S.actions.filter((a) => a === 'StopInstance').length === 1);
  check('第 1 轮：通知写明「下一轮确认」', sent('下一轮巡检会确认') === 1);
  check('第 1 轮：不报「关机未生效」', sent('关机未生效') === 0);
  let state = await common.loadState(env);
  check('记下了关机下发时间', Number(state['i-a']?.stop_sent_at) > 0);

  await run(env); // 仍然 Running
  check('第 2 轮仍在运行：发出「关机未生效」', sent('关机未生效') === 1);
  check('第 2 轮：再次下发关机', S.actions.filter((a) => a === 'StopInstance').length === 2);
  await run(env);
  check('「关机未生效」1 小时内不刷屏', sent('关机未生效') === 1);

  S.status = 'Stopped';
  await run(env);
  state = await common.loadState(env);
  check('停下来后清掉下发记录', !state['i-a']?.stop_sent_at);
}
{
  S = fresh({ gb: 190, status: 'Running' });
  const env = await newEnv();
  await run(env);
  S.status = 'Stopped';
  await run(env);
  check('下一轮已停止：不报「关机未生效」', sent('关机未生效') === 0);
}

console.log('--- 3. 巡检心跳 ---');
{
  S = fresh();
  const env = await newEnv();
  for (let i = 0; i < 3; i += 1) await run(env);
  const state = await common.loadState(env);
  const sum = guard.heartbeatSummary(state);
  check('3 轮巡检被计数', sum.count === 3, JSON.stringify(state.run_hours));
  check('刚开始统计：按已统计时长折算，不误报偏少', sum.ok && sum.text.includes('统计开始'), sum.text);
  const long = guard.heartbeatSummary({ ...state, heartbeat_since: now() - 2 * 86400 });
  check('统计满 24 小时后次数偏少：给出警告', !long.ok && long.text.includes('偏少'), long.text);
  check('没配 HEARTBEAT_URL 时不对外请求', S.pings === 0);
}
{
  const nowL = common.nowLocal();
  const hours = {};
  for (let i = 0; i < 24; i += 1) hours[guard.hourBucket(new Date(nowL.getTime() - i * 3600e3))] = 12;
  hours['2000-01-01T00'] = 999; // 很久以前的不算
  const sum = guard.heartbeatSummary({ run_hours: hours }, nowL);
  check('满 24 小时每小时 12 次：显示正常', sum.ok && sum.count === 288, sum.text);
  const state = { run_hours: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`2026-01-01T${String(i).padStart(2, '0')}`, 1])) };
  guard.recordHeartbeat(state);
  check('只保留最近 26 个小时桶', Object.keys(state.run_hours).length === 26);
}
{
  S = fresh();
  const env = await newEnv({ HEARTBEAT_URL: 'https://hc.example/ping/abc' });
  await run(env);
  check('配置了 HEARTBEAT_URL：每轮成功后上报一次', S.pings === 1);
  S.pingFails = true;
  const r = await run(env);
  check('上报失败不影响巡检结果', r.ok === true && r.checked === 1, JSON.stringify(r));
}
{
  S = fresh();
  const env = await newEnv({ HEARTBEAT_URL: 'http://insecure.example' });
  await run(env);
  check('非 https 地址不上报', S.pings === 0);
}

globalThis.fetch = realFetch;
console.log(`\n预警与确认自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
