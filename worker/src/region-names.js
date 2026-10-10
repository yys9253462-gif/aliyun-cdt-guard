/**
 * 阿里云地域「代码 → 中文名」映射表
 *
 * 解决什么问题：
 *     阿里云接口返回的地域是**代码**（ap-southeast-6），不是给人看的。
 *     机器没起名时，以前会用代码拼出 `ap-southeast-6-3stsujw0r` 这样的名字 ——
 *     在 Telegram 菜单里很难一眼认出是哪个机房。
 *
 *     老大的原话：「加入的新机器会自动使用对应地区的中文名吗」
 *     → 答：以前不会，现在会了。
 *
 * ---------------------------------------------------------------------------
 * 数据来源（2026-10-10 用阿里云官方文档逐个核实，不是凭记忆写的）
 * ---------------------------------------------------------------------------
 *   · ECS 地域和可用区（中文/国际版）：
 *     https://help.aliyun.com/zh/ecs/user-guide/regions-and-zones
 *     https://www.alibabacloud.com/help/en/ecs/user-guide/regions-and-zones
 *   · 开服地域（含本地地域命名，如「华东5(南京-本地地域)」）：
 *     https://help.aliyun.com/knowledge_detail/252819.html
 *
 * ⚠️ 命名口径说明（很重要，别改错了）：
 *   1. 表里存的是**中文名**，不是完整的官方全称。
 *      官方叫「菲律宾(马尼拉)」，这里存「马尼拉」——
 *      因为这个名字会拼进机器名（`马尼拉-LTAI5t-3stsujw0r`），
 *      太长会把 Telegram 菜单按钮撑爆（见 menu-labels.js 的 DEVICE_NAME_MAX）。
 *   2. 有多个城市的地域取**城市名**（华北2 → 北京，不是「华北2」）——
 *      用户认得的是「北京」而不是「华北2」。
 *   3. 本地地域保留「本地」二字（南京本地 / 福州本地 / 武汉本地）——
 *      它们是独立于常规地域的产品形态，去掉「本地」会误导。
 *
 * 🔴 未知地域一定回退成**原代码**，不要回退成「未知地域」四个字。
 *    理由：回退成代码至少还能查出是哪儿（拿去搜索/查控制台都能用）；
 *    回退成「未知地域」等于把信息抹掉了，还分不清是哪台机器。
 */

/**
 * 地域代码 → 中文短名。
 *
 * 键必须是小写（查表时会先 toLowerCase）。
 */
export const REGION_CN = {
  // ---- 中国内地 ----
  'cn-qingdao': '青岛',
  'cn-beijing': '北京',
  'cn-zhangjiakou': '张家口',
  'cn-huhehaote': '呼和浩特',
  'cn-wulanchabu': '乌兰察布',
  'cn-hangzhou': '杭州',
  'cn-shanghai': '上海',
  'cn-nanjing': '南京本地',
  'cn-fuzhou': '福州本地',
  'cn-shenzhen': '深圳',
  'cn-heyuan': '河源',
  'cn-guangzhou': '广州',
  'cn-wuhan-lr': '武汉本地',
  'cn-chengdu': '成都',
  'cn-zhongwei': '中卫',

  // ---- 中国香港（属「非中国内地」，免费额度按 200GB 算）----
  'cn-hongkong': '中国香港',

  // ---- 亚太 ----
  'ap-southeast-1': '新加坡',
  'ap-southeast-2': '悉尼',
  'ap-southeast-3': '吉隆坡',
  'ap-southeast-4': '墨尔本',
  'ap-southeast-5': '雅加达',
  'ap-southeast-6': '马尼拉',
  'ap-southeast-7': '曼谷',
  'ap-southeast-8': '柔佛',
  'ap-northeast-1': '东京',
  'ap-northeast-2': '首尔',
  'ap-south-1': '孟买',

  // ---- 北美 ----
  'us-west-1': '硅谷',
  'us-east-1': '弗吉尼亚',
  'us-southeast-1': '亚特兰大',
  'na-south-1': '墨西哥',

  // ---- 欧洲 ----
  'eu-central-1': '法兰克福',
  'eu-west-1': '伦敦',
  'eu-west-2': '巴黎',

  // ---- 中东 / 南美 ----
  'me-east-1': '迪拜',
  'me-central-1': '利雅得',
  'sa-east-1': '圣保罗',

  // ---- 金融云（少数用户会用，一并给中文名）----
  'cn-hangzhou-finance': '杭州金融云',
  'cn-shanghai-finance-1': '上海金融云',
  'cn-shenzhen-finance-1': '深圳金融云',
  'cn-beijing-finance-1': '北京金融云',
};

/**
 * 把地域代码转成给人看的中文名。
 *
 * 行为约定：
 *   · 已知地域 → 中文名（`ap-southeast-6` → `马尼拉`）
 *   · 未知地域 → **原样返回代码**（`xx-somewhere-9` → `xx-somewhere-9`）
 *   · 空值     → `未知地域`
 *
 * @param {string} region 地域代码
 * @returns {string} 中文名或原代码
 */
export function regionDisplayName(region) {
  const code = String(region || '').trim();
  if (!code) return '未知地域';
  return REGION_CN[code.toLowerCase()] || code;
}

/**
 * 把地域代码渲染成「中文名（代码）」的形式。
 *
 * 为什么要带代码：中文名好认，但代码是**唯一标识**——
 * 复制到控制台、拿去搜索、跟阿里云工单沟通时都要用代码。
 * 两个都给，用户既认得出也不会用错。
 *
 * 例：`ap-southeast-6` → `马尼拉（ap-southeast-6）`
 */
export function regionDisplayWithCode(region) {
  const code = String(region || '').trim();
  if (!code) return '未知地域';
  const cn = REGION_CN[code.toLowerCase()];
  // 未知地域就不要画蛇添足成「xx-somewhere-9（xx-somewhere-9）」
  return cn ? `${cn}（${code}）` : code;
}

/**
 * 判断这个地域代码我们认不认识。
 *
 * 用途：给用户提示「这个地域比较新，我还不认识它的中文名」，
 * 而不是悄悄显示一串代码让他莫名其妙。
 */
export function isKnownRegion(region) {
  const code = String(region || '').trim().toLowerCase();
  return Boolean(code) && Object.prototype.hasOwnProperty.call(REGION_CN, code);
}
