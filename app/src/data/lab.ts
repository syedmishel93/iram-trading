/**
 * The strategy lab, run on the backend instead of on the chart thread.
 *
 * WHAT THIS IS NOT: A SECOND ENGINE
 * `server/engine/lab-engine.mjs` is this repository's own `backtest/lab.ts`,
 * compiled. The gateway spawns a Node worker per study and that worker calls
 * the same `runStudy` this module's fallback calls in the tab. There is one
 * implementation of the sweep, the walk-forward and the CSCV, which is the only
 * arrangement under which "it ran on the server" is not also "it might disagree
 * with what the desk would have said".
 *
 * WHY MOVE IT AT ALL, GIVEN ONE STUDY GETS NO FASTER
 * A single study is one process either way; the server does not make it
 * quicker, and pretending otherwise would be the wrong reason to do this. Two
 * real ones:
 *
 *   - **The chart thread stops blocking.** A `confluence` sweep is ~1.7s of
 *     synchronous work, and `ui/strategy.ts` currently has to double-yield
 *     through `scheduleFrame` just so the button can repaint "Running…" before
 *     the tab freezes. Nothing else — no crosshair, no incoming tick, no other
 *     desk — moves during that.
 *   - **A study can be one of many.** The batch endpoint fans studies across
 *     cores (measured 3.0x on eight), which is what makes a playbook-wide or
 *     watchlist-wide sweep a thing you would actually wait for.
 *
 * BARS ARE SENT, NOT A SYMBOL — DELIBERATELY, HERE
 * The endpoint accepts either. The desk sends bars because it has already done
 * work the server cannot repeat: it backfilled through the archive to reach the
 * family's warm-up, and it re-measured coverage with `openCoverage` against the
 * venue's own calendar, without which every FX study scores ~71% and gets
 * refused. Asking the server to fetch its own bars would study a different
 * window than the one the desk is about to describe on screen.
 *
 * THE FALLBACK IS THE POINT
 * No backend is a supported way to run this terminal. Every failure here —
 * refused connection, a 500, a malformed body — returns `ok: false` and the
 * desk runs the study locally, exactly as it always did. The only thing the
 * operator loses is the unblocked thread, and they are told which happened.
 */

import { gatewayBase } from "./backend";
import type { BarView } from "../chart/series";
import type { Family, Study, StudySubject } from "../backtest/lab";

export interface RemoteStudyOptions {
  costs?: { spread: number; commission: number; slippage: number };
  riskPerTrade?: number;
  coverage?: number;
  containsDemo?: boolean;
  allowDemo?: boolean;
}

export interface RemoteStudyResult {
  ok: boolean;
  study: Study | null;
  /** Wall-clock milliseconds the WORKER took, as the gateway measured it. */
  ms: number;
  /** Why it could not run there. Empty when `ok`. */
  error: string;
}

/**
 * How long to wait before giving up and running locally.
 *
 * Generous, because a study legitimately takes seconds and killing one that was
 * about to answer wastes the whole run. Bounded, because the fallback is cheap
 * and a hung request must not leave the desk on "Running…" for ever — the exact
 * failure `scheduleFrame` was introduced to stop.
 */
export const REMOTE_TIMEOUT_MS = 120_000;

