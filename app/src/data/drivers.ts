/**
 * What each instrument's price actually depends on.
 *
 * WHY A CURATED MAP AND NOT "EVERYTHING THE VENUE LISTS"
 * The terminal can enumerate several thousand symbols. Handing all of them to
 * a model as candidate features is the fastest possible route to a beautiful
 * backtest and a worthless one — and this codebase already has a measured
 * example of what that costs: the confluence score's PBO is 89%, which is what
 * fitting noise looks like when you finally test for it. A model with 3,000
 * columns and 900 rows will find something every time.
 *
 * So the universe is declared, small, and every column is here for a stated
 * reason. `why` is not documentation; it is the thing you argue with when the
 * model says a driver mattered. A feature nobody can explain the mechanism for
 * is a feature that will not survive out of sample.
 *
 * WHAT THIS IS NOT
 * It is NOT a claim that these relationships hold. `macro.ts` says it plainly
 * for the same series — BTC against DXY has run strongly negative, near zero
 * and positive in stretches of months — and nothing here overrides that. This
 * says "these are the series worth MEASURING against this instrument", and
 * measuring is what the panel and the training run are for. The sign, the
 * strength and whether it is there at all are outputs, never inputs.
 *
 * WHY THE SYMBOLS ARE REAL ONES
 * Every symbol below is one the source registry can actually resolve — the
 * four macro series come from the same lane `macro.ts` already reads, and the
 * crypto legs are Binance pairs. A driver map full of tickers that return
 * nothing produces a training panel full of empty columns, which a model will
 * happily fit around.
 */

/** One series another instrument is worth measuring against. */
export interface Driver {
  readonly symbol: string;
  readonly label: string;
  /**
   * The MECHANISM, in one sentence. Why this could move that.
   *
   * Required, and deliberately awkward to fill in: if you cannot state the
   * channel, the column does not belong in the panel.
   */
  readonly why: string;
  /**
   * `lead` means this series is thought to move first and is therefore usable
   * as a predictor; `context` means it moves together and is a regime
   * descriptor, not a signal. Lagging both into a model without the
   * distinction is how a contemporaneous correlation becomes a "forecast".
   */
  readonly role: "lead" | "context";
}

/** The families an instrument can belong to. */
export type AssetFamily = "crypto-major" | "crypto-alt" | "gold" | "fx-major" | "equity-index" | "energy";

const DXY: Driver = {
  symbol: "DXY",
  label: "Dollar index",
  why: "Almost everything here is priced in dollars, so the unit of account moving is not the same as the asset moving.",
  role: "context",
};
const US10Y: Driver = {
  symbol: "US10Y",
  label: "US 10-year yield",
  why: "The discount rate for every long-duration asset, and the opportunity cost of holding one that yields nothing.",
  role: "lead",
};
const SPX: Driver = {
  symbol: "SPX500",
  label: "S&P 500",
  why: "The broadest read on risk appetite; crypto and commodities have both traded as risk assets for long stretches.",
  role: "context",
};
const GOLD: Driver = {
  symbol: "XAUUSD",
  label: "Gold",
  why: "The other thing people buy when they distrust currency debasement — sometimes a substitute for BTC, sometimes a complement.",
  role: "context",
};

/**
 * Drivers by family.
 *
 * Kept small on purpose. Four to six columns against a few thousand bars is a
 * ratio a walk-forward can actually validate; twenty is not.
 */
