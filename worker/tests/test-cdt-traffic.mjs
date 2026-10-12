/**
 * CDT 流量查询自检（不联网）
 * ===========================================================================
 * 这一组测试钉的是 2026-10-12 修的三个问题。它们的共同点是：
 * **都不报错、都静默地给出错数字** —— 只有对比测试才能发现。
 *
 * ---------------------------------------------------------------------------
 * 一、PageSize 写死 50 且不翻页 → 明细被静默截断，总量偏小
 * ---------------------------------------------------------------------------
 * 账号下接入 CDT 的云产品越多，明细条目越多（ECS/EIP/SLB/CEN/IPv6 网关…），
 * 第 50 条以后被丢弃。偏小不报错，只会让「额度剩余」虚高 ——
 * 用户以为安全，其实已在扣钱。
 *
 * 修法：分页拉全（单页 100、最多 10 页，页数上限是子请求预算的闸门）。
 *
 * ---------------------------------------------------------------------------
 * 二、同一个 AK 被反复查 → 白白消耗子请求预算
 * ---------------------------------------------------------------------------
 * CDT 接口返回账号级总量，同一 AK 查多少次都是同一个数。
 * 不缓存时同 AK 3 台机器一轮查 3 次，接口一抖重试起来很容易打满
 * 免费版单请求 50 个子请求的上限（整轮崩掉、结果全丢）。
 *
 * 修法：按 AK+端点 的请求级缓存（与余额缓存同一套哲学）。
 * 注意失败**不**缓存 —— 网络抖动是暂时的，下一台再试可能就好了。
 *
 * ---------------------------------------------------------------------------
 * 三、流量额度页逐台展示账号级总量 → 数字全错还看不懂
 * ---------------------------------------------------------------------------
 * 老写法让每台机器各显示一次「已用」（同 AK 下 3 台显示 3 个相同数字，
 * 用户以为各自独立），再拿账号总量跟单台所在池的额度比 ——
 * 账号混有内地机器时，海外池「剩余」被内地用量污染。
 *
 * 修法：按 AK 分组、一组只查一次；纯单池账号才显示「剩余」；
 * 混合地域账号明说「接口拆不出分池消耗」，不给错数字。
 */

import { getCdtTrafficGb, clearTrafficCache } from '../src/aliyun-api.js';
import { buildTraffic } from '../src/views.js';

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

/**
 * 拦全局 fetch，按 Action / 分页参数返回假数据。
 * 返回 calls 数组（含 url / action / params），供断言请求次数与参数。
 */
function makeFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const params = new URLSearchParams(init?.body || '');
    const action = params.get('Action') || 'Unknown';
    const call = { url: String(url), action, params };
    calls.push(call);
    const payload = handler(call, calls.length) || {};
    const body = JSON.stringify(payload);
    return { status: 200, ok: true, text: async () => body };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
    cdtCalls: () => calls.filter((c) => c.action === 'ListCdtInternetTraffic'),
  };
}

const GB = 1024 ** 3;
/** 造 n 条「每条 1GB」的明细 */
function details(n) {
  return Array.from({ length: n }, () => ({ Traffic: String(GB) }));
}

// ===========================================================================
// 第一组：分页拉全
// ===========================================================================
console.log('\n【第一组】CDT 明细分页：一条都不许丢');

{
  // 100 + 3 条，必须翻两页、总量 103GB
  const f = makeFetch((c) => {
    const page = Number(c.params.get('PageNumber') || '1');
    return { TrafficDetails: page === 1 ? details(100) : details(3) };
  });
  clearTrafficCache();
  const gb = await getCdtTrafficGb('LTAIpage01fake00001', 'sk');
  check('两页明细（100+3）全部计入 → 103 GB', gb === 103, `实际 ${gb}`);
  check('确实翻了 2 页（不是只读第 1 页）', f.cdtCalls().length === 2,
    `实际 ${f.cdtCalls().length} 次`);
  check('单页按上限 100 条请求', f.cdtCalls()[0].params.get('PageSize') === '100');
  f.restore();
}

