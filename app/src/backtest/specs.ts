/**
 * The shipped rule specs.
 *
 * Seventeen distinct behaviours, recovered from the previous terminal's
 * strategy table and named for what each one DOES rather than for the trading
 * style it was filed under. See `rules.ts` for why the count went down from the
 * 35 that were advertised: the old dispatcher matched a regular expression
 * against the strategy NAME, so eight market-making entries and three
 * smart-money entries each collapsed onto a single shared rule.
 *
 * TWO WERE NOT PORTED, AND THAT IS DELIBERATE
 *
 *   "Kinetic Flux" — the old note described it as "normalized price-velocity ×
 *   volume participation (open interpretation)". An invented metric with no
 *   published definition, whose own author flagged it as open to
 *   interpretation, cannot be tested against anything. Shipping it under a
 *   confident name would be the one thing this terminal is not allowed to do.
 *
 *   "RSI Divergence" — a real technique, but it needs a swing-comparison column
 *   this vocabulary does not have. It is absent rather than approximated,
 *   because the obvious approximation (RSI extremes) is a DIFFERENT strategy
 *   and is already here under its own name.
 *
 * WHAT THE NOTES ARE FOR
 * Where the old build shipped a proxy and said so, that admission is carried
 * forward verbatim in spirit. A band-fade rule labelled "Avellaneda–Stoikov
 * Market Making" is not market making; it is a band fade. The note says so.
 */

import type { RuleSpec } from "./rules";

const ATR2 = { type: "atr", mult: 2 } as const;
const RR2 = { type: "rr", value: 2 } as const;
const RR15 = { type: "rr", value: 1.5 } as const;

