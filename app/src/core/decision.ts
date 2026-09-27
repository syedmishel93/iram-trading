/**
 * The assembler — every source, one shape.
 *
 * This is the file that makes the terminal cohesive rather than a collection of
 * panels. Each contributor below takes what one subsystem already produces and
 * converts it into `Evidence`: a lean, a weight, a sentence, a provenance, and
 * — when it can say one — what would flip it. `synthesise` in core/evidence.ts
 * does the rest.
 *
 * THE WEIGHTS ARE DECLARED HERE, IN ONE TABLE, ON PURPOSE
 * Scattering them across eight modules is how a blend becomes unauditable: you
 * cannot ask "why does funding matter this much" if the answer is spread over
 * four files. Every number in `WEIGHTS` has a comment saying what it is relative
 * to. None of them is fitted — fitting weights to past outcomes is precisely how
 * the confluence score reached a PBO of 89%, and this assembly would inherit
 * that the moment anyone optimised it.
 *
 * WHAT EVERY CONTRIBUTOR MUST DO
 * Return evidence even when it has nothing. A source that stays silent when it
 * cannot answer is invisible to `coverage`, and the read then reports the same
 * confidence whether it consulted nine sources or two. `absent()` and `failed()`
 * exist for exactly that, and every branch below uses one of them.
 */

import {
  absent,
  ageCheck,
  failed,
  unavailable,
  synthesise,
  type Evidence,
  type Read,
} from "./evidence";
import type { ConfluenceResult } from "../scan/confluence";
import type { Detection } from "../detect/types";
import type { DerivRead } from "../data/derivs";
import type { SpreadRead } from "../data/spread";
import type { CorrelationMatrix } from "../data/correlation";
import type { DerivedFundamentals, Fundamentals } from "../data/fundamentals";

/**
 * Relative importance. Each comment says what the number is relative TO.
 *
 * These are judgements, not fits. The ordering is the claim: what price is
 * doing outranks what a model thinks about it, and both outrank what the asset
 * is — because a great asset with broken structure is still a bad entry, and
 * that is the mistake this ordering exists to resist.
 */
export const WEIGHTS = {
  /** Highest: it is the thing you are looking at. */
  structure: 1,
  /** Equal to structure — the confluence engine reads the same price. */
  confluence: 1,
  /** Higher-timeframe context outranks either, when it exists. */
  higherTimeframe: 1,
  /** Positioning moves price on a horizon of hours to days. */
  derivatives: 0.7,
  /** A statistical read on a regime, not on a direction. */
  regime: 0.5,
  /** Gated hard by its own calibration; see the contributor. */
  forecast: 0.4,
  /** Informational: changes what a pattern is worth, not which way it points. */
  fundamentals: 0.4,
  /** Informational, and only occasionally decisive. */
  onchain: 0.3,
  /** Almost never directional. It tells you the price is odd. */
  venue: 0.3,
  /** Never directional. It tells you your risk is not what you think. */
  correlation: 0.3,
  /**
   * Never directional either. A scheduled release does not say which way price
   * goes — it says the current read may stop being true at a known minute.
   *
   * Low weight because its job is not to move the score. Its job is to be
   * COUNTED: a calendar that answered is a piece of context the read has, and
   * one that did not is a gap in coverage like any other.
   */
  calendar: 0.3,
  /**
   * Participation withdrawing from a move that is still going.
   *
   * NOT the whole leading composite — only its `thinning` family. The
   * `committed` family of that composite reads funding and open interest, and
   * `derivatives` above already reads exactly those, from the same venue. Two
   * contributors fed by one measurement is not corroboration, it is the same
   * vote counted twice with a second label on it, and it would inflate
   * agreement in precisely the crowded conditions where agreement is most
   * misleading.
   *
   * Below `derivatives` because divergence is famously right eventually and
   * ruinous meanwhile.
   */
  thinning: 0.4,
  /**
   * Volatility compression. Lean is ALWAYS null, like the calendar.
   *
   * A squeeze constrains WHEN, never which way. Every platform that draws an
   * arrow out of one is inventing the half of the signal that does not exist.
   */
  coiled: 0.3,
} as const;

/** Beyond this a derivatives read is stale — funding publishes 3x a day. */
const DERIV_MAX_AGE_MS = 30 * 60_000;

