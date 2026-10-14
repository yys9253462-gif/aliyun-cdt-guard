/**
 * 额度池拆分自检（不联网）
 * ===========================================================================
 * 阿里云 CDT 免费额度分两个池：中国内地 20GB、非中国内地 200GB，各算各的。
 * 流量接口返回账号级明细，每条带 BusinessRegionId（2026-10 用真实账号核对过）。
 *
 * 钉死的问题：原来每台机器都拿「账号合计」和自己的阈值比，
 * 同账号里海外机器跑的流量会把内地机器误关，而且整个月都不会自动开回来。
 */
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import * as api from '../src/aliyun-api.js';
import { withRequestContext } from '../src/request-context.js';

let pass = 0, fail = 0;
const out = console.log.bind(console);
function check(name, cond, extra = '') {
  if (cond) { pass++; out(`  ✅ ${name}`); }
  else { fail++; out(`  ❌ ${name}  ${extra}`); }
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
  let body = String(init.body || '');
  try { body = decodeURIComponent(body); } catch (_) { /* json */ }
  if (String(url).includes('api.telegram.org')) {
    S.tg.push((body.match(/\*([^*]+)\*/) || [])[1] || '');
    const p = { ok: true, result: {} };
    return { ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) };
  }
  const action = (body.match(/(?:^|&)Action=([^&]+)/) || [])[1] || '';
  const iid = (body.match(/InstanceId=([^&]+)/) || [])[1] || (body.match(/"(i-[a-z0-9-]+)"/) || [])[1];
  let p = { RequestId: 'x' };
  if (action === 'ListCdtInternetTraffic') {
    p = { TrafficDetails: S.details.map(([region, gb]) => (region ? { BusinessRegionId: region, Traffic: gb * GB } : { Traffic: gb * GB })) };
  } else if (action === 'DescribeInstances') {
    p = { TotalCount: 1, Instances: { Instance: [{ InstanceId: iid, Status: (S.status && S.status[iid]) || 'Running' }] } };
  } else if (action === 'StopInstance') S.stopped.push(iid);
  else if (action === 'StartInstance') S.started.push(iid);
  const t = JSON.stringify(p);
  return { ok: true, status: 200, json: async () => p, text: async () => t };
};
const u = (id, region, limit, ak = 'LTAI-SAME-ACCOUNT') => ({ name: id, instance_id: id, region, ak, sk: 'S', traffic_limit: limit });
async function inspect(users, details, extra = {}) {
  S = { tg: [], stopped: [], started: [], details, ...extra };
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users });
  const log = console.log; console.log = () => {};
  try { await withRequestContext(() => guard.runInspection(env, { force: true })); } finally { console.log = log; }
  return env;
}

console.log('--- 1. 接口层：按地域归池 ---');
{
  S = { details: [['ap-northeast-2', 28.5], ['ap-northeast-1', 0], ['cn-hangzhou', 3], ['cn-hongkong', 10]] };
  const pools = await withRequestContext(() => api.getCdtTrafficPools('A', 'B'));
  check('合计 = 全部明细之和', Math.abs(pools.total - 41.5) < 1e-9, JSON.stringify(pools));
  check('香港算非内地池', Math.abs(pools.overseas - 38.5) < 1e-9, JSON.stringify(pools));
  check('杭州算内地池', Math.abs(pools.mainland - 3) < 1e-9, JSON.stringify(pools));
  const hz = await withRequestContext(() => api.getCdtTrafficGb('A', 'B', '', 'cn-hangzhou'));
  const jp = await withRequestContext(() => api.getCdtTrafficGb('A', 'B', '', 'ap-northeast-1'));
  const all = await withRequestContext(() => api.getCdtTrafficGb('A', 'B'));
  check('传内地地域 → 内地池用量', Math.abs(hz - 3) < 1e-9, hz);
  check('传海外地域 → 非内地池用量', Math.abs(jp - 38.5) < 1e-9, jp);
  check('不传地域 → 账号合计（兼容旧调用）', Math.abs(all - 41.5) < 1e-9, all);
}
{
  S = { details: [[null, 5], ['ap-northeast-2', 10]] };
  const pools = await withRequestContext(() => api.getCdtTrafficPools('A', 'B'));
  check('明细没带地域：两个池都算上（宁可早关，不可漏关）', pools.mainland === 5 && pools.overseas === 15, JSON.stringify(pools));
}
{
  S = { details: [['ap-northeast-2', 10]] };
  let calls = 0;
  const f = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls += 1; return f(...a); };
  await withRequestContext(async () => {
    await api.getCdtTrafficGb('A', 'B', '', 'cn-hangzhou');
    await api.getCdtTrafficGb('A', 'B', '', 'ap-northeast-2');
    await api.getCdtTrafficPools('A', 'B');
  });
  globalThis.fetch = f;
  check('同一账号一轮只查一次接口（按池取数走缓存）', calls === 1, `调用 ${calls} 次`);
}

