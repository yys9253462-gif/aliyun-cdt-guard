import { pathToFileURL } from 'node:url';
export function bindChat(raw, id) {
  if (!/^[1-9][0-9]{4,}$/.test(id)) throw new Error('Invalid Telegram ID');
  let config;
  const text = raw.trim();
  if (!text || text === 'Value not found') config = { users: [] };
  else {
    const start = text.indexOf('{');
    if (start < 0) throw new Error('Unrecognized KV response');
    config = JSON.parse(text.slice(start));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config');
  }
  config.telegram = { ...config.telegram, chat_id: id };
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = ''; for await (const part of process.stdin) raw += part;
    process.stdout.write(JSON.stringify(bindChat(raw, process.argv[2])));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
