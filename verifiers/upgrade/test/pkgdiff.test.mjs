import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moduleKind } from '../src/pkgdiff.mjs';

function pkg(pj, nested = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-pkg-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj));
  for (const [rel, content] of Object.entries(nested)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(content));
  }
  return dir;
}

test('plain CommonJS package', () => {
  const pj = { name: 'a', main: 'index.js' };
  assert.equal(moduleKind(pj, pkg(pj)), 'cjs');
});

test('type:module with only a default export is ESM-only (chalk 5/6 style)', () => {
  const pj = { type: 'module', exports: { types: './s/index.d.ts', default: './s/index.js' } };
  assert.equal(moduleKind(pj, pkg(pj)), 'esm-only');
});

test('type:module BUT require condition points into a nested commonjs scope is dual (glob 13 / rimraf 6 style)', () => {
  const pj = {
    type: 'module', main: './dist/commonjs/index.js',
    exports: { '.': { import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' }, require: { types: './dist/commonjs/index.d.ts', default: './dist/commonjs/index.js' } } },
  };
  const dir = pkg(pj, { 'dist/commonjs/package.json': { type: 'commonjs' }, 'dist/esm/package.json': { type: 'module' } });
  assert.equal(moduleKind(pj, dir), 'dual');
});

test('require condition mapped to .cjs is dual; node/default to a type:module .js is ESM-only (uuid 14 style)', () => {
  const dual = { type: 'module', exports: { import: './i.js', require: './r.cjs' } };
  assert.equal(moduleKind(dual, pkg(dual)), 'dual');
  const esm = { type: 'module', exports: { '.': { node: { default: './dist-node/index.js' }, default: './dist/index.js' } } };
  assert.equal(moduleKind(esm, pkg(esm)), 'esm-only');
});

test('type:module with main only is ESM-only', () => {
  const pj = { type: 'module', main: './index.js' };
  assert.equal(moduleKind(pj, pkg(pj)), 'esm-only');
});
