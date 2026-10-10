/**
 * Telegram 发送层健壮性自检（不联网）
 * ===========================================================================
 * 本轮修的是第四轮遗留的 B5/B6/B7/B9/B10 五组问题，全部集中在「发送层」。
 * 这一组的共同特点是**都不报错、都静默失效**，所以必须用测试钉死：
 *
 *   B6  markdownSafe 漏检下划线 `_`
 *       —— 机器名里一个落单的下划线就让整条消息被 Telegram 拒收。
 *          最坑的是「最终还能发出去」（因为会降级重发），所以表面上一切正常，
 *          只有翻日志才看得到持续刷屏的 "can't parse entities"。
 *
 *   B7  消息超过 4096 字符不分片
 *       —— 机器一多，报表直接被拒、一个字都发不出去。
 *          这是唯一一个「用户完全收不到消息」的问题，最严重。
 *
 *   B9/B10  发送层不做统一过滤
 *       —— body 里混入的 `*` 会「吃掉」标题的加粗标记；
 *          不可见控制字符会让 Telegram 表现异常。
 *
 *   B5  子请求预算
 *       —— 免费版单请求最多 50 个子请求，撞上就整个请求崩掉。
 *          这里验证预算计数器与「预算不够时不再发请求」的行为。
 */
import {
  markdownSafe,
  splitMessage,
  withPageMarker,
  neutralizeMarkdown,
  sendAlert,
} from '../src/telegram.js';
import {
  resetSubrequestCount,
  getSubrequestCount,
  isSubrequestBudgetExhausted,
  BudgetExhaustedError,
  getAccountBalance,
  clearBalanceCache,
} from '../src/aliyun-api.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274C ${name}  ${extra}`); }
}

console.log('===== B6：markdownSafe 必须查下划线 =====');

// —— 核心回归：这一条如果失败，说明 B6 又漏了 ——
// 机器名带一个下划线是最常见的场景（用户自己起的 web_server 就有一个）
check('单个下划线判为不安全',
  markdownSafe('机器 web_server') === false);
check('自动命名的机器名（含 2 个下划线，偶数）判为安全',
  markdownSafe('机器 cn-hongkong_主账号_1a2b') === true);
check('自动命名的机器名（含 1 个下划线）判为不安全',
  markdownSafe('cn-hongkong_主账号') === false);
check('成对下划线判为安全',
  markdownSafe('_斜体_ 正常文本') === true);
check('两个下划线（各自落单）判为安全（成偶数）',
  markdownSafe('web_server db_server') === true);
check('三个下划线判为不安全',
  markdownSafe('a_b_c_d') === false);
check('用户自定义机器名 web_server 判为不安全',
  markdownSafe('web_server') === false);

// 原有能力不能被破坏
check('单个星号仍判为不安全', markdownSafe('只有 * 一个') === false);
check('成对星号仍判为安全', markdownSafe('*加粗*') === true);
check('单个反引号仍判为不安全', markdownSafe('` 落单') === false);
check('方括号不配对仍判为不安全', markdownSafe('[未闭合') === false);
check('方括号配对仍判为安全', markdownSafe('[标题](链接)') === true);
check('波浪号落单判为不安全（删除线标记）', markdownSafe('~ 一个') === false);
check('空文本判为安全', markdownSafe('') === true);
check('null 判为安全', markdownSafe(null) === true);
check('undefined 判为安全', markdownSafe(undefined) === true);
check('纯中文无标记判为安全', markdownSafe('机器运行正常，流量 12GB') === true);

console.log('\n===== B7：消息长度分片 =====');

check('短文本不分片（返回 1 段）', splitMessage('短消息').length === 1);
check('短文本原样返回', splitMessage('短消息')[0] === '短消息');
check('空文本返回空数组', splitMessage('').length === 0);
check('null 返回空数组', splitMessage(null).length === 0);

// 构造超长文本：200 行，每行 40 字符 = 8000 字符，必然超限
const longLines = [];
for (let i = 1; i <= 200; i += 1) {
  longLines.push(`第 ${i} 行：${'内容'.repeat(18)}`);
}
const longText = longLines.join('\n');
check('超长文本确实超过 3800 字符', longText.length > 3800,
  `实际 ${longText.length}`);
