/**
 * The related assets the AI proposes for a study, each with its reason.
 *
 * WHAT "CHOSEN BY AI" MEANS HERE, SAID PLAINLY
 * Not a model. The picks come from a fixed, declared map: `data/drivers.ts`
 * owns WHICH series are worth measuring against each asset class and why, and
 * this file adds the three things a steered study needs on top of it —
 *
 *   1. a ONE-LINE reason per pick, short enough to read beside a checkbox,
 *      with the full mechanism from `drivers.ts` kept for "Why?";
 *   2. a small number of picks `drivers.ts` does not carry (BTC for a
 *      non-BTC major, the volatility index and the other index for an equity
 *      index), each argued where it is declared;
 *   3. a filter to what the terminal can ACTUALLY LOAD.
 *
 * The third is the one that matters, and it is measured, not assumed. v5x
 * recorded a live study in which "DXY and US10Y loaded no bars from any
 * source" — so a study seeded from `driversFor` alone spent two of its five
 * slots on columns that were always empty. Probed against the running gateway
 * on 2026-09-21 (`/ohlc?provider=yfinance&interval=1h&limit=50`):
 *
 *     DXY       404        DX-Y.NYB  50 bars      ^VIX     50 bars
 *     US10Y     404        ^TNX      50 bars      XAGUSD   50 bars
 *     USOIL     404        SPX500    50 bars      NAS100   50 bars
 *     EURUSD    50 bars    USDJPY    50 bars      EURGBP   50 bars
 *
 * So `DXY` and `US10Y` are replaced by the tickers the free proxy can serve —
 * the ICE dollar index (`DX-Y.NYB`) and the CBOE 10-year yield index (`^TNX`)
 * — and anything with no known source is WITHHELD with its reason rather than
 * proposed. The MT5 bridge may serve more (a broker's own `DXY`), but whether
 * it does depends on the broker and on MT5 running, so it is not assumed here.
 *
 * WHAT THIS DOES NOT CLAIM
 * Any direction. "Gold usually moves against the dollar" is exactly the kind
 * of typed-in sign `data/macro.ts` refuses to hold, because those
 * relationships flip for months at a time. A reason here says what the series
 * IS and why it could matter; whether and which way it moves with the subject
 * is measured when the study runs.
 *
 * No DOM, no fetch — pure, so the proposals are testable per asset class.
 */

import { driversFor, familyOf, type AssetFamily, type Driver } from "../data/drivers";
import { looksCrypto } from "../data/venues";

/** One proposed related asset. */
export interface RelatedPick {
  /** The ticker that will be FETCHED — already translated to a loadable one. */
  readonly symbol: string;
  readonly label: string;
  /** One short line: what it is, and why it is here. No direction claimed. */
  readonly reason: string;
  /** The full mechanism, for "Why?". */
  readonly why: string;
  /** `drivers.ts`'s role — lead may predict, context describes. */
  readonly driverRole: "lead" | "context";
  /** Where the bars come from, in the operator's words. */
  readonly source: string;
}

/** A relationship the map knows about and that could not be proposed. */
export interface Withheld {
  readonly symbol: string;
  readonly label: string;
  readonly reason: string;
}

export interface RelatedProposal {
  readonly subject: string;
  readonly family: AssetFamily | null;
  readonly picks: readonly RelatedPick[];
  readonly withheld: readonly Withheld[];
  /** One line for the top of the card. */
  readonly intro: string;
}

/**
 * Map tickers the proxy cannot serve onto ones it can.
 *
 * Only where the replacement measures the SAME thing. The ICE dollar index is
 * what "DXY" means; `^TNX` is the 10-year yield (Yahoo quotes it in tenths of
 * a percent on some endpoints, which a return-based study does not notice).
 */
export const LOADABLE_ALIAS: Readonly<Record<string, { readonly symbol: string; readonly note: string }>> = {
  DXY: { symbol: "DX-Y.NYB", note: "The ICE dollar index under its Yahoo ticker — `DXY` itself returns nothing from the free proxy (measured: 404)." },
  US10Y: { symbol: "^TNX", note: "The CBOE 10-year yield index under its Yahoo ticker — `US10Y` returns nothing from the free proxy (measured: 404)." },
};

/**
 * Non-crypto symbols the local proxy serves, per its own symbol map
 * (`server/ddt_data_server.py`: FX_PAIRS, METALS, YF_INDEX) plus the three
 * Yahoo tickers measured above. Crypto is served by Binance and recognised by
 * `looksCrypto`, the same test the registry uses to route it.
 */