{
  // 不满一页：1 次请求就够，不多翻
  const f = makeFetch(() => ({ TrafficDetails: details(5) }));
  clearTrafficCache();
  const gb = await getCdtTrafficGb('LTAIpage02fake00002', 'sk');
  check('不满一页 → 只请求 1 次', f.cdtCalls().length === 1,
    `实际 ${f.cdtCalls().length} 次`);
  check('总量 5 GB', gb === 5, `实际 ${gb}`);
  f.restore();
}

{
  // 永远满页：最多 10 页后必须停（子请求预算的闸门，不许无限翻）
  const f = makeFetch(() => ({ TrafficDetails: details(100) }));
  clearTrafficCache();
  const gb = await getCdtTrafficGb('LTAIpage03fake00003', 'sk');
  check('永远满页 → 最多翻 10 页就停（保护子请求预算）',
    f.cdtCalls().length === 10, `实际 ${f.cdtCalls().length} 次`);
  check('10 页 × 100 条全部计入 → 1000 GB', gb === 1000, `实际 ${gb}`);
  f.restore();
}

// ===========================================================================
// 第二组：AK 级缓存与端点
// ===========================================================================
console.log('\n【第二组】同 AK 只查一次；端点分开缓存');

{
  const f = makeFetch(() => ({ TrafficDetails: details(5) }));
  clearTrafficCache();
  await getCdtTrafficGb('LTAIcache01fake001', 'sk');
  await getCdtTrafficGb('LTAIcache01fake001', 'sk');
  await getCdtTrafficGb('LTAIcache01fake001', 'sk');
  check('同 AK 连查 3 次 → 只发 1 次请求', f.cdtCalls().length === 1,
    `实际 ${f.cdtCalls().length} 次`);
  f.restore();
}

{
  const f = makeFetch(() => ({ TrafficDetails: details(1) }));
  clearTrafficCache();
  await getCdtTrafficGb('LTAIcache02fake002', 'sk');
  await getCdtTrafficGb('LTAIcache03fake003', 'sk');
  check('不同 AK → 各查一次（共 2 次）', f.cdtCalls().length === 2,
    `实际 ${f.cdtCalls().length} 次`);
  f.restore();
}

{
  const f = makeFetch(() => ({ TrafficDetails: details(1) }));
  clearTrafficCache();
  await getCdtTrafficGb('LTAIep01fake000001', 'sk', 'cdt.example.com');
  await getCdtTrafficGb('LTAIep01fake000001', 'sk', 'cdt.example.com');
  check('同 AK + 同端点 → 只查一次', f.cdtCalls().length === 1,
    `实际 ${f.cdtCalls().length} 次`);
  await getCdtTrafficGb('LTAIep01fake000001', 'sk'); // 默认端点
  check('同 AK 换端点 → 不共用缓存（两套计量体系）', f.cdtCalls().length === 2,
    `实际 ${f.cdtCalls().length} 次`);
  check('自定义端点真的用上了', f.cdtCalls()[0].url.includes('cdt.example.com'),
    f.cdtCalls()[0].url);
  check('空端点回落国内站默认', f.cdtCalls()[1].url.includes('cdt.aliyuncs.com'),
    f.cdtCalls()[1].url);
  f.restore();
}

{
  // 失败不缓存：第一次业务错误，第二次必须真的再试
  const f = makeFetch((c, n) => (n === 1
    ? { Code: 'InvalidAccessKeyId.NotFound', Message: 'not found' }
    : { TrafficDetails: details(2) }));
  clearTrafficCache();
  let threw = false;
  try {
    await getCdtTrafficGb('LTAIfail01fake00001', 'sk');
  } catch (error) {
    threw = true;
  }
  check('接口业务错误 → 抛出，不静默返回 0', threw);
  const gb = await getCdtTrafficGb('LTAIfail01fake00001', 'sk');
  check('失败不缓存 → 重试成功拿到 2 GB', gb === 2, `实际 ${gb}`);
  check('失败后确实重发了请求', f.cdtCalls().length === 2,
    `实际 ${f.cdtCalls().length} 次`);
  f.restore();
}

// ===========================================================================
// 第三组：流量额度页按账号分组
// ===========================================================================
console.log('\n【第三组】流量额度页：按账号分组，混合账号不算错账');

