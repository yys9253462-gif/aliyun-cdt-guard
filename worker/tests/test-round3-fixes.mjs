/**
 * 第三轮排查修复自检（不联网）
 * ===========================================================================
 *   1. 添加账号扫描：失败的地域要告诉用户，限流不再拖垮其他地域
 *   2. 「立即巡检」不再被 3 分钟软锁拒绝
 *   3. 周报日均按经过的天数计算
 *   4. 删除提示不用 Telegram 旧版 Markdown 不认识的 **加粗**
 *   5. 长消息部分发送失败时只重发失败的段落
 */
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import * as scan from '../src/account-scan.js';
import * as bot from '../src/bot-listener.js';
import * as tg from '../src/telegram.js';
import { buildWeekly } from '../src/views.js';
import { withRequestContext, requestContext } from '../src/request-context.js';

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
const quiet = async (fn) => {
  const log = console.log; const err = console.error; const warn = console.warn;
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; console.warn = warn; }
};

const REGIONS = ['ap-northeast-2', 'ap-southeast-1', 'cn-beijing', 'cn-hangzhou', 'cn-shanghai', 'cn-shenzhen',
  'cn-qingdao', 'cn-chengdu', 'cn-guangzhou', 'cn-hongkong', 'eu-central-1', 'me-east-1', 'us-east-1', 'us-west-1'];
let F;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  let body = String(init.body || '');
  try { body = decodeURIComponent(body); } catch (_) { /* json */ }
  F.calls.push(body);
  if (u.includes('api.telegram.org')) {
    const fails = F.tgFail && F.tgFail(body);
    const p = fails ? { ok: false, description: 'boom' } : { ok: true, result: { message_id: 1 } };
    return { ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) };
  }
  const action = (body.match(/(?:^|&)Action=([^&]+)/) || [])[1] || '';
  const region = (body.match(/RegionId=([^&]+)/) || [])[1];
  let p = { RequestId: 'x' };
  if (action === 'DescribeRegions') p = { Regions: { Region: REGIONS.map((RegionId) => ({ RegionId })) } };
  else if (action === 'DescribeInstances' && F.failRegion && F.failRegion(region)) p = F.failPayload;
  else if (action === 'DescribeInstances') {
    p = { TotalCount: 1, Instances: { Instance: [{ InstanceId: `i-${region}`, InstanceName: region, Status: 'Running' }] } };
  } else if (action === 'ListCdtInternetTraffic') p = { TrafficDetails: [] };
  const t = JSON.stringify(p);
  return { ok: true, status: 200, json: async () => p, text: async () => t };
};

console.log('--- 1. 扫描失败的地域要说出来 ---');
{
  F = { calls: [], failRegion: (r) => r.startsWith('cn-'), failPayload: { Code: 'Throttling.User', Message: 'busy' } };
  const r = await quiet(() => withRequestContext(() => scan.scanAccount('LTAI-FAKE', 'SECRET')));
  const found = new Set(r.instances.map((i) => i.region));
  check('国内地域被限流：海外地域照样扫到', ['eu-central-1', 'me-east-1', 'us-east-1', 'us-west-1'].every((x) => found.has(x)),
    [...found].join(','));
  check('被限流的地域都记进 failedRegions', r.failedRegions.length === 8, JSON.stringify(r.failedRegions));
  const describeCalls = F.calls.filter((c) => c.includes('Action=DescribeInstances')).length;
  check(`扫描不重试，不会把调用次数耗光（DescribeInstances ${describeCalls} 次）`, describeCalls === REGIONS.length);
  const text = scan.formatScanResult(r.instances, 20, r.failedRegions);
  check('扫描结果里写明「有 8 个地域没扫到」', text.includes('有 8 个地域没扫到'), text.slice(-200));
  check('提示可以重新扫描', text.includes('重新扫描'));
}
{
  F = { calls: [], failRegion: (r) => r === 'us-west-1', failPayload: { Code: 'Forbidden.RAM', Message: 'no permission' } };
  const r = await quiet(() => withRequestContext(() => scan.scanAccount('LTAI-FAKE', 'SECRET')));
  check('单个地域没权限：其余照常，失败地域被列出', r.instances.length === REGIONS.length - 1
    && r.failedRegions.length === 1 && r.failedRegions[0].region === 'us-west-1', JSON.stringify(r.failedRegions));
}
{
  F = { calls: [], failRegion: () => true, failPayload: { Code: 'Throttling.User', Message: 'busy' } };
  const r = await quiet(() => withRequestContext(() => scan.scanAccount('LTAI-FAKE', 'SECRET')));
  check('所有地域都失败：不报「扫描完成」，而是「没能完成」', r.credential === scan.CRED_UNKNOWN && r.instances.length === 0,
    JSON.stringify({ c: r.credential, m: r.message }));
}
{
  F = { calls: [] };
  const r = await quiet(() => withRequestContext(() => scan.scanAccount('LTAI-FAKE', 'SECRET')));
  const text = scan.formatScanResult(r.instances, 20, r.failedRegions);
  check('全部正常：没有失败提示', r.failedRegions.length === 0 && !text.includes('没扫到'));
}
{
  F = { calls: [] };
  await quiet(() => withRequestContext(async () => {
    requestContext().budget.used = 40; // 只剩 2 次调用
    const r = await scan.scanAccount('LTAI-FAKE', 'SECRET');
    check('调用次数不够时：剩下的地域标为「没来得及扫描」，不冒充「没有机器」',
      r.failedRegions.some((f) => f.reason.includes('没来得及')), JSON.stringify(r.failedRegions.slice(0, 2)));
  }));
}

