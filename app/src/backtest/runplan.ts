/**
 * "BTCUSDT, 2000 to 2026, $500" — turned into an honest run.
 *
 * WHY THIS EXISTS
 *
 * The Playbook asked `history.load` for a constant 1,500 bars and got 992, so a
 * strategy the owner expected thousands of trades from produced 73. The count
 * was never the strategy's; it was the window's. And the fix is not a larger
 * constant — `MAX_STUDY_BARS` is 60,000 and always was — it is asking for a
 * SPAN, checking what the archive actually holds, and SAYING SO when the answer
 * is smaller than the question.
 *
 * THE ONE THING THIS FILE IS REALLY FOR
 *
 * Asking BTCUSDT for the year 2000 is asking for eight years before Bitcoin
 * traded at all and seventeen before this venue listed it. Returning 2022-2026
 * without a word turns "I tested twenty-six years of history" into something
 * the operator believes, and every statistic downstream inherits that belief.
 * So a clipped range is REPORTED, with the date the data really starts — the
 * same rule as a study that names the vendors it lost rather than quietly
 * reporting the window it wanted.
 */

import { intervalMs, type HistoryService, type HistoryResult } from "../data/history";
import { MAX_STUDY_BARS } from "../ui/study/state";

/** What the archive holds for one series. A slice of `SeriesInventory`. */
export interface Holding {
  readonly oldest: number;
  readonly newest: number;
  readonly bars: number;
}

export interface RunRequest {
  readonly symbol: string;
  readonly timeframe: string;
  /** Inclusive calendar years, UTC. */
  readonly fromYear: number;
  readonly toYear: number;
  /** Account size the simulation starts from. */
  readonly balance: number;
  /** Percent of balance at stake per trade. */
  readonly riskPct: number;
}

export interface RunPlan {
  readonly ok: boolean;
  readonly symbol: string;
  readonly timeframe: string;
  /** The window that will actually be run, after clipping to the archive. */
  readonly from: number;
  readonly to: number;
  readonly years: number;
  /** Bars to ask the history service for. */
  readonly wantBars: number;
  /** Money at stake per trade. */
  readonly riskPerTrade: number;
  /** True when the archive could not serve the whole range asked for. */
  readonly clipped: boolean;
  /** True when `MAX_STUDY_BARS` bound the request. */
  readonly capped: boolean;
  /** What the operator has to be told. Empty when the request was met exactly. */
  readonly why: string;
  /**
   * The series a FETCH would have to bring in for this plan to become runnable,
   * or null when fetching cannot help.
   *
   * A TYPED DESCRIPTOR, NOT A SENTENCE TO MATCH ON. The desk has to offer
   * "download it" on exactly one of three refusals and must not offer it on the
   * other two, and the only thing separating them was English: "the archive
   * holds no EURUSD 15m to run on" versus "…and nothing can be reached back
   * for". A card that greps a `why` to decide whether to show a button is one
   * word away from offering a download that cannot work.
   *
   * Null on the two that fetching cannot fix, and the reasoning is at each site:
   * backfill reaches BACK from what is held, so a window ending years before
   * the oldest bar is a refusal rather than a fetch.
   */
  readonly missing: MissingSeries | null;
}

/** What a fetch would have to bring in, sized for the window that was asked for. */
export interface MissingSeries {
  readonly symbol: string;
  readonly timeframe: string;
  /**
   * Bars to aim for. The refusal path has no `wantBars` of its own -- it
   * returns before the window arithmetic -- so this is computed from the years
   * asked for, which is the number the operator actually typed.
   */
  readonly wantBars: number;
}

const YEAR_MS = 365.25 * 86_400_000;

/**
 * A risk per trade above this is not a strategy setting, it is a bet.
 *
 * Refused rather than clamped: an operator who typed 60 meant something, and
 * silently running 2% would answer a question they did not ask.
 */
const MAX_RISK_PCT = 50;

