const MINUTE_MS = 6e4;
function settleBar(minutes, span, levels) {
  const { stop, target, direction } = levels;
  const wrongWay = direction === "long" ? !(stop < target) : !(stop > target);
  if (wrongWay) {
    return {
      hit: "neither",
      basis: "assumed",
      minutes: 0,
      why: `the stop is on the wrong side of the target for a ${direction}`
    };
  }
  const inside = minutes.filter((b) => b.t >= span.from && b.t < span.to);
  const assumed = (why) => ({
    hit: "stop",
    basis: "assumed",
    minutes: inside.length,
    why
  });
  if (inside.length === 0) return assumed("no minute bars for this bar");
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (first === void 0 || last === void 0) return assumed("no minute bars for this bar");
  if (first.t - span.from >= MINUTE_MS) {
    return assumed("the minutes start after the bar does");
  }
  if (span.to - (last.t + MINUTE_MS) >= MINUTE_MS) {
    return assumed("the minutes end before the bar does");
  }
  for (let i = 1; i < inside.length; i += 1) {
    const prev = inside[i - 1];
    const cur = inside[i];
    if (prev === void 0 || cur === void 0) continue;
    if (cur.t - prev.t > MINUTE_MS) {
      return assumed("a minute is missing from the middle of the bar");
    }
  }
  for (const b of inside) {
    const hitStop = direction === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = direction === "long" ? b.h >= target : b.l <= target;
    if (hitStop && hitTarget) {
      return {
        hit: "stop",
        basis: "assumed",
        minutes: inside.length,
        why: "one minute held both levels, so the order is still unknown"
      };
    }
    if (hitStop) return { hit: "stop", basis: "measured", minutes: inside.length, why: "" };
    if (hitTarget) return { hit: "target", basis: "measured", minutes: inside.length, why: "" };
  }
  return { hit: "neither", basis: "measured", minutes: inside.length, why: "" };
}
const NaNArray = (n) => new Float64Array(n).fill(NaN);
function sma(src, period, len = src.length) {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  let sum = 0;
  let holes = 0;
  for (let i = 0; i < len; i++) {
    const v = src[i];
    if (Number.isFinite(v)) sum += v;
    else holes += 1;
    if (i >= period) {
      const gone = src[i - period];
      if (Number.isFinite(gone)) sum -= gone;
      else holes -= 1;
    }
    if (i >= period - 1 && holes === 0) out[i] = sum / period;
  }
  return out;
}
function ema(src, period, len = src.length) {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += src[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < len; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function wilder(src, period, len) {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < len; i++) {
    prev = (prev * (period - 1) + src[i]) / period;
    out[i] = prev;
  }
  return out;
}
function rsi(close, period = 14, len = close.length) {
  const out = NaNArray(len);
  if (len < period + 1) return out;
  const gain = new Float64Array(len);
  const loss = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const d = close[i] - close[i - 1];
    gain[i] = d > 0 ? d : 0;
    loss[i] = d < 0 ? -d : 0;
  }
  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period; i++) {
    avgG += gain[i];
    avgL += loss[i];
  }
  avgG /= period;
  avgL /= period;
  out[period] = rsiFrom(avgG, avgL);
  for (let i = period + 1; i < len; i++) {
    avgG = (avgG * (period - 1) + gain[i]) / period;
    avgL = (avgL * (period - 1) + loss[i]) / period;
    out[i] = rsiFrom(avgG, avgL);
  }
  return out;
}
function rsiFrom(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function trueRange(high, low, close, len = close.length) {
  const out = new Float64Array(len);
  if (len === 0) return out;
  out[0] = high[0] - low[0];
  for (let i = 1; i < len; i++) {
    const h = high[i];
    const l = low[i];
    const pc = close[i - 1];
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}
function atr(high, low, close, period = 14, len = close.length) {
  return wilder(trueRange(high, low, close, len), period, len);
}
function macd(close, fast = 12, slow = 26, signalPeriod = 9, len = close.length) {
  const fastEma = ema(close, fast, len);
  const slowEma = ema(close, slow, len);
  const macdLine = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (!Number.isNaN(f) && !Number.isNaN(s)) macdLine[i] = f - s;
  }
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal = NaNArray(len);
  if (firstValid >= 0) {
    const tail = macdLine.subarray(firstValid);
    const sig = ema(tail, signalPeriod, tail.length);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i];
  }
  const histogram = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const m = macdLine[i];
    const s = signal[i];
    if (!Number.isNaN(m) && !Number.isNaN(s)) histogram[i] = m - s;
  }
  return { macd: macdLine, signal, histogram };
}
function bollinger(close, period = 20, mult = 2, len = close.length) {
  const middle = sma(close, period, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    const mean = middle[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = close[j] - mean;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}
function vwap(high, low, close, volume, time, sessionMs = 864e5, len = close.length) {
  const out = NaNArray(len);
  let pv = 0;
  let vol = 0;
  let session = -1;
  for (let i = 0; i < len; i++) {
    const t = time[i];
    const s = sessionMs > 0 ? Math.floor(t / sessionMs) : 0;
    if (s !== session) {
      session = s;
      pv = 0;
      vol = 0;
    }
    const typical = (high[i] + low[i] + close[i]) / 3;
    const v = volume[i];
    pv += typical * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}
function stochastic(high, low, close, period = 14, smoothK = 3, smoothD = 3, len = close.length) {
  const raw = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j];
      const l = low[j];
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const span = hh - ll;
    raw[i] = span === 0 ? 50 : (close[i] - ll) / span * 100;
  }
  const k = smoothK > 1 ? smaSkippingNaN(raw, smoothK, len) : raw;
  const d = smaSkippingNaN(k, smoothD, len);
  return { k, d };
}
function smaSkippingNaN(src, period, len) {
  const out = NaNArray(len);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    const v = src[i];
    if (!Number.isNaN(v)) {
      sum += v;
      count++;
    }
    if (i >= period) {
      const drop = src[i - period];
      if (!Number.isNaN(drop)) {
        sum -= drop;
        count--;
      }
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}
function adx(high, low, close, period = 14, len = close.length) {
  const plusDM = new Float64Array(len);
  const minusDM = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(high, low, close, len), period, len);
  const pdm = wilder(plusDM, period, len);
  const mdm = wilder(minusDM, period, len);
  const plusDI = NaNArray(len);
  const minusDI = NaNArray(len);
  const dx = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const t = tr[i];
    if (Number.isNaN(t) || t === 0) continue;
    const p = pdm[i] / t * 100;
    const m = mdm[i] / t * 100;
    plusDI[i] = p;
    minusDI[i] = m;
    const sum = p + m;
    dx[i] = sum === 0 ? 0 : Math.abs(p - m) / sum * 100;
  }
  const firstValid = dx.findIndex((v) => !Number.isNaN(v));
  const out = NaNArray(len);
  if (firstValid >= 0) {
    const tail = dx.subarray(firstValid);
    const smoothed = wilder(tail, period, tail.length);
    for (let i = 0; i < smoothed.length; i++) out[firstValid + i] = smoothed[i];
  }
  return { adx: out, plusDI, minusDI };
}
function roc(close, period = 12, len = close.length) {
  const out = NaNArray(len);
  for (let i = period; i < len; i++) {
    const then = close[i - period];
    if (then === 0 || !Number.isFinite(then)) continue;
    out[i] = (close[i] - then) / then * 100;
  }
  return out;
}
function williamsR(high, low, close, period = 14, len = close.length) {
  const out = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j];
      const l = low[j];
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const range = hh - ll;
    if (range <= 0) continue;
    out[i] = (hh - close[i]) / range * -100;
  }
  return out;
}
function cci(high, low, close, period = 20, len = close.length) {
  const out = NaNArray(len);
  const tp = NaNArray(len);
  for (let i = 0; i < len; i++) {
    tp[i] = (high[i] + low[i] + close[i]) / 3;
  }
  for (let i = period - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const mean = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
    const mad = dev / period;
    if (mad <= 0) continue;
    out[i] = (tp[i] - mean) / (0.015 * mad);
  }
  return out;
}
function mfi(high, low, close, volume, period = 14, len = close.length) {
  const out = NaNArray(len);
  const tp = NaNArray(len);
  for (let i = 0; i < len; i++) {
    tp[i] = (high[i] + low[i] + close[i]) / 3;
  }
  for (let i = period; i < len; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const now = tp[j];
      const prev = tp[j - 1];
      const flow = now * volume[j];
      if (!Number.isFinite(flow)) continue;
      if (now > prev) pos += flow;
      else if (now < prev) neg += flow;
    }
    if (pos + neg <= 0) continue;
    out[i] = pos / (pos + neg) * 100;
  }
  return out;
}
function supertrendDirection(high, low, close, period = 10, mult = 3, len = close.length) {
  const out = NaNArray(len);
  const a = atr(high, low, close, period, len);
  let upper = NaN;
  let lower = NaN;
  let dir = 1;
  for (let i = 0; i < len; i++) {
    const atrNow = a[i];
    if (!Number.isFinite(atrNow)) continue;
    const mid = (high[i] + low[i]) / 2;
    let up = mid + mult * atrNow;
    let low_ = mid - mult * atrNow;
    const prevClose = i > 0 ? close[i - 1] : close[i];
    if (Number.isFinite(upper) && !(up < upper || prevClose > upper)) up = upper;
    if (Number.isFinite(lower) && !(low_ > lower || prevClose < lower)) low_ = lower;
    const c = close[i];
    if (Number.isFinite(upper) && Number.isFinite(lower)) {
      if (dir === 1 && c < lower) dir = -1;
      else if (dir === -1 && c > up) dir = 1;
    }
    upper = up;
    lower = low_;
    out[i] = dir;
  }
  return out;
}
function keltner(high, low, close, period = 20, mult = 2, atrPeriod = 10, len = close.length) {
  const middle = ema(close, period, len);
  const a = atr(high, low, close, atrPeriod, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const m = middle[i];
    const r2 = a[i];
    if (!Number.isFinite(m) || !Number.isFinite(r2)) continue;
    upper[i] = m + mult * r2;
    lower[i] = m - mult * r2;
  }
  return { middle, upper, lower };
}
function squeeze(high, low, close, period = 20, bbMult = 2, kcMult = 1.5, len = close.length) {
  const bb = bollinger(close, period, bbMult, len);
  const kc = keltner(high, low, close, period, kcMult, period, len);
  const out = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const bu = bb.upper[i];
    const bl = bb.lower[i];
    const ku = kc.upper[i];
    const kl = kc.lower[i];
    if (!Number.isFinite(bu) || !Number.isFinite(ku)) continue;
    out[i] = bu < ku && bl > kl ? 1 : 0;
  }
  return out;
}
function donchian(high, low, period = 20, excludeCurrent = false, len = high.length) {
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  const middle = NaNArray(len);
  const shift = excludeCurrent ? 1 : 0;
  for (let i = period - 1 + shift; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1 - shift; j <= i - shift; j++) {
      const h = high[j];
      const l = low[j];
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    upper[i] = hi;
    lower[i] = lo;
    middle[i] = (hi + lo) / 2;
  }
  return { middle, upper, lower };
}
function ichimoku(high, low, close, conversionPeriod = 9, basePeriod = 26, spanBPeriod = 52, displacement = 26, len = close.length) {
  const midpoint = (period) => {
    const out = NaNArray(len);
    for (let i = period - 1; i < len; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        const h = high[j];
        const l = low[j];
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const conversion = midpoint(conversionPeriod);
  const base = midpoint(basePeriod);
  const spanBRaw = midpoint(spanBPeriod);
  const spanARaw = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const c = conversion[i];
    const b = base[i];
    if (Number.isFinite(c) && Number.isFinite(b)) spanARaw[i] = (c + b) / 2;
  }
  const shiftForward = (src) => {
    const out = NaNArray(len);
    for (let i = displacement; i < len; i++) out[i] = src[i - displacement];
    return out;
  };
  const lagging = NaNArray(len);
  for (let i = 0; i + displacement < len; i++) lagging[i] = close[i + displacement];
  return {
    conversion,
    base,
    spanA: shiftForward(spanARaw),
    spanB: shiftForward(spanBRaw),
    lagging,
    displacement
  };
}
function chandelier(high, low, close, period = 22, mult = 3, len = close.length) {
  const a = atr(high, low, close, period, len);
  const long = NaNArray(len);
  const short = NaNArray(len);
  let longStop = -Infinity;
  let shortStop = Infinity;
  for (let i = period - 1; i < len; i++) {
    const r2 = a[i];
    if (!Number.isFinite(r2)) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = high[j];
      const l = low[j];
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    const rawLong = hi - mult * r2;
    const rawShort = lo + mult * r2;
    const c = close[i];
    if (c < longStop) longStop = -Infinity;
    if (c > shortStop) shortStop = Infinity;
    longStop = Math.max(longStop, rawLong);
    shortStop = Math.min(shortStop, rawShort);
    long[i] = longStop;
    short[i] = shortStop;
  }
  return { long, short };
}
const DEFAULT_COSTS = {
  spread: 2e-4,
  commission: 4e-4,
  slippage: 1e-4,
  /* The MT5 rate from `friction.ts` VENUES, which is a published schedule and
     not a measured one. It is charged per night HELD, so an intraday rule pays
     it zero times and is unaffected by this default. */
  carryPerNight: 1e-4
};
const ZERO_COSTS = { spread: 0, commission: 0, slippage: 0, carryPerNight: 0 };
function nightsBetween(entryTime, exitTime) {
  if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime)) return 0;
  const DAY = 864e5;
  return Math.max(0, Math.floor(exitTime / DAY) - Math.floor(entryTime / DAY));
}
function effectiveSlippage(costs, atrPct) {
  const mult = costs.slippageAtrMult;
  if (mult === void 0 || !Number.isFinite(atrPct) || atrPct <= 0) return costs.slippage;
  return Math.max(costs.slippage, mult * atrPct);
}
function modelledFill(price, direction, costs, entering) {
  const half = costs.spread / 2 + costs.slippage;
  const payUp = entering ? direction === "long" : direction === "short";
  return price * (payUp ? 1 + half : 1 - half);
}
function fillable(entryPrice, stop, direction) {
  return direction === "long" ? stop < entryPrice : stop > entryPrice;
}
const NO_SETTLE = { ambiguous: 0, measured: 0, assumed: 0, share: NaN, why: "" };
const NO_FRICTION = {
  spreadPct: 0,
  slippagePaid: 0,
  commissionPct: 0,
  carryPct: 0,
  totalPct: 0,
  perTradePct: 0,
  share: NaN,
  nights: 0,
  why: "No trades, so nothing was charged."
};
function summariseFriction(trades, costs) {
  if (trades.length === 0) return NO_FRICTION;
  const commissionPct = costs.commission * 2 * trades.length;
  let carryPct = 0;
  let nights = 0;
  let gross = 0;
  let slippagePaid = 0;
  for (const t of trades) {
    carryPct += t.carryPct;
    nights += t.nightsHeld;
    gross += Math.abs(t.grossPct);
    slippagePaid += t.slippagePct;
  }
  const spreadPct = costs.spread * trades.length + slippagePaid;
  const totalPct = spreadPct + commissionPct + carryPct;
  const share = gross > 0 ? totalPct / gross : NaN;
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  const nightWords = `${nights.toLocaleString()} night${nights === 1 ? "" : "s"}`;
  const carryWords = nights === 0 ? " No position was held overnight, so nothing was financed" : carryPct > 0 ? ` Financing over ${nightWords} was ${pct(carryPct)} of that` : ` ${nightWords} were held and this venue was charged nothing for them, so no financing is in that figure`;
  return {
    spreadPct,
    slippagePaid,
    commissionPct,
    carryPct,
    totalPct,
    perTradePct: totalPct / trades.length,
    share,
    nights,
    why: `Costs came to ${pct(totalPct)} across ${trades.length.toLocaleString()} trades, which is ${Number.isFinite(share) ? `${(share * 100).toFixed(0)}% of what those trades moved` : "an unknown share of what those trades moved"}.${carryWords}.`
  };
}
const EMPTY = (strategy, refused, bars) => ({
  strategy,
  trades: [],
  equity: new Float64Array(0),
  warnings: [],
  refused,
  bars,
  friction: NO_FRICTION,
  settle: NO_SETTLE
});
function makeContext(bars, macro) {
  const n = bars.length;
  const ctx = {
    bars,
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    time: new Float64Array(n),
    ...macro ? { macro } : {}
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    ctx.open[i] = b.o;
    ctx.high[i] = b.h;
    ctx.low[i] = b.l;
    ctx.close[i] = b.c;
    ctx.volume[i] = b.v;
    ctx.time[i] = b.t;
  }
  return ctx;
}
function runBacktest(strategy, bars, opts = {}, shared) {
  var _a;
  const costs = opts.costs ?? DEFAULT_COSTS;
  const risk = opts.riskPerTrade ?? 0.01;
  const minCoverage = opts.minCoverage ?? 0.98;
  const n = bars.length;
  if (opts.containsDemo === true && opts.allowDemo !== true) {
    return EMPTY(strategy.id, "series contains generated data; refusing to report it as a result", n);
  }
  if (opts.coverage !== void 0 && opts.coverage < minCoverage) {
    return EMPTY(
      strategy.id,
      `series coverage ${(opts.coverage * 100).toFixed(1)}% is below the ${(minCoverage * 100).toFixed(0)}% floor — a gap would be silently treated as one enormous bar`,
      n
    );
  }
  if (n < strategy.warmup + 10) {
    return EMPTY(strategy.id, `only ${n} bars; ${strategy.warmup + 10} needed`, n);
  }
  if (opts.minutes !== void 0 && !(Number.isFinite(opts.barIntervalMs) && opts.barIntervalMs > 0)) {
    return EMPTY(
      strategy.id,
      "minutes were supplied with no barIntervalMs, so there is no span to settle them against — pass the width of one bar in milliseconds",
      n
    );
  }
  if (((_a = opts.costs) == null ? void 0 : _a.slippageAtrMult) !== void 0 && !(Number.isFinite(opts.costs.slippageAtrMult) && opts.costs.slippageAtrMult >= 0)) {
    return EMPTY(
      strategy.id,
      `the cost model s slippageAtrMult is ${String(opts.costs.slippageAtrMult)} — a negative or unreadable multiple would credit every fill and print as an edge`,
      n
    );
  }
  const badTerm = ["spread", "commission", "slippage", "carryPerNight"].find(
    (k) => !Number.isFinite(costs[k]) || costs[k] < 0
  );
  if (badTerm !== void 0) {
    return EMPTY(
      strategy.id,
      `the cost model's ${badTerm} is ${String(costs[badTerm])} — every figure computed from it would be meaningless, and a NaN result reads as "cleared nothing" rather than as an error`,
      n
    );
  }
  const ctx = makeContext(bars, opts.macro);
  const trades = [];
  const equity = new Float64Array(n).fill(1);
  const warnings = [];
  let capital = 1;
  let position = null;
  let runHigh = 0;
  let runLow = 0;
  let exitBasis = "unambiguous";
  let ambiguous = 0;
  let measured = 0;
  let assumedSettles = 0;
  let settleWhy = "";
  const atrCol = costs.slippageAtrMult === void 0 ? null : atr(ctx.high, ctx.low, ctx.close, 14, n);
  const slipAt = (i) => {
    if (atrCol === null || i < 1) return costs.slippage;
    const a = atrCol[i - 1];
    const px2 = ctx.close[i - 1];
    return effectiveSlippage(costs, px2 > 0 ? a / px2 : NaN);
  };
  const minutes = opts.minutes;
  const interval = opts.barIntervalMs ?? 0;
  let minCursor = 0;
  const settleMinutes = (i, stop, target, direction) => {
    if (minutes === void 0) {
      return { hit: "stop", basis: "assumed", why: "no minute bars were supplied for this run" };
    }
    const from = ctx.time[i];
    const to = from + interval;
    while (minCursor < minutes.length && minutes[minCursor].t < from) minCursor += 1;
    let hi = minCursor;
    while (hi < minutes.length && minutes[hi].t < to) hi += 1;
    const r2 = settleBar(minutes.slice(minCursor, hi), { from, to }, { stop, target, direction });
    return { hit: r2.hit, basis: r2.basis, why: r2.why };
  };
  let slippagePct = 0;
  const fill = (price, direction, entering, i) => {
    const slip = slipAt(i);
    slippagePct += slip;
    return modelledFill(price, direction, { ...costs, slippage: slip }, entering);
  };
  const closePosition = (pos, exitIndex, rawExit, reason) => {
    const exitPrice = fill(rawExit, pos.direction, false, exitIndex);
    const gross = pos.direction === "long" ? (exitPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - exitPrice) / pos.entryPrice;
    const nightsHeld = nightsBetween(ctx.time[pos.entryIndex], ctx.time[exitIndex]);
    const carryPct = Math.max(0, costs.carryPerNight) * nightsHeld;
    const net = gross - costs.commission * 2 - carryPct;
    const riskPerUnit = Math.abs(pos.entryPrice - pos.stop) / pos.entryPrice;
    const rMultiple = riskPerUnit > 0 ? net / riskPerUnit : 0;
    const riskPrice = Math.abs(pos.entryPrice - pos.stop);
    const long = pos.direction === "long";
    const adverse = long ? pos.entryPrice - runLow : runHigh - pos.entryPrice;
    const favourable = long ? runHigh - pos.entryPrice : pos.entryPrice - runLow;
    const inR = (v) => riskPrice > 0 ? Math.max(0, v) / riskPrice : 0;
    capital *= 1 + net * (riskPerUnit > 0 ? risk / riskPerUnit : 0);
    trades.push({
      direction: pos.direction,
      entryIndex: pos.entryIndex,
      entryTime: ctx.time[pos.entryIndex],
      entryPrice: pos.entryPrice,
      exitIndex,
      exitTime: ctx.time[exitIndex],
      exitPrice,
      exitReason: reason,
      rMultiple,
      returnPct: net,
      reason: pos.reason,
      maeR: inR(adverse),
      mfeR: inR(favourable),
      nightsHeld,
      carryPct,
      grossPct: gross,
      exitBasis,
      slippagePct
    });
  };
  let pending = null;
  for (let i = strategy.warmup; i < n; i++) {
    if (pending && !position) {
      const raw = ctx.open[i];
      const entryPrice = fill(raw, pending.direction, true, i);
      const valid = fillable(entryPrice, pending.stop, pending.direction);
      if (valid) {
        slippagePct = slipAt(i);
        runHigh = entryPrice;
        runLow = entryPrice;
        position = {
          direction: pending.direction,
          entryIndex: i,
          entryPrice,
          stop: pending.stop,
          target: pending.target ?? null,
          reason: pending.reason
        };
      }
      pending = null;
    }
    if (position) {
      exitBasis = "unambiguous";
      const hi = ctx.high[i];
      const lo = ctx.low[i];
      const hitStop = position.direction === "long" ? lo <= position.stop : hi >= position.stop;
      const hitTarget = position.target !== null && (position.direction === "long" ? hi >= position.target : lo <= position.target);
      let takeStopFirst = hitStop;
      if (hitStop && hitTarget && position.target !== null) {
        ambiguous += 1;
        const r2 = settleMinutes(i, position.stop, position.target, position.direction);
        exitBasis = r2.basis;
        if (r2.basis === "measured") measured += 1;
        else {
          assumedSettles += 1;
          if (settleWhy === "") settleWhy = r2.why;
        }
        takeStopFirst = r2.hit !== "target";
      }
      if (takeStopFirst && hitStop) {
        if (position.direction === "long") runLow = Math.min(runLow, position.stop);
        else runHigh = Math.max(runHigh, position.stop);
        closePosition(position, i, position.stop, "stop");
        position = null;
      } else if (hitTarget && position.target !== null) {
        if (position.direction === "long") {
          runHigh = Math.max(runHigh, position.target);
          runLow = Math.min(runLow, lo);
        } else {
          runLow = Math.min(runLow, position.target);
          runHigh = Math.max(runHigh, hi);
        }
        closePosition(position, i, position.target, "target");
        position = null;
      } else if (strategy.exit) {
        runHigh = Math.max(runHigh, hi);
        runLow = Math.min(runLow, lo);
        const why = strategy.exit(ctx, position, i);
        if (why) {
          closePosition(position, i, ctx.close[i], "rule");
          position = null;
        }
      } else {
        runHigh = Math.max(runHigh, hi);
        runLow = Math.min(runLow, lo);
      }
    }
    if (!position && !pending) {
      const signal = strategy.entry(ctx, i);
      if (signal && Number.isFinite(signal.stop)) pending = signal;
    }
    equity[i] = capital;
  }
  for (let i = 0; i < strategy.warmup && i < n; i++) equity[i] = 1;
  if (position) {
    closePosition(position, n - 1, ctx.close[n - 1], "end-of-data");
    equity[n - 1] = capital;
    warnings.push("a position was open at the end of the data and was closed at the last price");
  }
  if (trades.length < 30) {
    warnings.push(
      `only ${trades.length} trade${trades.length === 1 ? "" : "s"} — too few for the statistics to mean much; treat every metric as noise`
    );
  }
  return {
    strategy: strategy.id,
    trades,
    equity,
    warnings,
    refused: null,
    bars: n,
    friction: summariseFriction(trades, costs),
    settle: {
      ambiguous,
      measured,
      assumed: assumedSettles,
      /* NaN WHEN NOTHING WAS IN DOUBT. Reporting 1 would say every doubtful exit
         was settled on a run that had none, and reporting 0 would say they were
         all guessed. Every formatter here renders NaN as an em dash. */
      share: ambiguous > 0 ? measured / ambiguous : NaN,
      why: settleWhy
    }
  };
}
const EMPTY_METRICS = {
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  profitFactor: 0,
  expectancyR: 0,
  totalReturn: 0,
  maxDrawdown: 0,
  sharpe: 0,
  perTradeSharpe: 0,
  recoveryFactor: 0,
  avgWinR: 0,
  avgLossR: 0,
  maxConsecutiveLosses: 0,
  avgBarsHeld: 0,
  sortino: 0,
  cagr: 0,
  calmar: 0,
  ulcerIndex: 0,
  maxTimeUnderWaterBars: 0,
  exposure: 0
};
function perTradeSharpe(trades) {
  const n = trades.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const t of trades) sum += t.rMultiple;
  const mean = sum / n;
  let sq = 0;
  for (const t of trades) sq += (t.rMultiple - mean) ** 2;
  const sd = Math.sqrt(sq / n);
  return sd > 0 ? mean / sd : Number.NaN;
}
function maxDrawdown(equity) {
  let peak = -Infinity;
  let worst = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}
