/**
 * Instrument specifications, and how a pip is actually worth something.
 *
 * WHY THIS TABLE DOES NOT CONTAIN A PRICE
 * The table this was recovered from carried a `px` field on every row — a price
 * snapshot taken some time before July. A price in a static table is a lie with
 * a timestamp attached, and this terminal has a live feed for exactly this
 * purpose. Price comes from the feed or from you; nothing here pretends to
 * know it.
 *
 * WHY IT DOES NOT CARRY A DOLLAR-PER-PIP CONSTANT EITHER, WHICH IS THE
 * INTERESTING PART
 * The recovered table also carried `dpp`, "dollars per pip per lot", as a
 * hardcoded number: 10 for EUR/USD, 9.09 for every JPY pair, 10 for USD/CHF.
 * Those are not properties of an instrument. They are properties of an
 * instrument AND the exchange rate on the day somebody typed them in.
 *
 * Pip value is not a constant. It is
 *
 *     pipValue = pip × contractSize × (USD per unit of the QUOTE currency)
 *
 * and only the last term moves. Measured against that identity, the recovered
 * constants were wrong by:
 *
 *     USD/JPY     9.09  vs   6.40      +42%
 *     USD/CAD    10.00  vs   7.29      +37%
 *     USD/CHF    10.00  vs  11.26      −11%
 *
 * That is not cosmetic. Recommended lot size is
 * `riskAmount / (stopPips × pipValue)`, so pip value sits directly underneath
 * the one number this calculator exists to produce, and a 42% error in it is a
 * 30% error in the position you take.
 *
 * SO PIP VALUE IS DERIVED — EXACTLY, FOR 65 OF THE 72 INSTRUMENTS HERE
 *
 *   quote is USD → pipValue = pip × contractSize.
 *                  Exact, no external data. 62 rows: every crypto, metal, US
 *                  index and stock, and the majors quoted in dollars.
 *
 *   base is USD  → pipValue = pip × contractSize / price.
 *                  Exact, and it needs nothing you have not already typed:
 *                  the price of USD/JPY *is* the JPY-per-USD rate.
 *                  3 rows: USD/JPY, USD/CHF, USD/CAD.
 *
 *   neither      → needs one more rate, and SAYS SO instead of guessing.
 *                  7 rows: EUR/JPY, GBP/JPY, AUD/JPY, EUR/GBP, EUR/AUD, and
 *                  the two European indices below.
 *
 * That last branch is the whole reason pip value is a case and not a number. A
 * calculator that quietly substitutes a stale constant for a rate it does not
 * have produces a lot size that looks authoritative and is wrong.
 *
 * TWO CORRECTIONS TO THE RECOVERED DATA
 * `SHIBUSD` appeared twice in the source table — a duplicate object key, so the
 * second silently won. It appears once here, which is why 73 source rows became
 * the 72 below.
 * `GER40` and `UK100` were both marked USD-quoted. The DAX settles in EUR and
 * the FTSE in GBP; a pip of either is not a dollar. They are quoted correctly
 * here, which puts them in the cross branch where they belong.
 */

/** What kind of thing this is. Drives contract conventions and the UI grouping. */
export type AssetClass = "forex" | "crypto" | "perp" | "metal" | "index" | "stock";

export interface InstrumentSpec {
  readonly symbol: string;
  readonly name: string;
  readonly cls: AssetClass;
  /**
   * The price increment this instrument is quoted in "pips" of.
   *
   * For FX that is the fourth decimal, or the second for JPY pairs. For
   * everything else it is the conventional tick and "pip" simply means "tick" —
   * the arithmetic does not care what the unit is called.
   */
  readonly pip: number;
  /** Units of the base per lot. 100_000 for a standard FX lot, 1 for spot crypto. */
  readonly contractSize: number;
  readonly base: string;
  readonly quote: string;
  /** Venue maximum, where the recovered table recorded one. */
  readonly maxLeverage?: number;
}

/**
 * How a pip value was arrived at, carried next to the number itself.
 *
 * The desk renders this rather than the bare figure. "$6.40 per pip" and "$6.40
 * per pip, derived from the price you entered" are different claims, and only
 * the second one is true.
 */