/** Beyond this a fundamentals row is stale. Cached hourly. */
const FUNDAMENTAL_MAX_AGE_MS = 3 * 60 * 60_000;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface DecisionInputs {
  readonly symbol: string;
  readonly timeframe: string;
  readonly now: number;

  readonly confluence: ConfluenceResult | null;
  /** Detections on CLOSED bars, newest last. */
  readonly detections: readonly Detection[];
  /** Higher timeframes the user enabled, with the projected read. */
  readonly higher: readonly { timeframe: string; bias: string; score: number }[];
  readonly higherEnabled: readonly string[];

  readonly regime: { ok: boolean; state?: string; confidence?: number; error?: string } | null;
  readonly forecast:
    | { ok: boolean; pUp?: number; usable?: boolean; standing?: string; error?: string }
    | null;

  readonly derivatives: { read: DerivRead | null; asOf: number; error?: string } | null;
  readonly fundamentals: { row: Fundamentals; derived: DerivedFundamentals; asOf: number } | null;
  readonly spread: SpreadRead | null;
  readonly correlation: { matrix: CorrelationMatrix; openPositions: number } | null;
  readonly onchain: { ok: boolean; lean: number | null; reason: string; asOf: number; error?: string } | null;
  /**
   * The scheduled-release read for THIS instrument's currencies.
   *
   * `discount` is 0..1 — how much of the confidence in any structural read the
   * next print is currently eating. See data/calendar.ts releaseRisk.
   */
  /**
   * Measured correlation to the macro lane, already turned into evidence.
   *
   * Optional and empty by default. Every entry's lean is derived from the
   * CURRENTLY measured coefficient rather than from any rule about what the
   * dollar does to crypto — see `data/macro.ts` for why that distinction is
   * the whole design.
   */
  readonly macro?: readonly Evidence[];
  readonly calendar: { ok: boolean; discount: number; note: string; error?: string } | null;
  /**
   * The leading read, split along the axis it declares.
   *
   * Deliberately NOT passed as one object with a single score. The composite in
   * analysis/leading.ts keeps timing, direction and conviction apart because
   * they answer different questions, and collapsing them here would undo that
   * at the last step — which is where it would be hardest to notice.
   */
  readonly leading: {
    ok: boolean;
    /** 0..1 — how close a range expansion looks. Never a direction. */
    timing: number;
    coiledReason: string;
    /** −1..+1 from the thinning family only, or null when it had no reading. */
    thinningLean: number | null;
    thinningReason: string;
    /** 0..1 share of the composite that answered. */
    coverage: number;
    error?: string;
  } | null;
}

/* --------------------------------------------------------- contributors -- */

function fromConfluence(c: ConfluenceResult | null): Evidence {
  if (!c) {
    return failed("confluence", "trend", "Confluence", WEIGHTS.confluence, "Not computed for this series.");
  }
  if (c.insufficient !== null) {
    return absent("confluence", "trend", "Confluence", WEIGHTS.confluence, c.insufficient);
  }
  const top = c.signals[0];
  return {
    id: "confluence",
    group: "trend",
    label: "Confluence",
    lean: clamp(c.score, -1, 1),
    /* Scaled by the engine's OWN confidence, which it already gates on
       volatility. Double-counting that gate here would punish a violent trend
       twice for being violent. */
    weight: WEIGHTS.confluence * clamp(c.confidence, 0, 1),
    reason: `${c.signals.length} indicator modules, ${(c.agreement * 100).toFixed(0)}% agreeing.${top ? ` Strongest: ${top.reason}` : ""}`,
    source: "local indicators",
    asOf: 0,
    state: "fresh",
    flip: "a close that reverses the moving-average stack it is reading",
  };
}