const refuse = (req: RunRequest, why: string, missing: MissingSeries | null = null): RunPlan => ({
  ok: false,
  symbol: req.symbol,
  timeframe: req.timeframe,
  from: 0,
  to: 0,
  years: 0,
  wantBars: 0,
  riskPerTrade: 0,
  clipped: false,
  capped: false,
  why,
  // DEFAULTS TO NULL, so a refusal added later offers no download until somebody
  // decides it should. The safe direction: a missing button is a feature nobody
  // found, a wrong one is a fetch that cannot succeed.
  missing,
});

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * How many bars the requested years come to, capped the way a run is capped.
 *
 * ONE OWNER for that arithmetic. The success path computes it from the CLIPPED
 * window and the fetch path has no window yet, so both would otherwise carry
 * their own copy of "years x bars per year, but not more than MAX_STUDY_BARS" —
 * and a fetch that asked for a different depth than the run needs is a download
 * that finishes and leaves the plan still refusing.
 */
function wantedBars(req: RunRequest): number {
  const step = intervalMs(req.timeframe);
  const span = Date.UTC(req.toYear + 1, 0, 1) - Date.UTC(req.fromYear, 0, 1);
  if (!(step > 0) || !(span > 0)) return 0;
  return Math.min(MAX_STUDY_BARS, Math.ceil(span / step));
}

/**
 * The offered bar size nearest the one asked for.
 *
 * A CONTROL THAT SHOWS ONE VALUE AND RUNS ANOTHER IS WORSE THAN A REFUSAL.
 * MEASURED on the running build: the Playbook's select displayed "5m" while
 * the plan under it refused with "the archive holds no XAUUSD 3m to run on".
 * The chart was on 3m, the desk took that as its default, and 3m is not one of
 * the five sizes the select offers — so the browser did what a `<select>` does
 * with a value outside its options, which is show the first one and say
 * nothing. Neither half was wrong on its own: the select was right about its
 * options and the plan was right about the value it was handed.
 *
 * Nearest by DURATION, not by string. "45m" is between two offered sizes and
 * alphabetically nowhere; a list sorted as text would put "1d" beside "15m".
 * An unparseable input takes the first offered size rather than being carried
 * through, because carrying it through is the bug.
 */
export function nearestTimeframe(want: string, offered: readonly string[]): string {
  const first = offered[0] ?? "";
  if (offered.includes(want)) return want;
  /* PARSED HERE RATHER THAN TRUSTED. `intervalMs` answers 3,600,000 for
     anything it cannot read — "" and "banana" both come back as one hour —
     which is a silent default, and a silent default is what this function
     exists to remove. Long-standing and relied on elsewhere, so it is not
     changed; it is simply not asked a question it cannot refuse. */
  if (!/^\d+[mhdwM]$/.test(want)) return first;
  const target = intervalMs(want);
  if (!Number.isFinite(target) || target <= 0) return first;

  let best = first;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const t of offered) {
    const ms = intervalMs(t);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    /* Compared as a RATIO, not a difference. 1d is 1,380 minutes from 1h and
       4h is 180, but on a log scale 2h sits between 1h and 4h where a linear
       gap would always favour the smaller size. */
    const gap = Math.abs(Math.log(ms / target));
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best;
}

