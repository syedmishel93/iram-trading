/**
 * Where an autonomous sweep's studies actually run.
 *
 * `autorun.ts` takes a `runStudies` function and has no opinion about cores.
 * This supplies it, with two implementations and one rule for choosing:
 *
 *   REMOTE  the gateway's worker pool (`/api/lab/studies`). Chosen whenever
 *           it answers, because a sweep is dozens of studies and the browser
 *           thread is also drawing the chart.
 *   LOCAL   the same engine in this tab, one study at a time, yielding a
 *           frame between them so the progress line can paint.
 *
 * MEASURED (v60, eight cores, 25 shipped specs, client-supplied bars):
 *
 *     bars    remote wall   serial sum   speed-up
 *     2,000   3.18 s        15.7 s       4.9x
 *     5,000   5.75 s        26.0 s       4.5x
 *
 * and the gap that shapes this file: one spec study is ~47 ms in-process and
 * ~384 ms through a worker, because spawning Node and warming V8 costs about
 * seven times the study. So REMOTE wins on a field of eighty and LOSES on a
 * field of three — `preferRemote` exists for callers who know they have a
 * handful, and the threshold is stated rather than hidden.
 *
 * THE BATCH CAP IS 64 (`LAB_BATCH_MAX`) and a full field is larger, so the
 * field is chunked. Each chunk is its own job: a cancel cancels the chunk in
 * flight and the rest are never submitted.
 */

import { LAB_BATCH_MAX, labCapacity, runLabJob, type LabStudyRequest } from "../data/lab";
import { runSpecStudy } from "./lab";
import { scheduleFrame } from "../core/frame";
import type { BarView } from "../chart/series";
import type { AutoRunDeps, Entrant, RunProgress, StudyOutcome } from "./autorun";
import type { StudyOptions } from "./lab";

export interface RunnerOptions {
  /** Bars to study. Sent to the gateway, or used in this tab. */
  readonly bars: readonly BarView[];
  readonly opts?: StudyOptions;
  /** Below this many entrants, the worker start-up costs more than it saves. */
  readonly remoteFloor?: number;
  readonly signal?: AbortSignal;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

/** Fields below this, run here: see the timings in the header. */
export const REMOTE_FLOOR = 8;

const idOf = (subject: string): string => (subject.startsWith("spec:") ? subject.slice(5) : subject.startsWith("family:") ? subject.slice(7) : subject);

/** Split a field into batches the gateway will accept. */
export function chunk<T>(items: readonly T[], size = LAB_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Study every entrant in this tab, one at a time.
 *
 * Yields a frame between studies. `runSpecStudy` is synchronous and a 5,000-bar
 * spec study is ~80 ms, so without the yield a field of eighty freezes the tab
 * for six seconds and the progress line never repaints — the same reason
 * `ui/strategy.ts` yields twice before a run.
 */
export async function runLocally(
  entrants: readonly Entrant[],
  bars: readonly BarView[],
  onProgress: (p: RunProgress) => void,
  opts?: StudyOptions,
  signal?: AbortSignal,
): Promise<StudyOutcome[]> {
  const out: StudyOutcome[] = [];
  let done = 0;
  for (const entrant of entrants) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => scheduleFrame(() => resolve()));
    try {
      out.push({ id: entrant.spec.id, study: runSpecStudy(entrant.spec, bars, opts ?? {}) });
    } catch (err) {
      out.push({ id: entrant.spec.id, study: null, error: err instanceof Error ? err.message : String(err) });
    }
    done += 1;
    onProgress({ done, total: entrants.length, last: entrant.spec.name });
  }
  return out;
}

/**
 * The runner `autoRun` wants.
 *
 * Remote when the gateway answers and the field is worth shipping; otherwise
 * local. A remote chunk that fails as a whole does not lose its entrants: each
 * comes back with the job's error, so the search still charges for the arms it
 * attempted and the report can say what went wrong.
 */
export function createStudyRunner(options: RunnerOptions): AutoRunDeps["runStudies"] {
  return async (entrants, onProgress) => {
    const floor = options.remoteFloor ?? REMOTE_FLOOR;
    const capacity = entrants.length >= floor ? await labCapacity(options.fetchImpl ?? fetch) : { ok: false, workers: 0, cores: 0, hint: "small field — studied in this tab" };
    if (!capacity.ok) {
      return runLocally(entrants, options.bars, onProgress, options.opts, options.signal);
    }

    const byId = new Map(entrants.map((e) => [e.spec.id, e]));
    const results = new Map<string, StudyOutcome>();
    let done = 0;

    for (const batch of chunk(entrants)) {
      if (options.signal?.aborted) break;
      const studies: LabStudyRequest[] = batch.map((e) => ({
        subject: { kind: "spec", id: e.spec.id, spec: e.spec },
        bars: options.bars,
        ...(options.opts ? { opts: options.opts } : {}),
      }));
      const progress = await runLabJob(studies, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onProgress: (p) => {
          /* `done` counts the whole field, not the chunk. */
          onProgress({ done: done + p.done, total: entrants.length, last: p.studies.at(-1)?.label ?? "" });
        },
      });
      for (const s of progress.studies) {
        const id = idOf(s.subject);
        results.set(id, s.ok && s.study ? { id, study: s.study } : { id, study: null, error: s.error || "the study failed and gave no reason" });
      }
      /*
       * A JOB THAT NEVER RAN IS NOT A FIELD THAT FAILED.
       *
       * MEASURED: a gateway process older than the spec support answered 422
       * to the submit, and all 85 rules came back "could not be studied" —
       * `labCapacity` had said yes, so nothing fell back and a whole sweep was
       * lost to a stale server. The distinction that matters is whether the
       * studies RAN: nothing reported means nothing ran, so run them here
       * instead. Per-study failures are left exactly as the gateway reported
       * them, because those arms were really attempted.
       */
      if (!progress.ok && progress.studies.length === 0 && !options.signal?.aborted) {
        const local = await runLocally(batch, options.bars, (p) => onProgress({ done: done + p.done, total: entrants.length, last: p.last }), options.opts, options.signal);
        for (const out of local) results.set(out.id, out);
      } else if (!progress.ok) {
        for (const e of batch) {
          if (!results.has(e.spec.id)) results.set(e.spec.id, { id: e.spec.id, study: null, error: progress.error || `the sweep ${progress.state}` });
        }
      }
      done += batch.length;
      onProgress({ done: Math.min(done, entrants.length), total: entrants.length, last: batch.at(-1)?.spec.name ?? "" });
    }

    /* Anything the gateway never answered for is still an arm of the search. */
    for (const e of entrants) {
      if (!results.has(e.spec.id)) {
        results.set(e.spec.id, { id: e.spec.id, study: null, error: options.signal?.aborted ? "the sweep was cancelled before this rule ran" : "the sweep returned no answer for this rule" });
      }
    }
    return [...byId.keys()].map((id) => results.get(id) as StudyOutcome);
  };
}
