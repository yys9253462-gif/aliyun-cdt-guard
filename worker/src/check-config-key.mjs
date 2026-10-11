import { pathToFileURL } from 'node:url';
export function configKeyMissing(text) {
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  const start = text.search(/^\s*\[/m);
  if (start < 0) throw new Error('Invalid key list');
  const keys = JSON.parse(text.slice(start));
  if (!Array.isArray(keys) || keys.some(k => !k || typeof k.name !== 'string')) throw new Error('Invalid key list');
  return !keys.some(k => k.name === 'config');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    console.log(configKeyMissing(text) ? 'MISSING' : 'EXISTS');
  } catch(e) { console.error(e.message); process.exitCode = 1; }
}
