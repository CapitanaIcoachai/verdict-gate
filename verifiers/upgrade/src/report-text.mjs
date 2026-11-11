import { color as c } from './util.mjs';

const BADGE = {
  BREAKS: (s) => c.bold(c.red(s)), REVIEW: (s) => c.bold(c.yellow(s)), UNVERIFIED: (s) => c.bold(c.blue(s)),
  CLEAR: (s) => c.bold(c.green(s)), 'NOT-IMPORTED': (s) => c.gray(s), 'UP-TO-DATE': (s) => c.gray(s), SKIPPED: (s) => c.gray(s), ERROR: (s) => c.red(s),
};
const pad = (s, n) => String(s).padEnd(n);

export function headline(r) {
  if (r.verdict === 'ERROR' || r.verdict === 'SKIPPED') return r.reason || '';
  if (r.verdict === 'UP-TO-DATE') return 'already on the newest version';
  if (r.verdict === 'NOT-IMPORTED') return 'not imported in source (CLI / config / plugin use is not analysed)';
  if (r.verdict === 'CLEAR') return `${r.stats.verified} of ${r.stats.uses} call sites checked, no API break found`;
  if (r.verdict === 'UNVERIFIED') return `only ${r.stats.verified} of ${r.stats.uses} call sites could be verified (no usable runtime/types)`;
  const b = r.issues.filter((i) => i.severity === 'breaks');
  const first = (b[0] || r.issues[0]);
  const n = b.length || r.issues.length;
  return `${first.path}: ${first.title}${n > 1 ? `  (+${n - 1} more)` : ''}`;
}

export function renderText(report, { verbose = true } = {}) {
  const out = [];
  const rs = report.results;
  out.push(`${c.bold('Upgrade Radar')}  ${report.project.name}  ${c.gray(`${report.filesScanned} source files scanned`)}`);
  out.push('');
  const w = Math.max(10, ...rs.map((r) => r.name.length)) + 2;
  for (const r of rs) {
    const ver = r.from && r.to ? `${r.from} -> ${r.to}` : '';
    const bump = r.bump ? c.gray(r.bump) : '';
    out.push(`  ${BADGE[r.verdict](pad(r.verdict, 12))} ${pad(r.name, w)} ${pad(ver, 24)} ${pad(bump, 6)} ${headline(r)}`);
  }
  const counts = {};
  for (const r of rs) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  out.push('');
  out.push(c.gray('  ' + Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join('  ·  ')));

  if (verbose) {
    for (const r of rs.filter((x) => x.issues?.length)) {
      out.push('');
      out.push(c.bold(`${r.name} ${r.from} -> ${r.to}`) + (r.fromAssumed ? c.gray(`  (current version assumed from ${r.fromSource})`) : ''));
      for (const i of r.issues) {
        const tag = i.severity === 'breaks' ? c.red('BREAKS') : i.severity === 'review' ? c.yellow('REVIEW') : c.gray('info  ');
        out.push(`  ${tag} ${i.message}`);
        const ev = i.evidenceBy ? Object.entries(i.evidenceBy) : (i.evidence ? [[i.sources.join('+'), i.evidence]] : []);
        for (const [src, e] of ev) if (e && (e.old || e.new)) out.push(c.gray(`         [${src}] old: ${e.old}   new: ${e.new}`));
        if (i.suggestion) out.push(c.cyan(`         possible replacement: ${i.suggestion.names.map((n) => '`' + n + '`').join(', ')}  (${i.suggestion.how})`));
        for (const h of i.changelog || []) out.push(c.gray(`         changelog ${h.file}:${h.line}  ${h.text}`));
        const lines = [];
        for (const s of i.sites) if (!lines.some((x) => x.file === s.file && x.line === s.line)) lines.push(s);
        for (const s of lines.slice(0, 4)) out.push(`         ${c.dim(`${s.file}:${s.line}`)}  ${s.snippet}`);
        if (lines.length > 4) out.push(c.gray(`         ... and ${lines.length - 4} more line(s)`));
      }
      for (const n of r.notes || []) out.push(c.gray(`  note: ${n}`));
    }
  }
  return out.join('\n');
}
