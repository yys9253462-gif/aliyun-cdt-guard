function percentEncode(value) {
  return encodeURIComponent(value).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
async function signAliyunRpc(options) {
  const {
    method = "POST",
    action,
    version,
    accessKeyId,
    accessKeySecret,
    params = {},
    nonce,
    timestamp
  } = options;
  const allParams = {
    Format: "JSON",
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: nonce,
    SignatureVersion: "1.0",
    SignatureType: "",
    Timestamp: timestamp,
    Action: action,
    ...params
  };
  const sortedKeys = Object.keys(allParams).sort();
  const canonicalParts = sortedKeys.map(
    (key) => `${percentEncode(key)}=${percentEncode(String(allParams[key]))}`
  );
  const canonicalQueryString = canonicalParts.join("&");
  const stringToSign = `${method.toUpperCase()}&${percentEncode("/")}&${percentEncode(canonicalQueryString)}`;
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${accessKeySecret}&`),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(stringToSign)
  );
  const signature = toBase64(signatureBuffer);
  return { signature, allParams, canonicalQueryString };
}
function makeNonce() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < random.length; index += 1) {
    result += chars[random[index] % chars.length];
  }
  return result;
}
function makeTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export { makeNonce, makeTimestamp, percentEncode, signAliyunRpc, toBase64 };
