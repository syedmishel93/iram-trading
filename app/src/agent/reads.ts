/**
 * What the expert's heavier tools hand back, shaped once.
 *
 * Pure functions over the terminal's own outputs — the Setup card's view, the
 * outlook simulation, the scanner's rows — so the payload the model reads is
 * tested with literals and cannot drift from the panel it restates. Nothing in
 * here computes a market figure: it selects, renames with units, and attaches
 * the basis (measured or modelled) the source module already declared.
 *
 * `ui/shell/terminalaccess.ts` is the only caller. It owns the live signals and
 * the network; this file owns the wording of what crosses to the analyst.
 */

import type { SetupView } from "../setup/ui";
import { planRMultiple } from "../setup/plan";
import { breakEven } from "../setup/simulate";
import type {
  Outlook,
  OutlookCalibration,
  Refused,
  TouchOdds,
  TradePlan as OutlookTradePlan,
} from "../analysis/outlook";
import type { ScanRow } from "../scan/scanner";

const r6 = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(8)) : 0);
const r4 = (v: number): number => (Number.isFinite(v) ? Number(v.toFixed(4)) : 0);

/* ------------------------------------------------------------------ setup */

export type SetupCall = "go" | "armed" | "conflict" | "stand-down" | "unknown" | "no-setup";

export type SetupRead =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly symbol: string;
      readonly timeframe: string;
      /** The Setup card's verdict kind, or `no-setup` when the engine chose none. */
      readonly call: SetupCall;
      readonly headline: string;
      readonly read_line: string;
      readonly strategy: string | null;
      readonly gates_passed: number;
      readonly gates_total: number;
      readonly blocking: readonly { readonly text: string; readonly clears: string | null }[];
      readonly unchecked: readonly { readonly text: string; readonly clears: string | null }[];
      readonly watch_level: number | null;
      readonly conflict_note: string | null;
      /**
       * Null when there is no plan, AND when a gate blocks: the Setup card hides
       * the entry, stop and size behind a block so they cannot be retyped by
       * hand, and the analyst is held to the same rule.
       */
      readonly plan: {
        readonly direction: "long" | "short";
        readonly entry: number;
        readonly entry_low: number;
        readonly entry_high: number;
        readonly stop: number;
        readonly target1: number;
        readonly target2: number;
        readonly reward_to_risk_t1: number;
        readonly break_even_hit_rate: number;
        readonly stop_from: string;
        readonly stop_atr_now: number;
      } | null;
      readonly plan_withheld: string;
      readonly plan_problem: string | null;
      readonly no_setup_reason: string;
      readonly waiting_for: string;
      readonly why_this_setup: string;
      readonly history: {
        readonly note: string;
        readonly instances: number;
        readonly hit_rate: number | null;
        readonly hit_rate_lower_bound: number | null;
        readonly break_even_hit_rate: number;
        readonly expectancy_r: number | null;
        readonly enough_to_characterise: boolean;
        readonly adverse: boolean;
        readonly basis: string;
      } | null;
      readonly size: { readonly qty: string; readonly risk_money: string; readonly risk_pct: string } | null;
      readonly basis: string;
    };

/**
 * The Setup card's own view, restated for the analyst.
 *
 * `view` is the card's `setupView` — the same object the card, the dock's
 * verdict banner and the journal read — so the three cannot disagree with what
 * the analyst is told. `undefined` means the host never wired it.
 */
export function setupRead(view: SetupView | null | undefined): SetupRead {
  if (view === undefined) {
    return {
      ok: false,
      reason:
        "The Setup card's verdict is not connected to the analyst in this build, so no call can be derived from it. Read the Setup card on screen.",
    };
  }
  if (view === null) {
    return {
      ok: false,
      reason: "The Setup card has no read yet — the chart is still loading or switching instrument.",
    };
  }
  const v = view.verdict;
  const noSetup = view.setupRefusal.length > 0;
  const call: SetupCall = noSetup ? "no-setup" : v.kind;
  const live = call === "go" || call === "armed" || call === "conflict";
  const p = view.plan;
  const rr = p ? planRMultiple(p) : 0;

  return {
    ok: true,
    symbol: view.symbol,
    timeframe: view.timeframe,
    call,
    headline: v.headline,
    read_line: v.readLine,
    strategy: v.strategy,
    gates_passed: v.passed,
    gates_total: v.total,
    blocking: v.blocking.map((g) => ({ text: g.text, clears: g.clears ?? null })),
    unchecked: v.unknown.map((g) => ({ text: g.text, clears: g.clears ?? null })),
    watch_level: v.watchLevel,
    conflict_note: v.conflictNote,
    plan:
      p && live
        ? {
            direction: p.direction,
            entry: r6(p.entry),
            entry_low: r6(p.entryLow),
            entry_high: r6(p.entryHigh),
            stop: r6(p.stop),
            target1: r6(p.target1),
            target2: r6(p.target2),
            reward_to_risk_t1: r4(rr),
            break_even_hit_rate: r4(breakEven(rr)),
            stop_from: p.stopFrom,
            stop_atr_now: r4(view.stopAtrLive),
          }
        : null,
    plan_withheld:
      p && !live
        ? "A plan exists but a gate blocks or could not be checked, so its entry, stop and size are withheld — the same rule the Setup card applies."
        : "",
    plan_problem: view.planProblem,
    no_setup_reason: view.setupRefusal,
    waiting_for: view.setupWaitingFor,
    why_this_setup: view.setupWhy,
    history: view.history
      ? {
          note: view.history.note,
          instances: view.history.n,
          hit_rate: view.history.hitRate,
          hit_rate_lower_bound: view.history.hitLow,
          break_even_hit_rate: r4(view.history.breakEven),
          expectancy_r: view.history.expectancy,
          enough_to_characterise: view.history.enough,
          adverse: view.history.adverse,
          basis: "measured by replay over the archive, IN-SAMPLE — a prior, not a forecast",
        }
      : null,
    size:
      view.size && live
        ? { qty: view.size.qty, risk_money: view.size.riskMoney, risk_pct: view.size.riskPct }
        : null,
    basis:
      "The Setup card's own verdict: gates checked against your rules. Decision support — you execute.",
  };
}