function sharpeRatio(equity, barsPerYear = 8760) {
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (prev > 0 && Number.isFinite(cur)) rets.push(cur / prev - 1);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r2) => s + r2, 0) / rets.length;
  let variance = 0;
  for (const r2 of rets) variance += (r2 - mean) ** 2;
  variance /= rets.length - 1;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return mean / sd * Math.sqrt(barsPerYear);
}
function barReturns(equity) {
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (prev > 0 && Number.isFinite(cur)) rets.push(cur / prev - 1);
  }
  return rets;
}
function sortinoRatio(equity, barsPerYear = 8760) {
  const rets = barReturns(equity);
  if (rets.length < 2 || !(barsPerYear > 0)) return 0;
  let sum = 0;
  let down = 0;
  for (const r2 of rets) {
    sum += r2;
    if (r2 < 0) down += r2 * r2;
  }
  const semi = Math.sqrt(down / rets.length);
  if (semi === 0) return 0;
  return sum / rets.length / semi * Math.sqrt(barsPerYear);
}
const MIN_CAGR_YEARS = 0.25;
function cagr(equity, barsPerYear) {
  const n = equity.length;
  if (n < 2 || !(barsPerYear > 0)) return 0;
  const first = equity[0];
  const last = equity[n - 1];
  if (!(first > 0) || !Number.isFinite(last)) return 0;
  const years = (n - 1) / barsPerYear;
  if (years < MIN_CAGR_YEARS) return 0;
  if (last <= 0) return -1;
  return (last / first) ** (1 / years) - 1;
}
function drawdownCurve(equity) {
  const out = new Float64Array(equity.length);
  let peak = -Infinity;
  let prev = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (Number.isFinite(v)) {
      if (v > peak) peak = v;
      prev = peak > 0 ? (peak - v) / peak : 0;
    }
    out[i] = prev;
  }
  return out;
}
function ulcerIndex(equity) {
  const dd = drawdownCurve(equity);
  if (dd.length === 0) return 0;
  let sq = 0;
  for (let i = 0; i < dd.length; i++) sq += dd[i] ** 2;
  return Math.sqrt(sq / dd.length);
}
function maxTimeUnderWater(equity) {
  let peak = -Infinity;
  let run = 0;
  let worst = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (!Number.isFinite(v)) continue;
    if (v >= peak) {
      peak = v;
      run = 0;
    } else {
      run++;
      if (run > worst) worst = run;
    }
  }
  return worst;
}
function exposure(trades, bars) {
  if (bars <= 0 || trades.length === 0) return 0;
  const held = new Uint8Array(bars);
  for (const t of trades) {
    if (t.entryIndex < 0 || t.exitIndex >= bars || t.exitIndex < t.entryIndex) return 0;
    held.fill(1, t.entryIndex, t.exitIndex + 1);
  }
  let n = 0;
  for (let i = 0; i < bars; i++) n += held[i];
  return n / bars;
}
function computeMetrics(trades, equity, barsPerYear = 8760) {
  if (trades.length === 0) return { ...EMPTY_METRICS };
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumR = 0;
  let sumWinR = 0;
  let sumLossR = 0;
  let barsHeld = 0;
  let consecutive = 0;
  let worstStreak = 0;
  for (const t of trades) {
    sumR += t.rMultiple;
    barsHeld += t.exitIndex - t.entryIndex;
    if (t.returnPct > 0) {
      wins++;
      grossWin += t.returnPct;
      sumWinR += t.rMultiple;
      consecutive = 0;
    } else {
      grossLoss += Math.abs(t.returnPct);
      sumLossR += t.rMultiple;
      consecutive++;
      if (consecutive > worstStreak) worstStreak = consecutive;
    }
  }
  const losses = trades.length - wins;
  const last = equity.length > 0 ? equity[equity.length - 1] : 1;
  const dd = maxDrawdown(equity);
  const growth = cagr(equity, barsPerYear);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: wins / trades.length,
    // No losses at all makes the ratio infinite; report the gross win instead
    // so the number stays sortable and finite.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? grossWin : 0,
    expectancyR: sumR / trades.length,
    totalReturn: last - 1,
    maxDrawdown: dd,
    sharpe: sharpeRatio(equity, barsPerYear),
    perTradeSharpe: perTradeSharpe(trades),
    recoveryFactor: dd > 0 ? (last - 1) / dd : 0,
    avgWinR: wins > 0 ? sumWinR / wins : 0,
    avgLossR: losses > 0 ? sumLossR / losses : 0,
    maxConsecutiveLosses: worstStreak,
    avgBarsHeld: barsHeld / trades.length,
    sortino: sortinoRatio(equity, barsPerYear),
    cagr: growth,
    calmar: dd > 0 && growth !== 0 ? growth / dd : 0,
    ulcerIndex: ulcerIndex(equity),
    maxTimeUnderWaterBars: maxTimeUnderWater(equity),
    exposure: exposure(trades, equity.length)
  };
}
const MIN_OOS_TRADES$1 = 30;
const MIN_RETENTION = 0.4;
const MAX_PBO = 0.5;
const pctOf = (v) => `${(v * 100).toFixed(0)}%`;
const r = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
function promote(wf, pbo2) {
  const oos = wf.aggregate;
  const checks = [];
  const enough = oos.trades >= MIN_OOS_TRADES$1;
  checks.push({
    id: "sample",
    passed: enough,
    text: enough ? `${oos.trades} out-of-sample trades — enough to read.` : `${oos.trades} out-of-sample trades, under ${MIN_OOS_TRADES$1}. Nothing below this line means anything yet.`
  });
  const positive = oos.expectancyR > 0;
  checks.push({
    id: "expectancy",
    passed: positive,
    text: positive ? `${r(oos.expectancyR)} expectancy out of sample.` : `${r(oos.expectancyR)} expectancy out of sample — it lost money on data it had not seen.`
  });
  const held = Number.isFinite(wf.degradation) && wf.degradation >= MIN_RETENTION && positive;
  checks.push({
    id: "retention",
    passed: held,
    text: Number.isFinite(wf.degradation) ? `${pctOf(wf.degradation)} of the in-sample edge survived out of sample${held ? "." : `, under the ${pctOf(MIN_RETENTION)} floor — most of it was a description of the training slice.`}` : "No usable in-sample edge to degrade from."
  });
  const good = wf.folds.filter((f) => f.outOfSample.expectancyR > 0).length;
  const majority = wf.folds.length > 0 && good * 2 > wf.folds.length;
  checks.push({
    id: "folds",
    passed: majority,
    text: `${good} of ${wf.folds.length} folds were profitable out of sample${majority ? "." : " — one good period is not a strategy."}`
  });
  if (pbo2 !== void 0) {
    const ok = pbo2.pbo <= MAX_PBO;
    checks.push({
      id: "pbo",
      passed: ok,
      /* The check on the SELECTION, not on this strategy. A candidate can be
         individually sound and still be one the sweep had no ability to pick. */
      text: `PBO ${pctOf(pbo2.pbo)}${ok ? " — the selection carries information." : ` — above ${pctOf(MAX_PBO)}, so choosing the best of this set is not distinguishable from choosing at random. That is a fact about the SET, not about this strategy.`}`
    });
  } else {
    checks.push({
      id: "pbo",
      passed: false,
      text: "PBO not computed — a check nobody ran is not a check that passed."
    });
  }
  const promoted = checks.every((c) => c.passed);
  const failed = checks.filter((c) => !c.passed).length;
  return {
    promoted,
    checks,
    outOfSample: oos,
    summary: promoted ? `Promoted — ${r(oos.expectancyR)} over ${oos.trades} out-of-sample trades, ${pctOf(wf.degradation)} of the edge retained.` : `Not promoted — ${failed} of ${checks.length} checks failed.`
  };
}
const TREND_ADX = 25;
const VOL_LOOKBACK = 250;
const VOLATILE_PCTILE = 0.8;
function classifyRegimes(bars) {
  const n = bars.length;
  const out = new Array(n).fill("chop");
  if (n < 30) return out;
  const high = Float64Array.from(bars, (b) => b.h);
  const low = Float64Array.from(bars, (b) => b.l);
  const close = Float64Array.from(bars, (b) => b.c);
  const a = adx(high, low, close, 14, n).adx;
  const vol = atr(high, low, close, 14, n);
  for (let i = 0; i < n; i++) {
    const v = vol[i];
    const c = close[i];
    if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0) continue;
    const normalised = v / c;
    const from = Math.max(0, i - VOL_LOOKBACK);
    let below = 0;
    let seen = 0;
    for (let j = from; j < i; j++) {
      const vj = vol[j];
      const cj = close[j];
      if (!Number.isFinite(vj) || !Number.isFinite(cj) || cj <= 0) continue;
      seen++;
      if (vj / cj < normalised) below++;
    }
    const pctile = seen < 30 ? 0 : below / seen;
    if (pctile >= VOLATILE_PCTILE) {
      out[i] = "volatile";
      continue;
    }
    const adxNow = a[i];
    out[i] = Number.isFinite(adxNow) && adxNow > TREND_ADX ? "trend" : "chop";
  }
  return out;
}
function sliceMetrics(trades) {
  if (trades.length === 0) return { ...EMPTY_METRICS };
  const equity = [1];
  let e = 1;
  for (const t of trades) {
    e *= 1 + t.returnPct;
    equity.push(e);
  }
  return computeMetrics(trades, equity, Math.max(1, trades.length));
}
function byRegime(trades, bars, regimes = classifyRegimes(bars)) {
  const groups = /* @__PURE__ */ new Map();
  for (const t of trades) {
    const idx = t.entryIndex;
    const reg = regimes[Math.max(0, Math.min(idx, regimes.length - 1))] ?? "chop";
    const list = groups.get(reg);
    if (list === void 0) groups.set(reg, [t]);
    else list.push(t);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const r2 of regimes) counts.set(r2, (counts.get(r2) ?? 0) + 1);
  const out = [];
  for (const regime of ["trend", "chop", "volatile"]) {
    const list = groups.get(regime) ?? [];
    out.push({
      regime,
      metrics: sliceMetrics(list),
      exposure: regimes.length === 0 ? 0 : (counts.get(regime) ?? 0) / regimes.length
    });
  }
  return out;
}
function quantile(values, q) {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0];
  const sorted = [...values].sort((a2, b2) => a2 - b2);
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  if (lo === hi) return a;
  const b = sorted[hi];
  return a + (b - a) * (pos - lo);
}
function bodyShares(open, close, len = close.length, window = 400) {
  const to = Math.min(len, close.length);
  const from = Math.max(0, to - window);
  const out = [];
  for (let i = from; i < to; i++) {
    const o = open[i];
    if (!(o > 0)) continue;
    const share = Math.abs(close[i] - o) / o;
    if (Number.isFinite(share)) out.push(share);
  }
  return out;
}
function gapShares(high, low, close, len = close.length, window = 400) {
  const to = Math.min(len, close.length);
  const from = Math.max(2, to - window);
  const out = [];
  for (let i = from; i < to; i++) {
    const px2 = close[i];
    if (!(px2 > 0)) continue;
    const up = low[i] - high[i - 2];
    const down = low[i - 2] - high[i];
    const gap = Math.max(up, down);
    if (gap > 0) out.push(gap / px2);
  }
  return out;
}
function saturate(value, half) {
  if (!(value > 0) || !(half > 0)) return 0;
  return Math.min(value / (value + half), CEILING);
}
const CEILING = 1 - 1e-9;
function findPivots(high, low, opts = {}, len = high.length) {
  const left = Math.max(1, opts.left ?? 3);
  const right = Math.max(1, opts.right ?? 3);
  const minProminence = opts.minProminence ?? 0;
  const out = [];
  if (len < left + right + 1) return out;
  for (let i = left; i < len - right; i++) {
    const h = high[i];
    const l = low[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (isHigh && (j < i ? high[j] >= h : high[j] > h)) isHigh = false;
      if (isLow && (j < i ? low[j] <= l : low[j] < l)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      const p = prominence(high, low, i, left, right, len, "high");
      if (p >= minProminence) {
        out.push({ kind: "high", index: i, price: h, confirmedAt: i + right, prominence: p });
      }
    }
    if (isLow) {
      const p = prominence(high, low, i, left, right, len, "low");
      if (p >= minProminence) {
        out.push({ kind: "low", index: i, price: l, confirmedAt: i + right, prominence: p });
      }
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}
function prominence(high, low, i, left, right, len, kind) {
  const from = Math.max(0, i - left);
  const to = Math.min(len - 1, i + right);
  if (kind === "high") {
    const peak = high[i];
    let deepest = peak;
    for (let j = from; j <= to; j++) {
      const v = low[j];
      if (v < deepest) deepest = v;
    }
    return peak > 0 ? (peak - deepest) / peak : 0;
  }
  const trough = low[i];
  let highest = trough;
  for (let j = from; j <= to; j++) {
    const v = high[j];
    if (v > highest) highest = v;
  }
  return trough > 0 ? (highest - trough) / trough : 0;
}
function alternate(pivots) {
  const out = [];
  for (const p of pivots) {
    const last = out[out.length - 1];
    if (!last || last.kind !== p.kind) {
      out.push(p);
      continue;
    }
    const replace = p.kind === "high" ? p.price > last.price : p.price < last.price;
    if (replace) out[out.length - 1] = p;
  }
  return out;
}
function noiseShare(high, low, close, len = close.length, window = 200) {
  const to = Math.min(len, close.length);
  const from = Math.max(1, to - window);
  if (to - from < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const prev = close[i - 1];
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - prev),
      Math.abs(low[i] - prev)
    );
    const px2 = close[i];
    if (px2 > 0 && Number.isFinite(tr)) {
      sum += tr / px2;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}
const clamp01$1 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function px(v) {
  const abs = Math.abs(v);
  const dp = abs >= 1e3 ? 2 : abs >= 1 ? 4 : 6;
  return v.toFixed(dp);
}
function detectStructure(data, opts = {}, len = data.c.length) {
  const pivots = alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 3,
        right: opts.right ?? 3,
        minProminence: opts.minProminence ?? 1e-3
      },
      len
    )
  );
  if (pivots.length < 3) return [];
  const unit = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  let trend = null;
  let lastHigh = null;
  let lastLow = null;
  let pivotCursor = 0;
  const brokenHighs = /* @__PURE__ */ new Set();
  const brokenLows = /* @__PURE__ */ new Set();
  for (let i = 0; i < len; i++) {
    while (pivotCursor < pivots.length && pivots[pivotCursor].confirmedAt <= i) {
      const p = pivots[pivotCursor];
      if (p.kind === "high") lastHigh = p;
      else lastLow = p;
      pivotCursor++;
    }
    const close = data.c[i];
    if (lastHigh && !brokenHighs.has(lastHigh.index) && close > lastHigh.price) {
      const isContinuation = trend === "up";
      const kind = trend === null || isContinuation ? "bos" : "choch";
      out.push(
        breakDetection({
          kind,
          direction: "long",
          pivot: lastHigh,
          breakIndex: i,
          close,
          maxExtend: opts.maxExtend ?? 60,
          wasTrend: trend,
          atr: unit[i]
        })
      );
      brokenHighs.add(lastHigh.index);
      trend = "up";
    }
    if (lastLow && !brokenLows.has(lastLow.index) && close < lastLow.price) {
      const isContinuation = trend === "down";
      const kind = trend === null || isContinuation ? "bos" : "choch";
      out.push(
        breakDetection({
          kind,
          direction: "short",
          pivot: lastLow,
          breakIndex: i,
          close,
          maxExtend: opts.maxExtend ?? 60,
          wasTrend: trend,
          atr: unit[i]
        })
      );
      brokenLows.add(lastLow.index);
      trend = "down";
    }
  }
  return out;
}
function breakDetection(args) {
  const { kind, direction, pivot, breakIndex, close, wasTrend } = args;
  const bullish = direction === "long";
  const overshootPrice = Math.abs(close - pivot.price);
  const overshootAtr = args.atr > 0 ? overshootPrice / args.atr : 0;
  const prominenceAtr = args.atr > 0 ? pivot.prominence * pivot.price / args.atr : 0;
  const overshoot = overshootPrice / (pivot.price || 1);
  const confidence = clamp01$1(
    0.3 + 0.35 * saturate(overshootAtr, 1) + 0.25 * saturate(prominenceAtr, 3)
  );
  const label = kind === "bos" ? "Break of structure" : "Change of character";
  const reason = kind === "bos" ? `close ${px(close)} broke the prior swing ${bullish ? "high" : "low"} ${px(pivot.price)} (bar ${pivot.index}) ${wasTrend === null ? "establishing" : "continuing"} the ${bullish ? "up" : "down"} leg — cleared by ${(overshoot * 100).toFixed(2)}%` : `close ${px(close)} broke the prior swing ${bullish ? "high" : "low"} ${px(pivot.price)} AGAINST the prevailing ${wasTrend === "up" ? "up" : "down"} trend — first sign that leg is over`;
  const shapes = [
    {
      type: "line",
      x0: pivot.index,
      y0: pivot.price,
      x1: breakIndex,
      y1: pivot.price,
      tone: bullish ? "bull" : "bear",
      dashed: true,
      label: kind === "bos" ? "BOS" : "CHoCH"
    },
    {
      type: "marker",
      x: breakIndex,
      y: close,
      tone: bullish ? "bull" : "bear",
      text: kind === "bos" ? "BOS" : "CHoCH",
      above: bullish
    }
  ];
  return {
    id: `${kind}-${direction}-${pivot.index}-${breakIndex}`,
    kind,
    label,
    direction,
    from: pivot.index,
    to: breakIndex,
    confidence,
    reason,
    shapes
  };
}
const DISPLACEMENT_FALLBACK = 0.012;
const FVG_FALLBACK = 1e-3;
const DISPLACEMENT_QUANTILE = 0.9;
const FVG_QUANTILE = 0.75;
function displacementFloor(data, len) {
  const noise = noiseShare(data.h, data.l, data.c, len);
  const bodies = bodyShares(data.o, data.c, len);
  const rank = bodies.length >= 20 ? quantile(bodies, DISPLACEMENT_QUANTILE) : 0;
  const floor = noise > 0 ? noise : DISPLACEMENT_FALLBACK;
  return Math.max(rank, floor);
}
function fvgFloor(data, len) {
  const noise = noiseShare(data.h, data.l, data.c, len);
  const gaps = gapShares(data.h, data.l, data.c, len);
  const rank = gaps.length >= 12 ? quantile(gaps, FVG_QUANTILE) : 0;
  const floor = noise > 0 ? noise * 0.25 : FVG_FALLBACK;
  return Math.max(rank, floor);
}
function detectFVG(data, opts = {}, len = data.c.length) {
  const minSize = opts.minSize ?? fvgFloor(data, len);
  const hideMitigated = opts.hideMitigated ?? true;
  const maxZones = opts.maxZones ?? 12;
  const a = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  for (let i = 2; i < len; i++) {
    const prevHigh = data.h[i - 2];
    const prevLow = data.l[i - 2];
    const curHigh = data.h[i];
    const curLow = data.l[i];
    const mid = data.c[i - 1];
    if (!Number.isFinite(mid) || mid <= 0) continue;
    let bullish;
    let top;
    let bottom;
    if (curLow > prevHigh) {
      bullish = true;
      bottom = prevHigh;
      top = curLow;
    } else if (curHigh < prevLow) {
      bullish = false;
      bottom = curHigh;
      top = prevLow;
    } else {
      continue;
    }
    const size = (top - bottom) / mid;
    if (size < minSize) continue;
    let mitigatedAt = -1;
    for (let j = i + 1; j < len; j++) {
      const h = data.h[j];
      const l = data.l[j];
      if (l <= top && h >= bottom) {
        mitigatedAt = j;
        break;
      }
    }
    if (hideMitigated && mitigatedAt >= 0) continue;
    const unit = a[i];
    const gapAtr = unit > 0 ? (top - bottom) / unit : 0;
    const confidence = clamp01$1(0.3 + 0.45 * saturate(gapAtr, 0.75));
    out.push({
      id: `fvg-${bullish ? "b" : "s"}-${i}`,
      kind: "fvg",
      label: bullish ? "Bullish FVG" : "Bearish FVG",
      direction: bullish ? "long" : "short",
      from: i - 2,
      to: i,
      confidence,
      reason: `three-bar imbalance: bar ${i} ${bullish ? "low" : "high"} ${px(bullish ? curLow : curHigh)} did not overlap bar ${i - 2} ${bullish ? "high" : "low"} ${px(bullish ? prevHigh : prevLow)}, leaving ${px(bottom)}–${px(top)} (${(size * 100).toFixed(2)}% of price) untraded` + (mitigatedAt >= 0 ? ` — already mitigated at bar ${mitigatedAt}` : " — unmitigated"),
      shapes: [
        {
          type: "box",
          x0: i - 2,
          x1: i,
          y0: bottom,
          y1: top,
          tone: bullish ? "bull" : "bear",
          extend: mitigatedAt < 0,
          label: bullish ? "FVG" : "FVG"
        }
      ]
    });
  }
  return out.slice(-maxZones);
}
function detectOrderBlocks(data, opts = {}, len = data.c.length) {
  const displacement = opts.displacement ?? displacementFloor(data, len);
  const hideMitigated = opts.hideMitigated ?? true;
  const maxZones = opts.maxZones ?? 8;
  const lookback = opts.lookback ?? 3;
  const ao = atr(data.h, data.l, data.c, 14, len);
  const byBlock = /* @__PURE__ */ new Map();
  for (let i = 1; i < len; i++) {
    const open = data.o[i];
    const close = data.c[i];
    if (!Number.isFinite(open) || open <= 0) continue;
    const move = (close - open) / open;
    if (Math.abs(move) < displacement) continue;
    const bullish = move > 0;
    let blockIndex = -1;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      const o = data.o[j];
      const c = data.c[j];
      if (bullish ? c < o : c > o) {
        blockIndex = j;
        break;
      }
    }
    if (blockIndex < 0) continue;
    const top = data.h[blockIndex];
    const bottom = data.l[blockIndex];
    let mitigatedAt = -1;
    for (let j = i + 1; j < len; j++) {
      const h = data.h[j];
      const l = data.l[j];
      if (l <= top && h >= bottom) {
        mitigatedAt = j;
        break;
      }
    }
    if (hideMitigated && mitigatedAt >= 0) continue;
    const unitOb = ao[i];
    const moveAtr = unitOb > 0 ? Math.abs(move) * data.c[i] / unitOb : 0;
    const confidence = clamp01$1(0.3 + 0.45 * saturate(moveAtr, 2));
    const existing = byBlock.get(blockIndex);
    if (existing && existing.confidence >= confidence) continue;
    byBlock.set(blockIndex, {
      id: `ob-${bullish ? "b" : "s"}-${blockIndex}`,
      kind: "order-block",
      label: bullish ? "Bullish order block" : "Bearish order block",
      direction: bullish ? "long" : "short",
      from: blockIndex,
      to: i,
      confidence,
      reason: `bar ${i} displaced ${(move * 100).toFixed(2)}%; bar ${blockIndex} was the last ${bullish ? "down" : "up"} close before it, range ${px(bottom)}–${px(top)}` + (mitigatedAt >= 0 ? ` — mitigated at bar ${mitigatedAt}` : " — unmitigated"),
      shapes: [
        {
          type: "box",
          x0: blockIndex,
          x1: i,
          y0: bottom,
          y1: top,
          tone: bullish ? "bull" : "bear",
          extend: mitigatedAt < 0,
          dashed: true,
          label: "OB"
        }
      ]
    });
  }
  return [...byBlock.values()].sort((a, b) => a.to - b.to).slice(-maxZones);
}
const DEFAULTS$1 = {
  swing: 3,
  equalTolerance: 8e-4,
  lookback: 400,
  maxResults: 6,
  minPenetration: 2e-4
};
function detectSweeps(data, opts = {}, len = data.c.length) {
  const minPen = opts.minPenetration ?? DEFAULTS$1.minPenetration;
  const maxResults = opts.maxResults ?? DEFAULTS$1.maxResults;
  const reclaimWithin = opts.reclaimWithin ?? 3;
  const tol = opts.equalTolerance ?? DEFAULTS$1.equalTolerance;
  const swing = opts.swing ?? DEFAULTS$1.swing;
  const lookback = opts.lookback ?? DEFAULTS$1.lookback;
  const pivots = findPivots(data.h, data.l, { left: swing, right: swing }, len);
  const from = Math.max(0, len - lookback);
  const out = [];
  for (const pivot of pivots) {
    if (pivot.index < from) continue;
    for (let i = pivot.confirmedAt + 1; i < len; i++) {
      const high = data.h[i];
      const low = data.l[i];
      const close = data.c[i];
      if (!Number.isFinite(close)) continue;
      const isHigh = pivot.kind === "high";
      const penetrated = isHigh ? (high - pivot.price) / pivot.price : (pivot.price - low) / pivot.price;
      if (penetrated < minPen) continue;
      let reclaimAt = -1;
      for (let j = i; j < Math.min(len, i + 1 + reclaimWithin); j++) {
        const cj = data.c[j];
        if (isHigh ? cj < pivot.price : cj > pivot.price) {
          reclaimAt = j;
          break;
        }
      }
      if (reclaimAt < 0) break;
      const depth = saturate(penetrated, tol * 4);
      const speed = clamp01$1(1 - (reclaimAt - i) / (reclaimWithin + 1));
      const confidence = clamp01$1(0.35 + 0.3 * depth + 0.3 * speed);
      const extreme = isHigh ? high : low;
      const shapes = [
        {
          type: "level",
          x0: pivot.index,
          y: pivot.price,
          tone: isHigh ? "bear" : "bull",
          dashed: true,
          label: "swept"
        },
        {
          type: "box",
          x0: i - 0.4,
          x1: reclaimAt + 0.4,
          y0: Math.min(pivot.price, extreme),
          y1: Math.max(pivot.price, extreme),
          tone: isHigh ? "bear" : "bull"
        },
        {
          type: "marker",
          x: i,
          y: extreme,
          tone: isHigh ? "bear" : "bull",
          text: isHigh ? "SSL" : "BSL",
          above: isHigh
        }
      ];
      out.push({
        id: `sweep-${pivot.kind}-${pivot.index}-${i}`,
        kind: "liquidity-sweep",
        label: isHigh ? "Sell-side sweep" : "Buy-side sweep",
        /* A raid on highs is a SHORT read and a raid on lows is a LONG one —
           the side that got taken out is the side that is now trapped. */
        direction: isHigh ? "short" : "long",
        from: pivot.index,
        to: reclaimAt,
        confidence,
        reason: `wick ${(penetrated * 100).toFixed(2)}% through ${px(pivot.price)}, closed back inside ${reclaimAt === i ? "on the same bar" : `after ${reclaimAt - i} bar${reclaimAt - i === 1 ? "" : "s"}`} — invalid beyond ${px(extreme)}`,
        shapes
      });
      break;
    }
  }
  return out.slice(-maxResults);
}
const DEFAULTS = { minBars: 10, maxHeightAtr: 3, lookback: 400, maxResults: 4 };
function detectRanges(data, opts = {}, len = data.c.length) {
  const minBars = opts.minBars ?? DEFAULTS.minBars;
  const maxHeightAtr = opts.maxHeightAtr ?? DEFAULTS.maxHeightAtr;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  if (len < minBars + 20) return [];
  const a = atr(data.h, data.l, data.c, 14, len);
  const from = Math.max(20, len - lookback);
  const found = [];
  for (let end = len - 1; end >= from + minBars; end--) {
    const budget = a[end] * maxHeightAtr;
    if (!Number.isFinite(budget) || budget <= 0) continue;
    let hi = -Infinity;
    let lo = Infinity;
    let start = end;
    for (let i = end; i >= from; i--) {
      const h = data.h[i];
      const l = data.l[i];
      const nextHi = Math.max(hi, h);
      const nextLo = Math.min(lo, l);
      if (nextHi - nextLo > budget) break;
      hi = nextHi;
      lo = nextLo;
      start = i;
    }
    if (end - start + 1 < minBars) continue;
    found.push({ start, end, hi, lo, heightAtr: (hi - lo) / a[end] });
    end = start;
  }
  const out = found.map((r2) => {
    let breakAt = -1;
    let breakUp = false;
    for (let i = r2.end + 1; i < len; i++) {
      const c = data.c[i];
      if (c > r2.hi) {
        breakAt = i;
        breakUp = true;
        break;
      }
      if (c < r2.lo) {
        breakAt = i;
        breakUp = false;
        break;
      }
    }
    const bars = r2.end - r2.start + 1;
    const length = clamp01$1((bars - minBars) / (minBars * 3));
    const tightness = clamp01$1(1 - r2.heightAtr / maxHeightAtr);
    const confidence = clamp01$1(0.4 + 0.3 * length + 0.3 * tightness);
    const shapes = [
      {
        type: "box",
        x0: r2.start - 0.5,
        x1: (breakAt < 0 ? len - 1 : breakAt) + 0.5,
        y0: r2.lo,
        y1: r2.hi,
        tone: "neutral",
        dashed: true,
        label: `${bars} bars`
      }
    ];
    if (breakAt >= 0) {
      shapes.push({
        type: "marker",
        x: breakAt,
        y: breakUp ? r2.hi : r2.lo,
        tone: breakUp ? "bull" : "bear",
        text: "EXP",
        above: breakUp
      });
    }
    return {
      id: `range-${r2.start}-${r2.end}`,
      kind: breakAt >= 0 ? "expansion" : "range",
      label: breakAt >= 0 ? "Range expansion" : "Range",
      /* An unbroken range has no direction, and saying otherwise would be the
         single most common way this detector could mislead. */
      direction: breakAt < 0 ? "neutral" : breakUp ? "long" : "short",
      from: r2.start,
      to: breakAt < 0 ? r2.end : breakAt,
      confidence,
      reason: breakAt < 0 ? `${bars} bars between ${px(r2.lo)} and ${px(r2.hi)} — ${r2.heightAtr.toFixed(1)} ATR tall, still inside` : `${bars}-bar range between ${px(r2.lo)} and ${px(r2.hi)}, closed ${breakUp ? "above" : "below"} it`,
      shapes
    };
  });
  return out.slice(0, maxResults);
}
const STRUCTURAL_COLUMNS = {
  /** +1 on the bar a bullish break of structure completed, −1 bearish, else 0. */
  bos: "Break of structure (+1 up / −1 down)",
  /** +1 / −1 on the bar a change of character completed. */
  choch: "Change of character (+1 up / −1 down)",
  /** +1 on the bar a buy-side sweep was reclaimed, −1 for sell-side. */
  sweep: "Liquidity sweep (+1 long / −1 short)",
  /** +1 while close sits inside an unmitigated bullish FVG, −1 bearish. */
  infvg: "Inside a fair value gap (+1 bull / −1 bear)",
  /** +1 while close sits inside a bullish order block, −1 bearish. */
  inob: "Inside an order block (+1 bull / −1 bear)",
  /** +1 on the bar price closed out of a range upward, −1 downward. */
  expansion: "Range expansion (+1 up / −1 down)",
  /** 1 while price is inside a detected range, else 0. */
  inrange: "Inside a range (1 / 0)"
};
const UNCAPPED = 1e9;
const cache$2 = /* @__PURE__ */ new WeakMap();
const sign = (d) => d.direction === "long" ? 1 : d.direction === "short" ? -1 : 0;
function structuralColumns(ctx, needed) {
  let table = cache$2.get(ctx);
  if (table === void 0) {
    table = {};
    cache$2.set(ctx, table);
  }
  const wanted = Object.keys(STRUCTURAL_COLUMNS).filter(
    (id) => needed.has(id) && table[id] === void 0
  );
  if (wanted.length === 0) return table;
  const data = {
    t: ctx.time,
    o: ctx.open,
    h: ctx.high,
    l: ctx.low,
    c: ctx.close,
    v: ctx.volume
  };
  const n = ctx.close.length;
  const want = new Set(wanted);
  const found = [];
  if (want.has("bos") || want.has("choch")) {
    found.push(...detectStructure(data, {}, n));
  }
  if (want.has("sweep")) {
    found.push(...detectSweeps(data, { maxResults: UNCAPPED }, n));
  }
  if (want.has("infvg")) {
    found.push(...detectFVG(data, { maxZones: UNCAPPED, hideMitigated: false }, n));
  }
  if (want.has("inob")) {
    found.push(...detectOrderBlocks(data, { maxZones: UNCAPPED, hideMitigated: false }, n));
  }
  if (want.has("expansion") || want.has("inrange")) {
    found.push(...detectRanges(data, { maxResults: UNCAPPED }, n));
  }
  const blank = () => new Float64Array(n);
  for (const id of wanted) {
    const col = blank();
    if (id === "bos" || id === "choch") {
      for (const d of found) {
        if (d.kind !== id) continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "sweep") {
      for (const d of found) {
        if (d.kind !== "liquidity-sweep") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "expansion") {
      for (const d of found) {
        if (d.kind !== "expansion") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "inrange") {
      for (const d of found) {
        if (d.kind !== "range") continue;
        for (let i = d.to; i < n; i++) {
          const box = d.shapes.find((s) => s.type === "box");
          if (box === void 0 || box.type !== "box") break;
          const c = ctx.close[i];
          if (c < Math.min(box.y0, box.y1) || c > Math.max(box.y0, box.y1)) break;
          col[i] = 1;
        }
      }
    } else {
      const kind = id === "infvg" ? "fvg" : "order-block";
      for (const d of found) {
        if (d.kind !== kind) continue;
        const box = d.shapes.find((s2) => s2.type === "box");
        if (box === void 0 || box.type !== "box") continue;
        const lo = Math.min(box.y0, box.y1);
        const hi = Math.max(box.y0, box.y1);
        const s = sign(d);
        for (let i = d.to + 1; i < n; i++) {
          const c = ctx.close[i];
          if (c >= lo && c <= hi) {
            col[i] = s;
            break;
          }
          if (s > 0 && c < lo) break;
          if (s < 0 && c > hi) break;
        }
      }
    }
    table[id] = col;
  }
  return table;
}
const COLUMNS = {
  open: "Open",
  high: "High",
  low: "Low",
  close: "Close",
  ema9: "EMA 9",
  ema20: "EMA 20",
  ema21: "EMA 21",
  ema50: "EMA 50",
  ema200: "EMA 200",
  rsi: "RSI(14)",
  atr: "ATR(14)",
  macd: "MACD line",
  macds: "MACD signal",
  macdh: "MACD histogram",
  stochk: "Stochastic %K",
  stochd: "Stochastic %D",
  cci: "CCI(20)",
  willr: "Williams %R(14)",
  bbu: "Bollinger upper",
  bbm: "Bollinger middle",
  bbl: "Bollinger lower",
  stdir: "Supertrend direction",
  vwap: "VWAP",
  roc: "ROC(12) %",
  adx: "ADX(14)",
  mfi: "MFI(14)",
  /* v49 bands and systems. Every one of these uses the RANGE or a second
     instrument rather than rearranging close a sixth time — see the note at
     the foot of `chart/indicators.ts`. */
  kcu: "Keltner upper",
  kcm: "Keltner middle",
  kcl: "Keltner lower",
  dcu: "Donchian upper (excl. current bar)",
  dcl: "Donchian lower (excl. current bar)",
  squeeze: "Squeeze on (1 / 0)",
  celong: "Chandelier exit, long",
  ceshort: "Chandelier exit, short",
  tenkan: "Ichimoku conversion",
  kijun: "Ichimoku base",
  /* v49 structure. These are what the DETECTORS found, compiled to columns —
     see `backtest/structural.ts` for why every event is written at the bar it
     became knowable and never at the bar it began. */
  ...STRUCTURAL_COLUMNS,
  /* v63.21 CONTEXT. These are the only columns that come from a SECOND
       INSTRUMENT, and they exist because the shipped rules have no standalone
       edge: measured over 5 years and 821 trades per arm the best per-trade
       Sharpe was +0.070 against a hurdle of +0.102. The remaining question is
       not "which rule works" but "in which STATE does one work", and a state
       needs a second series.
  
       A CHANGE is computed on the context series' OWN bars before alignment —
       `dxy_chg5` is five DXY trading days, never five rows of a value carried
       across a weekend. `copper_gold` is DERIVED at read time: a ratio of two
       stored series is not a third series, only a second place to disagree. */
  dxy: "US dollar index",
  dxy_chg5: "US dollar index, 5-day change",
  us10y: "US 10-year yield",
  us10y_chg5: "US 10-year yield, 5-day change",
  us02y: "US 2-year yield",
  vix: "VIX",
  vix_chg5: "VIX, 5-day change",
  spx: "S&P 500",
  spx_chg5: "S&P 500, 5-day change",
  usdjpy: "USD/JPY",
  copper_gold: "Copper / gold ratio"
};
const MACRO_COLUMNS = [
  "dxy",
  "dxy_chg5",
  "us10y",
  "us10y_chg5",
  "us02y",
  "vix",
  "vix_chg5",
  "spx",
  "spx_chg5",
  "usdjpy",
  "copper_gold"
];
new Set(MACRO_COLUMNS);
const OPERATORS = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crossabove: "crosses above",
  crossbelow: "crosses below"
};
const isColumn = (v) => Object.prototype.hasOwnProperty.call(COLUMNS, v);
function parseOperand(v) {
  if (typeof v !== "string") return null;
  if (isColumn(v)) return { kind: "column", id: v };
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? { kind: "number", value: n } : null;
}
function validateSpec(spec) {
  var _a;
  const problems = [];
  const checkGroup = (group2, where) => {
    if (!group2) return;
    group2.forEach((cond, i) => {
      const at2 = `${where}[${i}]`;
      if (!Array.isArray(cond) || cond.length !== 3) {
        problems.push({ where: at2, message: "A condition must be exactly [column, operator, value]." });
        return;
      }
      const [l, op, r2] = cond;
      if (!isColumn(l)) problems.push({ where: at2, message: `"${l}" is not an indicator this build computes.` });
      if (!Object.prototype.hasOwnProperty.call(OPERATORS, op)) {
        problems.push({ where: at2, message: `"${op}" is not an operator.` });
      }
      if (parseOperand(r2) === null) {
        problems.push({ where: at2, message: `"${r2}" is neither an indicator nor a number.` });
      }
    });
  };
  if (spec.long.length === 0 && (((_a = spec.short) == null ? void 0 : _a.length) ?? 0) === 0) {
    problems.push({ where: "entry", message: "A strategy with no entry condition never trades." });
  }
  checkGroup(spec.long, "long");
  checkGroup(spec.short, "short");
  checkGroup(spec.exitLong, "exitLong");
  checkGroup(spec.exitShort, "exitShort");
  if (spec.stop.type === "atr" && !(spec.stop.mult > 0)) {
    problems.push({ where: "stop", message: "An ATR stop needs a positive multiple." });
  }
  if (spec.stop.type === "pct" && !(spec.stop.value > 0)) {
    problems.push({ where: "stop", message: "A percent stop needs a positive distance." });
  }
  return problems;
}
const cache$1 = /* @__PURE__ */ new WeakMap();
function columnsFor(ctx, needed) {
  var _a;
  let table = cache$1.get(ctx);
  if (!table) {
    table = {};
    cache$1.set(ctx, table);
  }
  const t = table;
  const want = (id, build) => {
    if (!needed.has(id) || t[id]) return;
    t[id] = build();
  };
  want("open", () => ctx.open);
  want("high", () => ctx.high);
  want("low", () => ctx.low);
  want("close", () => ctx.close);
  want("ema9", () => ema(ctx.close, 9));
  want("ema20", () => ema(ctx.close, 20));
  want("ema21", () => ema(ctx.close, 21));
  want("ema50", () => ema(ctx.close, 50));
  want("ema200", () => ema(ctx.close, 200));
  want("rsi", () => rsi(ctx.close, 14));
  want("atr", () => atr(ctx.high, ctx.low, ctx.close, 14));
  want("roc", () => roc(ctx.close, 12));
  want("willr", () => williamsR(ctx.high, ctx.low, ctx.close, 14));
  want("cci", () => cci(ctx.high, ctx.low, ctx.close, 20));
  want("mfi", () => mfi(ctx.high, ctx.low, ctx.close, ctx.volume, 14));
  want("stdir", () => supertrendDirection(ctx.high, ctx.low, ctx.close, 10, 3));
  want("vwap", () => vwap(ctx.high, ctx.low, ctx.close, ctx.volume, ctx.time));
  want("adx", () => adx(ctx.high, ctx.low, ctx.close, 14).adx);
  want("squeeze", () => squeeze(ctx.high, ctx.low, ctx.close));
  if ((needed.has("kcu") || needed.has("kcm") || needed.has("kcl")) && !t.kcm) {
    const k = keltner(ctx.high, ctx.low, ctx.close);
    t.kcu = k.upper;
    t.kcm = k.middle;
    t.kcl = k.lower;
  }
  if ((needed.has("dcu") || needed.has("dcl")) && !t.dcu) {
    const d = donchian(ctx.high, ctx.low, 20, true);
    t.dcu = d.upper;
    t.dcl = d.lower;
  }
  if ((needed.has("celong") || needed.has("ceshort")) && !t.celong) {
    const ce = chandelier(ctx.high, ctx.low, ctx.close);
    t.celong = ce.long;
    t.ceshort = ce.short;
  }
  if ((needed.has("tenkan") || needed.has("kijun")) && !t.tenkan) {
    const ic = ichimoku(ctx.high, ctx.low, ctx.close);
    t.tenkan = ic.conversion;
    t.kijun = ic.base;
  }
  for (const id of MACRO_COLUMNS) {
    if (!needed.has(id) || t[id]) continue;
    const supplied = (_a = ctx.macro) == null ? void 0 : _a[id];
    t[id] = supplied && supplied.length === ctx.close.length ? supplied : new Float64Array(ctx.close.length).fill(NaN);
  }
  const structural = structuralColumns(ctx, needed);
  for (const [id, col] of Object.entries(structural)) {
    if (needed.has(id) && col !== void 0) {
      t[id] = col;
    }
  }
  if ((needed.has("macd") || needed.has("macds") || needed.has("macdh")) && !t.macd) {
    const m = macd(ctx.close, 12, 26, 9);
    t.macd = m.macd;
    t.macds = m.signal;
    t.macdh = m.histogram;
  }
  if ((needed.has("stochk") || needed.has("stochd")) && !t.stochk) {
    const s = stochastic(ctx.high, ctx.low, ctx.close, 14, 3, 3);
    t.stochk = s.k;
    t.stochd = s.d;
  }
  if ((needed.has("bbu") || needed.has("bbm") || needed.has("bbl")) && !t.bbm) {
    const b = bollinger(ctx.close, 20, 2);
    t.bbu = b.upper;
    t.bbm = b.middle;
    t.bbl = b.lower;
  }
  return t;
}
function referenced(spec) {
  const out = /* @__PURE__ */ new Set();
  const scan = (g) => {
    for (const [l, , r2] of g ?? []) {
      out.add(l);
      const p = parseOperand(r2);
      if ((p == null ? void 0 : p.kind) === "column") out.add(p.id);
    }
  };
  scan(spec.long);
  scan(spec.short);
  scan(spec.exitLong);
  scan(spec.exitShort);
  if (spec.stop.type === "atr") out.add("atr");
  return out;
}
const at = (col, i) => col === void 0 || i < 0 || i >= col.length ? NaN : col[i];
function evalCondition(cond, cols, i) {
  const [leftId, op, right] = cond;
  const left = cols[leftId];
  const now = at(left, i);
  if (!Number.isFinite(now)) return false;
  const p = parseOperand(right);
  if (p === null) return false;
  const rNow = p.kind === "number" ? p.value : at(cols[p.id], i);
  if (!Number.isFinite(rNow)) return false;
  switch (op) {
    case ">":
      return now > rNow;
    case "<":
      return now < rNow;
    case ">=":
      return now >= rNow;
    case "<=":
      return now <= rNow;
    case "crossabove":
    case "crossbelow": {
      const prev = at(left, i - 1);
      const rPrev = p.kind === "number" ? p.value : at(cols[p.id], i - 1);
      if (!Number.isFinite(prev) || !Number.isFinite(rPrev)) return false;
      return op === "crossabove" ? prev <= rPrev && now > rNow : prev >= rPrev && now < rNow;
    }
    default:
      return false;
  }
}
function evalGroup(group2, cols, i) {
  if (!group2 || group2.length === 0) return false;
  for (const c of group2) if (!evalCondition(c, cols, i)) return false;
  return true;
}
const operandLabel = (v) => {
  const p = parseOperand(v);
  if (p === null) return String(v);
  return p.kind === "column" ? COLUMNS[p.id] : String(p.value);
};
function conditionText(c) {
  return `${COLUMNS[c[0]] ?? c[0]} ${OPERATORS[c[1]] ?? c[1]} ${operandLabel(c[2])}`;
}
function groupText(g) {
  if (!g || g.length === 0) return "—";
  return g.map(conditionText).join(" AND ");
}
function stopText(s) {
  return s.type === "atr" ? `${s.mult} × ATR(14) from entry` : `${s.value}% from entry`;
}
function targetText(t) {
  if (t.type === "rr") return `${t.value}× the risk`;
  if (t.type === "pct") return `${t.value}% from entry`;
  return "exit rule only";
}
function warmupFor(needed) {
  let n = 20;
  if (needed.has("ema200")) n = Math.max(n, 200);
  if (needed.has("ema50")) n = Math.max(n, 50);
  if (needed.has("ema21")) n = Math.max(n, 21);
  if (needed.has("ema20")) n = Math.max(n, 20);
  if (needed.has("bbu") || needed.has("bbm") || needed.has("bbl")) n = Math.max(n, 20);
  if (needed.has("cci")) n = Math.max(n, 20);
  if (needed.has("adx")) n = Math.max(n, 28);
  if (needed.has("stdir")) n = Math.max(n, 20);
  if (needed.has("mfi") || needed.has("rsi") || needed.has("willr") || needed.has("stochk") || needed.has("stochd")) {
    n = Math.max(n, 18);
  }
  if (needed.has("macd") || needed.has("macds") || needed.has("macdh")) n = Math.max(n, 35);
  return n + 5;
}
function compileSpec(spec) {
  const needed = referenced(spec);
  const warmup = warmupFor(needed);
  return {
    id: spec.id,
    label: spec.name,
    warmup,
    params: {
      stop: spec.stop.type === "atr" ? spec.stop.mult : spec.stop.value,
      target: spec.target.type === "none" ? 0 : spec.target.value
    },
    rules: {
      entry: `LONG when ${groupText(spec.long)}${spec.short ? `; SHORT when ${groupText(spec.short)}` : ""}`,
      stop: stopText(spec.stop),
      exit: spec.target.type === "none" ? `exit rule: ${groupText(spec.exitLong)}` : `${targetText(spec.target)}, or the exit rule (${groupText(spec.exitLong)})`,
      ...spec.note ? { note: spec.note } : {}
    },
    entry(ctx, i) {
      const cols = columnsFor(ctx, needed);
      const long = evalGroup(spec.long, cols, i);
      const short = !long && evalGroup(spec.short, cols, i);
      if (!long && !short) return null;
      const price = ctx.close[i];
      if (!Number.isFinite(price) || price <= 0) return null;
      let risk;
      if (spec.stop.type === "atr") {
        const a = at(cols.atr, i);
        if (!Number.isFinite(a) || a <= 0) return null;
        risk = a * spec.stop.mult;
      } else {
        risk = price * spec.stop.value / 100;
      }
      if (!(risk > 0)) return null;
      const dir = long ? 1 : -1;
      const stop = price - dir * risk;
      let target;
      if (spec.target.type === "rr") target = price + dir * risk * spec.target.value;
      else if (spec.target.type === "pct") target = price * (1 + dir * spec.target.value / 100);
      return {
        direction: long ? "long" : "short",
        stop,
        ...target !== void 0 ? { target } : {},
        reason: long ? groupText(spec.long) : groupText(spec.short)
      };
    },
    exit(ctx, position, i) {
      const group2 = position.direction === "long" ? spec.exitLong : spec.exitShort;
      if (!group2 || group2.length === 0) return null;
      const cols = columnsFor(ctx, needed);
      return evalGroup(group2, cols, i) ? `Exit rule: ${groupText(group2)}` : null;
    }
  };
}
const MIN_BARS = 210;
const NEUTRAL = (reason) => ({
  bias: "neutral",
  score: 0,
  agreement: 0,
  confidence: 0,
  signals: [],
  insufficient: reason
});
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const finite$1 = (v) => v !== void 0 && Number.isFinite(v);
function fmt(v) {
  const abs = Math.abs(v);
  const dp = abs >= 1e3 ? 0 : abs >= 1 ? 2 : 4;
  return v.toFixed(dp);
}
function confluence(bars) {
  const n = bars.c.length;
  if (n < MIN_BARS) {
    return NEUTRAL(`only ${n} bars — need ${MIN_BARS} for a stable read`);
  }
  const i = n - 1;
  const close = bars.c[i];
  if (!Number.isFinite(close) || close <= 0) return NEUTRAL("last close is not a usable price");
  const signals = [];
  const e20 = ema(bars.c, 20);
  const e50 = ema(bars.c, 50);
  const e200 = ema(bars.c, 200);
  const a20 = e20[i];
  const a50 = e50[i];
  const a200 = e200[i];
  if (finite$1(a20) && finite$1(a50) && finite$1(a200)) {
    const f20 = a20;
    const f50 = a50;
    const f200 = a200;
    const stackedUp = f20 > f50 && f50 > f200;
    const stackedDown = f20 < f50 && f50 < f200;
    const spread = Math.abs(f20 - f200) / close;
    const strength = clamp01(spread / 0.05);
    if (stackedUp || stackedDown) {
      signals.push({
        id: "ma-stack",
        name: "MA structure",
        direction: stackedUp ? "long" : "short",
        strength,
        weight: 2,
        reason: `EMA20/50/200 stacked ${stackedUp ? "bullish" : "bearish"} (${fmt(f20)} / ${fmt(f50)} / ${fmt(f200)}), spread ${(spread * 100).toFixed(2)}% of price`
      });
    } else {
      signals.push({
        id: "ma-stack",
        name: "MA structure",
        direction: "neutral",
        strength: 0,
        weight: 2,
        reason: `EMA20/50/200 interleaved (${fmt(f20)} / ${fmt(f50)} / ${fmt(f200)}) — no clean trend structure`
      });
    }
  }
  if (finite$1(a200)) {
    const f200 = a200;
    const dist = (close - f200) / close;
    signals.push({
      id: "ma-location",
      name: "Price vs EMA200",
      direction: dist > 2e-3 ? "long" : dist < -2e-3 ? "short" : "neutral",
      strength: clamp01(Math.abs(dist) / 0.04),
      weight: 1.5,
      reason: `price ${fmt(close)} is ${(dist * 100).toFixed(2)}% ${dist >= 0 ? "above" : "below"} EMA200 ${fmt(f200)}`
    });
  }
  const r2 = rsi(bars.c, 14)[i];
  if (finite$1(r2)) {
    const rv = r2;
    const off = (rv - 50) / 50;
    signals.push({
      id: "rsi",
      name: "RSI(14)",
      direction: rv > 55 ? "long" : rv < 45 ? "short" : "neutral",
      strength: clamp01(Math.abs(off) / 0.5),
      weight: 1.25,
      reason: rv > 70 ? `RSI ${rv.toFixed(1)} — overbought, momentum up but stretched` : rv < 30 ? `RSI ${rv.toFixed(1)} — oversold, momentum down but stretched` : `RSI ${rv.toFixed(1)} (${rv >= 50 ? "above" : "below"} midline)`
    });
  }
  const m = macd(bars.c);
  const hist = m.histogram[i];
  const prevHist = m.histogram[i - 1];
  if (finite$1(hist)) {
    const hv = hist;
    const rising = finite$1(prevHist) ? hv > prevHist : false;
    signals.push({
      id: "macd",
      name: "MACD",
      direction: hv > 0 ? "long" : hv < 0 ? "short" : "neutral",
      strength: clamp01(Math.abs(hv) / (close * 4e-3)),
      weight: 1.25,
      reason: `MACD histogram ${hv >= 0 ? "+" : ""}${fmt(hv)} and ${rising ? "rising" : "falling"}`
    });
  }
  const bb = bollinger(bars.c, 20, 2);
  const up = bb.upper[i];
  const lo = bb.lower[i];
  if (finite$1(up) && finite$1(lo)) {
    const u = up;
    const l = lo;
    const span = u - l;
    if (span > 0) {
      const pos = (close - l) / span;
      const off = (pos - 0.5) * 2;
      signals.push({
        id: "bb-position",
        name: "Bollinger position",
        direction: pos > 0.6 ? "long" : pos < 0.4 ? "short" : "neutral",
        strength: clamp01(Math.abs(off)),
        weight: 0.75,
        reason: `price sits at ${(pos * 100).toFixed(0)}% of the 20/2 band (${fmt(l)} – ${fmt(u)})`
      });
    }
  }
  const volLookback = 20;
  let volSum = 0;
  for (let j = i - volLookback; j < i; j++) volSum += bars.v[j];
  const volAvg = volSum / volLookback;
  const volNow = bars.v[i];
  if (volAvg > 0 && Number.isFinite(volNow)) {
    const ratio = volNow / volAvg;
    const barDir = close > bars.o[i] ? "long" : close < bars.o[i] ? "short" : "neutral";
    signals.push({
      id: "volume",
      name: "Volume",
      direction: ratio > 1.2 ? barDir : "neutral",
      strength: clamp01((ratio - 1) / 1.5),
      weight: 0.75,
      reason: `volume ${ratio.toFixed(2)}x the 20-bar average${ratio > 1.2 ? ` confirming a ${barDir} bar` : " — unremarkable"}`
    });
  }
  let weighted = 0;
  let totalWeight = 0;
  for (const s of signals) {
    const dir = s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0;
    weighted += dir * s.strength * s.weight;
    totalWeight += s.weight;
  }
  if (totalWeight === 0) return NEUTRAL("no module produced a usable reading");
  const score = weighted / totalWeight;
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
  const atrArr = atr(bars.h, bars.l, bars.c, 14);
  const atrNow = atrArr[i];
  let confidence = clamp01(Math.abs(score) * 1.6) * (0.4 + 0.6 * agreement);
  let volNote = "";
  const stack = signals.find((sg) => sg.id === "ma-stack");
  if (stack && stack.direction === "neutral") {
    confidence *= 0.55;
  } else if (stack && score !== 0 && stack.direction !== (score > 0 ? "long" : "short")) {
    confidence *= 0.7;
  }
  if (finite$1(atrNow)) {
    const atrPct = atrNow / close * 100;
    let sum = 0;
    let count = 0;
    for (let j = i - 100; j < i; j++) {
      const a = atrArr[j];
      if (finite$1(a)) {
        sum += a;
        count++;
      }
    }
    const atrAvg = count > 0 ? sum / count : atrNow;
    const volRatio = atrAvg > 0 ? atrNow / atrAvg : 1;
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
      direction: "neutral",
      // never votes on direction
      strength: 0,
      weight: 0,
      reason: `ATR ${atrPct.toFixed(2)}% of price; ${volNote}`
    });
  }
  const bias = score > 0.12 ? "long" : score < -0.12 ? "short" : "neutral";
  return {
    bias,
    score,
    agreement,
    confidence: clamp01(confidence),
    signals,
    insufficient: null
  };
}
const cache = /* @__PURE__ */ new WeakMap();
function cached(ctx, key, build) {
  let table = cache.get(ctx);
  if (!table) {
    table = /* @__PURE__ */ new Map();
    cache.set(ctx, table);
  }
  const hit = table.get(key);
  if (hit) return hit;
  const built = build();
  table.set(key, built);
  return built;
}
const scanBars = (ctx) => ({
  t: ctx.time,
  o: ctx.open,
  h: ctx.high,
  l: ctx.low,
  c: ctx.close,
  v: ctx.volume
});
function emaTrend(fast = 20, slow = 50, atrMult = 2, rr = 2) {
  return {
    id: `ema-${fast}-${slow}-${atrMult}x${rr}`,
    label: `EMA ${fast}/${slow} trend`,
    warmup: Math.max(slow, 14) + 5,
    params: { fast, slow, atrMult, rr },
    rules: {
      entry: `EMA${fast} crosses above EMA${slow} for longs, below for shorts`,
      stop: `${atrMult} x ATR(14) from entry`,
      exit: `fixed target at ${rr}R, or the stop`
    },
    entry(ctx, i) {
      const f = cached(ctx, `ema${fast}`, () => ema(ctx.close, fast));
      const s = cached(ctx, `ema${slow}`, () => ema(ctx.close, slow));
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));
      const fNow = f[i];
      const sNow = s[i];
      const fPrev = f[i - 1];
      const sPrev = s[i - 1];
      const atrNow = a[i];
      if (![fNow, sNow, fPrev, sPrev, atrNow].every(Number.isFinite) || atrNow <= 0) return null;
      const crossedUp = fPrev <= sPrev && fNow > sNow;
      const crossedDown = fPrev >= sPrev && fNow < sNow;
      if (!crossedUp && !crossedDown) return null;
      const price = ctx.close[i];
      const risk = atrNow * atrMult;
      const direction = crossedUp ? "long" : "short";
      return {
        direction,
        stop: crossedUp ? price - risk : price + risk,
        target: crossedUp ? price + risk * rr : price - risk * rr,
        reason: `EMA${fast} crossed ${crossedUp ? "above" : "below"} EMA${slow} (${fNow.toFixed(2)} vs ${sNow.toFixed(2)}); stop ${atrMult}x ATR = ${risk.toFixed(2)}`
      };
    }
  };
}
function rsiReversion(period = 14, low = 30, high = 70, atrMult = 2, rr = 1.5) {
  return {
    id: `rsi-${period}-${low}-${high}-${atrMult}x${rr}`,
    label: `RSI(${period}) reversion`,
    warmup: Math.max(period, 200) + 5,
    params: { period, low, high, atrMult, rr },
    rules: {
      entry: `RSI crosses back up through ${low} above EMA200, or down through ${high} below it`,
      stop: `${atrMult} x ATR(14)`,
      exit: `target at ${rr}R, or the stop`
    },
    entry(ctx, i) {
      const r2 = cached(ctx, `rsi${period}`, () => rsi(ctx.close, period));
      const trend = cached(ctx, "ema200", () => ema(ctx.close, 200));
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));
      const rNow = r2[i];
      const rPrev = r2[i - 1];
      const t200 = trend[i];
      const atrNow = a[i];
      if (![rNow, rPrev, t200, atrNow].every(Number.isFinite) || atrNow <= 0) return null;
      const price = ctx.close[i];
      const risk = atrNow * atrMult;
      const longSetup = rPrev <= low && rNow > low && price > t200;
      const shortSetup = rPrev >= high && rNow < high && price < t200;
      if (!longSetup && !shortSetup) return null;
      return {
        direction: longSetup ? "long" : "short",
        stop: longSetup ? price - risk : price + risk,
        target: longSetup ? price + risk * rr : price - risk * rr,
        reason: `RSI ${rPrev.toFixed(1)} → ${rNow.toFixed(1)} crossed ${longSetup ? `up through ${low}` : `down through ${high}`} with price ${longSetup ? "above" : "below"} EMA200 ${t200.toFixed(2)}`
      };
    }
  };
}
function confluenceStrategy(minScore = 0.35, minConfidence = 0.4, atrMult = 2, rr = 2, stride = 4) {
  return {
    id: `confluence-${minScore}-${minConfidence}-${atrMult}x${rr}`,
    label: `Confluence ≥ ${minScore}`,
    warmup: 215,
    params: { minScore, minConfidence, atrMult, rr, stride },
    rules: {
      entry: `glass-box confluence score beyond ±${minScore} with confidence ≥ ${minConfidence}`,
      stop: `${atrMult} x ATR(14)`,
      exit: `target at ${rr}R, or the stop`
    },
    entry(ctx, i) {
      if (i % stride !== 0) return null;
      const a = cached(ctx, "atr14", () => atr(ctx.high, ctx.low, ctx.close, 14));
      const atrNow = a[i];
      if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
      const window = i + 1;
      const src = scanBars(ctx);
      const view = {
        t: src.t.subarray(0, window),
        o: src.o.subarray(0, window),
        h: src.h.subarray(0, window),
        l: src.l.subarray(0, window),
        c: src.c.subarray(0, window),
        v: src.v.subarray(0, window)
      };
      const read = confluence(view);
      if (read.insufficient) return null;
      if (Math.abs(read.score) < minScore || read.confidence < minConfidence) return null;
      const price = ctx.close[i];
      const risk = atrNow * atrMult;
      const long = read.score > 0;
      const top = read.signals.filter((s) => s.weight > 0 && s.direction !== "neutral").slice(0, 2).map((s) => s.reason).join("; ");
      return {
        direction: long ? "long" : "short",
        stop: long ? price - risk : price + risk,
        target: long ? price + risk * rr : price - risk * rr,
        reason: `confluence ${read.score.toFixed(2)} (confidence ${read.confidence.toFixed(2)}) — ${top}`
      };
    }
  };
}
const defaultScore = (m) => m.trades < 10 ? -Infinity : m.expectancyR * Math.min(1, m.trades / 30);
function walkForward(candidates, bars, opts = {}) {
  const foldCount = Math.max(2, opts.folds ?? 5);
  const trainRatio = Math.min(0.9, Math.max(0.1, opts.trainRatio ?? 0.7));
  const score = opts.score ?? defaultScore;
  const warnings = [];
  if (candidates.length === 0) {
    return {
      folds: [],
      aggregate: computeMetrics([], []),
      degradation: 0,
      warnings: ["no candidate strategies"],
      verdict: "nothing to validate"
    };
  }
  const windowSize = Math.floor(bars.length / foldCount);
  const maxWarmup = Math.max(...candidates.map((c) => c.warmup));
  if (windowSize < maxWarmup * 2) {
    return {
      folds: [],
      aggregate: computeMetrics([], []),
      degradation: 0,
      warnings: [
        `${bars.length} bars over ${foldCount} folds leaves ${windowSize} per fold, below twice the ${maxWarmup}-bar warm-up — there is not enough history to validate on`
      ],
      verdict: "insufficient history"
    };
  }
  const folds = [];
  const oosTrades = [];
  let isExpectancySum = 0;
  let oosExpectancySum = 0;
  let scored = 0;
  for (let f = 0; f < foldCount; f++) {
    const from = f * windowSize;
    const to = f === foldCount - 1 ? bars.length : (f + 1) * windowSize;
    const splitAt = from + Math.floor((to - from) * trainRatio);
    const train = bars.slice(from, splitAt);
    const test = bars.slice(splitAt, to);
    if (train.length < maxWarmup + 10 || test.length < maxWarmup + 10) continue;
    let best = null;
    for (const candidate of candidates) {
      const run = runBacktest(candidate, train, opts);
      if (run.refused) continue;
      const m = computeMetrics(run.trades, run.equity);
      const s = score(m);
      if (!best || s > best.score) best = { strategy: candidate, metrics: m, score: s };
    }
    if (!best || !Number.isFinite(best.score)) {
      folds.push({
        index: f,
        trainFrom: from,
        trainTo: splitAt,
        testFrom: splitAt,
        testTo: to,
        chosen: null,
        inSample: computeMetrics([], []),
        outOfSample: computeMetrics([], []),
        trades: []
      });
      continue;
    }
    const oos = runBacktest(best.strategy, test, opts);
    const oosMetrics = computeMetrics(oos.trades, oos.equity);
    oosTrades.push(...oos.trades);
    isExpectancySum += best.metrics.expectancyR;
    oosExpectancySum += oosMetrics.expectancyR;
    scored++;
    folds.push({
      index: f,
      trainFrom: from,
      trainTo: splitAt,
      testFrom: splitAt,
      testTo: to,
      chosen: best.strategy.id,
      inSample: best.metrics,
      outOfSample: oosMetrics,
      trades: oos.trades
    });
  }
  const aggregate = computeMetrics(oosTrades, syntheticEquity(oosTrades, opts.riskPerTrade ?? 0.01));
  const isAvg = scored > 0 ? isExpectancySum / scored : 0;
  const oosAvg = scored > 0 ? oosExpectancySum / scored : 0;
  const degradation = isAvg !== 0 ? oosAvg / isAvg : 0;
  if (oosTrades.length < 30) {
    warnings.push(
      `${oosTrades.length} out-of-sample trades across all folds — too few to conclude anything`
    );
  }
  let verdict;
  if (scored === 0) verdict = "no fold produced a usable selection";
  else if (oosAvg <= 0)
    verdict = `out-of-sample expectancy is ${oosAvg.toFixed(3)}R against ${isAvg.toFixed(3)}R in-sample — the edge did not survive selection and is very likely curve-fitting`;
  else if (degradation < 0.4)
    verdict = `out-of-sample kept only ${(degradation * 100).toFixed(0)}% of in-sample expectancy — most of the apparent edge was fitted to the training slice`;
  else
    verdict = `out-of-sample kept ${(degradation * 100).toFixed(0)}% of in-sample expectancy (${oosAvg.toFixed(3)}R vs ${isAvg.toFixed(3)}R) across ${scored} folds`;
  return { folds, aggregate, degradation, warnings, verdict };
}
function syntheticEquity(trades, risk) {
  const out = new Float64Array(trades.length + 1);
  let capital = 1;
  out[0] = 1;
  trades.forEach((t, i) => {
    Math.abs(t.entryPrice - t.exitPrice) > 0 ? Math.abs(t.rMultiple) : 0;
    capital *= 1 + t.rMultiple * risk;
    out[i + 1] = capital;
  });
  return out;
}
function combinations(n, k) {
  const out = [];
  const pick = [];
  const walk = (start) => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}
