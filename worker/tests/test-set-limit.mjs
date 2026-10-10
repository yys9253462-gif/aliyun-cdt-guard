/**
 * 「设阈值」功能自检（不联网）
 * ===========================================================================
 * 这一组盯的是「手机里改阈值」这条新链路，重点是**绝不能写坏阈值**：
 *   阈值一旦变成 0 / 负数 / NaN，下游 `流量 < 阈值` 判断会永假，
 *   于是每 5 分钟强制关机一次，用户完全不知道为什么机器老是被关。
 *   （这条规则与 guard.js 的 parseTrafficLimit 是同一条命根子。）
 *
 * 覆盖：
 *   1. 档位解析：各种写法都要认（带 GB / 带空格 / 带 ✅ 标记）
 *   2. 非法输入必须被拒绝，且**不改配置**
 *   3. 正常输入必须真的写入
 *   4. 主菜单精简后不得丢入口（新老标签都要能匹配到功能）
 */

import * as M from '../src/menu-labels.js';
import {
  parseLimitChoice,
  limitPresetRows,
  setDeviceLimit,
  mainMenuRows,
} from '../src/bot-listener.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274C ${name}  ${extra}`); }
};

// ---------------------------------------------------------------------------
console.log('\n【第一组】档位文字解析');
{
  const ok = [
    ['180GB', 180], ['180', 180], ['180 gb', 180], ['180 GB', 180],
    ['✅ 180GB', 180], ['✅180GB', 180], ['50GB', 50], ['200', 200],
    ['150.5GB', 150.5],
  ];
  for (const [input, want] of ok) {
    check(`「${input}」→ ${want}`, parseLimitChoice(input) === want,
      `实际 ${JSON.stringify(parseLimitChoice(input))}`);
  }
  check('「手动输入」→ manual', parseLimitChoice('手动输入') === 'manual');
  check('「✏️ 手动输入」也能认',
    parseLimitChoice(`\u{270F}\u{FE0F} 手动输入`) === 'manual');

  const bad = ['abc', '', '   ', 'GB', '...', '一千'];
  for (const input of bad) {
    check(`「${input}」→ 不是有效阈值`, parseLimitChoice(input) === null,
      `实际 ${JSON.stringify(parseLimitChoice(input))}`);
  }
  // 0 / 负数由 setDeviceLimit 的上下限兜住（parseLimitChoice 对 0 返回 null）
  check('「0」→ null', parseLimitChoice('0') === null);
  check('「-5」→ null', parseLimitChoice('-5') === null);
}

// ---------------------------------------------------------------------------
console.log('\n【第二组】档位菜单渲染（含当前值标记）');
{
  const u = { name: '菲律宾节点', instance_id: 'i-abc', traffic_limit: 180, region: 'ap-southeast-6' };
  const rows = limitPresetRows(u);
  const flat = rows.flat();
  check('包含 6 个档位', flat.filter((t) => /GB$/.test(t)).length === 6,
    `实际 ${JSON.stringify(flat)}`);
  check('当前值 180 被 ✅ 标出',
    flat.some((t) => t.includes('\u2705') && t.includes('180GB')),
    JSON.stringify(flat));
  check('有「手动输入」按钮', flat.includes(M.LBL_LIMIT_MANUAL));
  check('有「返回上一步」', flat.includes(M.LBL_BACK_PREV));
  check('有「返回主菜单」', flat.includes(M.LBL_BACK_MAIN));

  // 阈值缺失时不该崩，且不标 ✅
  const rows2 = limitPresetRows({ name: 'x', instance_id: 'i-y' });
  check('阈值字段缺失时不崩', rows2.flat().length > 0);
}

// ---------------------------------------------------------------------------
console.log('\n【第三组】setDeviceLimit —— 非法值不得写配置');
{
  const mkEnv = () => {
    const store = {};
    return {
      store,
      CDT_GUARD_KV: {
        get: async (k) => store[k] || null,
        put: async (k, v) => { store[k] = v; },
        delete: async () => {},
      },
    };
  };

  const badValues = [0, -5, NaN, Infinity, 'abc', '', '   ', 3, 9999, null, true];
  for (const bad of badValues) {
    const env = mkEnv();
    const config = { users: [{ name: 'x', instance_id: 'i-1', region: 'ap-southeast-6', traffic_limit: 180 }] };
    const result = await setDeviceLimit(env, config, 'i-1', bad);
    const unchanged = config.users[0].traffic_limit === 180;
    check(`阈值 ${JSON.stringify(bad)} 被拒绝且不改配置`, unchanged,
      `实际 traffic_limit=${config.users[0].traffic_limit}，回执=${result.slice(0, 30)}`);
  }

  // 正常值必须写入
  const env = mkEnv();
  const config = { users: [{ name: 'x', instance_id: 'i-1', region: 'ap-southeast-6', traffic_limit: 180 }] };
  await setDeviceLimit(env, config, 'i-1', 150);
  check('阈值 150 被正确写入', config.users[0].traffic_limit === 150,
    `实际 ${config.users[0].traffic_limit}`);

  // 找不到机器
  const r = await setDeviceLimit(mkEnv(), { users: [] }, 'i-none', 180);
  check('机器不存在时给出中文提示', r.includes('没找到'), r);
}

// ---------------------------------------------------------------------------
console.log('\n【第四组】主菜单精简后：新项都在，且都无英文');
{
  const rows = mainMenuRows();
  const flat = rows.flat();
  check('主菜单 9 项', flat.length === 9, `实际 ${flat.length}: ${JSON.stringify(flat)}`);
  const need = [
    M.LBL_STATUS_OVERVIEW, M.LBL_TRAFFIC, M.LBL_DEVICES, M.LBL_SET_LIMIT,
    M.LBL_START_ALL, M.LBL_STOP_ALL, M.LBL_ADD_ACCOUNT, M.LBL_RUN, M.LBL_HIDE,
  ];
  for (const n of need) {
    check(`含「${M.stripIcon(n)}」`, flat.includes(n));
  }
  const latin = flat.filter((t) => /[A-Za-z]/.test(M.stripIcon(t)));
  check('无英文', latin.length === 0, latin.join(','));

  // 老标签仍能匹配（用户手打「总览」还能用）
  check('老「总览」仍可匹配', M.matchMain(M.LBL_OVERVIEW, M.LBL_OVERVIEW));
  check('老「凭据体检」仍可匹配', M.matchMain(M.LBL_CHECK_CRED, M.LBL_CHECK_CRED));
}

console.log('\n' + '-'.repeat(60));
console.log(`设阈值与菜单精简自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
