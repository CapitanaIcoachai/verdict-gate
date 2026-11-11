#!/usr/bin/env python3
"""FixOrFluke, the flaky verifier of Verdict Gate.

Reruns one test on both sides of a merge request (base and head), alternating runs so that
machine noise hits both sides equally, and decides with statistics whether the fix worked:

  FIXED            head has 0 failures, one-sided Fisher p < alpha, 95% upper bound of the
                   residual failure rate <= target
  NOT FIXED        head still fails ("no measurable effect" if p >= alpha, "better, still flaky" otherwise)
  NEED MORE RUNS   head has 0 failures but the evidence is not enough yet (prints how many runs are needed)
  NOT REPRODUCED   base never failed: nothing can be said about the fix
  BROKEN           the first runs on one side all fail: the test or the command is broken there

A diff guard looks at the test file between base and head: removed or loosened assertions,
skips, retries. A FIXED with a guard becomes "FIXED, BUT TEST WEAKENED" and needs a human.

Standard library only. Needs git. Prints one line "VERDICT {json}" (schema verdict-gate/1).

  fixorfluke.py compare --repo . --base origin/main --head HEAD --test "python3 -m unittest -q test_checkout" [--runs 100]
  fixorfluke.py demo            builds a temporary repo with a real flaky bug and three MRs, verifies all three
  fixorfluke.py ci-verify       reads CI_MERGE_REQUEST_DIFF_BASE_SHA / CI_COMMIT_SHA and FOF_TEST, FOF_TEST_FILE
  fixorfluke.py bisect --repo . --good v1.2.0 --bad HEAD --test "..."   which commit made the test flaky? (statistical bisection)
  fixorfluke.py demo-bisect     eight commits, the fifth introduces the flakiness: bisect finds it
"""
import argparse, json, math, os, re, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

LIMITS = ("Measures only what it runs: a flakiness that shows up only in another environment is reported as NOT REPRODUCED. "
          "The diff guard catches common weakening patterns, not all of them.")

# ---------- statistics ----------
def fisher_one_sided(kb, nb, kh, nh):
    """P(head failures <= kh | margins). Small p = head fails less than base."""
    K, N = kb + kh, nb + nh
    def pmf(x): return math.comb(nh, x) * math.comb(nb, K - x) / math.comb(N, K)
    return min(1.0, sum(pmf(x) for x in range(max(0, K - nb), kh + 1)))

def upper_bound(k, n, conf=0.95):
    """One-sided Clopper-Pearson upper bound of the failure rate."""
    a = 1 - conf
    if k == 0: return 1 - a ** (1 / n)
    if k >= n: return 1.0
    def cdf(p): return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))
    lo, hi = k / n, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid) > a: lo = mid
        else: hi = mid
    return hi

def runs_needed(target, conf=0.95): return math.ceil(math.log(1 - conf) / math.log(1 - target))

# ---------- running ----------
def run_once(cwd, cmd, env, timeout):
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, env=env, timeout=timeout)
        return r.returncode == 0, (r.stderr or r.stdout)[-400:].decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return False, "timeout"

def preflight(side_dir, cmd, env, timeout, n=6):
    """BROKEN if the first n runs all fail with the same tail of output."""
    tails = []
    for _ in range(n):
        ok, tail = run_once(side_dir, cmd, env, timeout)
        if ok: return False, None
        tails.append(tail.strip().splitlines()[-1] if tail.strip() else "")
    return len(set(tails)) == 1, tails[0]

def compare(base_dir, head_dir, cmd, runs, jobs, timeout):
    env = dict(os.environ); env.pop("PYTHONHASHSEED", None)
    tasks = [t for i in range(runs) for t in (("base", base_dir), ("head", head_dir))]  # ABAB
    res = {"base": [0, 0], "head": [0, 0]}
    def one(t):
        e = dict(env); e["FOF_RUN_ID"] = f"{t[0]}-{os.getpid()}-{time.time_ns()}"
        with tempfile.TemporaryDirectory(prefix="fof-") as td:
            e["TMPDIR"] = td
            return run_once(t[1], cmd, e, timeout)[0]
    with ThreadPoolExecutor(max(1, jobs)) as ex:
        for (side, _), ok in zip(tasks, ex.map(one, tasks)):
            res[side][0] += (not ok); res[side][1] += 1
    return res

