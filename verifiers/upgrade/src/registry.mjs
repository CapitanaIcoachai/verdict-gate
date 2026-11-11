import fs from 'node:fs';
import path from 'node:path';
import { CACHE_ROOT, ensureDir, safeName } from './util.mjs';

const TTL_MS = 6 * 3600 * 1000;
const mem = new Map();

export async function packument(name) {
  if (mem.has(name)) return mem.get(name);
  const p = (async () => {
    const dir = ensureDir(path.join(CACHE_ROOT, 'packuments'));
    const file = path.join(dir, safeName(name) + '.json');
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* miss */ }
    const url = 'https://registry.npmjs.org/' + name.replace('/', '%2f');
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
    const text = await res.text();
    fs.writeFileSync(file, text);
    return JSON.parse(text);
  })();
  mem.set(name, p);
  return p;
}

export function latest(pk) {
  return pk['dist-tags']?.latest;
}

export function repoUrl(pk) {
  let u = pk.repository?.url || (typeof pk.repository === 'string' ? pk.repository : '') || pk.homepage || '';
  u = u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
  u = u.replace(/^git@github\.com:/, 'https://github.com/');
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = 'https://github.com/' + u;
  return u || null;
}
