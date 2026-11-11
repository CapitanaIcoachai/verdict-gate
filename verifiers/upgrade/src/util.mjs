import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CACHE_ROOT = process.env.UPGRADE_RADAR_CACHE || path.join(os.homedir(), '.cache', 'upgrade-radar');

export const safeName = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = {
  red: c('31'), green: c('32'), yellow: c('33'), blue: c('34'), cyan: c('36'),
  gray: c('90'), bold: c('1'), dim: c('2'),
};

export function errMsg(e) {
  return (e && (e.message || String(e))).split('\n')[0];
}
