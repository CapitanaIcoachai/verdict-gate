import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanUsage, parseSpecifier } from '../src/usage.mjs';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-usage-'));
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const scan = (files, pkgs) => scanUsage(fixture(files), new Set(pkgs)).byPackage;
const members = (res, pkg) => res.get(pkg).uses.filter((u) => u.kind !== 'module');
const paths = (res, pkg) => members(res, pkg).map((u) => u.path.join('.') + (u.called ? '()' : '') + (u.isNew ? ' new' : ''));

test('parseSpecifier: plain, subpath, scoped, relative, builtin', () => {
  assert.deepEqual(parseSpecifier('glob'), { pkg: 'glob', sub: '' });
  assert.deepEqual(parseSpecifier('uuid/v4'), { pkg: 'uuid', sub: 'v4' });
  assert.deepEqual(parseSpecifier('@scope/pkg/lib/x'), { pkg: '@scope/pkg', sub: 'lib/x' });
  assert.equal(parseSpecifier('./local'), null);
  assert.equal(parseSpecifier('node:fs'), null);
});

test('a shadowing parameter is NOT a use of the package', () => {
  const r = scan({ 'a.js': `const glob = require('glob');\nfunction f(glob) { return glob.nothing(); }\nglob.sync('x');\n` }, ['glob']);
  const p = paths(r, 'glob');
  assert.ok(p.includes('sync()'), p.join());
  assert.ok(!p.some((x) => x.startsWith('nothing')), 'shadowed name leaked: ' + p.join());
});

test('destructuring with alias, and new on a destructured class', () => {
  const r = scan({ 'a.js': `const { sync: s, Glob } = require('glob');\ns('x');\nnew Glob('y', {});\n` }, ['glob']);
  const u = members(r, 'glob');
  assert.ok(u.some((x) => x.path.join('.') === 'sync' && x.called && x.argc === 1));
  assert.ok(u.some((x) => x.path.join('.') === 'Glob' && x.isNew && x.argc === 2));
});

test('ESM default, named alias and namespace imports use the import view', () => {
  const r = scan({ 'a.mjs': `import g, { globSync as gs } from 'glob';\nimport * as ns from 'glob';\ng.sync('a'); gs('b'); ns.glob('c');\n` }, ['glob']);
  const u = members(r, 'glob');
  assert.ok(u.every((x) => x.view === 'import'));
  assert.ok(u.some((x) => x.path.join('.') === 'default.sync' && x.called));
  assert.ok(u.some((x) => x.path.join('.') === 'globSync' && x.called));
  assert.ok(u.some((x) => x.path.join('.') === 'glob' && x.called));
});

test('TypeScript compiled to CommonJS: ESM syntax is a require() with interop', () => {
  const r = scan({
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'commonjs', esModuleInterop: true } }),
    'a.ts': `import chalk from 'chalk';\nchalk.red('x');\n`,
  }, ['chalk']);
  const u = members(r, 'chalk').find((x) => x.path.join('.') === 'default.red');
  assert.ok(u, JSON.stringify(members(r, 'chalk')));
  assert.equal(u.view, 'require');
  assert.equal(u.interop, true);
});

test('dynamic import binds the namespace', () => {
  const r = scan({ 'a.mjs': `const m = await import('chalk');\nm.default.red('x');\n` }, ['chalk']);
  assert.ok(members(r, 'chalk').some((x) => x.path.join('.') === 'default.red' && x.view === 'import'));
});

test('subpath require records the subpath', () => {
  const r = scan({ 'a.js': `const v4 = require('uuid/v4');\nv4();\n` }, ['uuid']);
  const mod = r.get('uuid').uses.find((u) => u.kind === 'module');
  assert.equal(mod.sub, 'v4');
});

test('call results and callback parameters are followed', () => {
  const r = scan({ 'a.js': `const express = require('express');\nconst app = express();\napp.get('/', (req, res) => { req.param('x'); res.sendfile('f'); });\n` }, ['express']);
  const p = paths(r, 'express');
  assert.ok(p.includes('()()') === false);
  assert.ok(p.some((x) => x === '()'.concat('.get()')), p.join());
  assert.ok(p.some((x) => /cb:1:0:2:2:req\.param\(\)/.test(x)), p.join());
  assert.ok(p.some((x) => /cb:1:1:2:2:res\.sendfile\(\)/.test(x)), p.join());
});

test('type-only imports are type uses, not runtime uses', () => {
  const r = scan({ 'a.ts': `import type { Foo } from 'pkg';\nlet x: Foo;\n` }, ['pkg']);
  const u = r.get('pkg').uses;
  assert.ok(u.length > 0);
  assert.ok(u.every((x) => x.kind !== 'value'), JSON.stringify(u.map((x) => x.kind)));
});

test('unrelated packages and relative imports are ignored', () => {
  const r = scan({ 'a.js': `const x = require('./glob');\nconst y = require('lodash');\ny.map();\n` }, ['glob']);
  assert.equal(r.get('glob').uses.length, 0);
});

test('node_modules and build output are not scanned', () => {
  const dir = fixture({ 'node_modules/x/i.js': `require('glob')`, 'dist/o.js': `require('glob')`, 'src/ok.js': `require('glob')` });
  const res = scanUsage(dir, new Set(['glob']));
  assert.equal(res.files, 1);
});
