/**
 * 【独立验证】到流量阈值自动停机 —— 用线上真实配置参数做边界实测
 * 不联网：拦截全局 fetch，观察真实链路有没有下发 StopInstance。
 * 与现有 test-quota-limit.mjs 的区别：这里用**线上那台机器的真实参数**
 * （region=ap-southeast-6, traffic_limit=180）跑完整边界序列。
 */
import { parseTrafficLimit, checkOne } from '../src/guard.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  \u2705 ${n}`); }
  else { fail++; console.log(`  \u274C ${n}  ${e}`); }
};

// —— 线上真实参数（取自 KV config）——
const LIVE = {
  name: '菲律宾节点',
  instance_id: 'i-faketest0000stsujw0r',
  region: 'ap-southeast-6',
  ak: 'LTAIfake000000000000',
  sk: 'fake-secret',
  traffic_limit: 180,
};

function makeFetch(trafficGb, status) {
  return async (url, init) => {
    const params = new URLSearchParams(init?.body || '');
    const action = params.get('Action') || 'Unknown';
    makeFetch.calls.push(action);
    let payload;
    if (action === 'ListCdtInternetTraffic') {
      payload = { TrafficDetails: [{ Traffic: String(trafficGb * 1024 ** 3) }] };
    } else if (action === 'DescribeInstances') {
      payload = { Instances: { Instance: [{
        InstanceId: LIVE.instance_id, InstanceName: LIVE.name, Status: status,
        RegionId: LIVE.region, PublicIpAddress: { IpAddress: ['1.2.3.4'] },
      }] } };
    } else { payload = {}; }
    const body = JSON.stringify(payload);
    return { status: 200, ok: true, text: async () => body };
  };
}
makeFetch.calls = [];

const ENV = { CDT_GUARD_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const CONFIG = { chat_id: '1234567890', bot_token: 'fake-token' };
const orig = globalThis.fetch;

console.log('\n【A 组】线上真实阈值 180GB —— 跨阈边界逐点实测（运行中）');
{
  globalThis.fetch = makeFetch(0, 'Running');
  const cases = [
    ['0.71 GB（线上当前实测值）→ 不关机', 0.71, false],
    ['179.99 GB（阈值下沿内）→ 不关机', 179.99, false],
    ['180.00 GB（正好等于阈值）→ 必须关机', 180, true],
    ['180.01 GB（刚超一点）→ 必须关机', 180.01, true],
    ['400.00 GB（严重超标）→ 必须关机', 400, true],
  ];
  for (const [name, gb, shouldStop] of cases) {
    makeFetch.calls = [];
    globalThis.fetch = makeFetch(gb, 'Running');
    const logs = [];
    try {
      await checkOne(ENV, { ...LIVE }, CONFIG, {}, (m) => logs.push(m), []);
    } catch (e) { /* 忽略非关机类异常 */ }
    const stopped = makeFetch.calls.includes('StopInstance');
    check(name, stopped === shouldStop,
      `实际 StopInstance=${stopped}，期望 ${shouldStop}；调用序列=${JSON.stringify(makeFetch.calls)}`);
  }
}

console.log('\n【B 组】已经停止 + 流量超标 → 不得重复下发关机，只提醒');
{
  makeFetch.calls = [];
  globalThis.fetch = makeFetch(200, 'Stopped');
  try { await checkOne(ENV, { ...LIVE }, CONFIG, {}, () => {}, []); } catch (e) {}
  // 已 Stopped 时流量超标 → 走「保持关机」分支，不发 StopInstance
  check('已停止 + 超标 → 不发 StopInstance（避免无效指令）',
    !makeFetch.calls.includes('StopInstance'),
    `实际=${JSON.stringify(makeFetch.calls)}`);
  // 但也绝不能反过来去 StartInstance（那会立刻烧钱）
  check('已停止 + 超标 → 不得误开机 StartInstance',
    !makeFetch.calls.includes('StartInstance'),
    `实际=${JSON.stringify(makeFetch.calls)}`);
}

console.log('\n【C 组】流量回落但仍超标边缘 → 不得自动开机（防抖）');
{
  makeFetch.calls = [];
  globalThis.fetch = makeFetch(185, 'Stopped');
  try { await checkOne(ENV, { ...LIVE }, CONFIG, {}, () => {}, []); } catch (e) {}
  check('已停止 + 185GB（仍 > 180）→ 不得自动开机',
    !makeFetch.calls.includes('StartInstance'),
    `实际=${JSON.stringify(makeFetch.calls)}`);
}

console.log('\n【D 组】流量回到安全线内 + 已停止 → 应自动开机');
{
  makeFetch.calls = [];
  globalThis.fetch = makeFetch(1, 'Stopped');
  try { await checkOne(ENV, { ...LIVE }, CONFIG, {}, () => {}, []); } catch (e) {}
  check('已停止 + 1GB（安全）→ 自动开机 StartInstance',
    makeFetch.calls.includes('StartInstance'),
    `实际=${JSON.stringify(makeFetch.calls)}`);
}

console.log('\n【E 组】阈值字段被人改坏 → 必须回退 180，绝不乱关');
{
  for (const [label, bad] of [['字符串 "180abc"', '180abc'], ['null', null], ['""', ''], ['true', true]]) {
    makeFetch.calls = [];
    globalThis.fetch = makeFetch(5, 'Running');
    const logs = [];
    try {
      await checkOne(ENV, { ...LIVE, traffic_limit: bad }, CONFIG, {}, (m) => logs.push(m), []);
    } catch (e) {}
    check(`阈值=${label} + 已用 5GB → 不得关机`,
      !makeFetch.calls.includes('StopInstance'),
      `实际=${JSON.stringify(makeFetch.calls)}`);
  }
  // 同时确认 parseTrafficLimit 对线上值 180 返回合法
  const p = parseTrafficLimit(180);
  check('线上阈值 180 解析为合法值（invalid=null）', p.limitGb === 180 && p.invalid === null,
    `实际=${JSON.stringify(p)}`);
}

console.log('\n【F 组】阈值设得比免费额度高 → 必须发付费风险提醒（ap-southeast-6 免费 200GB）');
{
  makeFetch.calls = [];
  globalThis.fetch = makeFetch(5, 'Running');
  const logs = [];
  try {
    await checkOne(ENV, { ...LIVE, traffic_limit: 300 }, CONFIG, {}, (m) => logs.push(m), []);
  } catch (e) {}
  const warned = logs.some((m) => m.includes('高于免费额度') || m.includes('付费风险'));
  check('阈值 300GB > 免费 200GB → 日志出现付费风险提醒', warned,
    `实际日志=${JSON.stringify(logs)}`);
}

globalThis.fetch = orig;

console.log('\n' + '-'.repeat(60));
console.log(`到流量阈值自动停机 · 独立边界验证：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
