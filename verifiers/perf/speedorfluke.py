#!/usr/bin/env python3
"""SpeedOrFluke, the performance verifier of Verdict Gate.

An MR claims "faster". This verifier runs the same benchmark command on base and head, alternating
(ABAB) so that machine noise hits both sides equally, and decides with a Mann-Whitney U test whether
the difference is real, and with a bootstrap confidence interval how big it is.

  FASTER                  head is faster, p < alpha, and the median speedup is at least --min-gain
  SLOWER                  head is slower, p < alpha (a regression: FAIL)
  NO MEASURABLE DIFFERENCE p >= alpha
  NEED MORE RUNS          p < alpha but the confidence interval still crosses --min-gain
  BROKEN                  the benchmark fails on one side

Metric: wall time of the command by default; with --metric the last number printed by the command
(for benchmarks that print their own timing, lower is better). Guard: the benchmark file must not
change between base and head. Standard library only, needs git.

  speedorfluke.py compare --repo . --base origin/main --head HEAD --bench "python3 bench.py" [--runs 30] [--bench-file bench.py]
  speedorfluke.py demo
"""
import argparse, json, math, os, random, re, shutil, statistics, subprocess, sys, tempfile, time

LIMITS = ("Measures one benchmark command on one machine. A speedup that depends on data the benchmark does not cover is not seen. "
          "Wall time includes interpreter start-up; use --metric for benchmarks that print their own timing.")

# ---------- statistics ----------
def mann_whitney(a, b):
    """Two-sided Mann-Whitney U with normal approximation and tie correction. Returns (U_a, p, direction) where direction<0 means a tends to be smaller."""
    n1, n2 = len(a), len(b)
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    ranks, i, tie_term = [0.0] * (n1 + n2), 0, 0.0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1): ranks[k] = r
        t = j - i + 1
        if t > 1: tie_term += t ** 3 - t
        i = j + 1
    r1 = sum(rk for rk, (v, g) in zip(ranks, allv) if g == 0)
    u1 = r1 - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    n = n1 + n2
    sigma = math.sqrt(n1 * n2 / 12 * ((n + 1) - tie_term / (n * (n - 1)))) if n > 1 else 0
    if sigma == 0: return u1, 1.0, 0
    z = (u1 - mu) / sigma
    p = 2 * (1 - 0.5 * math.erfc(-abs(z) / math.sqrt(2)))
    return u1, max(0.0, min(1.0, p)), (-1 if u1 < mu else 1)

def bootstrap_gain(base, head, iters=2000, conf=0.95, seed=7):
    """Gain = 1 - median(head)/median(base). Percentile bootstrap CI."""
    rnd = random.Random(seed); g = []
    for _ in range(iters):
        b = [rnd.choice(base) for _ in base]; h = [rnd.choice(head) for _ in head]
        mb = statistics.median(b)
        g.append(1 - statistics.median(h) / mb if mb else 0.0)
    g.sort(); lo = g[int((1 - conf) / 2 * iters)]; hi = g[int((1 + conf) / 2 * iters) - 1]
    return 1 - statistics.median(head) / statistics.median(base), lo, hi

# ---------- running ----------
NUM = re.compile(r"(-?\d+(?:\.\d+)?)(?!.*\d)")
def run_once(cwd, cmd, metric):
    t = time.perf_counter()
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=600)
    dt = time.perf_counter() - t
    if r.returncode != 0: return None, (r.stderr or r.stdout)[-300:]
    if metric:
        m = NUM.search((r.stdout or "").strip().splitlines()[-1] if r.stdout.strip() else "")
        if not m: return None, "no number in benchmark output"
        return float(m.group(1)), None
    return dt, None

def measure(base_dir, head_dir, cmd, runs, metric, warmup=2):
    for d in (base_dir, head_dir):
        for _ in range(warmup):
            v, err = run_once(d, cmd, metric)
            if err: return None, None, (("base" if d == base_dir else "head"), err)
    base, head = [], []
    for i in range(runs):
        order = ((base_dir, base), (head_dir, head)) if i % 2 == 0 else ((head_dir, head), (base_dir, base))
        for d, acc in order:
            v, err = run_once(d, cmd, metric)
            if err: return None, None, (("base" if d == base_dir else "head"), err)
            acc.append(v)
    return base, head, None

def guard(repo, base, head, bench_file):
    if not bench_file: return []
    d = subprocess.run(["git", "-C", repo, "diff", "--stat", f"{base}...{head}", "--", bench_file], capture_output=True, text=True).stdout.strip()
    return [f"benchmark file changed: {bench_file}"] if d else []

