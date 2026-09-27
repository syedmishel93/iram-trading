/**
 * Client for the quant service — `server/quant`, port 8789.
 *
 * WHY THE TERMINAL SENDS ITS BARS RATHER THAN THE SERVICE FETCHING THEM
 * Because the terminal's bars are the ones on screen. They came from a
 * provider it chose, went through its gap checks, and may be a replay slice
 * rather than live. A service that re-fetched would answer a question about a
 * different series, and the first time the two disagreed nobody could tell
 * which was right.
 *
 * WHY EVERY RESULT IS A DISCRIMINATED UNION AND NOT A NULLABLE VALUE
 * There are three outcomes and they are not interchangeable:
 *
 *   ok        — a number, with the basis it rests on
 *   refused   — a REASON. "Ninety bars is not enough to fit a GARCH model" is
 *               a finding and belongs on screen, verbatim.
 *   offline   — the service is not running. Nothing is known either way.
 *
 * Collapsing "refused" into "offline" would let a real answer look like a
 * connection problem, and collapsing either into `null` would let both look
 * like a zero. The service returns refusals as HTTP 200 for the same reason.
 *
 * NOTHING HERE IS ON A HOT PATH
 * Every call is user-initiated and takes seconds to a minute. There is no
 * polling, no call on symbol change, and no automatic refresh — a GARCH fit
 * that ran itself every time you clicked a different chart would make the
 * terminal unusable and tell you nothing you asked for.
 */

import { signal, type Signal } from "../core/signal";
import type { BarView } from "../chart/series";
import { quantBase } from "./backend";

/**
 * The full URL for one quant endpoint.
 *
 * A FUNCTION THAT JOINS THE PATH, NOT A BASE TO INTERPOLATE - and the shape is
 * the fix, not decoration. What stood here was
 *
 *     export const QUANT_BASE = (): string => quantBase();
 *
 * read as `fetch(`${QUANT_BASE}/quant/health`)`. A template literal stringifies
 * a FUNCTION BY ITS SOURCE, so every request this module made went to the
 * literal path `() => quantBase()/quant/health`, which the gateway answered -
 * correctly - with 404. MEASURED in the shipped bundle: `el=()=>kf()`, and the
 * resolved request was
 * `http://127.0.0.1:8787/()%20=%3E%20kf()/quant/health` -> 404. The whole Quant
 * desk reported "the quant service is not running" against a service that was
 * up, healthy, and answering `/quant/health` with every library present.
 *
 * WHY NOTHING CAUGHT IT
 * `tsc` cannot: interpolating a function into a template is legal TypeScript.
 * The one test that touched the address compared the broken string to itself -
 * `expect(r.reason).toContain(QUANT_BASE)`, where the reason had been built by
 * the same interpolation - so it passed on a bug it was reading twice. A test
 * whose expected value comes from the code under test cannot fail.
 *
 * Joining the path here leaves no bare base in the module to interpolate, so
 * the mistake has nowhere to come back. The test that holds it down asserts the
 * URL `fetch` was actually called with.
 */
export function quantUrl(path: string): string {
  return `${quantBase()}${path}`;
}

/** The service is slow by nature. This is a ceiling, not an expectation. */
export const QUANT_TIMEOUT_MS = 180_000;

export type QuantResult<T> =
  | { readonly state: "ok"; readonly value: T; readonly ms: number }
  /** The service ran and declined to answer. `reason` is for the operator. */
  | { readonly state: "refused"; readonly reason: string }
  /** The service could not be reached, or crashed. Nothing is known. */
  | { readonly state: "offline"; readonly reason: string };

/** Which libraries the service has, and what each missing one costs. */
export interface QuantHealth {
  readonly service: string;
  readonly python: string;
  readonly present: Readonly<Record<string, string>>;
  readonly missing: Readonly<Record<string, string>>;
  readonly degraded: readonly string[];
}

interface Envelope {
  ok?: boolean;
  reason?: string;
  ms?: number;
  [k: string]: unknown;
}

/**
 * One request.
 *
 * Aborts on a timeout rather than hanging: a fetch with no abort leaves a
 * pending promise and a spinner forever if the service is wedged, and the
 * operator has no way to tell that from a slow model.
 */
