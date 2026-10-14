function shortIdTail(instanceId) {
  const id = String(instanceId || "").trim();
  if (!id) return "";
  return id.length <= DEVICE_ID_TAIL ? id : id.slice(-DEVICE_ID_TAIL);
}
function buildDeviceButton(name, paused = false, instanceId = "") {
  let shortName = String(name || "未命名");
  if (shortName.length > DEVICE_NAME_MAX) {
    shortName = `${shortName.slice(0, DEVICE_NAME_MAX)}…`;
  }
  const mark = paused ? ` ${PAUSED_MARK}` : "";
  const tail = shortIdTail(instanceId);
  const idPart = tail ? ` [${tail}]` : "";
  return `${DEVICE_PREFIX}${shortName}${mark}${idPart}`;
}
function parseDeviceButton(text) {
  const raw = String(text || "");
  if (!raw.startsWith(DEVICE_PREFIX)) {
    return null;
  }
  let rest = raw.slice(DEVICE_PREFIX.length).trim();
  let idTail = "";
  const m = rest.match(/\s*\[([0-9a-zA-Z-]{1,64})\]\s*$/);
  if (m) {
    idTail = m[1];
    rest = rest.slice(0, m.index).trim();
  }
  if (rest.endsWith(PAUSED_MARK)) {
    rest = rest.slice(0, -PAUSED_MARK.length).trim();
  }
  if (rest.endsWith("…")) {
    rest = rest.slice(0, -1);
  }
  if (!rest && !idTail) return null;
  return { name: rest, idTail };
}
function stripIcon(text) {
  let result = String(text || "").trim();
  result = result.replace(
    /^[\p{Extended_Pictographic}\p{Emoji_Component}\u{FE0F}\u{200D}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]+\s*/u,
    ""
  );
  return result.trim();
}
function matchMain(text, label) {
  const raw = String(text || "").trim();
  if (raw === label) {
    return true;
  }
  const strippedInput = stripIcon(raw);
  const strippedLabel = stripIcon(label);
  return strippedInput !== "" && strippedInput === strippedLabel;
}
var LBL_STATUS_OVERVIEW, LBL_TRAFFIC, LBL_DEVICES, LBL_START_ALL, LBL_STOP_ALL, LBL_ADD_ACCOUNT, LBL_SET_LIMIT, LBL_RUN, LBL_HIDE, LBL_OVERVIEW, LBL_STATUS, LBL_REPORT, LBL_WEEKLY, LBL_BALANCE, LBL_ACCOUNTS, LBL_CHECK_CRED, LBL_HELP, LBL_BACK_MAIN, LBL_PAGE_PREV, LBL_PAGE_NEXT, LBL_BACK_PREV, LBL_LIMIT_MANUAL, LBL_ADD_CONFIRM, LBL_ADD_RESCAN, LBL_ADD_CANCEL, LBL_DEV_STATUS, LBL_DEV_START, LBL_DEV_STOP, LBL_DEV_PAUSE, LBL_DEV_RESUME, LBL_DEV_DELETE, LBL_BACK_LIST, DEVICE_PREFIX, DEVICE_NAME_MAX, PAUSED_MARK, DEVICE_ID_TAIL;
LBL_STATUS_OVERVIEW = "\u{1F4CA} 状态总览";
LBL_TRAFFIC = "\u{1F4C8} 流量额度";
LBL_DEVICES = "\u{1F5A5} 单机操作";
LBL_START_ALL = "\u{1F680} 全部开机";
LBL_STOP_ALL = "\u{1F6D1} 全部关机";
LBL_ADD_ACCOUNT = "➕ 添加账号";
LBL_SET_LIMIT = "\u{1F39A} 设阈值";
LBL_RUN = "\u{1F504} 立即巡检";
LBL_HIDE = "❌ 收起菜单";
LBL_OVERVIEW = "\u{1F4CA} 总览";
LBL_STATUS = "\u{1F4E1} 实例状态";
LBL_REPORT = "\u{1F4CB} 完整报表";
LBL_WEEKLY = "\u{1F4C5} 周报";
LBL_BALANCE = "\u{1F4B0} 余额详情";
LBL_ACCOUNTS = "\u{1F3E6} 账号汇总";
LBL_CHECK_CRED = "\u{1F511} 凭据体检";
LBL_HELP = "\u2139️ 使用说明";
LBL_BACK_MAIN = "\u{1F3E0} 返回主菜单";
LBL_PAGE_PREV = "上一页机器";
LBL_PAGE_NEXT = "下一页机器";
LBL_BACK_PREV = "\u{1F519} 返回上一步";
LBL_LIMIT_MANUAL = "✏️ 手动输入";
LBL_ADD_CONFIRM = "✅ 全部加入监控";
LBL_ADD_RESCAN = "\u{1F504} 重新扫描";
LBL_ADD_CANCEL = "❌ 取消添加";
LBL_DEV_STATUS = "\u{1F4CA} 状态";
LBL_DEV_START = "\u{1F680} 开机";
LBL_DEV_STOP = "\u{1F6D1} 关机";
LBL_DEV_PAUSE = "⏸️ 暂停监控";
LBL_DEV_RESUME = "▶️ 恢复监控";
LBL_DEV_DELETE = "\u{1F5D1} 删除机器";
LBL_BACK_LIST = "\u{1F519} 返回列表";
DEVICE_PREFIX = "\u{1F5A5} ";
DEVICE_NAME_MAX = 22;
PAUSED_MARK = "⏸️";
DEVICE_ID_TAIL = 8;

export { DEVICE_ID_TAIL, DEVICE_NAME_MAX, DEVICE_PREFIX, LBL_ACCOUNTS, LBL_ADD_ACCOUNT, LBL_ADD_CANCEL, LBL_ADD_CONFIRM, LBL_ADD_RESCAN, LBL_BACK_LIST, LBL_BACK_MAIN, LBL_BACK_PREV, LBL_BALANCE, LBL_CHECK_CRED, LBL_DEVICES, LBL_DEV_DELETE, LBL_DEV_PAUSE, LBL_DEV_RESUME, LBL_DEV_START, LBL_DEV_STATUS, LBL_DEV_STOP, LBL_HELP, LBL_HIDE, LBL_LIMIT_MANUAL, LBL_OVERVIEW, LBL_PAGE_NEXT, LBL_PAGE_PREV, LBL_REPORT, LBL_RUN, LBL_SET_LIMIT, LBL_START_ALL, LBL_STATUS, LBL_STATUS_OVERVIEW, LBL_STOP_ALL, LBL_TRAFFIC, LBL_WEEKLY, PAUSED_MARK, buildDeviceButton, matchMain, parseDeviceButton, shortIdTail, stripIcon };
