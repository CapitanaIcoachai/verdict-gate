import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CACHE_ROOT, ensureDir, safeName } from './util.mjs';

const inflight = new Map();

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Install one exact version into an isolated cache dir. Scripts are NEVER run. */
export function install(name, version) {
  const key = `${name}@${version}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const dir = path.join(CACHE_ROOT, 'installs', safeName(key));
    const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(dir, '.ok'))) return { dir, pkgDir, key };
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'upgrade-radar-probe', private: true, version: '0.0.0' }));
    const base = ['install', `${name}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'];
    let note = '';
    try {
      await run('npm', base, { cwd: dir, timeout: 240000 });
    } catch (e1) {
      try {
        await run('npm', [...base, '--legacy-peer-deps'], { cwd: dir, timeout: 240000 });
        note = 'installed with --legacy-peer-deps';
      } catch (e2) {
        throw new Error(`npm install ${key} failed: ${(e2.stderr || e2.message).toString().split('\n').slice(0, 3).join(' ')}`);
      }
    }
    if (!fs.existsSync(pkgDir)) throw new Error(`${key} installed but ${pkgDir} is missing`);
    fs.writeFileSync(path.join(dir, '.ok'), note);
    return { dir, pkgDir, key, note };
  })();
  inflight.set(key, p);
  p.catch(() => inflight.delete(key));
  return p;
}

export function readPkgJson(inst) {
  return JSON.parse(fs.readFileSync(path.join(inst.pkgDir, 'package.json'), 'utf8'));
}
