// Ground truth for the bundled demo. Every expectation below was verified by hand against the real
// published packages (their package.json / exports / typings), not copied from this tool's output.
// Needs network on first run (npm install into the cache); skipped when the registry is unreachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from '../src/scan.mjs';

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'legacy-app');
let report = null;
let offline = false;

test.before(async () => {
  try {
    const r = await fetch('https://registry.npmjs.org/glob/latest', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('registry');
  } catch { offline = true; return; }
  report = await scanProject({ dir: DEMO });
});

const R = (name) => report.results.find((r) => r.name === name);
const hasIssue = (name, pred) => R(name).issues.some(pred);

test('chalk: chalk.red and chalk.green were removed from the require() shape', (t) => {
  if (offline) return t.skip('offline');
  assert.equal(R('chalk').verdict, 'BREAKS');
  assert.ok(hasIssue('chalk', (i) => i.kind.startsWith('removed') && i.path === 'chalk.red'));
  assert.ok(hasIssue('chalk', (i) => i.kind.startsWith('removed') && i.path === 'chalk.green'));
  assert.ok(hasIssue('chalk', (i) => i.kind === 'esm-only'));
});

test('glob: glob() is no longer callable, but glob.sync still exists (must NOT be reported)', (t) => {
  if (offline) return t.skip('offline');
  assert.equal(R('glob').verdict, 'BREAKS');
  assert.ok(hasIssue('glob', (i) => i.kind === 'not-callable' && i.path === 'glob'));
  assert.ok(!hasIssue('glob', (i) => /glob\.sync/.test(i.path)), 'false positive on glob.sync');
  assert.ok(!hasIssue('glob', (i) => i.kind === 'esm-only'), 'glob 13 ships a CommonJS build: not ESM-only');
});

test('rimraf: default export is no longer a function; package still has a CommonJS build', (t) => {
  if (offline) return t.skip('offline');
  assert.ok(hasIssue('rimraf', (i) => i.kind === 'not-callable'));
  assert.ok(!hasIssue('rimraf', (i) => i.kind === 'esm-only'));
});

test('uuid: the uuid/v4 deep import is gone', (t) => {
  if (offline) return t.skip('offline');
  assert.ok(hasIssue('uuid', (i) => i.kind === 'module-gone' && i.path === 'uuid/v4'));
});

test('node-fetch: require() no longer returns a function', (t) => {
  if (offline) return t.skip('offline');
  assert.ok(hasIssue('node-fetch', (i) => i.kind === 'not-callable'));
  assert.ok(hasIssue('node-fetch', (i) => i.kind === 'esm-only'));
});

test('commander: the default program instance (commander.version) is gone', (t) => {
  if (offline) return t.skip('offline');
  assert.ok(hasIssue('commander', (i) => i.kind.startsWith('removed') && i.path === 'commander.version'));
});

test('express: req.param and res.sendfile found through callback parameters, with their line numbers', (t) => {
  if (offline) return t.skip('offline');
  const param = R('express').issues.find((i) => /req\)\.param$/.test(i.path));
  const sendfile = R('express').issues.find((i) => /res\)\.sendfile$/.test(i.path));
  assert.ok(param && sendfile);
  assert.equal(param.sites[0].file, path.join('src', 'server.js'));
  assert.equal(param.sites[0].line, 9);
  assert.equal(sendfile.sites[0].line, 10);
});

test('axios and lodash minor bumps are CLEAR (no false alarms)', (t) => {
  if (offline) return t.skip('offline');
  assert.equal(R('axios').verdict, 'CLEAR');
  assert.equal(R('lodash').verdict, 'CLEAR');
});

test('every BREAKS issue carries at least one source line, except package-level ones', (t) => {
  if (offline) return t.skip('offline');
  for (const r of report.results) for (const i of r.issues) {
    if (i.severity === 'breaks' && !i.sources.every((s) => s === 'package.json')) assert.ok(i.sites.length > 0, `${r.name}: ${i.path} has no site`);
  }
});
