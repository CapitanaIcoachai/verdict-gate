import semver from 'semver';
import { readProject } from './project.mjs';
import { scanUsage } from './usage.mjs';
import { packument, latest } from './registry.mjs';
import { analyzePackage } from './analyze.mjs';
import { pool, errMsg } from './util.mjs';

const ORDER = { BREAKS: 0, REVIEW: 1, UNVERIFIED: 2, CLEAR: 3, 'NOT-IMPORTED': 4, 'UP-TO-DATE': 5, SKIPPED: 6, ERROR: 7 };

export async function scanProject({ dir, only, to, includeDev = true, concurrency = 3, onProgress = () => {} }) {
  const project = readProject(dir);
  let deps = project.deps;
  if (!includeDev) deps = deps.filter((d) => d.section !== 'devDependencies');
  if (only?.length) deps = deps.filter((d) => only.includes(d.name));
  const names = deps.filter((d) => !d.skip).map((d) => d.name);
  onProgress({ phase: 'usage', message: `scanning source files for ${names.length} packages` });
  const usage = scanUsage(project.root, new Set(names));

  const results = await pool(deps, concurrency, async (d) => {
    const base = { name: d.name, section: d.section, range: d.range };
    if (d.skip || !d.resolved) return { ...base, verdict: 'SKIPPED', reason: d.skip || 'could not determine installed version', issues: [], stats: { uses: 0, verified: 0, files: 0 } };
    try {
      const pk = await packument(d.name);
      const target = to || latest(pk);
      if (!pk.versions?.[target]) return { ...base, verdict: 'ERROR', reason: `version ${target} not found on npm`, issues: [], stats: { uses: 0, verified: 0, files: 0 } };
      if (!semver.gt(target, d.resolved.version)) {
        return { ...base, from: d.resolved.version, to: target, verdict: 'UP-TO-DATE', issues: [], stats: { uses: 0, verified: 0, files: 0 } };
      }
      onProgress({ phase: 'analyze', message: `${d.name} ${d.resolved.version} -> ${target}` });
      const uses = usage.byPackage.get(d.name)?.uses || [];
      const r = await analyzePackage({ name: d.name, from: d.resolved.version, to: target, uses, project, fromAssumed: d.resolved.assumed, fromSource: d.resolved.source });
      return { ...base, ...r };
    } catch (e) {
      return { ...base, verdict: 'ERROR', reason: errMsg(e), issues: [], stats: { uses: 0, verified: 0, files: 0 } };
    }
  });
  results.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.name.localeCompare(b.name));
  return { project: { root: project.root, name: project.pkg.name || '(unnamed)', engines: project.pkg.engines || null }, filesScanned: usage.files, results, generatedAt: new Date().toISOString() };
}

export async function checkOne({ dir, name, to, from }) {
  const project = readProject(dir);
  const d = project.deps.find((x) => x.name === name);
  if (!d && !from) throw new Error(`${name} is not a dependency of ${project.root} (pass --from to compare two versions anyway)`);
  const pk = await packument(name);
  const target = to || latest(pk);
  const resolved = from ? { version: from, source: '--from' } : d.resolved;
  if (!resolved) throw new Error(`cannot determine the current version of ${name}`);
  const usage = scanUsage(project.root, new Set([name]));
  const uses = usage.byPackage.get(name)?.uses || [];
  const r = await analyzePackage({ name, from: resolved.version, to: target, uses, project, fromAssumed: resolved.assumed, fromSource: resolved.source });
  return { project: { root: project.root, name: project.pkg.name || '(unnamed)', engines: project.pkg.engines || null }, filesScanned: usage.files, results: [{ name, section: d?.section, range: d?.range, ...r }], generatedAt: new Date().toISOString() };
}
