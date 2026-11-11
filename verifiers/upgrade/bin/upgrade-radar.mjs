#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, checkOne } from '../src/scan.mjs';
import { renderText } from '../src/report-text.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { color as c, errMsg } from '../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = `
Upgrade Radar - which dependency upgrades will break YOUR code?

  upgrade-radar scan  [dir]            check every dependency against its newest version
  upgrade-radar check <pkg> [dir]      deep-dive one dependency
  upgrade-radar demo                   run on the bundled legacy-app sample

Options
  --to <version>      target version (default: newest published)
  --from <version>    (check) compare from this version instead of the one in the lockfile
  --only a,b          (scan) only these packages
  --no-dev            (scan) skip devDependencies
  --html <file>       write a self-contained HTML report
  --json <file>       write the full result as JSON
  --fail-on breaks    exit 1 when any upgrade breaks your code (for CI)
  --quiet             summary table only
`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['no-dev', 'quiet', 'help'].includes(k)) o[k] = true; else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (!cmd || o.help || cmd === 'help') { console.log(HELP); return 0; }
  const onProgress = (p) => { if (process.stderr.isTTY) process.stderr.write(c.gray(`\r\x1b[K  ${p.phase}: ${p.message}`)); };
  let report;
  if (cmd === 'scan' || cmd === 'demo') {
    const dir = cmd === 'demo' ? path.join(HERE, '..', 'demo', 'legacy-app') : (o._[1] || '.');
    report = await scanProject({ dir, to: o.to, only: o.only ? o.only.split(',') : null, includeDev: !o['no-dev'], onProgress });
  } else if (cmd === 'check') {
    if (!o._[1]) { console.error('usage: upgrade-radar check <pkg> [dir]'); return 2; }
    report = await checkOne({ dir: o._[2] || '.', name: o._[1], to: o.to, from: o.from });
  } else { console.log(HELP); return 2; }
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  console.log(renderText(report, { verbose: !o.quiet }));
  if (o.html) { fs.writeFileSync(o.html, renderHtml(report)); console.log(c.gray(`\nHTML report: ${path.resolve(o.html)}`)); }
  if (o.json) { fs.writeFileSync(o.json, JSON.stringify(report, null, 2)); console.log(c.gray(`JSON: ${path.resolve(o.json)}`)); }
  if (o['fail-on'] === 'breaks' && report.results.some((r) => r.verdict === 'BREAKS')) return 1;
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(c.red('error: ') + errMsg(e)); process.exit(2); });
