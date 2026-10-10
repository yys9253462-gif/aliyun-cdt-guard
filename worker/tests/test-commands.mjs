/**
 * 命令注册一致性自检
 *
 * 为什么专门写这一组：
 *   Telegram 的「/」命令菜单（输入框旁边那个）需要**单独注册**，
 *   和代码里 handleCommand 的 case 分支是**两份清单**。
 *   两份清单一旦走偏，用户会遇到两种最恼人的情况：
 *     A. 菜单里能点，点了机器人说「没听懂这个命令」（代码没处理）
 *     B. 命令明明能用，但菜单里找不到（用户根本不知道有这功能）
 *   B 这种情况**不报错、不崩溃**，只有横向比对两份清单才能发现。
 *   —— /cancel 就真实踩过这个坑：代码里处理了，但没注册，菜单里看不见。
 *
 * 本组不联网、不读线上数据，纯静态比对。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

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

const listenerSrc = readFileSync(join(SRC, 'bot-listener.js'), 'utf8');
const telegramSrc = readFileSync(join(SRC, 'telegram.js'), 'utf8');

// ---------------------------------------------------------------------------
console.log('--- 1. 提取「代码实际处理」的命令清单 ---');

// handleCommand 里 case 'xxx': 的分支就是实际能用的命令
const handledMatch = listenerSrc.match(
  /function handleCommand[\s\S]*?\n\}/
);
const handledBlock = handledMatch ? handledMatch[0] : '';
const handled = new Set(
  [...handledBlock.matchAll(/case\s+'([a-z]+)'\s*:/g)].map((m) => m[1])
);

// 'start' 是 Telegram 的默认起始命令，通常作为 menu 的别名，不算独立注册项
const ALIASES = new Set(['start']);

const handledReal = [...handled].filter((c) => !ALIASES.has(c));

console.log(`  代码中处理: ${[...handled].sort().join(', ')}`);
check('至少提取到 5 个命令分支', handledReal.length >= 5, `实际 ${handledReal.length}`);
check('包含 cancel（添加账号流程要用）', handled.has('cancel'));
check('包含 menu', handled.has('menu'));

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 2. 提取「已注册到 Telegram 菜单」的命令清单 ---');

const regMatch = telegramSrc.match(
  /export async function registerCommands[\s\S]*?\n\}/
);
const regBlock = regMatch ? regMatch[0] : '';
const registered = new Set(
  [...regBlock.matchAll(/command:\s*'([a-z]+)'/g)].map((m) => m[1])
);

console.log(`  已注册到菜单: ${[...registered].sort().join(', ')}`);
check('注册清单非空', registered.size > 0);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 3. 两份清单必须一致（这是本测试存在的理由） ---');

// A. 代码处理了但没注册 → 用户看不见这个功能，更容易在报错时困惑
const missingInMenu = handledReal.filter((c) => !registered.has(c));
check(
  '代码里处理的命令都注册进了菜单（否则用户看不见）',
  missingInMenu.length === 0,
  missingInMenu.length ? `漏注册: ${missingInMenu.join(', ')}` : ''
);

// B. 注册了但代码没处理 → 用户点了却被告知「没听懂」，体验最差
const missingInCode = [...registered].filter((c) => !handled.has(c));
check(
  '菜单里注册的命令代码都处理了（否则点了报「没听懂」）',
  missingInCode.length === 0,
  missingInCode.length ? `无处理分支: ${missingInCode.join(', ')}` : ''
);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 4. 注册项本身的格式要求 ---');

const cmdEntries = [...regBlock.matchAll(
  /command:\s*'([a-z]+)',\s*description:\s*'([^']*)'/g
)].map((m) => ({ command: m[1], description: m[2] }));

check('每项都有 command 和 description', cmdEntries.length === registered.size,
  `${cmdEntries.length} vs ${registered.size}`);

// Telegram 要求命令名 1-32 字符、只含小写字母数字下划线
check('命令名都符合 Telegram 规则（小写字母数字下划线）',
  cmdEntries.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command)));

// 描述不能超 256 字符；且按老大的要求必须是中文
check('描述都不超过 256 字符',
  cmdEntries.every((c) => c.description.length <= 256));
check('描述都是中文（不出现英文单词）',
  cmdEntries.every((c) => !/[A-Za-z]{2,}/.test(c.description)),
  cmdEntries.filter((c) => /[A-Za-z]{2,}/.test(c.description))
    .map((c) => c.command).join(', '));
check('描述都不为空', cmdEntries.every((c) => c.description.trim().length > 0));

// 命令名不得重复（Telegram 会拒绝或行为不可预期）
const cmdNames = cmdEntries.map((c) => c.command);
check('命令名无重复', new Set(cmdNames).size === cmdNames.length);

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 5. 帮助文案要覆盖新增命令 ---');

const helpMatch = listenerSrc.match(/const HELP_TEXT[\s\S]*?`;/);
const helpText = helpMatch ? helpMatch[0] : '';
check('使用说明里提到了 /cancel',
  helpText.includes('/cancel'));
check('使用说明里提到了添加账号',
  helpText.includes('添加阿里云账号') || helpText.includes('添加账号'));

// ---------------------------------------------------------------------------
console.log('');
console.log(`===== 命令注册自检: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
