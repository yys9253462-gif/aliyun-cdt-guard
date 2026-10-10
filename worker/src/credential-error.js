/**
 * 凭据错误的识别与中文翻译（唯一事实来源）
 *
 * 为什么单独拆一个模块：
 *   同一个「AK 失效」的报错，会在**两个完全不同的场景**里出现：
 *     1. 添加账号时 —— 用户就坐在手机前等着，需要立刻告诉他哪里填错了
 *     2. 巡检时     —— 用户没在看，是定时任务撞上的，要发告警通知
 *   一开始这两处的文案是各写各的：添加账号那套写得很细（还分门别类），
 *   巡检那套只把阿里云的英文原话原样贴出去 —— 用户半夜收到一条
 *   「InvalidAccessKeyId.NotFound」，根本不知道该干嘛。
 *
 *   所以把识别逻辑收成**一份**，两个场景都调它。
 *   这与本项目「两份必须同步的清单早晚走偏」的教训是同一条。
 *
 * ⚠️ 判定原则：**能确定是「凭据坏了」才说是凭据问题**。
 *    网络抖动、限流这些是**暂时性**的，不能误报成「你的 Key 失效了」，
 *    否则用户会跑去阿里云白折腾一通。所以这里把错误分成两类：
 *      · 确定性凭据错误（CRED_ERR_*）—— 必须换 Key，不换就一直坏
 *      · 暂时性错误（TRANSIENT）      —— 等一会儿自己会好
 */

/**
 * 错误分类。
 *
 * CREDENTIAL —— 凭据本身的问题，**不处理就永远好不了**。
 *               这类要单独走「高优先级告警」通道，不受普通冷却压制。
 * TRANSIENT  —— 网络/限流等暂时性问题，**等一会儿会自己好**。
 *               这类走普通冷却，避免刷屏。
 * UNKNOWN    —— 认不出来，按暂时性处理（宁可少报，不可误报）。
 */
export const ERR_CREDENTIAL = 'credential';
export const ERR_TRANSIENT = 'transient';
export const ERR_UNKNOWN = 'unknown';

/**
 * 识别一条阿里云错误属于哪一类。
 *
 * @param {Error|string} error
 * @returns {{kind: string, reason: string, raw: string}}
 *   kind   —— ERR_CREDENTIAL / ERR_TRANSIENT / ERR_UNKNOWN
 *   reason —— 给人看的中文说明（含阿里云原话 + 下一步动作）
 *   raw    —— 阿里云/网络的原始报错文本
 */
export function classifyError(error) {
  const raw = sanitize(String((error && error.message) || error || ''));

  // ---- 确定性凭据错误：这几类不换 Key / 不改权限，永远不会好 ----

  if (/InvalidAccessKeyId|AccessKeyId.*(?:NotFound|not exist)/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}\n\n这个访问密钥 ID 阿里云不认识。多半是复制时漏了字符，或这对密钥已被删除。`,
    };
  }
  if (/SignatureDoesNotMatch/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}\n\n访问密钥口令不对（签名对不上）。多半是复制时漏了字符或多带了空格。`,
    };
  }
  if (/InvalidAccessKeySecret|access key secret.*invalid/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}\n\n访问密钥口令不对。请重新复制一次（注意别带上空格）。`,
    };
  }
  // ⚠️ Ram 必须带词边界，且必须处在**权限语境**里，否则会大面积误伤：
  //    · 「Invalid parameter」「program failed」「grammar error」里都含 ram，
  //      被 i 标志一匹配就全判成「密钥权限不足」——而阿里云的参数校验错误
  //      恰好大量带 parameter，用户会被引去白折腾 RAM 权限（实测踩过）。
  //    · 裸的 \bRAM\b 也不行：「ram usage high」（内存占用高）会被误判。
  //      阿里云权限类报错一定是「RAM + 权限词」共现（如 Forbidden.RAM、
  //      RAM ... not authorized），所以要求两者同时出现才算数。
  const permWord = /Forbidden|no permission|not authorized|\bdenied\b|not allowed/i;
  const ramPerm = /\bRAM\b[\s\S]{0,40}?(?:not authorized|no permission|denied|forbidden|not allowed|权限|授权)/i
    || /(?:Forbidden\.RAM|RAM\.(?:NoPermission|PolicyDenied))/i;
  if (permWord.test(raw) || ramPerm.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}\n\n这把密钥的权限不够。请在阿里云访问控制里给它加上「云服务器只读」权限，\n否则查不到机器。`,
    };
  }
  // 阿里云在密钥被禁用/过期时也会返回类似令牌的报错
  if (/SecurityToken|token.*(?:expired|invalid)/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}\n\n这对密钥已失效（可能被禁用或过期）。请去阿里云重新生成后再配置。`,
    };
  }

  // ---- 暂时性错误：等一会儿会自己好，不要误报成「密钥失效」----

  if (/Throttl|FlowControl|TooManyRequests|RequestLimit/i.test(raw)) {
    return {
      kind: ERR_TRANSIENT,
      raw,
      reason: `${raw}\n\n请求太频繁被阿里云限流了。等一分钟再试一次。`,
    };
  }
  if (/timeout|timed out|ETIMEDOUT|network|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|无响应|非 JSON/i.test(raw)) {
    return {
      kind: ERR_TRANSIENT,
      raw,
      reason: `${raw}\n\n连不上阿里云。可能是网络出口的临时问题，稍后再试。`,
    };
  }

  return {
    kind: ERR_UNKNOWN,
    raw,
    reason: raw || '未知原因（阿里云没有返回具体说明）。',
  };
}

/**
 * 只取「给人看的中文原因」。给添加账号那种「一次性展示」的场景用。
 *
 * 保留这个函数是为了不破坏原有调用点 —— 原来的 credentialReason()
 * 就是这个行为，现在内部转调 classifyError，语义不变。
 */
export function credentialReason(error) {
  return classifyError(error).reason;
}

/** 判断这条错误是不是「确定性凭据问题」（需要用户动手才能修好） */
export function isCredentialError(error) {
  return classifyError(error).kind === ERR_CREDENTIAL;
}

/**
 * 遮蔽敏感串。
 *
 * 为什么这里要自带一份而不是 import common：
 *   这个模块会被 account-scan 和 guard 两边引用，而 common 里又引了
 *   KV 相关的东西 —— 保持本模块**零内部依赖**，避免以后出现循环引用。
 *   本函数逻辑与 common.sanitize 一致（把疑似密钥的长串打码）。
 */
function sanitize(text) {
  return String(text || '')
    // 阿里云的 AK 固定 LTAI 开头，整串打掉
    .replace(/LTAI[A-Za-z0-9]{6,}/g, 'LTAI****')
    // 长的高熵串（疑似 Secret）也打掉，但别误伤普通英文句子
    .replace(/\b[A-Za-z0-9]{24,}\b/g, '****');
}