export function planRun(req: RunRequest, holding: Holding | null): RunPlan {
  if (!(req.balance > 0)) {
    return refuse(req, "a balance above zero is needed before anything can be sized");
  }
  if (!(req.riskPct > 0)) {
    return refuse(req, "risk per trade must be above zero");
  }
  if (req.riskPct > MAX_RISK_PCT) {
    return refuse(
      req,
      `risk per trade of ${req.riskPct}% is above the ${MAX_RISK_PCT}% ceiling — ` +
        "that is a bet rather than a setting, so it is refused rather than clamped",
    );
  }
  if (req.toYear < req.fromYear) {
    return refuse(req, `${req.fromYear} is after ${req.toYear} — the years are the wrong way round`);
  }

  const asked = { from: Date.UTC(req.fromYear, 0, 1), to: Date.UTC(req.toYear + 1, 0, 1) };

  if (holding === null || !(holding.bars > 0) || !(holding.newest > holding.oldest)) {
    /*
     * THE ONE REFUSAL A FETCH CAN FIX, and until now the only thing offered was
     * the sentence. The owner's words: "IF THERE IS NO DATA IT CAN ASK ME TO
     * DOWNLOAD". Holding nothing is not a dead end — `history.backfill` reaches
     * for a series the archive has never seen, which is exactly what
     * `loadForPlan` does for a series it holds too little of.
     *
     * Sized from the YEARS ASKED FOR rather than from a constant, because this
     * path returns before the window arithmetic and a fixed number would be the
     * `WANTED_BARS = 1500` defect this file exists to have fixed: a bar count
     * describing the window instead of the strategy.
     */
    return refuse(req, `the archive holds no ${req.symbol} ${req.timeframe} to run on`, {
      symbol: req.symbol,
      timeframe: req.timeframe,
      wantBars: wantedBars(req),
    });
  }

  /*
   * THE ARCHIVE IS WHAT YOU HAVE, NOT WHAT YOU CAN GET.
   *
   * The first version of this clipped the window to `holding.oldest`, and
   * running it showed the mistake immediately: a profile holding five weeks of
   * BTCUSDT 1h answered a request for 2000–2026 with "the run covers
   * 2026-08-21 to 2026-09-24". Honest about the archive, and useless as a
   * control — you could never ask for history you did not already have, which
   * is the entire point of asking.
   *
   * So only the FUTURE edge is a hard clip: nobody can backfill tomorrow. The
   * past edge is a WARNING, because `history.backfill` can reach for it, and
   * the plan says how much is held versus how much the run needs.
   */
  /* A WINDOW ENTIRELY BEFORE THE OLDEST BAR IS NOT A FETCH, IT IS A REFUSAL.
     Backfill reaches BACK from what is held; it cannot invent a year the venue
     never listed. 2000–2026 overlaps and is worth reaching for; 2010–2015 ends
     seven years before anything exists and would fetch nothing while looking
     like it was trying. */
  if (asked.to <= holding.oldest) {
    return refuse(
      req,
      `the archive holds no ${req.symbol} ${req.timeframe} inside ${req.fromYear}–${req.toYear}, and nothing ` +
        `can be reached back for: what exists runs ${iso(holding.oldest)} to ${iso(holding.newest)}`,
    );
  }

  const from = asked.from;
  const to = Math.min(asked.to, holding.newest);
  if (to <= from) {
    return refuse(
      req,
      `the archive holds no ${req.symbol} ${req.timeframe} inside ${req.fromYear}–${req.toYear} — ` +
        `what it has runs ${iso(holding.oldest)} to ${iso(holding.newest)}`,
    );
  }

  const notes: string[] = [];
  const clipped = to < asked.to || from < holding.oldest;
  if (to < asked.to) {
    notes.push(`the newest ${req.symbol} ${req.timeframe} bar is ${iso(holding.newest)}, so the run ends there`);
  }
  if (from < holding.oldest) {
    const haveMs = Math.max(0, to - holding.oldest);
    const needMs = to - from;
    const pct = Math.round((haveMs / needMs) * 100);
    notes.push(
      `the archive holds ${req.symbol} ${req.timeframe} from ${iso(holding.oldest)} — about ${pct}% of the ` +
        "span asked for. The run will reach back for the rest before it starts, which can take a while the first time",
    );
  }

  const step = intervalMs(req.timeframe);
  const need = Math.ceil((to - from) / step);
  const capped = need > MAX_STUDY_BARS;
  if (capped) {
    notes.push(
      `that span is ${need.toLocaleString()} bars; the run is capped at ${MAX_STUDY_BARS.toLocaleString()} ` +
        "because past it a single pass takes minutes and the oldest bars describe a market that no longer exists",
    );
  }

  return {
    ok: true,
    // Nothing is missing on a plan that runs. `loadForPlan` still reaches back
    // for a short window; that is a warning on a running plan, not a refusal.
    missing: null,
    symbol: req.symbol,
    timeframe: req.timeframe,
    from,
    to,
    years: (to - from) / YEAR_MS,
    wantBars: Math.min(MAX_STUDY_BARS, need),
    riskPerTrade: (req.balance * req.riskPct) / 100,
    clipped,
    capped,
    why: notes.join("; "),
  };
}

