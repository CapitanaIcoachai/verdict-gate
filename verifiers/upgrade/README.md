# Upgrade Radar

**Which dependency upgrades will break *your* code?**

Developers put off dependency upgrades because the real question is hard to answer: not "is there a
new version?" (every tool tells you that) but "if I bump this, what exactly stops working in *my*
code?". Changelogs are long, prose, and written for everyone. You are one project.

Upgrade Radar answers that question with evidence instead of guesses. It compares the **real APIs of
two published versions** of a package and intersects the difference with **the exact members your code
uses**. For every finding it prints the file and line.

```
  BREAKS   chalk       4.1.2 -> 6.0.1   major   chalk: now ESM-only  (+2 more)
  BREAKS   express     4.18.2 -> 5.2.1  major   express().get(→ req).param: removed
  BREAKS   uuid        3.4.0 -> 14.0.2  major   uuid/v4: import path no longer exists
  CLEAR    axios       1.6.0 -> 1.20.0  minor   1 of 1 call sites checked, no API break found
```

No language model, no API key, no account. Nothing is guessed: if it cannot prove something it says
`UNVERIFIED` instead of inventing an answer.

## Run it

```bash
npm install                       # one dependency family: typescript + semver
node bin/upgrade-radar.mjs demo   # bundled sample project with deliberately old dependencies
node bin/upgrade-radar.mjs scan ../my-project --html report.html
node bin/upgrade-radar.mjs check express ../my-project      # deep dive on one package
node bin/upgrade-radar.mjs scan . --fail-on breaks          # exit code 1 for CI
```

Needs Node 20+ and network access to the npm registry. Verified on Node 20.20, 22.23 and 25.9 (same
verdicts on the demo packages tried). The first scan installs each version into
`~/.cache/upgrade-radar` (override with `UPGRADE_RADAR_CACHE`); repeat scans of the same versions take
seconds. Your project is only read, never modified, and it does not need `node_modules`.

## How it works

1. **What you use.** Your `.js/.ts/.mjs/.cjs/.jsx/.tsx` files are parsed with the TypeScript compiler. It
   follows `import`/`require`/dynamic `import()`, aliases, destructuring, call results
   (`const app = express()`) and callback parameters (`app.get('/', (req, res) => ...)`), and uses the
   compiler's scope analysis so a local variable that happens to share a name is not confused with the
   package. ESM syntax in a TypeScript project compiled to CommonJS is treated as the `require()` it
   becomes.
2. **What the old version exports.** The old version is read from the lockfile (or `node_modules`, or the
   exact version in `package.json`; otherwise the lowest version the range allows, and the report says so).
3. **What the new version exports.** Both versions are installed side by side (install scripts never run).
   Their exports are enumerated at runtime for both `require()` and `import()`. That probe runs under
   Node's permission model: no child processes, no file writes, and filesystem reads limited to the cache
   folder (all three measured on Node 20, 22 and 25), and on **Node 25+ also no network** (measured: on Node 20 and 22 the network is still
   reachable inside the sandbox, so use Node 25 if you want that guarantee). It never calls an exported
   function or a getter. Their TypeScript typings (bundled, or
   DefinitelyTyped for the same major) are read from the real `.d.ts` files.
4. **Cross-check.** Every use is checked: does the member still exist, is it still callable or
   constructible, do your arguments still fit a signature, is a callback still accepted, does the deep
   import path still resolve, is the package now ESM-only for a CommonJS project, does it now need a newer
   Node than your `engines` allows, is there a new peer dependency.
5. **Evidence.** Each finding lists the old and new facts it rests on (`runtime`, `types`, `package.json`),
   changelog lines from the package's own shipped changelog that mention the symbol, and, for removed
   exports only, a *clearly labelled heuristic* hint about a similarly named new export.

## What the verdicts mean

| Verdict | Meaning |
|---|---|
| BREAKS | At least one place in your code uses something the new version removed or changed incompatibly. |
| REVIEW | Possible problem the tool cannot prove (more required arguments, Node/peer requirements, changed kind). |
| CLEAR | Every usage that could be checked is compatible. This is about the API surface only. |
| UNVERIFIED | Fewer than half of the usages could be checked (e.g. no usable runtime or typings). |
| NOT-IMPORTED | Never imported in source: CLI tools, config-driven plugins. Package-level facts still apply. |

## Limits (read these)

* **Behaviour changes with an unchanged API are invisible.** Same function, different result: keep your tests.
* Only JS/TS source files. Vue/Svelte templates and config files are not analysed.
* Values that travel through your own objects or functions are followed only while they stay in direct
  variables.
* Methods on objects returned by a call are checked only when the package ships typings; the runtime probe
  never calls package code. Example: Express's `app.del` is gone in v5 but declared in neither typings, so
  it is not reported.
* Packages that need a native build or that throw on import without their install scripts fall back to
  typings only (the report says so under `note:`).
* The runtime probe imports package code to read its exports, inside the sandbox described above.
  Install scripts never run. Without a Node permission flag (older than 20) the probe would run
  unsandboxed and the report says so.

## Tests

```bash
npm test
```

* `test/usage.test.mjs`: scope, aliasing, destructuring, interop, callbacks; one was validated by
  deliberately breaking the scanner and watching the test fail.
* `test/pkgdiff.test.mjs`: dual vs ESM-only classification (including nested `package.json` scopes, the
  case that fooled the first version of this tool on `glob` 13 and `rimraf` 6).
* `test/engine.test.mjs`: ground truth for the bundled demo, checked by hand against the real packages
  (needs network on first run). It asserts what must be found *and* what must not be reported, e.g.
  `glob.sync` still exists in `glob` 13 and is not flagged.

## Layout

```
bin/upgrade-radar.mjs   CLI
src/usage.mjs           finds what your code uses
src/shape.mjs, probe-child.mjs   sandboxed runtime export probe
src/types.mjs           TypeScript typings surface
src/pkgdiff.mjs         ESM/CJS, engines, peer dependencies
src/analyze.mjs         the cross-check
src/report-*.mjs        terminal and HTML reports
demo/legacy-app         sample project, intentionally old
```
