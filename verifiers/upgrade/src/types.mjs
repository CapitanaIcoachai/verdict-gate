// Type-level API surface of one installed package version, read from its real .d.ts files
// (bundled, or DefinitelyTyped @types/<name> of the same major when the package ships none).
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import semver from 'semver';
import { install } from './install.mjs';
import { packument } from './registry.mjs';

function typesPackageName(name) {
  return '@types/' + (name.startsWith('@') ? name.slice(1).replace('/', '__') : name);
}

function bundledTypes(pkgJson) {
  if (pkgJson.types || pkgJson.typings) return true;
  const ex = pkgJson.exports;
  const hasTypesCond = (v) => v && typeof v === 'object' && (v.types || Object.values(v).some((x) => hasTypesCond(x)));
  return !!(ex && hasTypesCond(ex));
}

/** Where do this version's types live? Returns {dir, kind} or null. */
export async function typesLocation(name, version, inst, pkgJson) {
  const idx = path.join(inst.pkgDir, 'index.d.ts');
  if (bundledTypes(pkgJson) || fs.existsSync(idx)) return { dir: inst.dir, kind: 'bundled' };
  try {
    const pk = await packument(typesPackageName(name));
    const major = semver.major(version);
    const minor = semver.minor(version);
    const vers = Object.keys(pk.versions || {}).filter((v) => semver.valid(v) && !semver.prerelease(v));
    const sameMinor = vers.filter((v) => semver.major(v) === major && semver.minor(v) === minor);
    const sameMajor = vers.filter((v) => semver.major(v) === major);
    const pick = (arr) => arr.sort(semver.rcompare)[0];
    const chosen = pick(sameMinor.length ? sameMinor : sameMajor);
    if (!chosen) return null;
    const ti = await install(typesPackageName(name), chosen);
    return { dir: ti.dir, kind: `DefinitelyTyped ${typesPackageName(name)}@${chosen}` };
  } catch {
    return null;
  }
}

const OPTS = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  strict: true,
};

