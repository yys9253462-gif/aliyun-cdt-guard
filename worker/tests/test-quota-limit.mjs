/**
 * 额度口径 与 关机阈值 自检（不联网）
 * ===========================================================================
 * 这一组测试钉死的是**两个会直接造成金钱损失**的计算错误。
 * 它们都不「报错」，都只是「算错」，所以只有对比测试才能发现。
 *
 * ---------------------------------------------------------------------------
 * 一、免费额度是**账号级**的，不是机器级的
 * ---------------------------------------------------------------------------
 * 阿里云的 CDT 免费额度按「账号 + 地域池」给：
 *     中国内地 20GB 一份、非中国内地 200GB 一份。
 * 同一个账号下挂 3 台海外机器，也**只有 200GB**，不是 600GB。
 *
 * 老代码是「遍历成员、逐台累加」，于是：
 *     3 台海外 → 算出 600GB（虚高 3 倍）
 * 用户看到报表说「还剩 590GB，很安全」，实际 210GB 就已经在扣钱了。
 * 这个错误不报错、不崩溃，纯粹是数字骗人 —— 最危险的那一类。
 *
 * ---------------------------------------------------------------------------
 * 二、关机阈值不合法时，绝不能「当成 0」去关机
 * ---------------------------------------------------------------------------
 * 老代码只有一句：
 *     const limitGb = Number(user.traffic_limit === undefined ? 180 : user.traffic_limit);
 * 它只挡住了「字段缺失」。而下面这些都会漏过去：
 *     null  → Number(null) = 0      → 判定「流量 < 0」永假 → 每次巡检都关机
 *     ''    → 0                     → 同上
 *     'abc' → NaN                   → NaN 的比较全是 false → 同样掉进关机分支
 *     -5    → -5                    → 同样必然关机
 * 后果：机器每 5 分钟被关一次，用户完全不知道为什么。
 *
 * 修法是**宁可漏关、绝不乱关**：拿不准就退回默认 180，并留下日志。
 *
 * 本测试连「对照组的正常路径」一起验：
 *     阈值 1GB / 已用 5GB  → 必须真的关机（证明没把功能改坏）
 *     阈值 180 / 已用 5GB  → 必须不关机
 */

import { quotaForGroup } from '../src/account-summary.js';
import { parseTrafficLimit, checkOne } from '../src/guard.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2705 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u274C ${name}  ${extra}`);
  }
}

// ===========================================================================
// 第一部分：免费额度必须按账号算，不按台数累加
// ===========================================================================
console.log('\n【第一组】免费额度按账号计算（不按机器台数累加）');

const mk = (region) => ({ region, instance_id: `i-${region}`, name: region });

