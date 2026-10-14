/**
 * 脚本改配置同步自检（不联网）
 * ===========================================================================
 * 线上配置的主存储在协调器（Durable Object）里，KV 只是镜像；
 * 但电脑上的 configure.sh / deploy.sh 直接读写 KV。
 * 原来脚本改的配置线上不生效，之后机器人一改配置还会把它覆盖掉。
 */
import { GuardCoordinator } from '../src/coordinator.js';
import * as common from '../src/common.js';

let pass = 0, fail = 0;
const out = console.log.bind(console);
function check(name, cond, extra = '') {
  if (cond) { pass++; out(`  ✅ ${name}`); }
  else { fail++; out(`  ❌ ${name}  ${extra}`); }
}

class FakeKV {
  constructor() { this.m = new Map(); this.failGet = false; }
  async get(k, t) {
    if (this.failGet) throw new Error('KV down');
    const r = this.m.get(k);
    return r == null ? null : (t === 'json' ? JSON.parse(r) : r);
  }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
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
function setup() {
  const kv = new FakeKV();
  const storage = new FakeStorage();
  const co = new GuardCoordinator({ storage }, { CDT_GUARD_KV: kv, WEBHOOK_SECRET: 's' });
  return { kv, storage, env: co.adaptedEnv() };
}
const ids = (cfg) => cfg.users.map((u) => u.instance_id).join(',');

console.log('--- 1. 脚本改了 KV 里的配置（没升版本号）---');
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  const script = JSON.parse(kv.m.get('config'));
  script.users.push({ instance_id: 'i-b' });
  await kv.put('config', JSON.stringify(script)); // 脚本原样写回，版本号不变
  const seen = await quiet(() => common.loadConfig(env));
  check('线上读到脚本加的机器', ids(seen) === 'i-a,i-b', ids(seen));
  seen.users[0].paused = true;
  await common.saveConfig(env, seen);
  const after = JSON.parse(kv.m.get('config'));
  check('之后在机器人里改配置：脚本加的机器不会被覆盖', ids(after) === 'i-a,i-b' && after.users[0].paused === true, ids(after));
}

console.log('--- 2. 脚本升了版本号 ---');
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  const script = JSON.parse(kv.m.get('config'));
  script.telegram.chat_id = '999';
  script._revision = String(Number(script._revision) + 1);
  await kv.put('config', JSON.stringify(script));
  const seen = await quiet(() => common.loadConfig(env));
  check('版本号更高：采用脚本改的 Chat ID', seen.telegram.chat_id === '999');
}

console.log('--- 3. KV 镜像比协调器旧（镜像写失败留下的）---');
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  const stale = kv.m.get('config');
  const cfg = await common.loadConfig(env);
  cfg.users.push({ instance_id: 'i-new' });
  await common.saveConfig(env, cfg); // 版本号 +1
  await kv.put('config', stale); // 模拟镜像没写成功，KV 还是旧版本
  const seen = await quiet(() => common.loadConfig(env));
  check('KV 版本号更低：不被旧内容覆盖', ids(seen) === 'i-a,i-new', ids(seen));
}

console.log('--- 4. 异常情况 ---');
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  await kv.put('config', '{broken json');
  const seen = await quiet(() => common.loadConfig(env));
  check('KV 里的配置坏了：继续用协调器里的', ids(seen) === 'i-a', ids(seen));
}
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  kv.failGet = true;
  const seen = await quiet(() => common.loadConfig(env));
  check('KV 读取失败：继续用协调器里的，不报错', ids(seen) === 'i-a', ids(seen));
}
{
  const { kv, env } = setup();
  await common.saveConfig(env, { telegram: { chat_id: '1' }, users: [{ instance_id: 'i-a' }] });
  kv.m.delete('config');
  const seen = await quiet(() => common.loadConfig(env));
  check('KV 里没有配置：继续用协调器里的', ids(seen) === 'i-a', ids(seen));
}
{
  const { kv, storage, env } = setup();
  await kv.put('state', JSON.stringify({ old: 1 }));
  await storage.put('data:state', JSON.stringify({ fresh: 1 }));
  const st = await common.loadState(env);
  check('只同步 config，运行状态仍以协调器为准', st.fresh === 1 && !st.old, JSON.stringify(st));
}

console.log(`\n脚本改配置同步自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
