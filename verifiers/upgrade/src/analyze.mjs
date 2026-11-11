// Core: for one dependency, cross-check "what your code uses" against "what the new version really exports".
import semver from 'semver';
import { packument, repoUrl } from './registry.mjs';
import { install, readPkgJson } from './install.mjs';
import { probeShapes, lookup } from './shape.mjs';
import { openTypes } from './types.mjs';
import { packageLevelFindings } from './pkgdiff.mjs';
import { findChangelogs, grepChangelogs } from './changelog.mjs';
import { suggestReplacement } from './suggest.mjs';

const SEV_RANK = { breaks: 3, review: 2, info: 1 };
const IDENT = /^[A-Za-z_$][\w$]*$/;

export function displayPath(pkgName, pathArr) {
  const arr = pathArr.slice();
  if (arr[0] === 'default') {
    arr.shift();
    if (!arr.length) return `${pkgName} (default export)`;
  }
  let s = pkgName;
  for (const k of arr) {
    if (k === '()') s += '()';
    else if (k === 'new()') s += ' instance';
    else if (k === 'await()') continue;
    else if (k.startsWith('cb:')) s += `(\u2192 ${k.split(':')[5]})`;
    else s += IDENT.test(k) ? '.' + k : `["${k}"]`;
  }
  return s;
}

function interopPath(use, shapeRoot) {
  const p = use.path.slice();
  if (use.view === 'require' && use.interop && p[0] === 'default' && !shapeRoot?.props?.__esModule) return p.slice(1);
  return p;
}

// ES-import view of a CommonJS package: names missing from the namespace may still be reachable through `default`
// (that is what bundlers and Babel/TS interop do), so look there before declaring something missing.
function lookupI(root, p, view) {
  const r = lookup(root, p);
  if (r.missing !== undefined && view === 'import' && p[0] !== 'default' && root?.props?.default) {
    const r2 = lookup(root, ['default', ...p]);
    if (r2.node || r2.unknown) return { ...r2, viaDefault: true };
  }
  return r;
}

function accepts(sigs, k) { return sigs.some((s) => k >= s.min && k <= s.max); }
function sigText(sigs) { return sigs.slice(0, 2).map((s) => s.text).join('  |  ') || '(not callable)'; }
const cleanErr = (e) => String(e).replace(/ in \/\S+/g, '').replace(/ imported from .*/, '').replace(/'\/[^']+'/g, "'<install dir>'").slice(0, 170);
const siteKey = (s) => `${s.file}:${s.line}:${s.col}`;

