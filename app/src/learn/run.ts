/**
 * A model run, kept.
 *
 * WHAT WAS HAPPENING BEFORE
 * `server/quant` fits five classifiers with purged walk-forward cross-
 * validation, scores them against a sample-size-aware significance floor, and
 * returns a verdict. Then the terminal rendered it into a panel and threw it
 * away. Close the panel and the result is gone; run it again next week and
 * there is nothing to compare against. Its own header says it plainly — "the
 * service holds no state" — which is correct for the service and left the
 * terminal with no memory at all.
 *
 * The consequence is not that a number was lost. It is that the ONE question
 * worth asking of a model was unaskable:
 *
 *     Does it still say what it said last time?
 *
 * A model whose AUC was 0.58 in March and 0.51 in September has told you
 * something enormous, and neither number alone tells you any of it. Keeping
 * runs is what turns a fit into a series.
 *
 * WHAT IS KEPT AND WHAT IS NOT
 * The scores, the shape of the data they came from, and the verdict — a few
 * hundred bytes. Not the fitted model: these are refitted in seconds from bars
 * the terminal already holds, and a serialised booster in localStorage would
 * be a megabyte of weights that no part of this application can load. Storing
 * a model you cannot run is a museum, not a memory.
 */

/** Which endpoint produced it. Extend as the desk grows. */
export type RunKind = "classify" | "forecast" | "volatility" | "edge" | "crossasset" | "causal";

export interface ModelRun {
  readonly id: string;
  readonly at: number;
  readonly kind: RunKind;
  readonly symbol: string;
  readonly timeframe: string;
  /** How many bars went in. The first thing that explains a moved score. */
  readonly bars: number;
  /** Epoch ms of the first and last bar fitted, so two runs are comparable. */
  readonly fromBar: number | null;
  readonly toBar: number | null;

  /**
   * The headline score, whatever this kind's headline score is.
   *
   * Named `metric` rather than `auc` because a volatility run has no AUC and
   * forcing one would either lie or leave a hole. `metricName` travels with it
   * so a stored run from a future kind still renders truthfully.
   */
  readonly metric: number | null;
  readonly metricName: string;
  /**
   * Did it clear its own significance floor?
   *
   * Null when the kind has no such notion. Never defaulted to false: "this
   * model did not beat chance" and "nobody asked whether it did" are different
   * findings, and the second must not be rendered as the first.
   */
  readonly beatsChance: boolean | null;
  /** The service's own sentence. Kept verbatim — it is better than a re-word. */
  readonly verdict: string;
  /** Best model name, for kinds that race several. */
  readonly best: string | null;
  /** Top features and weights, when the kind reports them. */
  readonly drivers: readonly { readonly name: string; readonly weight: number }[];
  /** Pinned runs survive the cap and the "forget everything" sweep. */
  readonly pinned: boolean;
  /** Whatever the operator wants to remember about why they ran it. */
  readonly note: string;
}

let counter = 0;

export function makeRunId(at: number): string {
  counter = (counter + 1) % 100000;
  return `m${at.toString(36)}-${counter.toString(36)}`;
}

export interface RunDraft {
  readonly kind: RunKind;
  readonly symbol: string;
  readonly timeframe: string;
  readonly bars: number;
  readonly fromBar?: number | null;
  readonly toBar?: number | null;
  readonly metric?: number | null;
  readonly metricName: string;
  readonly beatsChance?: boolean | null;
  readonly verdict: string;
  readonly best?: string | null;
  readonly drivers?: readonly { readonly name: string; readonly weight: number }[];
  readonly note?: string;
}

export function buildRun(draft: RunDraft, at: number): ModelRun {
  return {
    id: makeRunId(at),
    at,
    kind: draft.kind,
    symbol: draft.symbol.toUpperCase(),
    timeframe: draft.timeframe,
    bars: Math.max(0, Math.round(draft.bars)),
    fromBar: draft.fromBar ?? null,
    toBar: draft.toBar ?? null,
    metric: typeof draft.metric === "number" && Number.isFinite(draft.metric) ? draft.metric : null,
    metricName: draft.metricName,
    beatsChance: draft.beatsChance ?? null,
    verdict: draft.verdict,
    best: draft.best ?? null,
    drivers: (draft.drivers ?? []).slice(0, 8).map((d) => ({ name: d.name, weight: d.weight })),
    pinned: false,
    note: draft.note ?? "",
  };
}

