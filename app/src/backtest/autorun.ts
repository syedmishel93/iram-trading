/**
 * The autonomous run: build the field, test it, judge it, keep what survived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES, IN ORDER
 *
 *   1. FIELD    every rule in `specs.ts`, plus hybrids composed from them
 *               (`hybrid.ts`). One list, deduped, capped, deterministic.
 *   2. TEST     each is studied on the operator's bars — walk-forward, PBO,
 *               real costs — by a runner passed in (see below).
 *   3. JUDGE    `search.ts` applies the existing promotion gate AND charges
 *               the result for the size of the search.
 *   4. KEEP     survivors become `discovered.ts` rows, unproven, with the
 *               provenance needed to read them again in six months.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE RUNNER IS INJECTED
 *
 * A study is CPU-bound and there are dozens of them. Where they run is a
 * deployment question with three answers in this repo — the browser thread,
 * the gateway's worker pool (`/api/lab/studies`), or Node in a test — and
 * every one of them gets the same engine (`server/engine/lab-engine.mjs` is
 * this repository's own lab, compiled). So this module takes a `runStudies`
 * function and stays pure, testable and free of any opinion about cores.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES
 *
 * It does not choose bars, fetch anything, arm anything or write to storage.
 * The caller owns all four. It returns a report and the rows it WOULD keep;
 * the desk decides what happens to them, because "the terminal saved a
 * strategy" is a thing the operator should be able to point at.
 */

import { SPECS } from "./specs";
import { buildConditioned, type ConditionedResult } from "./conditioned";
import { buildHybrids, DEFAULT_MAX_HYBRIDS, type HybridResult } from "./hybrid";
import { scoreSearch, type Candidate, type SearchResult } from "./search";
import type { Discovered } from "./discovered";
import type { RuleSpec } from "./rules";
import type { Costs } from "./engine";
import type { Study } from "./lab";

/** One rule to study, and where it came from. */
export interface Entrant {
  readonly spec: RuleSpec;
  readonly origin: "library" | "hybrid" | "conditioned";
}

export interface RunProgress {
  readonly done: number;
  readonly total: number;
  /** The rule just finished, for a progress line that is not a bare number. */
  readonly last: string;
}

export interface StudyOutcome {
  readonly id: string;
  /** Null when this rule could not be studied; `error` says why. */
  readonly study: Study | null;
  readonly error?: string;
}

export interface AutoRunDeps {
  /**
   * Study these rules and return one outcome each, in any order.
   *
   * A rule that cannot be studied comes back with `study: null` and a reason —
   * never dropped, because a field of 60 that silently becomes 40 changes the
   * hurdle without telling anyone.
   */
  readonly runStudies: (entrants: readonly Entrant[], onProgress: (p: RunProgress) => void) => Promise<readonly StudyOutcome[]>;
  readonly now?: () => number;
}

export interface AutoRunOptions {
  readonly symbol: string;
  readonly timeframe: string;
  /** Bars the studies were run over — recorded on every row it keeps. */
  readonly bars: number;
  readonly costs: Costs;
  readonly maxHybrids?: number;
  readonly maxConditioned?: number;
  /**
   * True only when the context series (DXY, yields, VIX) are loaded and
   * ALIGNED onto these bars. Conditioned arms are added only then.
   *
   * A conditioned arm whose column is NaN can never fire, so adding it would
   * widen the field and raise the hurdle for every real arm while contributing
   * nothing. Off by default: the caller has to have done the work.
   */
  readonly contextAvailable?: boolean;
  /** Rules to leave out (already retired by the operator, say). */
  readonly exclude?: readonly string[];
  readonly onProgress?: (p: RunProgress) => void;
  /**
   * Arms already spent on these bars — a previous run the operator is about
   * to compare against. Passed to `scoreSearch`, which charges for them.
   */
  readonly priorTrials?: number;
}

export interface AutoRunReport {
  readonly symbol: string;
  readonly timeframe: string;
  readonly at: number;
  /** What was entered, before anything was studied. */
  readonly entered: number;
  readonly hybrids: HybridResult & { readonly unbuilt: number };
  /** Rules that could not be studied at all, with the reason each. */
  readonly failed: readonly { readonly id: string; readonly why: string }[];
  readonly search: SearchResult;
  /** Survivors as shelf rows — unproven, with provenance. Not yet saved. */
  readonly keep: readonly Discovered[];
  readonly line: string;
}