export const DRIVERS: Readonly<Record<AssetFamily, readonly Driver[]>> = {
  "crypto-major": [
    DXY,
    US10Y,
    SPX,
    GOLD,
    {
      symbol: "ETHUSDT",
      label: "Ether",
      why: "The second leg of the same asset class — when BTC and ETH diverge, the move is usually idiosyncratic rather than macro.",
      role: "context",
    },
  ],
  "crypto-alt": [
    {
      symbol: "BTCUSDT",
      label: "Bitcoin",
      why: "The dominant beta of the asset class. Most alt moves are BTC's move plus a residual, and the residual is the only part that is about the alt.",
      role: "lead",
    },
    {
      symbol: "ETHUSDT",
      label: "Ether",
      why: "The second beta, and the settlement layer a large share of alts actually live on.",
      role: "lead",
    },
    DXY,
    SPX,
  ],
  gold: [
    DXY,
    US10Y,
    SPX,
    {
      symbol: "XAGUSD",
      label: "Silver",
      why: "The same monetary-metal bid with more industrial demand in it; the ratio between them separates the two stories.",
      role: "context",
    },
  ],
  "fx-major": [
    DXY,
    US10Y,
    SPX,
    GOLD,
  ],
  "equity-index": [
    US10Y,
    DXY,
    GOLD,
  ],
  energy: [
    DXY,
    SPX,
    GOLD,
  ],
};

/* Declared ABOVE `familyOf`, which reads it. It works either way here — the
   function is only called after the module has evaluated — but a `const` below
   its reader is the temporal-dead-zone shape that has taken this codebase down
   three times, and it is not worth keeping the habit. */
const FX_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "SEK", "NOK", "MXN", "ZAR", "TRY", "CNH",
]);

const CRYPTO_MAJORS = new Set(["BTCUSDT", "BTCUSD", "BTCUSDC", "ETHUSDT", "ETHUSD", "XBTUSD"]);
const METALS = new Set(["XAUUSD", "XAUUSDT", "GOLD", "XAGUSD", "SILVER"]);
const INDICES = new Set(["SPX500", "US500", "NAS100", "US30", "GER40", "UK100", "JP225"]);
const ENERGY = new Set(["USOIL", "UKOIL", "WTI", "BRENT", "NATGAS"]);

/**
 * Which family a symbol belongs to.
 *
 * Returns null rather than guessing. An unrecognised symbol getting the crypto
 * driver set by default would silently train a model on the wrong four columns
 * and report a number for it.
 */
export function familyOf(symbol: string): AssetFamily | null {
  const s = symbol.toUpperCase().trim();
  if (s === "") return null;
  if (CRYPTO_MAJORS.has(s)) return "crypto-major";
  if (METALS.has(s)) return "gold";
  if (INDICES.has(s)) return "equity-index";
  if (ENERGY.has(s)) return "energy";
  /* A quote-currency suffix is the only reliable structural hint left. USDT
     and USDC pairs are crypto; a six-letter pair of known currency codes is FX. */
  if (s.endsWith("USDT") || s.endsWith("USDC") || s.endsWith("BUSD")) return "crypto-alt";
  if (s.length === 6 && FX_CODES.has(s.slice(0, 3)) && FX_CODES.has(s.slice(3))) return "fx-major";
  return null;
}

/**
 * The drivers worth storing and measuring for this instrument.
 *
 * NEVER includes the instrument itself — a column that is the target shifted
 * by nothing is a perfect predictor of the target, and a panel builder that
 * allows it will report an AUC near 1.0 and mean nothing by it.
 */
export function driversFor(symbol: string): readonly Driver[] {
  const fam = familyOf(symbol);
  if (fam === null) return [];
  const self = symbol.toUpperCase().trim();
  return DRIVERS[fam].filter((d) => d.symbol.toUpperCase() !== self);
}

/** Every distinct symbol the store needs to hold, for a set of instruments. */
export function driverUniverse(symbols: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of symbols) for (const d of driversFor(s)) out.add(d.symbol);
  return [...out].sort();
}

/** One line for the UI: what this instrument is measured against, and why. */
export function driverSummary(symbol: string): string {
  const fam = familyOf(symbol);
  if (fam === null) {
    return `No driver set is declared for ${symbol}. It will be modelled on its own history only — nothing is being guessed about what moves it.`;
  }
  const ds = driversFor(symbol);
  const leads = ds.filter((d) => d.role === "lead").length;
  return `${symbol} is a ${fam.replace("-", " ")} instrument, measured against ${ds.length} driver${
    ds.length === 1 ? "" : "s"
  } (${leads} treated as possibly leading). Whether any of them actually matters is measured, not assumed.`;
}