function fromStructure(detections: readonly Detection[], timeframe: string): Evidence {
  if (detections.length === 0) {
    return absent(
      "structure",
      "structure",
      "Market structure",
      WEIGHTS.structure,
      "No chart patterns found.",
    );
  }

  /**
   * The most recent CONFIRMED break, not an average of everything on screen.
   *
   * Averaging structure is meaningless: a break from two hundred bars ago and
   * one from yesterday do not blend into a half-break. The newest confirmed
   * directional structure is the one the market is currently trading against.
   */
  const directional = detections.filter((d) => d.direction !== "neutral");
  const last = directional[directional.length - 1];

  if (!last) {
    return {
      id: "structure",
      group: "structure",
      label: "Market structure",
      lean: null,
      weight: WEIGHTS.structure,
      reason: `${detections.length} pattern(s) found, none pointing a direction — levels and zones only.`,
      source: `${timeframe} detectors`,
      asOf: 0,
      state: "fresh",
    };
  }

  const lean = (last.direction === "long" ? 1 : -1) * clamp(last.confidence, 0, 1);
  return {
    id: "structure",
    group: "structure",
    label: "Market structure",
    lean,
    weight: WEIGHTS.structure,
    reason: `${last.label} — ${last.reason}`,
    source: `${timeframe} detectors`,
    asOf: 0,
    state: "fresh",
    flip: `a confirmed break the other way invalidates it; so does a close back through the level that created it`,
  };
}

function fromHigherTimeframes(
  higher: readonly { timeframe: string; bias: string; score: number }[],
  enabled: readonly string[],
): Evidence {
  if (enabled.length === 0) {
    return absent(
      "htf",
      "trend",
      "Higher timeframes",
      WEIGHTS.higherTimeframe,
      "No higher timeframe turned on — missing context, not a neutral signal. Turn one on in Study.",
    );
  }
  if (higher.length === 0) {
    return absent(
      "htf",
      "trend",
      "Higher timeframes",
      WEIGHTS.higherTimeframe,
      `${enabled.join(", ")} enabled but no structure projected down yet.`,
    );
  }

  const leans = higher.map((h) => (h.bias === "long" ? 1 : h.bias === "short" ? -1 : 0) * clamp(h.score, 0, 1));
  const mean = leans.reduce((a, b) => a + b, 0) / leans.length;

  return {
    id: "htf",
    group: "trend",
    label: "Higher timeframes",
    lean: clamp(mean, -1, 1),
    weight: WEIGHTS.higherTimeframe,
    reason: higher.map((h) => `${h.timeframe} ${h.bias}`).join(", "),
    source: "projected structure",
    asOf: 0,
    state: "fresh",
    flip: `a change of character on ${higher[0]?.timeframe ?? "the higher timeframe"}`,
  };
}

function fromRegime(r: DecisionInputs["regime"]): Evidence {
  if (!r) {
    return absent("regime", "model", "Regime model", WEIGHTS.regime, "Not requested for this series.");
  }
  if (!r.ok) {
    return failed("regime", "model", "Regime model", WEIGHTS.regime, r.error ?? "The model declined.");
  }

  const state = r.state ?? "";

  /**
   * THE REGIME CONTRIBUTES NO DIRECTION, AND THE WEIGHT TABLE ALREADY SAID SO.
   *
   * `WEIGHTS.regime` is annotated "A statistical read on a regime, not on a
   * direction." The code under it did the opposite: it matched the state label
   * and returned a full-strength lean scaled by the mixture's confidence. Two
   * things were wrong with that, and the first is why the second could not be
   * patched.
   *
   * 1. THE LABELS COLLIDED. `server/mishel_hmm.py` named its three states
   *    "PANIC/high-vol", "TREND-UP" and "CHOP/TREND-DN", and the down test was
   *    `/TREND-DN|PANIC/`. A SIDEWAYS market matched, because chop and
   *    downtrend shared one string, and voted short at whatever confidence the
   *    mixture reported — measured at 0.63 on BTCUSDT 1m, on a chart the model
   *    itself had classified as going nowhere. High volatility matched too, on
   *    the strength of the word "panic"; a vertical rally is high-vol and so
   *    is a crash. The labels are now distinct and readable.
   *
   * 2. THE SEPARATION IS AN ARTEFACT OF THE FIT. This is the one that closes
   *    the question. The model is a Gaussian mixture over (return, rolling
   *    volatility) — it CLUSTERS ON RETURN. Its components are therefore
   *    separated by mean return by construction, and one of them has a
   *    positive mean for the same reason that splitting any sample at its
   *    centre produces a half above it. Measured: on eight driftless random
   *    walks, the fitted state still carried a named direction on two of them,
   *    and no significance threshold fixes that, because the standard error of
   *    a SELECTED subsample does not describe a selection.
   *
   * So the state is filed as context — which is what it is. It says what kind
   * of market this has been over the last 48 bars, it counts toward coverage
   * like every other source that answered, and it does not push the score
   * either way. Direction is what `structure`, `confluence` and
   * `higherTimeframe` are weighted 1 for.
   */
  const lean = 0;

  return {
    id: "regime",
    group: "model",
    label: "Regime model",
    lean,
    weight: WEIGHTS.regime,
    reason: `${state} (${((r.confidence ?? 0) * 100).toFixed(0)}% confidence) — what kind of market this has been, not where it goes next. Counts toward data coverage but does not push the score either way.`,
    source: "local Python service",
    asOf: 0,
    state: "fresh",
    flip: "a shift in realised volatility moves the mixture between states",
  };
}