const parts = splitMessage(longText);
check('超长文本被分成多段', parts.length > 1, `实际 ${parts.length} 段`);
check('每段都不超过 3800 字符（留出续页标记余量）',
  parts.every((p) => p.length <= 3800),
  `最长 ${Math.max(...parts.map((p) => p.length))}`);
check('所有段落拼起来内容无丢失',
  parts.join('\n').replace(/\n+/g, '\n') === longText.replace(/\n+/g, '\n'),
  `原文 ${longText.length} 字符，拼回 ${parts.join('\n').length} 字符`);

// 单行就超长的极端情况（例如阿里云返回一大段报错原文）
const oneHugeLine = 'X'.repeat(9000);
const hugeParts = splitMessage(oneHugeLine);
check('单行超长也能分片（不丢内容）', hugeParts.length > 1);
check('单行分片后内容完整',
  hugeParts.join('') === oneHugeLine,
  `原文 ${oneHugeLine.length}，拼回 ${hugeParts.join('').length}`);
check('单行分片每段都不超限',
  hugeParts.every((p) => p.length <= 3800));

// 恰好等于上限的边界
const exactLimit = 'Y'.repeat(3800);
check('恰好 3800 字符不分片', splitMessage(exactLimit).length === 1);
const justOver = 'Y'.repeat(3801);
check('3801 字符会分片', splitMessage(justOver).length === 2);

console.log('\n===== B7：续页标记 =====');

check('单段不加续页标记', withPageMarker('正文', 0, 1) === '正文');
check('多段第 1 段加标记', withPageMarker('正文', 0, 3).includes('第 1/3 段'));
check('多段最后 1 段加标记', withPageMarker('正文', 2, 3).includes('第 3/3 段'));
check('标记不会破坏正文', withPageMarker('重要内容', 1, 2).startsWith('重要内容'));

console.log('\n===== B9/B10：特殊字符净化 =====');

const dirty = '机器 web_server 报错 [已停止] *注意* `代码` ~删除~';
const clean = neutralizeMarkdown(dirty);
check('净化后不含下划线', !clean.includes('_'), clean);
check('净化后不含星号', !clean.includes('*'), clean);
check('净化后不含反引号', !clean.includes('`'), clean);
check('净化后不含方括号', !clean.includes('[') && !clean.includes(']'), clean);
check('净化后不含波浪号', !clean.includes('~'), clean);
check('净化后下划线变成连字符（视觉相近）', clean.includes('web-server'), clean);
check('净化后中文内容完整保留', clean.includes('机器') && clean.includes('已停止'), clean);
check('净化后文本本身是 Markdown 安全的', markdownSafe(clean) === true);
check('净化空串不报错', neutralizeMarkdown('') === '');
check('净化 null 不报错', neutralizeMarkdown(null) === '');
check('净化 undefined 不报错', neutralizeMarkdown(undefined) === '');

// 控制字符必须被清掉（它们会让 Telegram 拒收或显示异常）
const withControl = `正常文本${String.fromCharCode(0)}${String.fromCharCode(7)}结束`;
const cleanControl = neutralizeMarkdown(withControl);
check('控制字符被替换成空格', !cleanControl.includes(String.fromCharCode(0))
  && !cleanControl.includes(String.fromCharCode(7)), JSON.stringify(cleanControl));
check('换行符必须保留（否则报表全挤成一坨）',
  neutralizeMarkdown('第一行\n第二行').includes('\n'));
check('制表符必须保留', neutralizeMarkdown('A\tB').includes('\t'));

// 落单的星号是真凶：它会和标题的加粗标记配成一对
const title = '止损关机失败';
const bodyWithStar = `机器: A\n错误: 请求失败 *最关键的一点`;
check('标题+正文含落单星号时判为不安全（证实问题存在）',
  markdownSafe(`${title}\n${bodyWithStar}`) === false);
check('净化正文后整体变安全（证实修复有效）',
  markdownSafe(`${title}\n${neutralizeMarkdown(bodyWithStar)}`) === true);

console.log('\n===== B5：子请求预算 =====');

resetSubrequestCount();
check('重置后计数为 0', getSubrequestCount() === 0);
check('重置后预算未耗尽', isSubrequestBudgetExhausted() === false);

