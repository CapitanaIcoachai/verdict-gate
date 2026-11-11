#!/usr/bin/env python3
"""Minimal MCP client: talks to mcp/verdict_gate_mcp.py over stdio and prints what an agent would see.
Run from the repository root:  python3 mcp/examples/client_demo.py
"""
import json, os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
msgs = [
 {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "client_demo", "version": "0"}}},
 {"jsonrpc": "2.0", "method": "notifications/initialized"},
 {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
 {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "verify_i18n", "arguments": {"source": "demo-app/locales/en.json", "targets": ["demo-app/locales/it.json"], "glossary": ["OK"]}}},
 {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "verify_i18n", "arguments": {"source": "demo-app/locales/en.json", "targets": ["demo-app/locales/de.json"], "glossary": ["OK"]}}},
 {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "demo", "arguments": {"verifier": "flaky"}}},
 {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "verify_upgrade", "arguments": {"project_dir": "demo-app/node-service", "mode": "check", "package": "express", "from_version": "4.18.2", "to_version": "5.2.1"}}},
 {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "check_verdict", "arguments": {"verdict": {"schema": "verdict-gate/1", "verifier": "flaky", "outcome": "PASS", "detail": "FIXED", "evidence": [], "guards": ["retry added"], "needs_human": False}}}},
 {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "get_policy", "arguments": {}}},
]
r = subprocess.run([sys.executable, "mcp/verdict_gate_mcp.py"], cwd=ROOT, input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True, timeout=900)
out = {m["id"]: m for m in (json.loads(l) for l in r.stdout.splitlines() if l.strip())}
sc = lambda i: out[i]["result"]["structuredContent"]
print("initialize   ->", out[1]["result"]["serverInfo"], "protocol", out[1]["result"]["protocolVersion"])
print("tools/list   ->", [t["name"] for t in out[2]["result"]["tools"]])
v = sc(3); print("i18n it      ->", v["outcome"], "|", v["detail"])
v = sc(4); print("i18n de      ->", v["outcome"], "|", v["detail"]); print("                defects:", [(e["key"], e["type"]) for e in v["evidence"] if "type" in e])
for v in sc(5)["verdicts"]: print("flaky demo   ->", v["target"].split(":")[0].ljust(11), v["outcome"].ljust(6), "|", v["detail"])
v = sc(6); print("upgrade      ->", v["outcome"], "|", v["detail"])
for e in v["evidence"]:
    if e.get("file"): print("                ", e.get("title"), e.get("path"), "@", f"{e['file']}:{e['line']}")
print("check_verdict->", sc(7))
print("get_policy   -> exit codes", sc(8)["exit_codes"])