function pbo(matrix, blocks = 8) {
  var _a;
  const configs = matrix.length;
  if (configs < 2) {
    return {
      pbo: 0,
      logits: [],
      splits: 0,
      oosPositiveRate: 0,
      interpretation: "PBO needs at least two configurations to compare"
    };
  }
  const T = ((_a = matrix[0]) == null ? void 0 : _a.length) ?? 0;
  const S = blocks % 2 === 0 ? blocks : blocks - 1;
  if (T < S * 2 || S < 2) {
    return {
      pbo: 0,
      logits: [],
      splits: 0,
      oosPositiveRate: 0,
      interpretation: `not enough observations (${T}) to form ${S} blocks`
    };
  }
  const size = Math.floor(T / S);
  const blockRanges = [];
  for (let i = 0; i < S; i++) {
    blockRanges.push([i * size, i === S - 1 ? T : (i + 1) * size]);
  }
  const perf = (config, chosen) => {
    const row = matrix[config];
    let sum = 0;
    for (const b of chosen) {
      const [from, to] = blockRanges[b];
      for (let t = from; t < to; t++) sum += row[t] ?? 0;
    }
    return sum;
  };
  const logits = [];
  let oosPositive = 0;
  const all = [...Array(S).keys()];
  for (const train of combinations(S, S / 2)) {
    const trainSet = new Set(train);
    const test = all.filter((b) => !trainSet.has(b));
    let bestConfig = 0;
    let bestPerf = -Infinity;
    for (let c = 0; c < configs; c++) {
      const p = perf(c, train);
      if (p > bestPerf) {
        bestPerf = p;
        bestConfig = c;
      }
    }
    const oos = Array.from({ length: configs }, (_, c) => perf(c, test));
    const chosenPerf = oos[bestConfig];
    if (chosenPerf > 0) oosPositive++;
    let worseCount = 0;
    for (let c = 0; c < configs; c++) if (oos[c] < chosenPerf) worseCount++;
    const omega = (worseCount + 0.5) / configs;
    logits.push(Math.log(omega / (1 - omega)));
  }
  const failures = logits.filter((l) => l <= 0).length;
  const value = logits.length > 0 ? failures / logits.length : 0;
  let interpretation;
  if (value >= 0.5) {
    interpretation = `PBO ${(value * 100).toFixed(0)}% — the best in-sample configuration lands below the out-of-sample median at least half the time. Selection here has no predictive value; the winner was the luckiest, not the best.`;
  } else if (value >= 0.25) {
    interpretation = `PBO ${(value * 100).toFixed(0)}% — selection carries real overfitting risk. Roughly one in ${Math.round(1 / value)} choices of "best" would have disappointed out-of-sample.`;
  } else {
    interpretation = `PBO ${(value * 100).toFixed(0)}% — the in-sample winner usually held up out-of-sample. This is evidence the selection process has some skill, not that the strategy will profit.`;
  }
  return {
    pbo: value,
    logits,
    splits: logits.length,
    oosPositiveRate: logits.length > 0 ? oosPositive / logits.length : 0,
    interpretation
  };
}
function equityToReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    out.push(prev > 0 && Number.isFinite(cur) ? cur / prev - 1 : 0);
  }
  return out;
}
function subjectLabel(subject) {
  var _a;
  if (subject.kind === "family") {
    return ((_a = FAMILIES.find((f) => f.id === subject.id)) == null ? void 0 : _a.label) ?? subject.id;
  }
  return subject.spec.name;
}
const FAMILIES = [
  {
    id: "ema",
    label: "EMA trend",
    blurb: "The plainest trend system, included as the baseline everything else has to beat"
  },
  {
    id: "rsi",
    label: "RSI reversion",
    blurb: "Counter-trend entries filtered by the 200 EMA"
  },
  {
    id: "confluence",
    label: "Confluence engine",
    blurb: "The terminal's own glass-box score, tested like any other rule"
  }
];
function familyGrid(family) {
  switch (family) {
    case "ema": {
      const out = [];
      for (const [fast, slow] of [
        [10, 30],
        [20, 50],
        [20, 100],
        [50, 200]
      ]) {
        for (const rr of [1.5, 2, 3]) out.push(emaTrend(fast, slow, 2, rr));
      }
      return out;
    }
    case "rsi": {
      const out = [];
      for (const low of [20, 25, 30, 35]) {
        for (const rr of [1.5, 2, 3]) out.push(rsiReversion(14, low, 100 - low, 2, rr));
      }
      return out;
    }
    case "confluence": {
      const out = [];
      for (const minScore of [0.25, 0.35, 0.45]) {
        for (const rr of [1.5, 2, 3]) out.push(confluenceStrategy(minScore, 0.4, 2, rr));
      }
      return out;
    }
  }
}
const SPEC_GRID_CAP = 12;
const SPEC_RATIOS = [0.75, 1, 1.5];
const SPEC_THRESHOLD_STEP = 5;
const BOUNDED_COLUMNS = {
  rsi: [0, 100],
  stochk: [0, 100],
  stochd: [0, 100],
  mfi: [0, 100],
  adx: [0, 100],
  willr: [-100, 0]
};
const AXIS_BANDS = {
  "stop.atr": [0.1, 10],
  "stop.pct": [0.05, 50],
  "target.rr": [0.1, 20],
  "target.pct": [0.05, 100]
};
const round2 = (v) => Math.round(v * 100) / 100;
function bandedValues(values, band) {
  const out = [];
  for (const v of values) {
    if (!Number.isFinite(v) || v < band[0] || v > band[1]) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
const GROUPS = ["long", "short", "exitLong", "exitShort"];
const groupOf = (spec, key) => key === "long" ? spec.long : key === "short" ? spec.short : key === "exitLong" ? spec.exitLong : spec.exitShort;
function thresholdAxis(spec) {
  const seen = /* @__PURE__ */ new Map();
  const order = [];
  for (const key of GROUPS) {
    for (const cond of groupOf(spec, key) ?? []) {
      const [left, , right] = cond;
      if (!(left in BOUNDED_COLUMNS)) continue;
      const parsed = parseOperand(right);
      if (parsed === null || parsed.kind !== "number") continue;
      let values = seen.get(left);
      if (!values) {
        values = /* @__PURE__ */ new Set();
        seen.set(left, values);
        order.push(left);
      }
      values.add(parsed.value);
    }
  }
  for (const column of order) {
    const values = seen.get(column);
    if (values && values.size === 1) {
      return { column, value: [...values][0] };
    }
  }
  return null;
}
function ambiguousThresholds(spec) {
  const seen = /* @__PURE__ */ new Map();
  for (const key of GROUPS) {
    for (const cond of groupOf(spec, key) ?? []) {
      const [left, , right] = cond;
      if (!(left in BOUNDED_COLUMNS)) continue;
      const parsed = parseOperand(right);
      if (parsed === null || parsed.kind !== "number") continue;
      const values = seen.get(left) ?? /* @__PURE__ */ new Set();
      values.add(parsed.value);
      seen.set(left, values);
    }
  }
  const out = [];
  for (const [column, values] of seen) {
    if (values.size > 1) {
      out.push(
        `${COLUMNS[column]} appears with ${values.size} different thresholds (${[...values].join(", ")}), so none of them was varied — moving one without the others makes a different rule, and the lab does not guess how they are related.`
      );
    }
  }
  return out;
}
const replaceThreshold = (group2, column, from, to) => {
  return group2.map((cond) => {
    const [left, op, right] = cond;
    if (left !== column) return cond;
    const parsed = parseOperand(right);
    return parsed !== null && parsed.kind === "number" && parsed.value === from ? [left, op, String(to)] : cond;
  });
};
function specGrid(spec) {
  const axes = [];
  const held = [...ambiguousThresholds(spec)];
  const stopBase = spec.stop.type === "atr" ? spec.stop.mult : spec.stop.value;
  const stopBand = AXIS_BANDS[spec.stop.type === "atr" ? "stop.atr" : "stop.pct"];
  const stopValues = stopBase >= stopBand[0] && stopBase <= stopBand[1] ? bandedValues(SPEC_RATIOS.map((r2) => round2(stopBase * r2)), stopBand) : [];
  if (stopValues.length > 1) {
    axes.push({
      what: spec.stop.type === "atr" ? "stop (× ATR)" : "stop (%)",
      values: stopValues
    });
  } else {
    held.push(
      `The stop (${stopBase}${spec.stop.type === "atr" ? " × ATR" : "%"}) was not varied: it is outside the ${stopBand[0]}-${stopBand[1]} band this lab will invent neighbours inside, so the only honest thing to test is the number as written.`
    );
  }
  let targetValues = [];
  if (spec.target.type === "none") {
    held.push("There is no target to vary: this rule exits on its exit conditions and its stop only.");
  } else {
    const band = AXIS_BANDS[spec.target.type === "rr" ? "target.rr" : "target.pct"];
    const base = spec.target.value;
    targetValues = base >= band[0] && base <= band[1] ? bandedValues(SPEC_RATIOS.map((r2) => round2(base * r2)), band) : [];
    if (targetValues.length > 1) {
      axes.push({
        what: spec.target.type === "rr" ? "target (× risk)" : "target (%)",
        values: targetValues
      });
    } else {
      targetValues = [];
      held.push(
        `The target (${base}${spec.target.type === "rr" ? "× risk" : "%"}) was not varied: it is outside the ${band[0]}-${band[1]} band this lab will invent neighbours inside.`
      );
    }
  }
  const threshold = thresholdAxis(spec);
  let thresholdValues = [];
  if (threshold) {
    const band = BOUNDED_COLUMNS[threshold.column];
    const candidates = [
      threshold.value - SPEC_THRESHOLD_STEP,
      threshold.value,
      threshold.value + SPEC_THRESHOLD_STEP
    ];
    const inside = candidates.filter((v) => v > band[0] && v < band[1]);
    const product = Math.max(1, stopValues.length) * Math.max(1, targetValues.length) * inside.length;
    if (inside.length < candidates.length) {
      held.push(
        `${COLUMNS[threshold.column]} at ${threshold.value} was not varied: ±${SPEC_THRESHOLD_STEP} points leaves the ${band[0]}-${band[1]} range the column can take, and a threshold outside its own range is a condition that can never fire rather than a variant.`
      );
    } else if (product > SPEC_GRID_CAP) {
      held.push(
        `${COLUMNS[threshold.column]} at ${threshold.value} was held fixed: varying it as well would need ${product} configurations and the cap is ${SPEC_GRID_CAP}, which is the size of the largest family grid. The stop and the target come first because they are the two parameters every rule has.`
      );
    } else {
      thresholdValues = inside;
      axes.push({ what: `${COLUMNS[threshold.column]} threshold`, values: inside });
    }
  }
  const variants = [{}];
  const expand = (values, key) => {
    if (values.length === 0) return;
    const next = [];
    for (const base of variants) for (const v of values) next.push({ ...base, [key]: v });
    variants.length = 0;
    variants.push(...next);
  };
  expand(stopValues, "stop");
  expand(targetValues, "target");
  expand(thresholdValues, "threshold");
  const strategies = variants.map((variant) => {
    let varied = spec;
    const tags = [];
    if (variant.stop !== void 0) {
      varied = {
        ...varied,
        stop: varied.stop.type === "atr" ? { type: "atr", mult: variant.stop } : { type: "pct", value: variant.stop }
      };
      tags.push(`stop ${variant.stop}`);
    }
    if (variant.target !== void 0 && varied.target.type !== "none") {
      varied = { ...varied, target: { type: varied.target.type, value: variant.target } };
      tags.push(`target ${variant.target}`);
    }
    if (variant.threshold !== void 0 && threshold) {
      varied = {
        ...varied,
        long: replaceThreshold(varied.long, threshold.column, threshold.value, variant.threshold),
        ...varied.short ? { short: replaceThreshold(varied.short, threshold.column, threshold.value, variant.threshold) } : {},
        ...varied.exitLong ? { exitLong: replaceThreshold(varied.exitLong, threshold.column, threshold.value, variant.threshold) } : {},
        ...varied.exitShort ? { exitShort: replaceThreshold(varied.exitShort, threshold.column, threshold.value, variant.threshold) } : {}
      };
      tags.push(`${threshold.column} ${variant.threshold}`);
    }
    const suffix = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
    const compiled = compileSpec(
      tags.length === 0 ? spec : { ...varied, id: `${spec.id}@${tags.join("/")}`, name: `${spec.name}${suffix}` }
    );
    return variant.threshold === void 0 ? compiled : { ...compiled, params: { ...compiled.params, threshold: variant.threshold } };
  });
  return { strategies, axes, held };
}
const MIN_OOS_TRADES = 30;
const emptyStudy = (subject, bars, why) => ({
  subject,
  bars,
  configs: [],
  best: null,
  bestRun: null,
  walk: { folds: [], aggregate: computeMetrics([], []), degradation: 0, warnings: [], verdict: why },
  overfit: { pbo: 0, logits: [], splits: 0, oosPositiveRate: 0, interpretation: why },
  headline: { standing: "refused", verdict: "Cannot be tested", why },
  grossMetrics: null,
  promotion: promote(
    { folds: [], aggregate: computeMetrics([], []), degradation: 0 }
  ),
  regimes: [],
  warnings: [why],
  rules: null
});
function runStudy(family, bars, opts = {}) {
  return sweep({ kind: "family", id: family }, familyGrid(family), [], bars, opts);
}
function runSpecStudy(spec, bars, opts = {}) {
  const subject = { kind: "spec", id: spec.id, spec };
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    return emptyStudy(
      subject,
      bars.length,
      `This rule cannot be tested as written: ${problems.map((p) => `${p.where} — ${p.message}`).join(" ")}`
    );
  }
  const grid = specGrid(spec);
  const warnings = [...grid.held];
  if (grid.strategies.length === 1) {
    warnings.push(
      "Only one configuration was testable, so this is a single backtest and not a search: nothing was selected, so there is no selection bias to measure and the overfitting probability below is not evidence of robustness."
    );
  }
  return sweep(subject, grid.strategies, warnings, bars, opts);
}
function runSubjectStudy(subject, bars, opts = {}) {
  return subject.kind === "family" ? runStudy(subject.id, bars, opts) : runSpecStudy(subject.spec, bars, opts);
}
function sweep(subject, grid, gridWarnings, bars, opts) {
  const maxWarmup = Math.max(...grid.map((g) => g.warmup));
  if (bars.length < maxWarmup * 4) {
    const what = subject.kind === "family" ? "this family" : "this rule";
    return emptyStudy(
      subject,
      bars.length,
      `${bars.length} bars is not enough for ${what} — it needs at least ${maxWarmup * 4} (four times the ${maxWarmup}-bar warm-up) before a sweep means anything.`
    );
  }
  const warnings = [...gridWarnings];
  const configs = [];
  const matrix = [];
  const runs = /* @__PURE__ */ new Map();
  for (const strategy of grid) {
    const run = runBacktest(strategy, bars, opts);
    runs.set(strategy.id, run);
    const m = run.refused ? computeMetrics([], []) : computeMetrics(run.trades, run.equity);
    configs.push({
      id: strategy.id,
      label: strategy.label,
      params: strategy.params,
      metrics: m,
      score: run.refused ? -Infinity : defaultScore(m),
      refused: run.refused
    });
    for (const w of run.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (!run.refused && run.equity.length > 1) matrix.push(equityToReturns(run.equity));
  }
  configs.sort((a, b) => b.score - a.score);
  const best = configs[0] ?? null;
  const bestRun = best ? runs.get(best.id) ?? null : null;
  const bestStrategy = best ? grid.find((g) => g.id === best.id) ?? null : null;
  const walk = walkForward(grid, bars, { ...opts, folds: opts.folds ?? 5 });
  const overfit = pbo(matrix, opts.blocks ?? 8);
  let grossMetrics = null;
  if (bestStrategy) {
    const gross = runBacktest(bestStrategy, bars, { ...opts, costs: ZERO_COSTS });
    if (!gross.refused) grossMetrics = computeMetrics(gross.trades, gross.equity);
  }
  return {
    subject,
    bars: bars.length,
    configs,
    best,
    bestRun,
    walk,
    overfit,
    headline: judge(configs, walk, overfit, best, grossMetrics),
    grossMetrics,
    promotion: promote(walk, overfit),
    /* The WINNER's trades, split by entry regime. Not the walk-forward pool:
       those trades come from different configurations fold by fold, so
       splitting them by regime would mix several strategies together and
       report the result as one. */
    regimes: bestRun && bestRun.trades.length > 0 ? byRegime(bestRun.trades, bars) : [],
    warnings: [...warnings, ...walk.warnings],
    rules: (bestStrategy == null ? void 0 : bestStrategy.rules) ?? null
  };
}
function judge(configs, walk, overfit, best, gross) {
  if (!best || best.refused) {
    return {
      standing: "refused",
      verdict: "Cannot be tested",
      why: (best == null ? void 0 : best.refused) ?? "no configuration produced a usable run"
    };
  }
  const oos = walk.aggregate.trades;
  if (overfit.splits >= 4 && overfit.pbo >= 0.5) {
    return {
      standing: "no-edge",
      verdict: "No demonstrated edge",
      why: `PBO is ${(overfit.pbo * 100).toFixed(0)}%: across ${overfit.splits} train/test splits, the configuration that won in-sample landed below the out-of-sample median more often than not. Selection among these ${configs.length} variants has no measurable skill, so the winner is the luckiest rather than the best. The equity curve below is real arithmetic on real bars and still tells you nothing about the future.`
    };
  }
  if (oos < MIN_OOS_TRADES) {
    return {
      standing: "unproven",
      verdict: "Unproven — sample too small",
      why: `Walk-forward produced ${oos} out-of-sample trade${oos === 1 ? "" : "s"}. Below ${MIN_OOS_TRADES} nothing can be concluded, however good the numbers look: a handful of trades will happily show a large edge or none at all purely by chance. Test on more history or a faster timeframe before reading anything into this.`
    };
  }
  if (overfit.pbo >= 0.3) {
    return {
      standing: "fragile",
      verdict: "Fragile",
      why: `PBO is ${(overfit.pbo * 100).toFixed(0)}% — the in-sample winner fails out-of-sample in roughly one split in ${Math.max(2, Math.round(1 / Math.max(overfit.pbo, 0.01)))}. There may be something here, but the parameter choice is doing a lot of the work.`
    };
  }
  if (walk.degradation < 0.3) {
    return {
      standing: "fragile",
      verdict: "Fragile — did not carry out of sample",
      why: `Out-of-sample expectancy is ${(walk.degradation * 100).toFixed(0)}% of in-sample across ${walk.folds.length} folds and ${oos} trades. Most of what the backtest showed was fitted to the training slice.`
    };
  }
  const costNote = gross && gross.expectancyR > 0 && walk.aggregate.expectancyR <= 0 ? " Note that it is profitable only with costs switched off — the frictions are the whole result." : "";
  return {
    standing: "survived",
    verdict: "Survived out-of-sample",
    why: `${oos} out-of-sample trades across ${walk.folds.length} folds retained ${(walk.degradation * 100).toFixed(0)}% of in-sample expectancy, with PBO ${(overfit.pbo * 100).toFixed(0)}% over ${overfit.splits} splits. That is evidence, not proof — it is one symbol over one period, and the future is not obliged to resemble it.` + costNote
  };
}
const ATR2 = { type: "atr", mult: 2 };
const RR2 = { type: "rr", value: 2 };
const RR15 = { type: "rr", value: 1.5 };
const SPECS = [
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
    note: "The fastest of the trend rules and the one that trades most. Expect a low win rate and a heavy dependence on costs."
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
    note: "Trades pullbacks to the 50 only in the direction the 200 already allows. Needs 200 bars of warm-up before its first decision."
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
    note: "Requires all three averages stacked before it will act. Far fewer entries than the 9/21 cross, which is the entire point of it."
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
    note: "Always in the market in one direction or the other, so the exit rule and the stop fire against each other constantly. Read the trade count before the return."
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
    note: "Acts only when ADX says a trend exists. ADX is a lagging measure of trend STRENGTH and says nothing about direction — the EMAs supply that."
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
    target: RR2
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
    note: "Rate of change crossing zero is momentum turning. The EMA 50 filter is what stops it fading every trend it meets."
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
    note: "Trend and momentum must agree. Conditions are STATES rather than crossings, so it re-enters continuously while they hold."
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
    note: "Buys as RSI climbs back OUT of oversold rather than while it is falling into it. Wins often and loses big; a high win rate here proves nothing on its own."
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
    target: RR15
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
    target: RR2
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
    note: "Williams %R runs from -100 to 0, so -80 is OVERSOLD and -20 is overbought — the reverse of every other oscillator here."
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
    note: "MFI is RSI weighted by volume. On a feed with absent or flat volume it degenerates towards plain RSI — check the Data desk before reading anything into the difference."
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
    note: "This one rule is what EIGHT separately-named market-making strategies in the old build actually ran. Genuine market making needs an order book and a funding curve; this is the mean-reversion core such systems sit on, and nothing more."
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
    note: "Stood in for the liquidity-sweep, FVG-retest and PDH/PDL strategies in the old build. It is a band-and-oscillator rule, not a structural one — the real structural detectors live on the Chart desk."
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
    note: "The same bands as the fade, traded the other way round. The old build also used this as a proxy for the London-open and opening-range strategies, which it is not — it has no concept of a session."
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
    note: "Session VWAP, reset daily. On a 1-day timeframe every bar is its own session, so this rule is meaningless above 4h — check the timeframe before trusting a result."
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
    note: "A level taken on the wick and given back on the close. The one pattern here that carries its own invalidation — the extreme of the raid — rather than borrowing one from ATR. Fires on the bar the close came back, never on the wick."
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
    note: "The same raid, taken only in the direction the 50/200 already allows. Trades far less. If this beats the unfiltered version it is evidence the trend filter is doing work; if it does not, that is worth knowing before you add one by habit."
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
    note: "Enters on a confirmed structure break and exits on a change of character against it — the same invalidation the Setup card names for an open position, tested rather than asserted."
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
    note: "Price trading back into an unmitigated imbalance. The zone stops being a zone the moment a close goes through its far side, so a rule that keeps firing after that is testing a level nobody is defending."
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
    note: "The last opposing candle before a displacement, retested. Filtered by the 200 because an order block against the prevailing trend is the one that most often fails."
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
    note: "The bar that closes out of a named sideways stretch. Most of a chart is range, and this is the only rule in the set that waits for one to end rather than assuming a trend was already running."
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
    note: "Bollinger has come back out of Keltner and price has left the channel. The squeeze itself says only that expansion is due and NOTHING about direction — the direction here comes from which side price actually left through, not from the squeeze."
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
    note: "The classic turtle entry, with the current bar excluded from the channel so a breakout is possible at all, and the Chandelier exit doing the trailing. The ADX filter is what stops it buying every poke of a flat range."
  }
];
new Map(SPECS.map((s) => [s.id, s]));
const FEATURE_WARMUP = 220;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
function hasVolume(bars) {
  let positive = 0;
  for (const b of bars) if (b.v > 0) positive += 1;
  return positive > bars.length * 0.8;
}
function buildFeatures(bars) {
  const n = bars.length;
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const open = new Float64Array(n);
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    high[i] = b.h;
    low[i] = b.l;
    close[i] = b.c;
    open[i] = b.o;
    vol[i] = b.v;
  }
  const a14 = atr(high, low, close, 14, n);
  const aBase = sma(a14, 100, n);
  const e50 = ema(close, 50, n);
  const e200 = ema(close, 200, n);
  const r14 = rsi(close, 14, n);
  const adx14 = adx(high, low, close, 14, n).adx;
  const m = macd(close, 12, 26, 9, n);
  const bb = bollinger(close, 20, 2, n);
  const r12 = roc(close, 12, n);
  const useVolume = hasVolume(bars);
  const volAvg = useVolume ? sma(vol, 20, n) : null;
  const omitted = [];
  if (!useVolume) {
    omitted.push("volRatio — this series reports no usable volume, so participation is unknown");
  }
  const names = [
    "rsi14",
    "adx14",
    "atrPct",
    "atrRatio",
    "distEma50",
    "distEma200",
    "slopeEma50",
    "macdhAtr",
    "bbPos",
    "roc12",
    "barRange",
    "bodyShare",
    "hourUtc",
    "dayOfWeek",
    ...useVolume ? ["volRatio"] : []
  ];
  const featuresAt = (i) => {
    const b = bars[i];
    if (b === void 0 || i < FEATURE_WARMUP) return null;
    const c = close[i];
    const a = a14[i];
    if (!finite(c) || !(c > 0) || !finite(a) || !(a > 0)) return null;
    const ab = aBase[i];
    const e50i = e50[i];
    const e50prev = e50[i - 20];
    const e200i = e200[i];
    const bu = bb.upper[i];
    const bl = bb.lower[i];
    const band = bu - bl;
    const range = b.h - b.l;
    const row = {
      rsi14: r14[i],
      adx14: adx14[i],
      atrPct: a / c * 100,
      atrRatio: finite(ab) && ab > 0 ? a / ab : Number.NaN,
      distEma50: (c - e50i) / a,
      distEma200: (c - e200i) / a,
      slopeEma50: (e50i - e50prev) / a,
      macdhAtr: m.histogram[i] / a,
      bbPos: band > 0 ? (c - bl) / band : Number.NaN,
      roc12: r12[i],
      barRange: range / a,
      /* A doji has zero range and an undefined body share. NaN drops the row
         rather than calling it a full body, which is what 0/0 -> 1 would. */
      bodyShare: range > 0 ? Math.abs(b.c - b.o) / range : Number.NaN,
      hourUtc: new Date(b.t).getUTCHours(),
      dayOfWeek: new Date(b.t).getUTCDay()
    };
    if (volAvg !== null) {
      const va = volAvg[i];
      row["volRatio"] = finite(va) && va > 0 ? b.v / va : Number.NaN;
    }
    for (const k of names) if (!finite(row[k])) return null;
    return row;
  };
  return { names, featuresAt, omitted };
}
function collectSignals(strategy, bars) {
  const matrix = buildFeatures(bars);
  const signals = [];
  let unfeatured = 0;
  let asked = 0;
  if (bars.length === 0) return { signals, matrix, unfeatured, asked };
  const ctx = makeContext(bars);
  const start = Math.max(strategy.warmup, FEATURE_WARMUP);
  for (let i = start; i < bars.length; i += 1) {
    asked += 1;
    const sig = strategy.entry(ctx, i);
    if (sig === null) continue;
    if (sig.target === void 0 || !Number.isFinite(sig.target)) continue;
    const features = matrix.featuresAt(i);
    if (features === null) {
      unfeatured += 1;
      continue;
    }
    signals.push({
      index: i,
      direction: sig.direction,
      stop: sig.stop,
      target: sig.target,
      reason: sig.reason,
      features
    });
  }
  return { signals, matrix, unfeatured, asked };
}
function buildLedger(bars, signals, opts) {
  var _a, _b, _c, _d;
  const costs = opts.costs ?? DEFAULT_COSTS;
  const horizon = Math.max(1, Math.floor(opts.horizon));
  const candidates = [];
  const reasons = /* @__PURE__ */ new Set();
  let skipped = 0;
  let measured = 0;
  for (const s of signals) {
    const signalBar = bars[s.index];
    if (signalBar === void 0) {
      skipped += 1;
      reasons.add("a signal pointed at a bar outside the series");
      continue;
    }
    const entryBar = bars[s.index + 1];
    if (entryBar === void 0) {
      skipped += 1;
      reasons.add("a signal had no bar after it to enter on");
      continue;
    }
    const entryPrice = modelledFill(entryBar.o, s.direction, costs, true);
    if (!fillable(entryPrice, s.stop, s.direction)) {
      skipped += 1;
      reasons.add(`a signal's stop was on the wrong side of its entry for a ${s.direction}`);
      continue;
    }
    const risk = Math.abs(entryPrice - s.stop);
    if (!(risk > 0)) {
      skipped += 1;
      reasons.add("a signal's stop was its entry, so risk was zero");
      continue;
    }
    let outcome = "timeout";
    let basis = "measured";
    let barsHeld = horizon;
    let exitPrice = ((_a = bars[Math.min(bars.length - 1, s.index + horizon)]) == null ? void 0 : _a.c) ?? entryPrice;
    for (let k = 0; k < horizon; k += 1) {
      const j = s.index + 1 + k;
      const b = bars[j];
      if (b === void 0) break;
      const hitStop = s.direction === "long" ? b.l <= s.stop : b.h >= s.stop;
      const hitTarget = s.direction === "long" ? b.h >= s.target : b.l <= s.target;
      if (!hitStop && !hitTarget) continue;
      if (hitStop && hitTarget) {
        const span = { from: b.t, to: b.t + (((_b = opts.minutes) == null ? void 0 : _b.barMs) ?? 0) };
        const settled = settleBar(((_c = opts.minutes) == null ? void 0 : _c.bars) ?? [], span, {
          stop: s.stop,
          target: s.target,
          direction: s.direction
        });
        outcome = settled.hit === "target" ? "target" : "stop";
        basis = settled.basis;
      } else {
        outcome = hitStop ? "stop" : "target";
        basis = "measured";
      }
      barsHeld = k + 1;
      exitPrice = outcome === "target" ? s.target : s.stop;
      break;
    }
    if (outcome === "timeout") {
      const lastIndex = Math.min(bars.length - 1, s.index + horizon);
      exitPrice = ((_d = bars[lastIndex]) == null ? void 0 : _d.c) ?? entryPrice;
      barsHeld = lastIndex - s.index;
      basis = "measured";
    }
    const exitFilled = modelledFill(exitPrice, s.direction, costs, false);
    const gross = s.direction === "long" ? exitFilled - entryPrice : entryPrice - exitFilled;
    const fees = (entryPrice + exitFilled) * costs.commission;
    const rMultiple = (gross - fees) / risk;
    if (basis === "measured") measured += 1;
    candidates.push({
      index: s.index,
      time: signalBar.t,
      direction: s.direction,
      entryPrice,
      stop: s.stop,
      target: s.target,
      features: s.features,
      outcome,
      basis,
      barsHeld,
      rMultiple,
      reason: s.reason
    });
  }
  return {
    candidates,
    skipped,
    measuredShare: candidates.length === 0 ? 0 : measured / candidates.length,
    why: [...reasons].join("; ")
  };
}
function baseRate(led) {
  let wins = 0;
  let decided = 0;
  for (const c of led.candidates) {
    if (c.outcome === "timeout") continue;
    decided += 1;
    if (c.outcome === "target") wins += 1;
  }
  return { rate: decided === 0 ? 0 : wins / decided, decided };
}
const DEFAULT_RUIN_FRACTION = 0.1;
const DEFAULT_MAX_POINTS = 400;
function curvePoints(points, max) {
  if (max < 3 || points.length <= max) return [...points];
  const buckets = Math.max(1, Math.floor(max / 3));
  const size = points.length / buckets;
  const out = [];
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    if (to <= from) continue;
    let hi = points[from];
    let lo = hi;
    for (let i = from; i < to; i += 1) {
      const p = points[i];
      if (p.equity > hi.equity) hi = p;
      if (p.equity < lo.equity) lo = p;
    }
    const first = points[from];
    const picked = [first, hi, lo].filter((p, i, a) => a.indexOf(p) === i).sort((x, y) => x.t - y.t);
    out.push(...picked);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1].t !== last.t) out.push(last);
  return out;
}
function simulateAccount(trades, opts) {
  const start = opts.balance;
  const ruinFloor = start * (opts.ruinFraction ?? DEFAULT_RUIN_FRACTION);
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
  if (!(start > 0) || !(opts.riskPct > 0)) {
    return {
      start,
      end: start,
      peak: start,
      trough: start,
      maxDrawdown: 0,
      taken: 0,
      unreachable: trades.length,
      ruinedAt: null,
      curve: [],
      why: "a balance and a risk per trade above zero are needed before anything can be simulated"
    };
  }
  const risk = opts.riskPct / 100;
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let equity = start;
  let peak = start;
  let trough = start;
  let maxDrawdown2 = 0;
  let taken = 0;
  let ruinedAt = null;
  const points = ordered.length > 0 ? [{ t: ordered[0].entryTime, equity: start }] : [];
  for (const t of ordered) {
    equity += equity * risk * t.rMultiple;
    taken += 1;
    points.push({ t: t.exitTime, equity });
    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown2) maxDrawdown2 = dd;
    if (equity <= ruinFloor) {
      ruinedAt = t.exitTime;
      break;
    }
  }
  const unreachable = ordered.length - taken;
  const why = ruinedAt === null ? "" : `the account fell below ${Math.round((opts.ruinFraction ?? DEFAULT_RUIN_FRACTION) * 100)}% of its starting balance and the run stops there. ${unreachable.toLocaleString()} later trades are not counted: a broker closes the account out, and anything after that point is a recovery that could not have happened.`;
  return {
    start,
    end: equity,
    peak,
    trough,
    maxDrawdown: maxDrawdown2,
    taken,
    unreachable,
    ruinedAt,
    curve: curvePoints(points, maxPoints),
    why
  };
}
const MIN_COVERAGE = 0.8;
function closeTimeOf(t, intervalMs) {
  return t + intervalMs;
}
function alignMacro(tradedTimes, macro, macroIntervalMs) {
  const n = tradedTimes.length;
  const level = new Float64Array(n).fill(NaN);
  if (n === 0) {
    return { level, known: 0, coverage: 0, thin: "there are no bars to align onto" };
  }
  if (macro.length === 0) {
    return { level, known: 0, coverage: 0, thin: "no bars were held for the context series" };
  }
  let j = -1;
  let known = 0;
  for (let i = 0; i < n; i += 1) {
    const now = tradedTimes[i];
    while (j + 1 < macro.length && closeTimeOf(macro[j + 1].t, macroIntervalMs) <= now) {
      j += 1;
    }
    if (j >= 0) {
      const c = macro[j].c;
      if (Number.isFinite(c)) {
        level[i] = c;
        known += 1;
      }
    }
  }
  const coverage = known / n;
  const thin = coverage < MIN_COVERAGE ? `the context series covers only ${Math.round(coverage * 100)}% of these bars, so a rule conditioned on it would be tested on that much` : null;
  return { level, known, coverage, thin };
}
function macroChange(macro, lookback) {
  const back = Math.max(1, Math.floor(lookback));
  const out = [];
  for (let i = 0; i < macro.length; i += 1) {
    const here = macro[i];
    const prev = macro[i - back];
    if (prev === void 0 || !Number.isFinite(prev.c) || prev.c === 0 || !Number.isFinite(here.c)) {
      out.push({ t: here.t, c: NaN });
      continue;
    }
    out.push({ t: here.t, c: (here.c - prev.c) / prev.c });
  }
  return out;
}
function ratioOf(a, b) {
  const n = Math.min(a.level.length, b.level.length);
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    const x = a.level[i];
    const y = b.level[i];
    if (Number.isFinite(x) && Number.isFinite(y) && y !== 0) out[i] = x / y;
  }
  return out;
}
const CHANGE_LOOKBACK = 5;
const CONTEXT_INTERVAL_MS = 864e5;
function buildMacroColumns(tradedTimes, series) {
  const columns = {};
  const missing = [];
  const n = tradedTimes.length;
  const blank = () => new Float64Array(n).fill(NaN);
  const levels = {};
  const put = (col, symbol, change) => {
    const bars = series[symbol];
    if (!bars || bars.length === 0) {
      columns[col] = blank();
      missing.push(`${symbol} is not in the archive, so ${col} cannot be read`);
      return;
    }
    const source = change ? macroChange(bars, CHANGE_LOOKBACK) : bars;
    const a = alignMacro(tradedTimes, source, CONTEXT_INTERVAL_MS);
    if (!change) levels[symbol] = a;
    columns[col] = a.level;
    if (a.thin) missing.push(`${col}: ${a.thin}`);
  };
  put("dxy", "DXY", false);
  put("dxy_chg5", "DXY", true);
  put("us10y", "US10Y", false);
  put("us10y_chg5", "US10Y", true);
  put("us02y", "US02Y", false);
  put("vix", "VIX", false);
  put("vix_chg5", "VIX", true);
  put("spx", "SPX", false);
  put("spx_chg5", "SPX", true);
  put("usdjpy", "USDJPY", false);
  const alignSide = (symbol) => {
    const bars = series[symbol];
    if (!bars || bars.length === 0) return null;
    return levels[symbol] ?? alignMacro(tradedTimes, bars, CONTEXT_INTERVAL_MS);
  };
  const copper = alignSide("COPPER");
  const gold = alignSide("XAUUSD");
  if (copper && gold) {
    columns["copper_gold"] = ratioOf(copper, gold);
  } else {
    columns["copper_gold"] = blank();
    missing.push("copper_gold needs both COPPER and XAUUSD in the archive");
  }
  return { columns, missing };
}
function parseContext(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out = {};
  for (const [symbol, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) {
      throw new Error(`context.${symbol} must be an array of {t, c} bars`);
    }
    const bars = [];
    for (let i = 0; i < v.length; i += 1) {
      const b = v[i];
      const t = b == null ? void 0 : b["t"];
      const c = b == null ? void 0 : b["c"];
      if (typeof t !== "number" || !Number.isFinite(t) || typeof c !== "number" || !Number.isFinite(c)) {
        throw new Error(`context.${symbol}[${i}] needs a finite t and c`);
      }
      bars.push({ t, c });
    }
    bars.sort((a, b) => a.t - b.t);
    out[symbol] = bars;
  }
  return Object.keys(out).length > 0 ? out : null;
}
const STYLES = {
  scalp: true,
  intraday: true,
  swing: true,
  reversion: true,
  custom: true
};
const str = (o, k, where) => {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}.${k} must be a non-empty string`);
  return v;
};
const group = (o, k, where) => {
  const v = o[k];
  if (!Array.isArray(v)) throw new Error(`${where}.${k} must be an array of conditions`);
  return v;
};
function parseStop(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("spec.stop must be an object");
  const o = raw;
  const value = o["type"] === "atr" ? o["mult"] : o["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`spec.stop.${o["type"] === "atr" ? "mult" : "value"} must be a finite number`);
  }
  if (o["type"] === "atr") return { type: "atr", mult: value };
  if (o["type"] === "pct") return { type: "pct", value };
  throw new Error(`spec.stop.type must be "atr" or "pct", not ${JSON.stringify(o["type"])}`);
}
function parseTarget(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("spec.target must be an object");
  const o = raw;
  if (o["type"] === "none") return { type: "none" };
  const value = o["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("spec.target.value must be a finite number");
  }
  if (o["type"] === "rr") return { type: "rr", value };
  if (o["type"] === "pct") return { type: "pct", value };
  throw new Error(`spec.target.type must be "rr", "pct" or "none", not ${JSON.stringify(o["type"])}`);
}
function parseSpec(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("spec must be an object");
  const o = raw;
  const style = str(o, "style", "spec");
  if (!Object.prototype.hasOwnProperty.call(STYLES, style)) {
    throw new Error(`spec.style ${JSON.stringify(style)} is not one of ${Object.keys(STYLES).join(", ")}`);
  }
  const note = o["note"];
  if (note !== void 0 && typeof note !== "string") throw new Error("spec.note must be a string");
  const spec = {
    id: str(o, "id", "spec"),
    name: str(o, "name", "spec"),
    style,
    long: group(o, "long", "spec"),
    ...o["short"] !== void 0 ? { short: group(o, "short", "spec") } : {},
    ...o["exitLong"] !== void 0 ? { exitLong: group(o, "exitLong", "spec") } : {},
    ...o["exitShort"] !== void 0 ? { exitShort: group(o, "exitShort", "spec") } : {},
    stop: parseStop(o["stop"]),
    target: parseTarget(o["target"]),
    ...typeof note === "string" ? { note } : {}
  };
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    throw new Error(`spec is not testable: ${problems.map((p) => `${p.where} — ${p.message}`).join("; ")}`);
  }
  return spec;
}
function parseJob(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("job must be an object");
  const job = raw;
  const hasFamily = job["family"] !== void 0 && job["family"] !== null;
  const hasSpec = job["spec"] !== void 0 && job["spec"] !== null;
  if (hasFamily && hasSpec) {
    throw new Error("job names both `family` and `spec` — a study has one subject, so which one is a guess");
  }
  if (!hasFamily && !hasSpec) {
    throw new Error("job names neither `family` nor `spec` — nothing to study");
  }
  let subject;
  if (hasFamily) {
    const family = job["family"];
    if (typeof family !== "string" || !FAMILIES.some((f) => f.id === family)) {
      throw new Error(`unknown family ${JSON.stringify(family)} — expected one of ${FAMILIES.map((f) => f.id).join(", ")}`);
    }
    subject = { kind: "family", id: family };
  } else {
    const spec = parseSpec(job["spec"]);
    subject = { kind: "spec", id: spec.id, spec };
  }
  const rawBars = job["bars"];
  if (!Array.isArray(rawBars)) throw new Error("job.bars must be an array");
  const bars = rawBars.map((b, i) => {
    const bar = b;
    const num = (k) => {
      const v = bar[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`bars[${i}].${k} is not a finite number`);
      }
      return v;
    };
    return { t: num("t"), o: num("o"), h: num("h"), l: num("l"), c: num("c"), v: num("v") };
  });
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t <= bars[i - 1].t) {
      throw new Error(`bars[${i}].t is not after bars[${i - 1}].t — bars must be ascending and unique`);
    }
  }
  const rawOpts = typeof job["opts"] === "object" && job["opts"] !== null ? job["opts"] : {};
  const parsed = parseContext(job["context"]);
  const opts = parsed === null ? rawOpts : { ...rawOpts, macro: buildMacroColumns(bars.map((b) => b.t), parsed).columns };
  return { subject, bars, opts, ...parsed === null ? {} : { context: parsed } };
}
function readCosts(raw) {
  if (typeof raw !== "object" || raw === null) return DEFAULT_COSTS;
  const o = raw;
  const term = (k) => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const spread = term("spread");
  const commission = term("commission");
  const slippage = term("slippage");
  const carryRaw = o["carryPerNight"];
  const carry = carryRaw === void 0 ? DEFAULT_COSTS.carryPerNight : typeof carryRaw === "number" && Number.isFinite(carryRaw) && carryRaw >= 0 ? carryRaw : null;
  if (spread === null || commission === null || slippage === null || carry === null) {
    return DEFAULT_COSTS;
  }
  return { spread, commission, slippage, carryPerNight: carry };
}
function specCatalogue() {
  return SPECS.map((sp) => ({ ...sp }));
}
function runLedgerJob(raw) {
  const started = Date.now();
  const job = typeof raw === "object" && raw !== null ? { ...raw } : {};
  const wantedId = job["specId"];
  if (typeof wantedId === "string" && job["spec"] === void 0) {
    const found = SPECS.find((sp) => sp.id === wantedId);
    if (found === void 0) {
      throw new Error(
        `no shipped rule called ${JSON.stringify(wantedId)} — the library has ${SPECS.length}, and a ledger cannot be built for one that does not exist`
      );
    }
    job["spec"] = found;
  }
  const { subject, bars, opts } = parseJob(job);
  if (subject.kind !== "spec") {
    throw new Error("a ledger job needs a `spec` — a family is a grid search, and a ledger is one rule");
  }
  const o = opts;
  const num = (k, fallback) => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const horizon = Math.floor(num("horizon", 100));
  const balance = num("balance", 500);
  const riskPct = num("riskPct", 1);
  const costs = readCosts(o["costs"]);
  const strategy = compileSpec(subject.spec);
  const got = collectSignals(strategy, bars);
  const led = buildLedger(bars, got.signals, { horizon, costs });
  const base = baseRate(led);
  const bt = runBacktest(strategy, bars, { costs, riskPerTrade: riskPct / 100 });
  const metrics = computeMetrics(bt.trades, bt.equity);
  const account = simulateAccount(bt.trades, { balance, riskPct });
  return {
    subject,
    costs,
    /* Only what the router reads. A candidate also carries prices, stops and
       an R multiple, and shipping 1,800 of those per rule over a pipe for a
       model that never looks at them is bytes nobody asked for. */
    rows: led.candidates.map((c) => ({
      t: c.time,
      outcome: c.outcome,
      features: c.features
    })),
    sample: {
      found: led.candidates.length,
      resolved: base.decided,
      baseRate: base.rate,
      measuredShare: led.measuredShare,
      unfeatured: got.unfeatured,
      asked: got.asked,
      skipped: led.skipped,
      why: led.why,
      omitted: [...got.matrix.omitted]
    },
    metrics,
    account,
    bars: bars.length,
    from: bars.length > 0 ? bars[0].t : 0,
    to: bars.length > 0 ? bars[bars.length - 1].t : 0,
    ms: Date.now() - started
  };
}
function runJob(raw) {
  const { subject, bars, opts, context } = parseJob(raw);
  const started = Date.now();
  const study = runSubjectStudy(subject, bars, opts);
  const conditioned = context ? Object.keys(context).sort() : [];
  return {
    subject,
    configs: study.configs.length,
    study,
    ms: Date.now() - started,
    context: conditioned
  };
}
export {
  FAMILIES,
  SPECS,
  familyGrid,
  parseContext,
  parseJob,
  parseSpec,
  readCosts,
  runJob,
  runLedgerJob,
  runSpecStudy,
  runStudy,
  runSubjectStudy,
  specCatalogue,
  specGrid,
  subjectLabel
};