console.log('--- 2. 巡检：内地机器不再被海外流量误关 ---');
{
  // 同账号：日本（阈值 180）跑了 30GB，杭州（阈值 18）跑了 1GB；合计 31 > 18
  await inspect([u('i-jp', 'ap-northeast-1', 180), u('i-hz', 'cn-hangzhou', 18)], [['ap-northeast-1', 30], ['cn-hangzhou', 1]]);
  check('杭州只用了 1GB：不关机', !S.stopped.includes('i-hz'), S.stopped.join(','));
  check('不误报「免费额度已用尽」', !S.tg.includes('免费额度已用尽'), S.tg.join(','));
}
{
  // 内地池真的超了：杭州 19GB > 18
  await inspect([u('i-jp', 'ap-northeast-1', 180), u('i-hz', 'cn-hangzhou', 18)], [['ap-northeast-1', 30], ['cn-hangzhou', 19]]);
  check('内地池真的超标：杭州关机，日本不动', S.stopped.join(',') === 'i-hz', S.stopped.join(','));
}
{
  // 杭州上个月被误关（Stopped），这个月内地池只用了 1GB → 应该自动开回来
  await inspect([u('i-jp', 'ap-northeast-1', 180), u('i-hz', 'cn-hangzhou', 18)], [['ap-northeast-1', 30], ['cn-hangzhou', 1]],
    { status: { 'i-hz': 'Stopped' } });
  check('内地池安全 + 杭州已停止：自动开机', S.started.includes('i-hz'), S.started.join(','));
}

console.log('--- 3. 同账号多台海外机：共用 200GB 池 ---');
{
  await inspect([u('i-jp', 'ap-northeast-1', 180), u('i-sg', 'ap-southeast-1', 180)], [['ap-northeast-1', 120], ['ap-southeast-1', 70]]);
  check('两台合计 190 > 180：两台都关', S.stopped.sort().join(',') === 'i-jp,i-sg', S.stopped.join(','));
  check('额度提醒按池只推一条（不按台重复）', S.tg.filter((t) => t === '免费额度即将用尽').length === 1, S.tg.join(','));
}
{
  await inspect([u('i-jp', 'ap-northeast-1', 180), u('i-sg', 'ap-southeast-1', 180)], [['ap-northeast-1', 100], ['ap-southeast-1', 50]]);
  check('合计 150 < 180：都不关', S.stopped.length === 0, S.stopped.join(','));
}

console.log('--- 4. 不同账号互不影响 ---');
{
  await inspect([u('i-a', 'ap-northeast-2', 180, 'LTAI-ACCOUNT-A'), u('i-b', 'ap-southeast-6', 180, 'LTAI-ACCOUNT-B')],
    [['ap-northeast-2', 190]]);
  check('两个账号查到同样的数时各自判断（各自超标各自关）', S.stopped.sort().join(',') === 'i-a,i-b', S.stopped.join(','));
  const k1 = guard.poolEventKey({ ak: 'LTAI-ACCOUNT-A' }, 'ap-northeast-2', 'x');
  const k2 = guard.poolEventKey({ ak: 'LTAI-ACCOUNT-B' }, 'ap-northeast-2', 'x');
  const k3 = guard.poolEventKey({ ak: 'LTAI-ACCOUNT-A' }, 'cn-hangzhou', 'x');
  check('不同账号的提醒键不同', k1 !== k2);
  check('同账号不同池的提醒键不同', k1 !== k3);
  check('提醒键里不含 AccessKey 原文', !k1.includes('LTAI'));
}

globalThis.fetch = realFetch;
console.log(`\n额度池拆分自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
