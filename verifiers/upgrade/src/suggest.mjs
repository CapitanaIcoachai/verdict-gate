// Heuristic replacement hints. Always labelled as heuristic: they come from name similarity among
// exports that are NEW in the target version, never from guessing.
function tokens(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function score(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

/**
 * removedPath: e.g. ['sync']; ctxLabel: e.g. 'glob'
 * oldNode/newNode: the containing runtime shape nodes (props) where the member used to live / live now;
 * newRoot: the whole new root shape (replacement may have moved to the top level)
 */
export function suggestReplacement({ ctxLabel, removedName, oldContainer, newContainer, newRoot }) {
  const R = tokens(removedName);
  const ctx = new Set(tokens(ctxLabel));
  if (!R.length) return [];
  const cand = [];
  const addFrom = (props, where) => {
    for (const [k, node] of Object.entries(props || {})) {
      if (where === 'container' && oldContainer && Object.prototype.hasOwnProperty.call(oldContainer, k)) continue; // not new
      cand.push({ name: k, node });
    }
  };
  addFrom(newContainer, 'container');
  if (newRoot) addFrom(newRoot.props, 'root');
  const seen = new Set();
  const scored = [];
  for (const c of cand) {
    if (seen.has(c.name) || c.name === removedName || ['default', '__esModule', 'module.exports'].includes(c.name)) continue;
    seen.add(c.name);
    let C = tokens(c.name);
    const stripped = C.filter((t) => !ctx.has(t));
    if (stripped.length) C = stripped;
    scored.push({ name: c.name, s: score(R, C), t: c.node?.t });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.filter((x) => x.s >= 0.6 && ['function', 'class', 'object'].includes(x.t)).slice(0, 3).map((x) => x.name);
}
