#!/usr/bin/env python3
"""ContractDiff, the API contract verifier of Verdict Gate.

Starts the service on base and on head (two git worktrees, two ports), sends the same requests to
both, and compares the responses by SHAPE: status code, JSON keys and value types, recursively.
Values are ignored unless a request sets "compare_values": true. Verdicts:

  CLEAR        same status and shape on every request (new optional fields are allowed and listed)
  BREAKS       a field disappeared, a type changed, or a status changed
  BROKEN       the service did not come up on one side

Configuration (JSON):
  {"start": "python3 app.py --port {port}", "health": "/health", "timeout": 20,
   "requests": [{"method": "GET", "path": "/users/1"}, {"method": "POST", "path": "/orders", "body": {"sku": "A"}}]}

Standard library only, needs git. Prints one line "VERDICT {json}" (schema verdict-gate/1).

  contractdiff.py compare --repo . --base origin/main --head HEAD --config api-contract.json
  contractdiff.py demo
"""
import argparse, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

LIMITS = ("Compares response shapes for the requests listed in the configuration only. Semantics (a field that keeps its type but changes meaning) "
          "and endpoints not listed are not checked. Values are compared only where compare_values is set.")

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def shape(x):
    if isinstance(x, dict): return {k: shape(v) for k, v in x.items()}
    if isinstance(x, list): return [shape(x[0])] if x else []
    if x is None: return "null"
    if isinstance(x, bool): return "boolean"
    if isinstance(x, (int, float)): return "number"
    return "string"

def diff_shape(a, b, path=""):
    """Returns (breaks, additions)."""
    breaks, adds = [], []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k not in b: breaks.append({"field": f"{path}.{k}".lstrip("."), "change": "removed", "was": a[k] if isinstance(a[k], str) else "object"})
            else:
                br, ad = diff_shape(a[k], b[k], f"{path}.{k}"); breaks += br; adds += ad
        for k in b:
            if k not in a: adds.append({"field": f"{path}.{k}".lstrip("."), "change": "added", "now": b[k] if isinstance(b[k], str) else "object"})
    elif isinstance(a, list) and isinstance(b, list):
        if a and b:
            br, ad = diff_shape(a[0], b[0], f"{path}[]"); breaks += br; adds += ad
    elif a != b:
        breaks.append({"field": path.lstrip(".") or "$", "change": "type changed", "was": a if isinstance(a, str) else "object", "now": b if isinstance(b, str) else "object"})
    return breaks, adds

