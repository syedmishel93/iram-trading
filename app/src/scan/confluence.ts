/**
 * Glass-box confluence.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * Every contribution to a bias carries the reason it exists. There is no path
 * through this module that produces a number without the sentence explaining
 * it. A screener row that says "LONG 0.62" and cannot say why is exactly the
 * black box this terminal refuses to be.
 *
 * Consequences of that rule, made concrete:
 *  - Insufficient data returns NEUTRAL with a reason. It never extrapolates a
 *    score from a short series, because a confident-looking number computed
 *    from 30 bars is worse than an honest "not enough data".
 *  - Volatility does not vote on direction. It scales CONFIDENCE. A market can
 *    be violently trending or quietly trending; volatility says how much to
 *    trust the read, not which way to lean.
 *  - `agreement` is reported separately from `score`. Six modules at +0.3 and
 *    three at +0.9 with three at -0.9 can average the same; they are not the
 *    same read, and the caller must be able to tell them apart.
 *
 * This is decision support. It ranks and explains; it never places an order.
 */

import { ema, rsi, atr, macd, bollinger } from "../chart/indicators";

export type Direction = "long" | "short" | "neutral";

export interface ConfluenceSignal {
  /** Stable id, for tests and for the UI to key on. */
  id: string;
  name: string;
  direction: Direction;
  /** 0..1 — how emphatic this module is. */
  strength: number;
  /** Relative importance in the blend. */
  weight: number;
  /** Plain language. Shown verbatim in the UI. */
  reason: string;
}

export interface ConfluenceResult {
  bias: Direction;
  /** -1 (max short) .. +1 (max long). */
  score: number;
  /** 0..1 — share of weight pulling the same way as the bias. */
  agreement: number;
  /** 0..1 — how much to trust the read, after the volatility gate. */
  confidence: number;
  signals: ConfluenceSignal[];
  /** Set when no real read was possible. */
  insufficient: string | null;
}

export interface ScanBars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

/** Below this there is not enough history for a 200-EMA or a stable ATR. */
export const MIN_BARS = 210;

const NEUTRAL = (reason: string): ConfluenceResult => ({
  bias: "neutral",
  score: 0,
  agreement: 0,
  confidence: 0,
  signals: [],
  insufficient: reason,
});

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (v: number | undefined): boolean => v !== undefined && Number.isFinite(v);

function fmt(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return v.toFixed(dp);
}

/**
 * Score a series.
 *
 * Pure and allocation-light: this runs across the whole symbol universe, in a
 * worker, on every scan.
 */