{
  // 同 AK 两台海外机器：只查一次，合并展示，剩余 = 200 - 12
  const f = makeFetch(() => ({ TrafficDetails: details(12) }));
  clearTrafficCache();
  const text = await buildTraffic({
    users: [
      {
        name: '首尔节点', instance_id: 'i-kr01', region: 'ap-northeast-2',
        ak: 'LTAIgrp01fake00001', sk: 'sk', traffic_limit: 180,
      },
      {
        name: '马尼拉节点', instance_id: 'i-ph01', region: 'ap-southeast-6',
        ak: 'LTAIgrp01fake00001', sk: 'sk', traffic_limit: 180,
      },
    ],
  });
  check('同 AK 两台机器 → CDT 只查 1 次', f.cdtCalls().length === 1,
    `实际 ${f.cdtCalls().length} 次`);
  check('输出标注「账号级计量」', text.includes('账号级计量'));
  check('同 AK 合并成一个账号组（不逐台重复）',
    (text.match(/账号 LTAI/g) || []).length === 1);
  check('纯海外账号 → 非内地额度 200 GB', text.includes('非中国内地额度: 200 GB'));
  check('剩余 = 200 - 12 = 188.00 GB', text.includes('188.00 GB'));
  check('每台机器仍列在地域与阈值', text.includes('首尔（ap-northeast-2）')
    && text.includes('阈值 180 GB'));
  check('页尾告知数据滞后（ CDT 按小时出账 ）', text.includes('滞后'));
  f.restore();
}

{
  // 混合地域账号：明说拆不出，不算错账
  const f = makeFetch(() => ({ TrafficDetails: details(45) }));
  clearTrafficCache();
  const text = await buildTraffic({
    users: [
      {
        name: '杭州机器', instance_id: 'i-cn01', region: 'cn-hangzhou',
        ak: 'LTAImix01fake00001', sk: 'sk', traffic_limit: 18,
      },
      {
        name: '首尔机器', instance_id: 'i-kr02', region: 'ap-northeast-2',
        ak: 'LTAImix01fake00001', sk: 'sk', traffic_limit: 180,
      },
    ],
  });
  check('混合账号给出警告并指向控制台',
    text.includes('同时含有内地与非内地') && text.includes('控制台'));
  check('混合账号不显示分池「剩余」（那个数字是错的）', !text.includes('剩 '));
  check('混合账号仍报账号合计用量', text.includes('45.00 GB'));
  f.restore();
}

{
  // 纯内地账号：20GB 池，极易超
  const f = makeFetch(() => ({ TrafficDetails: details(25) }));
  clearTrafficCache();
  const text = await buildTraffic({
    users: [{
      name: '上海机器', instance_id: 'i-cn02', region: 'cn-shanghai',
      ak: 'LTAIcn01fake00001', sk: 'sk', traffic_limit: 18,
    }],
  });
  check('纯内地账号 → 内地额度 20 GB', text.includes('中国内地额度: 20 GB'));
  check('超支时如实说「已超出」', text.includes('已超出 5.00 GB'));
  f.restore();
}

{
  // 全部暂停：不花请求
  const f = makeFetch(() => ({ TrafficDetails: details(1) }));
  clearTrafficCache();
  const text = await buildTraffic({
    users: [{
      name: '暂停机', instance_id: 'i-pz01', region: 'ap-northeast-2',
      ak: 'LTAIpz01fake00001', sk: 'sk', traffic_limit: 180, paused: true,
    }],
  });
  check('全部暂停 → 不发任何 CDT 请求', f.cdtCalls().length === 0,
    `实际 ${f.cdtCalls().length} 次`);
  check('全部暂停有明确说明', text.includes('全部已暂停'));
  f.restore();
}

{
  // 查询失败：说人话，不显示 0
  const f = makeFetch(() => ({
    Code: 'InvalidAccessKeyId.NotFound', Message: 'specified ak not found',
  }));
  clearTrafficCache();
  const text = await buildTraffic({
    users: [{
      name: '坏Key机', instance_id: 'i-bk01', region: 'ap-northeast-2',
      ak: 'LTAIbk01fake00001', sk: 'sk', traffic_limit: 180,
    }],
  });
  check('查询失败 → 明示「查询失败」而不是显示 0', text.includes('查询失败'));
  f.restore();
}

console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