function fromForecast(f: DecisionInputs["forecast"]): Evidence {
  if (!f) {
    return absent("forecast", "model", "Forecast", WEIGHTS.forecast, "Not requested for this series.");
  }
  if (!f.ok) {
    return failed("forecast", "model", "Forecast", WEIGHTS.forecast, f.error ?? "The classifier declined.");
  }

  /**
   * An uncalibrated classifier contributes NOTHING, and says so.
   *
   * This is the single most important gate in the file. A probability from a
   * model whose Brier score is worse than always saying 50% is not weak
   * evidence — it is not evidence, and letting it in at reduced weight would be
   * laundering noise into a number that looks considered.
   */
  if (f.usable !== true) {
    return {
      id: "forecast",
      group: "model",
      label: "Forecast",
      lean: null,
      weight: WEIGHTS.forecast,
      reason: `Withheld. ${f.standing ?? "The model is not accurate enough here for its probability to be trusted."}`,
      source: "local Python service",
      asOf: 0,
      state: "fresh",
    };
  }

  const p = clamp(f.pUp ?? 0.5, 0, 1);
  return {
    id: "forecast",
    group: "model",
    label: "Forecast",
    /* Centred on 0.5 and doubled: p=0.6 is a lean of +0.2, not +0.6. */
    lean: clamp((p - 0.5) * 2, -1, 1),
    weight: WEIGHTS.forecast,
    reason: `p(up) ${(p * 100).toFixed(1)}%. ${f.standing ?? ""}`,
    source: "local Python service",
    asOf: 0,
    state: "fresh",
    flip: "the walk-forward accuracy falling back inside the noise band",
  };
}

/**
 * True when the instrument has no perpetual, no crypto venue book, and no
 * listing in a market-cap aggregator — so three of the twelve sources are not
 * gaps to be closed but questions with no answer.
 *
 * Duplicated from `looksCrypto` deliberately: `core/` must not import from
 * `data/`, and the list of crypto quote currencies is a fact about naming, not
 * about the venue layer. Kept minimal for that reason — a symbol this does not
 * recognise is treated as non-crypto, which understates the ceiling rather than
 * overstating it, and understating is the safe direction for a floor check.
 */
const CRYPTO_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "BTC", "ETH", "BNB", "USD"];

function isCryptoSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  /* `XAUUSD` ends in USD and is not crypto, so the metals and the major FX
     pairs are excluded before the suffix test rather than after it. */
  if (/^(XAU|XAG|XPT|XPD)/.test(s)) return false;
  if (/^(EUR|GBP|AUD|NZD|CAD|CHF|JPY)USD$/.test(s) || /^USD(JPY|CHF|CAD)$/.test(s)) return false;
  return CRYPTO_QUOTES.some((q) => s.endsWith(q) && s.length > q.length);
}

