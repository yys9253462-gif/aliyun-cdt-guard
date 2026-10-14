function nowLocal() {
  const now = /* @__PURE__ */ new Date();
  return new Date(now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1e3);
}
// 当前计费周期（北京时间 YYYY-MM），测试与报表共用
function currentBillingCycle() {
  return formatDate(nowLocal()).slice(0, 7);
}
function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function formatTime(date) {
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}
function sanitize(text) {
  return redact(String(text === void 0 || text === null ? "" : text)).replace(/[_*`\[\]]/g, " ").trim();
}
function redact(text) {
  let result = String(text === void 0 || text === null ? "" : text);
  for (const key of SECRET_KEYS) {
    const pattern = new RegExp(
      `["']?${key}["']?\\s*[=:]\\s*["']?[^&\\s,}\\]"']*["']?`,
      "gi"
    );
    result = result.replace(pattern, "[已隐藏]");
  }
  result = result.replace(/LTAI[A-Za-z0-9]{6,}/g, "[已隐藏]");
  result = result.replace(/\b[A-Za-z0-9]{24,}\b/g, (m) => {
    if (/[A-Z]/.test(m) && /[a-z]/.test(m)) {
      return "[已隐藏]";
    }
    return m;
  });
  return result;
}
function formatMoney(amount, currency, defaultSymbol = "$") {
  if (amount === null || amount === void 0 || amount < 0) {
    return "查询失败";
  }
  const symbols = { CNY: "\xA5", USD: "$" };
  const symbol = symbols[currency] || defaultSymbol;
  return `${symbol}${Number(amount).toFixed(2)}`;
}
function bucket(env) {
  return env && env.CDT_GUARD_KV || null;
}
async function loadConfig(env) {
  let config = bucket(env) ? await bucket(env).get(KV_CONFIG, "json") : null;
  if (!config && env.CONFIG_JSON) {
    try {
      config = JSON.parse(env.CONFIG_JSON);
    } catch (error) {
      console.error("环境变量里的配置不是合法 JSON:", error.message);
    }
  }
  if (!config) {
    return { users: [], telegram: {} };
  }
  if (!config.telegram && config.bot_token) {
    config.telegram = {
      bot_token: config.bot_token,
      chat_id: config.chat_id,
      admin_ids: config.admin_ids || [config.chat_id]
    };
  }
  if (!Array.isArray(config.users)) {
    config.users = [];
  }
  return config;
}
async function saveConfig(env, config) {
  if (!bucket(env)) {
    throw new Error("未绑定 KV 存储，无法保存配置");
  }
  config._revision = String(Number(config._revision || 0) + 1);
  await bucket(env).put(KV_CONFIG, JSON.stringify(config));
}
async function loadState(env) {
  if (!bucket(env)) {
    return {};
  }
  const state = await bucket(env).get(KV_STATE, "json");
  return state || {};
}
async function saveState(env, state) {
  if (!bucket(env)) {
    return false;
  }
  try {
    await bucket(env).put(KV_STATE, JSON.stringify(state));
    return true;
  } catch (error) {
    console.log(`[状态] 写入失败（不影响本轮巡检继续）: ${String(error && error.message || error)}`);
    return false;
  }
}
function eventAllowed(state, key, event, cooldown = NOTIFY_COOLDOWN) {
  const record = state[key] || {};
  const last = Number(record[event] || 0);
  return nowSeconds() - last >= cooldown;
}
function purgeDeviceState(state, instanceId) {
  const id = String(instanceId || "").trim();
  if (!id || !state) {
    return false;
  }
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(state, id)) {
    delete state[id];
    changed = true;
  }
  for (const key of Object.keys(state)) {
    if (key.startsWith(`${id}:`)) {
      delete state[key];
      changed = true;
    }
  }
  return changed;
}
async function clearDeviceState(env, instanceId) {
  const state = await loadState(env);
  const changed = purgeDeviceState(state, instanceId);
  if (changed) {
    await saveState(env, state);
  }
  return changed;
}
function markEvent(state, key, event) {
  if (!state[key]) {
    state[key] = {};
  }
  state[key][event] = nowSeconds();
}
function bumpCounter(state, key, counter, step = 1) {
  if (!state[key]) {
    state[key] = {};
  }
  state[key][counter] = Number(state[key][counter] || 0) + step;
  return state[key][counter];
}
function clearCounter(state, key, counter) {
  if (state[key]) {
    delete state[key][counter];
  }
}
async function loadHistory(env) {
  if (!bucket(env)) {
    return [];
  }
  const history = await bucket(env).get(KV_HISTORY, "json");
  return Array.isArray(history) ? history : [];
}
// 单条写入（测试与旧调用方用），内部走批量写入
async function appendTrafficHistory(env, instanceId, name, trafficGb) {
  await appendTrafficHistoryBatch(env, [{ instanceId, name, trafficGb }]);
}
async function appendTrafficHistoryBatch(env, entries) {
  if (!bucket(env)) {
    return false;
  }
  const list = Array.isArray(entries) ? entries : [];
  const valid = list.filter((e) => {
    const g = e && e.trafficGb;
    return e && e.instanceId && g !== null && g !== void 0 && Number(g) >= 0;
  });
  if (!valid.length) {
    return false;
  }
  try {
    const now = nowLocal();
    const day = formatDate(now);
    const time = formatTime(now);
    let history = await loadHistory(env);
    const touched = new Set(valid.map((e) => e.instanceId));
    history = history.filter(
      (item) => !(touched.has(item.instance_id) && item.date === day)
    );
    for (const e of valid) {
      history.push({
        instance_id: e.instanceId,
        name: e.name,
        date: day,
        time,
        traffic_gb: Math.round(Number(e.trafficGb) * 1e4) / 1e4
      });
    }
    const cutoffDate = new Date(now.getTime() - HISTORY_KEEP_DAYS * 86400 * 1e3);
    const cutoff = formatDate(cutoffDate);
    history = history.filter((item) => String(item.date || "") >= cutoff);
    history.sort((a, b) => {
      const left = `${a.date || ""} ${a.time || ""}`;
      const right = `${b.date || ""} ${b.time || ""}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    await bucket(env).put(KV_HISTORY, JSON.stringify(history));
    return true;
  } catch (error) {
    console.log(`[台账] 写入失败（不影响巡检）: ${String(error && error.message || error)}`);
    return false;
  }
}
async function loadSessions(env) {
  if (!bucket(env)) {
    return {};
  }
  const sessions = await bucket(env).get(KV_SESSION, "json");
  return sessions || {};
}
async function setCurrentDevice(env, chatId, instanceId) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  sessions[key] = Object.assign({}, sessions[key] || {}, {
    instanceId,
    at: nowSeconds()
  });
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function getCurrentDevice(env, chatId) {
  const sessions = await loadSessions(env);
  const record = sessions[String(chatId)];
  return record && nowSeconds() - Number(record.at || 0) <= 900 ? record.instanceId : null;
}
async function getWizard(env, chatId) {
  const sessions = await loadSessions(env);
  const record = sessions[String(chatId)] || {};
  const wizard = record.wizard;
  if (!wizard || typeof wizard !== "object") {
    return null;
  }
  const at = Number(wizard.at || 0);
  if (nowSeconds() - at > WIZARD_TTL_SECONDS) {
    await clearWizard(env, chatId);
    return null;
  }
  return wizard;
}
async function setWizard(env, chatId, wizard) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  sessions[key] = Object.assign({}, sessions[key] || {}, {
    wizard: Object.assign({}, wizard, { at: nowSeconds() })
  });
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function clearWizard(env, chatId) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  if (!sessions[key]) {
    return;
  }
  delete sessions[key].wizard;
  if (!Object.keys(sessions[key]).length) {
    delete sessions[key];
  }
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function setLimitWizard(env, chatId, wizard) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  sessions[key] = Object.assign({}, sessions[key] || {}, {
    limitWizard: Object.assign({}, wizard, { at: nowSeconds() })
  });
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function getLimitWizard(env, chatId) {
  const sessions = await loadSessions(env);
  const record = sessions[String(chatId)] || {};
  const wizard = record.limitWizard;
  if (!wizard || typeof wizard !== "object") {
    return null;
  }
  const at = Number(wizard.at || 0);
  if (nowSeconds() - at > WIZARD_TTL_SECONDS) {
    await clearLimitWizard(env, chatId);
    return null;
  }
  return wizard;
}
async function clearLimitWizard(env, chatId) {
  if (!bucket(env)) {
    return;
  }
  const sessions = await loadSessions(env);
  const key = String(chatId);
  if (!sessions[key]) {
    return;
  }
  delete sessions[key].limitWizard;
  if (!Object.keys(sessions[key]).length) {
    delete sessions[key];
  }
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function resetNavigation(env, chatId) {
  if (!bucket(env)) return;
  const sessions = await loadSessions(env);
  delete sessions[String(chatId)];
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function setNavigation(env, chatId, navigation) {
  if (!bucket(env)) return;
  const sessions = await loadSessions(env), key = String(chatId);
  sessions[key] = { ...sessions[key] || {}, navigation };
  await bucket(env).put(KV_SESSION, JSON.stringify(sessions));
}
async function getNavigation(env, chatId) {
  const sessions = await loadSessions(env);
  return sessions[String(chatId)]?.navigation || {};
}
var NOTIFY_COOLDOWN, OVERLIMIT_COOLDOWN, MONEY_COOLDOWN, QUOTA_COOLDOWN, QUOTA_WARN_LEVELS, DEFAULT_BALANCE_LIMIT, DEFAULT_BILL_LIMIT, TIMEZONE_OFFSET_HOURS, HISTORY_KEEP_DAYS, KV_CONFIG, KV_STATE, KV_HISTORY, KV_SESSION, SECRET_KEYS, WIZARD_TTL_SECONDS;
NOTIFY_COOLDOWN = 3600;
OVERLIMIT_COOLDOWN = 86400;
MONEY_COOLDOWN = 21600;
QUOTA_COOLDOWN = 86400;
QUOTA_WARN_LEVELS = [80, 95];
DEFAULT_BALANCE_LIMIT = 10;
DEFAULT_BILL_LIMIT = 0;
TIMEZONE_OFFSET_HOURS = 8;
HISTORY_KEEP_DAYS = 60;
KV_CONFIG = "config";
KV_STATE = "state";
KV_HISTORY = "traffic_history";
KV_SESSION = "sessions";
SECRET_KEYS = [
  "accesskeyid",
  "accesskeysecret",
  "signature",
  "signaturenonce",
  "securitytoken",
  "ststoken",
  "authorization",
  "credential",
  "bot_token"
];
WIZARD_TTL_SECONDS = 900;

export { appendTrafficHistory, currentBillingCycle, DEFAULT_BALANCE_LIMIT, DEFAULT_BILL_LIMIT, HISTORY_KEEP_DAYS, KV_CONFIG, KV_HISTORY, KV_SESSION, KV_STATE, MONEY_COOLDOWN, NOTIFY_COOLDOWN, OVERLIMIT_COOLDOWN, QUOTA_COOLDOWN, QUOTA_WARN_LEVELS, SECRET_KEYS, TIMEZONE_OFFSET_HOURS, WIZARD_TTL_SECONDS, appendTrafficHistoryBatch, bucket, bumpCounter, clearCounter, clearDeviceState, clearLimitWizard, clearWizard, eventAllowed, formatDate, formatMoney, formatTime, getCurrentDevice, getLimitWizard, getNavigation, getWizard, loadConfig, loadHistory, loadSessions, loadState, markEvent, nowLocal, nowSeconds, purgeDeviceState, redact, resetNavigation, sanitize, saveConfig, saveState, setCurrentDevice, setLimitWizard, setNavigation, setWizard };