{
  const cases = [
    ['1 台海外 → 只有 200GB', [mk('cn-hongkong')], { mainland: 0, overseas: 200 }],
    ['3 台海外 → 仍然只有 200GB（不是 600）',
      [mk('cn-hongkong'), mk('ap-northeast-1'), mk('us-west-1')], { mainland: 0, overseas: 200 }],
    ['2 台内地 → 只有 20GB（不是 40）', [mk('cn-hangzhou'), mk('cn-beijing')], { mainland: 20, overseas: 0 }],
    ['内地 1 台 + 海外 2 台 → 20 + 200',
      [mk('cn-hangzhou'), mk('cn-hongkong'), mk('us-west-1')], { mainland: 20, overseas: 200 }],
    ['没有机器 → 0 + 0', [], { mainland: 0, overseas: 0 }],
    ['地域字段缺失 → 按内地算一份 20',
      [{ instance_id: 'i-a' }, { region: null, instance_id: 'i-b' }], { mainland: 20, overseas: 0 }],
  ];

  for (const [name, members, want] of cases) {
    const got = quotaForGroup(members);
    check(name, got.mainland === want.mainland && got.overseas === want.overseas,
      `实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
  }

  // 这一条是「反向验证的守卫」：只要有人把逐台累加写回来，这条立刻红。
  // ⚠️ 必须用**真实的地域编号** —— 编造的 "overseas-0" 这类名字
  //    isOverseasRegion 认不出来，会被当成内地，测不出问题。
  const realOverseas = ['cn-hongkong', 'ap-northeast-1', 'us-west-1', 'ap-southeast-1',
    'eu-central-1', 'us-east-1', 'ap-south-1', 'me-east-1', 'eu-west-1', 'ap-northeast-2'];
  const tenOverseas = realOverseas.map((r) => mk(r));
  const got = quotaForGroup(tenOverseas);
  check('10 台海外 → 仍然只有 200GB（钉死「不按台累加」）',
    got.overseas === 200, `实际 ${got.overseas}`);

  // 同理，内地也钉一条
  const realMainland = ['cn-hangzhou', 'cn-beijing', 'cn-shanghai', 'cn-shenzhen',
    'cn-qingdao', 'cn-zhangjiakou', 'cn-chengdu', 'cn-guangzhou', 'cn-wuhan', 'cn-hongkong-x'];
  const tenMainland = realMainland.slice(0, 9).map((r) => mk(r));
  const gotM = quotaForGroup(tenMainland);
  check('9 台内地 → 仍然只有 20GB（钉死「不按台累加」）',
    gotM.mainland === 20, `实际 ${gotM.mainland}`);
}

// ===========================================================================
// 第二部分：阈值解析（纯函数，覆盖各种脏数据）
// ===========================================================================
console.log('\n【第二组】关机阈值解析：拿不准就回退默认值，绝不冒险');

{
  const limitCases = [
    // [说明, 入参, 期望阈值, 是否应判定为「不合法」]
    ['字段缺失（老配置）→ 用默认 180', undefined, 180, false],
    ['正常数字 200 → 原样用', 200, 200, false],
    ['数字字符串 "180" → 转成 180', '180', 180, false],
    ['小数 12.5 → 保留小数', 12.5, 12.5, false],
    ['带空格的 "  150  " → 去空格后 150', '  150  ', 150, false],
    ['0 → 不合法，回退 180', 0, 180, true],
    ['负数 -5 → 不合法，回退 180', -5, 180, true],
    ['null → 不合法，回退 180', null, 180, true],
    ['空字符串 → 不合法，回退 180', '', 180, true],
    ['纯空格 "   " → 不合法，回退 180', '   ', 180, true],
    ['乱填 "abc" → 不合法，回退 180', 'abc', 180, true],
    ['布尔 true → 不合法（注意 Number(true)===1 的坑）', true, 180, true],
    ['布尔 false → 不合法', false, 180, true],
    ['NaN → 不合法，回退 180', NaN, 180, true],
    ['Infinity → 不合法，回退 180', Infinity, 180, true],
    ['数组 → 不合法', [], 180, true],
    ['对象 → 不合法', {}, 180, true],
  ];

  for (const [name, raw, wantGb, wantInvalid] of limitCases) {
    const got = parseTrafficLimit(raw);
    const okGb = got.limitGb === wantGb;
    const okFlag = wantInvalid ? got.invalid !== null : got.invalid === null;
    check(name, okGb && okFlag,
      `实际 ${JSON.stringify(got)}，期望 ${wantGb}${wantInvalid ? ' + 标记为不合法' : ''}`);
  }
}

// ===========================================================================
// 第三部分：端到端 —— 拦 fetch，看真实链路到底有没有调 StopInstance
// ===========================================================================
console.log('\n【第三组】端到端：异常阈值绝不能触发强制关机');

{
  // 所有阿里云请求都走全局 fetch，所以拦它就能看到真实行为。
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const params = new URLSearchParams(init?.body || '');
    const action = params.get('Action') || 'Unknown';
    calls.push(action);
    let payload;
    switch (action) {
      case 'ListCdtInternetTraffic':
        // 本月只用了 5GB
        payload = { TrafficDetails: [{ Traffic: String(5 * 1024 ** 3) }] };
        break;
      case 'DescribeInstances':
        // ⚠️ 阿里云真实结构是两层：Instances.Instance[]
        payload = {
          Instances: {
            Instance: [{
              InstanceId: 'i-any', InstanceName: 'any', Status: 'Running',
              RegionId: 'cn-hongkong', PublicIpAddress: { IpAddress: ['1.2.3.4'] },
            }],
          },
        };
        break;
      default:
        payload = {};
    }
    const body = JSON.stringify(payload);
    return { status: 200, ok: true, text: async () => body };
  };

  const logger = () => {};
  const config = { chat_id: '123456789', bot_token: 'fake-token' };
  const env = {
    CDT_GUARD_KV: {
      get: async () => null, put: async () => {}, delete: async () => {},
    },
  };
  const baseUser = {
    instance_id: 'i-threshold', name: '阈值测试机',
    ak: 'LTAIfake000000000000', sk: 'fake-secret', region: 'cn-hongkong',
  };

  const badValues = [
    ['null', null], ['空字符串', ''], ['纯空格', '   '], ['乱填 abc', 'abc'],
    ['负数', -5], ['零', 0], ['布尔 true', true], ['NaN', NaN],
  ];

  for (const [name, limit] of badValues) {
    calls.length = 0;
    const logs = [];
    try {
      await checkOne(env, { ...baseUser, traffic_limit: limit }, config, {},
        (m) => logs.push(m), []);
    } catch (e) { /* 本组只关心有没有关机，其他异常忽略 */ }
    const stopped = calls.includes('StopInstance');
    check(`阈值=${name} → 不得调用 StopInstance`, !stopped,
      `实际调用 ${JSON.stringify(calls.filter((c) => c === 'StopInstance'))}`);
  }

  // 对照组 1：真的超标了，必须关机（否则说明修复把功能改坏了）
  calls.length = 0;
  await checkOne(env, { ...baseUser, traffic_limit: 1 }, config, {}, logger, []);
  check('对照组：阈值 1GB / 已用 5GB → 必须调用 StopInstance',
    calls.includes('StopInstance'), `实际调用 ${JSON.stringify(calls)}`);

  // 对照组 2：正常余量，不该关机
  calls.length = 0;
  await checkOne(env, { ...baseUser, traffic_limit: 180 }, config, {}, logger, []);
  check('对照组：阈值 180GB / 已用 5GB → 不得关机',
    !calls.includes('StopInstance'), `实际调用 ${JSON.stringify(calls)}`);

  // 对照组 3：字段整个缺失，按默认 180 处理，不该关机
  calls.length = 0;
  await checkOne(env, baseUser, config, {}, logger, []);
  check('对照组：阈值字段缺失 / 已用 5GB → 按 180 处理，不得关机',
    !calls.includes('StopInstance'), `实际调用 ${JSON.stringify(calls)}`);

  globalThis.fetch = originalFetch;
}

// ===========================================================================
console.log(`\n${'-'.repeat(60)}`);
console.log(`额度与阈值自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
