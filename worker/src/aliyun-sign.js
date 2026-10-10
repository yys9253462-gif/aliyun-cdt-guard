/**
 * 阿里云 RPC 风格接口签名（在 Cloudflare Workers 里实现）
 *
 * 为什么要手写：Workers 里没法用阿里云官方 SDK（那是 Python/Java 的），
 * 只能用 Web Crypto 自己算签名。阿里云用的是 HMAC-SHA1。
 *
 * 签名流程（这是阿里云 RPC 风格的标准做法）：
 *   1. 收集所有公共参数 + 业务参数
 *   2. 按参数名做字典序排序
 *   3. 每项做 URL 编码后拼成 query 串（这就是 canonicalizedQueryString）
 *   4. 构造 StringToSign = 请求方法 + "&" + 编码后的"/" + "&" + 编码后的query串
 *   5. HMAC-SHA1 计算，密钥是 AccessKeySecret + "&"
 *   6. 结果 Base64 编码，得到 Signature
 */

const API_VERSION_ECS = '2014-05-26';

/** URL 编码规则（阿里云要求：把 + 编成 %20，* 编成 %2A，~ 不编码） */
function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/** Base64 编码 ArrayBuffer -> 字符串 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/**
 * 生成阿里云接口的签名与完整请求参数。
 *
 * @param {object} options
 *   - method       请求方法，固定 'POST'
 *   - action       接口名，如 'DescribeInstances'
 *   - version      接口版本，如 '2014-05-26'
 *   - accessKeyId  访问密钥编号
 *   - accessKeySecret 访问密钥（只用于算签名，不放进请求）
 *   - params       业务参数对象
 *   - nonce       随机串
 *   - timestamp   ISO8601 时间戳（UTC）
 * @returns {Promise<object>} 包含 signature 和全部待提交参数
 */
export async function signAliyunRpc(options) {
  const {
    method = 'POST',
    action,
    version,
    accessKeyId,
    accessKeySecret,
    params = {},
    nonce,
    timestamp,
  } = options;

  // 1. 公共参数（阿里云要求每次请求都带上这些）
  //
  // ⚠️ 注意 SignatureType 这个参数：它的值是**空字符串**，看起来毫无意义，
  //    但它**必须参与签名计算**，否则算出来的签名和阿里云对不上
  //    （会报 SignatureDoesNotMatch）。
  //    这是实测比对官方 SDK 输出才发现的坑 —— 文档里没强调这一点。
  const allParams = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    SignatureType: '',
    Timestamp: timestamp,
    Action: action,
    ...params,
  };

  // 2. 按参数名做字典序排序（阿里云强制要求）
  const sortedKeys = Object.keys(allParams).sort();

  // 3. 拼装 canonicalizedQueryString
  const canonicalParts = sortedKeys.map(
    (key) => `${percentEncode(key)}=${percentEncode(String(allParams[key]))}`
  );
  const canonicalQueryString = canonicalParts.join('&');

  // 4. 构造 StringToSign
  //    注意 method 要先转大写再编码，路径固定是 "/"
  const stringToSign =
    `${method.toUpperCase()}&${percentEncode('/')}&${percentEncode(canonicalQueryString)}`;

  // 5. HMAC-SHA1 计算（密钥后面要加一个 &，这是阿里云的约定）
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${accessKeySecret}&`),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(stringToSign)
  );

  // 6. Base64 得到最终签名
  const signature = toBase64(signatureBuffer);

  return { signature, allParams, canonicalQueryString };
}

/** 生成随机串（阿里云要求每次请求不同，防重放攻击） */
export function makeNonce() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < random.length; index += 1) {
    result += chars[random[index] % chars.length];
  }
  return result;
}

/** 生成 ISO8601 时间戳（UTC，形如 2026-10-10T07:46:31Z） */
export function makeTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 调用阿里云 ECS 接口。
 *
 * @param {object} config
 *   - accessKeyId / accessKeySecret
 *   - endpoint  形如 ecs.ap-southeast-6.aliyuncs.com
 *   - action / version / params
 */
export async function callAliyunEcs(config) {
  const {
    accessKeyId,
    accessKeySecret,
    endpoint,
    action,
    version = API_VERSION_ECS,
    params = {},
  } = config;

  const nonce = makeNonce();
  const timestamp = makeTimestamp();

  const { signature, allParams } = await signAliyunRpc({
    action,
    version,
    accessKeyId,
    accessKeySecret,
    params,
    nonce,
    timestamp,
  });

  // 签名也要作为参数提交（这是阿里云的要求）
  const finalParams = { ...allParams, Signature: signature };

  // 拼成 application/x-www-form-urlencoded 的请求体
  const body = Object.keys(finalParams)
    .map((key) => `${percentEncode(key)}=${percentEncode(String(finalParams[key]))}`)
    .join('&');

  const response = await fetch(`https://${endpoint}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }

  return {
    httpStatus: response.status,
    raw: text.slice(0, 800),
    parsed,
  };
}