export type PipBasis =
  | { readonly kind: "quote-usd" }
  | { readonly kind: "base-usd"; readonly price: number }
  | { readonly kind: "cross"; readonly rateSymbol: string; readonly rate: number }
  | { readonly kind: "unknown"; readonly rateSymbol: string };

export interface PipValue {
  /** USD per pip per lot, or NaN when the basis is "unknown". */
  readonly value: number;
  readonly basis: PipBasis;
}

/**
 * The rate needed to turn a pip into dollars, for the instruments that need one.
 *
 * Keyed by QUOTE CURRENCY, not by instrument, because that is what the
 * conversion actually depends on: EUR/JPY and GBP/JPY need the same USD/JPY
 * between them, not one rate each.
 */
export const CROSS_RATE_SYMBOL: Readonly<Record<string, string>> = {
  JPY: "USDJPY",
  GBP: "GBPUSD",
  AUD: "AUDUSD",
  EUR: "EURUSD",
  /* Added with the crosses and exotics. Every quote currency in the table needs
     an entry here or `pipValue` returns NaN with no named rate to fix it — a
     silent hole in the calculator on exactly the pairs whose pip value is
     least obvious. The direction matters: a symbol starting with USD quotes
     the currency PER dollar and is inverted; one ending in USD is not. */
  CHF: "USDCHF",
  CAD: "USDCAD",
  NZD: "NZDUSD",
  MXN: "USDMXN",
  ZAR: "USDZAR",
  TRY: "USDTRY",
  SEK: "USDSEK",
  NOK: "USDNOK",
  PLN: "USDPLN",
  SGD: "USDSGD",
  HKD: "USDHKD",
  CNH: "USDCNH",
  HUF: "USDHUF",
  CZK: "USDCZK",
};

/**
 * USD per one unit of the quote currency.
 *
 * USD/JPY quotes JPY per USD, so the dollar value of one yen is its RECIPROCAL;
 * GBP/USD already quotes dollars per pound and is used as it stands. Getting
 * this inversion backwards is the classic FX bug, and it is silent — it returns
 * a number of entirely plausible magnitude either way.
 */
function usdPerQuoteUnit(quote: string, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return NaN;
  const sym = CROSS_RATE_SYMBOL[quote];
  if (sym === undefined) return NaN;
  return sym.startsWith("USD") ? 1 / rate : rate;
}

/**
 * USD per one unit of the QUOTE currency — the single conversion factor that
 * every other currency figure on the desk is built from.
 *
 * This exists as one function because pip value and position notional are the
 * same conversion applied twice, and the table this was recovered from got them
 * wrong INDEPENDENTLY. Pip value used a stale constant; margin used
 * `entry × lot × contractSize` with no conversion at all, which on USD/JPY
 * reported the notional in yen and called it dollars — a 156× overstatement of
 * the margin required. Deriving both from one factor means there is exactly one
 * place for that class of bug to live, and it is this function.
 *
 *     pipValue     = pip × contractSize × quoteToUsd
 *     notionalUsd  = lots × contractSize × price × quoteToUsd
 *
 * Both identities hold for all three branches, which is the check that the
 * branches are right:
 *
 *   EUR/USD  quoteToUsd = 1        → pip 0.0001×100k×1 = $10          ✓
 *                                    notional 1×100k×1.0842×1 = $108,420 ✓
 *   USD/JPY  quoteToUsd = 1/price  → pip 0.01×100k/156.3 = $6.40      ✓
 *                                    notional 1×100k×156.3/156.3 = $100,000 ✓
 *                                    (one lot of USD/JPY is 100,000 USD, and
 *                                     the price cancels exactly as it should)
 */