console.log('--- 2. 立即巡检不被软锁拒绝 ---');
{
  F = { calls: [] };
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  const config = { telegram: { chat_id: '1' }, users: [{ name: 'm', instance_id: 'i-ap-northeast-2', region: 'ap-northeast-2', ak: 'A', sk: 'B', traffic_limit: 180 }] };
  await common.saveConfig(env, config);
  await quiet(() => withRequestContext(() => guard.runInspection(env))); // 刚跑过一轮定时巡检
  F.calls = [];
  await quiet(() => withRequestContext(() => bot.runInspection2(env, config, 'T', '1')));
  const replies = F.calls.filter((c) => c.includes('"chat_id"')).join('\n');
  check('定时巡检刚跑完就点「立即巡检」：照样执行', replies.includes('巡检完成') && !replies.includes('本次已取消'),
    replies.slice(0, 160));
}

console.log('--- 3. 周报日均 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const now = common.nowLocal();
  const day = (n) => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
  const history = [];
  for (let i = 6; i >= 0; i -= 1) history.push({ instance_id: 'i-a', name: 'm', date: day(i), time: '09:00', traffic_gb: (6 - i) * 10 });
  await env.CDT_GUARD_KV.put('traffic_history', JSON.stringify(history));
  await env.CDT_GUARD_KV.put('history', JSON.stringify(history));
  const text = await buildWeekly(env, { users: [{ name: 'm', instance_id: 'i-a', region: 'ap-northeast-2' }] });
  check('7 个日快照、每天 10GB：日均 10.00 GB（不是 8.57）', text.includes('日均约: 10.00 GB/天（覆盖 6 天）'), text);
}

console.log('--- 4. 删除提示的加粗写法 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  const config = { users: [{ name: 'm', instance_id: 'i-a', region: 'ap-northeast-2' }] };
  await common.saveConfig(env, config);
  const text = await quiet(() => bot.deleteDevice(env, config, 'i-a'));
  check('不再用 Telegram 旧版 Markdown 不认识的 **', !text.includes('**') && text.includes('*阿里云上的 ECS 实例本身没有被删除*'), text);
}

console.log('--- 5. 分段消息只重发失败的段落 ---');
{
  const lines = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 ${'x'.repeat(20)}`);
  const longText = lines.join('\n');
  const segments = tg.splitMessage(longText);
  F = { calls: [], tgFail: (body) => body.includes('第 0 行 ') === false && body.includes(`第 ${lines.length - 1} 行`) };
  await quiet(() => withRequestContext(async () => {
    await tg.sendText('T', '1', longText, [[{ text: 'ok', callback_data: 'x' }]]);
    const outbox = requestContext().outbox;
    check(`消息被分成 ${segments.length} 段`, segments.length >= 3);
    check('只把失败的最后一段放进重发队列', outbox.length === 1 && !outbox[0].text.includes('第 0 行 ')
      && outbox[0].text.includes(`第 ${lines.length - 1} 行`), outbox[0] && outbox[0].text.slice(0, 40));
    check('失败的是最后一段：重发时带上按钮', outbox[0] && Array.isArray(outbox[0].keyboard));
  }, { outbox: [] }));
}

globalThis.fetch = realFetch;
console.log(`\n第三轮修复自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