function paramInfo(checker, sf, sig) {
  const params = sig.getParameters();
  let min = 0;
  let max = 0;
  const callable = [];
  const names = [];
  for (const p of params) {
    const d = p.valueDeclaration;
    const isRest = d && ts.isParameter(d) && !!d.dotDotDotToken;
    const optional = d && ts.isParameter(d) && (!!d.questionToken || !!d.initializer);
    if (isRest) max = Infinity; else if (max !== Infinity) max++;
    if (!isRest && !optional) min++;
    let t;
    try { t = checker.getTypeOfSymbolAtLocation(p, sf); } catch { t = null; }
    let c = true;
    if (t) {
      const parts = t.isUnion() ? t.types : [t];
      c = parts.some((x) => x.getCallSignatures().length > 0 || (x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0);
    }
    callable.push(c);
    names.push(p.getName());
  }
  return { min, max, callable, names, text: checker.signatureToString(sig) };
}

export class TypeSurface {
  constructor(program, sf, label) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.sf = sf;
    this.label = label;
    this.moduleSym = this.checker.getSymbolAtLocation(sf) || sf.symbol;
    this.exports = new Map();
    if (this.moduleSym) for (const s of this.checker.getExportsOfModule(this.moduleSym)) this.exports.set(s.getName(), s);
    const eq = this.moduleSym?.exports?.get('export=');
    this.exportEquals = eq ? this.alias(eq) : null;
  }

  alias(sym) {
    try { return sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym; } catch { return sym; }
  }

  typeOfSym(sym) {
    const c = this.checker;
    if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Property |
        ts.SymbolFlags.Method | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Enum | ts.SymbolFlags.Accessor)) {
      return c.getTypeOfSymbolAtLocation(sym, this.sf);
    }
    return c.getDeclaredTypeOfSymbol(sym);
  }

  /** Resolve a use-path. Returns {found,type?,sym?} | {found:false,at} | {unknown:true}. */
  resolve(view, pathArr, kind) {
    const c = this.checker;
    let i = 0;
    let cur = null; // {sym?, type}
    const eq = this.exportEquals;
    if (pathArr.length === 0) {
      // the module value itself: only `export =` modules (CommonJS style) can be called/constructed
      const t = view === 'require' && eq ? this.typeOfSym(eq) : null;
      return {
        found: true, root: true,
        call: t ? t.getCallSignatures().map((x) => paramInfo(c, this.sf, x)) : [],
        ctor: t ? t.getConstructSignatures().map((x) => paramInfo(c, this.sf, x)) : [],
        typeText: '',
      };
    }
    const k0 = pathArr[0];
    if ((k0 === '()' || k0 === 'new()') && !(view === 'require' && eq)) return { found: false, at: 0, notCallable: k0 === '()', notConstructible: k0 === 'new()' };
    const named = this.exports.get(k0);
    if (view === 'require' && eq) {
      cur = { sym: eq, type: this.typeOfSym(eq) };
      if (k0 === 'default' && !named) i = 1; // interop default of `export =`
    } else if (named) {
      const s = this.alias(named);
      cur = { sym: s, type: this.typeOfSym(s) };
      i = 1;
    } else if (k0 === 'default' && eq) {
      cur = { sym: eq, type: this.typeOfSym(eq) };
      i = 1;
    } else if (eq) {
      cur = { sym: eq, type: this.typeOfSym(eq) }; // named import from `export =` module
    } else {
      return { found: false, at: 0 };
    }
    if (kind === 'type') return this.resolveTypeSide(cur, pathArr, i);
    for (; i < pathArr.length; i++) {
      const k = pathArr[i];
      let t = cur.type;
      if (!t) return { unknown: true };
      if (k === '()') {
        const sig = t.getCallSignatures()[0];
        if (!sig) return { found: false, at: i, notCallable: true };
        cur = { type: c.getReturnTypeOfSignature(sig) };
      } else if (k === 'new()') {
        const sig = t.getConstructSignatures()[0];
        if (!sig) return { found: false, at: i, notConstructible: true };
        cur = { type: c.getReturnTypeOfSignature(sig) };
      } else if (k.startsWith('cb:')) {
        const [, ai, pj, argc, np] = k.split(':').map((x, idx) => (idx === 0 || idx === 5 ? x : Number(x)));
        const pt = this.callbackParamType(t, ai, pj, argc, np);
        if (!pt) return { unknown: true };
        cur = { type: pt };
      } else if (k === 'await()') {
        let a;
        try { a = c.getAwaitedType ? c.getAwaitedType(t) : null; } catch { a = null; }
        if (!a) return { unknown: true };
        cur = { type: a };
      } else {
        t = c.getNonNullableType(t);
        const prop = c.getPropertyOfType(c.getApparentType(t), k);
        if (prop) {
          cur = { sym: prop, type: c.getTypeOfSymbolAtLocation(prop, this.sf) };
        } else if (t.getStringIndexType()) {
          cur = { type: t.getStringIndexType() };
        } else if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          return { unknown: true };
        } else {
          return { found: false, at: i };
        }
      }
    }
    const t = cur.type;
    const call = t ? t.getCallSignatures().map((s) => paramInfo(c, this.sf, s)) : [];
    const ctor = t ? t.getConstructSignatures().map((s) => paramInfo(c, this.sf, s)) : [];
    return { found: true, call, ctor, typeText: t ? c.typeToString(t).slice(0, 160) : '' };
  }

  paramTypeAt(sig, idx) {
    const c = this.checker;
    const ps = sig.getParameters();
    if (!ps.length) return null;
    const last = ps[ps.length - 1];
    const lastIsRest = !!(last.valueDeclaration && ts.isParameter(last.valueDeclaration) && last.valueDeclaration.dotDotDotToken);
    if (idx < ps.length - (lastIsRest ? 1 : 0)) return c.getTypeOfSymbolAtLocation(ps[idx], this.sf);
    if (lastIsRest) {
      const t = c.getTypeOfSymbolAtLocation(last, this.sf);
      return c.getIndexTypeOfType(t, ts.IndexKind.Number) || null;
    }
    return null;
  }

  /** Type of parameter `pj` of the function literal passed as argument `ai` of a call with `argc` args. */
  callbackParamType(fnType, ai, pj, argc, np) {
    const c = this.checker;
    const sigs = [...fnType.getCallSignatures(), ...fnType.getConstructSignatures()];
    for (const sig of sigs) {
      const range = paramInfo(c, this.sf, sig);
      if (argc < range.min || argc > range.max) continue;
      const pt = this.paramTypeAt(sig, ai);
      if (!pt) continue;
      const fns = [];
      const take = (x) => { if (x.getCallSignatures().length) fns.push(x); };
      for (const part of pt.isUnion() ? pt.types : [pt]) {
        take(part);
        if (!part.getCallSignatures().length) {
          const el = c.getIndexTypeOfType(part, ts.IndexKind.Number);
          if (el) (el.isUnion() ? el.types : [el]).forEach(take);
        }
      }
      let best = null;
      for (const f of fns) for (const fs of f.getCallSignatures()) {
        const n = fs.getParameters().length;
        if (n >= np && n > pj && (!best || n < best.n)) best = { sig: fs, n };
      }
      if (best) return this.paramTypeAt(best.sig, pj);
    }
    return null;
  }

  resolveTypeSide(cur, pathArr, i) {
    let sym = cur.sym;
    for (; i < pathArr.length; i++) {
      const next = sym?.exports?.get(pathArr[i]) || sym?.members?.get(pathArr[i]);
      if (!next) return { found: false, at: i };
      sym = this.alias(next);
    }
    return { found: true, call: [], ctor: [], typeText: '' };
  }
}

const cache = new Map();

/** Open the type surface for `spec` ("pkg" or "pkg/sub") of an installed version; null if no types. */
export async function openTypes(name, version, inst, pkgJson, spec) {
  const key = inst.key + '|' + spec;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const loc = await typesLocation(name, version, inst, pkgJson);
    if (!loc) return null;
    const containing = path.join(loc.dir, '__ur_probe.mjs');
    const res = ts.resolveModuleName(spec, containing, OPTS, ts.sys).resolvedModule;
    if (!res || !/\.d\.[cm]?ts$/.test(res.resolvedFileName)) return null;
    const program = ts.createProgram([res.resolvedFileName], OPTS);
    const sf = program.getSourceFile(res.resolvedFileName);
    if (!sf) return null;
    return new TypeSurface(program, sf, loc.kind);
  })().catch(() => null);
  cache.set(key, p);
  return p;
}