export function quoteToUsd(spec: InstrumentSpec, price: number, crossRate?: number): PipValue {
  if (spec.quote === "USD") {
    return { value: 1, basis: { kind: "quote-usd" } };
  }

  if (spec.base === "USD") {
    /* The instrument's own price IS quote-per-USD, so one unit of the quote is
       worth 1/price dollars. No external rate, nothing to go stale. */
    if (!Number.isFinite(price) || price <= 0) {
      return { value: NaN, basis: { kind: "unknown", rateSymbol: spec.symbol } };
    }
    return { value: 1 / price, basis: { kind: "base-usd", price } };
  }

  const rateSymbol = CROSS_RATE_SYMBOL[spec.quote] ?? `USD${spec.quote}`;
  if (crossRate === undefined || !Number.isFinite(crossRate) || crossRate <= 0) {
    return { value: NaN, basis: { kind: "unknown", rateSymbol } };
  }
  const usd = usdPerQuoteUnit(spec.quote, crossRate);
  if (!Number.isFinite(usd)) return { value: NaN, basis: { kind: "unknown", rateSymbol } };
  return { value: usd, basis: { kind: "cross", rateSymbol, rate: crossRate } };
}

/**
 * Value of one pip of one lot, in USD.
 *
 * `price` is the instrument's own price and is needed only when USD is the
 * base. `crossRate` is the rate named by `CROSS_RATE_SYMBOL[spec.quote]` and is
 * needed only for the crosses; without it the value is NaN and the basis names
 * the rate that would fix it.
 */
export function pipValue(spec: InstrumentSpec, price: number, crossRate?: number): PipValue {
  const conv = quoteToUsd(spec, price, crossRate);
  return { value: spec.pip * spec.contractSize * conv.value, basis: conv.basis };
}

/** True when pip value needs a rate this instrument's own price cannot supply. */
export function needsCrossRate(spec: InstrumentSpec): boolean {
  return spec.quote !== "USD" && spec.base !== "USD";
}