async function post<T>(path: string, body: unknown): Promise<QuantResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUANT_TIMEOUT_MS);
  try {
    const res = await fetch(quantUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { state: "offline", reason: `The service answered HTTP ${res.status}.` };
    }
    const json = (await res.json()) as Envelope;
    if (json.ok === false) {
      return {
        state: "refused",
        reason: json.reason ?? "The service declined without giving a reason.",
      };
    }
    return { state: "ok", value: json as unknown as T, ms: json.ms ?? 0 };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      state: "offline",
      reason: aborted
        ? `No answer within ${Math.round(QUANT_TIMEOUT_MS / 1000)}s. The model may still be running.`
        : `The quant service is not reachable at ${quantBase()}. Start the terminal with: python run.py`,
    };
  } finally {
    /* Without this the abort still fires three minutes after a request that
       already succeeded. Harmless on its own controller, but it keeps a timer
       alive per call and the leak is invisible until the tab has been open a
       while. */
    clearTimeout(timer);
  }
}

/**
 * Bars, trimmed to what the models can actually use.
 *
 * A GARCH walk-forward over 20,000 bars takes minutes and answers a question
 * about 2019. Every model here is fitted on recent structure, so sending the
 * whole archive costs time and buys a worse answer — the parameters are
 * averaged over regimes that no longer exist.
 */
export const MAX_BARS = 5000;

export function trimBars(bars: readonly BarView[], max = MAX_BARS): BarView[] {
  return bars.length <= max ? [...bars] : bars.slice(bars.length - max);
}

