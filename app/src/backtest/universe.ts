/**
 * Which markets a survey runs across, and why each one is in the list.
 *
 * WHAT THE MULTI-MARKET PANEL IS FOR
 * A strategy tested on one instrument produces a fact about that instrument. It
 * is very easy to mistake for a fact about the strategy, and the mistake is
 * expensive in a specific way: the rules that survive a single-market sweep are
 * disproportionately the ones fitted to that market's character. Test a
 * mean-reversion rule on BTC alone and you learn how mean-reverting BTC was over
 * your window. Test it on BTC and gold and an index and it either keeps working
 * or it does not, and either answer is worth more than the first one.
 *
 * So the panel is chosen for DISAGREEMENT. Instruments that behave alike add
 * trade count and no information — a survey over BTC, ETH and SOL has three
 * names and one market, and it will report a crypto-momentum finding as a
 * universal law. Every entry below is here because it breaks something the
 * others share: a different session structure, a different volatility regime, a
 * different reason people hold it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CORRELATION IS THE THING BEING MANAGED
 *
 * The survey's evidence is cross-market AGREEMENT: a style that works on four of
 * five markets is a style, and a style that works on one is that market's
 * character. That inference is only sound if the markets are close to
 * independent. Four highly-correlated crypto pairs agreeing is one market
 * agreeing with itself four times, and counting it as four is exactly the
 * inflated-sample error `resample.ts` blocks the bootstrap against.
 *
 * The panel cannot make instruments independent, so it does the next best thing:
 * it declares the correlation group each one belongs to, and `survey.ts` counts
 * AGREEMENT BY GROUP rather than by symbol. BTC and ETH both liking a rule
 * counts once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE
 *
 * **A long list.** Twenty instruments is twenty history fetches before the first
 * result, and the marginal one adds a fraction of what the fourth did. The
 * default is five, and the set is editable.
 *
 * **Anything outside the instrument table.** Every symbol here is a declared
 * instrument in `risk/instruments.ts` and routes through `data/sources.ts`.
 *
 * That is NOT a promise that all four will load. Only the crypto entries come
 * from Binance directly; gold, the index and the FX pair resolve through the
 * proxy or the MT5 bridge, and how much history those return depends on what
 * the backend is connected to. Which is precisely why availability is treated as
 * a RESULT rather than an assumption: a panel entry that quietly failed would
 * turn "this rule works across four markets" into "this rule works on the two
 * that happened to download", and the reader would have no way to tell. So
 * `survey.ts` reports loaded and missing markets by name, counts agreement only
 * over what actually arrived, and never describes a short panel as a full one.
 */

/**
 * A correlation group.
 *
 * Instruments in the same group are NOT independent evidence. The grouping is
 * coarse and deliberately so — it is the difference between "two markets agreed"
 * and "one market agreed with itself", and a coarse answer to that is far more
 * useful than a precise correlation matrix nobody calibrated.
 */
export type Bloc = "crypto" | "metals" | "equity" | "fx" | "energy" | "rates";

export const BLOC_LABEL: Readonly<Record<Bloc, string>> = {
  crypto: "Crypto",
  metals: "Metals",
  equity: "Equity index",
  fx: "FX",
  energy: "Energy",
  rates: "Rates",
};

export interface Market {
  /** The terminal's own dialect. `data/sources.ts` translates per vendor. */
  readonly symbol: string;
  readonly label: string;
  readonly bloc: Bloc;
  /** What this market contributes that the others do not. */
  readonly why: string;
  /** True for markets that close. Drives the session caveat in the report. */
  readonly continuous: boolean;
}

/**
 * The default panel.
 *
 * Five markets in five blocs. BTC and gold are first because they are the two
 * the question is usually asked about, and because they are close to opposites
 * in the way that matters here: BTC trends violently and never closes, gold
 * ranges for months and gaps over weekends. A rule that works on both is
 * unlikely to be fitted to either.
 */
