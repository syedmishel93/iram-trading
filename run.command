#!/usr/bin/env sh
# IRAM Intelligence Trading — macOS Finder double-click. Identical to run.sh.
#
# Three lines of logic on purpose. Every decision this launcher makes lives in
# run.py, so all three platforms read one copy instead of three that drift; the
# only thing a shell can do that Python cannot is find Python. Arguments are
# passed through, so `./run.sh --status` and `./run.sh --port 9000` work.
cd "$(dirname "$0")" || exit 1
for py in python3 python py; do
  command -v "$py" >/dev/null 2>&1 && exec "$py" run.py "$@"
done
echo "Python 3 was not found. Install it from https://www.python.org/downloads/"
echo "The whole backend is Python; there is no way to run this without it."
exit 1