// 余额查询在「同一 AK、同一轮」内只真正发一次请求（B8 的验证）
resetSubrequestCount();
clearBalanceCache();
// 故意指向一个必然失败的地址，避免测试真的联网
// （getAccountBalance 内部会尝试多个端点，全部失败后返回 { amount: null }）
globalThis.fetch = async () => {
  throw new Error('测试环境不联网');
};
const first = await getAccountBalance('AK_TEST_0001', 'SK_TEST', 'cn-hangzhou');
const afterFirst = getSubrequestCount();
const second = await getAccountBalance('AK_TEST_0001', 'SK_TEST', 'cn-hangzhou');
const afterSecond = getSubrequestCount();
check('首次查询会真正发起请求（计数 > 0）', afterFirst > 0, `计数 ${afterFirst}`);
check('同一 AK 第二次查询**不再发起请求**（走缓存，计数不变）',
  afterSecond === afterFirst, `第一次后 ${afterFirst}，第二次后 ${afterSecond}`);
check('缓存命中返回同样结果',
  JSON.stringify(first) === JSON.stringify(second),
  `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
check('查询失败也返回 { amount: null } 而不是抛异常', first.amount === null);

// 不同 AK 应该各查一次（缓存按 AK 区分）
const beforeOther = getSubrequestCount();
await getAccountBalance('AK_TEST_0002', 'SK_TEST', 'cn-hangzhou');
check('换一个 AK 会重新查询（缓存按账号区分）',
  getSubrequestCount() > beforeOther,
  `之前 ${beforeOther}，之后 ${getSubrequestCount()}`);

check('BudgetExhaustedError 是可识别的错误类型',
  new BudgetExhaustedError() instanceof Error);
check('BudgetExhaustedError 带 name 便于日志分辨',
  new BudgetExhaustedError().name === 'BudgetExhaustedError');

// 预算耗尽后，余额查询应当抛预算错误而不是继续发请求
resetSubrequestCount();
clearBalanceCache();
// 把预算烧掉：反复查询不同 AK 直到耗尽
let burned = 0;
let budgetErrorSeen = false;
for (let i = 0; i < 200 && !budgetErrorSeen; i += 1) {
  try {
    await getAccountBalance(`AK_BURN_${i}`, 'SK', 'cn-hangzhou');
    burned = getSubrequestCount();
  } catch (error) {
    budgetErrorSeen = error instanceof BudgetExhaustedError;
    break;
  }
}
check('持续查询最终会触发预算保护', budgetErrorSeen || isSubrequestBudgetExhausted(),
  `已烧掉 ${burned} 个子请求，耗尽=${isSubrequestBudgetExhausted()}`);
check('预算耗尽后不会再无限发请求（有上限）',
  getSubrequestCount() <= 50,
  `计数 ${getSubrequestCount()}`);

// 恢复 fetch 以免影响后续
delete globalThis.fetch;

console.log('\n===== 告警令牌来源回退（第六轮线上抓到的严重 bug）=====');

// 背景：机器人令牌有两个来源 —— env.TELEGRAM_BOT_TOKEN（Cloudflare 加密变量）
// 与 config.telegram.bot_token（配置字段）。一键脚本只写了前者，
// 而 sendAlert 原本只读后者 → 所有告警静默丢失，机器人却照常聊天。
// 这里验证「配置里没有令牌时，能从 env 回退取到」。
{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    return {
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    };
  };

  const configWithoutToken = { telegram: { chat_id: '999' } };

  // 情形 1：配置没令牌、env 有令牌 → 必须能发出去
  const ok1 = await sendAlert(
    configWithoutToken, '流量超标已止损', '机器: A\n当前流量: 200GB',
    'danger', null, null, { TELEGRAM_BOT_TOKEN: '111:FAKE-TOKEN-FOR-TEST' }
  );
  check('配置里没令牌时能从 env 回退发出告警（修复的核心）',
    ok1 === true && calls.length > 0,
    `返回 ${ok1}，请求数 ${calls.length}`);

  // 情形 2：env 通过 config.__env 挂载（guard.checkOne 的做法）
  calls.length = 0;
  const configWithHiddenEnv = { telegram: { chat_id: '999' } };
  Object.defineProperty(configWithHiddenEnv, '__env', {
    value: { TELEGRAM_BOT_TOKEN: '222:FAKE-TOKEN-FOR-TEST' },
    enumerable: false,
  });
  const ok2 = await sendAlert(
    configWithHiddenEnv, '凭据失效', '账号 AK 已失效', 'danger'
  );
  check('能从 config.__env 回退取到令牌（六处老调用点不用改签名）',
    ok2 === true && calls.length > 0,
    `返回 ${ok2}，请求数 ${calls.length}`);
  check('config.__env 不会被 JSON 序列化带走（密钥不进 KV）',
    JSON.stringify(configWithHiddenEnv).indexOf('FAKE-TOKEN') < 0,
    JSON.stringify(configWithHiddenEnv));

  // 情形 3：两处都没有令牌 → 必须返回 false，且不能瞎发请求
  calls.length = 0;
  const ok3 = await sendAlert(
    { telegram: { chat_id: '999' } }, '测试', '正文', 'info', null, null, {}
  );
  check('两处都没有令牌时返回 false（不假装成功）', ok3 === false);
  check('没有令牌时不发起任何请求', calls.length === 0, `请求数 ${calls.length}`);

  // 情形 4：配置里的令牌优先（向后兼容原有写法）
  calls.length = 0;
  const ok4 = await sendAlert(
    { telegram: { bot_token: '333:FAKE-CONFIG-TOKEN', chat_id: '999' } },
    '测试', '正文', 'info', null, null,
    { TELEGRAM_BOT_TOKEN: '444:FAKE-ENV-TOKEN' }
  );
  check('配置里有令牌时正常工作（向后兼容）', ok4 === true && calls.length > 0);
  check('配置里的令牌优先于 env',
    calls.length > 0 && calls[0].url.includes('333:FAKE-CONFIG-TOKEN'),
    calls.length ? calls[0].url.replace(/bot\d+:[^/]+/, 'bot<TOKEN>') : '无请求');

  // 情形 5：Chat ID 也能从 env 回退
  calls.length = 0;
  const ok5 = await sendAlert(
    { telegram: {} }, '测试', '正文', 'info', null, null,
    { TELEGRAM_BOT_TOKEN: '555:FAKE-TOKEN-FOR-TEST', TELEGRAM_CHAT_ID: '888' }
  );
  check('Chat ID 也能从 env 回退', ok5 === true && calls.length > 0);

  delete globalThis.fetch;
}

console.log('\n===== cron 日志不得出现 [object Object] =====');
{
  // 这个坑与机器人回执是同一个病根，只是发生在 cron 的 console.log 里。
  // 第六轮部署后从 wrangler tail 实测日志里抓到的：
  //   [cron] 巡检完成: [object Object]
  const { formatInspectionSummary } = await import('../src/index.js');

  const cases = [
    [{ ok: true, checked: 1 }, (t) => t.includes('已检查 1 台')],
    [{ ok: true, checked: 5 }, (t) => t.includes('已检查 5 台')],
    [{ ok: true, checked: 0 }, (t) => t.includes('没有需要检查的机器')],
    [{ ok: true, skipped: true, checked: 0 }, (t) => t.includes('跳过')],
    [{ ok: true, checked: 3, partial: true, total: 10 },
      (t) => t.includes('部分完成') && t.includes('3/10') && t.includes('预算')],
    [{ ok: false, error: 'KV 读取超时' }, (t) => t.includes('失败') && t.includes('KV 读取超时')],
    [{ ok: false }, (t) => t.includes('失败')],
  ];
  for (const [summary, verify] of cases) {
    let text;
    try { text = formatInspectionSummary(summary); }
    catch (e) { check(`格式化 ${JSON.stringify(summary).slice(0, 40)}`, false, `抛异常 ${e.message}`); continue; }
    check(`格式化 ${JSON.stringify(summary).slice(0, 40)}`,
      verify(text) && !text.includes('object'), `实际：${text}`);
  }

  // 硬性守卫：任何异常输入都不得吐 [object Object]
  const evil = [null, undefined, 'oops', 42, [], { ok: true, checked: {} },
    { ok: true, checked: [] }, { ok: true, checked: null }];
  for (const s of evil) {
    let t;
    try { t = formatInspectionSummary(s); } catch (e) { t = `抛异常 ${e.message}`; }
    check(`异常输入不得出现 [object Object]（${JSON.stringify(s)}）`,
      !String(t).includes('[object Object]'), String(t));
  }
}

console.log(`\nTelegram 发送层自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
