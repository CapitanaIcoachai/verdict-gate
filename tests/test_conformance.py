"""Every verifier must print a valid verdict-gate/1 line, and the statistics must match known exact values."""
import json, os, subprocess, sys, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "schema")); sys.path.insert(0, os.path.join(ROOT, "verifiers", "flaky"))
import check, fixorfluke as fof

def verdict_lines(out):
    return [json.loads(l[8:]) for l in out.splitlines() if l.startswith("VERDICT ")]

class Stats(unittest.TestCase):
    def test_exact_values(self):
        self.assertAlmostEqual(fof.fisher_one_sided(11, 60, 0, 60), 0.000295, places=6)
        self.assertAlmostEqual(fof.upper_bound(0, 60), 0.0487, places=4)
        self.assertAlmostEqual(fof.fisher_one_sided(7, 60, 6, 60), 0.50, places=2)
        self.assertAlmostEqual(fof.fisher_one_sided(3, 60, 0, 60), 0.1218, places=4)
        self.assertEqual([fof.runs_needed(t) for t in (.05, .02, .01)], [59, 149, 299])
    def test_decision_rules(self):
        d = lambda kb, nb, kh, nh, g=[]: fof.decide(kb, nb, kh, nh, 0.05, 1, 0.05, 0.95, None, g, "t")
        self.assertEqual(d(11, 60, 0, 60)["outcome"], "PASS")
        self.assertEqual(d(8, 60, 6, 60)["detail"], "NOT FIXED, no measurable effect")
        self.assertTrue(d(3, 60, 0, 60)["detail"].startswith("NEED MORE RUNS: 59"))
        self.assertTrue(d(0, 60, 0, 60)["detail"].startswith("NOT REPRODUCED"))
        w = d(15, 60, 0, 60, ["assertion loosened"]); self.assertEqual(w["outcome"], "PASS"); self.assertTrue(w["needs_human"]); self.assertIn("WEAKENED", w["detail"])
        for v in (d(11, 60, 0, 60), d(8, 60, 6, 60), d(3, 60, 0, 60), w): self.assertEqual(check.problems(v), [])

class FlakyDemo(unittest.TestCase):
    def test_three_mrs(self):
        out = subprocess.run([sys.executable, "verifiers/flaky/fixorfluke.py", "demo", "--runs", "60"], cwd=ROOT, capture_output=True, text=True).stdout
        vs = verdict_lines(out); self.assertEqual(len(vs), 3)
        for v in vs: self.assertEqual(check.problems(v), [], v)
        by = {v["target"].split(":")[0]: v for v in vs}
        self.assertEqual(by["mr-placebo"]["outcome"], "FAIL")
        self.assertEqual(by["mr-fix"]["outcome"], "PASS"); self.assertEqual(by["mr-fix"]["guards"], [])
        self.assertEqual(by["mr-weaken"]["outcome"], "PASS"); self.assertIn("assertion loosened", by["mr-weaken"]["guards"]); self.assertTrue(by["mr-weaken"]["needs_human"])

class I18nDemo(unittest.TestCase):
    def test_catalogs(self):
        r = subprocess.run([sys.executable, "verifiers/i18n/i18n_gate.py", "--source", "demo-app/locales/en.json", "--targets", "demo-app/locales/*.json", "--glossary", "OK"], cwd=ROOT, capture_output=True, text=True)
        v = verdict_lines(r.stdout)[0]; self.assertEqual(check.problems(v), [], v)
        self.assertEqual(v["outcome"], "FAIL"); self.assertEqual(r.returncode, 2)
        types = {(e.get("lang"), e.get("key"), e.get("type")) for e in v["evidence"] if "type" in e}
        self.assertIn(("de", "save", "leftover"), types); self.assertIn(("de", "greet", "tag"), types); self.assertIn(("de", "greet", "placeholder"), types)
        self.assertIn(("de", "lines", "newline"), types); self.assertIn(("de", "retry", "missing"), types)
        self.assertFalse(any(t[0] == "it" for t in types), "the Italian catalog is clean")