export const INSTRUMENTS: readonly InstrumentSpec[] = [
  { symbol: "EURUSD", name: "EUR/USD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "USD" },
  { symbol: "GBPUSD", name: "GBP/USD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "GBP", quote: "USD" },
  { symbol: "USDJPY", name: "USD/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "USD", quote: "JPY" },
  { symbol: "AUDUSD", name: "AUD/USD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "AUD", quote: "USD" },
  { symbol: "USDCHF", name: "USD/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "CHF" },
  { symbol: "USDCAD", name: "USD/CAD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "CAD" },
  { symbol: "NZDUSD", name: "NZD/USD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "NZD", quote: "USD" },
  { symbol: "EURJPY", name: "EUR/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "EUR", quote: "JPY" },
  { symbol: "GBPJPY", name: "GBP/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "GBP", quote: "JPY" },
  { symbol: "EURGBP", name: "EUR/GBP", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "GBP" },
  { symbol: "AUDJPY", name: "AUD/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "AUD", quote: "JPY" },
  { symbol: "EURAUD", name: "EUR/AUD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "AUD" },
  { symbol: "EURCHF", name: "EUR/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "CHF" },
  { symbol: "EURCAD", name: "EUR/CAD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "CAD" },
  { symbol: "EURNZD", name: "EUR/NZD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "NZD" },
  { symbol: "GBPCHF", name: "GBP/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "GBP", quote: "CHF" },
  { symbol: "GBPCAD", name: "GBP/CAD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "GBP", quote: "CAD" },
  { symbol: "GBPAUD", name: "GBP/AUD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "GBP", quote: "AUD" },
  { symbol: "GBPNZD", name: "GBP/NZD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "GBP", quote: "NZD" },
  { symbol: "AUDCAD", name: "AUD/CAD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "AUD", quote: "CAD" },
  { symbol: "AUDCHF", name: "AUD/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "AUD", quote: "CHF" },
  { symbol: "AUDNZD", name: "AUD/NZD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "AUD", quote: "NZD" },
  { symbol: "NZDCAD", name: "NZD/CAD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "NZD", quote: "CAD" },
  { symbol: "NZDCHF", name: "NZD/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "NZD", quote: "CHF" },
  { symbol: "CADCHF", name: "CAD/CHF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "CAD", quote: "CHF" },
  { symbol: "NZDJPY", name: "NZD/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "NZD", quote: "JPY" },
  { symbol: "CADJPY", name: "CAD/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "CAD", quote: "JPY" },
  { symbol: "CHFJPY", name: "CHF/JPY", cls: "forex", pip: 0.01, contractSize: 100000, base: "CHF", quote: "JPY" },
  { symbol: "USDMXN", name: "USD/MXN", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "MXN" },
  { symbol: "USDZAR", name: "USD/ZAR", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "ZAR" },
  { symbol: "USDTRY", name: "USD/TRY", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "TRY" },
  { symbol: "USDSEK", name: "USD/SEK", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "SEK" },
  { symbol: "USDNOK", name: "USD/NOK", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "NOK" },
  { symbol: "USDPLN", name: "USD/PLN", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "PLN" },
  { symbol: "USDSGD", name: "USD/SGD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "SGD" },
  { symbol: "USDHKD", name: "USD/HKD", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "HKD" },
  { symbol: "USDCNH", name: "USD/CNH", cls: "forex", pip: 0.0001, contractSize: 100000, base: "USD", quote: "CNH" },
  { symbol: "EURTRY", name: "EUR/TRY", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "TRY" },
  { symbol: "EURPLN", name: "EUR/PLN", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "PLN" },
  { symbol: "EURSEK", name: "EUR/SEK", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "SEK" },
  { symbol: "EURNOK", name: "EUR/NOK", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "NOK" },
  { symbol: "EURHUF", name: "EUR/HUF", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "HUF" },
  { symbol: "EURCZK", name: "EUR/CZK", cls: "forex", pip: 0.0001, contractSize: 100000, base: "EUR", quote: "CZK" },
  { symbol: "BTCUSD", name: "BTC/USD", cls: "crypto", pip: 1, contractSize: 1, base: "BTC", quote: "USD" },
  { symbol: "ETHUSD", name: "ETH/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "ETH", quote: "USD" },
  { symbol: "SOLUSD", name: "SOL/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "SOL", quote: "USD" },
  { symbol: "XRPUSD", name: "XRP/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "XRP", quote: "USD" },
  { symbol: "BNBUSD", name: "BNB/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "BNB", quote: "USD" },
  { symbol: "DOGEUSD", name: "DOGE/USD", cls: "crypto", pip: 0.00001, contractSize: 1, base: "DOGE", quote: "USD" },
  { symbol: "ADAUSD", name: "ADA/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "ADA", quote: "USD" },
  { symbol: "AVAXUSD", name: "AVAX/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "AVAX", quote: "USD" },
  { symbol: "DOTUSD", name: "DOT/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "DOT", quote: "USD" },
  { symbol: "LINKUSD", name: "LINK/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "LINK", quote: "USD" },
  { symbol: "POLUSD", name: "POL (MATIC)/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "POL", quote: "USD" },
  { symbol: "LTCUSD", name: "LTC/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "LTC", quote: "USD" },
  { symbol: "TRXUSD", name: "TRX/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "TRX", quote: "USD" },
  { symbol: "SHIBUSD", name: "SHIB/USD", cls: "crypto", pip: 1e-8, contractSize: 1, base: "SHIB", quote: "USD" },
  { symbol: "UNIUSD", name: "UNI/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "UNI", quote: "USD" },
  { symbol: "ATOMUSD", name: "ATOM/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "ATOM", quote: "USD" },
  { symbol: "NEARUSD", name: "NEAR/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "NEAR", quote: "USD" },
  { symbol: "APTUSD", name: "APT/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "APT", quote: "USD" },
  { symbol: "ARBUSD", name: "ARB/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "ARB", quote: "USD" },
  { symbol: "OPUSD", name: "OP/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "OP", quote: "USD" },
  { symbol: "PEPEUSD", name: "PEPE/USD", cls: "crypto", pip: 1e-9, contractSize: 1, base: "PEPE", quote: "USD" },
  { symbol: "SUIUSD", name: "SUI/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "SUI", quote: "USD" },
  { symbol: "TONUSD", name: "TON/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "TON", quote: "USD" },
  { symbol: "ICPUSD", name: "ICP/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "ICP", quote: "USD" },
  { symbol: "FILUSD", name: "FIL/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "FIL", quote: "USD" },
  { symbol: "INJUSD", name: "INJ/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "INJ", quote: "USD" },
  { symbol: "WIFUSD", name: "WIF/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "WIF", quote: "USD" },
  { symbol: "BONKUSD", name: "BONK/USD", cls: "crypto", pip: 1e-8, contractSize: 1, base: "BONK", quote: "USD" },
  { symbol: "FLOKIUSD", name: "FLOKI/USD", cls: "crypto", pip: 1e-7, contractSize: 1, base: "FLOKI", quote: "USD" },
  { symbol: "SEIUSD", name: "SEI/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "SEI", quote: "USD" },
  { symbol: "TIAUSD", name: "TIA/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "TIA", quote: "USD" },
  { symbol: "JUPUSD", name: "JUP/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "JUP", quote: "USD" },
  { symbol: "RENDERUSD", name: "RENDER/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "RENDER", quote: "USD" },
  { symbol: "FETUSD", name: "FET/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "FET", quote: "USD" },
  { symbol: "ONDOUSD", name: "ONDO/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "ONDO", quote: "USD" },
  { symbol: "ENAUSD", name: "ENA/USD", cls: "crypto", pip: 0.0001, contractSize: 1, base: "ENA", quote: "USD" },
  { symbol: "PENGUUSD", name: "PENGU/USD", cls: "crypto", pip: 1e-6, contractSize: 1, base: "PENGU", quote: "USD" },
  { symbol: "HYPEUSD", name: "HYPE/USD", cls: "crypto", pip: 0.001, contractSize: 1, base: "HYPE", quote: "USD" },
  { symbol: "TAOUSD", name: "TAO/USD", cls: "crypto", pip: 0.01, contractSize: 1, base: "TAO", quote: "USD" },
  { symbol: "BTCPERP", name: "BTC-PERP", cls: "perp", pip: 0.1, contractSize: 1, base: "BTC", quote: "USD", maxLeverage: 125 },
  { symbol: "ETHPERP", name: "ETH-PERP", cls: "perp", pip: 0.01, contractSize: 1, base: "ETH", quote: "USD", maxLeverage: 100 },
  { symbol: "SOLPERP", name: "SOL-PERP", cls: "perp", pip: 0.001, contractSize: 1, base: "SOL", quote: "USD", maxLeverage: 75 },
  { symbol: "XRPPERP", name: "XRP-PERP", cls: "perp", pip: 0.0001, contractSize: 1, base: "XRP", quote: "USD", maxLeverage: 75 },
  { symbol: "BNBPERP", name: "BNB-PERP", cls: "perp", pip: 0.01, contractSize: 1, base: "BNB", quote: "USD", maxLeverage: 75 },
  { symbol: "DOGEPERP", name: "DOGE-PERP", cls: "perp", pip: 0.00001, contractSize: 1, base: "DOGE", quote: "USD", maxLeverage: 75 },
  { symbol: "AVAXPERP", name: "AVAX-PERP", cls: "perp", pip: 0.001, contractSize: 1, base: "AVAX", quote: "USD", maxLeverage: 50 },
  { symbol: "LINKPERP", name: "LINK-PERP", cls: "perp", pip: 0.001, contractSize: 1, base: "LINK", quote: "USD", maxLeverage: 50 },
  { symbol: "PEPEPERP", name: "PEPE-PERP", cls: "perp", pip: 1e-9, contractSize: 1, base: "PEPE", quote: "USD", maxLeverage: 25 },
  { symbol: "SUIPERP", name: "SUI-PERP", cls: "perp", pip: 0.0001, contractSize: 1, base: "SUI", quote: "USD", maxLeverage: 50 },
  { symbol: "XAUUSD", name: "Gold", cls: "metal", pip: 0.01, contractSize: 100, base: "XAU", quote: "USD" },
  { symbol: "XAGUSD", name: "Silver", cls: "metal", pip: 0.001, contractSize: 5000, base: "XAG", quote: "USD" },
  { symbol: "XPTUSD", name: "Platinum", cls: "metal", pip: 0.01, contractSize: 50, base: "XPT", quote: "USD" },
  { symbol: "XPDUSD", name: "Palladium", cls: "metal", pip: 0.01, contractSize: 100, base: "XPD", quote: "USD" },
  { symbol: "NAS100", name: "Nasdaq 100", cls: "index", pip: 0.01, contractSize: 1, base: "NAS100", quote: "USD" },
  { symbol: "US30", name: "Dow 30", cls: "index", pip: 1, contractSize: 1, base: "US30", quote: "USD" },
  { symbol: "SPX500", name: "S&P 500", cls: "index", pip: 0.1, contractSize: 1, base: "SPX500", quote: "USD" },
  { symbol: "GER40", name: "DAX 40", cls: "index", pip: 0.1, contractSize: 1, base: "GER40", quote: "EUR" },
  { symbol: "UK100", name: "FTSE 100", cls: "index", pip: 0.5, contractSize: 1, base: "UK100", quote: "GBP" },
  { symbol: "JPN225", name: "Nikkei 225", cls: "index", pip: 1, contractSize: 1, base: "JPN225", quote: "JPY" },
  { symbol: "AUS200", name: "ASX 200", cls: "index", pip: 0.1, contractSize: 1, base: "AUS200", quote: "AUD" },
  { symbol: "FRA40", name: "CAC 40", cls: "index", pip: 0.1, contractSize: 1, base: "FRA40", quote: "EUR" },
  { symbol: "EU50", name: "Euro Stoxx 50", cls: "index", pip: 0.1, contractSize: 1, base: "EU50", quote: "EUR" },
  { symbol: "HK50", name: "Hang Seng", cls: "index", pip: 1, contractSize: 1, base: "HK50", quote: "HKD" },
  { symbol: "US2000", name: "Russell 2000", cls: "index", pip: 0.1, contractSize: 1, base: "US2000", quote: "USD" },
  { symbol: "AAPL", name: "Apple", cls: "stock", pip: 0.01, contractSize: 1, base: "AAPL", quote: "USD" },
  { symbol: "NVDA", name: "Nvidia", cls: "stock", pip: 0.01, contractSize: 1, base: "NVDA", quote: "USD" },
  { symbol: "TSLA", name: "Tesla", cls: "stock", pip: 0.01, contractSize: 1, base: "TSLA", quote: "USD" },
  { symbol: "MSFT", name: "Microsoft", cls: "stock", pip: 0.01, contractSize: 1, base: "MSFT", quote: "USD" },
  { symbol: "AMZN", name: "Amazon", cls: "stock", pip: 0.01, contractSize: 1, base: "AMZN", quote: "USD" },
  { symbol: "GOOGL", name: "Alphabet", cls: "stock", pip: 0.01, contractSize: 1, base: "GOOGL", quote: "USD" },
  { symbol: "META", name: "Meta Platforms", cls: "stock", pip: 0.01, contractSize: 1, base: "META", quote: "USD" },
  { symbol: "NFLX", name: "Netflix", cls: "stock", pip: 0.01, contractSize: 1, base: "NFLX", quote: "USD" },
  { symbol: "AMD", name: "AMD", cls: "stock", pip: 0.01, contractSize: 1, base: "AMD", quote: "USD" },
  { symbol: "INTC", name: "Intel", cls: "stock", pip: 0.01, contractSize: 1, base: "INTC", quote: "USD" },
  { symbol: "AVGO", name: "Broadcom", cls: "stock", pip: 0.01, contractSize: 1, base: "AVGO", quote: "USD" },
  { symbol: "JPM", name: "JPMorgan Chase", cls: "stock", pip: 0.01, contractSize: 1, base: "JPM", quote: "USD" },
  { symbol: "V", name: "Visa", cls: "stock", pip: 0.01, contractSize: 1, base: "V", quote: "USD" },
  { symbol: "WMT", name: "Walmart", cls: "stock", pip: 0.01, contractSize: 1, base: "WMT", quote: "USD" },
  { symbol: "DIS", name: "Disney", cls: "stock", pip: 0.01, contractSize: 1, base: "DIS", quote: "USD" },
  { symbol: "BA", name: "Boeing", cls: "stock", pip: 0.01, contractSize: 1, base: "BA", quote: "USD" },
  { symbol: "KO", name: "Coca-Cola", cls: "stock", pip: 0.01, contractSize: 1, base: "KO", quote: "USD" },
  { symbol: "PFE", name: "Pfizer", cls: "stock", pip: 0.01, contractSize: 1, base: "PFE", quote: "USD" },
  { symbol: "XOM", name: "Exxon Mobil", cls: "stock", pip: 0.01, contractSize: 1, base: "XOM", quote: "USD" },
  { symbol: "COIN", name: "Coinbase", cls: "stock", pip: 0.01, contractSize: 1, base: "COIN", quote: "USD" },
  { symbol: "MSTR", name: "MicroStrategy", cls: "stock", pip: 0.01, contractSize: 1, base: "MSTR", quote: "USD" },
  { symbol: "PLTR", name: "Palantir", cls: "stock", pip: 0.01, contractSize: 1, base: "PLTR", quote: "USD" },

];

/**
 * SERIES YOU READ, NOT INSTRUMENTS YOU HOLD.
 *
 * A Treasury yield, a credit spread and an index level explain other markets;
 * none of them is a thing you can own lots of. They are kept in their own list
 * rather than as a flag on `INSTRUMENTS`, and the reason is a failure this file
 * caused the moment they were tried the other way: five calculator tests
 * immediately objected that a quote currency of "PCT" has no convertible rate,
 * because everything that sizes, converts or values a position walks the
 * instrument table.
 *
 * Teaching each of those consumers to skip a flag is the "find EVERY consumer"
 * trap CLAUDE.md records — the next consumer added would not know. Keeping them
 * out of the table means no sizing code can reach them by construction, and
 * `sizePosition` defaulting `contractSize` to 1 can never turn 4.43% into a
 * position measured in thousands.
 */
export const CONTEXT_SERIES: Readonly<Record<string, string>> = {
  DXY: "US Dollar Index",
  US10Y: "US 10-year yield",
  US1Y: "US 1-year yield",
  US10YR: "US 10-year REAL yield (TIPS)",
  HYOAS: "US high-yield credit spread",
  SPX: "S&P 500 index",
  NDX: "Nasdaq 100 index",
  VIX: "Volatility index",
  COPPER: "Copper front month",
};

/**
 * Whether this symbol is a context series rather than something tradeable.
 *
 * Unknown symbols are TRADEABLE: the catalogue holds thousands of venue symbols
 * this file has never heard of, and refusing to size one because it is absent
 * here would break every instrument not listed.
 */
export function isContextOnly(symbol: string): boolean {
  return Object.hasOwn(CONTEXT_SERIES, symbol.trim().toUpperCase());
}

const BY_SYMBOL: ReadonlyMap<string, InstrumentSpec> = new Map(
  INSTRUMENTS.map((i) => [i.symbol, i]),
);

/**
 * Look up a spec by symbol, tolerating the venue suffixes the feed uses.
 *
 * The chart says BTCUSDT and this table says BTCUSD. Refusing to connect the
 * two would mean the calculator could never prefill from the symbol you are
 * already looking at, which is most of the reason for having it in the same
 * terminal as the chart.
 */
export function findInstrument(symbol: string): InstrumentSpec | undefined {
  const up = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const direct = BY_SYMBOL.get(up);
  if (direct) return direct;
  /* USDT, USDC and BUSD all settle in dollars for this purpose. */
  const stripped = up.replace(/(USDT|USDC|BUSD)$/, "USD");
  return BY_SYMBOL.get(stripped);
}

/** Class labels, in the order the picker groups them. */
export const CLASS_LABEL: Readonly<Record<AssetClass, string>> = {
  forex: "Forex",
  crypto: "Crypto",
  perp: "Crypto perpetuals",
  metal: "Metals",
  index: "Indices",
  stock: "Stocks",
};
