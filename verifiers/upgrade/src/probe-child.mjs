// Runs INSIDE the isolated cache dir (copied there as __ur_probe.mjs), under Node's permission model:
// no network, no child processes, filesystem read limited to that dir. It only enumerates the shape of
// what a package exports. It never calls an exported function and never invokes a getter.
import { createRequire } from 'node:module';

const realWrite = process.stdout.write.bind(process.stdout);
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = () => {};
const require = createRequire(import.meta.url);
const specs = JSON.parse(process.argv[2]);

const SKIP_FN = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);
let budget = 25000;

function ownNames(obj, stopAt) {
  const names = new Map();
  let o = obj;
  let own = true;
  while (o && o !== stopAt && o !== Object.prototype && o !== Function.prototype) {
    for (const k of Reflect.ownKeys(o)) {
      if (typeof k !== 'string') continue;
      if (!names.has(k)) names.set(k, { holder: o, inherited: !own });
    }
    o = Object.getPrototypeOf(o);
    own = false;
  }
  return names;
}

function describe(v, depth, isNs) {
  if (--budget < 0) return { t: 'truncated' };
  if (v === null) return { t: 'null' };
  const t = typeof v;
  if (t !== 'function' && t !== 'object') return { t };
  const node = { t: 'object' };
  if (t === 'function') {
    let src = '';
    try { src = Function.prototype.toString.call(v); } catch { /* ignore */ }
    node.t = /^class[\s{]/.test(src) ? 'class' : 'function';
    node.len = v.length;
  } else if (Array.isArray(v)) {
    return { t: 'array' };
  }
  if (depth >= 3) { node.deep = true; return node; }
  const props = {};
  let n = 0;
  for (const [k, { holder, inherited }] of ownNames(v)) {
    if (t === 'function' && SKIP_FN.has(k)) continue;
    if (++n > 400) { node.capped = true; break; }
    const d = Object.getOwnPropertyDescriptor(holder, k);
    if (!d) continue;
    if (d.get || d.set) { props[k] = { t: 'getter' }; if (inherited) props[k].inh = 1; continue; }
    const child = describe(d.value, depth + 1);
    if (inherited) child.inh = 1;
    props[k] = child;
  }
  node.props = props;
  if (t === 'function' && v.prototype && typeof v.prototype === 'object') {
    const protoProps = {};
    let m = 0;
    for (const [k, { holder }] of ownNames(v.prototype)) {
      if (k === 'constructor') continue;
      if (++m > 300) break;
      const d = Object.getOwnPropertyDescriptor(holder, k);
      if (!d) continue;
      protoProps[k] = (d.get || d.set) ? { t: 'getter' } : { t: typeof d.value === 'function' ? 'function' : typeof d.value, len: typeof d.value === 'function' ? d.value.length : undefined };
    }
    node.proto = protoProps;
  }
  return node;
}

const out = {};
for (const s of specs) {
  const r = {};
  try { r.require = { shape: describe(require(s), 0) }; }
  catch (e) { r.require = { error: `${e?.code || e?.name || 'Error'}: ${String(e?.message || e).split('\n')[0].slice(0, 200)}` }; }
  try { const ns = await import(s); r.import = { shape: describe(ns, 0, true) }; }
  catch (e) { r.import = { error: `${e?.code || e?.name || 'Error'}: ${String(e?.message || e).split('\n')[0].slice(0, 200)}` }; }
  out[s] = r;
}
// wait for the pipe to drain: process.exit() right after a large write truncates it
realWrite('\n@@UR@@' + JSON.stringify(out) + '@@END@@\n', () => process.exit(0));