# ---------- diff guard ----------
PAT_ASSERT = re.compile(r'\b(assert\w*|expect\(|should\.|t\.ok|t\.equal)')
PAT_WEAK = [
    (re.compile(r'@(pytest\.mark\.)?(skip|skipif|xfail)|unittest\.skip|\.skip\(|\bxit\(|\bit\.skip|test\.skip|\.only\(|t\.Skip\('), "skip/xfail added"),
    (re.compile(r'flaky\(|reruns\s*=|retryTimes|retries\s*[:=]\s*[1-9]|--reruns|@retry|rerunfailures'), "retry added"),
    (re.compile(r'assertLessEqual|assertGreaterEqual|assertTrue\(True\)|assertIsNotNone|assertAlmostEqual|toBeCloseTo|pytest\.approx|toBeTruthy|pass\s*#'), "assertion loosened"),
    (re.compile(r'timeout\s*[:=(]\s*\d+|time\.sleep\(|setTimeout\(\s*\d{4,}'), "timeout raised or sleep added"),
]
def guard(repo, base, head, test_file):
    if not test_file: return []
    d = subprocess.run(["git", "-C", repo, "diff", "-U0", f"{base}...{head}", "--", test_file], capture_output=True, text=True).stdout
    rem = [l[1:] for l in d.splitlines() if l.startswith('-') and not l.startswith('---')]
    add = [l[1:] for l in d.splitlines() if l.startswith('+') and not l.startswith('+++')]
    flags = []
    if rem or add: flags.append(f"test file changed (+{len(add)} -{len(rem)} lines)")
    ra = sum(bool(PAT_ASSERT.search(l)) for l in rem); aa = sum(bool(PAT_ASSERT.search(l)) for l in add)
    if ra > aa: flags.append(f"{ra - aa} assertion(s) removed")
    for pat, msg in PAT_WEAK:
        if any(pat.search(l) for l in add) and msg not in flags: flags.append(msg)
    return flags

# ---------- verdict ----------
def decide(kb, nb, kh, nh, alpha, looks, target, conf, broken, guards, test_id):
    a = alpha / max(1, looks)
    v = {"schema": "verdict-gate/1", "verifier": "flaky", "target": test_id, "guards": guards, "limits": LIMITS}
    ev = [{"where": "base", "runs": nb, "failures": kb}, {"where": "head", "runs": nh, "failures": kh}]
    if broken:
        v.update(outcome="BROKEN", detail=f"BROKEN: {broken[0]} fails every early run with the same error", evidence=ev + [{"error": broken[1]}], needs_human=True)
        return v
    if kb == 0:
        v.update(outcome="UNSURE", detail=f"NOT REPRODUCED: 0 failures on base out of {nb}", evidence=ev, needs_human=True)
        return v
    p = fisher_one_sided(kb, nb, kh, nh); ev.append({"p": float(f"{p:.3g}"), "alpha_used": float(f"{a:.3g}")})
    if kh > 0:
        v.update(outcome="FAIL", detail="NOT FIXED, better but still flaky" if p < a else "NOT FIXED, no measurable effect", evidence=ev, needs_human=True,
                 fix_hint="the change does not remove the failure; look for order- or time-dependent state")
        return v
    ub = upper_bound(0, nh, conf); ev.append({"upper_bound_95": float(f"{ub:.3g}")})
    if p < a and ub <= target:
        detail = f"FIXED: residual failure rate below {target:.0%} at {conf:.0%} confidence"
        if guards: detail = f"FIXED, BUT TEST WEAKENED ({'; '.join(guards)})"
        v.update(outcome="PASS", detail=detail, evidence=ev, needs_human=bool(guards))
    else:
        need = runs_needed(target, conf)
        v.update(outcome="UNSURE", detail=f"NEED MORE RUNS: {need} clean head runs needed for {target:.0%}", evidence=ev + [{"runs_needed": need}], needs_human=True)
    return v

# ---------- worktrees ----------
def worktree(repo, ref, root):
    d = os.path.join(root, re.sub(r'[^\w.-]', '_', ref))
    subprocess.run(["git", "-C", repo, "worktree", "add", "-q", "--detach", d, ref], check=True)
    return d

def cleanup(repo, root):
    for d in os.listdir(root):
        subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", os.path.join(root, d)], capture_output=True)
    shutil.rmtree(root, ignore_errors=True)