function fromDerivatives(
  d: DecisionInputs["derivatives"],
  now: number,
  symbol: string,
): Evidence {
  if (!d) {
    /* Gold has no perpetual, so there is no funding rate and no open interest
       to read — on any day, at any hour, however healthy every service is.
       Marking it structural keeps it counted against coverage (the read really
       IS thinner) while letting the gate say what was attainable. */
    return isCryptoSymbol(symbol)
      ? absent("derivs", "flow", "Derivatives", WEIGHTS.derivatives, "Not loaded for this instrument.")
      : absent(
          "derivs",
          "flow",
          "Derivatives",
          WEIGHTS.derivatives,
          `${symbol} has no perpetual, so there is no funding rate or open interest to read. Not a gap you can close.`,
          true,
        );
  }
  if (d.error !== undefined || !d.read) {
    return failed("derivs", "flow", "Derivatives", WEIGHTS.derivatives, d.error ?? "No read.");
  }
  if (d.read.insufficient !== null) {
    return absent("derivs", "flow", "Derivatives", WEIGHTS.derivatives, d.read.insufficient);
  }

  const signals = d.read.signals;
  const votes: number[] = signals.map((s) =>
    s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0,
  );
  const mean = votes.length > 0 ? votes.reduce((a, b) => a + b, 0) / votes.length : 0;

  return ageCheck(
    {
      id: "derivs",
      group: "flow",
      label: "Derivatives",
      lean: clamp(mean, -1, 1),
      weight: WEIGHTS.derivatives,
      reason: signals.map((s) => `${s.name} ${s.value}`).join(" · "),
      source: "Binance futures",
      asOf: d.asOf,
      state: "fresh",
      flip: "funding flipping sign, or open interest falling while price holds",
    },
    DERIV_MAX_AGE_MS,
    now,
  );
}

function fromFundamentals(
  f: DecisionInputs["fundamentals"],
  now: number,
  symbol: string,
): Evidence {
  if (!f) {
    return absent(
      "fundamentals",
      "fundamental",
      "Fundamentals",
      WEIGHTS.fundamentals,
      "Not listed — fundamentals cover crypto only.",
      /* For a metal or an FX pair this is permanent — there is no circulating
         supply or float to look up. For a crypto asset it merely has not
         loaded, which IS a gap worth counting as one. */
      !isCryptoSymbol(symbol),
    );
  }

  /**
   * ALWAYS informational — `lean: null`, always.
   *
   * A 6% float is not bullish. It is a fact that changes what a breakout is
   * worth, and the moment it is allowed to vote on direction it becomes a
   * thesis rather than a constraint. This is the one contributor that never
   * gets a lean, however tempting.
   */
  const notes = f.derived.notes;
  const headline =
    notes.length > 0
      ? notes[0] as string
      : `Rank #${f.row.rank}, ${(f.derived.turnover * 100).toFixed(2)}% turnover, ${f.derived.belowAth.toFixed(0)}% below the high.`;

  return ageCheck(
    {
      id: "fundamentals",
      group: "fundamental",
      label: "Fundamentals",
      lean: null,
      weight: WEIGHTS.fundamentals,
      reason: headline,
      source: "CoinGecko — circulating supply is self-reported",
      asOf: f.asOf,
      state: "fresh",
    },
    FUNDAMENTAL_MAX_AGE_MS,
    now,
  );
}

function fromSpread(s: SpreadRead | null, symbol: string): Evidence {
  if (!s || !s.ok) {
    /* Cross-venue pricing compares one instrument across crypto exchanges. A
       broker-quoted metal or FX pair has exactly one book here, so there is
       nothing to compare — and the DEALING spread, which is the number the cost
       gate actually wants, comes from data/brokerquote.ts instead. */
    if (!isCryptoSymbol(symbol)) {
      return absent(
        "venue",
        "venue",
        "Cross-venue",
        WEIGHTS.venue,
        `Only one price source for ${symbol}, so there is nothing to compare. Your broker spread is checked separately.`,
        true,
      );
    }
    return absent(
      "venue",
      "venue",
      "Cross-venue",
      WEIGHTS.venue,
      s?.reason ?? "Cross-venue pricing was not loaded.",
    );
  }
  return {
    id: "venue",
    group: "venue",
    label: "Cross-venue",
    /* Never directional. A wide spread does not say which way to lean; it says
       the price you are looking at may not be the market. */
    lean: null,
    weight: WEIGHTS.venue,
    reason:
      s.note !== ""
        ? s.note
        : `${s.quotes.length} venues within ${s.spreadPct.toFixed(3)}%. The price on screen is the market's, not one book's.`,
    source: s.quotes.map((q) => q.venue).join(", "),
    asOf: 0,
    state: "fresh",
  };
}

