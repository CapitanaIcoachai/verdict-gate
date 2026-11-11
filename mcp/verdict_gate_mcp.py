#!/usr/bin/env python3
"""Verdict Gate MCP server (Model Context Protocol, stdio transport, JSON-RPC 2.0).

Lets any MCP client, such as a GitLab Duo agent or another agent runtime, run the
Verdict Gate verifiers as tools and receive the verdict-gate/1 object back. Standard library only.

  python3 mcp/verdict_gate_mcp.py            # speaks MCP on stdin/stdout, one JSON-RPC message per line
  python3 mcp/verdict_gate_mcp.py --selftest # lists tools and runs the i18n demo without a client

Tools
  verify_flaky    reruns a test on base and head of a repository and returns FIXED / NOT FIXED / ...
  verify_upgrade  checks a dependency upgrade (or all changed deps between two refs) against the code
  verify_i18n     checks translated catalogs against the source catalog
  verify_perf     is the MR really faster? ABAB benchmark runs, Mann-Whitney, bootstrap CI of the gain
  bisect_flaky    which commit made a test flaky? statistical bisection between a good and a bad ref
  verify_api      does the MR break the API contract? same requests on base and head, shape diff
  check_verdict   validates any verdict object against the verdict-gate/1 contract
  get_policy      returns verdict-gate.toml and the lifecycle stage of each verifier
  demo            runs the bundled demo of one verifier (no repository needed)

The server never changes an outcome: tools return exactly what the verifier printed.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "schema"))
import check as schema_check  # noqa: E402

PROTOCOL = "2025-06-18"
SERVER = {"name": "verdict-gate", "version": "0.1.0"}

def run(cmd, cwd=ROOT, timeout=1800):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    lines = [l[8:] for l in r.stdout.splitlines() if l.startswith("VERDICT ")]
    verdicts = [json.loads(l) for l in lines]
    if not verdicts:
        return {"error": "verifier printed no VERDICT line", "exit": r.returncode, "stderr": r.stderr[-2000:], "stdout": r.stdout[-2000:]}
    return verdicts[0] if len(verdicts) == 1 else {"verdicts": verdicts}

TOOLS = [
    {"name": "verify_flaky",
     "description": "Did a flaky-test fix really work? Reruns ONE test on both sides of a merge request (base and head refs of a git repository), alternating, and decides with a one-sided Fisher exact test and a 95% Clopper-Pearson upper bound. Returns a verdict-gate/1 object: outcome PASS (FIXED), FAIL (NOT FIXED), UNSURE (NEED MORE RUNS / NOT REPRODUCED) or BROKEN, with evidence counts, p-value, bound and diff-guard findings (removed or loosened assertions, skips, retries).",
     "inputSchema": {"type": "object", "required": ["repo", "base", "head", "test_cmd"], "properties": {
         "repo": {"type": "string", "description": "path of the git repository"},
         "base": {"type": "string", "description": "base ref or SHA (target branch)"},
         "head": {"type": "string", "description": "head ref or SHA (the MR branch)"},
         "test_cmd": {"type": "string", "description": "shell command that runs only the flaky test, retries disabled, e.g. 'python3 -m unittest -q tests.test_x.TestY.test_z'"},
         "test_id": {"type": "string", "description": "label for the report"},
         "test_file": {"type": "string", "description": "path of the test file, enables the diff guard"},
         "runs": {"type": "integer", "default": 100, "description": "runs per side per look"},
         "looks": {"type": "integer", "default": 3}, "jobs": {"type": "integer", "default": 8},
         "alpha": {"type": "number", "default": 0.05}, "target": {"type": "number", "default": 0.05},
         "setup": {"type": "string", "description": "shell command run once in each worktree before measuring"}}}},
    {"name": "verify_upgrade",
     "description": "If I upgrade this dependency, what stops working? Compares the real exports and types of two published npm versions with the exact call sites in the project. Modes: 'mr' checks every dependency whose version changed in package.json between base and head; 'check' checks one package from a version to a version; 'scan' checks all dependencies against their newest versions. Returns a verdict-gate/1 object with file:line evidence.",
     "inputSchema": {"type": "object", "required": ["project_dir"], "properties": {
         "project_dir": {"type": "string", "description": "directory containing package.json"},
         "mode": {"type": "string", "enum": ["mr", "check", "scan"], "default": "mr"},
         "base": {"type": "string"}, "head": {"type": "string"},
         "package": {"type": "string"}, "from_version": {"type": "string"}, "to_version": {"type": "string"}}}},
    {"name": "verify_i18n",
     "description": "Are the translations complete? Compares translated JSON catalogs (key -> string) with the source catalog: missing keys, strings left in the source language, HTML tags and placeholders not preserved, line breaks, Unicode NFC, lengths that overflow. Returns a verdict-gate/1 object listing every defect with language, key and type.",
     "inputSchema": {"type": "object", "required": ["source", "targets"], "properties": {
         "source": {"type": "string", "description": "path of the source catalog JSON"},
         "targets": {"type": "array", "items": {"type": "string"}, "description": "paths or globs of the translated catalogs"},
         "max_ratio": {"type": "number", "default": 1.6}, "glossary": {"type": "array", "items": {"type": "string"}, "description": "terms that legitimately stay untranslated"}}}},
    {"name": "verify_perf",
     "description": "Is the MR really faster? Runs the same benchmark command on base and head, alternating, and decides with a Mann-Whitney U test and a bootstrap confidence interval of the median gain. Returns a verdict-gate/1 object: PASS (FASTER), FAIL (SLOWER or NO MEASURABLE DIFFERENCE), UNSURE (NEED MORE RUNS), BROKEN. Guard: the benchmark file must not change.",
     "inputSchema": {"type": "object", "required": ["repo", "base", "head", "bench_cmd"], "properties": {
         "repo": {"type": "string"}, "base": {"type": "string"}, "head": {"type": "string"},
         "bench_cmd": {"type": "string", "description": "benchmark command; wall time is measured unless metric_from_output is true"},
         "metric_from_output": {"type": "boolean", "default": False, "description": "use the last number the command prints (lower is better)"},
         "bench_file": {"type": "string"}, "runs": {"type": "integer", "default": 30}, "min_gain": {"type": "number", "default": 0.05}, "alpha": {"type": "number", "default": 0.05}}}},
    {"name": "bisect_flaky",
     "description": "Which commit made a test flaky? Statistical bisection between a good ref and a bad ref: each probed commit is declared stable only after enough clean runs (59 for a 5% residual rate at 95% confidence) and flaky at the first failure. Returns a verdict-gate/1 object whose evidence names the culprit commit, its subject, author and files, plus every probe.",
     "inputSchema": {"type": "object", "required": ["repo", "good", "bad", "test_cmd"], "properties": {
         "repo": {"type": "string"}, "good": {"type": "string", "description": "ref where the test was stable"}, "bad": {"type": "string", "description": "ref where it is flaky"},
         "test_cmd": {"type": "string"}, "test_id": {"type": "string"}, "target": {"type": "number", "default": 0.05}, "jobs": {"type": "integer", "default": 8}}}},
    {"name": "verify_api",
     "description": "Does the MR break the API contract? Starts the service on base and head (two worktrees, two ports), sends the same requests to both, compares status codes and response shapes (keys and types, recursively). Returns a verdict-gate/1 object: PASS (CLEAR, added fields listed), FAIL (BREAKS: removed field, type change, status change), BROKEN (service did not start).",
     "inputSchema": {"type": "object", "required": ["repo", "base", "head", "config"], "properties": {
         "repo": {"type": "string"}, "base": {"type": "string"}, "head": {"type": "string"},
         "config": {"type": "string", "description": "path of the contract JSON: start command with {port}, health path, requests[]"}}}},
    {"name": "check_verdict",
     "description": "Validates a verdict object against the verdict-gate/1 contract. Returns {valid, problems[]}.",
     "inputSchema": {"type": "object", "required": ["verdict"], "properties": {"verdict": {"type": "object"}}}},
    {"name": "get_policy",
     "description": "Returns the gate policy (verdict-gate.toml as text), the exit-code mapping and which DevSecOps lifecycle stages each verifier touches.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "demo",
     "description": "Runs the bundled demo of a verifier with no repository needed: 'flaky' (three MRs: placebo, real fix, weakened test), 'i18n' (en/it/de catalogs), 'upgrade' (nine old dependencies, needs npm registry access), 'perf' (fast, placebo and slower MRs), 'bisect' (eight commits, the fifth introduces flakiness), 'api' (a renamed field and an added field).",
     "inputSchema": {"type": "object", "required": ["verifier"], "properties": {"verifier": {"type": "string", "enum": ["flaky", "i18n", "upgrade", "perf", "bisect", "api"]}}}},
]

def call(name, a):
    a = a or {}
    if name == "verify_flaky":
        cmd = [sys.executable, os.path.join(ROOT, "verifiers/flaky/fixorfluke.py"), "compare", "--repo", a["repo"], "--base", a["base"], "--head", a["head"], "--test", a["test_cmd"],
               "--runs", str(a.get("runs", 100)), "--looks", str(a.get("looks", 3)), "--jobs", str(a.get("jobs", 8)), "--alpha", str(a.get("alpha", 0.05)), "--target", str(a.get("target", 0.05))]
        for k, f in (("test_id", "--test-id"), ("test_file", "--test-file"), ("setup", "--setup")):
            if a.get(k): cmd += [f, a[k]]
        return run(cmd)
    if name == "verify_upgrade":
        v = os.path.join(ROOT, "verifiers/upgrade/verdict.mjs"); mode = a.get("mode", "mr"); d = a["project_dir"]
        if mode == "mr": return run(["node", v, "mr", "--base", a["base"], "--head", a["head"], "--dir", d])
        if mode == "scan": return run(["node", v, "scan", d])
        bin_ = os.path.join(ROOT, "verifiers/upgrade/bin/upgrade-radar.mjs")
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as t: tmp = t.name
        cmd = ["node", bin_, "check", a["package"], d, "--quiet", "--json", tmp]
        if a.get("from_version"): cmd += ["--from", a["from_version"]]
        if a.get("to_version"): cmd += ["--to", a["to_version"]]
        subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        return run(["node", v, "report", tmp])
    if name == "verify_i18n":
        cmd = [sys.executable, os.path.join(ROOT, "verifiers/i18n/i18n_gate.py"), "--source", a["source"], "--targets", *a["targets"], "--max-ratio", str(a.get("max_ratio", 1.6))]
        if a.get("glossary"): cmd += ["--glossary", ",".join(a["glossary"])]
        return run(cmd)
    if name == "verify_perf":
        cmd = [sys.executable, os.path.join(ROOT, "verifiers/perf/speedorfluke.py"), "compare", "--repo", a["repo"], "--base", a["base"], "--head", a["head"], "--bench", a["bench_cmd"],
               "--runs", str(a.get("runs", 30)), "--min-gain", str(a.get("min_gain", 0.05)), "--alpha", str(a.get("alpha", 0.05))]
        if a.get("metric_from_output"): cmd.append("--metric")
        if a.get("bench_file"): cmd += ["--bench-file", a["bench_file"]]
        return run(cmd)
    if name == "bisect_flaky":
        cmd = [sys.executable, os.path.join(ROOT, "verifiers/flaky/fixorfluke.py"), "bisect", "--repo", a["repo"], "--good", a["good"], "--bad", a["bad"], "--test", a["test_cmd"], "--target", str(a.get("target", 0.05)), "--jobs", str(a.get("jobs", 8))]
        if a.get("test_id"): cmd += ["--test-id", a["test_id"]]
        return run(cmd)
    if name == "verify_api":
        return run([sys.executable, os.path.join(ROOT, "verifiers/api/contractdiff.py"), "compare", "--repo", a["repo"], "--base", a["base"], "--head", a["head"], "--config", a["config"]])
    if name == "check_verdict":
        p = schema_check.problems(a["verdict"]); return {"valid": not p, "problems": p}
    if name == "get_policy":
        return {"policy_toml": open(os.path.join(ROOT, "verdict-gate.toml"), encoding="utf-8").read(),
                "exit_codes": {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5, "PASS_WITH_GUARDS": 6},
                "stages": {"flaky": ["verify", "secure", "release", "monitor", "govern", "plan"], "upgrade": ["verify", "secure", "release", "package", "monitor", "plan"], "i18n": ["verify", "release", "configure", "govern"], "perf": ["verify", "release", "monitor"], "api": ["verify", "release", "govern"]}}
    if name == "demo":
        v = a["verifier"]
        if v == "flaky": return run([sys.executable, os.path.join(ROOT, "verifiers/flaky/fixorfluke.py"), "demo", "--runs", "60"])
        if v == "i18n": return run([sys.executable, os.path.join(ROOT, "verifiers/i18n/i18n_gate.py"), "--source", "demo-app/locales/en.json", "--targets", "demo-app/locales/*.json", "--glossary", "OK"])
        if v == "perf": return run([sys.executable, os.path.join(ROOT, "verifiers/perf/speedorfluke.py"), "demo"])
        if v == "bisect": return run([sys.executable, os.path.join(ROOT, "verifiers/flaky/fixorfluke.py"), "demo-bisect"])
        if v == "api": return run([sys.executable, os.path.join(ROOT, "verifiers/api/contractdiff.py"), "demo"])
        return run(["node", os.path.join(ROOT, "verifiers/upgrade/verdict.mjs"), "demo"])
    raise KeyError(name)

def handle(msg):
    m, i, p = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if m == "initialize":
        return {"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": p.get("protocolVersion", PROTOCOL), "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER,
                "instructions": "Verdict Gate: deterministic verifiers for merge requests. Call a verify_* tool, read outcome/detail/evidence, never alter them. A PASS with guards needs a human."}}
    if m == "notifications/initialized" or m is None and i is None: return None
    if m == "ping": return {"jsonrpc": "2.0", "id": i, "result": {}}
    if m == "tools/list": return {"jsonrpc": "2.0", "id": i, "result": {"tools": TOOLS}}
    if m == "tools/call":
        try:
            out = call(p.get("name"), p.get("arguments"))
            is_err = isinstance(out, dict) and "error" in out
            return {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}], "structuredContent": out if isinstance(out, dict) else {"result": out}, "isError": is_err}}
        except KeyError as e:
            return {"jsonrpc": "2.0", "id": i, "error": {"code": -32602, "message": f"unknown tool or missing argument: {e}"}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": f"verifier error: {e}"}], "isError": True}}
    if i is not None: return {"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": f"method not found: {m}"}}
    return None

def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}) + "\n"); sys.stdout.flush(); continue
        resp = handle(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n"); sys.stdout.flush()

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        print(json.dumps([t["name"] for t in TOOLS])); print(json.dumps(call("demo", {"verifier": "i18n"}), ensure_ascii=False)[:300])
    else:
        serve()