/** The field: every library rule, then every hybrid, deduped and capped. */
export function buildField(opts: {
  readonly maxHybrids?: number;
  readonly maxConditioned?: number;
  /** True only when the context series are loaded and aligned. See below. */
  readonly contextAvailable?: boolean;
  readonly exclude?: readonly string[];
} = {}): {
  readonly entrants: readonly Entrant[];
  readonly hybrids: HybridResult & { readonly unbuilt: number };
  readonly conditioned: ConditionedResult;
} {
  const excluded = new Set(opts.exclude ?? []);
  const library = SPECS.filter((s) => !excluded.has(s.id));
  const hybrids = buildHybrids(library, { max: opts.maxHybrids ?? DEFAULT_MAX_HYBRIDS });
  /* CONDITIONED ARMS. Measured over 5 years and 821 trades per arm, the best
     unconditioned rule scored +0.070 against a hurdle of +0.102 — the library
     has no standalone edge, so the remaining question is whether one works in a
     particular STATE. Every arm added raises the hurdle for all of them, which
     is why `MACRO_STATES` is six and not sixty, and why each carries its prior.
     A state column with no context series loaded reads NaN, so the arm simply
     never fires rather than firing on a zero. */
  /* OFF UNLESS THE CONTEXT SERIES ARE ACTUALLY LOADED, and that is a safety
     property rather than a preference.

     A conditioned arm whose context column is NaN can never fire. Adding 150 of
     them would widen the field from ~85 to ~235 and RAISE the hurdle
     (`sqrt(2 ln N)/sqrt(n)`) for every real arm, while contributing nothing —
     the search would get strictly harder and no better. An inert capability
     that costs something is worse than one that costs nothing, and this
     codebase already records the shape: a comment describing a control is not
     a control, and `edge.push` had no caller for releases.

     So the caller must SAY the context is there. `autoRun` passes it through
     from whoever loaded the bars. */
  const conditioned = opts.contextAvailable
    ? buildConditioned(library, {
        ...(opts.maxConditioned === undefined ? {} : { max: opts.maxConditioned }),
        ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
      })
    : { specs: [], refused: [], capped: 0 };
  const entrants: Entrant[] = [
    ...library.map((spec): Entrant => ({ spec, origin: "library" })),
    ...hybrids.hybrids.filter((h) => !excluded.has(h.spec.id)).map((h): Entrant => ({ spec: h.spec, origin: "hybrid" })),
    ...conditioned.specs.map((spec): Entrant => ({ spec, origin: "conditioned" })),
  ];
  return { entrants, hybrids, conditioned };
}

export async function autoRun(opts: AutoRunOptions, deps: AutoRunDeps): Promise<AutoRunReport> {
  const now = deps.now ?? Date.now;
  const at = now();
  const { entrants, hybrids } = buildField({
    ...(opts.maxHybrids === undefined ? {} : { maxHybrids: opts.maxHybrids }),
    ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
    ...(opts.contextAvailable === undefined ? {} : { contextAvailable: opts.contextAvailable }),
  });
  const byId = new Map(entrants.map((e) => [e.spec.id, e]));

  const outcomes = await deps.runStudies(entrants, (p) => opts.onProgress?.(p));

  const candidates: Candidate[] = [];
  const failed: { id: string; why: string }[] = [];
  for (const out of outcomes) {
    const entrant = byId.get(out.id);
    if (!entrant) continue;
    if (out.study === null) {
      failed.push({ id: out.id, why: out.error ?? "the study did not run, and gave no reason" });
      continue;
    }
    candidates.push({ id: out.id, name: entrant.spec.name, origin: entrant.origin, study: out.study });
  }

  /* A rule that could not be studied was still an arm of the search: it was
     chosen, built and attempted. Charging for it keeps the hurdle honest when
     half the field fails on a short history. */
  const search = scoreSearch({
    candidates,
    priorTrials: Math.max(0, Math.floor(opts.priorTrials ?? 0)) + failed.length,
  });

  const keep: Discovered[] = search.survivors.flatMap((s) => {
    const entrant = byId.get(s.id);
    if (!entrant) return [];
    return [
      {
        spec: entrant.spec,
        origin: entrant.origin,
        foundAt: at,
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        bars: opts.bars,
        trials: search.trials,
        trades: s.trades,
        expectancy: s.expectancy,
        sharpe: s.sharpe,
        deflated: s.deflated.deflated,
        hurdle: s.deflated.hurdle,
        costs: opts.costs,
        status: "unproven" as const,
      },
    ];
  });

  const failedNote = failed.length > 0 ? ` ${failed.length} could not be studied on this history.` : "";
  return {
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    at,
    entered: entrants.length,
    hybrids,
    failed,
    search,
    keep,
    line: `${search.line}${failedNote}`,
  };
}