def decide(base, head, alpha, min_gain, guards, target, broken=None):
    v = {"schema": "verdict-gate/1", "verifier": "perf", "target": target, "guards": guards, "limits": LIMITS}
    if broken:
        v.update(outcome="BROKEN", detail=f"BROKEN: benchmark fails on {broken[0]}", evidence=[{"error": broken[1]}], needs_human=True); return v
    u, p, direction = mann_whitney(head, base)
    gain, lo, hi = bootstrap_gain(base, head)
    ev = [{"where": "base", "runs": len(base), "median": round(statistics.median(base), 6), "min": round(min(base), 6)},
          {"where": "head", "runs": len(head), "median": round(statistics.median(head), 6), "min": round(min(head), 6)},
          {"p_mann_whitney": float(f"{p:.3g}"), "median_gain": round(gain, 4), "gain_ci95": [round(lo, 4), round(hi, 4)]}]
    if p >= alpha:
        v.update(outcome="FAIL", detail=f"NO MEASURABLE DIFFERENCE: p = {p:.3g}, median gain {gain:+.1%} (CI {lo:+.1%} to {hi:+.1%})", evidence=ev, needs_human=True,
                 fix_hint="the change does not move the benchmark; profile before optimising")
    elif direction > 0:
        v.update(outcome="FAIL", detail=f"SLOWER: head is slower, p = {p:.3g}, median change {gain:+.1%}", evidence=ev, needs_human=True, fix_hint="performance regression: revert or profile the hot path")
    elif lo >= min_gain:
        v.update(outcome="PASS", detail=f"FASTER: median gain {gain:+.1%} (CI {lo:+.1%} to {hi:+.1%}), p = {p:.3g}", evidence=ev, needs_human=bool(guards))
        if guards: v["detail"] = "FASTER, BUT BENCHMARK CHANGED (" + "; ".join(guards) + ")"
    else:
        v.update(outcome="UNSURE", detail=f"NEED MORE RUNS: gain {gain:+.1%} is significant but the CI ({lo:+.1%} to {hi:+.1%}) still crosses the {min_gain:.0%} threshold", evidence=ev, needs_human=True)
    return v

def worktree(repo, ref, root):
    d = os.path.join(root, re.sub(r"[^\w.-]", "_", ref)); subprocess.run(["git", "-C", repo, "worktree", "add", "-q", "--detach", d, ref], check=True); return d

def compare(repo, base, head, bench, runs, metric, alpha, min_gain, bench_file, target):
    root = tempfile.mkdtemp(prefix="sof-")
    try:
        b, h = worktree(repo, base, root), worktree(repo, head, root)
        bv, hv, broken = measure(b, h, bench, runs, metric)
        return decide(bv, hv, alpha, min_gain, guard(repo, base, head, bench_file), target, broken)
    finally:
        for d in os.listdir(root): subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", os.path.join(root, d)], capture_output=True)
        shutil.rmtree(root, ignore_errors=True)

# ---------- demo ----------
BENCH = '''import time, sys
sys.path.insert(0, ".")
from lib import unique_sorted
data = [i % 997 for i in range(60000)]
t = time.perf_counter()
for _ in range(3): unique_sorted(data)
print(f"{time.perf_counter() - t:.6f}")
'''
LIB_SLOW = '''def unique_sorted(items):
    out = []
    for x in items:
        if x not in out:          # O(n^2): list membership
            out.append(x)
    return sorted(out)
'''
LIB_FAST = '''def unique_sorted(items):
    return sorted(set(items))     # O(n log n)
'''
LIB_PLACEBO = LIB_SLOW.replace("out = []", "out = []  # pre-sized for speed")
LIB_SLOWER = LIB_SLOW.replace("    for x in items:", "    for x in items + items:   # processes the input twice")

def demo(args):
    root = tempfile.mkdtemp(prefix="sof-demo-"); repo = os.path.join(root, "repo"); os.makedirs(repo)
    g = lambda *a: subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True)
    open(os.path.join(repo, "bench.py"), "w").write(BENCH); open(os.path.join(repo, "lib.py"), "w").write(LIB_SLOW)
    g("init", "-q", "-b", "main"); g("config", "user.email", "demo@verdict.gate"); g("config", "user.name", "demo"); g("add", "."); g("commit", "-q", "-m", "slow unique_sorted")
    for name, body in (("mr-fast", LIB_FAST), ("mr-placebo", LIB_PLACEBO), ("mr-slower", LIB_SLOWER)):
        g("checkout", "-q", "-b", name, "main"); open(os.path.join(repo, "lib.py"), "w").write(body); g("commit", "-q", "-am", f"perf: {name}")
    g("checkout", "-q", "main")
    out = []
    for name in ("mr-fast", "mr-placebo", "mr-slower"):
        t = time.time()
        v = compare(repo, "main", name, "python3 bench.py", args.runs, True, args.alpha, args.min_gain, "bench.py", f"{name}: python3 bench.py")
        print(f"# {name:11s} {v['outcome']:7s} {v['detail']}   ({time.time() - t:.1f}s)", file=sys.stderr)
        print("VERDICT " + json.dumps(v)); out.append(v)
    shutil.rmtree(root, ignore_errors=True)
    if args.json: json.dump(out, open(args.json, "w"), indent=2)
    return 0

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    def common(p):
        p.add_argument("--runs", type=int, default=30); p.add_argument("--alpha", type=float, default=0.05)
        p.add_argument("--min-gain", type=float, default=0.05, help="minimum median speedup to call FASTER (default 5%%)"); p.add_argument("--json")
    c = sub.add_parser("compare"); common(c)
    c.add_argument("--repo", default="."); c.add_argument("--base", required=True); c.add_argument("--head", default="HEAD")
    c.add_argument("--bench", required=True, help="benchmark command"); c.add_argument("--metric", action="store_true", help="use the last number printed by the command instead of wall time")
    c.add_argument("--bench-file", help="path of the benchmark file, for the guard"); c.add_argument("--target")
    d = sub.add_parser("demo"); common(d); d.set_defaults(runs=15)
    a = ap.parse_args()
    if a.cmd == "demo": return demo(a)
    v = compare(a.repo, a.base, a.head, a.bench, a.runs, a.metric, a.alpha, a.min_gain, a.bench_file, a.target or a.bench)
    print("VERDICT " + json.dumps(v))
    if a.json: json.dump(v, open(a.json, "w"), indent=2)
    return {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5}[v["outcome"]] if not (v["outcome"] == "PASS" and v["guards"]) else 6

if __name__ == "__main__":
    sys.exit(main())
