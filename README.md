# 阿里云 CDT 流量守护（aliyun-cdt-guard）

监控阿里云 **CDT（云数据传输）公网出流量**，在流量或费用失控前**自动关机止损**，
下个账期流量重置后**自动开机恢复业务**，并每天推送一份使用报表。

> 适合人群：用阿里云小磁盘/抢占式实例跑服务、担心流量超额扣费的用户。

---

## 它能帮你解决什么

- **忘了看流量，月底被扣一笔大的** —— 脚本每 5 分钟检查一次，超过你设的阈值立刻关机。
- **机器被关机后再也没起来** —— 下个月流量重置后自动开机，不用你手动操作。
- **不知道钱花在哪了** —— 每天早上 9 点推送报表：流量用了多少、本月账单多少、账户还剩多少钱。
- **海外机器访问国内源慢** —— 自动判断走阿里云内网源还是官方全球源。

---

## 快速开始（3 步）

### 第 1 步：准备 AccessKey（不要用主账号）

1. 打开阿里云控制台 → 右上角头像 → **访问控制 RAM** → 用户 → 创建用户
2. 勾选「使用永久 AccessKey 访问」
3. 创建完成后**立刻复制** AccessKey ID 和 Secret（只显示一次）
4. 给这个子账号授予以下权限：
   - `AliyunECSFullAccess`（开关机）
   - `AliyunCDTReadOnlyAccess`（查流量）
   - `AliyunBSSReadOnlyAccess`（查账单与余额）

### 第 2 步：准备通知渠道

支持三个渠道，可同时启用，互不影响。

**主力渠道：Telegram（必配）**

1. Telegram 搜索 `@BotFather` → 发送 `/newbot` → 按提示创建机器人 → 复制 Token
2. Telegram 搜索 `@userinfobot` → 发送任意消息 → 复制它回复的数字 ID

**推荐自建渠道：NapCat / OneBot（可选）**

自己搭的 QQ 机器人，**无配额限制、无需审核，可以承担全部告警**。

1. 在任意一台常开机器上部署 NapCat（或 Lagrange / go-cqhttp）
2. 开启 HTTP 服务，记下地址（如 `http://127.0.0.1:3000`）和 Token
3. 填群号即可（私聊填对方 QQ 号）

**备选渠道：QQ 官方机器人（可选，仅日报）**

1. 打开 https://q.qq.com 注册并创建机器人
2. 管理端获取 `AppID` 和 `AppSecret`
3. 把机器人拉进群，群里 @ 它，从日志里拿到群的 OpenID

> **重要限制**：腾讯对 QQ 官方机器人**主动消息**有严格频控，群聊**每月仅 4 条**。
> 所以官方通道只发日报摘要，**告警不走这条路**。想用 QQ 收告警请用 OneBot 方案。

### 第 3 步：一条命令安装

SSH 登录你的服务器（任意能联网的 Linux），以 root 执行：

```bash
bash <(curl -sL https://raw.githubusercontent.com/yys9253462-gif/aliyun-cdt-guard/main/install.sh)
```

然后跟着中文提示走：粘贴 AccessKey → 选地域 → 填实例 ID → 设流量阈值。
全程大约 3-5 分钟，装完会自动做一次自检并给你发一条测试通知。

---

## 常用操作

所有操作都通过**重新运行一次安装脚本**进入管理菜单完成：

```bash
bash <(curl -sL https://raw.githubusercontent.com/yys9253462-gif/aliyun-cdt-guard/main/install.sh)
```

菜单功能：

| 序号 | 功能 |
| --- | --- |
| 1 | 查看当前监控的机器 |
| 2 | 添加一台新机器 |
| 3 | 删除一台机器 |
| 4 | 暂停 / 恢复某台机器的监控 |
| 5 | 修改通知配置（Telegram / QQ） |
| 6 | 立即发送一次报表测试 |
| 7 | 立即执行一次巡检 |
| 8 | 查看最近日志 |
| 9 | 退出 |

---

## 配置项说明

配置文件位于 `/opt/cdt-guard/config.json`（权限锁定为 600）：

| 字段 | 说明 |
| --- | --- |
| `name` | 备注名，通知里用它标识机器 |
| `ak` / `sk` | RAM 子账号的 AccessKey |
| `region` | 实例所在地域，如 `cn-hongkong` |
| `instance_id` | ECS 实例 ID，形如 `i-xxxxxxxx` |
| `traffic_limit` | 流量熔断阈值（GB） |
| `bill_endpoint` | 账单接口节点，国内站 / 国际站不同 |
| `currency` | 显示货币符号 |
| `resgroup` | 资源组 ID，RAM 权限收窄到资源组时才需要 |
| `paused` | 是否暂停监控 |

通知相关配置：

| 字段 | 说明 |
| --- | --- |
| `telegram.bot_token` | Telegram 机器人 Token（主力渠道） |
| `telegram.chat_id` | 你的 Telegram 数字 ID |
| `onebot.base_url` | NapCat / OneBot 的 HTTP 地址 |
| `onebot.token` | OneBot 访问 Token（没设可留空） |
| `onebot.target_id` | 群号或对方 QQ 号 |
| `onebot.target_type` | `group` 群聊 / `private` 私聊 |
| `qq.app_id` / `qq.app_secret` | QQ 官方机器人凭证 |
| `qq.target_id` | 群 OpenID 或用户 OpenID |
| `qq.target_type` | `group` 群聊 / `user` 单聊 |

### 三个渠道的能力对比

| 渠道 | 告警 | 日报 | 限制 |
| --- | --- | --- | --- |
| Telegram | 支持 | 支持 | 无 |
| OneBot（NapCat） | 支持 | 支持 | 需自建，无配额 |
| QQ 官方机器人 | 不支持 | 支持 | 群聊每月仅 4 条 |

---

## 小磁盘救机脚本

如果你的阿里云实例是 1G/2G 小磁盘，需要先用光盘启动重新装系统，
项目里附带了 `alpine-rescue.sh`，在 VNC 控制台里一键完成：

网络修复 → 释放磁盘 → 全盘写入系统 → 开启 SSH → 自动重启。

用法：

```sh
sh alpine-rescue.sh 你的密码
```

---

## 工作原理

```
每 5 分钟（定时任务）
        │
        ├─ 查 CDT 当月流量 ──┐
        │                    │
        └─ 查实例状态 ───────┤
                             ▼
                   流量 < 阈值？
                   ┌─────────┴─────────┐
                  是                    否
                   │                     │
         实例是 Stopped？          实例是 Running？
          ┌───┴───┐                ┌───┴───┐
          是      否               是      否
          │       │                │       │
       自动开机  不动          强制关机  保持关机
                                     │
                              发送告警通知
```

---

## 卸载

```bash
bash <(curl -sL https://raw.githubusercontent.com/yys9253462-gif/aliyun-cdt-guard/main/uninstall.sh)
```

---

## 免责声明

1. 本项目仅供学习与技术交流。
2. 脚本对开关机接口做了异常兜底，但**不对因接口变更、配置错误、网络异常导致的流量损失与费用负责**。
3. **强烈建议同时在阿里云费用中心设置「预算告警」作为最后一道防线。**
