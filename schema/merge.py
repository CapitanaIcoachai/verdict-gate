#!/usr/bin/env python3
"""Merge several verdicts (monitor job) into one: worst outcome wins, evidence concatenated."""
import json, sys
RANK = {"PASS": 0, "UNSURE": 1, "FAIL": 2, "BROKEN": 3}
vs = [json.load(open(p)) for p in sys.argv[1:]]
worst = max(vs, key=lambda v: RANK[v["outcome"]])["outcome"]
out = {"schema": "verdict-gate/1", "verifier": vs[0]["verifier"] if len({v["verifier"] for v in vs}) == 1 else "flaky",
       "target": "monitor: " + ", ".join(v["verifier"] for v in vs), "outcome": worst,
       "detail": " | ".join(f"{v['verifier']}: {v['detail']}" for v in vs),
       "evidence": [dict(e, verifier=v["verifier"]) for v in vs for e in v["evidence"]][:200],
       "guards": [g for v in vs for g in v["guards"]], "needs_human": worst != "PASS"}
print(json.dumps(out))
