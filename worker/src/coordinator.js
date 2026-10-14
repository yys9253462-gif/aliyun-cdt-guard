import { loadConfig, redact } from './common.js';
import { localWorker } from './index.js';
import { withRequestContext } from './request-context.js';
import { sendMenu, sendText } from './telegram.js';

var GuardCoordinator = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.tail = Promise.resolve();
  }
  serial(fn) {
    const job = this.tail.then(fn);
    this.tail = job.catch(() => {
    });
    return job;
  }
  adaptedEnv() {
    const storage = this.state.storage, kv = this.env.CDT_GUARD_KV;
    return { ...this.env, CDT_GUARD_KV: {
      async get(key, type) {
        let raw = await storage.get(`data:${key}`);
        if (raw === void 0) {
          raw = kv ? await kv.get(key) : null;
          if (raw !== null) await storage.put(`data:${key}`, raw);
        } else if (key === "config" && kv) {
          // 电脑上的脚本（configure.sh / deploy.sh）是直接读写 KV 里的 config 的。
          // 原来这里只认协调器自己的那份，脚本改的配置线上不生效，之后还会被覆盖掉。
          // 现在 KV 里的版本号更高、或版本号相同但内容不同（脚本改了没升版本号）时，以 KV 为准。
          // 机器人改配置时版本号会 +1，所以 KV 镜像写失败留下的旧内容版本号更低，不会被误采用。
          try {
            const kvRaw = await kv.get(key);
            if (kvRaw && kvRaw !== raw) {
              const rev = (text) => {
                try {
                  return Number(JSON.parse(text)._revision || 0);
                } catch (_) {
                  return NaN;
                }
              };
              const kvRev = rev(kvRaw), doRev = rev(raw);
              if (Number.isFinite(kvRev) && (kvRev > doRev || kvRev === doRev || !Number.isFinite(doRev))) {
                console.log(`[同步] 采用 KV 里的配置（脚本改过，版本 ${kvRev}，原 ${doRev}）`);
                raw = kvRaw;
                await storage.put(`data:${key}`, raw);
              }
            }
          } catch (e) {
            console.log("[同步] 读取 KV 配置失败，继续用协调器里的配置:", redact(e));
          }
        }
        return type === "json" ? raw ? JSON.parse(raw) : null : raw;
      },
      async put(key, value) {
        await storage.put(`data:${key}`, String(value));
        if (key === "config" && kv) {
          try {
            await kv.put(key, String(value));
          } catch (e) {
            console.log("[备份] KV镜像写失败:", redact(e));
          }
        }
      },
      async delete(key) {
        await storage.delete(`data:${key}`);
        if (kv) {
          try {
            await kv.delete(key);
          } catch (e) {
            console.log("[备份] KV镜像删失败:", redact(e));
          }
        }
      }
    } };
  }
  fetch(request) {
    return this.serial(() => this.dispatch(request));
  }
  async dispatch(request) {
    const url = new URL(request.url), env = this.adaptedEnv();
    const key = request.headers.get("X-CDT-Key") || "";
    if (url.pathname === "/control/config") {
      if (!env.WEBHOOK_SECRET || key !== env.WEBHOOK_SECRET) return new Response("密钥不正确", { status: 403 });
      if (request.method === "GET") return Response.json(await loadConfig(env));
      if (request.method !== "PUT") return new Response("仅允许GET/PUT", { status: 405 });
      const next = await request.json();
      if (!next || !Array.isArray(next.users) || !next.telegram?.chat_id) return new Response("配置结构无效", { status: 400 });
      const previous = await loadConfig(env);
      const version = String(previous._revision || "0");
      if ((request.headers.get("If-Match") || "") !== version) return new Response("配置已被其他操作更新，请重新读取后再试", { status: 409 });
      next._revision = String(Number(version) + 1);
      await env.CDT_GUARD_KV.put("config", JSON.stringify(next));
      return Response.json({ ok: true, revision: next._revision });
    }
    if (url.pathname === "/internal/cron") {
      if (url.hostname !== "internal.invalid" || !env.WEBHOOK_SECRET || request.headers.get("X-CDT-Internal") !== env.WEBHOOK_SECRET) return new Response("未找到", { status: 404 });
      const event = await request.json();
      await withRequestContext(() => localWorker.scheduled(event, env, {}));
      return Response.json({ ok: true });
    }
    let id = null;
    if (url.pathname.startsWith("/webhook/")) {
      let provided = "";
      try {
        provided = decodeURIComponent(url.pathname.slice(9));
      } catch (_) {
        return new Response("未找到", { status: 404 });
      }
      if (!env.WEBHOOK_SECRET || provided !== env.WEBHOOK_SECRET) return new Response("未找到", { status: 404 });
      try {
        const update = await request.clone().json();
        if (Number.isSafeInteger(update.update_id)) id = update.update_id;
      } catch (_) {
      }
      if (id !== null && await this.state.storage.get(`update:${id}`)) return Response.json({ ok: true, duplicate: true });
    }
    const outbox = [];
    const actionJournal = id === null ? null : {
      has: async (key2) => Boolean(await this.state.storage.get(`action:${id}:${key2}`)),
      mark: async (key2) => this.state.storage.put(`action:${id}:${key2}`, Date.now())
    };
    try {
      const response = await withRequestContext(() => localWorker.fetch(request, env, {}), { outbox, actionJournal });
      if (outbox.length) {
        const pending = await this.state.storage.get("outbox") || [];
        await this.state.storage.put("outbox", pending.concat(outbox.map(({ token, ...job }) => ({ ...job, attempt: 0 }))).slice(-100));
        await this.state.storage.setAlarm(Date.now() + 3e4);
      }
      if (id !== null && response.ok) {
        await this.state.storage.put(`update:${id}`, Date.now());
        const keys = await this.state.storage.list({ prefix: "update:" });
        for (const prefix of ["update:", "action:"]) {
          const expired = prefix === "update:" ? keys : await this.state.storage.list({ prefix });
          for (const [k, at] of expired) if (Date.now() - at > 48 * 36e5) await this.state.storage.delete(k);
        }
      }
      return response;
    } catch (error) {
      console.log("[交互] 失败:", redact(error));
      return Response.json({ ok: false, error: "处理失败，请稍后重试" }, { status: 503 });
    }
  }
  alarm() {
    return this.serial(async () => {
      const pending = await this.state.storage.get("outbox") || [], remaining = [];
      await withRequestContext(async () => {
        for (const job of pending) {
          const token = String(this.env.TELEGRAM_BOT_TOKEN || "");
          const ok = job.kind === "menu" ? await sendMenu(token, job.chatId, job.text, job.rows) : await sendText(token, job.chatId, job.text, job.keyboard);
          if (!ok && job.attempt < 4) remaining.push({ ...job, attempt: job.attempt + 1 });
          else if (!ok) console.log("[通知] 重试5次仍失败，请检查Telegram连通性");
        }
      });
      await this.state.storage.put("outbox", remaining);
      if (remaining.length) await this.state.storage.setAlarm(Date.now() + 6e4);
    });
  }
};

export { GuardCoordinator };