/* ---------------------------------------------------------------- outlook */

/** A plan for the odds: the terminal's, or one the caller supplied. */
export interface OutlookPlanInput extends OutlookTradePlan {
  readonly source: "terminal setup" | "supplied by the caller";
}

/** The horizons quoted from the cone, in bars. */
export const OUTLOOK_HORIZONS: readonly number[] = [1, 6, 12, 24];

export type OutlookReport =
  | { readonly ok: false; readonly refused: string }
  | {
      readonly ok: true;
      readonly basis: "modelled";
      readonly method: string;
      readonly last_close: number;
      readonly horizon_bars: number;
      readonly draws: number;
      readonly seed: number;
      readonly sigma_now_pct_per_bar: number;
      readonly cone: readonly {
        readonly bars_ahead: number;
        readonly p5: number;
        readonly p25: number;
        readonly p50: number;
        readonly p75: number;
        readonly p95: number;
        readonly p5_pct: number;
        readonly p25_pct: number;
        readonly p50_pct: number;
        readonly p75_pct: number;
        readonly p95_pct: number;
      }[];
      readonly p_up_base_rate: number;
      readonly p_up_label: string;
      readonly lines: { readonly range: string; readonly lean: string; readonly odds: string | null };
      readonly odds: Record<string, unknown> | null;
      readonly odds_note: string;
      readonly calibration: Record<string, unknown>;
      readonly assumptions: readonly string[];
      readonly units: Readonly<Record<string, string>>;
    };

const pctFrom = (v: number, last: number): number => r4((v / last - 1) * 100);

export function outlookReport(
  o: Outlook | Refused,
  plan: OutlookPlanInput | null,
  planNote: string,
  calibration: OutlookCalibration | Refused | null,
  lines: (odds: TouchOdds | Refused | null) => { range: string; lean: string; odds: string | null },
): OutlookReport {
  if (!o.ok) return { ok: false, refused: o.refused };
  const c = o.cone;
  const hs = [...new Set([...OUTLOOK_HORIZONS.filter((h) => h <= c.horizon), c.horizon])];
  const cone = hs
    .map((h) => c.steps[h - 1])
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({
      bars_ahead: s.h,
      p5: r6(s.p5),
      p25: r6(s.p25),
      p50: r6(s.p50),
      p75: r6(s.p75),
      p95: r6(s.p95),
      p5_pct: pctFrom(s.p5, c.last),
      p25_pct: pctFrom(s.p25, c.last),
      p50_pct: pctFrom(s.p50, c.last),
      p75_pct: pctFrom(s.p75, c.last),
      p95_pct: pctFrom(s.p95, c.last),
    }));

  let odds: Record<string, unknown> | null = null;
  let touch: TouchOdds | Refused | null = null;
  if (plan) {
    const { source, ...levels } = plan;
    touch = o.touch(levels);
    const risk = Math.abs(levels.entry - levels.stop);
    const rr = risk > 0 ? Math.abs(levels.target1 - levels.entry) / risk : 0;
    const be = breakEven(rr);
    odds = touch.ok
      ? {
          basis: "modelled",
          plan_source: source,
          plan: levels,
          reward_to_risk_t1: r4(rr),
          break_even_rate: r4(be),
          target1_first: r4(touch.target1First),
          stop_first: r4(touch.stopFirst),
          neither_within_horizon: r4(touch.neither),
          target2_first: touch.target2First === null ? null : r4(touch.target2First),
          target1_first_minus_break_even: r4(touch.target1First - be),
          counts: touch.counts,
          assumptions: touch.assumptions,
        }
      : { plan_source: source, plan: levels, refused: touch.refused };
  }

  const cal: Record<string, unknown> =
    calibration === null
      ? { pending: true, note: "The band's track record is still being replayed from the archive." }
      : calibration.ok
        ? {
            basis: "measured",
            coverage: r4(calibration.coverage),
            nominal: calibration.nominal,
            inside: calibration.inside,
            trials: calibration.trials,
            usable: calibration.usable,
            horizon_bars: calibration.horizon,
            note: calibration.note,
          }
        : { refused: calibration.refused };

  return {
    ok: true,
    basis: "modelled",
    method:
      "Filtered historical simulation: this instrument's own past moves, standardised by the EWMA volatility known at the time, redrawn and rescaled to today's volatility.",
    last_close: r6(c.last),
    horizon_bars: c.horizon,
    draws: c.draws,
    seed: c.seed,
    sigma_now_pct_per_bar: r4(c.sigmaNow * 100),
    cone,
    p_up_base_rate: r4(c.pUp),
    p_up_label:
      "Share of simulated paths ending higher at the horizon — a base rate from this instrument's own moves, NOT a directional signal.",
    lines: lines(touch),
    odds,
    odds_note: planNote,
    calibration: cal,
    assumptions: c.assumptions,
    units: {
      prices: "quote currency",
      "*_pct": "percent from last_close",
      sigma_now_pct_per_bar: "percent per bar, one standard deviation",
      rates: "fractions of simulated paths, 0..1",
    },
  };
}

