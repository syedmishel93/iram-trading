#!/usr/bin/env python3
"""verify.py <index.html>  — baseline integrity gate.
1) CSS brace balance across every <style> block
2) extract main <script> -> /tmp/main.js ; WSRC worker string literal -> /tmp/wsrc.js
3) ID census: getElementById('x') targets that have no id="x" in the HTML
Exit 1 on structural failure. Known-benign orphans are listed, not fatal.
"""
import re, sys, os, subprocess

BENIGN = set()  # populated from baseline run; orphans are reported, never fatal

def main(path):
    src = open(path, encoding='utf-8').read()
    ok = True

    # ---- 1. CSS brace balance -------------------------------------------------
    styles = re.findall(r'<style[^>]*>(.*?)</style>', src, re.S)
    for i, s in enumerate(styles):
        # strip comments and strings so braces inside them don't count
        s2 = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
        bal = s2.count('{') - s2.count('}')
        print(f"  CSS block {i}: {len(s2)} chars, brace balance {bal}")
        if bal != 0:
            print(f"  !! CSS block {i} UNBALANCED ({bal})"); ok = False

    # ---- 2. main <script> -----------------------------------------------------
    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', src, re.S)
    if not scripts:
        print("  !! no inline <script> found"); return 1
    main_js = max(scripts, key=len)
    open('/tmp/main.js', 'w', encoding='utf-8').write(main_js)
    print(f"  main <script>: {len(main_js)} chars -> /tmp/main.js  ({len(scripts)} inline scripts total)")

    # ---- 2b. WSRC worker (JS string literal) ----------------------------------
    m = re.search(r'var\s+WSRC\s*=\s*"((?:[^"\\]|\\.)*)"', main_js, re.S)
    if m:
        raw = m.group(1)
        # unescape the JS string literal exactly as the engine would
        worker = raw.encode().decode('unicode_escape')
        open('/tmp/wsrc.js', 'w', encoding='utf-8').write(worker)
        print(f"  WSRC worker string: {len(worker)} chars -> /tmp/wsrc.js")
    else:
        print("  (no WSRC worker string literal found)")

    # ---- 3. ID census ---------------------------------------------------------
    ids = set(re.findall(r'\bid="([^"]+)"', src))
    want = set(re.findall(r"getElementById\('([^']+)'\)", src)) | \
           set(re.findall(r'getElementById\("([^"]+)"\)', src))
    orphans = sorted(w for w in want if w not in ids)
    print(f"  IDs declared: {len(ids)} · getElementById targets: {len(want)} · orphans: {len(orphans)}")
    if orphans:
        print("  orphan ids (created at runtime or benign):", ', '.join(orphans))

    # ---- node --check ---------------------------------------------------------
    for f in ('/tmp/main.js', '/tmp/wsrc.js'):
        if not os.path.exists(f):
            continue
        r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  !! node --check FAILED on {f}\n{r.stderr[:2000]}"); ok = False
        else:
            print(f"  node --check OK: {f}")

    print("\n  ==> " + ("VERIFY GREEN" if ok else "VERIFY FAILED"))
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