class UpgradeAdapter(unittest.TestCase):
    def test_report_conversion(self):
        fixture = os.path.join(ROOT, "tests", "fixtures", "upgrade-report.json")
        r = subprocess.run(["node", "verifiers/upgrade/verdict.mjs", "report", fixture], cwd=ROOT, capture_output=True, text=True)
        v = verdict_lines(r.stdout)[0]; self.assertEqual(check.problems(v), [], v)
        self.assertEqual(v["outcome"], "FAIL"); self.assertEqual(r.returncode, 2)
        self.assertTrue(any(e.get("file") == "src/server.js" and e.get("line") == 9 for e in v["evidence"]))

if __name__ == "__main__":
    unittest.main()

class PerfDemo(unittest.TestCase):
    def test_three_mrs(self):
        out = subprocess.run([sys.executable, "verifiers/perf/speedorfluke.py", "demo", "--runs", "12"], cwd=ROOT, capture_output=True, text=True, timeout=900).stdout
        vs = verdict_lines(out); self.assertEqual(len(vs), 3)
        for v in vs: self.assertEqual(check.problems(v), [], v)
        by = {v["target"].split(":")[0]: v for v in vs}
        self.assertEqual(by["mr-fast"]["outcome"], "PASS"); self.assertTrue(by["mr-fast"]["detail"].startswith("FASTER"))
        self.assertEqual(by["mr-placebo"]["outcome"], "FAIL"); self.assertTrue(by["mr-placebo"]["detail"].startswith("NO MEASURABLE"))
        # a 2x slowdown is SLOWER at 12 runs on a quiet machine; on a noisy CI runner it may land on NO MEASURABLE DIFFERENCE, still a FAIL
        self.assertEqual(by["mr-slower"]["outcome"], "FAIL"); self.assertLess(by["mr-slower"]["evidence"][2]["median_gain"], 0)

class BisectDemo(unittest.TestCase):
    def test_finds_culprit(self):
        out = subprocess.run([sys.executable, "verifiers/flaky/fixorfluke.py", "demo-bisect"], cwd=ROOT, capture_output=True, text=True, timeout=900).stdout
        v = verdict_lines(out)[0]; self.assertEqual(check.problems(v), [], v)
        self.assertEqual(v["outcome"], "FAIL"); self.assertIn("5 perf: dedupe coupons with set()", v["evidence"][0]["subject"]); self.assertIn("shop/checkout.py", v["evidence"][0]["files"])
        self.assertLessEqual(len(v["evidence"]) - 1, 5, "bisection must probe at most ceil(log2(7))+1 commits")

class ApiDemo(unittest.TestCase):
    def test_two_mrs(self):
        out = subprocess.run([sys.executable, "verifiers/api/contractdiff.py", "demo"], cwd=ROOT, capture_output=True, text=True, timeout=300).stdout
        vs = verdict_lines(out); self.assertEqual(len(vs), 2)
        for v in vs: self.assertEqual(check.problems(v), [], v)
        by = {v["target"].split(":")[0]: v for v in vs}
        changes = {(e["field"], e["change"]) for e in by["mr-rename-field"]["evidence"]}
        self.assertEqual(by["mr-rename-field"]["outcome"], "FAIL"); self.assertIn(("email", "removed"), changes); self.assertIn(("id", "type changed"), changes)
        self.assertEqual(by["mr-add-field"]["outcome"], "PASS"); self.assertIn(("created_at", "added"), {(e["field"], e["change"]) for e in by["mr-add-field"]["evidence"]})

class McpServer(unittest.TestCase):
    def test_jsonrpc_roundtrip(self):
        msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "demo", "arguments": {"verifier": "i18n"}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "check_verdict", "arguments": {"verdict": {"schema": "verdict-gate/1"}}}}]
        r = subprocess.run([sys.executable, "mcp/verdict_gate_mcp.py"], cwd=ROOT, input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True, timeout=120)
        out = {m["id"]: m for m in (json.loads(l) for l in r.stdout.splitlines() if l.strip())}
        self.assertEqual(out[1]["result"]["serverInfo"]["name"], "verdict-gate")
        self.assertEqual({t["name"] for t in out[2]["result"]["tools"]}, {"verify_flaky", "verify_upgrade", "verify_i18n", "verify_perf", "verify_api", "bisect_flaky", "check_verdict", "get_policy", "demo"})
        v = out[3]["result"]["structuredContent"]; self.assertEqual(v["verifier"], "i18n"); self.assertEqual(v["outcome"], "FAIL"); self.assertEqual(check.problems(v), [])
        self.assertFalse(out[4]["result"]["structuredContent"]["valid"])
