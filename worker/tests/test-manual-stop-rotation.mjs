/**
 * 手动关机不被自动开回 + 巡检轮转自检（不联网）
 * ===========================================================================
 * 钉死两个曾经的 bug：
 *   1. 在机器人里点「关机 / 全部关机」后，下一轮巡检看到「流量安全 + 已停止」
 *      就会自动开机 —— 你刚关的机器 5 分钟内又被开回来。
 *   2. 子请求预算不够查完所有机器时，每轮都从第 1 台查起，
 *      排在后面的机器永远查不到，也就永远不会被止损。
 */
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import * as api from '../src/aliyun-api.js';
import { doStop, doStart, doBatchPower } from '../src/bot-listener.js';

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

// 假阿里云：按 Action 分别应答，并记下每次请求的 Action 与涉及的实例
let instanceStatus = 'Stopped';
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const body = decodeURIComponent(String(init.body || ''));
  const action = (body.match(/(?:^|&)Action=([^&]+)/) || [])[1] || '';
  const ids = body.match(/i-[a-z0-9]+/g) || [];
  calls.push({ url: String(url), action, ids });
  let payload = { RequestId: 'x' };
  if (action === 'ListCdtInternetTraffic') {
    payload = { RequestId: 'x', TrafficDetails: [] };
  } else if (action.startsWith('DescribeInstance')) {
    payload = {
      RequestId: 'x', TotalCount: 1,
      Instances: { Instance: [{ InstanceId: ids[0], Status: instanceStatus }] },
      InstanceStatuses: { InstanceStatus: [{ InstanceId: ids[0], Status: instanceStatus }] },
    };
  } else if (String(url).includes('telegram')) {
    payload = { ok: true, result: {} };
  }
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};

function makeUser(i, ak = 'LTAI-FAKE-0000-TEST-ONLY') {
  return {
    name: `机器${i}`, instance_id: `i-r${i}`, region: 'cn-hongkong',
    ak, sk: 'FAKE-SECRET-FOR-TEST-ONLY', traffic_limit: 180,
  };
}

// ---------------------------------------------------------------------------
console.log('--- 1. 手动关机后，巡检不再自动开机 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const config = { telegram: { chat_id: '1', admin_ids: ['1'] }, users: [makeUser(1)] };
  await common.saveConfig(env, config);

  instanceStatus = 'Running';
  const reply = await doStop(config, 'i-r1', env);
  check('关机指令已下发', reply.includes('已向'), reply);
  const saved = await common.loadConfig(env);
  check('手动关机记号已写入配置', saved.users[0].manual_stopped === true);

  instanceStatus = 'Stopped';
  calls = [];
  const summary = await guard.runInspection(env, { force: true });
  check('巡检正常完成', summary.ok === true && summary.checked === 1, JSON.stringify(summary));
  check('巡检没有下发开机指令', !calls.some((c) => c.action === 'StartInstance'),
    calls.map((c) => c.action).join(','));

  const startReply = await doStart(saved, 'i-r1', env);
  check('手动开机成功下发', startReply.includes('已向'), startReply);
  const after = await common.loadConfig(env);
  check('手动开机后记号被清掉（恢复自动开机保护）', !after.users[0].manual_stopped);
}

console.log('--- 2. 全部关机 / 全部开机同样维护记号，且跳过暂停的机器 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const paused = { ...makeUser(3), paused: true };
  const config = { telegram: { chat_id: '1' }, users: [makeUser(2), paused] };
  await common.saveConfig(env, config);

  await doBatchPower(config, 'stop', env);
  let saved = await common.loadConfig(env);
  check('全部关机：普通机器打上记号', saved.users[0].manual_stopped === true);
  check('全部关机：暂停的机器不动', !saved.users[1].manual_stopped);

  await doBatchPower(saved, 'start', env);
  saved = await common.loadConfig(env);
  check('全部开机：记号被清掉', !saved.users[0].manual_stopped);
}

console.log('--- 4. 预算不够查完时，下一轮从没查到的机器开始 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const total = 30;
  // 每台不同 AK，避免账号级流量缓存让单台成本变低
  const users = [];
  for (let i = 0; i < total; i += 1) users.push(makeUser(i, `LTAI-FAKE-${i}-TEST-ONLY`));
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users });
  instanceStatus = 'Running';

  const seen = new Set();
  const statusIds = () => calls
    .filter((c) => c.action.startsWith('DescribeInstance'))
    .flatMap((c) => c.ids);

  // 每轮都模拟「全新的 Worker 实例」：定时任务常常落在新实例上，
  // 上一轮的内存缓存不会留下来帮忙，否则会掩盖「后面的机器永远查不到」。
  const freshIsolate = () => { api.clearTrafficCache?.(); api.clearBalanceCache?.(); };

  freshIsolate();
  calls = [];
  const r1 = await guard.runInspection(env, { force: true });
  check('第一轮因预算用完只查了部分', r1.partial === true && r1.checked < total,
    JSON.stringify(r1));
  statusIds().forEach((id) => seen.add(id));
  check('第一轮从第 1 台开始', statusIds()[0] === 'i-r0', statusIds()[0]);

  let rounds = 1;
  while (seen.size < total && rounds < 10) {
    freshIsolate();
    calls = [];
    await guard.runInspection(env, { force: true });
    statusIds().forEach((id) => seen.add(id));
    rounds += 1;
  }
  check(`若干轮之后所有 ${total} 台都被查到过（用了 ${rounds} 轮）`, seen.size === total,
    `只查到 ${seen.size} 台`);
  check('最后一台也被查到', seen.has(`i-r${total - 1}`));
}

console.log('--- 5. 能一轮查完时不留轮转起点 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [makeUser(1), makeUser(2)] });
  const r = await guard.runInspection(env, { force: true });
  const state = await common.loadState(env);
  check('两台都查完', r.checked === 2 && !r.partial, JSON.stringify(r));
  check('state 里没有残留轮转起点', state[guard.INSPECTION_CURSOR_KEY] === undefined);
}

globalThis.fetch = realFetch;
console.log(`\n手动关机与巡检轮转自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