export async function quantHealth(): Promise<QuantResult<QuantHealth>> {
  const controller = new AbortController();
  /* The health check gets a short timeout of its own. Its whole job is to
     answer "is the service there", and waiting three minutes to find out it is
     not defeats the purpose. */
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(quantUrl("/quant/health"), { signal: controller.signal });
    if (!res.ok) return { state: "offline", reason: `HTTP ${res.status}` };
    return { state: "ok", value: (await res.json()) as QuantHealth, ms: 0 };
  } catch {
    return {
      state: "offline",
      /* The ONE launcher. `python -m quant.app` on its own serves the model service
         on its own port, which this page does not address (CLAUDE.md, "Nine
         launchers"): the old remedy was a route into that bug. */
      reason: `Not running. Start the terminal with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Result shapes. These mirror the service and are deliberately partial: the
// service returns more than the UI shows, and a type that enumerated every
// field would break every time a model gained a diagnostic.
// ---------------------------------------------------------------------------

export interface VolatilityResult {
  readonly n_returns: number;
  readonly winner: string;
  readonly verdict: string;
  readonly margin_pct?: number;
  readonly baseline: { readonly name: string; readonly qlike: number };
  readonly models: Readonly<
    Record<
      string,
      {
        ok?: boolean;
        reason?: string;
        qlike?: number;
        persistence?: number;
        sigma_next_bar?: number;
        sigma_horizon?: number;
        annual_vol?: number;
        beats_ewma?: boolean;
        scored_bars?: number;
      }
    >
  >;
  readonly leverage?: {
    readonly gamma: number;
    readonly p_value: number;
    readonly asymmetric: boolean;
    readonly note: string;
  };
  readonly basis: string;
}

export interface StructureResult {
  readonly n_bars: number;
  readonly call: "stationary" | "unit-root" | "conflicted" | "inconclusive";
  readonly note: string;
  readonly adf: { readonly stat: number; readonly p_value: number };
  readonly kpss: { readonly stat: number; readonly p_value: number };
  readonly variance_ratio: Readonly<Record<string, number>>;
  readonly vr_note: string;
  readonly basis: string;
}

export interface EdgeResult {
  readonly n_trades: number;
  readonly mean: number;
  readonly t_stat: number;
  readonly p_value: number;
  readonly significant: boolean;
  readonly se_naive: number;
  readonly se_hac: number;
  readonly inflation: number | null;
  readonly independence: { readonly ljung_box_p: number; readonly independent: boolean; readonly note: string };
  readonly verdict: string;
  readonly caveat: string;
  readonly basis: string;
}

export interface ClassifyResult {
  readonly n_bars: number;
  readonly n_labelled: number;
  readonly base_rate: number;
  readonly folds: number;
  readonly horizon: number;
  readonly barrier_atr: number;
  readonly best: string;
  readonly models: Readonly<
    Record<
      string,
      {
        ok?: boolean;
        reason?: string;
        auc?: number;
        auc_floor?: number;
        beats_coin?: boolean;
        brier?: number;
        skill?: number;
        mean_miscalibration?: number;
        n_scored?: number;
        calibration?: readonly { predicted: number; actual: number; n: number }[];
      }
    >
  >;
  readonly agreement?: { readonly mean_spread: number; readonly note: string } | null;
  readonly importance?: readonly { readonly feature: string; readonly weight: number }[] | null;
  readonly verdict: string;
  readonly caveat: string;
  readonly basis: string;
}

export interface SeasonalityResult {
  readonly n_bars: number;
  readonly busiest_hour_utc?: number;
  readonly quietest_hour_utc?: number;
  readonly hour_of_day?: readonly { readonly hour: number; readonly effect: number }[];
  readonly day_of_week?: readonly { readonly day: string; readonly effect: number }[];
  readonly busiest_day?: string;
  readonly quietest_day?: string;
  readonly intraday_note?: string;
  readonly weekly_note?: string;
  readonly explained_variance: number;
  readonly strength: string;
  readonly verdict: string;
  readonly basis: string;
}

export interface CausalResult {
  readonly n_trades: number;
  readonly n_treated: number;
  readonly n_control: number;
  readonly confounders: readonly string[];
  readonly naive: { readonly difference: number; readonly p_value: number; readonly note: string };
  readonly dowhy: {
    ok?: boolean;
    reason?: string;
    adjusted_effect?: number;
    survives_refutation?: boolean;
    refutations?: Readonly<Record<string, { new_effect?: number; passed?: boolean; error?: string }>>;
  };
  readonly econml: {
    ok?: boolean;
    reason?: string;
    ate?: number;
    ci_low?: number;
    ci_high?: number;
    significant?: boolean;
    heterogeneous?: boolean;
  };
  readonly causalml: { ok?: boolean; reason?: string; ate?: number; agrees_with_econml?: boolean | null };
  readonly verdict: string;
  readonly assumption: string;
}

export interface KellyResult {
  readonly n_trades: number;
  readonly mean_r: number;
  readonly full_kelly: number;
  readonly full_kelly_drawdown: number;
  readonly recommended: number;
  readonly recommended_as_kelly_fraction: number | null;
  readonly recommended_drawdown: number | null;
  readonly verdict: string;
  readonly caveat: string;
}

/** A bar array, trimmed, as every bar-taking endpoint wants it. */
const withBars = (bars: readonly BarView[], extra: Record<string, unknown> = {}): unknown => ({
  bars: trimBars(bars),
  ...extra,
});

/** What `/quant/crossasset/train` answers with. */
export interface CrossAssetResult {
  readonly symbol: string;
  readonly timeframe: string;
  readonly horizon: number;
  readonly rows_scored: number;
  readonly folds: number;
  readonly base_rate: number;
  readonly drivers: readonly string[];
  readonly baseline: { readonly auc: number; readonly se: number };
  readonly full: { readonly auc: number; readonly se: number };
  readonly delta_auc: number;
  readonly delta_sigmas: number;
  readonly adds_information: boolean;
  readonly contributions: readonly { readonly column: string; readonly coef: number }[];
  readonly verdict: string;
  readonly notes: readonly string[];
}

/** One series a custom script produced. */
export interface ScriptSeries {
  readonly name: string;
  /** Null is a gap — a warm-up NaN, drawn as a break rather than as zero. */
  readonly values: readonly (number | null)[];
  readonly finite: number;
  readonly min: number;
  readonly max: number;
}

export interface ScriptResult {
  readonly bars: number;
  readonly series: readonly ScriptSeries[];
  readonly stdout: string;
  readonly notes: readonly string[];
}

export const quant = {
  volatility: (bars: readonly BarView[], horizon = 1) =>
    post<VolatilityResult>("/quant/volatility", withBars(bars, { horizon })),

  structure: (bars: readonly BarView[]) =>
    post<StructureResult>("/quant/stats/structure", withBars(bars)),

  leadlag: (bars: readonly BarView[], other: readonly BarView[]) =>
    post<Record<string, unknown>>("/quant/stats/leadlag", withBars(bars, { other: trimBars(other) })),

  edge: (returns: readonly number[]) => post<EdgeResult>("/quant/stats/edge", { returns }),

  classify: (bars: readonly BarView[], horizon = 24, barrierAtr = 1.5) =>
    post<ClassifyResult>("/quant/ml/classify", withBars(bars, { horizon, barrier_atr: barrierAtr })),

  race: (bars: readonly BarView[], horizon = 1) =>
    post<Record<string, unknown>>("/quant/forecast/race", withBars(bars, { horizon })),

  seasonality: (bars: readonly BarView[]) =>
    post<SeasonalityResult>("/quant/forecast/seasonality", withBars(bars)),

  causal: (trades: readonly unknown[], confounders?: readonly string[]) =>
    post<CausalResult>("/quant/causal/effect", {
      trades,
      ...(confounders ? { confounders } : {}),
    }),

  kelly: (returns: readonly number[], maxDrawdown = 0.2) =>
    post<KellyResult>("/quant/kelly", { returns, max_drawdown: maxDrawdown }),

  portfolio: (assets: readonly { symbol: string; bars: readonly BarView[] }[], opts: Record<string, unknown> = {}) =>
    post<Record<string, unknown>>("/quant/portfolio", {
      assets: assets.map((a) => ({ symbol: a.symbol, bars: trimBars(a.bars, 2000) })),
      ...opts,
    }),

  factors: (assets: readonly { symbol: string; bars: readonly BarView[] }[]) =>
    post<Record<string, unknown>>("/quant/panel/factors", {
      assets: assets.map((a) => ({ symbol: a.symbol, bars: trimBars(a.bars, 2000) })),
    }),

  /**
   * Does knowing what the drivers just did tell you anything about this
   * instrument's next move, over and above its own return?
   *
   * Takes the payload `panelPayload` produces — the alignment is done in the
   * browser, in `data/panel.ts`, because that is where the look-ahead would
   * get in and it is the one place that join happens.
   */
  /**
   * Run a Python snippet against these bars and get its series back.
   *
   * OFF unless the service was started with IRAM_QUANT_SCRIPTS=1. The refusal
   * says so and says why, because "unrestricted code in the service's process"
   * is a decision the operator has to make deliberately rather than discover.
   */
  script: (bars: readonly BarView[], code: string) =>
    post<ScriptResult>("/quant/script/run", withBars(bars, { code })),

  crossAsset: (payload: unknown) =>
    post<CrossAssetResult>("/quant/crossasset/train", payload),

  revealed: (opportunities: readonly unknown[], attributes: readonly string[]) =>
    post<Record<string, unknown>>("/quant/choice/revealed", { opportunities, attributes }),
};

/**
 * A signal holding one endpoint's latest result, plus whether it is running.
 *
 * Every panel needs the same three things — the result, a busy flag, and a way
 * to fire the call — and writing that by hand per panel is how one of them ends
 * up unable to show a refusal.
 */
export interface QuantSlot<T> {
  readonly result: Signal<QuantResult<T> | null>;
  readonly busy: Signal<boolean>;
  run(fn: () => Promise<QuantResult<T>>): void;
  clear(): void;
}

export function quantSlot<T>(): QuantSlot<T> {
  const result = signal<QuantResult<T> | null>(null);
  const busy = signal(false);
  /* Guards against a second click while the first is in flight. Without it two
     overlapping GARCH fits race and the SLOWER one wins, so the panel shows the
     answer to the older question. */
  let inflight = 0;

  return {
    result,
    busy,
    run(fn) {
      if (busy()) return;
      const ticket = ++inflight;
      busy.set(true);
      void fn()
        .then((r) => {
          if (ticket === inflight) result.set(r);
        })
        /**
         * A REJECTION IS A RESULT, AND WITHOUT THIS IT WAS NOTHING AT ALL.
         *
         * Every `fn` here is an async closure, and several of them do real
         * work before the fetch — awaiting driver loads, building a panel,
         * diagnosing it. Any of that can throw. With only `then`/`finally` the
         * rejection skipped straight past the result, cleared `busy`, and
         * surfaced as an unhandled promise rejection in the console: the panel
         * went back to reading "Not run yet." after a click that had, in fact,
         * run and failed. The one state an operator cannot recover from is the
         * one that looks identical to never having tried.
         *
         * `refused` rather than `offline`: the service is not implicated. The
         * message is whatever threw, which is the closest thing to the reason
         * that exists.
         */
        .catch((err: unknown) => {
          if (ticket !== inflight) return;
          result.set({
            state: "refused",
            reason: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (ticket === inflight) busy.set(false);
        });
    },
    clear() {
      result.set(null);
    },
  };
}

/** Human-readable one-liner for any result state, for a panel's status row. */
export function quantLine<T>(r: QuantResult<T> | null, busyNow: boolean): string {
  if (busyNow) return "Running — this can take up to a minute.";
  if (r === null) return "Not run yet.";
  if (r.state === "offline") return r.reason;
  if (r.state === "refused") return r.reason;
  return `Answered in ${(r.ms / 1000).toFixed(1)}s.`;
}