const PROXY_SERVED: ReadonlySet<string> = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "USDCAD", "NZDUSD",
  "EURJPY", "GBPJPY", "EURGBP", "AUDJPY", "EURAUD",
  "XAUUSD", "XAGUSD",
  "SPX500", "NAS100", "US30", "US2000",
  "DX-Y.NYB", "^TNX", "^VIX",
]);

/** Where a symbol's bars come from, or null when nothing here is known to serve it. */
export function sourceOf(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (s === "") return null;
  if (looksCrypto(s)) return "Binance";
  if (PROXY_SERVED.has(s)) return "local proxy (Yahoo, delayed)";
  return null;
}

/** The default loadability test — `sourceOf` answered. */
export const canLoad = (symbol: string): boolean => sourceOf(symbol) !== null;

/** Short reasons, by the symbol `drivers.ts` uses. What it is, never which way. */
const SHORT: Readonly<Record<string, string>> = {
  DXY: "Dollar index — most of what is traded here is priced in dollars",
  US10Y: "10-year yield — the price of money",
  SPX500: "S&P 500 — broad risk appetite",
  XAUUSD: "Gold — the other store-of-value trade",
  ETHUSDT: "Ether — crypto's second-largest market",
  BTCUSDT: "Bitcoin — most of crypto moves with it",
  XAGUSD: "Silver — the closest metal to gold",
};

/**
 * Picks `drivers.ts` does not carry, by family.
 *
 * Kept here rather than added to the driver map because the map feeds the
 * training panel too (`driverUniverse`), and a change there moves every model
 * that reads it. These affect only what a study is SEEDED with, and the
 * operator can switch each one off.
 */
const EXTRA: Readonly<Partial<Record<AssetFamily, readonly Driver[]>>> = {
  /* ETH's own driver set has no BTC in it — `crypto-major` lists ETH for BTC
     and nothing for ETH. The largest single influence on ETH is missing. */
  "crypto-major": [
    {
      symbol: "BTCUSDT",
      label: "Bitcoin",
      why: "The dominant beta of the asset class. When a major other than BTC moves, the first question is how much of it was BTC's move.",
      role: "lead",
    },
  ],
  /* An index measured only against yields, the dollar and gold has nothing in
     it that describes the equity market's own conditions. */
  "equity-index": [
    {
      symbol: "^VIX",
      label: "Volatility index",
      why: "Implied volatility on the S&P. It describes the conditions rather than the move, so it slices the result instead of predicting it.",
      role: "context",
    },
    {
      symbol: "NAS100",
      label: "Nasdaq 100",
      why: "The other large US index — mostly the same risk, weighted to technology. A move one makes without the other is the informative part.",
      role: "context",
    },
    {
      symbol: "SPX500",
      label: "S&P 500",
      why: "The broadest US index — for another index, the market it is a slice of.",
      role: "context",
    },
  ],
};

const EXTRA_SHORT: Readonly<Record<string, string>> = {
  "^VIX": "Volatility index — describes the conditions",
  NAS100: "Nasdaq 100 — tech-weighted US risk",
};

/** Per-family refinements of a short reason, where the generic one misleads. */
const FAMILY_SHORT: Readonly<Partial<Record<AssetFamily, Readonly<Record<string, string>>>>> = {
  gold: {
    DXY: "Dollar index — gold is priced in dollars",
    US10Y: "10-year yield — what holding gold costs you (nominal; no real-yield series loads here)",
  },
  "fx-major": {
    DXY: "Dollar index — the dollar side of most pairs",
    US10Y: "10-year yield — US rates, one side of the rate gap",
  },
  "equity-index": {
    US10Y: "10-year yield — the discount rate for stocks",
  },
};

/** Series the map would like and nothing here can load — named, never dropped silently. */
const WANTED_UNLOADABLE: Readonly<Partial<Record<AssetFamily, readonly Withheld[]>>> = {
  gold: [
    {
      symbol: "real yield",
      label: "US 10-year real yield",
      reason: "No source here serves an inflation-linked yield. The nominal 10-year stands in, and it is not the same thing — it moves with inflation expectations too.",
    },
  ],
  "fx-major": [
    {
      symbol: "rate gap",
      label: "Two-country rate differential",
      reason: "No source here serves foreign government yields, so the gap between the two rates cannot be built. The US 10-year is the one side that loads.",
    },
  ],
};

export interface ProposeOptions {
  /** Loadability test. Defaults to `canLoad`; injectable for other registries and tests. */
  readonly loadable?: (symbol: string) => boolean;
}