def run_compare(repo, base, head, cmd, test_id, test_file, runs, jobs, timeout, alpha, looks, target, conf, setup):
    root = tempfile.mkdtemp(prefix="fof-wt-")
    try:
        b, h = worktree(repo, base, root), worktree(repo, head, root)
        env = dict(os.environ); env.pop("PYTHONHASHSEED", None)
        if setup:
            for d in (b, h): subprocess.run(setup, shell=True, cwd=d, check=True, capture_output=True)
        broken = None
        for name, d in (("base", b), ("head", h)):
            is_broken, err = preflight(d, cmd, env, timeout)
            if is_broken: broken = (name, err); break
        if broken: return decide(0, 0, 0, 0, alpha, looks, target, conf, broken, [], test_id)
        total = {"base": [0, 0], "head": [0, 0]}
        for look in range(1, looks + 1):
            r = compare(b, h, cmd, runs, jobs, timeout)
            for s in total: total[s][0] += r[s][0]; total[s][1] += r[s][1]
            kb, nb = total["base"]; kh, nh = total["head"]
            v = decide(kb, nb, kh, nh, alpha, looks, target, conf, None, guard(repo, base, head, test_file), test_id)
            if v["outcome"] != "UNSURE" or v["detail"].startswith("NOT REPRODUCED"): break
        return v
    finally:
        cleanup(repo, root)

# ---------- demo ----------
HERE = os.path.dirname(os.path.abspath(__file__))
def demo(args):
    src = os.path.join(HERE, "demo_src")
    diffs = os.path.join(HERE, "demo_mrs")
    root = tempfile.mkdtemp(prefix="fof-demo-")
    repo = os.path.join(root, "repo")
    shutil.copytree(src, repo, ignore=shutil.ignore_patterns("__pycache__"))
    g = lambda *a: subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True)
    g("init", "-q", "-b", "main"); g("config", "user.email", "demo@verdict.gate"); g("config", "user.name", "demo")
    g("add", "."); g("commit", "-q", "-m", "shop with a flaky checkout test")
    for mr in ("mr-placebo", "mr-fix", "mr-weaken"):
        g("checkout", "-q", "-b", mr, "main"); g("apply", os.path.join(diffs, mr + ".diff")); g("commit", "-q", "-am", f"fix flaky test_total ({mr})")
    g("checkout", "-q", "main")
    cmd = "python3 -m unittest -q test_checkout.TestTotal.test_total"
    out = []
    for mr in ("mr-placebo", "mr-fix", "mr-weaken"):
        t = time.time()
        v = run_compare(repo, "main", mr, cmd, "test_checkout.TestTotal.test_total", "test_checkout.py", args.runs, args.jobs, args.timeout, args.alpha, 1, args.target, 0.95, None)
        v["target"] = f"{mr}: test_checkout.TestTotal.test_total"
        print(f"# {mr:11s} {v['outcome']:7s} {v['detail']}   ({time.time() - t:.1f}s)", file=sys.stderr)
        print("VERDICT " + json.dumps(v)); out.append(v)
    shutil.rmtree(root, ignore_errors=True)
    if args.json: json.dump(out, open(args.json, "w"), indent=2)
    return 0

# ---------- bisect: which commit made the test flaky? ----------
def probe_flaky(repo, ref, cmd, runs, jobs, timeout, root):
    """Returns (failures, runs) for one commit. 0 failures out of `runs` means: residual rate below target at 95% (runs = runs_needed)."""
    d = worktree(repo, ref, root)
    env = dict(os.environ); env.pop("PYTHONHASHSEED", None)
    fails = 0
    def one(i):
        e = dict(env); e["FOF_RUN_ID"] = f"bisect-{i}-{time.time_ns()}"
        with tempfile.TemporaryDirectory(prefix="fof-") as td:
            e["TMPDIR"] = td; return run_once(d, cmd, e, timeout)[0]
    with ThreadPoolExecutor(max(1, jobs)) as ex:
        for ok in ex.map(one, range(runs)): fails += (not ok)
    subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", d], capture_output=True)
    return fails, runs

