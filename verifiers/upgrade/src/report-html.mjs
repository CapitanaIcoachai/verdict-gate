import { headline } from './report-text.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const LABEL = {
  BREAKS: 'Breaks your code', REVIEW: 'Needs review', UNVERIFIED: 'Could not verify', CLEAR: 'No break found',
  'NOT-IMPORTED': 'Not imported in code', 'UP-TO-DATE': 'Up to date', SKIPPED: 'Skipped', ERROR: 'Error',
};
const ORDER = ['BREAKS', 'REVIEW', 'UNVERIFIED', 'CLEAR', 'NOT-IMPORTED', 'UP-TO-DATE', 'SKIPPED', 'ERROR'];

function issueHtml(i) {
  const ev = i.evidenceBy ? Object.entries(i.evidenceBy) : (i.evidence ? [[i.sources.join('+'), i.evidence]] : []);
  const evHtml = ev.filter(([, e]) => e && (e.old || e.new)).map(([src, e]) =>
    `<div class="ev"><span class="evsrc">${esc(src)}</span><div><span class="k">old</span> <code>${esc(e.old)}</code></div><div><span class="k">new</span> <code>${esc(e.new)}</code></div></div>`).join('');
  const sug = i.suggestion
    ? `<p class="sug">Possible replacement: ${i.suggestion.names.map((n) => `<code>${esc(n)}</code>`).join(', ')} <span class="muted">(${esc(i.suggestion.how)})</span></p>` : '';
  const cl = (i.changelog || []).length
    ? `<ul class="cl">${i.changelog.map((h) => `<li><span class="loc">${esc(h.file)}:${h.line}</span> ${esc(h.text)}</li>`).join('')}</ul>` : '';
  const seen = new Set();
  const sites = i.sites.filter((s) => { const k = `${s.file}:${s.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const siteHtml = sites.length
    ? `<ul class="sites">${sites.slice(0, 12).map((s) => `<li><span class="loc">${esc(s.file)}:${s.line}</span><code class="snip">${esc(s.snippet)}</code></li>`).join('')}${sites.length > 12 ? `<li class="muted">… and ${sites.length - 12} more lines</li>` : ''}</ul>`
    : '<p class="muted small">Package-level finding (no single source line).</p>';
  return `<article class="issue sev-${i.severity}">
    <div class="ihead"><span class="sev">${i.severity === 'breaks' ? 'Breaks' : i.severity === 'review' ? 'Review' : 'Info'}</span><code class="path">${esc(i.path)}</code><span class="srcs">${esc(i.sources.join(' + '))}</span></div>
    <p class="msg">${md(i.message)}</p>${evHtml}${sug}${cl}${siteHtml}
  </article>`;
}

function depHtml(r) {
  const ver = r.from && r.to ? `<span class="ver"><span>${esc(r.from)}</span><span class="arrow">&rarr;</span><span>${esc(r.to)}</span></span>` : '<span class="ver"></span>';
  const bump = r.bump ? `<span class="bump bump-${esc(r.bump)}">${esc(r.bump)}</span>` : '<span class="bump"></span>';
  const hasBody = (r.issues && r.issues.length) || (r.notes && r.notes.length) || r.fromAssumed;
  const stats = r.stats && r.stats.uses ? `<span class="muted small">${r.stats.uses} usage${r.stats.uses === 1 ? '' : 's'} in ${r.stats.files} file${r.stats.files === 1 ? '' : 's'}</span>` : '';
  const body = hasBody ? `<div class="body">
    ${r.fromAssumed ? `<p class="muted small">Current version taken from ${esc(r.fromSource)} (no lockfile entry found).</p>` : ''}
    ${(r.issues || []).map(issueHtml).join('')}
    ${(r.notes || []).map((n) => `<p class="muted small">Note: ${esc(n)}</p>`).join('')}
    ${r.repo ? `<p class="small"><a href="${esc(r.repo)}" rel="noopener">Release notes &amp; changelog &rarr; ${esc(r.repo.replace('https://', ''))}</a></p>` : ''}
  </div>` : '';
  return `<details class="dep v-${esc(r.verdict)}" data-verdict="${esc(r.verdict)}"${r.verdict === 'BREAKS' && false ? ' open' : ''}>
    <summary><span class="name">${esc(r.name)}</span>${ver}${bump}<span class="pill pill-${esc(r.verdict)}">${esc(LABEL[r.verdict])}</span><span class="hl">${esc(headline(r))} ${stats}</span></summary>${body}
  </details>`;
}

export function renderHtml(report) {
  const counts = {};
  for (const r of report.results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const tiles = ORDER.filter((v) => counts[v]).map((v) => `<button class="tile t-${v}" data-filter="${v}"><b>${counts[v]}</b><span>${esc(LABEL[v])}</span></button>`).join('');
  const when = new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upgrade Radar - ${esc(report.project.name)}</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#14181f;--muted:#5d6675;--line:#e3e6ec;--code:#eef0f4;
--breaks:#c62828;--breaks-bg:#fdecec;--review:#9a6700;--review-bg:#fff4d6;--clear:#1b7a43;--clear-bg:#e5f5ec;--unv:#1d5fb4;--unv-bg:#e6effb;--gray:#6b7380;--gray-bg:#eceef2;--accent:#14181f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1218;--panel:#171b23;--ink:#e8ebf0;--muted:#9aa3b2;--line:#262c38;--code:#1f2530;
--breaks:#ff7b72;--breaks-bg:#3a1a1c;--review:#e3b341;--review-bg:#3a2f12;--clear:#56d364;--clear-bg:#14301f;--unv:#79b8ff;--unv-bg:#14263f;--gray:#9aa3b2;--gray-bg:#232936;--accent:#e8ebf0}}
:root[data-theme=dark]{--bg:#0f1218;--panel:#171b23;--ink:#e8ebf0;--muted:#9aa3b2;--line:#262c38;--code:#1f2530;--breaks:#ff7b72;--breaks-bg:#3a1a1c;--review:#e3b341;--review-bg:#3a2f12;--clear:#56d364;--clear-bg:#14301f;--unv:#79b8ff;--unv-bg:#14263f;--gray:#9aa3b2;--gray-bg:#232936;--accent:#e8ebf0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:0 16px 64px}
header{padding:36px 0 18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;font-size:13px;text-transform:uppercase;color:var(--muted)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--breaks);box-shadow:0 0 0 4px var(--breaks-bg)}
h1{margin:10px 0 4px;font-size:28px;line-height:1.2}
.sub{color:var(--muted);margin:0}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 6px;border-radius:5px;word-break:break-word}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 14px}
.tile{flex:1 1 130px;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:12px 14px;cursor:pointer;color:var(--ink);font:inherit}
.tile b{display:block;font-size:26px;line-height:1.1}
.tile span{color:var(--muted);font-size:13px}
.tile.on{outline:2px solid var(--accent)}
.t-BREAKS b{color:var(--breaks)}.t-REVIEW b{color:var(--review)}.t-CLEAR b{color:var(--clear)}.t-UNVERIFIED b{color:var(--unv)}
.bar{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:8px 0 12px;color:var(--muted);font-size:13px}
.bar button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}
.dep{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:0 0 10px;overflow:hidden}
.dep summary{display:grid;grid-template-columns:150px 190px 56px 168px 1fr;gap:10px;align-items:center;padding:12px 14px;cursor:pointer;list-style:none}
.dep summary::-webkit-details-marker{display:none}
.dep:not(:has(.body)) summary{cursor:default}
.name{font-weight:650;word-break:break-word}
.ver{display:flex;gap:6px;align-items:center;font:12.5px ui-monospace,Menlo,monospace;color:var(--muted)}
.arrow{color:var(--ink)}
.bump{font-size:12px;color:var(--muted)}
.bump-major{color:var(--breaks);font-weight:600}
.pill{justify-self:start;font-size:12px;font-weight:650;padding:3px 9px;border-radius:999px;white-space:nowrap}
.pill-BREAKS{background:var(--breaks-bg);color:var(--breaks)}.pill-REVIEW{background:var(--review-bg);color:var(--review)}
.pill-CLEAR{background:var(--clear-bg);color:var(--clear)}.pill-UNVERIFIED{background:var(--unv-bg);color:var(--unv)}
.pill-NOT-IMPORTED,.pill-UP-TO-DATE,.pill-SKIPPED,.pill-ERROR{background:var(--gray-bg);color:var(--gray)}
.hl{color:var(--muted);font-size:13.5px;min-width:0}
.body{border-top:1px solid var(--line);padding:6px 14px 14px}
.issue{border-left:3px solid var(--line);padding:10px 0 4px 12px;margin:12px 0}
.sev-breaks{border-left-color:var(--breaks)}.sev-review{border-left-color:var(--review)}.sev-info{border-left-color:var(--gray)}
.ihead{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sev{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;padding:2px 7px;border-radius:5px}
.sev-breaks .sev{background:var(--breaks-bg);color:var(--breaks)}.sev-review .sev{background:var(--review-bg);color:var(--review)}.sev-info .sev{background:var(--gray-bg);color:var(--gray)}
.path{font-weight:600}
.srcs{margin-left:auto;font-size:12px;color:var(--muted)}
.msg{margin:6px 0}
.ev{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12.5px;margin:6px 0;padding:8px 10px;background:var(--bg);border-radius:8px}
.ev>div{grid-column:2}.evsrc{grid-row:span 2;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;align-self:center}
.k{display:inline-block;width:28px;color:var(--muted)}
.sug{margin:6px 0}
.sites,.cl{list-style:none;margin:8px 0 0;padding:0}
.sites li,.cl li{display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:13px}
.loc{font:12px ui-monospace,Menlo,monospace;color:var(--muted);white-space:nowrap}
.snip{background:transparent;padding:0;white-space:pre-wrap}
.muted{color:var(--muted)}.small{font-size:13px}
.limits{margin-top:30px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px 18px 14px}
.limits h2{font-size:16px;margin:14px 0 6px}.limits ul{margin:6px 0 0;padding-left:20px;color:var(--muted)}.limits li{margin:4px 0}
footer{margin-top:22px;color:var(--muted);font-size:12.5px}
a{color:var(--unv)}
@media (max-width:820px){.dep summary{grid-template-columns:1fr auto;grid-template-areas:"n p" "v b" "h h"}
.name{grid-area:n}.pill{grid-area:p;justify-self:end}.ver{grid-area:v}.bump{grid-area:b;justify-self:end}.hl{grid-area:h}.srcs{margin-left:0}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand"><span class="dot"></span>Upgrade Radar</div>
  <h1>${esc(report.project.name)}</h1>
  <p class="sub">${report.results.length} dependencies &middot; ${report.filesScanned} source files scanned &middot; ${esc(when)}</p>
</header>
<div class="tiles">${tiles}</div>
<div class="bar"><span id="count"></span><span><button id="all">Expand all</button> <button id="none">Collapse all</button></span></div>
<main id="deps">
${report.results.map(depHtml).join('\n')}
</main>
<section class="limits">
  <h2>How these results are produced</h2>
  <ul>
    <li>Both versions are installed side by side in an isolated cache (install scripts never run). Their <b>real exports</b> are read inside a Node sandbox with no network and no child processes, and their <b>real TypeScript typings</b> are read from the same packages (or DefinitelyTyped for the same major).</li>
    <li>Your code is parsed with the TypeScript compiler, so renamed imports, destructuring, call results and callback parameters are followed to the member that is really used. Every finding lists the exact lines.</li>
    <li>No language model is involved, so nothing here is guessed. The only heuristic is the &ldquo;possible replacement&rdquo; hint, and it is labelled as one.</li>
  </ul>
  <h2>What it does not check</h2>
  <ul>
    <li><b>Behaviour changes with the same API</b> (same function, different result). Keep your tests.</li>
    <li>Only <code>.js .jsx .ts .tsx .mjs .cjs .mts .cts</code> files. Vue/Svelte templates, config files, and CLI-only tools (linters, bundlers) are not analysed; those show as &ldquo;not imported&rdquo;.</li>
    <li>Values that travel through your own data structures or functions are not followed past the point where they leave a direct variable.</li>
    <li>Methods on objects returned by a call are only checked when the package ships typings; runtime introspection never calls package functions.</li>
  </ul>
</section>
<footer>Generated by Upgrade Radar. Version information comes from the npm registry at scan time.</footer>
</div>
<script>
(function(){
  var deps=[].slice.call(document.querySelectorAll('.dep')),tiles=[].slice.call(document.querySelectorAll('.tile')),active=null;
  function apply(){var n=0;deps.forEach(function(d){var show=!active||d.getAttribute('data-verdict')===active;d.style.display=show?'':'none';if(show)n++});
    document.getElementById('count').textContent=n+' of '+deps.length+' shown'+(active?' ('+active.toLowerCase()+')':'');
    tiles.forEach(function(t){t.classList.toggle('on',t.getAttribute('data-filter')===active)})}
  tiles.forEach(function(t){t.addEventListener('click',function(){var f=t.getAttribute('data-filter');active=active===f?null:f;apply()})});
  document.getElementById('all').addEventListener('click',function(){deps.forEach(function(d){if(d.querySelector('.body'))d.open=true})});
  document.getElementById('none').addEventListener('click',function(){deps.forEach(function(d){d.open=false})});
  deps.forEach(function(d){if(d.getAttribute('data-verdict')==='BREAKS'||d.getAttribute('data-verdict')==='REVIEW'){}});
  apply();
})();
</script>
</body>
</html>`;
}
