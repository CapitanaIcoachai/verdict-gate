#!/usr/bin/env node
// Verdict Gate adapter for Upgrade Radar: turns the engine's report into one VERDICT line (schema verdict-gate/1).
//
//   node verdict.mjs report  <report.json>                 convert an existing report (no network)
//   node verdict.mjs demo    [--json verdict.json]         run the bundled legacy-app demo, then convert
//   node verdict.mjs scan    <dir> [--json verdict.json]   scan a project against newest versions
//   node verdict.mjs mr      --base <sha> --head <sha> [--dir <project>]   check only the dependencies whose
//                            version changed in package.json between base and head (the MR mode used in CI)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, 'bin', 'upgrade-radar.mjs');
const LIMITS = 'Judges only the API members your code touches, from real runtime exports and .d.ts types. Behaviour changes that keep the same signature are not detected. Member checks for packages without types rely on runtime shape only.';

function toVerdict(report, target) {
  const results = report.results || [];
  const ev = [];
  for (const r of results) {
    for (const i of r.issues || []) {
      const site = (i.sites || [])[0];
      ev.push({ package: r.name, from: r.from, to: r.to, severity: i.severity, kind: i.kind, title: i.title, path: i.path || null,
        file: site ? site.file : null, line: site ? site.line : null, message: i.message || null, sites: (i.sites || []).length });
    }
    if (!(r.issues || []).length && r.verdict) ev.push({ package: r.name, from: r.from, to: r.to, verdict: r.verdict, reason: r.reason || null, checked: r.stats ? r.stats.verified : null });
  }
  const breaks = results.filter((r) => r.verdict === 'BREAKS');
  const review = results.filter((r) => ['REVIEW', 'UNVERIFIED', 'ERROR'].includes(r.verdict));
  const clear = results.filter((r) => r.verdict === 'CLEAR' || r.verdict === 'UP-TO-DATE');
  let outcome, detail;
  if (breaks.length) { outcome = 'FAIL'; detail = `BREAKS: ${breaks.map((r) => r.name).join(', ')} break ${breaks.reduce((n, r) => n + (r.issues || []).filter((i) => i.severity === 'breaks').length, 0)} call site(s)`; }
  else if (review.length) { outcome = 'UNSURE'; detail = `REVIEW: ${review.map((r) => `${r.name} (${r.verdict})`).join(', ')}`; }
  else if (clear.length) { outcome = 'PASS'; detail = `CLEAR: ${clear.length} upgrade(s) checked, no API break at any call site`; }
  else { outcome = 'UNSURE'; detail = 'NOTHING TO CHECK: no dependency resolved'; }
  const v = { schema: 'verdict-gate/1', verifier: 'upgrade', target, outcome, detail, evidence: ev.slice(0, 200), guards: [], needs_human: outcome !== 'PASS', limits: LIMITS };
  if (breaks.length) v.fix_hint = breaks.map((r) => (r.issues || []).filter((i) => i.suggestion).map((i) => `${r.name}: ${i.suggestion}`)).flat().slice(0, 5).join(' | ') || 'rewrite the listed call sites against the new API';
  return v;
}

function parse(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) o[a.slice(2)] = argv[++i]; else o._.push(a); } return o; }
function readPkgAt(dir, ref) { try { return JSON.parse(execFileSync('git', ['-C', dir, 'show', `${ref}:./package.json`], { encoding: 'utf8' })); } catch { return null; } }
function deps(p) { return { ...(p?.dependencies || {}), ...(p?.devDependencies || {}) }; }

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  let report, target;
  const tmp = path.join(os.tmpdir(), `ur-${process.pid}.json`);
  if (cmd === 'report') { report = JSON.parse(fs.readFileSync(o._[1], 'utf8')); target = report.project?.name || 'report'; }
  else if (cmd === 'demo' || cmd === 'scan') {
    const args = cmd === 'demo' ? ['demo'] : ['scan', o._[1] || '.'];
    execFileSync(process.execPath, [BIN, ...args, '--quiet', '--json', tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
    report = JSON.parse(fs.readFileSync(tmp, 'utf8')); target = report.project?.name || cmd;
  } else if (cmd === 'mr') {
    const dir = o.dir || '.';
    const a = deps(readPkgAt(dir, o.base)), b = deps(readPkgAt(dir, o.head));
    const changed = Object.keys(b).filter((k) => a[k] && a[k] !== b[k]);
    if (!changed.length) {
      const v = { schema: 'verdict-gate/1', verifier: 'upgrade', target: 'package.json', outcome: 'UNSURE', detail: 'NOTHING TO CHECK: no dependency version changed in this MR', evidence: [], guards: [], needs_human: false, limits: LIMITS };
      print(v, o.json); return 3;
    }
    const results = [];
    for (const name of changed) {
      const from = a[name].replace(/^[\^~=v\s]+/, ''), to = b[name].replace(/^[\^~=v\s]+/, '');
      execFileSync(process.execPath, [BIN, 'check', name, dir, '--from', from, '--to', to, '--quiet', '--json', tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
      results.push(...JSON.parse(fs.readFileSync(tmp, 'utf8')).results);
    }
    report = { results }; target = changed.map((n) => `${n} ${a[n]} -> ${b[n]}`).join(', ');
  } else { console.error('usage: verdict.mjs report <file> | demo | scan <dir> | mr --base <sha> --head <sha> [--dir <project>]'); return 2; }
  const v = toVerdict(report, target);
  print(v, o.json);
  return { PASS: 0, FAIL: 2, UNSURE: 3, BROKEN: 5 }[v.outcome];
}
function print(v, file) { console.log('VERDICT ' + JSON.stringify(v)); if (file) fs.writeFileSync(file, JSON.stringify(v, null, 2)); }
main().then((c) => process.exit(c), (e) => { console.error('error: ' + (e.message || e)); process.exit(1); });