def bisect(repo, good, bad, cmd, jobs, timeout, target, conf, test_id):
    """Sequential bisection over good..bad. A commit is 'stable' when 0 failures out of runs_needed(target) runs
    (residual rate below target at conf), 'flaky' at the first failure. Converges on the first flaky commit."""
    commits = subprocess.run(["git", "-C", repo, "rev-list", "--reverse", f"{good}..{bad}"], capture_output=True, text=True, check=True).stdout.split()
    if not commits:
        return {"schema": "verdict-gate/1", "verifier": "flaky", "target": test_id, "outcome": "UNSURE", "detail": "NOTHING TO BISECT: no commits between good and bad", "evidence": [], "guards": [], "needs_human": True, "limits": LIMITS}
    n_stable = runs_needed(target, conf)
    root = tempfile.mkdtemp(prefix="fof-bisect-"); probes = []
    def is_flaky(ref):
        fails, runs = 0, 0
        env = dict(os.environ); env.pop("PYTHONHASHSEED", None)
        d = worktree(repo, ref, root)
        try:
            for i in range(n_stable):           # stop at the first failure: flaky proven
                e = dict(env); e["FOF_RUN_ID"] = f"bisect-{ref[:7]}-{i}"
                ok = run_once(d, cmd, e, timeout)[0]; runs += 1
                if not ok: fails += 1; break
        finally:
            subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", d], capture_output=True)
        probes.append({"commit": ref[:10], "runs": runs, "failures": fails, "flaky": fails > 0})
        return fails > 0
    try:
        if not is_flaky(commits[-1]):
            v = {"schema": "verdict-gate/1", "verifier": "flaky", "target": test_id, "outcome": "UNSURE", "detail": f"NOT REPRODUCED: bad commit {commits[-1][:10]} passed {n_stable} runs", "evidence": probes, "guards": [], "needs_human": True, "limits": LIMITS}
            return v
        lo, hi = -1, len(commits) - 1          # commits[lo] stable (good), commits[hi] flaky
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if is_flaky(commits[mid]): hi = mid
            else: lo = mid
        culprit = commits[hi]
        show = subprocess.run(["git", "-C", repo, "show", "--stat", "--format=%H%n%an%n%ad%n%s", culprit], capture_output=True, text=True).stdout.splitlines()
        files = [l.strip().split("|")[0].strip() for l in show[4:] if "|" in l]
        v = {"schema": "verdict-gate/1", "verifier": "flaky", "target": test_id, "outcome": "FAIL",
             "detail": f"CULPRIT: {culprit[:10]} \"{show[3] if len(show) > 3 else ''}\" introduced the flakiness ({len(probes)} commits probed of {len(commits)})",
             "evidence": [{"culprit": culprit, "subject": show[3] if len(show) > 3 else "", "author": show[1] if len(show) > 1 else "", "files": files}] + probes,
             "guards": [], "needs_human": True, "limits": LIMITS, "fix_hint": f"review the diff of {culprit[:10]} in: {', '.join(files) or 'see git show'}"}
        return v
    finally:
        shutil.rmtree(root, ignore_errors=True)

def demo_bisect(args):
    """A repo with 8 commits; commit 5 introduces the set()-order bug. Bisect must find it."""
    src = os.path.join(HERE, "demo_src")
    root = tempfile.mkdtemp(prefix="fof-bisect-demo-"); repo = os.path.join(root, "repo")
    shutil.copytree(src, repo, ignore=shutil.ignore_patterns("__pycache__"))
    g = lambda *a: subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True)
    g("init", "-q", "-b", "main"); g("config", "user.email", "demo@verdict.gate"); g("config", "user.name", "demo")
    good_lib = "COUPONS = {\"WELCOME5\": 5, \"SPRING10\": 10, \"VIP15\": 15, \"FREESHIP\": 4, \"BUNDLE8\": 8, \"LOYAL12\": 12, \"FLASH20\": 20}\ndef best_coupon(codes):\n    return max(set(codes), key=COUPONS.get)\ndef total(price, codes):\n    return round(price * (100 - COUPONS[best_coupon(codes)]) / 100, 2)\n"
    bad_lib = open(os.path.join(repo, "shop", "checkout.py")).read()
    lib = os.path.join(repo, "shop", "checkout.py"); notes = os.path.join(repo, "NOTES.md")
    open(lib, "w").write(good_lib); g("add", "."); g("commit", "-q", "-m", "1 initial shop (stable)")
    for i, msg in ((2, "2 add notes"), (3, "3 docs: coupons"), (4, "4 refactor imports")):
        open(notes, "a").write(msg + "\n"); g("add", "-A"); g("commit", "-q", "-m", msg)
    open(lib, "w").write(bad_lib); g("add", "-A"); g("commit", "-q", "-m", "5 perf: dedupe coupons with set()")   # the culprit
    for i, msg in ((6, "6 docs: readme"), (7, "7 chore: bump version"), (8, "8 style: formatting")):
        open(notes, "a").write(msg + "\n"); g("add", "-A"); g("commit", "-q", "-m", msg)
    t = time.time()
    v = bisect(repo, "HEAD~7", "HEAD", "python3 -m unittest -q test_checkout.TestTotal.test_total", args.jobs, args.timeout, args.target, 0.95, "test_checkout.TestTotal.test_total")
    print(f"# bisect {v['outcome']} {v['detail']}   ({time.time() - t:.1f}s)", file=sys.stderr)
    print("VERDICT " + json.dumps(v)); shutil.rmtree(root, ignore_errors=True)
    if args.json: json.dump(v, open(args.json, "w"), indent=2)
    return 0

