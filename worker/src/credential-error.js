function classifyError(error) {
  const raw = sanitize2(String(error && error.message || error || ""));
  if (/InvalidAccessKeyId|AccessKeyId.*(?:NotFound|not exist)/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}

这个访问密钥 ID 阿里云不认识。多半是复制时漏了字符，或这对密钥已被删除。
如果你刚换过密钥：点「➕ 添加账号」把这台机器重新填一遍即可 —— 同一台机器会**原地更新凭据**，不会多出一台。`
    };
  }
  if (/SignatureDoesNotMatch/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}

访问密钥口令不对（签名对不上）。多半是复制时漏了字符或多带了空格。`
    };
  }
  if (/InvalidAccessKeySecret|access key secret.*invalid/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}

访问密钥口令不对。请重新复制一次（注意别带上空格）。`
    };
  }
  const permWord = /Forbidden|no permission|not authorized|\bdenied\b|not allowed/i;
  const ramPerm = /\bRAM\b[\s\S]{0,40}?(?:not authorized|no permission|denied|forbidden|not allowed|权限|授权)/i;
  if (permWord.test(raw) || ramPerm.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}

这把密钥的权限不够。请在阿里云访问控制里给它加上「云服务器只读」权限，
否则查不到机器。`
    };
  }
  if (/SecurityToken|token.*(?:expired|invalid)/i.test(raw)) {
    return {
      kind: ERR_CREDENTIAL,
      raw,
      reason: `${raw}

这对密钥已失效（可能被禁用或过期）。请去阿里云重新生成后再配置。`
    };
  }
  if (/Throttl|FlowControl|TooManyRequests|RequestLimit/i.test(raw)) {
    return {
      kind: ERR_TRANSIENT,
      raw,
      reason: `${raw}

请求太频繁被阿里云限流了。等一分钟再试一次。`
    };
  }
  if (/timeout|timed out|ETIMEDOUT|network|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|无响应|非 JSON/i.test(raw)) {
    return {
      kind: ERR_TRANSIENT,
      raw,
      reason: `${raw}

连不上阿里云。可能是网络出口的临时问题，稍后再试。`
    };
  }
  return {
    kind: ERR_UNKNOWN,
    raw,
    reason: raw || "未知原因（阿里云没有返回具体说明）。"
  };
}
function credentialReason(error) {
  return classifyError(error).reason;
}
function isCredentialError(error) {
  return classifyError(error).kind === ERR_CREDENTIAL;
}
function sanitize2(text) {
  return String(text || "").replace(/LTAI[A-Za-z0-9]{6,}/g, "LTAI****").replace(/\b[A-Za-z0-9]{24,}\b/g, "****");
}
var ERR_CREDENTIAL, ERR_TRANSIENT, ERR_UNKNOWN;
ERR_CREDENTIAL = "credential";
ERR_TRANSIENT = "transient";
ERR_UNKNOWN = "unknown";

export { ERR_CREDENTIAL, ERR_TRANSIENT, ERR_UNKNOWN, classifyError, credentialReason, isCredentialError, sanitize2 };