/* ---------------------------------------------------------- opportunities */

export type OpportunitiesReport =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly timeframe: string;
      readonly universe: string;
      readonly scanned: number;
      readonly with_setup: number;
      readonly without_setup: number;
      readonly failed: readonly { readonly symbol: string; readonly error: string }[];
      readonly stop_rules: { readonly min_stop_atr: number; readonly max_stop_atr: number; readonly source: string };
      readonly rows: readonly Record<string, unknown>[];
      readonly caveats: readonly string[];
    };

/**
 * Rows already in the Opportunities desk's order (`rankByOpportunity`).
 *
 * Failures are listed by name, never dropped: a scan that quietly returns 47
 * rows when 50 were asked for is lying about its coverage.
 */
export function opportunitiesReport(
  ranked: readonly ScanRow[],
  meta: {
    readonly timeframe: string;
    readonly universe: string;
    readonly limit: number;
    readonly minStopAtr: number;
    readonly maxStopAtr: number;
    readonly stopRuleSource: string;
  },
): OpportunitiesReport {
  const failed = ranked
    .filter((r) => r.error !== null)
    .map((r) => ({ symbol: r.symbol, error: r.error ?? "" }));
  const withSetup = ranked.filter((r) => r.opportunity?.ok === true);
  const rows = withSetup.slice(0, meta.limit).map((r, i) => {
    const o = r.opportunity?.ok === true ? r.opportunity.opportunity : null;
    if (o === null) return { rank: i + 1, symbol: r.symbol };
    return {
      rank: i + 1,
      symbol: r.symbol,
      last_price: r.lastPrice,
      change_24h_pct: r4(r.changePct),
      setup: o.label,
      kind: o.kind,
      direction: o.direction,
      reason: o.reason,
      engine_score: r4(o.score),
      grounded_fraction: r4(o.grounded),
      bars_since_confirmed: o.barsAgo,
      entry: r6(o.entry),
      entry_low: r6(o.entryLow),
      entry_high: r6(o.entryHigh),
      stop: r6(o.stop),
      target1: r6(o.target1),
      target2: r6(o.target2),
      reward_to_risk_t1: r4(o.rMultiple),
      one_r_pct_of_price: r4(o.riskPct * 100),
      stop_from: o.stopFrom,
      history: {
        basis: "measured by replay, IN-SAMPLE",
        instances: o.history.n,
        hit_rate: o.history.hitRate,
        hit_rate_lower_bound: o.history.hitLow,
        expectancy_r: o.history.expectancy,
        enough_to_characterise: o.history.enough,
        adverse: o.history.adverse,
        note: o.history.note,
      },
      edge_lower_bound_minus_break_even: o.edge === null ? null : r4(o.edge),
    };
  });
  return {
    ok: true,
    timeframe: meta.timeframe,
    universe: meta.universe,
    scanned: ranked.length,
    with_setup: withSetup.length,
    without_setup: ranked.length - withSetup.length - failed.length,
    failed,
    stop_rules: { min_stop_atr: meta.minStopAtr, max_stop_atr: meta.maxStopAtr, source: meta.stopRuleSource },
    rows,
    caveats: [
      "Ranked by the setup engine's score scaled by how grounded it is; historically adverse setups sort last. The replayed history is in-sample and never the primary key.",
      "These plans have NOT been through your Setup-card gates (spread, stop band, events, record). Open the symbol on the chart before acting on any row.",
      "edge_lower_bound_minus_break_even is null when the replay is too thin to say; positive means history clears break-even on its pessimistic reading.",
    ],
  };
}
