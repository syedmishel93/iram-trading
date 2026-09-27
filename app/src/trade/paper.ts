/**
 * Paper trading: simulated fills against real prices.
 *
 * WHY THIS IS NOT THE "DEMO MODE" THAT WAS REMOVED
 * The demo mode this terminal used to ship generated SYNTHETIC BARS and drew
 * them on the chart. That is the one thing the honesty contract forbids
 * outright: a price that nothing observed, rendered identically to one that was
 * observed. It was removed and it is not coming back.
 *
 * This is the opposite arrangement. The PRICES are real — the same live feed
 * the chart is drawing — and only the FILLS are simulated. Nothing here
 * fabricates market data; it fabricates your participation in it, which is
 * exactly what a practice account is and is a claim the desk can make honestly
 * because it labels every position as simulated.
 *
 * WHAT A SIMULATED FILL CANNOT KNOW
 * Recorded on every fill and shown on the desk, because a paper record that
 * quietly flatters itself is worse than no record — it teaches a strategy that
 * only works when filling is free:
 *
 *   - You would not have got this price. A market order crosses the spread, and
 *     a real fill lands on the far side of it. The desk applies a spread and a
 *     slippage assumption and SAYS they are assumptions.
 *   - You would not have got this size. Book depth is not modelled at all. A
 *     size that would move the market fills here at one price, silently.
 *   - Your order had no effect on the market, which is only true while it is
 *     small.
 *   - Nothing queued. A limit order at the touch may never fill in reality even
 *     when price trades there; this desk only does market orders, so that whole
 *     class of self-deception is excluded by construction rather than modelled
 *     badly.
 *
 * NO AUTOMATION, BY CONSTRUCTION
 * There is no function here that opens a position from a signal, a score, or a
 * strategy. Every fill originates in a click. The standing recommendation on
 * this terminal is that nothing be automated off the confluence score — PBO is
 * 89% — and a paper desk with an "auto-trade the signal" switch is how that
 * recommendation gets quietly ignored.
 */

/** A simulated position. Opened and closed only by an explicit user action. */
export interface PaperPosition {
  readonly id: string;
  readonly symbol: string;
  readonly direction: "long" | "short";
  readonly qty: number;
  /** Price recorded at open, AFTER the cost assumptions were applied. */
  readonly entry: number;
  /** The clean mid/last price at the moment of opening, before assumptions. */
  readonly entryMid: number;
  readonly openedAt: number;
  readonly stop?: number;
  readonly target?: number;
  readonly note?: string;
}

export interface PaperTrade extends PaperPosition {
  readonly exit: number;
  readonly exitMid: number;
  readonly closedAt: number;
  /** Currency P&L, after the entry and exit assumptions. */
  readonly pnl: number;
  /** P&L as a fraction of the notional put up at entry. */
  readonly pnlPct: number;
  /** Why it closed. Always a user action or a level THEY set. */
  readonly reason: "manual" | "stop" | "target";
}

export interface CostAssumptions {
  /** Half-spread as a fraction of price, applied on entry AND exit. */
  readonly spreadPct: number;
  /** Extra adverse fill as a fraction of price, applied on entry AND exit. */
  readonly slippagePct: number;
  /** Commission per side, as a fraction of notional. */
  readonly commissionPct: number;
}

export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  spreadPct: 0.0002,
  slippagePct: 0.0001,
  commissionPct: 0.0004,
};

/** Costs all zero. Named, so a run without them is deliberate and visible. */
export const FRICTIONLESS: CostAssumptions = {
  spreadPct: 0,
  slippagePct: 0,
  commissionPct: 0,
};

export interface PaperBook {
  readonly startingEquity: number;
  readonly positions: readonly PaperPosition[];
  readonly trades: readonly PaperTrade[];
}

export const emptyBook = (startingEquity = 10_000): PaperBook => ({
  startingEquity,
  positions: [],
  trades: [],
});

