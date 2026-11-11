// Finds every place the project uses a given npm package, down to the exact member chain:
//   import g from 'glob'; g.sync(p)            -> path ['default','sync'], called, 1 arg
//   const { v4 } = require('uuid'); v4()        -> path ['v4'], called
//   const app = express(); app.del('/x', h)     -> path ['default','()','del'], called, 2 args
// Scope-correct: uses the TypeScript binder, so shadowed names are not confused with the import.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', 'vendor',
  '.turbo', '.svelte-kit', 'target', '.venv', '__pycache__', '.parcel-cache', '.output',
]);
const MAX_FILES = 6000;

export function parseSpecifier(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('#')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2) return null;
    return { pkg: parts[0] + '/' + parts[1], sub: parts.slice(2).join('/') };
  }
  return { pkg: parts[0], sub: parts.slice(1).join('/') };
}

export function collectFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!SRC_EXT.has(ext)) continue;
        if (/\.d\.[cm]?ts$/.test(e.name) || /\.min\.[cm]?js$/.test(e.name)) continue;
        out.push(full);
      }
    }
  })(root);
  return out;
}

function loadTsOptions(root) {
  try {
    const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    if (!cfgPath || !path.resolve(cfgPath).startsWith(path.resolve(root))) return {};
    const { config } = ts.readConfigFile(cfgPath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(config || {}, ts.sys, path.dirname(cfgPath)).options || {};
  } catch { return {}; }
}

function compilesToCjs(file, tsOpts, pkgType) {
  const ext = path.extname(file);
  const isTs = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
  if (!isTs) return false;
  if (ext === '.cts') return true;
  if (ext === '.mts') return false;
  const M = ts.ModuleKind;
  const m = tsOpts.module;
  if (m === undefined) return false;
  if (m === M.CommonJS || m === M.AMD || m === M.UMD || m === M.System) return true;
  if (m === M.Node16 || m === M.NodeNext || m === M.Node18 || m === M.Node20) return pkgType !== 'module';
  return false;
}

function classifyArg(a) {
  if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return 'function';
  if (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) return 'string';
  if (ts.isNumericLiteral(a)) return 'number';
  if (ts.isObjectLiteralExpression(a)) return 'object';
  if (ts.isArrayLiteralExpression(a)) return 'array';
  if (a.kind === ts.SyntaxKind.TrueKeyword || a.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  if (ts.isSpreadElement(a)) return 'spread';
  return 'other';
}

function isTypePosition(id) {
  for (let n = id.parent, prev = id; n; prev = n, n = n.parent) {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return true;
    if (ts.isExpressionWithTypeArguments(n)) {
      const h = n.parent;
      // `class A extends B` is a value use; `implements X` / `interface extends X` are type uses
      return ts.isHeritageClause(h) ? h.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(h.parent) : true;
    }
    if (ts.isTypeQueryNode?.(n)) return true;
    if (ts.isStatement(n) || ts.isBlock(n)) return false;
    if (ts.isQualifiedName(n) || ts.isEntityName?.(n)) continue;
  }
  return false;
}

export function scanUsage(root, names, onlyFiles) {
  const wanted = new Set(names);
  const files = onlyFiles || collectFiles(root);
  const result = new Map([...wanted].map((n) => [n, { uses: [], bindingsSeen: 0 }]));
  if (!files.length) return { byPackage: result, files: 0, tsOpts: {} };

  const tsOpts = loadTsOptions(root);
  const rootPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return {}; } })();
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: false, noResolve: true, noLib: true, types: [], noEmit: true, skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    scanFile(sf, file);
  }
  return { byPackage: result, files: files.length, tsOpts };

  function scanFile(sf, file) {
    const toCjs = compilesToCjs(file, tsOpts, rootPkg.type);
    const isTs = /\.[cm]?tsx?$/.test(file);
    const lines = sf.text.split(/\r?\n/);
    const identsByText = new Map();
    const bindings = [];
    const queue = [];
    const seenSym = new Set();

    const rel = path.relative(root, file);
    const loc = (node) => {
      const pos = node.getStart(sf);
      const { line, character } = sf.getLineAndCharacterOfPosition(pos);
      return { file: rel, line: line + 1, col: character + 1, snippet: (lines[line] || '').trim().slice(0, 160) };
    };
    const emit = (b, u, node) => {
      const bucket = result.get(b.pkg);
      if (!bucket || bucket.uses.length >= 3000) return;
      bucket.uses.push({
        pkg: b.pkg, sub: b.sub, view: b.view, interop: b.interop, via: b.via, kind: u.kind || 'value',
        path: u.path.slice(), called: !!u.called, isNew: !!u.isNew, argc: u.argc ?? null, args: u.args || null,
        decl: !!u.decl, root: b.rootName || `require('${b.pkg}')`, ...loc(node),
      });
    };

    function addBinding(b, nameNode) {
      const sym = checker.getSymbolAtLocation(nameNode);
      if (!sym || seenSym.has(sym)) return;
      seenSym.add(sym);
      b.symbol = sym;
      b.name = nameNode.text;
      b.rootName = b.rootName || nameNode.text;
      b.valueRefs = 0; b.typeRefs = 0;
      bindings.push(b);
      queue.push(b);
      result.get(b.pkg).bindingsSeen++;
    }

    function bindPattern(nameNode, pathArr, base, declNode) {
      if (ts.isIdentifier(nameNode)) {
        addBinding({ ...base, path: pathArr.slice(), derived: true, declNode }, nameNode);
      } else if (ts.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.elements) {
          if (el.dotDotDotToken) { emit(base, { path: pathArr, decl: true }, el); continue; }
          let key = null;
          if (el.propertyName) {
            if (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) key = el.propertyName.text;
          } else if (ts.isIdentifier(el.name)) key = el.name.text;
          if (key == null) continue;
          const sub = [...pathArr, key];
          emit(base, { path: sub, decl: true }, el);
          bindPattern(el.name, sub, base, declNode);
        }
      }
    }

    // `pkg.method(…, (req, res) => …)`: the callback's parameters carry whatever type the signature declares for them
    function bindCallbackParams(callNode, calleePath, b) {
      const args = callNode.arguments || [];
      if (args.some((a) => ts.isSpreadElement(a))) return;
      args.forEach((a, i) => {
        if (!(ts.isArrowFunction(a) || ts.isFunctionExpression(a))) return;
        a.parameters.forEach((param, j) => {
          if (!ts.isIdentifier(param.name)) return;
          const nb = { pkg: b.pkg, sub: b.sub, view: b.view, interop: b.interop, via: b.via, typeOnly: false, derived: true,
            path: [...calleePath, `cb:${i}:${j}:${args.length}:${a.parameters.length}:${param.name.text}`], rootName: param.name.text };
          addBinding(nb, param.name);
        });
      });
    }

    // climb a member/call chain starting at `startNode`, emitting a use for each call step and the end of the chain
    function climb(startNode, basePath, b, opts = {}) {
      let node = startNode;
      const p0 = basePath.slice();
      let locNode = startNode;
      let endedWithCall = false;
      for (;;) {
        const p = node.parent;
        if (!p) break;
        if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p) ||
            ts.isSatisfiesExpression?.(p) || (ts.isAsExpression(p) && p.expression === node)) { node = p; continue; }
        if (ts.isAwaitExpression(p) && p.expression === node) {
          if (!(opts.dynamicImportCall && node === startNode)) p0.push('await()');
          node = p; endedWithCall = false; continue;
        }
        if (ts.isPropertyAccessExpression(p) && p.expression === node) {
          p0.push(p.name.text); node = p; locNode = p.name; endedWithCall = false; continue;
        }
        if (ts.isElementAccessExpression(p) && p.expression === node && p.argumentExpression && ts.isStringLiteralLike(p.argumentExpression)) {
          p0.push(p.argumentExpression.text); node = p; locNode = p.argumentExpression; endedWithCall = false; continue;
        }
        if (ts.isCallExpression(p) && p.expression === node) {
          const hasSpread = p.arguments.some((a) => ts.isSpreadElement(a));
          emit(b, { path: p0, called: true, argc: hasSpread ? null : p.arguments.length, args: p.arguments.map(classifyArg) }, locNode);
          bindCallbackParams(p, p0.slice(), b);
          p0.push('()'); node = p; endedWithCall = true; continue;
        }
        if (ts.isNewExpression(p) && p.expression === node) {
          const args = p.arguments || [];
          emit(b, { path: p0, isNew: true, argc: args.some((a) => ts.isSpreadElement(a)) ? null : args.length, args: args.map(classifyArg) }, locNode);
          p0.push('new()'); node = p; endedWithCall = true; continue;
        }
        if (ts.isTaggedTemplateExpression(p) && p.tag === node) {
          emit(b, { path: p0, called: true, argc: null }, locNode);
          p0.push('()'); node = p; endedWithCall = true; continue;
        }
        break;
      }
      // what happens with the value at the end of the chain?
      let ctx = node;
      let parent = node.parent;
      while (parent && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))) { ctx = parent; parent = parent.parent; }
      if (parent && ts.isVariableDeclaration(parent) && parent.initializer === ctx) {
        if (ts.isIdentifier(parent.name) || ts.isObjectBindingPattern(parent.name)) {
          const trail = p0.slice();
          if (ts.isAwaitExpression(ctx) && ctx !== node && !(opts.dynamicImportCall)) trail.push('await()');
          if (!endedWithCall && trail.length > b.path.length) emit(b, { path: trail, decl: true }, locNode);
          bindPattern(parent.name, trail, b, parent);
          return;
        }
      }
      if (!endedWithCall) emit(b, { path: p0, decl: p0.length === basePath.length && !!opts.isDecl }, locNode);
    }

    // ---- pass 1: collect candidate identifiers + module-binding sites
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const arr = identsByText.get(node.text);
        if (arr) arr.push(node); else identsByText.set(node.text, [node]);
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const ps = parseSpecifier(node.moduleSpecifier.text);
        if (ps && wanted.has(ps.pkg)) {
          const base = { pkg: ps.pkg, sub: ps.sub, view: toCjs ? 'require' : 'import', interop: toCjs && !!tsOpts.esModuleInterop, via: 'import', typeOnly: false };
          const clause = node.importClause;
          const clauseTypeOnly = !!clause?.isTypeOnly;
          if (!clauseTypeOnly) emit(base, { path: [], kind: 'module' }, node);
          if (!clause) {
            emit(base, { path: [], decl: true }, node);
            result.get(ps.pkg).bindingsSeen++;
          } else {
            if (clause.name) addBinding({ ...base, typeOnly: clauseTypeOnly, path: ['default'], isImport: true, declNode: node }, clause.name);
            const nb = clause.namedBindings;
            if (nb && ts.isNamespaceImport(nb)) addBinding({ ...base, typeOnly: clauseTypeOnly, path: [], isImport: true, declNode: node }, nb.name);
            else if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) {
                const imported = (el.propertyName || el.name).text;
                addBinding({ ...base, typeOnly: clauseTypeOnly || el.isTypeOnly, path: [imported], isImport: true, declNode: node }, el.name);
              }
            }
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
                 ts.isStringLiteralLike(node.moduleReference.expression)) {
        const ps = parseSpecifier(node.moduleReference.expression.text);
        if (ps && wanted.has(ps.pkg)) {
          emit({ pkg: ps.pkg, sub: ps.sub, view: 'require', interop: false, via: 'require' }, { path: [], kind: 'module' }, node);
          addBinding({ pkg: ps.pkg, sub: ps.sub, view: 'require', interop: false, via: 'require', typeOnly: false, path: [], isImport: true, declNode: node }, node.name);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const ps = parseSpecifier(node.moduleSpecifier.text);
        if (ps && wanted.has(ps.pkg)) {
          const base = { pkg: ps.pkg, sub: ps.sub, view: toCjs ? 'require' : 'import', interop: false, via: 'export-from' };
          result.get(ps.pkg).bindingsSeen++;
          if (!node.isTypeOnly) emit(base, { path: [], kind: 'module' }, node);
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) emit({ ...base }, { path: [(el.propertyName || el.name).text], decl: true, kind: node.isTypeOnly || el.isTypeOnly ? 'type' : 'value' }, el);
          } else emit(base, { path: [], decl: true }, node);
        }
      } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynImport) {
          const ps = parseSpecifier(node.arguments[0].text);
          if (ps && wanted.has(ps.pkg)) {
            const b = { pkg: ps.pkg, sub: ps.sub, view: isRequire ? 'require' : 'import', interop: false, via: isRequire ? 'require' : 'dynamic-import', typeOnly: false, path: [] };
            result.get(ps.pkg).bindingsSeen++;
            emit(b, { path: [], kind: 'module' }, node);
            climb(node, [], b, { dynamicImportCall: isDynImport, isDecl: true });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    // ---- pass 2: resolve references to each binding (symbol identity => scope-correct)
    while (queue.length) {
      const b = queue.shift();
      const cands = identsByText.get(b.name) || [];
      for (const id of cands) {
        const par = id.parent;
        if (id === b.declNode?.name) continue;
        if (par && (ts.isImportSpecifier(par) || ts.isImportClause(par) || ts.isNamespaceImport(par) || ts.isImportEqualsDeclaration(par) ||
            (ts.isVariableDeclaration(par) && par.name === id) || (ts.isBindingElement(par) && (par.name === id || par.propertyName === id)) ||
            (ts.isParameter(par) && par.name === id) || (ts.isFunctionDeclaration(par) && par.name === id) ||
            (ts.isPropertyAccessExpression(par) && par.name === id) || (ts.isPropertyAssignment(par) && par.name === id))) continue;
        if (checker.getSymbolAtLocation(id) !== b.symbol) continue;
        if (b.typeOnly || isTypePosition(id)) {
          b.typeRefs++;
          // type use: collect qualified chain A.B.C
          let node = id; const p0 = b.path.slice();
          while (node.parent && ts.isQualifiedName(node.parent) && node.parent.left === node) { p0.push(node.parent.right.text); node = node.parent; }
          emit(b, { path: p0, kind: 'type' }, id);
          continue;
        }
        b.valueRefs++;
        if (par && ts.isExportSpecifier(par)) { emit(b, { path: b.path }, id); continue; }
        if (par && ts.isShorthandPropertyAssignment(par)) { emit(b, { path: b.path }, id); continue; }
        climb(id, b.path, b);
      }
      // the import statement itself: does the thing we import still exist? (an unused removed import still breaks)
      if (b.isImport && !b.derived) {
        const kind = b.typeOnly || (isTs && b.valueRefs === 0 && b.typeRefs > 0) ? 'type' : 'value';
        if (!(b.valueRefs + b.typeRefs > 0 && kind === 'value' && b.path.length === 0)) {
          emit(b, { path: b.path, decl: true, kind: isTs && b.valueRefs === 0 && b.typeRefs === 0 ? 'type' : kind }, b.declNode);
        }
      }
    }
  }
}