export const PANEL: readonly Market[] = [
  {
    symbol: "BTCUSDT",
    label: "Bitcoin",
    bloc: "crypto",
    why: "Trends hard, reverses hard, and never closes — the deepest continuous history available, and the market most likely to flatter a momentum rule.",
    continuous: true,
  },
  {
    symbol: "XAUUSD",
    label: "Gold",
    bloc: "metals",
    why: "The counterweight to BTC: long ranges punctuated by macro repricing, with weekend gaps. Breaks any rule that quietly assumes a continuous tape.",
    continuous: false,
  },
  {
    symbol: "SPX500",
    label: "S&P 500",
    bloc: "equity",
    why: "Upward drift with volatility clustering, and a real session. A long-only-biased rule looks good here for reasons that have nothing to do with the rule.",
    continuous: false,
  },
  {
    symbol: "EURUSD",
    label: "Euro / dollar",
    bloc: "fx",
    why: "The nearest thing to a driftless market on the list. Mean reversion that survives here is mean reversion; elsewhere it may be riding a trend backwards.",
    continuous: false,
  },
  {
    symbol: "ETHUSDT",
    label: "Ether",
    bloc: "crypto",
    why: "Deliberately in BTC's bloc, so it adds trade count without being counted as a second market. Included because a rule failing on ETH while working on BTC is a warning about BTC.",
    continuous: true,
  },
];

export const PANEL_BY_SYMBOL: ReadonlyMap<string, Market> = new Map(
  PANEL.map((m) => [m.symbol, m]),
);

/**
 * The markets to load when the operator has not chosen.
 *
 * Four, not five: enough for three independent blocs plus BTC's partner, and
 * few enough that the first result arrives without a long wait. `ETHUSDT` is the
 * one dropped by default because it is the only entry that adds no new bloc.
 */
export const DEFAULT_SELECTION: readonly string[] = ["BTCUSDT", "XAUUSD", "SPX500", "EURUSD"];

/**
 * How many distinct correlation blocs a set of symbols covers.
 *
 * This, and not the symbol count, is the survey's real sample size for a
 * cross-market claim.
 */
export function blocsOf(symbols: readonly string[]): Bloc[] {
  const seen = new Set<Bloc>();
  for (const s of symbols) {
    const m = PANEL_BY_SYMBOL.get(s);
    if (m) seen.add(m.bloc);
  }
  return [...seen];
}

/**
 * The caveat a panel earns, or null when it has none.
 *
 * Returned rather than logged, so the report can carry it beside the numbers.
 * A survey over three crypto pairs is a legitimate thing to run; presenting its
 * output as a cross-market finding is not, and this is the sentence that stops
 * that happening quietly.
 */
export function panelCaveat(symbols: readonly string[]): string | null {
  if (symbols.length === 0) return "No markets selected — there is nothing to survey.";

  const blocs = blocsOf(symbols);
  const unknown = symbols.filter((s) => !PANEL_BY_SYMBOL.has(s));

  if (blocs.length <= 1 && unknown.length === 0) {
    const only = blocs[0];
    return (
      `Every market here is ${only ? BLOC_LABEL[only].toLowerCase() : "from one bloc"}. ` +
      `They move together, so agreement between them is one market agreeing with itself — ` +
      `read any result as a fact about ${only ? BLOC_LABEL[only].toLowerCase() : "this bloc"} ` +
      `and not about the rule.`
    );
  }

  if (unknown.length > 0) {
    return (
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} outside the declared panel, so ` +
      `${unknown.length === 1 ? "its" : "their"} correlation with the rest is unknown. ` +
      `Agreement counts treat each as its own bloc, which OVERSTATES the independence if ` +
      `${unknown.length === 1 ? "it tracks" : "they track"} something already listed.`
    );
  }

  if (blocs.length === 2) {
    return `Two independent blocs (${blocs.map((b) => BLOC_LABEL[b].toLowerCase()).join(" and ")}). Enough to catch a rule fitted to one market, not enough to call anything universal.`;
  }

  return null;
}
