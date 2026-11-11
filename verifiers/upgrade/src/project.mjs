import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readProject(dir) {
  const root = path.resolve(dir);
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) throw new Error(`no package.json in ${root}`);
  const lock = readJson(path.join(root, 'package-lock.json'));

  function resolved(name, range) {
    const lockVer = lock?.packages?.['node_modules/' + name]?.version || lock?.dependencies?.[name]?.version;
    if (lockVer) return { version: lockVer, source: 'package-lock.json' };
    const inst = readJson(path.join(root, 'node_modules', name, 'package.json'));
    if (inst?.version) return { version: inst.version, source: 'node_modules' };
    const min = semver.validRange(range) ? semver.minVersion(range)?.version : null;
    if (semver.valid(range)) return { version: semver.valid(range), source: 'package.json (exact version)' };
    if (min) return { version: min, source: 'lowest version allowed by "' + range + '"', assumed: true };
    return null;
  }

  const deps = [];
  for (const section of SECTIONS) {
    if (section === 'peerDependencies') continue;
    for (const [name, range] of Object.entries(pkg[section] || {})) {
      if (deps.some((d) => d.name === name)) continue;
      const r = typeof range === 'string' ? range : '';
      const skip = /^(git|github|file|link|workspace|http|https):|^[\w.-]+\/[\w.-]+$/.test(r) || r.startsWith('npm:')
        ? 'non-registry spec' : (!semver.validRange(r) && r !== 'latest' && r !== '*' ? 'unparsable range' : null);
      deps.push({ name, range: r, section, skip, resolved: skip ? null : resolved(name, r === 'latest' ? '*' : r) });
    }
  }
  return { root, pkg, deps };
}