export function sanitiseRun(raw: unknown): ModelRun | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : null);
  const num = (k: string): number | null => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : null);

  const id = str("id");
  const at = num("at");
  const kind = o["kind"];
  const symbol = str("symbol");
  if (id === null || at === null || symbol === null || typeof kind !== "string") return null;

  const drivers = Array.isArray(o["drivers"])
    ? (o["drivers"] as unknown[])
        .map((d) => {
          if (d === null || typeof d !== "object") return null;
          const dd = d as Record<string, unknown>;
          const name = typeof dd["name"] === "string" ? dd["name"] : null;
          const weight = typeof dd["weight"] === "number" && Number.isFinite(dd["weight"]) ? dd["weight"] : null;
          return name !== null && weight !== null ? { name, weight } : null;
        })
        .filter((d): d is { name: string; weight: number } => d !== null)
        .slice(0, 8)
    : [];

  return {
    id,
    at,
    kind: kind as RunKind,
    symbol: symbol.toUpperCase(),
    timeframe: str("timeframe") ?? "",
    bars: Math.max(0, Math.round(num("bars") ?? 0)),
    fromBar: num("fromBar"),
    toBar: num("toBar"),
    metric: num("metric"),
    metricName: str("metricName") ?? "score",
    beatsChance: typeof o["beatsChance"] === "boolean" ? (o["beatsChance"] as boolean) : null,
    verdict: str("verdict") ?? "",
    best: str("best"),
    drivers,
    pinned: o["pinned"] === true,
    note: typeof o["note"] === "string" ? (o["note"] as string) : "",
  };
}

/**
 * Metrics where a FALL is an improvement.
 *
 * QLIKE and Brier are losses: the volatility model that scores lower is the
 * better one. Every other score on this desk is the other way round, and a
 * drift line that read every fall as a deterioration would report an improving
 * volatility model as a decaying one — confidently, in a sentence, with a red
 * number beside it.
 *
 * Keyed on the metric NAME rather than the run kind, because the name is what
 * travels with the number: a kind that switches metric later would otherwise
 * keep the old direction and be silently backwards.
 */
const LOWER_IS_BETTER = new Set(["QLIKE", "Brier", "brier", "qlike", "loss", "RMSE", "MAE"]);

export function lowerIsBetter(metricName: string): boolean {
  return LOWER_IS_BETTER.has(metricName);
}

export interface Drift {
  readonly kind: RunKind;
  readonly symbol: string;
  readonly timeframe: string;
  readonly runs: number;
  readonly first: ModelRun;
  readonly latest: ModelRun;
  /** latest − first, in the metric's own units. NaN when either is missing. */
  readonly change: number;
  /**
   * Whether the change is an improvement, in this metric's own direction.
   *
   * Null when there is no change to judge, or when the change is too small to
   * call either way. Separate from the sign of `change` precisely because for
   * some metrics they point opposite ways — see `LOWER_IS_BETTER`.
   */
  readonly better: boolean | null;
  readonly text: string;
}

/**
 * How a repeated fit has moved.
 *
 * The reason to keep runs at all. Grouped by (kind, symbol, timeframe) because
 * a score is only comparable to a score from the same question on the same
 * series — comparing an AUC on BTCUSDT 1h to one on EURUSD 4h is comparing two
 * unrelated experiments and would produce a drift number that means nothing.
 *
 * Groups with a single run are dropped: one point is not a trend, and showing
 * it as "0.00 change" would suggest stability that has not been observed.
 */
export function drift(runs: readonly ModelRun[]): readonly Drift[] {
  const groups = new Map<string, ModelRun[]>();
  for (const r of runs) {
    const key = `${r.kind}|${r.symbol}|${r.timeframe}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: Drift[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const first = sorted[0] as ModelRun;
    const latest = sorted[sorted.length - 1] as ModelRun;
    const change = first.metric !== null && latest.metric !== null ? latest.metric - first.metric : NaN;
    const flat = Number.isFinite(change) && Math.abs(change) < 0.01;
    const down = lowerIsBetter(latest.metricName);
    const better = !Number.isFinite(change) || flat ? null : down ? change < 0 : change > 0;

    const span = `across ${sorted.length} runs, ${first.metric?.toFixed(3)} to ${latest.metric?.toFixed(3)}`;
    const moved = Number.isFinite(change) ? `${change < 0 ? "fallen" : "risen"} ${Math.abs(change).toFixed(3)}` : "";

    let text: string;
    if (!Number.isFinite(change)) {
      text = `${sorted.length} runs, but not all of them reported a ${latest.metricName}, so there is nothing to compare.`;
    } else if (flat) {
      text = `${sorted.length} runs and the ${latest.metricName} has not moved (${latest.metric?.toFixed(3)}). Stable is a useful answer, not a missing one.`;
    } else if (better === false) {
      text = `The ${latest.metricName} has ${moved} ${span}${down ? " — and lower is better for this one" : ""}. Whatever it was fitting, it is fitting less well now.`;
    } else {
      text = `The ${latest.metricName} has ${moved} ${span}${down ? " — and lower is better for this one, so this is an improvement" : ""}. Worth checking whether the bar count moved too before reading anything into it.`;
    }

    out.push({ kind: latest.kind, symbol: latest.symbol, timeframe: latest.timeframe, runs: sorted.length, first, latest, change, better, text });
  }
  return out.sort((a, b) => b.latest.at - a.latest.at);
}
