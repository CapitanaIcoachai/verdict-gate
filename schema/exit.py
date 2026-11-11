#!/usr/bin/env python3
"""Map a verdict to a CI exit code: PASS 0, FAIL 2, UNSURE 3, BROKEN 5. A PASS with guards exits 6 (needs a human)."""
import json, sys
v = json.load(open(sys.argv[1]))
code = {"PASS": 0, "FAIL": 2, "UNSURE": 3, "BROKEN": 5}[v["outcome"]]
if v["outcome"] == "PASS" and v.get("guards"): code = 6
print(f"verdict {v['outcome']} -> exit {code}")
sys.exit(code)
