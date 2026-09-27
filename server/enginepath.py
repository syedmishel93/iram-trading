"""Where the lab worker and the compiled engine live. One owner, two readers.

`gateway/lab.py` computed these for its asyncio pool, and `svc/auto.py` needs
the same three facts for its background loop. Two copies of a path is how one
process ends up driving a worker the other has never heard of — and the loop
cannot import from the gateway, because the gateway mounts the service and not
the other way round. A leaf module both can read inverts nothing.
"""

from __future__ import annotations

import os

#: `server/`, wherever this checkout or bundle put it.
SERVER_DIR = os.path.dirname(os.path.abspath(__file__))

#: The process that runs one job and exits.
WORKER = os.path.join(SERVER_DIR, "lab_worker.mjs")

#: The shipped TypeScript engine, compiled. Built by `npm --prefix app run build:lab`.
ENGINE = os.path.join(SERVER_DIR, "engine", "lab-engine.mjs")

__all__ = ["ENGINE", "SERVER_DIR", "WORKER"]
