#!/usr/bin/env python3
"""Conformance check for verdict-gate/1. Standard library only, no jsonschema dependency.
Usage: check.py verdict.json  (exit 0 if valid, 1 otherwise, with the reasons on stderr)."""
import json, sys
OUTCOMES = {"PASS", "FAIL", "UNSURE", "BROKEN"}
VERIFIERS = {"upgrade", "flaky", "i18n", "perf", "api"}
ALLOWED = {"schema", "verifier", "target", "outcome", "detail", "evidence", "guards", "needs_human", "fix_hint", "limits"}
def problems(v):
    out = []
    if not isinstance(v, dict): return ["not an object"]
    for k in ("schema", "verifier", "outcome", "detail", "evidence", "guards", "needs_human"):
        if k not in v: out.append(f"missing {k}")
    if v.get("schema") != "verdict-gate/1": out.append("schema must be verdict-gate/1")
    if v.get("verifier") not in VERIFIERS: out.append("verifier must be one of " + ", ".join(sorted(VERIFIERS)))
    if v.get("outcome") not in OUTCOMES: out.append("outcome must be PASS, FAIL, UNSURE or BROKEN")
    if not isinstance(v.get("detail"), str) or not v.get("detail"): out.append("detail must be a non-empty string")
    if not isinstance(v.get("evidence"), list) or any(not isinstance(e, dict) for e in v.get("evidence", [])): out.append("evidence must be a list of objects")
    if not isinstance(v.get("guards"), list) or any(not isinstance(g, str) for g in v.get("guards", [])): out.append("guards must be a list of strings")
    if not isinstance(v.get("needs_human"), bool): out.append("needs_human must be a boolean")
    if "target" in v and v["target"] is not None and not isinstance(v["target"], str): out.append("target must be a string or null")
    for k in ("fix_hint", "limits"):
        if k in v and not isinstance(v[k], str): out.append(f"{k} must be a string")
    extra = set(v) - ALLOWED
    if extra: out.append("unknown keys: " + ", ".join(sorted(extra)))
    if v.get("outcome") == "PASS" and v.get("guards") and not v.get("needs_human"): out.append("a PASS with guards must set needs_human=true")
    return out
def load(path):
    txt = open(path, encoding="utf-8").read().strip()
    if txt.startswith("VERDICT "): txt = txt[8:]
    return json.loads(txt)
if __name__ == "__main__":
    if len(sys.argv) < 2: print(__doc__); sys.exit(2)
    bad = 0
    for p in sys.argv[1:]:
        errs = problems(load(p))
        if errs: bad += 1; print(f"{p}: INVALID\n  - " + "\n  - ".join(errs), file=sys.stderr)
        else: print(f"{p}: valid verdict-gate/1")
    sys.exit(1 if bad else 0)
