/**
 * AccessKey 防泄露自检（不联网）
 * ===========================================================================
 *   1. 协调器不再提供能读出 / 替换全部配置（含 AccessKey Secret）的接口
 *   2. 添加账号做到一半放弃：暂存的 Secret 由巡检主动清掉
 *   3. 部署脚本强制网址密钥够长，自检用 POST 注册 Webhook
 *   4. 日志与通知里的密钥会被打码
 *   5. 文档推荐最小权限，不再推荐 AliyunECSFullAccess
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GuardCoordinator } from '../src/coordinator.js';
import * as common from '../src/common.js';
import * as guard from '../src/guard.js';
import { withRequestContext } from '../src/request-context.js';

let pass = 0, fail = 0;
const out = console.log.bind(console);
function check(name, cond, extra = '') {
  if (cond) { pass++; out(`  ✅ ${name}`); }
  else { fail++; out(`  ❌ ${name}  ${extra}`); }
}
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, t) { const r = this.m.get(k); return r == null ? null : (t === 'json' ? JSON.parse(r) : r); }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list() { return { keys: [...this.m.keys()].map((name) => ({ name })) }; }
}
class FakeStorage {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list() { return new Map(); }
  async setAlarm() {}
}
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const SK = 'RealLookingSecretValue0123456789ab';

console.log('--- 1. 读写配置的接口已移除 ---');
{
  const storage = new FakeStorage();
  const kv = new FakeKV();
  const co = new GuardCoordinator({ storage }, { CDT_GUARD_KV: kv, WEBHOOK_SECRET: 'right-secret-0123456789abcdef' });
  await common.saveConfig(co.adaptedEnv(), { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a', ak: 'LTAI5tReal0000000000', sk: SK }] });
  const get = await quiet(() => co.dispatch(new Request('https://x/control/config', { headers: { 'X-CDT-Key': 'right-secret-0123456789abcdef' } })));
  const body = await get.text();
  check('带对网址密钥 GET：拿不到配置', get.status === 404 && !body.includes(SK), `status=${get.status}`);
  const put = await quiet(() => co.dispatch(new Request('https://x/control/config', {
    method: 'PUT', headers: { 'X-CDT-Key': 'right-secret-0123456789abcdef', 'If-Match': '1' },
    body: JSON.stringify({ telegram: { chat_id: 'attacker' }, users: [] }),
  })));
  const after = await common.loadConfig(co.adaptedEnv());
  check('带对网址密钥 PUT：不能替换配置', put.status === 404 && after.telegram.chat_id === '1' && after.users.length === 1,
    `status=${put.status} chat=${after.telegram.chat_id}`);
  const src = fs.readFileSync(new URL('../src/coordinator.js', import.meta.url), 'utf8');
  check('协调器代码里不再有 Response.json(await loadConfig', !src.includes('Response.json(await loadConfig'));
}

console.log('--- 2. 放弃的添加账号向导：Secret 被主动清掉 ---');
{
  const env = { CDT_GUARD_KV: new FakeKV(), TELEGRAM_BOT_TOKEN: 'T' };
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [] });
  await common.setWizard(env, '1', { step: 'confirm', ak: 'LTAI5tReal0000000000', sk: SK });
  await common.setCurrentDevice(env, '1', 'i-keep');
  const sessions = await common.loadSessions(env);
  sessions['1'].wizard.at -= common.WIZARD_TTL_SECONDS + 1; // 模拟 15 分钟前就放弃了
  await env.CDT_GUARD_KV.put(common.KV_SESSION, JSON.stringify(sessions));
  await quiet(() => withRequestContext(() => guard.runInspection(env, { force: true })));
  const raw = env.CDT_GUARD_KV.m.get(common.KV_SESSION) || '';
  check('巡检后存储里不再有暂存的 Secret', !raw.includes(SK), raw.slice(0, 120));
  const left = await common.loadSessions(env);
  check('同一会话里的其他记录（当前选中的机器）保留', JSON.stringify(left).includes('i-keep'), JSON.stringify(left));
}
{
  const env = { CDT_GUARD_KV: new FakeKV() };
  await common.setWizard(env, '1', { step: 'confirm', ak: 'LTAI5tReal0000000000', sk: SK });
  const n = await common.purgeExpiredWizards(env);
  check('还没过期的向导不清（用户可能正在操作）', n === 0 && (env.CDT_GUARD_KV.m.get(common.KV_SESSION) || '').includes(SK));
}

console.log('--- 3. 部署脚本 ---');
{
  const sh = fs.readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  check('自检用 POST（才会向 Telegram 注册 Webhook）', /curl -s --max-time 25 -X POST -H "X-CDT-Key/.test(sh));
  const dir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const test = (secret) => {
    try {
      execFileSync('bash', ['-c', `cd "${dir}" && . ./deploy.sh >/dev/null 2>&1; is_strong_secret "$1" && echo yes || echo no`, '_', secret], { encoding: 'utf8' });
      return execFileSync('bash', ['-c', `cd "${dir}" && . ./deploy.sh >/dev/null 2>&1; is_strong_secret "$1" && echo yes || echo no`, '_', secret], { encoding: 'utf8' }).trim();
    } catch (e) { return 'error'; }
  };
  check('「abc123」这种短密钥被拒绝', test('abc123') === 'no');
  check('23 位被拒绝', test('a'.repeat(23)) === 'no');
  check('带空格 / 斜杠的被拒绝（会弄坏网址）', test('abcdefghijklmnopqrstuvwxyz/1') === 'no' && test('abcdefghijkl mnopqrstuvwxyz') === 'no');
  check('脚本自动生成的 32 位随机串通过', test('0123456789abcdef0123456789abcdef') === 'yes');
}

console.log('--- 4. 打码 ---');
{
  const msg = common.redact(`SignatureDoesNotMatch: AccessKeyId=LTAI5tReal0000000000&AccessKeySecret=${SK}`);
  check('错误信息里的 AccessKey ID 被打码', !msg.includes('LTAI5tReal0000000000'), msg);
  check('错误信息里的 Secret 被打码', !msg.includes(SK), msg);
  check('通知用的 sanitize 也打码', !common.sanitize(`key ${SK}`).includes(SK));
}

console.log('--- 5. 文档 ---');
{
  // 在仓库里：策略在 ../docs/、权限说明看根目录 README；
  // 在分享包里：策略在包内 docs/、权限说明看包内的部署指南
  const workerRoot = new URL('../', import.meta.url);
  const repoRoot = new URL('../../', import.meta.url);
  const inRepo = fs.existsSync(new URL('docs/ram-policy-ecs-minimal.json', repoRoot));
  const policyUrl = inRepo ? new URL('docs/ram-policy-ecs-minimal.json', repoRoot) : new URL('docs/ram-policy-ecs-minimal.json', workerRoot);
  const guideUrl = inRepo ? new URL('README.md', repoRoot) : new URL('部署指南.md', workerRoot);
  const guide = fs.readFileSync(guideUrl, 'utf8');
  const policy = JSON.parse(fs.readFileSync(policyUrl, 'utf8'));
  const actions = policy.Statement.flatMap((s) => s.Action).sort();
  check('最小权限策略只含查实例 / 查地域 / 开机 / 关机',
    JSON.stringify(actions) === JSON.stringify(['ecs:DescribeInstances', 'ecs:DescribeRegions', 'ecs:StartInstance', 'ecs:StopInstance']),
    JSON.stringify(actions));
  check('权限说明不再推荐授予 AliyunECSFullAccess', !/授予[\s\S]{0,80}`AliyunECSFullAccess`（开关机）/.test(guide)
    && guide.includes('不要给 `AliyunECSFullAccess`'));
  const used = new Set();
  for (const f of fs.readdirSync(new URL('../src/', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of s.matchAll(/action: "([A-Za-z]+)"/g)) used.add(m[1]);
  }
  const ecsUsed = [...used].filter((a) => /Instance|Region/.test(a) && !/Bill/.test(a)).map((a) => `ecs:${a}`).sort();
  check('代码用到的 ECS 接口都在策略里（不会因权限不够而失败）', ecsUsed.every((a) => actions.includes(a)), ecsUsed.join(','));
}

console.log(`\nAccessKey 防泄露自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
