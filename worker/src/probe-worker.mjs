import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
// 使用 curl 继承 HTTP(S)_PROXY，兼容未提供内置代理支持的 Node 版本。
async function curlRequest(url, options) {
  const config = `header = "Authorization: ${options.headers.Authorization}"\n`;
  const raw = execFileSync('curl', ['-sS', '--max-time', '15', '--config', '-', '-w', '\n%{http_code}', url], {
    input: config, encoding: 'utf8', timeout: 18000, windowsHide: true,
  });
  const split = raw.lastIndexOf('\n');
  const status = Number(raw.slice(split + 1));
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw.slice(0, split)) };
}
export async function probeWorker(token, name, selectedAccount = '', request = fetch) {
  const get = async path => {
    const res = await request(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    const body = await res.json();
    if (!res.ok || body.success !== true) {
      const e = new Error(`Cloudflare query failed (${res.status})`);
      e.status = res.status;
      e.codes = (body.errors || []).map(x => x.code);
      throw e;
    }
    return body.result;
  };
  const accounts = await get('/accounts');
  const account = selectedAccount ? accounts.find(a => a.id === selectedAccount)
    : accounts.length === 1 ? accounts[0] : null;
  if (!account) throw new Error('Select a valid CLOUDFLARE_ACCOUNT_ID; account is ambiguous or inaccessible');
  const base = `/accounts/${encodeURIComponent(account.id)}/workers`;
  let route;
  try { route = await get(`${base}/scripts/${encodeURIComponent(name)}/subdomain`); }
  catch (e) { if (e.status === 404 || e.codes?.includes(10007)) return null; throw e; }
  if (!route.enabled) return { accountId: account.id, url: '(workers.dev 未启用)' };
  const sub = await get(`${base}/subdomain`);
  if (!sub.subdomain || !/^[a-z0-9-]+$/i.test(sub.subdomain)) throw new Error('Invalid workers.dev subdomain');
  return { accountId: account.id, url: `https://${name}.${sub.subdomain}.workers.dev` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    const auth = JSON.parse(text.slice(text.indexOf('{')));
    if (!auth.token) throw new Error('No API token returned');
    const result = await probeWorker(auth.token, process.argv[2], process.argv[3], curlRequest);
    if (!result) process.exitCode = 2;
    else console.log(result.url);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
