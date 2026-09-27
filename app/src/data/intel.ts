/**
 * The model layer — regime and forecast, from the Python service.
 *
 * WHY THESE LIVE ON A SERVER AND NOT IN THE BROWSER
 * `mishel_hmm.py` fits a Gaussian mixture and `mishel_ml.py` trains a gradient
 * boosting classifier under walk-forward splits. Both are scikit-learn, both
 * are genuinely iterative, and neither belongs on the thread that paints the
 * chart. They have existed and been correct for versions; what they have never
 * had is a way into the terminal, which is the only reason this file exists.
 *
 * WHAT THEY ARE ALLOWED TO CLAIM
 * The regime model is a 3-state GMM over (return, rolling volatility), and it
 * says so — it is labelled "HMM-lite" in its own source rather than sold as a
 * hidden Markov model. The classifier reports its measured out-of-sample
 * accuracy and Brier score, and 53% is reported as 53%. A model that cannot
 * beat a coin flip must be allowed to say so; dressing it up is how a terminal
 * becomes a slot machine with a chart on it.
 *
 * OFFLINE IS A STATE, NOT AN ERROR
 * The service is optional. When it is not running the panel says exactly that,
 * in one line, and nothing else on the terminal changes. Nothing here is ever
 * approximated in the browser to fill the gap.
 */

import { governor } from "./net";
import type { BarView } from "../chart/series";
import { serviceBase } from "./backend";

const DEFAULT_BASE = (): string => serviceBase();

export interface RegimeRead {
  ok: true;
  /**
   * e.g. "Drifting up", "Sideways", "High volatility" — named from measured
   * means, with a direction only where the drift clears its own standard
   * error. Payloads cached before v53 carry the older "TREND-UP" /
   * "CHOP/TREND-DN" / "PANIC/high-vol" names; `core/decision.ts` still reads
   * those rather than silently dropping the evidence.
   */
  state: string;
  confidence: number;
  /** Count of each state across the last 48 bars. */
  last48: Record<string, number>;
  n: number;
  note: string;
}

export interface ForecastRead {
  ok: true;
  /** Probability the horizon return is positive. */
  pUp: number;
  /** Mean out-of-sample accuracy across the walk-forward folds. */
  accuracy: number;
  /** Mean Brier score. Lower is better; 0.25 is the score of always saying 50%. */
  brier: number;
  n: number;
  horizon: number;
}

export type IntelResult<T> = T | { ok: false; error: string };

export interface IntelService {
  regime(bars: readonly BarView[], signal?: AbortSignal): Promise<IntelResult<RegimeRead>>;
  forecast(
    bars: readonly BarView[],
    horizon: number,
    signal?: AbortSignal,
  ): Promise<IntelResult<ForecastRead>>;
}

async function post(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // A POST is never cached and never shared with another in-flight caller —
  // `unique` says so explicitly rather than relying on the method check.
  // It still spends from the local-service budget, so a stuck panel retrying
  // cannot starve the chart of its own proxy requests.
  const res = await governor.request({
    url,
    priority: "interactive",
    unique: true,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`service responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A number from an untrusted payload, or the stated fallback.
 *
 * `Number(null)` is 0 and `Number("")` is 0, so a plain `Number()` turns a
 * MISSING accuracy into a claim that the model got everything wrong. Absent
 * values must reach the fallback, not be coerced into a confident zero.
 */
const numOf = (v: unknown, fallback = 0): number => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Turn a thrown fetch into the one sentence a user can act on.
 *
 * "Failed to fetch" is what the browser says whether the service is stopped,
 * the port is wrong, or a firewall ate it. Naming the likely cause and the fix
 * is the difference between a dead panel and a panel that tells you what to do.
 */
function explain(err: unknown, base: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return `the analysis service is not running at ${base} — start everything with "python run.py"`;
  }
  return msg;
}

export function createIntel(base = DEFAULT_BASE()): IntelService {
  return {
    async regime(bars, signal) {
      // Below this the mixture has nothing to separate and would return three
      // labels for what is really one state.
      if (bars.length < 200) {
        return { ok: false, error: `${bars.length} bars — the regime model needs at least 200` };
      }
      try {
        const raw = await post(
          `${base}/svc/ml/regime`,
          { closes: Array.from(bars, (b) => b.c) },
          signal,
        );
        if (raw["ok"] !== true) {
          return { ok: false, error: String(raw["err"] ?? "the regime model declined to answer") };
        }
        return {
          ok: true,
          state: String(raw["state"] ?? "unknown"),
          confidence: numOf(raw["confidence"]),
          last48: (raw["last48"] as Record<string, number>) ?? {},
          n: numOf(raw["n"]),
          note: String(raw["note"] ?? ""),
        };
      } catch (err) {
        return { ok: false, error: explain(err, base) };
      }
    },

    async forecast(bars, horizon, signal) {
      // The Python side raises below 300; saying so here saves a round trip and
      // gives the same message whether or not the service is up.
      if (bars.length < 300) {
        return { ok: false, error: `${bars.length} bars — the classifier needs at least 300` };
      }
      try {
        const raw = await post(
          `${base}/svc/ml/predict`,
          {
            closes: Array.from(bars, (b) => b.c),
            highs: Array.from(bars, (b) => b.h),
            lows: Array.from(bars, (b) => b.l),
            vols: Array.from(bars, (b) => b.v),
            horizon,
          },
          signal,
        );
        if (raw["ok"] !== true) {
          return { ok: false, error: String(raw["err"] ?? "the classifier declined to answer") };
        }
        return {
          ok: true,
          pUp: numOf(raw["p_up"], 0.5),
          accuracy: numOf(raw["acc"], 0.5),
          brier: numOf(raw["brier"], 0.25),
          n: numOf(raw["n"]),
          horizon: numOf(raw["horizon"], horizon),
        };
      } catch (err) {
        return { ok: false, error: explain(err, base) };
      }
    },
  };
}

/**
 * What a forecast is allowed to be used for, in one sentence.
 *
 * The gate is the same one the strategy lab applies: a number that cannot beat
 * a coin flip is not a signal, and the honest thing is to say so ON the number
 * rather than in a footnote nobody reads. 0.25 is the Brier score of always
 * predicting 50%, so anything at or above it is worse than saying "I do not
 * know" — regardless of how the accuracy looks.
 */
export function forecastStanding(f: ForecastRead): { usable: boolean; why: string } {
  if (f.brier >= 0.25) {
    return {
      usable: false,
      why: `Brier ${f.brier.toFixed(3)} is at or worse than always saying 50%. This model is not calibrated; ignore the probability.`,
    };
  }
  if (f.accuracy < 0.53) {
    return {
      usable: false,
      why: `${(f.accuracy * 100).toFixed(1)}% out-of-sample accuracy over ${f.n} samples is inside the noise. Not an edge.`,
    };
  }
  return {
    usable: true,
    why: `${(f.accuracy * 100).toFixed(1)}% out-of-sample accuracy, Brier ${f.brier.toFixed(3)} across ${f.n} samples — better than a coin flip, which is a long way short of a reason to size up.`,
  };
}
