#!/usr/bin/env python3
"""
v35.0 — BUILD: src/  ->  dist/index.html

WHAT THIS RETIRES (the tax paid on every one of the last 34 builds)
  · triple manual version bump      -> injected from src/VERSION, one place
  · exact-string atomic patching    -> ordinary file edits in src/js/*.js
  · WSRC string-literal extraction  -> just another module, checked like any other
  · "syntax error at line 7,412"    -> node --check per module, error points at
                                       the 200-line file that actually broke

WHAT IT GUARANTEES
  --verify-identity rebuilds and asserts the output is BYTE-IDENTICAL (sha256)
  to the index.html the split was taken from. A refactor that cannot change the
  shipped bytes is a refactor that cannot introduce a bug.

USAGE
  python3 tools/build.py                     # build dist/index.html
  python3 tools/build.py --verify-identity   # build + prove bytes unchanged
  python3 tools/build.py --release           # build + bump version + copy to ./index.html
"""
import io, os, sys, json, hashlib, subprocess, shutil, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, 'src')
DIST = os.path.join(ROOT, 'dist')

def sha(t): return hashlib.sha256(t.encode('utf-8')).hexdigest()

def main():
    args = set(sys.argv[1:])
    mani = json.load(io.open(os.path.join(SRC, 'manifest.json'), encoding='utf-8'))

    # v38.0 — A BUILD THAT SILENTLY DROPS SOURCE IS WORSE THAN ONE THAT CRASHES.
    # build.py is manifest-driven, so a NEW src/js file is simply ignored — and the
    # build still prints "released". I lost two whole modules to this and only caught
    # it by grepping the output. Never again: any .js on disk that is not in the
    # manifest is a HARD FAILURE.
    listed = {p for p in mani['parts'] if p.startswith('js/')}
    ondisk = {'js/' + f for f in os.listdir(os.path.join(SRC, 'js')) if f.endswith('.js')}
    orphan = sorted(ondisk - listed)
    missing = sorted(listed - ondisk)
    if orphan:
        raise SystemExit("BUILD ABORTED — these source files exist but are NOT in "
                         "src/manifest.json, so they would be silently dropped:\n  "
                         + "\n  ".join(orphan)
                         + "\n\nAdd them to manifest.json (in load order) and rebuild.")
    if missing:
        raise SystemExit("BUILD ABORTED — manifest lists files that do not exist:\n  "
                         + "\n  ".join(missing))
    ver  = io.open(os.path.join(SRC, 'VERSION'), encoding='utf-8').read().strip()

    # ---- 1. per-module syntax check (the ergonomic win) --------------------
    bad = 0
    for p in mani['parts']:
        if not p.endswith('.js'): continue
        f = os.path.join(SRC, p)
        r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
        if r.returncode != 0:
            bad += 1
            print(f'  [FAIL] {p}\n{r.stderr.strip()[:400]}')
    if bad:
        print(f'\n  {bad} module(s) failed node --check — BUILD ABORTED'); return 1
    print(f'  node --check: {sum(1 for p in mani["parts"] if p.endswith(".js"))} modules OK')

    # ---- 2. concatenate ----------------------------------------------------
    out = ''.join(io.open(os.path.join(SRC, p), encoding='utf-8', newline='').read()
                  for p in mani['parts'])

    # ---- 3. identity proof (before any version injection) ------------------
    if '--verify-identity' in args:
        want = mani['sha256_of_source']
        got  = sha(out)
        if got != want:
            print(f'\n  !! IDENTITY FAILED\n     expected {want}\n     got      {got}')
            io.open('/tmp/build_mismatch.html', 'w', encoding='utf-8', newline='').write(out)
            return 1
        print(f'  IDENTITY PROVEN: sha256 {got[:16]}… — rebuilt bytes are IDENTICAL to source')

    # ---- 4. version injection: ONE place, three call sites -----------------
    if '--release' in args:
        n = 0
        # NOTE: the dotted-version requirement is load-bearing. A loose `BUILD v[\d.]+`
        # also matches the CSS comment "INTERFACE REBUILD v5" — which is exactly the
        # kind of collateral damage a manual/sed version bump would do silently.
        # The count==3 assert below is what caught it. Keep both.
        for pat, rep in ((r'(?<!RE)BUILD v\d+\.\d+', f'BUILD v{ver}'),
                         (r'MISHEL \u00b7 v\d+\.\d+', f'MISHEL \u00b7 v{ver}'),
                         (r"APP_VER='\d+\.\d+'", f"APP_VER='{ver}'")):
            out, k = re.subn(pat, rep, out)
            n += k
        assert n == 3, f'version injection hit {n} sites, expected 3 — ABORT'
        print(f'  version injected -> v{ver} (3 sites, from src/VERSION — no manual bump)')

    # ---- 5. emit -----------------------------------------------------------
    os.makedirs(DIST, exist_ok=True)
    dst = os.path.join(DIST, 'index.html')
    io.open(dst, 'w', encoding='utf-8', newline='').write(out)
    print(f'  wrote {dst}  ({len(out):,} bytes, {out.count(chr(10)):,} lines)')

    # ---- 6. the existing gate still runs on the OUTPUT ---------------------
    v = os.path.join(ROOT, 'tools', 'verify.py')
    if os.path.exists(v):
        r = subprocess.run(['python3', v, dst], capture_output=True, text=True)
        print('  ' + r.stdout.strip().splitlines()[-1].strip())
        if r.returncode != 0: return 1

    if '--release' in args:
        shutil.copy(dst, os.path.join(ROOT, 'index.html'))
        print(f'  released -> index.html (v{ver})')
    return 0

if __name__ == '__main__':
    sys.exit(main())