/**
 * The price a market order would actually have got.
 *
 * ALWAYS adverse: a buy pays up, a sell gets hit. Getting the sign of this
 * wrong is the single most flattering bug a paper-trading desk can have,
 * because it turns every round trip into a small free gain and the equity curve
 * drifts upward on activity alone.
 */
export function fillPrice(mid: number, direction: "long" | "short", side: "open" | "close", c: CostAssumptions): number {
  if (!Number.isFinite(mid) || mid <= 0) return NaN;
  /* Opening a long BUYS; closing a long SELLS. Opening a short sells, closing
     it buys. So the sign flips on both direction and side. */
  const buying = (direction === "long") === (side === "open");
  const adverse = c.spreadPct + c.slippagePct;
  return buying ? mid * (1 + adverse) : mid * (1 - adverse);
}

export interface OpenRequest {
  readonly symbol: string;
  readonly direction: "long" | "short";
  readonly qty: number;
  /** Live price from the feed. Never a price this module invented. */
  readonly mid: number;
  readonly at: number;
  readonly id: string;
  readonly stop?: number;
  readonly target?: number;
  readonly note?: string;
  readonly costs?: CostAssumptions;
}

export type OpenOutcome =
  | { readonly ok: true; readonly book: PaperBook }
  | { readonly ok: false; readonly reason: string };

export function openPosition(book: PaperBook, req: OpenRequest): OpenOutcome {
  if (!Number.isFinite(req.mid) || req.mid <= 0) {
    return { ok: false, reason: "No live price for this symbol. Nothing is filled against a price the feed has not supplied." };
  }
  if (!Number.isFinite(req.qty) || req.qty <= 0) {
    return { ok: false, reason: "Quantity must be greater than zero." };
  }
  const costs = req.costs ?? DEFAULT_ASSUMPTIONS;
  const entry = fillPrice(req.mid, req.direction, "open", costs);

  /* A stop on the wrong side of the entry would trigger on the next tick. That
     is a typo, not a trade, and filling it would immediately book a loss the
     user did not intend. */
  if (req.stop !== undefined && Number.isFinite(req.stop)) {
    const wrongSide = req.direction === "long" ? req.stop >= entry : req.stop <= entry;
    if (wrongSide) {
      return {
        ok: false,
        reason:
          req.direction === "long"
            ? "A long needs its stop below the entry; this one would trigger immediately."
            : "A short needs its stop above the entry; this one would trigger immediately.",
      };
    }
  }

  const position: PaperPosition = {
    id: req.id,
    symbol: req.symbol.toUpperCase(),
    direction: req.direction,
    qty: req.qty,
    entry,
    entryMid: req.mid,
    openedAt: req.at,
    ...(req.stop !== undefined && Number.isFinite(req.stop) ? { stop: req.stop } : {}),
    ...(req.target !== undefined && Number.isFinite(req.target) ? { target: req.target } : {}),
    ...(req.note !== undefined && req.note !== "" ? { note: req.note } : {}),
  };

  return { ok: true, book: { ...book, positions: [...book.positions, position] } };
}

/** Realised P&L for one position at a given clean price. */
export function realise(
  p: PaperPosition,
  mid: number,
  costs: CostAssumptions,
): { exit: number; pnl: number; pnlPct: number } {
  const exit = fillPrice(mid, p.direction, "close", costs);
  const dir = p.direction === "long" ? 1 : -1;
  const gross = (exit - p.entry) * dir * p.qty;
  /* Commission on both sides, on the notional actually transacted. */
  const commission = (p.entry * p.qty + exit * p.qty) * costs.commissionPct;
  const pnl = gross - commission;
  const notional = p.entry * p.qty;
  return { exit, pnl, pnlPct: notional > 0 ? pnl / notional : NaN };
}

