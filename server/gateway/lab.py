"""
The strategy lab, run across every core instead of one browser thread.

WHAT ACTUALLY MOVED
Not the engine — `server/engine/lab-engine.mjs` is the shipped TypeScript,
compiled. What moved is WHERE it runs and HOW MANY of it run at once. A study
was a synchronous call on the thread that also draws the chart, so the grid had
to stay small enough to keep a tab responsive, and three families meant three
studies one after another. Here a study is a process, and `n` of them run at
once on `n` cores.

THE SECOND WIN IS QUIETER AND WORTH MORE
The client can send a symbol instead of bars. `ui/strategy.ts` currently has to
have the history in the tab before it can study anything — it backfills, holds a
few thousand bars in memory, and hands them to the lab. Studying eight symbols
meant loading eight symbols into one page. Now the gateway fetches what a study
needs, and the browser sends thirty bytes.

WHAT IT REFUSES TO DO
It does not summarise, threshold or re-grade. `Study.headline` is computed
inside the engine specifically so a redesign cannot drop it, and this layer
would be exactly such a redesign if it decided which studies were worth
returning. Every study comes back whole, including the ones that say `refused`.

MEASURED — THE WHOLE LIBRARY, THROUGH THE BATCH ENDPOINT
All 25 specs in `app/src/backtest/specs.ts`, client-supplied bars, this machine
(8 cores, 8 workers, `python run.py --no-browser --no-background`):

    bars    submit    wall     per study (min/median/max)   sum      speed-up
    2,000    545 ms   3.18 s      384 /  594 /   923 ms   15.7 s      4.93x
    5,000      -      5.75 s      621 /  926 / 1,574 ms   26.0 s      4.52x

READ THE PER-STUDY COLUMN AGAINST `runSpecStudy`'S OWN 47 ms AND 81 ms.
Spawning `node`, parsing a 105 kB engine and warming V8 is roughly 340 ms and
540 ms of those figures — SEVEN TIMES the study at 2,000 bars. The
process-per-study design is still right (it is what makes a wedged study a
`kill` instead of a poisoned pool slot), and it was sized for `confluence` at
0.7-3.4 s, where the overhead is noise. For a 25-spec sweep it is most of the
bill, and the honest next move is a worker that stays alive for several studies
— NOT a pool, which is the thing the worker's own header refuses, but a process
handed a LIST of jobs it runs and exits after. Nothing here assumes that: the
speed-up below 8x is the overhead, not contention.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

# The three paths moved to `server/enginepath.py` when `svc/auto.py` started
# driving the same worker from a background thread. Two copies of a path is how
# one process ends up running a worker the other has never heard of.
from enginepath import ENGINE, SERVER_DIR, WORKER
from pydantic import BaseModel, Field, model_validator

Family = Literal["ema", "rsi", "confluence"]

#: One study is CPU-bound for up to a few seconds; `confluence` is ~20x the cost
#: of `ema` on the same bars. A wedged worker holds a core, so it gets a
#: deadline rather than the benefit of the doubt.
STUDY_TIMEOUT_S = 180.0

#: Bars are JSON on a pipe. 200k bars is far past any study that means anything,
#: and the cap stops a malformed request from becoming a memory incident.
MAX_BARS = 200_000


class BarModel(BaseModel):
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


class StudyRequest(BaseModel):
    """One study. Supply `bars`, or a `symbol` for the gateway to fetch.

    THE SUBJECT IS `family` OR `spec`, NEVER BOTH AND NEVER NEITHER.
    A study has one subject. A request naming both would make the gateway pick
    one, and a request naming neither would make it invent one; both are a wrong
    answer with no symptom, so both are a 422 before a worker is ever spawned.

    WHAT `spec` IS NOT VALIDATED AGAINST HERE, DELIBERATELY.
    A `RuleSpec`'s vocabulary — every column, every operator, what a condition
    may contain — lives in `app/src/backtest/rules.ts`, and `validateSpec` is
    the function that enforces it. Restating that vocabulary in pydantic would
    be a SECOND definition of what a rule is, free to drift from the one the
    engine actually runs: the gateway would start refusing a column the editor
    had just learned to emit, or accepting one the engine cannot compute. So
    this layer checks only what IT needs — an object with an `id` it can put in
    a label — and `parseJob` in the engine does the real check and returns the
    reason. Same rule as the frontend's "never retype a dependency's shape".
    """

    family: Family | None = None
    spec: dict[str, Any] | None = Field(
        default=None,
        description="A declarative RuleSpec, validated by the engine rather than here.",
    )
    symbol: str | None = Field(default=None, description="Fetched server-side when `bars` is absent.")
    #: Which feed answers for `symbol`. Named, never inferred — the proxy owns
    #: the symbol dialect for each vendor, and guessing the vendor FROM the
    #: dialect gets the symbol rejected. See `fetch_bars` in `app.py`.
    provider: str = "yfinance"
    timeframe: str = "1h"
    limit: int = Field(default=2000, ge=200, le=MAX_BARS)
    bars: list[BarModel] | None = None
    opts: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _exactly_one_subject(self) -> StudyRequest:
        if self.family is not None and self.spec is not None:
            raise ValueError("name either `family` or `spec`, not both — a study has one subject")
        if self.family is None and self.spec is None:
            raise ValueError("name a `family` or a `spec` — there is nothing to study")
        if self.spec is not None:
            spec_id = self.spec.get("id")
            if not isinstance(spec_id, str) or not spec_id.strip():
                raise ValueError("`spec.id` must be a non-empty string")
        return self

    def subject(self) -> str:
        """`family:ema` or `spec:ema-9-21-cross`. Readable, and unambiguous.

        Prefixed because a family id and a spec id share one namespace here and
        nothing stops a spec being called `ema`. A bare id in a report would
        then name two different studies identically.
        """
        if self.family is not None:
            return f"family:{self.family}"
        return f"spec:{(self.spec or {}).get('id', '?')}"

    def label(self) -> str:
        return f"{self.symbol or 'bars'}/{self.timeframe}/{self.subject()}"

    def job(self, bars: list[dict[str, Any]]) -> dict[str, Any]:
        """The job as the worker's `parseJob` expects it on stdin.

        A family job is byte-for-byte what it always was; a spec job carries
        `spec` in place of `family`. Exactly one key, because `parseJob` refuses
        both — the same rule stated on both sides of the pipe rather than
        assumed on one of them.
        """
        subject: dict[str, Any] = {"family": self.family} if self.family is not None else {"spec": self.spec}
        return {**subject, "bars": bars, "opts": self.opts}


class BatchRequest(BaseModel):
    """Several studies, fanned out across cores.

    The shape the work arrives in: the Playbook runs three families over one
    symbol, a scan runs one family over a watchlist.
    """

    studies: list[StudyRequest] = Field(min_length=1, max_length=64)


@dataclass
class StudyOutcome:
    label: str
    #: `family:ema` or `spec:<id>`. Was `family: str`, which could not name a
    #: spec study at all and would have had to hold an empty string for one.
    subject: str
    ok: bool
    study: dict[str, Any] | None = None
    error: str | None = None
    ms: int = 0
    bars: int = 0
    source: str = ""


@dataclass
class Job:
    id: str
    total: int
    started: float = field(default_factory=time.time)
    done: int = 0
    outcomes: list[StudyOutcome] = field(default_factory=list)
    state: str = "running"
    task: asyncio.Task[None] | None = None

    def report(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "elapsed_s": round(time.time() - self.started, 2),
            "studies": [
                {
                    "label": o.label,
                    "subject": o.subject,
                    "ok": o.ok,
                    "error": o.error,
                    "ms": o.ms,
                    "bars": o.bars,
                    "source": o.source,
                    # The headline is lifted out for a progress view; `study`
                    # below is the whole thing, ungraded and unfiltered.
                    "headline": (o.study or {}).get("headline") if o.ok else None,
                    "study": o.study,
                }
                for o in self.outcomes
            ],
        }


FetchBars = Callable[[str, str, int, str], Awaitable[tuple[list[dict[str, Any]], str]]]


class Lab:
    """Spawns workers, limits them to the core count, and tracks jobs."""

    def __init__(self, fetch: FetchBars) -> None:
        self.fetch = fetch
        self.jobs: dict[str, Job] = {}
        cores = os.cpu_count() or 4
        # One study per core. Node is single-threaded for this work, so more
        # processes than cores buys queueing, not throughput.
        self.workers = int(os.environ.get("IRAM_LAB_WORKERS", str(cores)))
        self._limiter = asyncio.Semaphore(self.workers)

    # ------------------------------------------------------------- health --
    def health(self) -> dict[str, Any]:
        node = shutil.which("node")
        engine = os.path.exists(ENGINE)
        return {
            "ok": bool(node) and engine and os.path.exists(WORKER),
            "node": node,
            "engine": ENGINE if engine else None,
            "engine_built": engine,
            "workers": self.workers,
            "cores": os.cpu_count(),
            "hint": None
            if (node and engine)
            else "run: npm --prefix app run build:lab   (and install Node)",
        }

    # ---------------------------------------------------------------- run --
    async def run_one(self, request: StudyRequest) -> StudyOutcome:
        label = request.label()
        subject = request.subject()
        try:
            if request.bars is not None:
                bars = [b.model_dump() for b in request.bars]
                source = "client"
            elif request.symbol:
                fetched, source = await self.fetch(
                    request.symbol, request.timeframe, request.limit, request.provider
                )
                bars = fetched
            else:
                return StudyOutcome(label, subject, False, error="supply either `bars` or `symbol`")

            if not bars:
                # An empty fetch is a data problem, and saying so beats handing
                # the engine nothing and reporting its refusal as the answer.
                return StudyOutcome(
                    label, subject, False,
                    error=f"no bars returned for {request.symbol}", source=source,
                )

            payload = json.dumps(request.job(bars))

            async with self._limiter:
                started = time.perf_counter()
                proc = await asyncio.create_subprocess_exec(
                    "node",
                    WORKER,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=SERVER_DIR,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(payload.encode()), timeout=STUDY_TIMEOUT_S
                    )
                except TimeoutError:
                    proc.kill()
                    await proc.wait()
                    return StudyOutcome(
                        label, subject, False,
                        error=f"study exceeded {STUDY_TIMEOUT_S:.0f}s and was killed",
                        bars=len(bars), source=source,
                    )
                elapsed = int((time.perf_counter() - started) * 1000)

            try:
                result = json.loads(stdout.decode() or "{}")
            except json.JSONDecodeError:
                detail = (stderr.decode() or stdout.decode())[:300]
                return StudyOutcome(
                    label, subject, False,
                    error=f"worker produced no JSON: {detail}",
                    bars=len(bars), source=source,
                )

            if not result.get("ok"):
                return StudyOutcome(
                    label, subject, False,
                    error=str(result.get("error") or "unknown worker error"),
                    bars=len(bars), source=source,
                )

            return StudyOutcome(
                label, subject, True,
                study=result["result"]["study"],
                ms=elapsed, bars=len(bars), source=source,
            )
        except Exception as exc:  # noqa: BLE001 — one bad study must not end a batch
            return StudyOutcome(label, subject, False, error=f"{type(exc).__name__}: {exc}")

    # ---------------------------------------------------------- batch job --
    def submit(self, batch: BatchRequest) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], total=len(batch.studies))
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self._run_batch(job, batch), name=f"lab-{job.id}")
        return job

    async def _run_batch(self, job: Job, batch: BatchRequest) -> None:
        async def one(request: StudyRequest) -> None:
            outcome = await self.run_one(request)
            job.outcomes.append(outcome)
            job.done += 1

        try:
            # Every study is launched at once; the semaphore decides how many
            # actually run, so the core count lives in exactly one place.
            await asyncio.gather(*(one(s) for s in batch.studies))
            job.state = "done"
        except asyncio.CancelledError:
            job.state = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            job.state = f"failed: {type(exc).__name__}: {exc}"

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None or job.task is None or job.task.done():
            return False
        job.task.cancel()
        job.state = "cancelled"
        return True
