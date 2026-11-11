#!/usr/bin/env python3
"""i18n gate, the translation verifier of Verdict Gate. Standard library only.

Compares every translated catalog (JSON key -> string) against the source catalog with
deterministic checks: missing keys, strings left in the source language, HTML tags and
placeholders not preserved, line breaks, Unicode normalization (NFC), lengths that overflow.

  i18n_gate.py --source demo-app/locales/en.json --targets demo-app/locales/*.json [--max-ratio 1.6] [--glossary OK] [--json verdict.json]

Prints one line "VERDICT {json}" (schema verdict-gate/1). Exit: PASS 0, FAIL 2, UNSURE 3.
"""
import argparse, glob, json, os, re, sys, unicodedata
PH = re.compile(r"\{\{\s*[\w.]+\s*\}\}|\{[\w.]+\}|%\(\w+\)[sd]|%[sdif]|\$\{[\w.]+\}|%\d+\$[sd]")
TAG = re.compile(r"</?[a-zA-Z][^>]*>")
LIMITS = "Checks form, not meaning: a fluent but wrong translation passes. Leftover detection skips one-word strings and glossary terms."

def multiset(items):
    m = {}
    for t in items: k = re.sub(r"\s+", " ", t).strip(); m[k] = m.get(k, 0) + 1
    return m

def check(src, tgt, lang, max_ratio, glossary, maxlen):
    defects = []
    for k, s in src.items():
        s = "" if s is None else str(s); t = tgt.get(k)
        if t is None or str(t).strip() == "":
            defects.append({"lang": lang, "key": k, "type": "missing"}); continue
        t = str(t)
        words = s.split()
        if re.search(r"[A-Za-zÀ-ÿ]", s) and len(words) >= 2 and t.strip().lower() == s.strip().lower() and s.strip().lower() not in glossary:
            defects.append({"lang": lang, "key": k, "type": "leftover", "text": s})
        if multiset(TAG.findall(s)) != multiset(TAG.findall(t)): defects.append({"lang": lang, "key": k, "type": "tag", "source": s, "target": t})
        if multiset(PH.findall(s)) != multiset(PH.findall(t)): defects.append({"lang": lang, "key": k, "type": "placeholder", "source": s, "target": t})
        if s.count("\n") != t.count("\n"): defects.append({"lang": lang, "key": k, "type": "newline"})
        if t != unicodedata.normalize("NFC", t): defects.append({"lang": lang, "key": k, "type": "nfc"})
        lim = maxlen.get(k, (len(s) * max_ratio + 2) if len(s) >= 4 else float("inf"))
        if len(t) > lim: defects.append({"lang": lang, "key": k, "type": "length", "limit": int(lim), "actual": len(t)})
    extra = [k for k in tgt if k not in src]
    return defects, extra

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True); ap.add_argument("--targets", nargs="+", required=True, help="files or globs")
    ap.add_argument("--max-ratio", type=float, default=1.6); ap.add_argument("--glossary", default="")
    ap.add_argument("--maxlen", help="JSON file key -> max length"); ap.add_argument("--json")
    a = ap.parse_args()
    src = json.load(open(a.source, encoding="utf-8"))
    glossary = {g.strip().lower() for g in a.glossary.split(",") if g.strip()}
    maxlen = json.load(open(a.maxlen)) if a.maxlen else {}
    files = sorted({f for pat in a.targets for f in glob.glob(pat)} - {os.path.abspath(a.source), a.source})
    files = [f for f in files if os.path.abspath(f) != os.path.abspath(a.source)]
    all_defects, extras, checked = [], {}, 0
    for f in files:
        lang = os.path.splitext(os.path.basename(f))[0]
        d, extra = check(src, json.load(open(f, encoding="utf-8")), lang, a.max_ratio, glossary, maxlen)
        all_defects += d; checked += len(src)
        if extra: extras[lang] = extra
    blocking = [d for d in all_defects if d["type"] != "length"]
    if not all_defects: outcome, detail = "PASS", f"CLEAR: {checked} strings checked in {len(files)} catalog(s), no defect"
    elif blocking: outcome, detail = "FAIL", f"FAIL: {len(blocking)} blocking defect(s), {len(all_defects) - len(blocking)} length warning(s) in {len(files)} catalog(s)"
    else: outcome, detail = "UNSURE", f"REVIEW: {len(all_defects)} length overflow(s) only"
    v = {"schema": "verdict-gate/1", "verifier": "i18n", "target": f"{os.path.basename(a.source)} vs {', '.join(os.path.basename(f) for f in files)}",
         "outcome": outcome, "detail": detail, "evidence": all_defects[:200] + ([{"extra_keys": extras}] if extras else []), "guards": [], "needs_human": outcome != "PASS", "limits": LIMITS}
    if blocking: v["fix_hint"] = "re-translate the listed keys keeping every tag and placeholder exactly as in the source"
    print("VERDICT " + json.dumps(v, ensure_ascii=False))
    if a.json: json.dump(v, open(a.json, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    return {"PASS": 0, "FAIL": 2, "UNSURE": 3}[outcome]

if __name__ == "__main__":
    sys.exit(main())