/** Run one study on the backend. Never throws; failure is a returned value. */
export async function runStudyRemote(
  family: Family,
  bars: readonly BarView[],
  opts: RemoteStudyOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteStudyResult> {
  const failed = (error: string): RemoteStudyResult => ({ ok: false, study: null, ms: 0, error });

  // The engine refuses a study on too little history anyway, and shipping a
  // megabyte of bars to be told so is a waste of both ends.
  if (bars.length === 0) return failed("no bars");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${gatewayBase()}/api/lab/study`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        family,
        // Sent as plain objects: `BarView` already is one, so there is no
        // serialisation step to get wrong between the two engines.
        bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
        opts,
      }),
    });

    if (!response.ok) return failed(`backend answered ${response.status}`);

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return failed("backend sent no result");

    const result = body as Record<string, unknown>;
    if (result["ok"] !== true) {
      return failed(typeof result["error"] === "string" ? result["error"] : "backend refused the study");
    }
    if (typeof result["study"] !== "object" || result["study"] === null) {
      return failed("backend sent no study");
    }

    return {
      ok: true,
      study: result["study"] as Study,
      ms: typeof result["ms"] === "number" ? result["ms"] : 0,
      error: "",
    };
  } catch (err) {
    // AbortError, a refused connection, or a body that would not parse. All
    // three mean the same thing to the caller: run it here instead.
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ batch jobs --- */

/**
 * THE BATCH API, AND WHY IT IS A JOB RATHER THAN A LONGER REQUEST.
 *
 * `runStudyRemote` above holds the connection open until the study answers,
 * which is right for one study and wrong for twenty-five: a minute of compute
 * behind one HTTP request is a minute a proxy timeout, a laptop lid or a tab
 * close can destroy along with every result. So the batch endpoint returns an
 * id immediately and the results are polled off it, which also means progress
 * exists at all — twenty-five studies with no interim report is a spinner.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not grade, rank, filter or summarise. Every outcome comes back whole,
 * including the refusals, for the same reason `gateway/lab.py` states: the
 * headline is computed inside the engine so that a layer like this one cannot
 * decide which studies were worth returning.
 *
 * MEASURED, so `intervalMs` can be chosen rather than guessed: all 25 shipped
 * specs over 2,000 bars is 3.2s wall on this machine's 8 cores and 5.8s over
 * 5,000 — so a one-second poll reports three to six times during a sweep, and
 * the figures per study are in `server/gateway/lab.py`.
 */

/** Mirrors `BatchRequest.studies`'s cap in `server/gateway/lab.py`. */
export const LAB_BATCH_MAX = 64;

/**
 * One study in a batch: a subject, and either bars or a symbol to fetch.
 *
 * `subject` is the SAME union `backtest/lab.ts` defines, imported rather than
 * restated — a `{family}`/`{spec}` pair declared here would be a second
 * definition of what a study is about, free to drift from the one the engine
 * actually dispatches on.
 */
export interface LabStudyRequest {
  readonly subject: StudySubject;
  /** Sent when the caller has already loaded and coverage-checked the history. */
  readonly bars?: readonly BarView[];
  /** Fetched server-side instead, when `bars` is absent. */
  readonly symbol?: string;
  readonly provider?: string;
  readonly timeframe?: string;
  readonly limit?: number;
  readonly opts?: RemoteStudyOptions;
}

export interface LabJobHandle {
  ok: boolean;
  id: string;
  total: number;
  state: string;
  /** Why it could not be submitted. Empty when `ok`. */
  error: string;
}

/** One finished (or failed) study inside a job. */
export interface LabStudyOutcome {
  label: string;
  /** `family:ema` or `spec:ema-9-21-cross` — what the gateway was asked for. */
  subject: string;
  ok: boolean;
  /** Why this one study failed. Empty when `ok`. */
  error: string;
  ms: number;
  bars: number;
  /** `client` when the caller sent bars, otherwise the provider that answered. */
  source: string;
  study: Study | null;
}

export type LabJobState = "running" | "done" | "cancelled" | "failed" | "unknown";

export interface LabJobProgress {
  ok: boolean;
  id: string;
  state: LabJobState;
  done: number;
  total: number;
  elapsedS: number;
  /** Completed studies, in the order the gateway finished them. */
  studies: LabStudyOutcome[];
  /** Why the job could not be read. Empty when `ok`. */
  error: string;
}

const NO_BACKEND =
  "The backend is not answering on this address, so the sweep cannot run there. " +
  "Start it with `python run.py`.";

const jobGone = (id: string): string =>
  `The backend has no job ${id} any more. Jobs live in the gateway's memory, so a restart ` +
  `loses them — the studies are not recoverable and the sweep has to be submitted again.`;

const serialise = (request: LabStudyRequest): Record<string, unknown> => ({
  ...(request.subject.kind === "family"
    ? { family: request.subject.id }
    : { spec: request.subject.spec }),
  ...(request.bars
    ? { bars: request.bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) }
    : {}),
  ...(request.symbol !== undefined ? { symbol: request.symbol } : {}),
  ...(request.provider !== undefined ? { provider: request.provider } : {}),
  ...(request.timeframe !== undefined ? { timeframe: request.timeframe } : {}),
  ...(request.limit !== undefined ? { limit: request.limit } : {}),
  opts: request.opts ?? {},
});

const asState = (raw: unknown): LabJobState => {
  if (raw === "running" || raw === "done" || raw === "cancelled") return raw;
  /* The gateway writes `failed: TypeError: ...` — the detail is carried in
     `error`, and the STATE stays one of five words a caller can switch on. */
  if (typeof raw === "string" && raw.startsWith("failed")) return "failed";
  return "unknown";
};

const text = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";

const num = (o: Record<string, unknown>, k: string): number =>
  typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : 0;

/** Submit a batch. Returns a job id immediately; nothing has run yet. */
export async function submitLabJob(
  studies: readonly LabStudyRequest[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LabJobHandle> {
  const failed = (error: string): LabJobHandle => ({ ok: false, id: "", total: 0, state: "", error });

  if (studies.length === 0) return failed("No studies to run.");
  if (studies.length > LAB_BATCH_MAX) {
    return failed(
      `${studies.length} studies is over the backend's limit of ${LAB_BATCH_MAX} in one job. ` +
        `Split the sweep — the limit is there because one job holds every result in the gateway's memory.`,
    );
  }

  try {
    const response = await fetchImpl(`${gatewayBase()}/api/lab/studies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ studies: studies.map(serialise) }),
    });
    if (response.status === 422) {
      return failed("The backend rejected the sweep: one of the studies is not a shape it accepts.");
    }
    if (!response.ok) return failed(`The backend answered ${response.status} to the sweep.`);

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return failed("The backend sent no job id.");
    const o = body as Record<string, unknown>;
    if (text(o, "id") === "") return failed("The backend sent no job id.");

    return { ok: true, id: text(o, "id"), total: num(o, "total"), state: text(o, "state"), error: "" };
  } catch (err) {
    return failed(err instanceof Error && err.name === "AbortError" ? "The sweep was cancelled." : NO_BACKEND);
  }
}

/** Read a job's progress and whatever has finished so far. */
export async function pollLabJob(
  id: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LabJobProgress> {
  const failed = (error: string, state: LabJobState = "unknown"): LabJobProgress => ({
    ok: false, id, state, done: 0, total: 0, elapsedS: 0, studies: [], error,
  });

  try {
    const response = await fetchImpl(
      `${gatewayBase()}/api/lab/studies/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
    if (!response.ok) return failed(`The backend answered ${response.status} reading job ${id}.`);

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return failed(`The backend sent nothing for job ${id}.`);
    const o = body as Record<string, unknown>;

    /* The route answers 200 with `{"error": "no job ..."}` for an id it does not
       hold. A 200 whose body is an error is still an error, and reading it as
       "0 of 0 done" would render a lost job as a finished one — the same class
       as `/svc/health` reporting "0 of 0 loops running" in green. */
    if (typeof o["error"] === "string") return failed(jobGone(id));
    if (!Array.isArray(o["studies"])) return failed(`The backend sent no study list for job ${id}.`);

    const studies: LabStudyOutcome[] = (o["studies"] as unknown[]).map((raw) => {
      const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      return {
        label: text(s, "label"),
        subject: text(s, "subject"),
        ok: s["ok"] === true,
        error: text(s, "error"),
        ms: num(s, "ms"),
        bars: num(s, "bars"),
        source: text(s, "source"),
        study: typeof s["study"] === "object" && s["study"] !== null ? (s["study"] as Study) : null,
      };
    });

    return {
      ok: true,
      id: text(o, "id") || id,
      state: asState(o["state"]),
      done: num(o, "done"),
      total: num(o, "total"),
      elapsedS: num(o, "elapsed_s"),
      studies,
      error: "",
    };
  } catch (err) {
    return failed(err instanceof Error && err.name === "AbortError" ? "The sweep was cancelled." : NO_BACKEND);
  }
}

/**
 * Cancel a running batch.
 *
 * `cancelled: false` is not a failure — it is the honest answer for a job that
 * had already finished, and the caller needs to be able to tell that apart from
 * "the request did not arrive".
 */
export async function cancelLabJob(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; cancelled: boolean; error: string }> {
  try {
    const response = await fetchImpl(`${gatewayBase()}/api/lab/studies/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return { ok: false, cancelled: false, error: `The backend answered ${response.status} cancelling job ${id}.` };
    }
    const body = (await response.json()) as Record<string, unknown>;
    return { ok: true, cancelled: body["cancelled"] === true, error: "" };
  } catch {
    return { ok: false, cancelled: false, error: NO_BACKEND };
  }
}

export interface LabJobDriveOptions {
  /** How often to ask. The caller owns this: a 25-study sweep is not a tick. */
  readonly intervalMs?: number;
  /** Aborts the poll AND cancels the job on the backend. */
  readonly signal?: AbortSignal;
  /** Called after every poll that returned, including the first. */
  readonly onProgress?: (progress: LabJobProgress) => void;
  /**
   * Give up after this long. Distinct from a study's own timeout: the gateway
   * kills a study at 180s, so a job that is still "running" long after every
   * study could have been killed means the gateway itself stopped answering.
   */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injectable for the test suite; real callers get `setTimeout`. */
  readonly wait?: (ms: number) => Promise<void>;
}

export const LAB_JOB_POLL_MS = 1_000;
export const LAB_JOB_TIMEOUT_MS = 30 * 60_000;

/**
 * Submit, poll to completion, report progress as studies land.
 *
 * IT ASKS `labCapacity` FIRST, and that extra round trip is deliberate. The
 * gateway accepts a batch perfectly happily with Node missing or the engine
 * unbuilt, and then answers with twenty-five identical worker errors. One
 * sentence naming the missing piece, before anything is sent, is the difference
 * between a fixable state and a wall of noise — and it is the same question
 * `labCapacity` already exists to answer, asked at the moment it matters.
 */
export async function runLabJob(
  studies: readonly LabStudyRequest[],
  options: LabJobDriveOptions = {},
): Promise<LabJobProgress> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const interval = options.intervalMs ?? LAB_JOB_POLL_MS;
  const timeout = options.timeoutMs ?? LAB_JOB_TIMEOUT_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const failed = (error: string, state: LabJobState = "failed", id = ""): LabJobProgress => ({
    ok: false, id, state, done: 0, total: studies.length, elapsedS: 0, studies: [], error,
  });

  if (options.signal?.aborted) return failed("The sweep was cancelled.", "cancelled");

  const capacity = await labCapacity(fetchImpl);
  if (!capacity.ok) {
    return failed(
      capacity.hint === "no backend"
        ? NO_BACKEND
        : `The backend is running but cannot study anything: ${capacity.hint || "it did not say why"}.`,
    );
  }

  const handle = await submitLabJob(studies, fetchImpl, options.signal);
  if (!handle.ok) return failed(handle.error, options.signal?.aborted ? "cancelled" : "failed");

  const started = Date.now();
  let last: LabJobProgress | null = null;

  for (;;) {
    const progress = await pollLabJob(handle.id, fetchImpl, options.signal);
    if (progress.ok) {
      last = progress;
      options.onProgress?.(progress);
      if (progress.state !== "running") return progress;
    } else if (options.signal?.aborted) {
      await cancelLabJob(handle.id, fetchImpl);
      return { ...failed(progress.error, "cancelled", handle.id), studies: last?.studies ?? [] };
    } else {
      /* A poll that could not be read is terminal. Retrying would turn "the
         gateway died" into a silent wait that ends at the timeout with nothing
         to show, half an hour later. */
      return { ...progress, total: progress.total || studies.length, studies: last?.studies ?? [] };
    }

    if (Date.now() - started > timeout) {
      await cancelLabJob(handle.id, fetchImpl);
      return {
        ...(last ?? failed("", "failed", handle.id)),
        ok: false,
        id: handle.id,
        state: "failed",
        error:
          `The sweep was still running after ${Math.round(timeout / 1000)}s and was cancelled. ` +
          `${last?.done ?? 0} of ${last?.total ?? studies.length} studies finished; those results are below.`,
      };
    }

    if (options.signal?.aborted) {
      await cancelLabJob(handle.id, fetchImpl);
      return {
        ...(last ?? failed("", "cancelled", handle.id)),
        ok: false,
        id: handle.id,
        state: "cancelled",
        error: "The sweep was cancelled.",
      };
    }

    await wait(interval);
  }
}

export interface LabCapacity {
  ok: boolean;
  workers: number;
  cores: number;
  /** Why it cannot run studies, when it cannot. */
  hint: string;
}

/**
 * Whether the backend can run studies at all.
 *
 * Distinct from "is the gateway up": the gateway runs fine without Node
 * installed or without `npm run build:lab` having been run, and in that state
 * it answers health checks while being unable to run a single study. The desk
 * needs the second question, and needs the answer to name the missing piece.
 */
export async function labCapacity(fetchImpl: typeof fetch = fetch): Promise<LabCapacity> {
  try {
    const response = await fetchImpl(`${gatewayBase()}/api/lab/health`);
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: body["ok"] === true,
      workers: typeof body["workers"] === "number" ? body["workers"] : 0,
      cores: typeof body["cores"] === "number" ? body["cores"] : 0,
      hint: typeof body["hint"] === "string" ? body["hint"] : "",
    };
  } catch {
    return { ok: false, workers: 0, cores: 0, hint: "no backend" };
  }
}
