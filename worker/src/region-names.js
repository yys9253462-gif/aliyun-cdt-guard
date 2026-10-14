var REGION_CN = {
  // ---- 中国内地 ----
  "cn-qingdao": "青岛",
  "cn-beijing": "北京",
  "cn-zhangjiakou": "张家口",
  "cn-huhehaote": "呼和浩特",
  "cn-wulanchabu": "乌兰察布",
  "cn-hangzhou": "杭州",
  "cn-shanghai": "上海",
  "cn-nanjing": "南京本地",
  "cn-fuzhou": "福州本地",
  "cn-shenzhen": "深圳",
  "cn-heyuan": "河源",
  "cn-guangzhou": "广州",
  "cn-wuhan-lr": "武汉本地",
  "cn-chengdu": "成都",
  "cn-zhongwei": "中卫",
  // ---- 中国香港（属「非中国内地」，免费额度按 200GB 算）----
  "cn-hongkong": "中国香港",
  // ---- 亚太 ----
  "ap-southeast-1": "新加坡",
  "ap-southeast-2": "悉尼",
  "ap-southeast-3": "吉隆坡",
  "ap-southeast-4": "墨尔本",
  "ap-southeast-5": "雅加达",
  "ap-southeast-6": "马尼拉",
  "ap-southeast-7": "曼谷",
  "ap-southeast-8": "柔佛",
  "ap-northeast-1": "东京",
  "ap-northeast-2": "首尔",
  "ap-south-1": "孟买",
  // ---- 北美 ----
  "us-west-1": "硅谷",
  "us-east-1": "弗吉尼亚",
  "us-southeast-1": "亚特兰大",
  "na-south-1": "墨西哥",
  // ---- 欧洲 ----
  "eu-central-1": "法兰克福",
  "eu-west-1": "伦敦",
  "eu-west-2": "巴黎",
  // ---- 中东 / 南美 ----
  "me-east-1": "迪拜",
  "me-central-1": "利雅得",
  "sa-east-1": "圣保罗",
  // ---- 金融云（少数用户会用，一并给中文名）----
  "cn-hangzhou-finance": "杭州金融云",
  "cn-shanghai-finance-1": "上海金融云",
  "cn-shenzhen-finance-1": "深圳金融云",
  "cn-beijing-finance-1": "北京金融云"
};
function regionDisplayName(region) {
  const code = String(region || "").trim();
  if (!code) return "未知地域";
  return REGION_CN[code.toLowerCase()] || code;
}
function regionDisplayWithCode(region) {
  const code = String(region || "").trim();
  if (!code) return "未知地域";
  const cn = REGION_CN[code.toLowerCase()];
  return cn ? `${cn}（${code}）` : code;
}

export { REGION_CN, regionDisplayName, regionDisplayWithCode };