export const SPECS: readonly RuleSpec[] = [
  // ------------------------------------------------------------ trend ---
  {
    id: "ema-9-21-cross",
    name: "EMA 9/21 cross",
    style: "scalp",
    long: [["ema9", "crossabove", "ema21"], ["close", ">", "ema9"]],
    short: [["ema9", "crossbelow", "ema21"]],
    exitLong: [["close", "<", "ema21"]],
    exitShort: [["close", ">", "ema21"]],
    stop: ATR2,
    target: RR15,
    note: "The fastest of the trend rules and the one that trades most. Expect a low win rate and a heavy dependence on costs.",
  },
  {
    id: "ema-50-200-cross",
    name: "EMA 50/200 cross",
    style: "swing",
    long: [["ema50", ">", "ema200"], ["close", "crossabove", "ema50"]],
    short: [["ema50", "<", "ema200"], ["close", "crossbelow", "ema50"]],
    exitLong: [["close", "<", "ema50"]],
    exitShort: [["close", ">", "ema50"]],
    stop: ATR2,
    target: RR2,
    note: "Trades pullbacks to the 50 only in the direction the 200 already allows. Needs 200 bars of warm-up before its first decision.",
  },
  {
    id: "ema-ribbon",
    name: "Triple-EMA ribbon",
    style: "swing",
    long: [["ema9", ">", "ema21"], ["ema21", ">", "ema50"], ["close", "crossabove", "ema9"]],
    short: [["ema9", "<", "ema21"], ["ema21", "<", "ema50"], ["close", "crossbelow", "ema9"]],
    exitLong: [["close", "<", "ema21"]],
    exitShort: [["close", ">", "ema21"]],
    stop: ATR2,
    target: RR2,
    note: "Requires all three averages stacked before it will act. Far fewer entries than the 9/21 cross, which is the entire point of it.",
  },
  {
    id: "supertrend-flip",
    name: "Supertrend flip",
    style: "swing",
    long: [["stdir", "crossabove", "0"]],
    short: [["stdir", "crossbelow", "0"]],
    exitLong: [["stdir", "<", "0"]],
    exitShort: [["stdir", ">", "0"]],
    stop: ATR2,
    target: { type: "rr", value: 3 },
    note: "Always in the market in one direction or the other, so the exit rule and the stop fire against each other constantly. Read the trade count before the return.",
  },
  {
    id: "adx-trend-strength",
    name: "ADX trend-strength",
    style: "intraday",
    long: [["adx", ">", "25"], ["ema9", ">", "ema21"], ["close", ">", "ema50"]],
    short: [["adx", ">", "25"], ["ema9", "<", "ema21"], ["close", "<", "ema50"]],
    exitLong: [["ema9", "crossbelow", "ema21"]],
    exitShort: [["ema9", "crossabove", "ema21"]],
    stop: ATR2,
    target: RR2,
    note: "Acts only when ADX says a trend exists. ADX is a lagging measure of trend STRENGTH and says nothing about direction — the EMAs supply that.",
  },
  {
    id: "macd-signal-cross",
    name: "MACD signal cross",
    style: "intraday",
    long: [["macd", "crossabove", "macds"], ["macdh", ">", "0"]],
    short: [["macd", "crossbelow", "macds"]],
    exitLong: [["macd", "crossbelow", "macds"]],
    exitShort: [["macd", "crossabove", "macds"]],
    stop: ATR2,
    target: RR2,
  },
  {
    id: "roc-impulse",
    name: "ROC impulse, trend-filtered",
    style: "scalp",
    long: [["roc", "crossabove", "0"], ["close", ">", "ema50"]],
    short: [["roc", "crossbelow", "0"], ["close", "<", "ema50"]],
    exitLong: [["roc", "<", "0"]],
    exitShort: [["roc", ">", "0"]],
    stop: ATR2,
    target: RR2,
    note: "Rate of change crossing zero is momentum turning. The EMA 50 filter is what stops it fading every trend it meets.",
  },
  {
    id: "dual-momentum",
    name: "Dual momentum",
    style: "swing",
    long: [["ema50", ">", "ema200"], ["rsi", ">", "55"]],
    short: [["ema50", "<", "ema200"], ["rsi", "<", "45"]],
    exitLong: [["rsi", "<", "48"]],
    exitShort: [["rsi", ">", "52"]],
    stop: ATR2,
    target: { type: "rr", value: 3 },
    note: "Trend and momentum must agree. Conditions are STATES rather than crossings, so it re-enters continuously while they hold.",
  },

  // ------------------------------------------------------- mean reversion ---
  {
    id: "rsi-reversion",
    name: "RSI mean reversion",
    style: "reversion",
    long: [["rsi", "crossabove", "32"]],
    short: [["rsi", "crossbelow", "68"]],
    exitLong: [["rsi", ">", "55"]],
    exitShort: [["rsi", "<", "45"]],
    stop: { type: "pct", value: 1.5 },
    target: RR2,
    note: "Buys as RSI climbs back OUT of oversold rather than while it is falling into it. Wins often and loses big; a high win rate here proves nothing on its own.",
  },
  {
    id: "stoch-cross",
    name: "Stochastic cross in the extreme",
    style: "scalp",
    long: [["stochk", "crossabove", "stochd"], ["stochk", "<", "40"]],
    short: [["stochk", "crossbelow", "stochd"], ["stochk", ">", "60"]],
    exitLong: [["stochk", ">", "80"]],
    exitShort: [["stochk", "<", "20"]],
    stop: { type: "pct", value: 1 },
    target: RR15,
  },
  {
    id: "cci-extremes",
    name: "CCI extremes",
    style: "reversion",
    long: [["cci", "crossabove", "-100"]],
    short: [["cci", "crossbelow", "100"]],
    exitLong: [["cci", ">", "120"]],
    exitShort: [["cci", "<", "-120"]],
    stop: ATR2,
    target: RR2,
  },
  {
    id: "williams-reversal",
    name: "Williams %R reversal",
    style: "reversion",
    long: [["willr", "crossabove", "-80"]],
    short: [["willr", "crossbelow", "-20"]],
    exitLong: [["willr", ">", "-30"]],
    exitShort: [["willr", "<", "-70"]],
    stop: ATR2,
    target: RR2,
    note: "Williams %R runs from -100 to 0, so -80 is OVERSOLD and -20 is overbought — the reverse of every other oscillator here.",
  },
  {
    id: "mfi-reversal",
    name: "Money-flow reversal",
    style: "reversion",
    long: [["mfi", "crossabove", "20"]],
    short: [["mfi", "crossbelow", "80"]],
    exitLong: [["mfi", ">", "55"]],
    exitShort: [["mfi", "<", "45"]],
    stop: ATR2,
    target: RR2,
    note: "MFI is RSI weighted by volume. On a feed with absent or flat volume it degenerates towards plain RSI — check the Data desk before reading anything into the difference.",
  },
  {
    id: "bb-fade",
    name: "Bollinger band fade",
    style: "reversion",
    long: [["close", "crossbelow", "bbl"]],
    short: [["close", "crossabove", "bbu"]],
    exitLong: [["close", ">", "bbm"]],
    exitShort: [["close", "<", "bbm"]],
    stop: { type: "pct", value: 1.2 },
    target: { type: "pct", value: 1 },
    note: "This one rule is what EIGHT separately-named market-making strategies in the old build actually ran. Genuine market making needs an order book and a funding curve; this is the mean-reversion core such systems sit on, and nothing more.",
  },
  {
    id: "bb-rsi-sweep",
    name: "Band break with RSI confirmation",
    style: "reversion",
    long: [["close", "crossbelow", "bbl"], ["rsi", "<", "42"]],
    short: [["close", "crossabove", "bbu"], ["rsi", ">", "58"]],
    exitLong: [["close", ">", "bbm"]],
    exitShort: [["close", "<", "bbm"]],
    stop: ATR2,
    target: RR2,
    note: "Stood in for the liquidity-sweep, FVG-retest and PDH/PDL strategies in the old build. It is a band-and-oscillator rule, not a structural one — the real structural detectors live on the Chart desk.",
  },

  // ------------------------------------------------------------ breakout ---
  {
    id: "bb-breakout",
    name: "Volatility band breakout",
    style: "intraday",
    long: [["close", "crossabove", "bbu"]],
    short: [["close", "crossbelow", "bbl"]],
    exitLong: [["close", "<", "bbm"]],
    exitShort: [["close", ">", "bbm"]],
    stop: ATR2,
    target: RR2,
    note: "The same bands as the fade, traded the other way round. The old build also used this as a proxy for the London-open and opening-range strategies, which it is not — it has no concept of a session.",
  },
  {
    id: "vwap-cross",
    name: "VWAP cross",
    style: "intraday",
    long: [["close", "crossabove", "vwap"]],
    short: [["close", "crossbelow", "vwap"]],
    exitLong: [["close", "<", "vwap"]],
    exitShort: [["close", ">", "vwap"]],
    stop: { type: "pct", value: 0.8 },
    target: RR15,
    note: "Session VWAP, reset daily. On a 1-day timeframe every bar is its own session, so this rule is meaningless above 4h — check the timeframe before trusting a result.",
  },
  // ------------------------------------------------------- structural ---
  /**
   * v49. The entries you would actually take, finally testable.
   *
   * Everything above this line is arithmetic on price. These are what the
   * DETECTORS find, compiled into columns by `backtest/structural.ts` — which
   * means the terminal can at last answer whether the sweep it drew on your
   * chart, with its confidence figure, has ever made money.
   *
   * Read the PBO figure before reading any of these results. Adding seven
   * specs to a set already measuring 89% does not find an edge; it is the
   * mechanism that produces the number. What justifies these seven is not that
   * they are more, it is that they test a DIFFERENT hypothesis — one about
   * structure rather than about a moving average — and a set of eighteen
   * variations on one idea overfits harder than a set of twenty-four spanning
   * two. See `promoteFrom` in `backtest/validate.ts` for the gate that decides
   * whether any of them earns a place on the desk.
   */
  {
    id: "sweep-reclaim",
    name: "Sweep and reclaim",
    style: "swing",
    long: [["sweep", ">", "0"]],
    short: [["sweep", "<", "0"]],
    exitLong: [["close", "<", "ema21"]],
    exitShort: [["close", ">", "ema21"]],
    stop: ATR2,
    target: RR2,
    note: "A level taken on the wick and given back on the close. The one pattern here that carries its own invalidation — the extreme of the raid — rather than borrowing one from ATR. Fires on the bar the close came back, never on the wick.",
  },
  {
    id: "sweep-with-trend",
    name: "Sweep, with the trend",
    style: "swing",
    long: [["sweep", ">", "0"], ["ema50", ">", "ema200"]],
    short: [["sweep", "<", "0"], ["ema50", "<", "ema200"]],
    exitLong: [["close", "<", "ema50"]],
    exitShort: [["close", ">", "ema50"]],
    stop: ATR2,
    target: { type: "rr", value: 3 },
    note: "The same raid, taken only in the direction the 50/200 already allows. Trades far less. If this beats the unfiltered version it is evidence the trend filter is doing work; if it does not, that is worth knowing before you add one by habit.",
  },
  {
    id: "bos-continuation",
    name: "Break of structure continuation",
    style: "swing",
    long: [["bos", ">", "0"], ["close", ">", "ema50"]],
    short: [["bos", "<", "0"], ["close", "<", "ema50"]],
    exitLong: [["choch", "<", "0"]],
    exitShort: [["choch", ">", "0"]],
    stop: ATR2,
    target: RR2,
    note: "Enters on a confirmed structure break and exits on a change of character against it — the same invalidation the Setup card names for an open position, tested rather than asserted.",
  },
  {
    id: "fvg-retest",
    name: "Fair value gap retest",
    style: "intraday",
    long: [["infvg", ">", "0"], ["close", ">", "ema200"]],
    short: [["infvg", "<", "0"], ["close", "<", "ema200"]],
    exitLong: [["close", "<", "ema21"]],
    exitShort: [["close", ">", "ema21"]],
    stop: ATR2,
    target: RR15,
    note: "Price trading back into an unmitigated imbalance. The zone stops being a zone the moment a close goes through its far side, so a rule that keeps firing after that is testing a level nobody is defending.",
  },
  {
    id: "ob-retest",
    name: "Order block retest",
    style: "swing",
    long: [["inob", ">", "0"], ["close", ">", "ema200"]],
    short: [["inob", "<", "0"], ["close", "<", "ema200"]],
    exitLong: [["close", "<", "ema21"]],
    exitShort: [["close", ">", "ema21"]],
    stop: ATR2,
    target: RR2,
    note: "The last opposing candle before a displacement, retested. Filtered by the 200 because an order block against the prevailing trend is the one that most often fails.",
  },
  {
    id: "range-expansion",
    name: "Range expansion",
    style: "intraday",
    long: [["expansion", ">", "0"]],
    short: [["expansion", "<", "0"]],
    exitLong: [["close", "<", "dcl"]],
    exitShort: [["close", ">", "dcu"]],
    stop: ATR2,
    target: RR2,
    note: "The bar that closes out of a named sideways stretch. Most of a chart is range, and this is the only rule in the set that waits for one to end rather than assuming a trend was already running.",
  },
  {
    id: "squeeze-release",
    name: "Squeeze release",
    style: "swing",
    long: [["squeeze", "<", "1"], ["close", ">", "kcu"]],
    short: [["squeeze", "<", "1"], ["close", "<", "kcl"]],
    exitLong: [["close", "<", "kcm"]],
    exitShort: [["close", ">", "kcm"]],
    stop: ATR2,
    target: RR2,
    note: "Bollinger has come back out of Keltner and price has left the channel. The squeeze itself says only that expansion is due and NOTHING about direction — the direction here comes from which side price actually left through, not from the squeeze.",
  },
  {
    id: "donchian-breakout",
    name: "Donchian breakout",
    style: "swing",
    long: [["close", ">", "dcu"], ["adx", ">", "20"]],
    short: [["close", "<", "dcl"], ["adx", ">", "20"]],
    exitLong: [["close", "<", "celong"]],
    exitShort: [["close", ">", "ceshort"]],
    stop: ATR2,
    target: { type: "rr", value: 3 },
    note: "The classic turtle entry, with the current bar excluded from the channel so a breakout is possible at all, and the Chandelier exit doing the trailing. The ADX filter is what stops it buying every poke of a flat range.",
  },
];

export const SPECS_BY_ID: ReadonlyMap<string, RuleSpec> = new Map(SPECS.map((s) => [s.id, s]));

export const STYLE_LABEL: Readonly<Record<string, string>> = {
  scalp: "Scalping",
  intraday: "Intraday",
  swing: "Swing",
  reversion: "Mean reversion",
  custom: "Your own",
};