export function confluence(bars: ScanBars): ConfluenceResult {
  const n = bars.c.length;
  if (n < MIN_BARS) {
    return NEUTRAL(`only ${n} bars — need ${MIN_BARS} for a stable read`);
  }

  const i = n - 1;
  const close = bars.c[i] as number;
  if (!Number.isFinite(close) || close <= 0) return NEUTRAL("last close is not a usable price");

  const signals: ConfluenceSignal[] = [];

  // --- 1. Trend structure: the stack of moving averages ---------------------
  const e20 = ema(bars.c, 20);
  const e50 = ema(bars.c, 50);
  const e200 = ema(bars.c, 200);
  const a20 = e20[i];
  const a50 = e50[i];
  const a200 = e200[i];

  if (finite(a20) && finite(a50) && finite(a200)) {
    const f20 = a20 as number;
    const f50 = a50 as number;
    const f200 = a200 as number;
    const stackedUp = f20 > f50 && f50 > f200;
    const stackedDown = f20 < f50 && f50 < f200;
    // Spread between fast and slow, as a share of price, is what separates a
    // decisive stack from three averages sitting on top of each other.
    const spread = Math.abs(f20 - f200) / close;
    const strength = clamp01(spread / 0.05);

    if (stackedUp || stackedDown) {
      signals.push({
        id: "ma-stack",
        name: "MA structure",
        direction: stackedUp ? "long" : "short",
        strength,
        weight: 2,
        reason: `EMA20/50/200 stacked ${stackedUp ? "bullish" : "bearish"} (${fmt(f20)} / ${fmt(f50)} / ${fmt(f200)}), spread ${(spread * 100).toFixed(2)}% of price`,
      });
    } else {
      signals.push({
        id: "ma-stack",
        name: "MA structure",
        direction: "neutral",
        strength: 0,
        weight: 2,
        reason: `EMA20/50/200 interleaved (${fmt(f20)} / ${fmt(f50)} / ${fmt(f200)}) — no clean trend structure`,
      });
    }
  }

  // --- 2. Location relative to the long average ----------------------------
  if (finite(a200)) {
    const f200 = a200 as number;
    const dist = (close - f200) / close;
    signals.push({
      id: "ma-location",
      name: "Price vs EMA200",
      direction: dist > 0.002 ? "long" : dist < -0.002 ? "short" : "neutral",
      strength: clamp01(Math.abs(dist) / 0.04),
      weight: 1.5,
      reason: `price ${fmt(close)} is ${(dist * 100).toFixed(2)}% ${dist >= 0 ? "above" : "below"} EMA200 ${fmt(f200)}`,
    });
  }

  // --- 3. Momentum ---------------------------------------------------------
  const r = rsi(bars.c, 14)[i];
  if (finite(r)) {
    const rv = r as number;
    // Distance from 50 is the signal; 70/30 are only labels on that scale.
    const off = (rv - 50) / 50;
    signals.push({
      id: "rsi",
      name: "RSI(14)",
      direction: rv > 55 ? "long" : rv < 45 ? "short" : "neutral",
      strength: clamp01(Math.abs(off) / 0.5),
      weight: 1.25,
      reason:
        rv > 70
          ? `RSI ${rv.toFixed(1)} — overbought, momentum up but stretched`
          : rv < 30
            ? `RSI ${rv.toFixed(1)} — oversold, momentum down but stretched`
            : `RSI ${rv.toFixed(1)} (${rv >= 50 ? "above" : "below"} midline)`,
    });
  }

  // --- 4. MACD -------------------------------------------------------------
  const m = macd(bars.c);
  const hist = m.histogram[i];
  const prevHist = m.histogram[i - 1];
  if (finite(hist)) {
    const hv = hist as number;
    const rising = finite(prevHist) ? hv > (prevHist as number) : false;
    signals.push({
      id: "macd",
      name: "MACD",
      direction: hv > 0 ? "long" : hv < 0 ? "short" : "neutral",
      strength: clamp01(Math.abs(hv) / (close * 0.004)),
      weight: 1.25,
      reason: `MACD histogram ${hv >= 0 ? "+" : ""}${fmt(hv)} and ${rising ? "rising" : "falling"}`,
    });
  }

  // --- 5. Position within the Bollinger envelope ---------------------------
  const bb = bollinger(bars.c, 20, 2);
  const up = bb.upper[i];
  const lo = bb.lower[i];
  if (finite(up) && finite(lo)) {
    const u = up as number;
    const l = lo as number;
    const span = u - l;
    if (span > 0) {
      const pos = (close - l) / span; // 0 at lower band, 1 at upper
      const off = (pos - 0.5) * 2; // -1..1
      signals.push({
        id: "bb-position",
        name: "Bollinger position",
        direction: pos > 0.6 ? "long" : pos < 0.4 ? "short" : "neutral",
        strength: clamp01(Math.abs(off)),
        weight: 0.75,
        reason: `price sits at ${(pos * 100).toFixed(0)}% of the 20/2 band (${fmt(l)} – ${fmt(u)})`,
      });
    }
  }

  // --- 6. Volume confirmation ----------------------------------------------
  const volLookback = 20;
  let volSum = 0;
  for (let j = i - volLookback; j < i; j++) volSum += bars.v[j] as number;
  const volAvg = volSum / volLookback;
  const volNow = bars.v[i] as number;
  if (volAvg > 0 && Number.isFinite(volNow)) {
    const ratio = volNow / volAvg;
    const barDir: Direction =
      close > (bars.o[i] as number) ? "long" : close < (bars.o[i] as number) ? "short" : "neutral";
    // Volume only CONFIRMS the direction the bar already went. Above-average
    // volume on a down bar is not bullish because volume is "strong".
    signals.push({
      id: "volume",
      name: "Volume",
      direction: ratio > 1.2 ? barDir : "neutral",
      strength: clamp01((ratio - 1) / 1.5),
      weight: 0.75,
      reason: `volume ${ratio.toFixed(2)}x the 20-bar average${ratio > 1.2 ? ` confirming a ${barDir} bar` : " — unremarkable"}`,
    });
  }

  // --- blend ---------------------------------------------------------------
  let weighted = 0;
  let totalWeight = 0;
  for (const s of signals) {
    const dir = s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0;
    weighted += dir * s.strength * s.weight;
    totalWeight += s.weight;
  }
  if (totalWeight === 0) return NEUTRAL("no module produced a usable reading");

  const score = weighted / totalWeight;

  // Agreement: share of weight pointing the same way as the net score. Kept
  // separate from `score` because a weak-but-unanimous read and a strong-but-
  // split read are different situations that average to the same number.
  const netDir = score > 0 ? 1 : score < 0 ? -1 : 0;
  let agreeing = 0;
  let directional = 0;
  for (const s of signals) {
    const dir = s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0;
    if (dir === 0) continue;
    directional += s.weight;
    if (dir === netDir) agreeing += s.weight;
  }
  const agreement = directional > 0 ? agreeing / directional : 0;

  // --- volatility gate: scales confidence, never direction -----------------
  const atrArr = atr(bars.h, bars.l, bars.c, 14);
  const atrNow = atrArr[i];
  let confidence = clamp01(Math.abs(score) * 1.6) * (0.4 + 0.6 * agreement);
  let volNote = "";

  // --- structure gate ------------------------------------------------------
  // Momentum modules read directional at any point in an oscillation — at the
  // top of a swing, RSI and MACD genuinely are up. That is not wrong, but a
  // directional read with NO trend structure behind it is a materially weaker
  // read than the same score inside a clean stack, and a screener that ranks
  // them together sends you into chop. So, exactly as with volatility: the
  // absence of structure scales confidence, it does not flip direction.
  const stack = signals.find((sg) => sg.id === "ma-stack");
  if (stack && stack.direction === "neutral") {
    confidence *= 0.55;
  } else if (stack && score !== 0 && stack.direction !== (score > 0 ? "long" : "short")) {
    // Structure exists but points the other way — momentum against the trend.
    confidence *= 0.7;
  }

  if (finite(atrNow)) {
    const atrPct = ((atrNow as number) / close) * 100;
    // Compare current volatility to its own recent norm, not to a fixed
    // threshold: 0.3% is calm for BTC and wild for EURUSD.
    let sum = 0;
    let count = 0;
    for (let j = i - 100; j < i; j++) {
      const a = atrArr[j];
      if (finite(a)) {
        sum += a as number;
        count++;
      }
    }
    const atrAvg = count > 0 ? sum / count : (atrNow as number);
    const volRatio = atrAvg > 0 ? (atrNow as number) / atrAvg : 1;

    if (volRatio > 1.8) {
      confidence *= 0.6;
      volNote = `volatility ${volRatio.toFixed(2)}x its norm — past patterns are less reliable here`;
    } else if (volRatio < 0.5) {
      confidence *= 0.85;
      volNote = `volatility ${volRatio.toFixed(2)}x its norm — compressed, prone to expansion`;
    } else {
      volNote = `volatility ${volRatio.toFixed(2)}x its norm — normal range`;
    }

    signals.push({
      id: "volatility",
      name: "Volatility regime",
      direction: "neutral", // never votes on direction
      strength: 0,
      weight: 0,
      reason: `ATR ${atrPct.toFixed(2)}% of price; ${volNote}`,
    });
  }

  const bias: Direction = score > 0.12 ? "long" : score < -0.12 ? "short" : "neutral";

  return {
    bias,
    score,
    agreement,
    confidence: clamp01(confidence),
    signals,
    insufficient: null,
  };
}

/** Build the columnar input `confluence` expects from an array of bars. */
export function toScanBars(
  bars: readonly { t: number; o: number; h: number; l: number; c: number; v: number }[],
): ScanBars {
  const n = bars.length;
  const out: ScanBars = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i] as { t: number; o: number; h: number; l: number; c: number; v: number };
    out.t[i] = b.t;
    out.o[i] = b.o;
    out.h[i] = b.h;
    out.l[i] = b.l;
    out.c[i] = b.c;
    out.v[i] = b.v;
  }
  return out;
}