/**
 * The related assets for one subject.
 *
 * Returns NOTHING for a symbol whose family is unknown, exactly as
 * `driversFor` does: guessing the crypto set for an unrecognised ticker would
 * seed a study with the wrong columns and report numbers for it.
 */
export function proposeRelated(subject: string, opts: ProposeOptions = {}): RelatedProposal {
  const loadable = opts.loadable ?? canLoad;
  const self = subject.trim().toUpperCase();
  const family = familyOf(self);

  if (family === null) {
    return {
      subject: self,
      family,
      picks: [],
      withheld: [],
      intro:
        self === ""
          ? "Pick an asset first."
          : `No relationships are declared for ${self}, so the AI adds nothing rather than guess. Add your own below.`,
    };
  }

  const base = driversFor(self);
  const extra = (EXTRA[family] ?? []).filter((d) => d.symbol.toUpperCase() !== self);
  const seen = new Set<string>();
  const picks: RelatedPick[] = [];
  const withheld: Withheld[] = [...(WANTED_UNLOADABLE[family] ?? [])];

  for (const d of [...base, ...extra]) {
    const alias = LOADABLE_ALIAS[d.symbol.toUpperCase()];
    const symbol = (alias?.symbol ?? d.symbol).toUpperCase();
    if (symbol === self || seen.has(symbol)) continue;
    seen.add(symbol);

    const reason =
      FAMILY_SHORT[family]?.[d.symbol] ?? SHORT[d.symbol] ?? EXTRA_SHORT[d.symbol] ?? `${d.label}`;

    if (!loadable(symbol)) {
      withheld.push({
        symbol,
        label: d.label,
        reason: `Nothing here is known to serve ${symbol}, so it is left out rather than added as an empty column.`,
      });
      continue;
    }

    const source = sourceOf(symbol) ?? "an injected source";
    picks.push({
      symbol,
      label: d.label,
      reason,
      why: [
        d.why,
        d.role === "lead"
          ? "Treated as possibly moving first, so it may be used as a predictor."
          : "Treated as moving together or describing conditions, not as a predictor.",
        alias === undefined ? "" : alias.note,
        `Bars from ${source}.`,
      ]
        .filter((s) => s !== "")
        .join(" "),
      driverRole: d.role,
      source,
    });
  }

  return {
    subject: self,
    family,
    picks,
    withheld,
    intro:
      picks.length === 0
        ? `Nothing related to ${self} can be loaded here, so the AI adds nothing. Add your own below.`
        : `For ${self}, these usually matter. How closely each really moves with it is measured when you run.`,
  };
}

/** One row of the related-assets list: a proposal or the operator's own addition. */
export interface RelatedRow {
  readonly symbol: string;
  readonly label: string;
  readonly reason: string;
  readonly why: string;
  readonly who: "ai" | "you";
  /** In the study right now. An AI pick switched off stays listed so it can come back. */
  readonly on: boolean;
}

/**
 * Merge the proposal with what the study actually holds.
 *
 * The study's context is the ONE owner of what is in: a pick is on exactly
 * when its symbol is in the context. So an operator's removal needs no second
 * list to be remembered — it is the absence — and a saved study reopened later
 * shows the AI's current proposals with the ones the operator had dropped
 * still off.
 */
export function relatedRows(
  proposal: RelatedProposal,
  context: readonly { readonly symbol: string; readonly label: string; readonly why: string }[],
): RelatedRow[] {
  const inStudy = new Set(context.map((c) => c.symbol.toUpperCase()));
  const proposed = new Set(proposal.picks.map((p) => p.symbol));
  return [
    ...proposal.picks.map((p) => ({
      symbol: p.symbol,
      label: p.label,
      reason: p.reason,
      why: p.why,
      who: "ai" as const,
      on: inStudy.has(p.symbol),
    })),
    ...context
      .filter((c) => !proposed.has(c.symbol.toUpperCase()))
      .map((c) => ({
        symbol: c.symbol,
        label: c.label,
        reason:
          sourceOf(c.symbol) === null
            ? "Added by you · no known source, tried when you run"
            : "Added by you",
        why:
          c.why.trim() === ""
            ? `You added ${c.symbol}. No mechanism is stated for it, so a result about it should be read with that in mind.`
            : c.why,
        who: "you" as const,
        on: true,
      })),
  ];
}

/**
 * The picks that go into a new study, minus any the operator has removed.
 */
export function chosenPicks(proposal: RelatedProposal, removed: ReadonlySet<string> = new Set()): RelatedPick[] {
  const drop = new Set([...removed].map((s) => s.toUpperCase()));
  return proposal.picks.filter((p) => !drop.has(p.symbol));
}
