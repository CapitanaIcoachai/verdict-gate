// Package-level facts that can break an upgrade regardless of which functions you call.
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

/** Module type of the package.json scope that owns `file` (nearest package.json wins; absent "type" means commonjs). */
function scopeType(pkgDir, rootPj, file) {
  if (!pkgDir) return rootPj.type === 'module' ? 'module' : 'commonjs';
  let dir = path.dirname(path.join(pkgDir, file));
  for (let guard = 0; guard < 12 && dir.startsWith(pkgDir); guard++) {
    const f = path.join(dir, 'package.json');
    if (dir !== pkgDir && fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')).type === 'module' ? 'module' : 'commonjs'; } catch { /* ignore */ }
    }
    if (dir === pkgDir) break;
    dir = path.dirname(dir);
  }
  return rootPj.type === 'module' ? 'module' : 'commonjs';
}

/**
 * Can `require()` load this package entry? 'cjs' | 'dual' | 'esm-only' | 'unknown'.
 * Reads the exports map the way Node does, including nested package.json "type" scopes
 * (e.g. dist/commonjs/package.json), which is how many dual packages are built.
 */
export function moduleKind(pj, pkgDir, sub = '.') {
  const extKind = (file) => {
    if (typeof file !== 'string') return null;
    if (file.endsWith('.cjs')) return 'cjs';
    if (file.endsWith('.mjs')) return 'esm';
    if (file.endsWith('.js') || !/\.[a-z]+$/.test(file)) return scopeType(pkgDir, pj, file) === 'module' ? 'esm' : 'cjs';
    return null;
  };
  const collect = (node, conds, out) => {
    if (typeof node === 'string') { out.push({ file: node, conds }); return; }
    if (Array.isArray(node)) { node.forEach((n) => collect(n, conds, out)); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) collect(v, [...conds, k], out);
  };
  if (pj.exports !== undefined) {
    const ex = pj.exports;
    const isCondMap = ex && typeof ex === 'object' && !Array.isArray(ex) && !Object.keys(ex).some((k) => k.startsWith('.'));
    const entry = typeof ex === 'string' || Array.isArray(ex) || isCondMap ? (sub === '.' ? ex : undefined) : ex[sub];
    if (entry === undefined) return 'unknown';
    const list = [];
    collect(entry, [], list);
    let requireSide = false; // reachable by require(): some non-import path ends in a CommonJS file
    let importSide = false;
    for (const { file, conds } of list) {
      if (conds.includes('types')) continue;
      const k = extKind(file);
      if (!k) continue;
      if (conds.includes('import') && !conds.includes('require')) importSide = true;
      else if (k === 'cjs') requireSide = true;
    }
    if (requireSide) return importSide ? 'dual' : 'cjs';
    return 'esm-only';
  }
  const k = extKind(pj.main || 'index.js');
  if (k === 'esm') return 'esm-only';
  return pj.module && !pj.main ? 'esm-only' : 'cjs';
}

function minNode(range) {
  try { return range ? semver.minVersion(range)?.version : null; } catch { return null; }
}

export function packageLevelFindings({ name, oldPj, newPj, oldDir, newDir, project, hasRequireUses, newDeprecated }) {
  const out = [];
  const oldK = moduleKind(oldPj, oldDir);
  const newK = moduleKind(newPj, newDir);
  if (oldK !== 'esm-only' && newK === 'esm-only') {
    const projNode = project.pkg.engines?.node;
    const lowest = minNode(projNode);
    const oldNodeSafe = !lowest || semver.lt(lowest, '22.12.0');
    out.push({
      kind: 'esm-only',
      severity: hasRequireUses ? (oldNodeSafe ? 'breaks' : 'review') : 'info',
      title: 'now ESM-only',
      message: `${name}@${newPj.version} can only be loaded as an ES module (was ${oldK}). ` +
        (hasRequireUses
          ? `Your CommonJS/require() code cannot load it on Node < 22.12${projNode ? ` (your engines.node is "${projNode}")` : ' (your package.json declares no engines.node)'}; ` +
            `convert the importing files to ESM or use dynamic import().`
          : 'No require() of it found in your code, so only your Node/bundler setup matters.'),
      evidence: { old: `module kind: ${oldK}`, new: `module kind: ${newK}` },
      sources: ['package.json'],
    });
  }
  const need = newPj.engines?.node;
  if (need && semver.validRange(need)) {
    const have = project.pkg.engines?.node;
    const lowest = minNode(have);
    const oldNeed = oldPj.engines?.node;
    if (have && lowest && !semver.satisfies(lowest, need)) {
      out.push({
        kind: 'engines', severity: 'review', title: 'Node version requirement raised',
        message: `${name}@${newPj.version} requires Node "${need}" but your package.json allows Node "${have}" (lowest ${lowest}).`,
        evidence: { old: oldNeed ? `engines.node "${oldNeed}"` : 'no engines.node', new: `engines.node "${need}"` },
        sources: ['package.json'],
      });
    } else if (!have && !semver.satisfies(process.versions.node, need)) {
      out.push({
        kind: 'engines', severity: 'review', title: 'Node version requirement raised',
        message: `${name}@${newPj.version} requires Node "${need}"; the Node running this scan (${process.versions.node}) does not satisfy it.`,
        evidence: { old: oldNeed ? `engines.node "${oldNeed}"` : 'no engines.node', new: `engines.node "${need}"` },
        sources: ['package.json'],
      });
    }
  }
  const peers = newPj.peerDependencies || {};
  const meta = newPj.peerDependenciesMeta || {};
  for (const [peer, range] of Object.entries(peers)) {
    if (meta[peer]?.optional) continue;
    const declared = project.pkg.dependencies?.[peer] || project.pkg.devDependencies?.[peer];
    const oldRange = oldPj.peerDependencies?.[peer];
    if (!declared) {
      if (!oldRange) out.push({
        kind: 'peer-new', severity: 'review', title: 'new peer dependency',
        message: `${name}@${newPj.version} now requires you to provide "${peer}@${range}", which your package.json does not list.`,
        evidence: { old: 'no such peer dependency', new: `peerDependencies "${peer}": "${range}"` }, sources: ['package.json'],
      });
    } else if (semver.validRange(declared) && semver.validRange(range) && !semver.intersects(declared, range)) {
      out.push({
        kind: 'peer-conflict', severity: 'review', title: 'peer dependency conflict',
        message: `${name}@${newPj.version} needs "${peer}@${range}" but you depend on "${peer}@${declared}".`,
        evidence: { old: oldRange ? `peer "${peer}": "${oldRange}"` : 'no such peer dependency', new: `peer "${peer}": "${range}"` }, sources: ['package.json'],
      });
    }
  }
  if (oldPj.bin && !newPj.bin) {
    out.push({
      kind: 'bin-removed', severity: 'review', title: 'command-line binary removed',
      message: `${name}@${oldPj.version} shipped a CLI (bin) and ${newPj.version} does not. npm scripts or CI calling it will fail.`,
      evidence: { old: 'has "bin"', new: 'no "bin"' }, sources: ['package.json'],
    });
  }
  if (newDeprecated) {
    out.push({
      kind: 'deprecated', severity: 'info', title: 'target version is deprecated',
      message: `npm marks ${name}@${newPj.version} deprecated: ${String(newDeprecated).slice(0, 200)}`,
      evidence: { old: '', new: 'deprecated' }, sources: ['registry'],
    });
  }
  return out;
}