export interface LoadedForPlan {
  readonly bars: HistoryResult["bars"];
  readonly source: string;
  readonly containsDemo: boolean;
  /** True when the vendor could not reach back as far as the plan asked. */
  readonly short: boolean;
  /** What the operator has to be told. Empty when the plan was met. */
  readonly why: string;
}

/**
 * Load the bars a plan asked for, reaching back once if the archive is short.
 *
 * THE RE-LOAD IS THE WHOLE POINT, and its absence was the defect.
 *
 * `backfill` returns a COUNT and writes what it fetched into the archive; it
 * does not return the series. The Playbook loaded, saw it was short,
 * backfilled — and then ran the backtest on the bars it had loaded BEFORE,
 * because `hist` was captured before and used after. MEASURED on the running
 * build, three consecutive runs with identical inputs on ETHUSDT 4h:
 *
 *     run 1  ->  156 trades
 *     run 2  ->  480 trades
 *     run 3  ->  480 trades
 *
 * The same question, two different answers, and the first one wrong. On a
 * market holding four days against a four-year request there were too few bars
 * to produce a single trade — which is what "the backtest is broken, always 0"
 * looks like from outside. Nothing could have caught it: a backtest that runs
 * on fewer bars and reports fewer trades is indistinguishable from a strategy
 * that simply traded less.
 *
 * ONE BACKFILL, NOT A LOOP. A vendor with nothing older to give would
 * otherwise be asked until a guard stopped it, and a desk that hangs is worse
 * than one that says how far it got. Falling short is reported, not retried.
 */
export async function loadForPlan(history: HistoryService, plan: RunPlan): Promise<LoadedForPlan> {
  const want = plan.wantBars;
  let hist = await history.load(plan.symbol, plan.timeframe, { limit: want });

  /* Below nine tenths is "short". Not equality: a vendor that returns one bar
     fewer than asked is not a problem worth a network round trip. */
  if (hist.bars.length < want * 0.9) {
    await history.backfill(plan.symbol, plan.timeframe, want);
    /* AND READ IT BACK. Everything above this line already worked. */
    hist = await history.load(plan.symbol, plan.timeframe, { limit: want });
  }

  const short = hist.bars.length < want * 0.9;
  return {
    bars: hist.bars,
    source: hist.source,
    containsDemo: hist.containsDemo,
    short,
    why: short
      ? `${hist.bars.length.toLocaleString()} bars arrived of the ${want.toLocaleString()} this window needs — ` +
        `${plan.symbol} ${plan.timeframe} does not reach that far back from this vendor. Everything below is ` +
        "measured on what arrived, which is a shorter window than the one asked for."
      : "",
  };
}

/**
 * A one-line description of what the run covered, for the result to carry.
 *
 * The result has to state its own window, because "73 trades" and "4,100
 * trades" are the same sentence about different questions, and a figure that
 * does not say what it was measured over is a figure nobody can argue with.
 */
export function planLine(p: RunPlan): string {
  if (!p.ok) return p.why;
  const span = `${iso(p.from)} to ${iso(p.to)}`;
  return `${p.symbol} ${p.timeframe}, ${span} — ${p.wantBars.toLocaleString()} bars, ${p.years.toFixed(1)} years`;
}