def request(port, r):
    url = f"http://127.0.0.1:{port}{r['path']}"
    data = json.dumps(r.get("body")).encode() if r.get("body") is not None else None
    req = urllib.request.Request(url, data=data, method=r.get("method", "GET"), headers={"Content-Type": "application/json", **r.get("headers", {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", "replace"); status = resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace"); status = e.code
    try: parsed = json.loads(body)
    except ValueError: parsed = body
    return status, parsed

def start(cwd, start_cmd, health, timeout):
    port = free_port()
    proc = subprocess.Popen(start_cmd.replace("{port}", str(port)), shell=True, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, preexec_fn=os.setsid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{health}", timeout=2); return proc, port, None
        except Exception:
            if proc.poll() is not None: return None, port, (proc.stderr.read().decode("utf-8", "replace")[-400:] or f"exited with {proc.returncode}")
            time.sleep(0.2)
    stop(proc); return None, port, "health check timed out"

def stop(proc):
    if proc and proc.poll() is None:
        try: os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception: pass
        try: proc.wait(5)
        except Exception: pass

def worktree(repo, ref, root):
    d = os.path.join(root, re.sub(r"[^\w.-]", "_", ref)); subprocess.run(["git", "-C", repo, "worktree", "add", "-q", "--detach", d, ref], check=True); return d

def compare(repo, base, head, cfg, target):
    root = tempfile.mkdtemp(prefix="cdf-"); procs = []
    v = {"schema": "verdict-gate/1", "verifier": "api", "target": target, "guards": [], "limits": LIMITS}
    try:
        sides = {}
        for name, ref in (("base", base), ("head", head)):
            d = worktree(repo, ref, root)
            proc, port, err = start(os.path.join(d, cfg.get("cwd", "")), cfg["start"], cfg.get("health", "/"), cfg.get("timeout", 20))
            if err:
                v.update(outcome="BROKEN", detail=f"BROKEN: service did not start on {name}", evidence=[{"side": name, "error": err}], needs_human=True); return v
            procs.append(proc); sides[name] = port
        breaks, adds, checked = [], [], 0
        for r in cfg["requests"]:
            label = f"{r.get('method', 'GET')} {r['path']}"
            sb, bb = request(sides["base"], r); sh, bh = request(sides["head"], r); checked += 1
            if sb != sh: breaks.append({"request": label, "field": "status", "change": "status changed", "was": sb, "now": sh}); continue
            if r.get("compare_values"):
                if bb != bh: breaks.append({"request": label, "field": "$", "change": "value changed", "was": bb, "now": bh})
                continue
            br, ad = diff_shape(shape(bb), shape(bh))
            breaks += [dict(x, request=label) for x in br]; adds += [dict(x, request=label) for x in ad]
        if breaks:
            v.update(outcome="FAIL", detail=f"BREAKS: {len(breaks)} breaking change(s) in {checked} request(s)", evidence=breaks + adds, needs_human=True,
                     fix_hint="restore the removed fields or version the endpoint; consumers reading the listed fields will break")
        else:
            v.update(outcome="PASS", detail=f"CLEAR: {checked} request(s), same status and shape" + (f", {len(adds)} field(s) added" if adds else ""), evidence=adds, needs_human=False)
        return v
    finally:
        for p in procs: stop(p)
        for d in os.listdir(root): subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", os.path.join(root, d)], capture_output=True)
        shutil.rmtree(root, ignore_errors=True)

# ---------- demo ----------
HERE = os.path.dirname(os.path.abspath(__file__))
APP_BREAK = '''    def user(self, uid):
        return {"id": str(uid), "name": "Ada", "mail": "ada@example.com", "roles": ["admin"]}   # id now a string, email renamed
'''
APP_ADD = '''    def user(self, uid):
        return {"id": uid, "name": "Ada", "email": "ada@example.com", "roles": ["admin"], "created_at": "2026-10-08"}
'''
def demo(args):
    src = os.path.join(HERE, "..", "..", "demo-app", "py-api")
    root = tempfile.mkdtemp(prefix="cdf-demo-"); repo = os.path.join(root, "repo"); shutil.copytree(src, repo)
    g = lambda *a: subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True)
    g("init", "-q", "-b", "main"); g("config", "user.email", "demo@verdict.gate"); g("config", "user.name", "demo"); g("add", "."); g("commit", "-q", "-m", "api v1")
    app = open(os.path.join(repo, "app.py")).read()
    orig = app[app.index("    def user(self, uid):"):app.index("    def health(self):")]
    for name, body in (("mr-rename-field", APP_BREAK), ("mr-add-field", APP_ADD)):
        g("checkout", "-q", "-b", name, "main"); open(os.path.join(repo, "app.py"), "w").write(app.replace(orig, body)); g("commit", "-q", "-am", name)
    g("checkout", "-q", "main")
    cfg = json.load(open(os.path.join(src, "api-contract.json")))
    out = []
    for name in ("mr-rename-field", "mr-add-field"):
        t = time.time(); v = compare(repo, "main", name, cfg, f"{name}: {len(cfg['requests'])} requests")
        print(f"# {name:16s} {v['outcome']:7s} {v['detail']}   ({time.time() - t:.1f}s)", file=sys.stderr)
        print("VERDICT " + json.dumps(v)); out.append(v)
    shutil.rmtree(root, ignore_errors=True)
    if args.json: json.dump(out, open(args.json, "w"), indent=2)
    return 0

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compare"); c.add_argument("--repo", default="."); c.add_argument("--base", required=True); c.add_argument("--head", default="HEAD")
    c.add_argument("--config", required=True); c.add_argument("--json"); c.add_argument("--target")
    d = sub.add_parser("demo"); d.add_argument("--json")
    a = ap.parse_args()
    if a.cmd == "demo": return demo(a)
    cfg = json.load(open(a.config)); v = compare(a.repo, a.base, a.head, cfg, a.target or f"{os.path.basename(a.config)}: {len(cfg['requests'])} requests")
    print("VERDICT " + json.dumps(v))
    if a.json: json.dump(v, open(a.json, "w"), indent=2)
    return {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5}[v["outcome"]]

if __name__ == "__main__":
    sys.exit(main())