def find_test_from_ci():
    t = os.environ.get("FOF_TEST")
    if t: return t
    for k in ("CI_MERGE_REQUEST_TITLE", "CI_MERGE_REQUEST_DESCRIPTION"):
        m = re.search(r'(?:fix(?:es)?[-\s]+flaky[:\s]+)([\w./:\[\]-]+)', os.environ.get(k, ""), re.I)
        if m: return m.group(1)
    return None

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    def common(p):
        p.add_argument("--runs", type=int, default=100, help="runs per side per look (default 100)")
        p.add_argument("--jobs", type=int, default=8); p.add_argument("--timeout", type=int, default=120)
        p.add_argument("--alpha", type=float, default=0.05); p.add_argument("--target", type=float, default=0.05)
        p.add_argument("--looks", type=int, default=3); p.add_argument("--json", help="also write the verdict to this file")
    c = sub.add_parser("compare"); common(c)
    c.add_argument("--repo", default="."); c.add_argument("--base", required=True); c.add_argument("--head", default="HEAD")
    c.add_argument("--test", required=True, help="shell command that runs ONLY the flaky test, retries disabled")
    c.add_argument("--test-id", help="label for the report"); c.add_argument("--test-file", help="path of the test file, for the diff guard")
    c.add_argument("--setup", help="shell command run once in each worktree before measuring")
    d = sub.add_parser("demo"); common(d); d.set_defaults(runs=60)
    b = sub.add_parser("bisect", help="find the commit that made a test flaky"); common(b)
    b.add_argument("--repo", default="."); b.add_argument("--good", required=True, help="a ref where the test was stable"); b.add_argument("--bad", default="HEAD")
    b.add_argument("--test", required=True); b.add_argument("--test-id")
    db = sub.add_parser("demo-bisect"); common(db)
    ci = sub.add_parser("ci-verify"); common(ci)
    ci.add_argument("--base", default=os.environ.get("CI_MERGE_REQUEST_DIFF_BASE_SHA")); ci.add_argument("--head", default=os.environ.get("CI_COMMIT_SHA"))
    a = ap.parse_args()
    if a.cmd == "demo": return demo(a)
    if a.cmd == "demo-bisect": return demo_bisect(a)
    if a.cmd == "bisect":
        v = bisect(a.repo, a.good, a.bad, a.test, a.jobs, a.timeout, a.target, 0.95, a.test_id or a.test)
        print("VERDICT " + json.dumps(v))
        if a.json: json.dump(v, open(a.json, "w"), indent=2)
        return {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5}[v["outcome"]]
    if a.cmd == "ci-verify":
        test = os.environ.get("FOF_TEST_CMD"); test_id = find_test_from_ci(); test_file = os.environ.get("FOF_TEST_FILE")
        if not test and test_id: test = f"python3 -m unittest -q {test_id}"
        if not test or not a.base or not a.head:
            v = {"schema": "verdict-gate/1", "verifier": "flaky", "target": test_id, "outcome": "UNSURE", "detail": "NO TEST SELECTED: set FOF_TEST (test id) or FOF_TEST_CMD, and base/head SHAs", "evidence": [], "guards": [], "needs_human": True, "limits": LIMITS}
            print("VERDICT " + json.dumps(v)); return 3
        a.repo, a.test, a.test_id, a.test_file, a.setup = os.getcwd(), test, test_id, test_file, os.environ.get("FOF_SETUP")
    v = run_compare(a.repo, a.base, a.head, a.test, a.test_id or a.test, a.test_file, a.runs, a.jobs, a.timeout, a.alpha, a.looks, a.target, 0.95, a.setup)
    print("VERDICT " + json.dumps(v))
    if a.json: json.dump(v, open(a.json, "w"), indent=2)
    return {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5}[v["outcome"]] if not (v["outcome"] == "PASS" and v["guards"]) else 6

if __name__ == "__main__":
    sys.exit(main())
