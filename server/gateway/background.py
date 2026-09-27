"""
The eleven loops `mishel_service.py` used to start in its `__main__` block.

WHY THEY MOVED, AND WHY THAT IS MORE THAN TIDYING
They were started by the block that also called `app.run(...)`, which means they
only ever ran when that file was the process entry point. Import it — as the
gateway does, as a test does — and you get all fifty-three routes and none of
the work behind them: alerts that never evaluate, backups that never happen, a
heartbeat that never beats. Nothing announces this. `/svc/health` answers, the
alert rows sit there unfired, and the dead-man's switch designed to make silence
audible is itself silent.

Under a lifespan they are owned by the application rather than by one way of
starting it, and `/api/health` reports which ones are actually turning.

OFF BY DEFAULT — set `IRAM_BACKGROUND=1`.
These loops poll vendors, write to SQLite and send Telegram messages. A gateway
started to serve one backtest, or by a test, must not begin doing that. `run.py`
is the thing that means "run the product properly", so that is what sets the
flag — and `run.py --no-background` is how to say otherwise.

THAT SENTENCE USED TO NAME A LAUNCHER THAT DID NOT DO IT. It credited
`start_mishel.py`, which started the three services as SEPARATE PROCESSES and so
never went near this flag; and no other launcher set it either. Measured on a
running gateway: `/api/health` reported `background: {enabled: false}` — so
every one of these loops, including the dead-man's-switch heartbeat whose entire
job is to make silence audible, had silently not run since consolidation. A
comment naming the component that is supposed to do something is not evidence
that anything does it.

THEY REMAIN DAEMON THREADS. Every one is a `while True` around a blocking
`sleep_ticking`, with no cancellation point to await and no shutdown protocol to
call. Wrapping them in tasks the gateway pretends it can stop would be a lie
told at the one moment it matters. Daemon threads die with the process, which is
what actually happens today and what the loops are already written for.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: Loop attribute names on `mishel_service`, in the order its `__main__` started
#: them. `heartbeat_loop` sleeps 30s first so the others can register a tick.
LOOP_NAMES: tuple[str, ...] = (
    "alert_loop",
    "bars_loop",
    "backup_loop",
    "data_loop",
    "ledger_loop",
    "whale_loop",
    "pair_scan_loop",
    "smart_copy_loop",
    "sig_loop",
    "heartbeat_loop",
    "db_alert_loop",
    "daily_brief_loop",
    # v62.6. Last, because a pass is minutes of CPU across every core and the
    # loops above it are seconds — starting it first would make a cold boot
    # look wedged.
    "auto_loop",
)


@dataclass
class LoopStatus:
    name: str
    started: bool
    error: str | None = None


class Loops:
    """Starts the service loops once, and reports on them."""

    def __init__(self) -> None:
        self.statuses: list[LoopStatus] = []
        self._threads: list[threading.Thread] = []
        self._module: Any = None
        self.enabled = False

    def start(self, module: Any) -> None:
        self._module = module
        self.enabled = True
        for name in LOOP_NAMES:
            fn: Callable[[], None] | None = getattr(module, name, None)
            if fn is None:
                # A loop that was renamed upstream must not be a silent absence.
                self.statuses.append(LoopStatus(name, False, "not found on mishel_service"))
                continue
            thread = threading.Thread(target=fn, name=f"iram-{name}", daemon=True)
            thread.start()
            self._threads.append(thread)
            self.statuses.append(LoopStatus(name, True))

    def report(self) -> dict[str, Any]:
        """What is running, and when each loop last ticked.

        `last_tick_age_s` comes from `mishel_service.LOOP_TICK`, the same table
        `/svc/health` reads, so the gateway cannot disagree with the service
        about which loops are stale.
        """
        if not self.enabled:
            return {"enabled": False, "hint": "set IRAM_BACKGROUND=1 to run service loops"}

        import time

        ticks: dict[str, float] = getattr(self._module, "LOOP_TICK", {}) or {}
        now = time.time()
        return {
            "enabled": True,
            "alive": sum(1 for t in self._threads if t.is_alive()),
            "loops": {
                s.name: {
                    "started": s.started,
                    "error": s.error,
                    "last_tick_age_s": (
                        round(now - ticks[s.name]) if s.name in ticks else None
                    ),
                }
                for s in self.statuses
            },
        }


loops = Loops()