export async function analyzePackage({ name, from, to, uses, project, fromAssumed, fromSource }) {
  const pk = await packument(name);
  const [oldI, newI] = await Promise.all([install(name, from), install(name, to)]);
  const oldPj = readPkgJson(oldI);
  const newPj = readPkgJson(newI);

  const specSet = new Set([name]);
  for (const u of uses) specSet.add(u.sub ? `${name}/${u.sub}` : name);
  const specs = [...specSet];
  const [oldProbe, newProbe] = await Promise.all([probeShapes(oldI, specs), probeShapes(newI, specs)]);

  const issues = new Map();
  const notes = [];
  if (oldProbe.failed) notes.push(`old version: ${oldProbe.failed}`);
  if (newProbe.failed) notes.push(`new version: ${newProbe.failed}`);
  if (!newProbe.sandboxed) notes.push('this Node has no permission model: introspection ran WITHOUT the sandbox');
  const changelogFiles = findChangelogs(newI.pkgDir);

  function addIssue(i, site, use) {
    let e = issues.get(i.key);
    if (!e) {
      e = { key: i.key, severity: i.severity, kind: i.kind, title: i.title, path: i.path, message: i.message,
        evidence: i.evidence || null, sources: new Set(), sites: [], suggestion: i.suggestion || null, changelog: [] };
      issues.set(i.key, e);
      if (i.symbol) e.changelog = grepChangelogs(changelogFiles, i.symbol);
    }
    for (const s of i.sources) e.sources.add(s);
    if (i.evidence && !e.evidenceBy) e.evidenceBy = {};
    if (i.evidence) for (const s of i.sources) if (!e.evidenceBy[s]) e.evidenceBy[s] = i.evidence;
    if (SEV_RANK[i.severity] > SEV_RANK[e.severity]) e.severity = i.severity;
    if (site && !e.sites.some((x) => siteKey(x) === siteKey(site))) {
      e.sites.push({ file: site.file, line: site.line, col: site.col, snippet: site.snippet });
    }
  }

  // ---- package-level facts
  const hasRequireUses = uses.some((u) => u.view === 'require');
  for (const f of packageLevelFindings({ name, oldPj, newPj, oldDir: oldI.pkgDir, newDir: newI.pkgDir, project, hasRequireUses, newDeprecated: pk.versions?.[to]?.deprecated })) {
    addIssue({ key: `pkg|${f.kind}`, path: name, ...f }, null);
    if (f.kind === 'esm-only') {
      const e = issues.get(`pkg|${f.kind}`);
      for (const u of uses.filter((x) => x.view === 'require' && x.kind === 'module')) {
        if (!e.sites.some((x) => siteKey(x) === siteKey(u)) && e.sites.length < 50) e.sites.push({ file: u.file, line: u.line, col: u.col, snippet: u.snippet });
      }
    }
  }

  // ---- use-level checks
  let verified = 0;
  let moduleLoadsOk = 0;
  const typesCache = new Map();
  const getTypes = async (spec) => {
    if (!typesCache.has(spec)) {
      typesCache.set(spec, Promise.all([openTypes(name, from, oldI, oldPj, spec), openTypes(name, to, newI, newPj, spec)]));
    }
    return typesCache.get(spec);
  };

  for (const use of uses) {
    const spec = use.sub ? `${name}/${use.sub}` : name;
    const site = { file: use.file, line: use.line, col: use.col, snippet: use.snippet };
    let didVerify = false;
    let moduleBroken = false;
    const isModuleSite = use.kind === 'module';

    // 1. can the module still be loaded the way the code loads it?
    const o = oldProbe.specs[spec]?.[use.view];
    const n = newProbe.specs[spec]?.[use.view];
    if (o && n && use.kind !== 'type') {
      if (!o.error && n.error) {
        moduleBroken = true;
        const code = n.error.split(':')[0];
        const nerr = cleanErr(n.error);
        const gone = /NOT_EXPORTED|NOT_FOUND/.test(code);
        const how = use.view === 'require' ? 'require()' : 'import';
        addIssue({
          key: `load|${spec}|${use.view}`, severity: 'breaks', kind: gone ? 'module-gone' : 'load-failure',
          title: gone ? 'import path no longer exists' : 'cannot be loaded',
          path: spec,
          message: gone
            ? `\`${how} '${spec}'\` resolves in ${name}@${from} but not in ${name}@${to} (${code}).`
            : `\`${how} '${spec}'\` loads in ${name}@${from} but throws in ${name}@${to}: ${nerr}`,
          evidence: { old: 'loads', new: nerr }, sources: ['runtime'], symbol: use.sub || null,
        }, site);
        didVerify = true;
      } else if (!o.error && !n.error) {
        if (isModuleSite) moduleLoadsOk++;
      }
    }
    if (isModuleSite) continue;

    // 2. does every member the code touches still exist, and is it still the same kind of thing?
    if (!moduleBroken && o && n && !o.error && !n.error && use.kind !== 'type') {
      const pO = interopPath(use, o.shape);
      const pN = interopPath(use, n.shape);
      const stripped = use.path.length - pN.length;
      // longest prefix of the path the OLD version lets us resolve (getters / call results stop the walk)
      let k = 0;
      let rO = pO.length === 0 ? { node: o.shape } : null;
      for (let i = 1; i <= pO.length; i++) {
        const r = lookupI(o.shape, pO.slice(0, i), use.view);
        if (r.node) { k = i; rO = r; } else break;
      }
      if (rO && rO.node) {
        const full = k === pO.length;
        const rN = k === 0 ? { node: n.shape } : lookupI(n.shape, pN.slice(0, k), use.view);
        if (rN.missing !== undefined) {
          const lookedN = rN.viaDefault ? ['default', ...pN.slice(0, k)] : pN.slice(0, k);
          const lookedO = rO.viaDefault ? ['default', ...pO.slice(0, k)] : pO.slice(0, k);
          const idxN = rN.missing - (rN.viaDefault ? 1 : 0);
          const idxUse = Math.min(use.path.length - 1, Math.max(0, idxN + stripped));
          const shownPath = displayPath(name, use.path.slice(0, idxUse + 1));
          const removedName = use.path[idxUse];
          const oldC = lookup(o.shape, lookedO.slice(0, idxN + (rO.viaDefault ? 1 : 0))).node;
          const newC = lookup(n.shape, lookedN.slice(0, rN.missing)).node;
          const sug = suggestReplacement({
            ctxLabel: name.replace(/^@[^/]+\//, ''), removedName, oldContainer: oldC?.props, newContainer: newC?.props, newRoot: n.shape,
          });
          addIssue({
            key: `removed|${spec}|${use.view}|${shownPath}`, severity: 'breaks',
            kind: idxUse === 0 ? 'removed-export' : 'removed-member',
            title: 'removed', path: shownPath,
            message: `\`${shownPath}\` exists in ${name}@${from} but is gone in ${name}@${to}.`,
            evidence: { old: rO.node.t, new: 'absent' },
            sources: ['runtime'], symbol: removedName,
            suggestion: sug.length ? { names: sug, how: 'heuristic: name similarity among exports that are new in the target version' } : null,
          }, site);
          didVerify = true;
        } else if (rN.node && full) {
          didVerify = true;
          const a = rO.node;
          const b = rN.node;
          const label = displayPath(name, use.path);
          const callable = (t) => t === 'function' || t === 'class';
          if (use.called && a.t !== 'getter' && b.t !== 'getter') {
            if (callable(a.t) && !callable(b.t)) {
              addIssue({
                key: `not-callable|${spec}|${use.view}|${label}`, severity: 'breaks', kind: 'not-callable', title: 'no longer a function',
                path: label, message: `\`${label}(...)\` was a ${a.t} in ${name}@${from}; in ${name}@${to} it is ${b.t === 'object' ? 'an object' : 'a ' + b.t}, so calling it throws.`,
                evidence: { old: a.t, new: b.t }, sources: ['runtime'], symbol: use.path[use.path.length - 1] || name,
              }, site);
            } else if (a.t === 'function' && b.t === 'class' && !use.isNew) {
              addIssue({
                key: `needs-new|${spec}|${use.view}|${label}`, severity: 'breaks', kind: 'needs-new', title: 'now a class',
                path: label, message: `\`${label}\` is now a class: calling it without \`new\` throws.`,
                evidence: { old: 'function', new: 'class' }, sources: ['runtime'], symbol: use.path[use.path.length - 1] || name,
              }, site);
            } else if (callable(a.t) && callable(b.t) && use.argc != null && b.len > use.argc && a.len <= use.argc) {
              addIssue({
                key: `more-required|${spec}|${use.view}|${label}|${use.argc}`, severity: 'review', kind: 'more-required-args', title: 'more required arguments',
                path: label, message: `\`${label}\` declares ${b.len} required parameters in ${name}@${to} (was ${a.len}); this call passes ${use.argc}.`,
                evidence: { old: `${a.len} required`, new: `${b.len} required` }, sources: ['runtime'], symbol: use.path[use.path.length - 1] || name,
              }, site);
            }
          } else if (use.isNew && !callable(b.t) && b.t !== 'getter') {
            addIssue({
              key: `not-constructible|${spec}|${use.view}|${label}`, severity: 'breaks', kind: 'not-constructible', title: 'no longer constructible',
              path: label, message: `\`new ${label}()\` worked in ${name}@${from} but ${label} is a ${b.t} in ${name}@${to}.`,
              evidence: { old: a.t, new: b.t }, sources: ['runtime'], symbol: use.path[use.path.length - 1] || name,
            }, site);
          } else if (!use.decl && a.t !== b.t && a.t !== 'getter' && b.t !== 'getter' && [a.t, b.t].every((t) => ['function', 'class', 'object'].includes(t))) {
            addIssue({
              key: `kind-changed|${spec}|${use.view}|${label}`, severity: 'review', kind: 'kind-changed', title: 'changed kind',
              path: label, message: `\`${label}\` changed from ${a.t} to ${b.t}.`,
              evidence: { old: a.t, new: b.t }, sources: ['runtime'], symbol: use.path[use.path.length - 1] || name,
            }, site);
          }
        } else if (rN.node) {
          didVerify = true; // prefix exists in both; deeper members are not reachable at runtime without calling code
        }
      }
    }

    // 3. same questions asked of the declared TypeScript API (catches instance methods the runtime probe cannot reach)
    if (!moduleBroken) {
      const [tO, tN] = await getTypes(spec);
      if (tO && tN) {
        const rO = tO.resolve(use.view, use.path, use.kind);
        const rN = tN.resolve(use.view, use.path, use.kind);
        if (rO.found && !rO.root && rN.found === false) {
          const label = displayPath(name, use.path.slice(0, rN.at + 1));
          const isTsSite = /\.[cm]?tsx?$/.test(use.file) || use.kind === 'type';
          const unreachable = use.path.some((k) => k === '()' || k === 'new()' || k.startsWith('cb:'));
          if (rN.notCallable || rN.notConstructible) {
            addIssue({
              key: `${rN.notCallable ? 'not-callable' : 'not-constructible'}|${spec}|${use.view}|${displayPath(name, use.path.slice(0, rN.at))}`, severity: 'breaks', kind: rN.notCallable ? 'not-callable' : 'not-constructible',
              title: rN.notCallable ? 'no longer a function' : 'no longer constructible', path: displayPath(name, use.path.slice(0, rN.at)),
              message: `\`${displayPath(name, use.path.slice(0, rN.at))}\` cannot be ${rN.notCallable ? 'called' : 'constructed'} per the ${name}@${to} typings.`,
              evidence: { old: 'callable/constructible', new: 'not' }, sources: ['types'], symbol: use.path[rN.at - 1] || null,
            }, site);
          } else {
            const missingName = use.path[rN.at];
            addIssue({
              key: `removed|${spec}|${use.view}|${label}`,
              severity: isTsSite || unreachable ? 'breaks' : 'review',
              kind: use.kind === 'type' ? 'removed-type' : (rN.at === 0 ? 'removed-export' : 'removed-member'),
              title: 'removed', path: label,
              message: `\`${label}\` is declared in the ${name}@${from} typings (${tO.label}) but not in ${name}@${to} (${tN.label}).` +
                (isTsSite ? ' TypeScript will fail to compile.' : ''),
              evidence: { old: rO.typeText || 'declared', new: 'not declared' }, sources: ['types'], symbol: missingName,
            }, site);
          }
          didVerify = true;
        } else if (rO.found && rN.found && use.kind !== 'type') {
          didVerify = true;
          const label = displayPath(name, use.path);
          if (use.called && rO.call.length) {
            if (!rN.call.length) {
              addIssue({
                key: `not-callable|${spec}|${use.view}|${label}`, severity: 'breaks', kind: 'not-callable', title: 'no longer a function', path: label,
                message: `\`${label}(...)\` has call signatures in ${name}@${from} typings but none in ${name}@${to}.`,
                evidence: { old: sigText(rO.call), new: '(no call signature)' }, sources: ['types'], symbol: use.path[use.path.length - 1],
              }, site);
            } else if (use.argc != null && accepts(rO.call, use.argc) && !accepts(rN.call, use.argc)) {
              addIssue({
                key: `args|${spec}|${label}|${use.argc}`, severity: 'breaks', kind: 'args-changed', title: 'call no longer matches signature', path: label,
                message: `\`${label}\` is called with ${use.argc} argument${use.argc === 1 ? '' : 's'}; no signature in ${name}@${to} accepts that many.`,
                evidence: { old: sigText(rO.call), new: sigText(rN.call) }, sources: ['types'], symbol: use.path[use.path.length - 1],
              }, site);
            } else if (use.args && use.argc != null) {
              use.args.forEach((kind, i) => {
                if (kind !== 'function') return;
                const oldCb = rO.call.some((s) => i >= s.callable.length ? false : s.callable[i]);
                const fits = rN.call.filter((s) => use.argc >= s.min && use.argc <= s.max);
                const newCb = fits.some((s) => (i < s.callable.length ? s.callable[i] : (s.max === Infinity)));
                if (oldCb && fits.length && !newCb) {
                  addIssue({
                    key: `callback|${spec}|${label}|${i}`, severity: 'review', kind: 'callback-dropped', title: 'callback argument no longer accepted',
                    path: label, message: `\`${label}\` is given a function as argument ${i + 1}, but in ${name}@${to} that parameter no longer accepts one.`,
                    evidence: { old: sigText(rO.call), new: sigText(rN.call) }, sources: ['types'], symbol: use.path[use.path.length - 1],
                  }, site);
                }
              });
            }
          }
          if (use.isNew && rO.ctor.length && use.argc != null && accepts(rO.ctor, use.argc) && rN.ctor.length && !accepts(rN.ctor, use.argc)) {
            addIssue({
              key: `ctor-args|${spec}|${label}|${use.argc}`, severity: 'breaks', kind: 'args-changed', title: 'constructor no longer matches', path: label,
              message: `\`new ${label}(...)\` passes ${use.argc} argument${use.argc === 1 ? '' : 's'}; no constructor in ${name}@${to} accepts that many.`,
              evidence: { old: sigText(rO.ctor), new: sigText(rN.ctor) }, sources: ['types'], symbol: use.path[use.path.length - 1],
            }, site);
          }
        }
      }
    }
    if (didVerify) verified++;
  }

  const list = [...issues.values()].map((e) => ({ ...e, sources: [...e.sources] }));
  list.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.sites.length - a.sites.length);
  const hasBreaks = list.some((i) => i.severity === 'breaks');
  const hasReview = list.some((i) => i.severity === 'review');
  const memberUses = uses.filter((u) => u.kind !== 'module');
  const moduleSites = uses.filter((u) => u.kind === 'module');
  const codeUses = memberUses.length;
  let verdict;
  if (hasBreaks) verdict = 'BREAKS';
  else if (hasReview) verdict = 'REVIEW';
  else if (codeUses === 0 && moduleSites.length === 0) verdict = 'NOT-IMPORTED';
  else if (codeUses === 0) verdict = moduleLoadsOk > 0 ? 'CLEAR' : 'UNVERIFIED';
  else if (verified / codeUses < 0.5) verdict = 'UNVERIFIED';
  else verdict = 'CLEAR';

  return {
    name, from, to, fromAssumed: !!fromAssumed, fromSource, bump: semver.diff(from, to),
    verdict, issues: list, stats: { uses: codeUses, verified, files: new Set(uses.map((u) => u.file)).size, moduleSites: moduleSites.length },
    repo: repoUrl(pk), changelogFiles: changelogFiles.map((f) => f.split('/').pop()), notes,
    types: { old: !!(await getTypes(name))[0], new: !!(await getTypes(name))[1] },
  };
}