function fromCorrelation(c: DecisionInputs["correlation"]): Evidence {
  if (!c) {
    return absent(
      "correlation",
      "correlation",
      "Correlation",
      WEIGHTS.correlation,
      "No watchlist series to compare.",
    );
  }
  if (c.matrix.pairs.length === 0) {
    return absent("correlation", "correlation", "Correlation", WEIGHTS.correlation, c.matrix.note);
  }
  return {
    id: "correlation",
    group: "correlation",
    label: "Correlation",
    /* Never directional. It changes how much you should hold, not which way. */
    lean: null,
    weight: WEIGHTS.correlation,
    reason: c.matrix.note,
    source: `${c.matrix.symbols.length} symbols`,
    asOf: 0,
    state: "fresh",
  };
}

function fromOnchain(o: DecisionInputs["onchain"], now: number): Evidence {
  if (!o) {
    /**
     * `unavailable`, not `absent`, and the distinction is worth 4 points of
     * coverage on every read this terminal has ever produced.
     *
     * There is no on-chain watcher in this build — `shell.ts` passes a literal
     * `null` and always has. So this was never a source that failed to answer;
     * it was a question the terminal cannot ask. Counting it as a gap put a
     * fixed 0.3 of the 6.9 expected weight permanently out of reach, on every
     * instrument, for ever, which is how honest reads end up under the coverage
     * floor for reasons that have nothing to do with the market.
     *
     * It is still listed. If a watcher is ever wired in, `o` becomes non-null
     * and every branch below applies unchanged.
     */
    return unavailable(
      "onchain",
      "onchain",
      "On-chain",
      WEIGHTS.onchain,
      "Not available in this build. Not counted against data coverage.",
    );
  }
  if (!o.ok) {
    return failed("onchain", "onchain", "On-chain", WEIGHTS.onchain, o.error ?? "The watcher did not answer.");
  }
  return ageCheck(
    {
      id: "onchain",
      group: "onchain",
      label: "On-chain",
      lean: o.lean === null ? null : clamp(o.lean, -1, 1),
      weight: WEIGHTS.onchain,
      reason: o.reason,
      source: "Blockscout, via the local service",
      asOf: o.asOf,
      state: "fresh",
    },
    DERIV_MAX_AGE_MS,
    now,
  );
}

/* -------------------------------------------------------------- assemble -- */

/** Every contributor, in a fixed order so the panel does not reshuffle. */
/**
 * The economic calendar as evidence.
 *
 * `lean` is ALWAYS null, and that is the entire design. It would be easy, and
 * completely wrong, to turn a hawkish forecast into a short lean: nobody knows
 * how a release lands until it lands, and the direction of the surprise is not
 * in the calendar. What IS knowable is that at a specific minute the structure
 * on screen may stop mattering, and that is context, not direction.
 */
function fromCalendar(
  cal: DecisionInputs["calendar"],
  now: number,
): Evidence {
  if (!cal) {
    return absent("calendar", "macro", "Economic calendar", WEIGHTS.calendar, "Not loaded.");
  }
  if (!cal.ok) {
    return failed(
      "calendar",
      "macro",
      "Economic calendar",
      WEIGHTS.calendar,
      cal.error ?? "No calendar source answered.",
    );
  }
  return {
    id: "calendar",
    group: "macro",
    label: "Economic calendar",
    state: "fresh",
    lean: null,
    weight: WEIGHTS.calendar,
    reason: cal.note,
    source: "ForexFactory weekly feed via the local passthrough",
    asOf: now,
    flip: "The release itself — nothing here says which way it will go.",
  };
}

/**
 * Participation thinning — the durability half of the leading read.
 *
 * Momentum divergence and close-within-range follow-through, and nothing else.
 * See WEIGHTS.thinning for why funding and open interest are excluded here
 * even though the composite measures them.
 */
function fromThinning(l: DecisionInputs["leading"], now: number): Evidence {
  if (!l) return absent("thinning", "flow", "Participation", WEIGHTS.thinning, "Not computed.");
  if (!l.ok) {
    return failed("thinning", "flow", "Participation", WEIGHTS.thinning, l.error ?? "No read.");
  }
  if (l.thinningLean === null) {
    return absent("thinning", "flow", "Participation", WEIGHTS.thinning, l.thinningReason);
  }
  return {
    id: "thinning",
    group: "flow",
    label: "Participation",
    state: "fresh",
    lean: clamp(l.thinningLean, -1, 1),
    weight: WEIGHTS.thinning,
    reason: l.thinningReason,
    asOf: now,
    source: "bar range and volume",
    flip: "a new extreme reached on rising volume with closes back at the highs",
  };
}

