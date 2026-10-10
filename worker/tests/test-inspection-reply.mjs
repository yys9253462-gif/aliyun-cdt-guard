/**
 * 巡检回执文案自检（不联网）
 * ===========================================================================
 * 钉死两件事：
 *   1. 回执里**绝不能出现 `[object Object]`** —— 曾经直接把返回对象插进
 *      模板字符串，用户收到「巡检完成 | | [object Object]」，一个有用的字都没有。
 *   2. 失败时**绝不能显示成「✅ 巡检完成」** —— 那是假装成功，比报错更害人。
 *
 * guard.runInspection 有四种返回形态，这里逐个覆盖。
 */
import { buildInspectionReply } from '../src/bot-listener.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274C ${name}  ${extra}`); }
}

const cases = [
  ['正常查了 3 台', { ok: true, checked: 3 }, (t) => t.includes('检查了 3 台') && !t.includes('object')],
  ['正常查了 1 台', { ok: true, checked: 1 }, (t) => t.includes('检查了 1 台')],
  ['配置里没有机器', { ok: true, checked: 0 }, (t) => t.includes('没有正在监控的机器') && t.includes('添加账号')],
  ['软锁拦住未跑', { ok: true, skipped: true, checked: 0 }, (t) => t.includes('没有正在监控的机器')],
  ['巡检整体失败', { ok: false, error: 'KV 读取超时' }, (t) => t.includes('没能完成') && t.includes('KV 读取超时')],
  ['失败但没有原因', { ok: false }, (t) => t.includes('没能完成')],
  ['返回 null', null, (t) => typeof t === 'string' && t.length > 0],
  ['返回 undefined', undefined, (t) => typeof t === 'string' && t.length > 0],
  ['返回空对象', {}, (t) => typeof t === 'string' && t.length > 0],
  ['返回字符串（异常情况）', 'oops', (t) => !t.includes('object')],
];

for (const [name, summary, verify] of cases) {
  let text;
  try { text = buildInspectionReply(summary); }
  catch (e) { check(name, false, `抛异常 ${e.message}`); continue; }
  check(name, verify(text), `实际输出：${JSON.stringify(text)}`);
}

// ---- 硬性守卫：任何形态都不得出现 [object Object] ----
const evil = [
  { ok: true, checked: 'x' }, { ok: true, checked: {} }, { ok: true, checked: [] },
  { ok: true, checked: null }, { ok: true, checked: 2.5 }, { ok: true, checked: -1 },
  { ok: false, error: { message: 'obj' } }, { ok: true, checked: 3, extra: { a: 1 } },
];
for (const s of evil) {
  const t = buildInspectionReply(s);
  check(`不得出现 [object Object]（${JSON.stringify(s).slice(0, 40)}）`,
    !t.includes('[object Object]'), JSON.stringify(t));
}

console.log(`\n巡检回执自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