export function closePosition(
  book: PaperBook,
  id: string,
  mid: number,
  at: number,
  reason: PaperTrade["reason"] = "manual",
  costs: CostAssumptions = DEFAULT_ASSUMPTIONS,
): PaperBook {
  const p = book.positions.find((x) => x.id === id);
  if (!p || !Number.isFinite(mid) || mid <= 0) return book;
  const { exit, pnl, pnlPct } = realise(p, mid, costs);
  const trade: PaperTrade = { ...p, exit, exitMid: mid, closedAt: at, pnl, pnlPct, reason };
  return {
    ...book,
    positions: book.positions.filter((x) => x.id !== id),
    trades: [...book.trades, trade],
  };
}

/**
 * Close anything whose own stop or target has been reached.
 *
 * Driven by the CLOSED BAR high/low, not by the live last price, and this is
 * the important part. A stop checked against the last trade only fires if you
 * happen to be looking when it prints, so a desk that polls would miss stops
 * that traded between polls and report a strategy that never lost. Feeding it
 * the bar's high and low means a level inside the bar's range counts as
 * touched, which is the same rule the backtest engine uses.
 *
 * Where both the stop and the target sit inside one bar, the STOP wins. Neither
 * is knowable from a bar alone and assuming the good one is how a paper record
 * quietly outperforms the account it is meant to be practising for.
 */
export function applyLevels(
  book: PaperBook,
  quotes: ReadonlyMap<string, { high: number; low: number; close: number }>,
  at: number,
  costs: CostAssumptions = DEFAULT_ASSUMPTIONS,
): { book: PaperBook; fired: PaperTrade[] } {
  let next = book;
  const fired: PaperTrade[] = [];

  for (const p of book.positions) {
    const q = quotes.get(p.symbol);
    if (!q || !Number.isFinite(q.high) || !Number.isFinite(q.low)) continue;

    const hitStop =
      p.stop !== undefined && (p.direction === "long" ? q.low <= p.stop : q.high >= p.stop);
    const hitTarget =
      p.target !== undefined && (p.direction === "long" ? q.high >= p.target : q.low <= p.target);

    if (!hitStop && !hitTarget) continue;

    /* Stop first, always. */
    const reason: PaperTrade["reason"] = hitStop ? "stop" : "target";
    const level = (hitStop ? p.stop : p.target) as number;
    const before = next;
    next = closePosition(next, p.id, level, at, reason, costs);
    const t = next.trades[next.trades.length - 1];
    if (t && next.trades.length > before.trades.length) fired.push(t);
  }

  return { book: next, fired };
}

export interface PaperSummary {
  readonly realised: number;
  readonly unrealised: number;
  readonly equity: number;
  readonly openNotional: number;
  readonly trades: number;
  readonly wins: number;
  readonly winRate: number;
  /** Total return on starting equity. */
  readonly returnPct: number;
}

export function summarise(
  book: PaperBook,
  marks: ReadonlyMap<string, number>,
  costs: CostAssumptions = DEFAULT_ASSUMPTIONS,
): PaperSummary {
  const realised = book.trades.reduce((s, t) => s + t.pnl, 0);

  let unrealised = 0;
  let openNotional = 0;
  for (const p of book.positions) {
    const mark = marks.get(p.symbol);
    openNotional += p.entry * p.qty;
    if (mark === undefined || !Number.isFinite(mark)) continue;
    /* Marked at the price a close would ACTUALLY get, costs included. An open
       position marked at the mid shows a profit that closing would not
       realise. */
    unrealised += realise(p, mark, costs).pnl;
  }

  const wins = book.trades.filter((t) => t.pnl > 0).length;
  const equity = book.startingEquity + realised + unrealised;

  return {
    realised,
    unrealised,
    equity,
    openNotional,
    trades: book.trades.length,
    wins,
    winRate: book.trades.length > 0 ? wins / book.trades.length : NaN,
    returnPct: book.startingEquity > 0 ? (equity - book.startingEquity) / book.startingEquity : NaN,
  };
}

/** Equity after each closed trade, for a curve. Starts at starting equity. */
export function equityCurve(book: PaperBook): number[] {
  const out = [book.startingEquity];
  let eq = book.startingEquity;
  for (const t of book.trades) {
    eq += t.pnl;
    out.push(eq);
  }
  return out;
}