/**
 * Volatility compression — the timing half.
 *
 * `lean` is null unconditionally and there is no branch that can make it
 * anything else. That is the enforcement: a compression reading cannot become
 * a direction by way of a later edit, because there is nowhere for it to go.
 */
function fromCoiled(l: DecisionInputs["leading"], now: number): Evidence {
  if (!l) return absent("coiled", "macro", "Compression", WEIGHTS.coiled, "Not computed.");
  if (!l.ok) {
    return failed("coiled", "macro", "Compression", WEIGHTS.coiled, l.error ?? "No read.");
  }
  return {
    id: "coiled",
    /* `macro` rather than a group of its own. Compression is context that
       changes what the rest is worth without pointing anywhere, which is the
       same job the calendar does, and a one-member group would give it a
       heading of its own on the desk for no reader benefit. */
    group: "macro",
    label: "Compression",
    state: "fresh",
    lean: null,
    weight: WEIGHTS.coiled,
    reason: l.coiledReason,
    asOf: now,
    source: "Bollinger bandwidth, ranked against this instrument",
    flip: "",
  };
}

export function assemble(input: DecisionInputs): Evidence[] {
  return [
    /* Cross-asset context, when it has been loaded and when it is strong
       enough to say anything. Supplied by the caller rather than derived here,
       because it needs four extra series the decision layer has no business
       fetching — and it is EMPTY by default, so a build that never loads them
       reads exactly as it did before. */
    ...(input.macro ?? []),
    fromStructure(input.detections, input.timeframe),
    fromConfluence(input.confluence),
    fromHigherTimeframes(input.higher, input.higherEnabled),
    fromDerivatives(input.derivatives, input.now, input.symbol),
    fromRegime(input.regime),
    fromForecast(input.forecast),
    fromFundamentals(input.fundamentals, input.now, input.symbol),
    fromOnchain(input.onchain, input.now),
    fromSpread(input.spread, input.symbol),
    fromCorrelation(input.correlation),
    fromCalendar(input.calendar, input.now),
    fromThinning(input.leading, input.now),
    fromCoiled(input.leading, input.now),
  ];
}

export interface Decision extends Read {
  readonly symbol: string;
  readonly timeframe: string;
  /** The one sentence a headline can carry without overstating. */
  readonly headline: string;
}

/**
 * The whole read, in one call.
 *
 * The headline deliberately leads with COVERAGE rather than with the bias. A
 * direction assembled from three of ten sources is not a weak direction, it is
 * an unsupported one, and putting "LONG" first would be the interface
 * disagreeing with its own confidence figure.
 */
export function decide(input: DecisionInputs): Decision {
  const base = synthesise(assemble(input));

  /**
   * The scheduled-release discount.
   *
   * Applied HERE rather than inside `synthesise`, deliberately. Coverage and
   * agreement are measurements of the evidence and must stay untouched by
   * policy — a release does not change how many sources answered or how much
   * they agree. What it changes is how much that agreement is WORTH over the
   * next few minutes, which is a judgement about actionability, and judgements
   * belong at the edge where they can be seen and reversed.
   *
   * It only ever reduces. There is no arrangement of the calendar that makes a
   * read more trustworthy than the evidence supports.
   */
  const discount = input.calendar?.ok ? clamp(input.calendar.discount, 0, 1) : 0;
  const confidence = base.confidence * (1 - discount);
  const limits =
    discount > 0.1 && input.calendar
      ? [
          ...base.limits,
          `Confidence cut by ${(discount * 100).toFixed(0)}% for a scheduled release. ${input.calendar.note}`,
        ]
      : base.limits;

  const read = { ...base, confidence, limits };

  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const headline =
    read.coverage === 0
      ? "No data answered — no read."
      : read.confidence === 0
        ? `Weak — only ${pct(read.coverage)} of the data answered, so the direction is not reliable.`
        : read.bias === "neutral"
          ? `No clear direction (${pct(read.coverage)} of data, signals balanced).`
          : `${read.bias.toUpperCase()}, ${pct(read.confidence)} confidence — ${pct(read.agreement)} of signals agree, ${pct(read.coverage)} of data answered.`;

  return { ...read, symbol: input.symbol, timeframe: input.timeframe, headline };
}
