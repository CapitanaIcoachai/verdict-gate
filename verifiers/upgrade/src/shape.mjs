import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function permissionFlags(dir) {
  const f = process.allowedNodeEnvironmentFlags;
  const flag = f.has('--permission') ? '--permission' : f.has('--experimental-permission') ? '--experimental-permission' : null;
  return flag ? [flag, `--allow-fs-read=${dir}`] : null;
}

/** Probe runtime shapes of `specs` in an installed dir, for both require() and import(). */
export function probeShapes(inst, specs) {
  return new Promise((resolve) => {
    const script = path.join(inst.dir, '__ur_probe.mjs');
    fs.copyFileSync(path.join(HERE, 'probe-child.mjs'), script);
    const perm = permissionFlags(inst.dir);
    const args = [...(perm || []), script, JSON.stringify(specs)];
    execFile(process.execPath, args, { cwd: inst.dir, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const m = /@@UR@@([\s\S]*?)@@END@@/.exec(stdout || '');
      if (!m) {
        const why = err ? (err.killed ? 'timed out' : (stderr || err.message).toString().split('\n')[0]) : 'no output';
        return resolve({ sandboxed: !!perm, failed: `probe failed: ${why}`, specs: {} });
      }
      try { resolve({ sandboxed: !!perm, specs: JSON.parse(m[1]) }); }
      catch (e) { resolve({ sandboxed: !!perm, failed: 'probe output unreadable', specs: {} }); }
    });
  });
}

/** Navigate a shape by path. Returns {node}|{unknown:true}|{missing:at}. */
export function lookup(root, pathArr) {
  let node = root;
  for (let i = 0; i < pathArr.length; i++) {
    const key = pathArr[i];
    if (!node || node.t === 'truncated') return { unknown: true, at: i };
    if (key === '()' || key === 'await()' || key.startsWith('cb:')) return { unknown: true, at: i };
    if (key === 'new()') {
      if (node.t !== 'class' && node.t !== 'function') return { missing: i };
      if (!node.proto) return { unknown: true, at: i };
      node = { t: 'object', props: node.proto };
      continue;
    }
    if (node.t === 'getter' || node.deep) return { unknown: true, at: i };
    if (node.t === 'function' || node.t === 'class' || node.t === 'object') {
      const child = node.props?.[key];
      if (!child) return node.capped ? { unknown: true, at: i } : { missing: i };
      node = child;
    } else {
      return { missing: i };
    }
  }
  return { node };
}
