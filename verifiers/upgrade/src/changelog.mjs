// Real text evidence: lines in the package's own shipped changelog that mention the symbol that changed.
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^(change(s|log)|history|releases?|migration|upgrad(e|ing)|breaking)([-_ ]?.*)?\.(md|markdown|txt)$/i;

export function findChangelogs(pkgDir) {
  try {
    return fs.readdirSync(pkgDir).filter((f) => NAME_RE.test(f)).map((f) => path.join(pkgDir, f));
  } catch { return []; }
}

export function grepChangelogs(files, symbol, limit = 3) {
  const needle = symbol.replace(/^.*\./, '');
  if (!needle || needle.length < 3) return [];
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_$]|$)');
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (re.test(lines[i]) && lines[i].trim().length > 3) {
        hits.push({ file: path.basename(f), line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return hits;
}
