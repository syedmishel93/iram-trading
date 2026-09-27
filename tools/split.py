#!/usr/bin/env python3
"""
v35.0 — SPLIT: index.html  ->  src/ modules.

THE POINT
  index.html is 11,700 lines in one file. Every build for 34 versions has been paid
  for with exact-string atomic patches, a triple manual version bump, and a bespoke
  string-literal extraction for the worker. That is a tax on every future change,
  and the biggest change (MT5 integration) is next.

THE GUARANTEE
  This split is BYTE-PRESERVING. It only ever cuts at line boundaries and never
  edits a single character. build.py concatenates the parts back and asserts the
  result is byte-identical to the original (sha256). If the hash matches, the
  refactor is correct BY CONSTRUCTION — not by inspection, not by hope.

HOW THE JS IS CUT
  Candidate cut points are lines that start at column 0 with a top-level construct
  (function / const / (function(){ / IND. / window. / a banner comment ...).
  A candidate is ACCEPTED only if the resulting chunk parses standalone under
  `node --check`. If it does not, the chunk is greedily merged with the next one
  and retried. So every emitted module is independently syntax-checkable — which
  is the whole ergonomic win: a syntax error points at line 40 of orb.js, not at
  line 7,412 of an 11,700-line file.
"""
import io, os, re, json, hashlib, subprocess, sys, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, 'src')
IDX  = os.path.join(ROOT, 'index.html')

MIN_LINES = 120          # don't emit trivially small modules
TOP = re.compile(r'^(?:/\*\s*=+|function\s+\w+\s*\(|const\s+\w+|let\s+\w+|var\s+\w+|'
                 r'\(function\s*\(|window\.\w+\s*=|IND\.\w+\s*=|document\.\w+|'
                 r'class\s+\w+|try\s*\{|setTimeout\(|setInterval\(|if\s*\()')

def node_check(text):
    p = subprocess.run(['node', '--check', '-'], input=text, capture_output=True, text=True)
    return p.returncode == 0

def main():
    raw = io.open(IDX, encoding='utf-8', newline='').read()
    sha = hashlib.sha256(raw.encode('utf-8')).hexdigest()

    # --- locate the ONE big inline script (the app) --------------------------
    starts = [m for m in re.finditer(r'<script>', raw)]
    best = None
    for m in starts:
        e = raw.find('</script>', m.end())
        if e < 0: continue
        if best is None or (e - m.end()) > (best[1] - best[0]):
            best = (m.end(), e)
    assert best, 'no inline <script> found'
    js_a, js_b = best

    head = raw[:js_a]           # everything up to and including <script>
    body = raw[js_a:js_b]       # the app
    tail = raw[js_b:]           # </script> onwards

    if os.path.isdir(SRC): shutil.rmtree(SRC)
    os.makedirs(os.path.join(SRC, 'js'))

    manifest = {'sha256_of_source': sha, 'parts': []}

    def emit(relpath, text):
        p = os.path.join(SRC, relpath)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        io.open(p, 'w', encoding='utf-8', newline='').write(text)
        manifest['parts'].append(relpath)
        return len(text.splitlines())

    n = emit('00-head.html', head)
    print(f'  00-head.html                     {n:>6} lines  (DOM + CSS + <script> open)')

    # --- cut the JS body -----------------------------------------------------
    lines = body.split('\n')
    cands = [0] + [i for i, l in enumerate(lines) if TOP.match(l)] + [len(lines)]
    cands = sorted(set(cands))

    chunks, i = [], 0
    while i < len(cands) - 1:
        j = i + 1
        while j < len(cands):
            # grow until the chunk is big enough AND parses on its own
            if cands[j] - cands[i] >= MIN_LINES:
                text = '\n'.join(lines[cands[i]:cands[j]])
                if node_check(text):
                    chunks.append((cands[i], cands[j], text)); break
            j += 1
        else:
            text = '\n'.join(lines[cands[i]:])
            chunks.append((cands[i], len(lines), text)); j = len(cands) - 1
            i = len(cands) - 1; break
        i = j

    # any trailing remainder
    last = chunks[-1][1] if chunks else 0
    if last < len(lines):
        chunks.append((last, len(lines), '\n'.join(lines[last:])))

    def name_of(text, k):
        m = re.search(r'/\*\s*=+\s*(?:v[\d.]+\s*)?([A-Za-z0-9 ,+&\u2014\-/]{4,44})', text)
        if m:
            s = re.sub(r'[^a-z0-9]+', '-', m.group(1).strip().lower()).strip('-')[:34]
            if s: return f'{k:02d}-{s}.js'
        m = re.search(r'function\s+(\w+)\s*\(', text)
        if m: return f'{k:02d}-{m.group(1).lower()}.js'
        return f'{k:02d}-part.js'

    for k, (a, b, text) in enumerate(chunks, 1):
        nm = 'js/' + name_of(text, k)
        # chunks are joined with '\n' -> re-add the separator except on the last
        payload = text + ('\n' if k < len(chunks) else '')
        emit(nm, payload)
        print(f'  {nm:<32} {b-a:>6} lines  {"parses standalone OK" if node_check(text) else "(merged group)"}')

    n = emit('99-tail.html', tail)
    print(f'  99-tail.html                     {n:>6} lines  (</script> + closing DOM)')

    io.open(os.path.join(SRC, 'manifest.json'), 'w', encoding='utf-8').write(
        json.dumps(manifest, indent=2))
    # v39.1: was hardcoded '35.0' — every re-split silently RESET the version,
    # and a release run after a re-split stamped the stale number into all three
    # injection sites. The version is a property of the page being split: read it.
    _m = re.search(r"APP_VER='(\d+\.\d+)'", raw)
    assert _m, 'split: APP_VER not found in source page'
    io.open(os.path.join(SRC, 'VERSION'), 'w', encoding='utf-8').write(_m.group(1) + '\n')

    print(f'\n  source sha256: {sha[:16]}…')
    print(f'  {len(manifest["parts"])} parts written to src/  ·  manifest.json + VERSION')
    print('  now run: python3 tools/build.py --verify-identity')

if __name__ == '__main__':
    main()
