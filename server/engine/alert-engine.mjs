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
function nthLargest(values, k) {
  if (k <= 0 || values.length < k) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[k - 1];
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
const SWING_TARGET_PER_BARS = 8;
const SWING_NOISE_FLOOR = 1;
function swingFloor(high, low, close, len = close.length, opts = {}) {
  const noise = noiseShare(high, low, close, len) * SWING_NOISE_FLOOR;
  const target = Math.max(4, Math.round(len / (opts.targetPerBars ?? SWING_TARGET_PER_BARS)));
  const raw = findPivots(
    high,
    low,
    { left: opts.left ?? 3, right: opts.right ?? 3, minProminence: noise },
    len
  );
  const rank = nthLargest(
    raw.map((p) => p.prominence),
    target
  );
  return Math.max(noise, rank);
}
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function px(v) {
  const abs = Math.abs(v);
  const dp = abs >= 1e3 ? 2 : abs >= 1 ? 4 : 6;
  return v.toFixed(dp);
}
const NaNArray = (n) => new Float64Array(n).fill(NaN);
function sma(src, period, len = src.length) {
  const out = NaNArray(len);
  if (period <= 0 || len < period) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
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
function bollinger(close, period = 20, mult = 2, len = close.length) {
  const middle = sma(close, period, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = period - 1; i < len; i++) {
    const mean2 = middle[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = close[j] - mean2;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / period);
    upper[i] = mean2 + mult * sd;
    lower[i] = mean2 - mult * sd;
  }
  return { middle, upper, lower };
}
function keltner(high, low, close, period = 20, mult = 2, atrPeriod = 10, len = close.length) {
  const middle = ema(close, period, len);
  const a = atr(high, low, close, atrPeriod, len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = 0; i < len; i++) {
    const m = middle[i];
    const r = a[i];
    if (!Number.isFinite(m) || !Number.isFinite(r)) continue;
    upper[i] = m + mult * r;
    lower[i] = m - mult * r;
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
function anchoredVwap(high, low, close, volume, anchorIndex, len = close.length) {
  const out = NaNArray(len);
  const start = Math.max(0, Math.min(anchorIndex, len - 1));
  let pv = 0;
  let vol = 0;
  for (let i = start; i < len; i++) {
    const typical = (high[i] + low[i] + close[i]) / 3;
    const v = volume[i];
    const vv = Number.isFinite(v) ? v : 0;
    pv += typical * vv;
    vol += vv;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
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
  const unit2 = atr(data.h, data.l, data.c, 14, len);
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
          atr: unit2[i]
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
          atr: unit2[i]
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
  const confidence = clamp01(
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
function detectLevels(data, opts = {}, len = data.c.length) {
  const tolerance = opts.tolerance ?? 35e-4;
  const minTouches = opts.minTouches ?? 2;
  const maxLevels = opts.maxLevels ?? 6;
  const pivots = findPivots(
    data.h,
    data.l,
    { left: opts.left ?? 3, right: opts.right ?? 3, minProminence: opts.minProminence ?? 2e-3 },
    len
  );
  if (pivots.length === 0) return [];
  const byPrice = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [];
  for (const p of byPrice) {
    if (current.length === 0) {
      current = [p];
      continue;
    }
    const anchor = current[0];
    if (Math.abs(p.price - anchor.price) / anchor.price <= tolerance) current.push(p);
    else {
      clusters.push(current);
      current = [p];
    }
  }
  if (current.length) clusters.push(current);
  const scored = clusters.filter((c) => c.length >= minTouches).map((c) => {
    const price = c.reduce((sum, p) => sum + p.price, 0) / c.length;
    const lastTouch = Math.max(...c.map((p) => p.index));
    const firstTouch = Math.min(...c.map((p) => p.index));
    const highs = c.filter((p) => p.kind === "high").length;
    const lows = c.length - highs;
    const recency = len > 0 ? lastTouch / len : 0;
    const confidence = clamp01(
      0.25 + 0.4 * saturate(c.length - minTouches, 3) + 0.25 * recency
    );
    return { price, lastTouch, firstTouch, touches: c.length, highs, lows, confidence };
  }).sort((a, b) => b.confidence - a.confidence).slice(0, maxLevels);
  return scored.map((s) => {
    const both = s.highs > 0 && s.lows > 0;
    const role = both ? "flipped support/resistance" : s.highs > 0 ? "resistance" : "support";
    return {
      id: `level-${s.price.toFixed(6)}`,
      kind: "level",
      label: role,
      direction: "neutral",
      from: s.firstTouch,
      to: s.lastTouch,
      confidence: s.confidence,
      reason: `${s.touches} swings within ${(tolerance * 100).toFixed(2)}% of ${px(s.price)} (${s.highs} high${s.highs === 1 ? "" : "s"}, ${s.lows} low${s.lows === 1 ? "" : "s"})` + (both ? " — price has traded through and re-tested it from the other side" : ""),
      shapes: [
        {
          type: "level",
          x0: s.firstTouch,
          y: s.price,
          tone: "accent",
          dashed: true,
          /**
           * The CHART tag is short; the sentence lives on the detection.
           *
           * `label` above is "flipped support/resistance", which is the right
           * thing for the Smart money desk to read out. Painting that same
           * 27-character phrase onto the chart once per level stacked six
           * identical prefixes down the left edge, over the candles, and the
           * only part that differed — the price — was pushed to the end of each
           * line where the eye reaches it last.
           *
           * A tag on a chart is a HANDLE, not a description: enough to tell one
           * line from another. The price leads because that is what differs.
           */
          label: `${px(s.price)}  ${both ? "flip" : s.highs > 0 ? "res" : "sup"}`
        }
      ]
    };
  });
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
    const unit2 = a[i];
    const gapAtr = unit2 > 0 ? (top - bottom) / unit2 : 0;
    const confidence = clamp01(0.3 + 0.45 * saturate(gapAtr, 0.75));
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
    const confidence = clamp01(0.3 + 0.45 * saturate(moveAtr, 2));
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
const LEVEL_MATCH_NOISE = 1;
const SHOULDER_MATCH_NOISE = 2.5;
const NECKLINE_DEPTH_NOISE = 3;
const TOUCH_NOISE = 0.75;
function unit(data, len, fallback) {
  const noise = noiseShare(data.h, data.l, data.c, len);
  return noise > 0 ? noise : fallback;
}
const pivotFloor = (data, opts, len) => opts.minProminence ?? swingFloor(data.h, data.l, data.c, len, {
  left: opts.left ?? 4,
  right: opts.right ?? 4
});
function pivotsOf(data, opts, len) {
  return alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 4,
        right: opts.right ?? 4,
        minProminence: pivotFloor(data, opts, len)
      },
      len
    )
  );
}
function detectDoubles(data, opts = {}, len = data.c.length) {
  const noise = unit(data, len, 1e-3);
  const tolerance = opts.tolerance ?? noise * LEVEL_MATCH_NOISE;
  const minDepth = noise * NECKLINE_DEPTH_NOISE;
  const pivots = pivotsOf(data, opts, len);
  const out = [];
  for (let i = 0; i + 2 < pivots.length; i++) {
    const a = pivots[i];
    const mid = pivots[i + 1];
    const b = pivots[i + 2];
    if (a.kind !== b.kind || mid.kind === a.kind) continue;
    const diff = Math.abs(a.price - b.price) / ((a.price + b.price) / 2);
    if (diff > tolerance) continue;
    const top = a.kind === "high";
    const neckline = mid.price;
    const depth = Math.abs(((a.price + b.price) / 2 - neckline) / neckline);
    if (depth < minDepth) continue;
    let confirmAt = -1;
    for (let j = b.confirmedAt; j < len; j++) {
      const c = data.c[j];
      if (top ? c < neckline : c > neckline) {
        confirmAt = j;
        break;
      }
    }
    if (confirmAt < 0) continue;
    const confidence = clamp01(
      0.35 + (1 - diff / tolerance) * 0.3 + Math.min(depth / (minDepth * 6), 1) * 0.25
    );
    const shapes = [
      {
        type: "line",
        x0: a.index,
        y0: a.price,
        x1: b.index,
        y1: b.price,
        tone: top ? "bear" : "bull",
        label: top ? "Double top" : "Double bottom"
      },
      {
        type: "line",
        x0: a.index,
        y0: neckline,
        x1: confirmAt,
        y1: neckline,
        tone: "neutral",
        dashed: true,
        label: "neckline"
      },
      {
        type: "marker",
        x: confirmAt,
        y: data.c[confirmAt],
        tone: top ? "bear" : "bull",
        text: top ? "2T" : "2B",
        above: !top
      }
    ];
    out.push({
      id: `${top ? "double-top" : "double-bottom"}-${a.index}-${b.index}`,
      kind: top ? "double-top" : "double-bottom",
      label: top ? "Double top" : "Double bottom",
      direction: top ? "short" : "long",
      from: a.index,
      to: confirmAt,
      confidence,
      reason: `two ${top ? "highs" : "lows"} at ${px(a.price)} and ${px(b.price)} (${(diff * 100).toFixed(2)}% apart), neckline ${px(neckline)} ${(depth * 100).toFixed(1)}% away; confirmed by the close through it at bar ${confirmAt}`,
      shapes
    });
  }
  return out;
}
function detectHeadShoulders(data, opts = {}, len = data.c.length) {
  const noise = unit(data, len, 14e-4);
  const tolerance = opts.tolerance ?? noise * SHOULDER_MATCH_NOISE;
  const pivots = pivotsOf(data, opts, len);
  const out = [];
  for (let i = 0; i + 4 < pivots.length; i++) {
    const ls = pivots[i];
    const t1 = pivots[i + 1];
    const head = pivots[i + 2];
    const t2 = pivots[i + 3];
    const rs = pivots[i + 4];
    if (ls.kind !== head.kind || head.kind !== rs.kind) continue;
    if (t1.kind === head.kind || t2.kind === head.kind) continue;
    const topPattern = head.kind === "high";
    const headDominates = topPattern ? head.price > ls.price && head.price > rs.price : head.price < ls.price && head.price < rs.price;
    if (!headDominates) continue;
    const shoulderDiff = Math.abs(ls.price - rs.price) / ((ls.price + rs.price) / 2);
    if (shoulderDiff > tolerance) continue;
    const slope = (t2.price - t1.price) / (t2.index - t1.index || 1);
    const necklineAt = (x) => t1.price + slope * (x - t1.index);
    let confirmAt = -1;
    for (let j = rs.confirmedAt; j < len; j++) {
      const c = data.c[j];
      const nl = necklineAt(j);
      if (topPattern ? c < nl : c > nl) {
        confirmAt = j;
        break;
      }
    }
    if (confirmAt < 0) continue;
    const headSize = Math.abs(head.price - (t1.price + t2.price) / 2) / ((t1.price + t2.price) / 2 || 1);
    const confidence = clamp01(
      0.35 + (1 - shoulderDiff / tolerance) * 0.3 + Math.min(headSize / (noise * 8), 1) * 0.25
    );
    out.push({
      id: `hs-${ls.index}-${rs.index}`,
      kind: "head-shoulders",
      label: topPattern ? "Head and shoulders" : "Inverse head and shoulders",
      direction: topPattern ? "short" : "long",
      from: ls.index,
      to: confirmAt,
      confidence,
      reason: `shoulders ${px(ls.price)} / ${px(rs.price)} (${(shoulderDiff * 100).toFixed(2)}% apart) around a ${topPattern ? "higher" : "lower"} head ${px(head.price)}; neckline broken on the close at bar ${confirmAt}`,
      shapes: [
        {
          type: "line",
          x0: ls.index,
          y0: ls.price,
          x1: head.index,
          y1: head.price,
          tone: topPattern ? "bear" : "bull"
        },
        {
          type: "line",
          x0: head.index,
          y0: head.price,
          x1: rs.index,
          y1: rs.price,
          tone: topPattern ? "bear" : "bull",
          label: topPattern ? "H&S" : "Inv H&S"
        },
        {
          type: "line",
          x0: t1.index,
          y0: t1.price,
          x1: confirmAt,
          y1: necklineAt(confirmAt),
          tone: "neutral",
          dashed: true,
          label: "neckline"
        },
        {
          type: "marker",
          x: confirmAt,
          y: data.c[confirmAt],
          tone: topPattern ? "bear" : "bull",
          text: "H&S",
          above: !topPattern
        }
      ]
    });
  }
  return out;
}
function detectTrendlines(data, opts = {}, len = data.c.length) {
  const minTouches = opts.minTouches ?? 3;
  const maxLines = opts.maxLines ?? 4;
  const maxPivots = opts.maxPivots ?? 40;
  const tolerance = opts.tolerance ?? unit(data, len, 6e-3) * TOUCH_NOISE;
  const pivots = findPivots(
    data.h,
    data.l,
    {
      left: opts.left ?? 4,
      right: opts.right ?? 4,
      minProminence: pivotFloor(data, opts, len)
    },
    len
  );
  const out = [];
  for (const kind of ["high", "low"]) {
    const allOfKind = pivots.filter((p) => p.kind === kind);
    const set = allOfKind.slice(-maxPivots);
    if (set.length < minTouches) continue;
    let best = null;
    let bestCount = minTouches - 1;
    for (let i = 0; i < set.length - 1; i++) {
      const a = set[i];
      if (set.length - i <= bestCount) break;
      for (let j = i + 1; j < set.length; j++) {
        const b = set[j];
        const span = b.index - a.index;
        if (span < 5) continue;
        const slope2 = (b.price - a.price) / span;
        let count = 0;
        for (let k = 0; k < set.length; k++) {
          const p = set[k];
          const expected = a.price + slope2 * (p.index - a.index);
          if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) count++;
        }
        if (count > bestCount) {
          bestCount = count;
          const touches = [];
          for (let k = 0; k < set.length; k++) {
            const p = set[k];
            const expected = a.price + slope2 * (p.index - a.index);
            if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) touches.push(p);
          }
          best = { a, b, touches };
        }
      }
    }
    if (!best) continue;
    const first = best.touches[0];
    const last = best.touches[best.touches.length - 1];
    const slope = (last.price - first.price) / (last.index - first.index || 1);
    const rising = slope > 0;
    const confidence = clamp01(0.3 + 0.45 * saturate(best.touches.length - minTouches, 2));
    out.push({
      id: `trendline-${kind}-${first.index}-${last.index}`,
      kind: "trendline",
      label: kind === "low" ? rising ? "Rising support" : "Falling support" : rising ? "Rising resistance" : "Falling resistance",
      direction: rising ? "long" : "short",
      from: first.index,
      to: last.index,
      confidence,
      reason: `${best.touches.length} swing ${kind === "high" ? "highs" : "lows"} within ${(tolerance * 100).toFixed(2)}% of one line from ${px(first.price)} (bar ${first.index}) to ${px(last.price)} (bar ${last.index})`,
      shapes: [
        {
          type: "line",
          x0: first.index,
          y0: first.price,
          x1: last.index,
          y1: last.price,
          tone: kind === "low" ? "bull" : "bear",
          extend: true,
          label: `${best.touches.length} touches`
        }
      ]
    });
  }
  return out.slice(0, maxLines);
}
function detectDivergence(data, opts = {}, len = data.c.length) {
  const period = opts.period ?? 14;
  const maxAge = opts.maxAgeBars ?? 60;
  const values = rsi(data.c, period, len);
  const pivots = alternate(
    findPivots(
      data.h,
      data.l,
      {
        left: opts.left ?? 4,
        right: opts.right ?? 4,
        minProminence: pivotFloor(data, opts, len)
      },
      len
    )
  );
  const out = [];
  for (const kind of ["high", "low"]) {
    const set = pivots.filter((p) => p.kind === kind);
    for (let i = 1; i < set.length; i++) {
      const prev = set[i - 1];
      const cur = set[i];
      if (cur.index - prev.index > maxAge) continue;
      const rPrev = values[prev.index];
      const rCur = values[cur.index];
      if (rPrev === void 0 || rCur === void 0) continue;
      if (Number.isNaN(rPrev) || Number.isNaN(rCur)) continue;
      const bearish = kind === "high" && cur.price > prev.price && rCur < rPrev;
      const bullish = kind === "low" && cur.price < prev.price && rCur > rPrev;
      if (!bearish && !bullish) continue;
      const gap = Math.abs(rCur - rPrev);
      if (gap < 3) continue;
      const confidence = clamp01(0.3 + 0.45 * saturate(gap, 12));
      out.push({
        id: `div-${kind}-${prev.index}-${cur.index}`,
        kind: "divergence",
        label: bearish ? "Bearish divergence" : "Bullish divergence",
        direction: bearish ? "short" : "long",
        from: prev.index,
        to: cur.confirmedAt,
        confidence,
        reason: `price made a ${bearish ? "higher high" : "lower low"} (${px(prev.price)} → ${px(cur.price)}) while RSI(${period}) made a ${bearish ? "lower high" : "higher low"} (${rPrev.toFixed(1)} → ${rCur.toFixed(1)}) — momentum did not confirm the move`,
        shapes: [
          {
            type: "line",
            x0: prev.index,
            y0: prev.price,
            x1: cur.index,
            y1: cur.price,
            tone: bearish ? "bear" : "bull",
            dashed: true,
            label: bearish ? "Bear div" : "Bull div"
          }
        ]
      });
    }
  }
  return out;
}
const DEFAULTS$8 = {
  swing: 3,
  equalTolerance: 8e-4,
  lookback: 400,
  maxResults: 6,
  minPenetration: 2e-4
};
function findPools(data, opts = {}, len = data.c.length) {
  const swing = opts.swing ?? DEFAULTS$8.swing;
  const tol = opts.equalTolerance ?? DEFAULTS$8.equalTolerance;
  const lookback = opts.lookback ?? DEFAULTS$8.lookback;
  const pivots = findPivots(data.h, data.l, { left: swing, right: swing }, len);
  const from = Math.max(0, len - lookback);
  const pools = [];
  for (const kind of ["high", "low"]) {
    const of = pivots.filter((p) => p.kind === kind && p.index >= from);
    const used = /* @__PURE__ */ new Set();
    for (let i = 0; i < of.length; i++) {
      if (used.has(i)) continue;
      const seed = of[i];
      const group = [seed];
      for (let j = i + 1; j < of.length; j++) {
        if (used.has(j)) continue;
        const other = of[j];
        if (Math.abs(other.price - seed.price) / seed.price <= tol) {
          group.push(other);
          used.add(j);
        }
      }
      if (group.length < 2) continue;
      used.add(i);
      const price = kind === "high" ? Math.max(...group.map((p) => p.price)) : Math.min(...group.map((p) => p.price));
      const last = Math.max(...group.map((p) => p.confirmedAt));
      let cleared = false;
      for (let b = last + 1; b < len; b++) {
        const c = data.c[b];
        if (kind === "high" ? c > price * (1 + tol) : c < price * (1 - tol)) {
          cleared = true;
          break;
        }
      }
      if (cleared) continue;
      pools.push({
        kind,
        price,
        at: group.map((p) => p.index).sort((a, b) => a - b),
        confirmedAt: last
      });
    }
  }
  return pools.sort((a, b) => a.confirmedAt - b.confirmedAt);
}
function detectPools(data, opts = {}, len = data.c.length) {
  const tol = opts.equalTolerance ?? DEFAULTS$8.equalTolerance;
  const maxResults = opts.maxResults ?? DEFAULTS$8.maxResults;
  const pools = findPools(data, opts, len);
  const out = pools.map((pool) => {
    const first = pool.at[0];
    const lastTouch = pool.at[pool.at.length - 1];
    const spread = pool.at.length < 2 ? 0 : Math.abs(
      (pool.kind === "high" ? Math.min(...pool.at.map((i) => data.h[i])) : Math.max(...pool.at.map((i) => data.l[i]))) - pool.price
    ) / pool.price;
    const tightness = clamp01(1 - spread / Math.max(tol, 1e-9));
    const touches = saturate(pool.at.length - 2, 2);
    const confidence = clamp01(0.4 + 0.25 * tightness + 0.3 * touches);
    const shapes = [
      {
        type: "level",
        x0: first,
        y: pool.price,
        tone: "accent",
        dashed: true,
        label: pool.kind === "high" ? "EQH" : "EQL"
      }
    ];
    return {
      id: `pool-${pool.kind}-${first}-${lastTouch}`,
      kind: pool.kind === "high" ? "equal-highs" : "equal-lows",
      label: pool.kind === "high" ? "Equal highs" : "Equal lows",
      /* Neutral, and deliberately. A pool of stops above the market is not a
         short signal — it is a magnet, and price reaching it is the ordinary
         outcome. Which way it resolves is what `detectSweeps` answers. */
      direction: "neutral",
      from: first,
      to: lastTouch,
      confidence,
      reason: `${pool.at.length} touches within ${(spread * 100).toFixed(3)}% at ${px(pool.price)} — resting orders sit ${pool.kind === "high" ? "above" : "below"}`,
      shapes
    };
  });
  return out.slice(-maxResults);
}
function detectSweeps(data, opts = {}, len = data.c.length) {
  const minPen = opts.minPenetration ?? DEFAULTS$8.minPenetration;
  const maxResults = opts.maxResults ?? DEFAULTS$8.maxResults;
  const reclaimWithin = opts.reclaimWithin ?? 3;
  const tol = opts.equalTolerance ?? DEFAULTS$8.equalTolerance;
  const swing = opts.swing ?? DEFAULTS$8.swing;
  const lookback = opts.lookback ?? DEFAULTS$8.lookback;
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
      const speed = clamp01(1 - (reclaimAt - i) / (reclaimWithin + 1));
      const confidence = clamp01(0.35 + 0.3 * depth + 0.3 * speed);
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
const DEFAULTS$7 = { minBars: 10, maxHeightAtr: 3, lookback: 400, maxResults: 4 };
function detectRanges(data, opts = {}, len = data.c.length) {
  const minBars = opts.minBars ?? DEFAULTS$7.minBars;
  const maxHeightAtr = opts.maxHeightAtr ?? DEFAULTS$7.maxHeightAtr;
  const lookback = opts.lookback ?? DEFAULTS$7.lookback;
  const maxResults = opts.maxResults ?? DEFAULTS$7.maxResults;
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
  const out = found.map((r) => {
    let breakAt = -1;
    let breakUp = false;
    for (let i = r.end + 1; i < len; i++) {
      const c = data.c[i];
      if (c > r.hi) {
        breakAt = i;
        breakUp = true;
        break;
      }
      if (c < r.lo) {
        breakAt = i;
        breakUp = false;
        break;
      }
    }
    const bars = r.end - r.start + 1;
    const length = clamp01((bars - minBars) / (minBars * 3));
    const tightness = clamp01(1 - r.heightAtr / maxHeightAtr);
    const confidence = clamp01(0.4 + 0.3 * length + 0.3 * tightness);
    const shapes = [
      {
        type: "box",
        x0: r.start - 0.5,
        x1: (breakAt < 0 ? len - 1 : breakAt) + 0.5,
        y0: r.lo,
        y1: r.hi,
        tone: "neutral",
        dashed: true,
        label: `${bars} bars`
      }
    ];
    if (breakAt >= 0) {
      shapes.push({
        type: "marker",
        x: breakAt,
        y: breakUp ? r.hi : r.lo,
        tone: breakUp ? "bull" : "bear",
        text: "EXP",
        above: breakUp
      });
    }
    return {
      id: `range-${r.start}-${r.end}`,
      kind: breakAt >= 0 ? "expansion" : "range",
      label: breakAt >= 0 ? "Range expansion" : "Range",
      /* An unbroken range has no direction, and saying otherwise would be the
         single most common way this detector could mislead. */
      direction: breakAt < 0 ? "neutral" : breakUp ? "long" : "short",
      from: r.start,
      to: breakAt < 0 ? r.end : breakAt,
      confidence,
      reason: breakAt < 0 ? `${bars} bars between ${px(r.lo)} and ${px(r.hi)} — ${r.heightAtr.toFixed(1)} ATR tall, still inside` : `${bars}-bar range between ${px(r.lo)} and ${px(r.hi)}, closed ${breakUp ? "above" : "below"} it`,
      shapes
    };
  });
  return out.slice(0, maxResults);
}
function detectBreakers(data, opts = {}, len = data.c.length) {
  const maxResults = opts.maxResults ?? 4;
  const tol = opts.retestTolerance ?? 2e-3;
  const blocks = detectOrderBlocks(data, { hideMitigated: false, maxZones: 24 }, len);
  const out = [];
  for (const block of blocks) {
    const box = block.shapes.find((s) => s.type === "box");
    if (box === void 0 || box.type !== "box") continue;
    const lo = Math.min(box.y0, box.y1);
    const hi = Math.max(box.y0, box.y1);
    const bullish = block.direction === "long";
    let brokeAt = -1;
    for (let i = block.to + 1; i < len; i++) {
      const c = data.c[i];
      if (bullish ? c < lo : c > hi) {
        brokeAt = i;
        break;
      }
    }
    if (brokeAt < 0) continue;
    let retestAt = -1;
    for (let i = brokeAt + 1; i < len; i++) {
      const h = data.h[i];
      const l = data.l[i];
      const band2 = hi * tol;
      if (l <= hi + band2 && h >= lo - band2) {
        retestAt = i;
        break;
      }
    }
    const flipped = bullish ? "short" : "long";
    const confidence = clamp01(block.confidence * (retestAt >= 0 ? 0.95 : 0.7));
    const shapes = [
      {
        type: "box",
        x0: block.from - 0.5,
        x1: len - 1,
        y0: lo,
        y1: hi,
        tone: flipped === "long" ? "bull" : "bear",
        extend: true,
        label: retestAt >= 0 ? "breaker · retested" : "breaker"
      },
      {
        type: "marker",
        x: brokeAt,
        y: bullish ? lo : hi,
        tone: flipped === "long" ? "bull" : "bear",
        text: "FLIP",
        above: !bullish
      }
    ];
    out.push({
      id: `breaker-${block.from}-${brokeAt}`,
      kind: "breaker",
      label: "Breaker block",
      direction: flipped,
      from: block.from,
      to: retestAt >= 0 ? retestAt : brokeAt,
      confidence,
      reason: `${bullish ? "demand" : "supply"} block at ${px(lo)}–${px(hi)} failed on the close through it${retestAt >= 0 ? ", and price has come back to it from the other side" : " — not yet retested"}`,
      shapes
    });
  }
  return out.slice(-maxResults);
}
const SESSIONS = [
  { id: "sydney", name: "Sydney", city: "Sydney", openUtc: 21, closeUtc: 6 },
  { id: "tokyo", name: "Tokyo", city: "Tokyo", openUtc: 0, closeUtc: 9 },
  { id: "london", name: "London", city: "London", openUtc: 7, closeUtc: 16 },
  { id: "newyork", name: "New York", city: "New York", openUtc: 12, closeUtc: 21 }
];
function sessionOpenAt(s, hourUtc) {
  const h = (hourUtc % 24 + 24) % 24;
  return s.openUtc <= s.closeUtc ? h >= s.openUtc && h < s.closeUtc : h >= s.openUtc || h < s.closeUtc;
}
const DEFAULT_SESSIONS = ["tokyo", "london", "newyork"];
const MAX_BAR_MS$1 = 6 * 36e5;
function detectSessionRanges(data, opts = {}, len = data.c.length) {
  const wanted = opts.sessions ?? DEFAULT_SESSIONS;
  const days = opts.days ?? 3;
  const maxResults = opts.maxResults ?? 9;
  if (len < 4) return [];
  const gaps = [];
  for (let i = 1; i < len; i++) gaps.push(data.t[i] - data.t[i - 1]);
  gaps.sort((a, b) => a - b);
  const barMs2 = gaps[Math.floor(gaps.length / 2)] ?? 0;
  if (!Number.isFinite(barMs2) || barMs2 <= 0 || barMs2 > MAX_BAR_MS$1) return [];
  const byId = new Map(SESSIONS.map((s) => [s.id, s]));
  const found = [];
  for (const id of wanted) {
    const win = byId.get(id);
    if (win === void 0) continue;
    for (const block of blocksFor(data, win, len, days)) found.push({ win, block });
  }
  if (found.length === 0) return [];
  const heights = found.map((f) => f.block.hi - f.block.lo).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const out = found.map((f) => toDetection(data, f.win, f.block, len, typicalHeight));
  return out.sort((a, b) => a.from - b.from).slice(-maxResults);
}
function blocksFor(data, win, len, days) {
  const blocks = [];
  let start = -1;
  let hi = -Infinity;
  let lo = Infinity;
  const close = (end) => {
    if (start >= 0 && end >= start) blocks.push({ start, end, hi, lo });
    start = -1;
    hi = -Infinity;
    lo = Infinity;
  };
  for (let i = 0; i < len; i++) {
    const t = data.t[i];
    const inside = sessionOpenAt(win, new Date(t).getUTCHours());
    if (inside) {
      if (start < 0) start = i;
      hi = Math.max(hi, data.h[i]);
      lo = Math.min(lo, data.l[i]);
    } else {
      close(i - 1);
    }
  }
  close(len - 1);
  return blocks.filter((b) => b.end > b.start).slice(-days);
}
function toDetection(data, win, block, len, typicalHeight) {
  let brokeUp = false;
  let brokeDown = false;
  for (let i = block.end + 1; i < len; i++) {
    const c = data.c[i];
    if (c > block.hi) brokeUp = true;
    if (c < block.lo) brokeDown = true;
    if (brokeUp && brokeDown) break;
  }
  const bars = block.end - block.start + 1;
  const shapes = [
    {
      type: "box",
      x0: block.start - 0.5,
      x1: block.end + 0.5,
      y0: block.lo,
      y1: block.hi,
      tone: "accent",
      dashed: true,
      label: win.name
    },
    { type: "level", x0: block.end, y: block.hi, tone: "neutral", dashed: true },
    { type: "level", x0: block.end, y: block.lo, tone: "neutral", dashed: true }
  ];
  const height = block.hi - block.lo;
  const relative = typicalHeight > 0 ? height / typicalHeight : 1;
  const tightness = clamp01(1 - (relative - 1) / 2);
  const confidence = clamp01(0.3 + 0.3 * saturate(bars, 6) + 0.3 * tightness);
  const both = brokeUp && brokeDown;
  return {
    id: `session-${win.id}-${block.start}`,
    kind: "session-range",
    label: `${win.name} range`,
    /* Neutral unless exactly ONE side has gone. Both sides taken means price
       has traded through the range in each direction, which says nothing at
       all — and calling that a direction would be the easiest way for this
       detector to mislead. */
    direction: both ? "neutral" : brokeUp ? "long" : brokeDown ? "short" : "neutral",
    from: block.start,
    to: block.end,
    confidence,
    reason: `${win.name} traded ${px(block.lo)}–${px(block.hi)} over ${bars} bars${both ? "; both sides have since been taken" : brokeUp ? "; the high has since been cleared" : brokeDown ? "; the low has since been cleared" : "; still intact"}`,
    shapes
  };
}
const DEFAULTS$6 = {
  gateAtr: 0.5,
  lookback: 600,
  maxPerKind: 6,
  bodyQuantile: 0.6,
  wickRatio: 2
};
function anchorsAt(data, len) {
  const out = [];
  for (const lv of detectLevels(data, {}, len)) {
    const shape = lv.shapes.find((s) => s.type === "level");
    if (shape && shape.type === "level") out.push({ price: shape.y, what: "a clustered level" });
  }
  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len)
  );
  for (const p of pivots) {
    out.push({
      price: p.price,
      what: p.kind === "high" ? "a prior swing high" : "a prior swing low"
    });
  }
  return out;
}
function nearestAnchor(anchors, price, tol) {
  let best = null;
  let bestGap = Infinity;
  for (const a of anchors) {
    const gap = Math.abs(a.price - price);
    if (gap <= tol && gap < bestGap) {
      best = a;
      bestGap = gap;
    }
  }
  return best;
}
function detectCandles(data, opts = {}, len = data.c.length) {
  const gateAtr = opts.gateAtr ?? DEFAULTS$6.gateAtr;
  const lookback = opts.lookback ?? DEFAULTS$6.lookback;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS$6.maxPerKind;
  const bodyQ = opts.bodyQuantile ?? DEFAULTS$6.bodyQuantile;
  const wickRatio = opts.wickRatio ?? DEFAULTS$6.wickRatio;
  if (len < 30) return [];
  const a = atr(data.h, data.l, data.c, 14, len);
  const bodyCut = quantile(bodyShares(data.o, data.c, len), bodyQ);
  const anchors = anchorsAt(data, len);
  const from = Math.max(3, len - lookback);
  const found = [];
  for (let i = from; i < len; i++) {
    const o = data.o[i];
    const h = data.h[i];
    const l = data.l[i];
    const c = data.c[i];
    const tol = a[i] * gateAtr;
    if (!Number.isFinite(tol) || tol <= 0) continue;
    const range = h - l;
    if (range <= 0) continue;
    const body = Math.abs(c - o);
    const bodyTop = Math.max(o, c);
    const bodyBottom = Math.min(o, c);
    const up = c > o;
    const po = data.o[i - 1];
    const pc = data.c[i - 1];
    const ph = data.h[i - 1];
    const pl = data.l[i - 1];
    const prevRange = ph - pl;
    const prevBody = Math.abs(pc - po);
    const prevUp = pc > po;
    const covers = bodyTop >= Math.max(po, pc) && bodyBottom <= Math.min(po, pc);
    const shareOfOpen = o > 0 ? body / o : 0;
    if (covers && body > prevBody && shareOfOpen >= bodyCut && up !== prevUp) {
      const anchor = nearestAnchor(anchors, up ? l : h, tol);
      if (anchor) {
        found.push(
          mark(
            "engulfing",
            i,
            up ? "long" : "short",
            up ? "Bullish engulfing" : "Bearish engulfing",
            `The body covers the previous bar's entirely and closes ${up ? "above" : "below"} it, at ${anchor.what} (${px(anchor.price)}). Body is ${(body / (prevBody || body)).toFixed(1)}x the bar it engulfed.`,
            clamp01(
              0.45 + 0.3 * clamp01(body / range) + 0.2 * clamp01(body / (prevBody || body) - 1)
            ),
            { h, l, up }
          )
        );
      }
    }
    const upperWick = h - bodyTop;
    const lowerWick = bodyBottom - l;
    const hammer = lowerWick >= body * wickRatio && lowerWick > upperWick * 2;
    const shooter = upperWick >= body * wickRatio && upperWick > lowerWick * 2;
    if (hammer || shooter) {
      const tip = hammer ? l : h;
      const wick = hammer ? lowerWick : upperWick;
      const anchor = nearestAnchor(anchors, tip, tol);
      if (anchor && wick / range >= 0.5) {
        found.push(
          mark(
            "pin-bar",
            i,
            hammer ? "long" : "short",
            hammer ? "Hammer" : "Shooting star",
            `A wick ${(wick / range * 100).toFixed(0)}% of the bar's range reached ${anchor.what} at ${px(anchor.price)} and the close came back off it.`,
            clamp01(0.4 + 0.35 * clamp01(wick / range) + 0.25 * clamp01(1 - body / range)),
            { h, l, up: hammer }
          )
        );
      }
    }
    if (prevRange > 0 && h <= ph && l >= pl && range / prevRange <= 0.7) {
      const anchor = nearestAnchor(anchors, c, tol);
      if (anchor) {
        found.push(
          mark(
            "inside-bar",
            i,
            "neutral",
            "Inside bar",
            `The whole bar sits inside the previous one at ${(range / prevRange * 100).toFixed(0)}% of its range, while price is at ${anchor.what} (${px(anchor.price)}). This marks the coil, not a side — direction is unresolved.`,
            clamp01(0.35 + 0.4 * clamp01(1 - range / prevRange)),
            { h: ph, l: pl, up: true }
          )
        );
      }
    }
    if (i >= 2) {
      const o2 = data.o[i - 2];
      const c2 = data.c[i - 2];
      const body2 = Math.abs(c2 - o2);
      const midpoint = (o2 + c2) / 2;
      const smallMiddle = prevBody <= body2 * 0.5;
      const morning = c2 < o2 && smallMiddle && up && c > midpoint;
      const evening = c2 > o2 && smallMiddle && !up && c < midpoint;
      if ((morning || evening) && o2 > 0 && body2 / o2 >= bodyCut) {
        const tip = morning ? Math.min(pl, l) : Math.max(ph, h);
        const anchor = nearestAnchor(anchors, tip, tol);
        if (anchor) {
          found.push(
            mark(
              "star",
              i,
              morning ? "long" : "short",
              morning ? "Morning star" : "Evening star",
              `Three bars: a ${morning ? "down" : "up"} body, a stall no more than half its size, then a close back past its midpoint (${px(midpoint)}) — turning at ${anchor.what} (${px(anchor.price)}).`,
              clamp01(
                0.45 + 0.3 * clamp01(body / body2) + 0.25 * clamp01(1 - prevBody / body2)
              ),
              {
                h: Math.max(h, ph, data.h[i - 2]),
                l: Math.min(l, pl, data.l[i - 2]),
                up: morning
              }
            )
          );
        }
      }
    }
  }
  return capPerKind$1(found, maxPerKind);
}
function mark(kind, i, direction, label, reason, confidence, box) {
  const tone = direction === "long" ? "bull" : direction === "short" ? "bear" : "neutral";
  const shapes = [
    { type: "box", x0: i - 0.45, x1: i + 0.45, y0: box.l, y1: box.h, tone, dashed: true },
    { type: "marker", x: i, y: box.up ? box.l : box.h, tone, text: label, above: !box.up }
  ];
  return {
    id: `${kind}-${i}`,
    kind,
    label,
    direction,
    /* `from` is the bar the pattern starts on; a star spans three. `to` is the
       bar at which it became knowable, which is always the last bar of the
       pattern — `simulate.ts` enters strictly after it. */
    from: kind === "star" ? i - 2 : kind === "pin-bar" ? i : i - 1,
    to: i,
    confidence,
    reason,
    shapes
  };
}
function capPerKind$1(found, max) {
  const byKind = /* @__PURE__ */ new Map();
  for (const d of found) {
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }
  const out = [];
  for (const list of byKind.values()) {
    list.sort((x, y) => y.to - x.to);
    out.push(...list.slice(0, max));
  }
  out.sort((x, y) => x.to - y.to);
  return out;
}
const DEFAULTS$5 = {
  lookback: 400,
  minTouches: 3,
  tolerance: 6e-3,
  minBars: 15,
  maxBars: 160,
  maxResults: 4,
  flatAtr: 1.5,
  convergeAtr: 1.5
};
function fitBoundary(set, minTouches, tolerance) {
  if (set.length < minTouches) return null;
  let best = null;
  let bestCount = minTouches - 1;
  let bestSpan = 0;
  for (let i = 0; i < set.length - 1; i++) {
    const a = set[i];
    if (set.length - i <= bestCount) break;
    for (let j = i + 1; j < set.length; j++) {
      const b = set[j];
      const span = b.index - a.index;
      if (span < 5) continue;
      const slope = (b.price - a.price) / span;
      let count = 0;
      let firstIdx = -1;
      let lastIdx = -1;
      for (let k = 0; k < set.length; k++) {
        const p = set[k];
        const expected = a.price + slope * (p.index - a.index);
        if (expected > 0 && Math.abs(p.price - expected) / expected <= tolerance) {
          count++;
          if (firstIdx < 0) firstIdx = k;
          lastIdx = k;
        }
      }
      if (count < minTouches) continue;
      const first = set[firstIdx];
      const last = set[lastIdx];
      const touchSpan = last.index - first.index;
      if (count > bestCount || count === bestCount && touchSpan > bestSpan) {
        bestCount = count;
        bestSpan = touchSpan;
        best = {
          at: (x) => a.price + slope * (x - a.index),
          slope,
          first,
          last,
          touches: count
        };
      }
    }
  }
  return best;
}
function classify(upperSlope, lowerSlope, atrUnit, spanBars, flatCut, convergeCut = flatCut) {
  if (!(atrUnit > 0) || !(spanBars > 0)) return null;
  const scale = atrUnit / spanBars;
  const up = upperSlope / scale;
  const lo = lowerSlope / scale;
  const upperFlat = Math.abs(up) < flatCut;
  const lowerFlat = Math.abs(lo) < flatCut;
  const spread = Math.abs(up - lo);
  if (spread < convergeCut) {
    if (upperFlat && lowerFlat) return null;
    const rising = up > 0;
    return {
      kind: "channel",
      label: rising ? "Rising channel" : "Falling channel",
      lean: "a channel resolves by leaving it, either side"
    };
  }
  const converging = up < lo;
  if (!converging) return null;
  if (upperFlat && lo > flatCut) {
    return { kind: "triangle", label: "Ascending triangle", lean: "folklore says up" };
  }
  if (lowerFlat && up < -flatCut) {
    return { kind: "triangle", label: "Descending triangle", lean: "folklore says down" };
  }
  if (up > flatCut && lo > flatCut) {
    return { kind: "wedge", label: "Rising wedge", lean: "folklore says down" };
  }
  if (up < -flatCut && lo < -flatCut) {
    return { kind: "wedge", label: "Falling wedge", lean: "folklore says up" };
  }
  return { kind: "triangle", label: "Symmetrical triangle", lean: "folklore says neither" };
}
function detectWedges(data, opts = {}, len = data.c.length) {
  const lookback = opts.lookback ?? DEFAULTS$5.lookback;
  const minTouches = opts.minTouches ?? DEFAULTS$5.minTouches;
  const tolerance = opts.tolerance ?? DEFAULTS$5.tolerance;
  const minBars = opts.minBars ?? DEFAULTS$5.minBars;
  const maxBars = opts.maxBars ?? DEFAULTS$5.maxBars;
  const maxResults = opts.maxResults ?? DEFAULTS$5.maxResults;
  const flatAtr = opts.flatAtr ?? DEFAULTS$5.flatAtr;
  const convergeAtr = opts.convergeAtr ?? DEFAULTS$5.convergeAtr;
  if (len < minBars + 10) return [];
  const floor = swingFloor(data.h, data.l, data.c, len);
  const all = findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len);
  const a = atr(data.h, data.l, data.c, 14, len);
  const scale = a[len - 1];
  if (!Number.isFinite(scale) || scale <= 0) return [];
  const windowStart = Math.max(0, len - lookback);
  const highs = all.filter((p) => p.kind === "high" && p.index >= windowStart).slice(-24);
  const lows = all.filter((p) => p.kind === "low" && p.index >= windowStart).slice(-24);
  const upper = fitBoundary(highs, minTouches, tolerance);
  const lower = fitBoundary(lows, minTouches, tolerance);
  if (!upper || !lower) return [];
  const start = Math.max(
    Math.min(upper.first.index, lower.first.index),
    /* Never longer than `maxBars`: past that the two lines are describing the
       whole chart rather than a formation inside it. */
    len - 1 - maxBars
  );
  const anchorEnd = Math.max(upper.last.confirmedAt, lower.last.confirmedAt);
  if (anchorEnd - start < minBars) return [];
  if (upper.at(start) <= lower.at(start)) return [];
  const out = [];
  let breakAt = -1;
  let breakUp = false;
  for (let i = anchorEnd + 1; i < len; i++) {
    const c = data.c[i];
    const hi = upper.at(i);
    const lo = lower.at(i);
    if (c > hi) {
      breakAt = i;
      breakUp = true;
      break;
    }
    if (c < lo) {
      breakAt = i;
      breakUp = false;
      break;
    }
  }
  const endX = breakAt >= 0 ? breakAt : len - 1;
  const shape = classify(upper.slope, lower.slope, scale, endX - start, flatAtr, convergeAtr);
  if (!shape) return [];
  const height = upper.at(endX) - lower.at(endX);
  const startHeight = upper.at(start) - lower.at(start);
  const narrowing = startHeight > 0 ? clamp01(1 - height / startHeight) : 0;
  const touches = upper.touches + lower.touches;
  const touchLift = clamp01((touches - 2 * minTouches) / 8);
  let kind = shape.kind;
  let label = shape.label;
  if (shape.kind === "channel") {
    const runFrom = Math.max(0, start - Math.round((endX - start) * 1.5));
    const shove = data.c[start] - data.c[runFrom];
    const poleAtr = Math.abs(shove) / scale;
    const against = poleAtr >= 3 && Math.sign(shove) !== Math.sign(upper.slope);
    if (against) {
      kind = "flag";
      label = shove > 0 ? "Bull flag" : "Bear flag";
    }
  }
  const tone = "accent";
  const lines = [
    {
      type: "line",
      x0: start,
      y0: upper.at(start),
      x1: endX,
      y1: upper.at(endX),
      tone: "bear",
      dashed: false
    },
    {
      type: "line",
      x0: start,
      y0: lower.at(start),
      x1: endX,
      y1: lower.at(endX),
      tone: "bull",
      dashed: false
    }
  ];
  const geometry = `${upper.touches} touches on the upper boundary and ${lower.touches} on the lower, over ${endX - start} bars. Height went from ${px(startHeight)} to ${px(height)}` + (narrowing > 0.05 ? `, ${(narrowing * 100).toFixed(0)}% narrower` : "") + ".";
  out.push({
    id: `${kind}-${start}-${endX}`,
    kind,
    label,
    direction: "neutral",
    from: start,
    to: anchorEnd,
    /* Capped well short of 1, and that is not cosmetic. The first version was
       `0.3 + 0.08 * (touches - 2 * minTouches)`, which on the first live series
       gave 0.08 x 15 = 1.2 and clamped to exactly 1.0 — the strongest claim
       this system can make, on every formation it found, because the term was
       unbounded. Extra touches genuinely help and they help less and less, so
       the term saturates. Nothing here earns certainty. */
    confidence: clamp01(0.25 + 0.2 * touchLift + 0.25 * narrowing),
    reason: `${geometry} Drawn while it holds and given no side — ${shape.lean}, and folklore is not evidence. The break below is what carries a record.`,
    shapes: lines
  });
  if (breakAt >= 0) {
    const level = breakUp ? upper.at(breakAt) : lower.at(breakAt);
    out.push({
      id: `${kind}-break-${breakAt}`,
      kind,
      label: `${label} break ${breakUp ? "up" : "down"}`,
      direction: breakUp ? "long" : "short",
      from: start,
      to: breakAt,
      confidence: clamp01(0.3 + 0.2 * touchLift + 0.2 * narrowing),
      reason: `Closed ${breakUp ? "above" : "below"} the ${breakUp ? "upper" : "lower"} boundary at ${px(level)} after ${endX - start} bars inside it. ${geometry}`,
      shapes: [
        ...lines,
        {
          type: "marker",
          x: breakAt,
          y: breakUp ? data.h[breakAt] : data.l[breakAt],
          tone: breakUp ? "bull" : "bear",
          text: label,
          above: breakUp
        },
        {
          type: "level",
          x0: start,
          y: level,
          tone,
          label: "boundary",
          dashed: true
        }
      ]
    });
  }
  return out.slice(0, maxResults);
}
const VALUE_AREA_PCT = 0.7;
const DEFAULT_BINS = 80;
function volumeProfile(bars, bins = DEFAULT_BINS, valueAreaPct = VALUE_AREA_PCT) {
  if (bars.length === 0 || bins < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let anyVolume = 0;
  for (const b of bars) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
    if (Number.isFinite(b.v) && b.v > 0) anyVolume += b.v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  if (anyVolume <= 0) return null;
  const binSize = (hi - lo) / bins;
  const acc = new Float64Array(bins);
  for (const b of bars) {
    const v = Number.isFinite(b.v) ? b.v : 0;
    if (v <= 0) continue;
    if (b.h - b.l <= 0) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((b.c - lo) / binSize)));
      acc[idx] = acc[idx] + v;
      continue;
    }
    const first = Math.min(bins - 1, Math.max(0, Math.floor((b.l - lo) / binSize)));
    const last = Math.min(bins - 1, Math.max(0, Math.floor((b.h - lo) / binSize)));
    const range = b.h - b.l;
    for (let i = first; i <= last; i++) {
      const binLow = lo + i * binSize;
      const binHigh = binLow + binSize;
      const overlap = Math.min(b.h, binHigh) - Math.max(b.l, binLow);
      if (overlap <= 0) continue;
      acc[i] = acc[i] + v * overlap / range;
    }
  }
  let pocIndex = 0;
  let peak = -1;
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const x = acc[i];
    total += x;
    if (x > peak) {
      peak = x;
      pocIndex = i;
    }
  }
  if (total <= 0) return null;
  const { lowIndex, highIndex } = valueArea(acc, pocIndex, total * valueAreaPct);
  const out = [];
  for (let i = 0; i < bins; i++) {
    out.push({ low: lo + i * binSize, high: lo + (i + 1) * binSize, volume: acc[i] });
  }
  return {
    bins: out,
    /* The MIDDLE of the winning bin, not its edge. A point of control drawn on
       a bin boundary looks like it belongs to whichever neighbour the eye
       happens to land on. */
    poc: lo + (pocIndex + 0.5) * binSize,
    val: lo + lowIndex * binSize,
    vah: lo + (highIndex + 1) * binSize,
    total,
    binSize,
    peak
  };
}
function valueArea(acc, pocIndex, target) {
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let held = acc[pocIndex];
  while (held < target && (lowIndex > 0 || highIndex < acc.length - 1)) {
    const below = lowIndex > 0 ? acc[lowIndex - 1] : -1;
    const above = highIndex < acc.length - 1 ? acc[highIndex + 1] : -1;
    if (below < 0 && above < 0) break;
    if (above >= below) {
      highIndex += 1;
      held += above;
    } else {
      lowIndex -= 1;
      held += below;
    }
  }
  return { lowIndex, highIndex };
}
function profileNodes(profile, sensitivity = 1) {
  const vols = profile.bins.map((b) => b.volume);
  const mean2 = profile.total / vols.length;
  let variance = 0;
  for (const v of vols) variance += (v - mean2) * (v - mean2);
  const sd = Math.sqrt(variance / vols.length);
  if (sd <= 0) return [];
  const hi = mean2 + sensitivity * sd;
  const lo = Math.max(0, mean2 - sensitivity * sd);
  const out = [];
  for (let i = 1; i < vols.length - 1; i++) {
    const v = vols[i];
    const prev = vols[i - 1];
    const next = vols[i + 1];
    const bin = profile.bins[i];
    const price = (bin.low + bin.high) / 2;
    if (v >= hi && v >= prev && v >= next) out.push({ kind: "hvn", price, volume: v });
    else if (v <= lo && v <= prev && v <= next) out.push({ kind: "lvn", price, volume: v });
  }
  return out;
}
const DEFAULTS$4 = {
  periods: 3,
  periodBars: 96,
  bins: 60,
  maxNodes: 3,
  climaxQuantile: 0.98,
  maxClimax: 4
};
function periodsOf(data, len, count, size, bins) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const end = len - k * size;
    const start = end - size;
    if (start < 0) break;
    const bars = [];
    for (let i = start; i < end; i++) {
      bars.push({
        t: data.t[i],
        o: data.o[i],
        h: data.h[i],
        l: data.l[i],
        c: data.c[i],
        v: data.v[i]
      });
    }
    const profile = volumeProfile(bars, bins);
    if (profile) out.push({ start, end: end - 1, profile });
  }
  return out.reverse();
}
function revisited(data, from, len, price) {
  for (let i = from; i < len; i++) {
    if (data.l[i] <= price && data.h[i] >= price) return true;
  }
  return false;
}
function detectProfile(data, opts = {}, len = data.c.length) {
  const periodBars = opts.periodBars ?? DEFAULTS$4.periodBars;
  const count = opts.periods ?? DEFAULTS$4.periods;
  const bins = opts.bins ?? DEFAULTS$4.bins;
  const maxNodes = opts.maxNodes ?? DEFAULTS$4.maxNodes;
  if (len < periodBars + 5) return [];
  const periods = periodsOf(data, len, count, periodBars, bins);
  if (periods.length === 0) return [];
  const out = [];
  const caveat = "Built from bar ranges, not trades — each bar's volume is spread across the prices it touched.";
  for (const p of periods) {
    const { poc, vah, val } = p.profile;
    const naked = !revisited(data, p.end + 1, len, poc);
    out.push({
      id: `poc-${p.start}`,
      kind: "poc",
      label: naked ? "Naked POC" : "Point of control",
      direction: "neutral",
      from: p.start,
      to: p.end,
      confidence: clamp01(naked ? 0.65 : 0.45),
      reason: `Most business over bars ${p.start}-${p.end} was done at ${px(poc)}. ` + (naked ? "Price has not traded back through it since — unfinished business at a price the market agreed on. " : "Price has since traded back through it. ") + caveat,
      shapes: [
        {
          type: "level",
          x0: p.start,
          y: poc,
          tone: naked ? "accent" : "neutral",
          label: naked ? "nPOC" : "POC",
          dashed: !naked
        }
      ]
    });
    out.push({
      id: `va-${p.start}`,
      kind: "value-area",
      label: "Value area",
      direction: "neutral",
      from: p.start,
      to: p.end,
      confidence: 0.4,
      reason: `70% of the volume over bars ${p.start}-${p.end} traded between ${px(val)} and ${px(vah)}. Outside that band is where the period spent time it did not agree with. ` + caveat,
      shapes: [
        { type: "box", x0: p.start, x1: p.end, y0: val, y1: vah, tone: "neutral", dashed: true, label: "VA" },
        { type: "level", x0: p.end, y: vah, tone: "neutral", label: "VAH", dashed: true },
        { type: "level", x0: p.end, y: val, tone: "neutral", label: "VAL", dashed: true }
      ]
    });
  }
  const newest = periods[periods.length - 1];
  const nodes = profileNodes(newest.profile, 1).filter((n) => n.kind === "lvn").sort((a, b) => a.volume - b.volume).slice(0, maxNodes);
  for (const n of nodes) {
    out.push({
      id: `lvn-${newest.start}-${n.price.toFixed(6)}`,
      kind: "lvn",
      label: "Low-volume node",
      direction: "neutral",
      from: newest.start,
      to: newest.end,
      confidence: 0.35,
      reason: `Almost nothing traded at ${px(n.price)} across bars ${newest.start}-${newest.end}. Price passed through rather than doing business there, which is a claim about SPEED through the level, not about direction. ` + caveat,
      shapes: [{ type: "level", x0: newest.start, y: n.price, tone: "accent", label: "LVN", dashed: true }]
    });
  }
  return out;
}
function detectVolumeClimax(data, opts = {}, len = data.c.length) {
  const q = opts.climaxQuantile ?? DEFAULTS$4.climaxQuantile;
  const max = opts.maxClimax ?? DEFAULTS$4.maxClimax;
  if (len < 60) return [];
  const vols = [];
  for (let i = 0; i < len; i++) {
    const v = data.v[i];
    if (Number.isFinite(v) && v > 0) vols.push(v);
  }
  if (vols.length < len * 0.5) return [];
  const cut = quantile(vols, q);
  if (!(cut > 0)) return [];
  const found = [];
  for (let i = Math.max(1, len - 400); i < len; i++) {
    const v = data.v[i];
    if (!(v >= cut)) continue;
    const o = data.o[i];
    const c = data.c[i];
    const h = data.h[i];
    const l = data.l[i];
    if (c === o) continue;
    const up = c > o;
    const range = h - l;
    const closePos = range > 0 ? (c - l) / range : 0.5;
    const multiple = v / (quantile(vols, 0.5) || v);
    found.push({
      id: `climax-${i}`,
      kind: "volume-climax",
      label: up ? "Buying climax" : "Selling climax",
      direction: up ? "long" : "short",
      from: i,
      to: i,
      confidence: clamp01(0.35 + 0.3 * clamp01(multiple / 10) + 0.2 * Math.abs(closePos - 0.5) * 2),
      reason: `Volume ${multiple.toFixed(1)}x the window median, in the top ${((1 - q) * 100).toFixed(0)}% of bars here, closing ${up ? "up" : "down"} at ${(closePos * 100).toFixed(0)}% of its range. Reported with the side the bar closed, not as exhaustion — which of the two readings holds on this instrument is what the record is for.`,
      shapes: [
        { type: "box", x0: i - 0.45, x1: i + 0.45, y0: l, y1: h, tone: up ? "bull" : "bear", dashed: true },
        { type: "marker", x: i, y: up ? l : h, tone: up ? "bull" : "bear", text: "vol", above: !up }
      ]
    });
  }
  found.sort((x, y) => y.to - x.to);
  return found.slice(0, max).sort((x, y) => x.to - y.to);
}
const SQ_DEFAULTS = {
  period: 20,
  bbMult: 2,
  kcMult: 1.5,
  maxReleases: 4,
  lookback: 500,
  minSqueezeBars: 5
};
function detectSqueeze(data, opts = {}, len = data.c.length) {
  const period = opts.period ?? SQ_DEFAULTS.period;
  const maxReleases = opts.maxReleases ?? SQ_DEFAULTS.maxReleases;
  const lookback = opts.lookback ?? SQ_DEFAULTS.lookback;
  const minBars = opts.minSqueezeBars ?? SQ_DEFAULTS.minSqueezeBars;
  if (len < period * 3) return [];
  const sq = squeeze(
    data.h,
    data.l,
    data.c,
    period,
    opts.bbMult ?? SQ_DEFAULTS.bbMult,
    opts.kcMult ?? SQ_DEFAULTS.kcMult,
    len
  );
  const a = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  const releases = [];
  const from = Math.max(period, len - lookback);
  let runStart = -1;
  for (let i = from; i < len; i++) {
    const on = sq[i] === 1;
    const prevOn = sq[i - 1] === 1;
    if (on && !prevOn) runStart = i;
    if (!on && prevOn && runStart >= 0) {
      const bars = i - runStart;
      if (bars >= minBars) {
        const o = data.o[i];
        const c = data.c[i];
        const up = c > o;
        const move = Math.abs(c - o) / (a[i] || 1);
        releases.push({
          id: `squeeze-release-${i}`,
          kind: "squeeze",
          label: `Squeeze release ${up ? "up" : "down"}`,
          direction: up ? "long" : "short",
          from: runStart,
          to: i,
          confidence: clamp01(0.35 + 0.25 * clamp01(bars / (period * 2)) + 0.3 * clamp01(move / 2)),
          reason: `Bollinger bands sat inside the Keltner channel for ${bars} bars, then this bar closed ${up ? "up" : "down"} ${move.toFixed(1)} ATR and the compression ended. The side is the one price took — the squeeze itself predicts nothing about direction.`,
          shapes: [
            {
              type: "box",
              x0: runStart,
              x1: i,
              y0: minLow(data, runStart, i),
              y1: maxHigh(data, runStart, i),
              tone: "neutral",
              dashed: true,
              label: `${bars}-bar squeeze`
            },
            {
              type: "marker",
              x: i,
              y: up ? data.l[i] : data.h[i],
              tone: up ? "bull" : "bear",
              text: "release",
              above: up
            }
          ]
        });
      }
      runStart = -1;
    }
  }
  if (sq[len - 1] === 1 && runStart >= 0 && len - 1 - runStart >= minBars) {
    const bars = len - 1 - runStart;
    out.push({
      id: `squeeze-live-${runStart}`,
      kind: "squeeze",
      label: "In a squeeze",
      direction: "neutral",
      from: runStart,
      to: len - 1,
      confidence: clamp01(0.3 + 0.4 * clamp01(bars / (period * 2))),
      reason: `${bars} bars with the Bollinger bands inside the Keltner channel and still compressed. This is a description of what has happened, not a forecast: it says the range is small, not which way it opens up.`,
      shapes: [
        {
          type: "box",
          x0: runStart,
          x1: len - 1,
          y0: minLow(data, runStart, len - 1),
          y1: maxHigh(data, runStart, len - 1),
          tone: "accent",
          dashed: true,
          extend: true,
          label: `${bars}-bar squeeze`
        }
      ]
    });
  }
  releases.sort((x, y) => y.to - x.to);
  out.push(...releases.slice(0, maxReleases));
  out.sort((x, y) => x.to - y.to);
  return out;
}
function minLow(data, from, to) {
  let v = Infinity;
  for (let i = from; i <= to; i++) v = Math.min(v, data.l[i]);
  return v;
}
function maxHigh(data, from, to) {
  let v = -Infinity;
  for (let i = from; i <= to; i++) v = Math.max(v, data.h[i]);
  return v;
}
const GAP_DEFAULTS = { minAtr: 0.5, lookback: 500, maxResults: 6 };
function detectGaps(data, opts = {}, len = data.c.length) {
  const minAtr = opts.minAtr ?? GAP_DEFAULTS.minAtr;
  const lookback = opts.lookback ?? GAP_DEFAULTS.lookback;
  const maxResults = opts.maxResults ?? GAP_DEFAULTS.maxResults;
  if (len < 30) return [];
  const a = atr(data.h, data.l, data.c, 14, len);
  const found = [];
  for (let i = Math.max(1, len - lookback); i < len; i++) {
    const prevHigh = data.h[i - 1];
    const prevLow = data.l[i - 1];
    const lo = data.l[i];
    const hi = data.h[i];
    const unit2 = a[i];
    if (!Number.isFinite(unit2) || unit2 <= 0) continue;
    const up = lo > prevHigh;
    const down = hi < prevLow;
    if (!up && !down) continue;
    const edgeNear = up ? prevHigh : prevLow;
    const edgeFar = up ? lo : hi;
    const size = Math.abs(edgeFar - edgeNear);
    if (size < unit2 * minAtr) continue;
    let filledAt = -1;
    for (let j = i + 1; j < len; j++) {
      const jl = data.l[j];
      const jh = data.h[j];
      if (up ? jl <= edgeNear : jh >= edgeNear) {
        filledAt = j;
        break;
      }
    }
    found.push({
      id: `gap-${i}`,
      kind: "gap",
      /* The side is the direction the gap OPENED, which is the only fact here.
         "Gaps get filled" would make this short on an up gap; that is the
         claim under test, not an input to it. */
      label: `Gap ${up ? "up" : "down"}`,
      direction: up ? "long" : "short",
      from: i - 1,
      to: i,
      confidence: clamp01(0.35 + 0.35 * clamp01(size / (unit2 * 3))),
      reason: `Price was never offered between ${px(Math.min(edgeNear, edgeFar))} and ${px(Math.max(edgeNear, edgeFar))} — a ${(size / unit2).toFixed(1)} ATR discontinuity. ` + (filledAt >= 0 ? `Filled ${filledAt - i} bars later.` : `Still open ${len - 1 - i} bars later.`),
      shapes: [
        {
          type: "box",
          x0: i - 0.5,
          x1: filledAt >= 0 ? filledAt : len - 1,
          y0: Math.min(edgeNear, edgeFar),
          y1: Math.max(edgeNear, edgeFar),
          tone: up ? "bull" : "bear",
          dashed: filledAt >= 0,
          extend: filledAt < 0,
          label: filledAt >= 0 ? "gap (filled)" : "gap"
        }
      ]
    });
  }
  found.sort((x, y) => y.to - x.to);
  return found.slice(0, maxResults).sort((x, y) => x.to - y.to);
}
function roundStep(price, unit2, minAtr) {
  if (!(price > 0) || !(unit2 > 0)) return 0;
  const target = unit2 * minAtr;
  const mantissas = [1, 2.5, 5];
  for (let k = -8; k <= 9; k++) {
    const decade = Math.pow(10, k);
    for (const m of mantissas) {
      const step = m * decade;
      if (step >= target) return step;
    }
  }
  return 0;
}
function detectRoundNumbers(data, opts = {}, len = data.c.length) {
  const minAtr = opts.minAtr ?? 2;
  const each = opts.each ?? 2;
  if (len < 20) return [];
  const price = data.c[len - 1];
  const a = atr(data.h, data.l, data.c, 14, len);
  const unit2 = a[len - 1];
  const step = roundStep(price, unit2, minAtr);
  if (!(step > 0)) return [];
  const base = Math.round(price / step) * step;
  const out = [];
  for (let k = -each; k <= each; k++) {
    const level = base + k * step;
    if (level <= 0) continue;
    let touches = 0;
    for (let i = Math.max(0, len - 400); i < len; i++) {
      if (data.l[i] <= level && data.h[i] >= level) touches++;
    }
    out.push({
      id: `round-${level.toFixed(8)}`,
      kind: "round-level",
      label: "Round number",
      direction: "neutral",
      from: Math.max(0, len - 400),
      to: len - 1,
      confidence: clamp01(0.2 + 0.3 * clamp01(touches / 20)),
      reason: `${px(level)} on a ${px(step)} ladder — the coarsest round step that is still at least ${minAtr} ATR wide on this instrument. Traded through ${touches} times in the last ${Math.min(400, len)} bars, which is the only evidence offered that it matters.`,
      shapes: [{ type: "level", x0: Math.max(0, len - 120), y: level, tone: "neutral", label: px(level), dashed: true }]
    });
  }
  return out;
}
const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786];
function detectFibs(data, opts = {}, len = data.c.length) {
  const ratios = opts.ratios ?? FIB_RATIOS;
  const [oteFrom, oteTo] = opts.ote ?? [0.618, 0.786];
  if (len < 40) return [];
  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len)
  ).filter((p) => p.confirmedAt <= len - 1);
  if (pivots.length < 2) return [];
  const b = pivots[pivots.length - 1];
  const a = pivots[pivots.length - 2];
  if (a.kind === b.kind) return [];
  const up = b.kind === "high";
  const from = a.price;
  const to = b.price;
  const height = to - from;
  if (!(Math.abs(height) > 0)) return [];
  const priceAt = (r) => to - height * r;
  const shapes = [
    {
      type: "box",
      x0: b.index,
      x1: len - 1,
      y0: Math.min(priceAt(oteFrom), priceAt(oteTo)),
      y1: Math.max(priceAt(oteFrom), priceAt(oteTo)),
      tone: up ? "bull" : "bear",
      extend: true,
      label: "OTE"
    }
  ];
  for (const r of ratios) {
    shapes.push({
      type: "level",
      x0: a.index,
      y: priceAt(r),
      tone: "neutral",
      label: r.toFixed(3),
      dashed: true
    });
  }
  const mid = priceAt(0.5);
  const now = data.c[len - 1];
  const inPremium = up ? now > mid : now < mid;
  return [
    {
      id: `fib-${a.index}-${b.index}`,
      kind: "fib",
      label: up ? "Retracement of the up leg" : "Retracement of the down leg",
      direction: "neutral",
      from: a.index,
      to: b.index,
      confidence: clamp01(0.3 + 0.3 * clamp01(Math.abs(height) / (Math.abs(to) * 0.05 || 1))),
      reason: `Anchored to the last completed leg: ${px(from)} (bar ${a.index}) to ${px(to)} (bar ${b.index}). Midpoint ${px(mid)}, so price at ${px(now)} is in ${inPremium ? "premium" : "discount"}. The OTE band is ${px(priceAt(oteTo))} to ${px(priceAt(oteFrom))}. These are arithmetic on two pivots — the levels are exact, whether the market cares about them is not claimed.`,
      shapes
    }
  ];
}
const dayOf$1 = (ms) => Math.floor(ms / 864e5);
function dayBlocks(data, len) {
  const out = [];
  let start = 0;
  let day = dayOf$1(data.t[0]);
  for (let i = 1; i < len; i++) {
    const d = dayOf$1(data.t[i]);
    if (d !== day) {
      out.push({ start, end: i - 1, day });
      start = i;
      day = d;
    }
  }
  out.push({ start, end: len - 1, day });
  return out;
}
function extremes(data, from, to) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i++) {
    hi = Math.max(hi, data.h[i]);
    lo = Math.min(lo, data.l[i]);
  }
  return { hi, lo, close: data.c[to] };
}
function detectPivotPoints(data, _opts = {}, len = data.c.length) {
  if (len < 10) return [];
  const blocks = dayBlocks(data, len);
  if (blocks.length < 2) return [];
  const prev = blocks[blocks.length - 2];
  if (prev.end - prev.start < 3) return [];
  const { hi, lo, close } = extremes(data, prev.start, prev.end);
  const pp = (hi + lo + close) / 3;
  const r1 = 2 * pp - lo;
  const s1 = 2 * pp - hi;
  const r2 = pp + (hi - lo);
  const s2 = pp - (hi - lo);
  const today = blocks[blocks.length - 1];
  const rows = [
    { name: "R2", y: r2 },
    { name: "R1", y: r1 },
    { name: "PP", y: pp },
    { name: "S1", y: s1 },
    { name: "S2", y: s2 }
  ];
  return [
    {
      id: `pivots-${prev.day}`,
      kind: "pivot-level",
      label: "Floor pivots",
      direction: "neutral",
      from: prev.start,
      to: prev.end,
      confidence: 0.35,
      reason: `Classic pivots from the previous session: high ${px(hi)}, low ${px(lo)}, close ${px(close)} over ${prev.end - prev.start + 1} bars. PP ${px(pp)}, R1 ${px(r1)}, S1 ${px(s1)}. Computed, not predicted — these are the levels a second trader would have on their chart.`,
      shapes: rows.map(
        (r) => ({
          type: "level",
          x0: today.start,
          y: r.y,
          tone: r.name === "PP" ? "accent" : "neutral",
          label: r.name,
          dashed: r.name !== "PP"
        })
      )
    }
  ];
}
function detectPriorLevels(data, _opts = {}, len = data.c.length) {
  if (len < 10) return [];
  const blocks = dayBlocks(data, len);
  if (blocks.length < 2) return [];
  const out = [];
  const prev = blocks[blocks.length - 2];
  const today = blocks[blocks.length - 1];
  const push = (name, from, to, id) => {
    if (to - from < 1) return;
    const { hi, lo } = extremes(data, from, to);
    let takenHigh = false;
    let takenLow = false;
    for (let i = today.start; i < len; i++) {
      if (data.h[i] >= hi) takenHigh = true;
      if (data.l[i] <= lo) takenLow = true;
    }
    out.push({
      id,
      kind: "prior-level",
      label: `${name} high / low`,
      direction: "neutral",
      from,
      to,
      confidence: clamp01(0.3 + (takenHigh && takenLow ? 0 : 0.25)),
      reason: `${name}: high ${px(hi)}${takenHigh ? " (taken)" : " (untouched)"}, low ${px(lo)}${takenLow ? " (taken)" : " (untouched)"}, over bars ${from}-${to}. An untouched prior extreme is resting liquidity; a taken one has already done its work.`,
      shapes: [
        {
          type: "level",
          x0: today.start,
          y: hi,
          tone: takenHigh ? "neutral" : "bear",
          label: `${name}H`,
          dashed: takenHigh
        },
        {
          type: "level",
          x0: today.start,
          y: lo,
          tone: takenLow ? "neutral" : "bull",
          label: `${name}L`,
          dashed: takenLow
        }
      ]
    });
  };
  push("Prior day", prev.start, prev.end, `prior-day-${prev.day}`);
  const weekOf = (ms) => Math.floor((ms + 4 * 864e5) / (7 * 864e5));
  const thisWeek = weekOf(data.t[len - 1]);
  let wStart = -1;
  let wEnd = -1;
  for (let i = 0; i < len; i++) {
    const w = weekOf(data.t[i]);
    if (w === thisWeek - 1) {
      if (wStart < 0) wStart = i;
      wEnd = i;
    }
  }
  if (wStart >= 0 && wEnd > wStart) push("Prior week", wStart, wEnd, `prior-week-${thisWeek - 1}`);
  return out;
}
function detectAnchoredVwap(data, opts = {}, len = data.c.length) {
  const maxAnchors = opts.maxAnchors ?? 2;
  if (len < 40) return [];
  let anyVolume = 0;
  for (let i = 0; i < len; i++) anyVolume += data.v[i] || 0;
  if (anyVolume <= 0) return [];
  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 4, right: 4, minProminence: floor }, len)
  ).filter((p) => p.confirmedAt <= len - 1);
  const lastHigh = [...pivots].reverse().find((p) => p.kind === "high");
  const lastLow = [...pivots].reverse().find((p) => p.kind === "low");
  const anchors = [lastHigh, lastLow].filter((p) => p !== void 0).slice(0, maxAnchors);
  const out = [];
  const now = data.c[len - 1];
  for (const p of anchors) {
    if (len - p.index < 10) continue;
    const series = anchoredVwap(data.h, data.l, data.c, data.v, p.index, len);
    const end = series[len - 1];
    const start = series[p.index];
    if (!Number.isFinite(end) || !Number.isFinite(start)) continue;
    const above = now > end;
    out.push({
      id: `avwap-${p.kind}-${p.index}`,
      kind: "avwap",
      label: `VWAP from the swing ${p.kind}`,
      direction: "neutral",
      from: p.index,
      to: len - 1,
      confidence: clamp01(0.3 + 0.25 * clamp01((len - p.index) / 200)),
      reason: `Volume-weighted average price since bar ${p.index} (${px(p.price)}), now ${px(end)}. Price is ${above ? "above" : "below"} it, so everyone who bought since that swing is on average ${above ? "in profit" : "underwater"}. That is an accounting fact, not a signal.`,
      shapes: [
        { type: "line", x0: p.index, y0: start, x1: len - 1, y1: end, tone: p.kind === "high" ? "bear" : "bull", extend: false, label: "aVWAP" },
        { type: "level", x0: len - 1, y: end, tone: "neutral", label: "aVWAP", dashed: true }
      ]
    });
  }
  return out;
}
const DEFAULTS$3 = { reclaimBars: 8, retestAtr: 0.4, maxPerKind: 4, lookback: 500 };
function boxEdges(d) {
  const box = d.shapes.find((s) => s.type === "box");
  if (!box || box.type !== "box") return null;
  return { lo: Math.min(box.y0, box.y1), hi: Math.max(box.y0, box.y1) };
}
function detectSprings(data, opts = {}, len = data.c.length) {
  const reclaimBars = opts.reclaimBars ?? DEFAULTS$3.reclaimBars;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS$3.maxPerKind;
  if (len < 40) return [];
  const ranges = detectRanges(data, { maxResults: 6 }, len);
  const a = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  for (const r of ranges) {
    const edges = boxEdges(r);
    if (!edges) continue;
    const { lo, hi } = edges;
    const height = hi - lo;
    if (!(height > 0)) continue;
    for (let i = r.to + 1; i < len; i++) {
      const barLow = data.l[i];
      const barHigh = data.h[i];
      const unit2 = a[i] || height * 0.1;
      for (const side of ["low", "high"]) {
        const broke = side === "low" ? barLow < lo : barHigh > hi;
        if (!broke) continue;
        const edge = side === "low" ? lo : hi;
        const depth = side === "low" ? lo - barLow : barHigh - hi;
        let reclaimAt = -1;
        for (let j = i; j < Math.min(len, i + reclaimBars + 1); j++) {
          const c = data.c[j];
          if (side === "low" ? c > lo : c < hi) {
            reclaimAt = j;
            break;
          }
          if (side === "low" ? c < barLow : c > barHigh) {
            reclaimAt = -2;
            break;
          }
        }
        if (reclaimAt < 0) continue;
        const spring = side === "low";
        const bars = reclaimAt - i;
        out.push({
          id: `${spring ? "spring" : "upthrust"}-${i}`,
          kind: spring ? "spring" : "upthrust",
          label: spring ? "Spring" : "Upthrust",
          direction: spring ? "long" : "short",
          from: r.from,
          to: reclaimAt,
          confidence: clamp01(
            0.4 + 0.25 * clamp01(depth / unit2) + 0.2 * clamp01(1 - bars / (reclaimBars + 1))
          ),
          reason: `Price traded ${px(depth)} (${(depth / unit2).toFixed(1)} ATR) ${spring ? "below" : "above"} the ${bars === 0 ? "range" : "range"} ${spring ? "floor" : "ceiling"} at ${px(edge)}, then closed back inside ${bars === 0 ? "on the same bar" : `${bars} bar${bars === 1 ? "" : "s"} later`}. The break was not held.`,
          shapes: [
            { type: "box", x0: r.from, x1: reclaimAt, y0: lo, y1: hi, tone: "neutral", dashed: true },
            { type: "level", x0: r.from, y: edge, tone: spring ? "bull" : "bear", label: spring ? "floor" : "ceiling", dashed: false },
            {
              type: "marker",
              x: i,
              y: spring ? barLow : barHigh,
              tone: spring ? "bull" : "bear",
              text: spring ? "spring" : "upthrust",
              above: !spring
            }
          ]
        });
        break;
      }
    }
  }
  return capPerKind(out, maxPerKind);
}
function detectFailedBreaks(data, opts = {}, len = data.c.length) {
  const reclaimBars = opts.reclaimBars ?? DEFAULTS$3.reclaimBars;
  const retestAtr = opts.retestAtr ?? DEFAULTS$3.retestAtr;
  const maxPerKind = opts.maxPerKind ?? DEFAULTS$3.maxPerKind;
  const lookback = opts.lookback ?? DEFAULTS$3.lookback;
  if (len < 40) return [];
  const breaks = detectStructure(data, {}, len).filter(
    (d) => (d.kind === "bos" || d.kind === "choch") && d.to >= len - lookback
  );
  const a = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  for (const b of breaks) {
    const lvl = b.shapes.find((s) => s.type === "level");
    const line = b.shapes.find((s) => s.type === "line");
    const level = lvl && lvl.type === "level" ? lvl.y : line && line.type === "line" ? line.y1 : NaN;
    if (!Number.isFinite(level)) continue;
    const long = b.direction === "long";
    const unit2 = a[b.to] || 0;
    if (!(unit2 > 0)) continue;
    let failedAt = -1;
    let retestAt = -1;
    for (let j = b.to + 1; j < Math.min(len, b.to + reclaimBars + 1); j++) {
      const c = data.c[j];
      if (long ? c < level : c > level) {
        failedAt = j;
        break;
      }
      const reach = long ? data.l[j] : data.h[j];
      if (retestAt < 0 && Math.abs(reach - level) <= unit2 * retestAtr) retestAt = j;
    }
    if (failedAt >= 0) {
      const bars = failedAt - b.to;
      out.push({
        id: `failed-break-${b.to}`,
        kind: "failed-break",
        label: `Failed ${b.kind === "bos" ? "break of structure" : "change of character"}`,
        direction: long ? "short" : "long",
        from: b.from,
        to: failedAt,
        confidence: clamp01(0.4 + 0.3 * clamp01(1 - bars / (reclaimBars + 1)) + 0.15 * b.confidence),
        reason: `${b.label} broke ${px(level)} on bar ${b.to}, then price closed back through it ${bars} bar${bars === 1 ? "" : "s"} later. Reported on the side of the reversal, because the break is what failed.`,
        shapes: [
          { type: "level", x0: b.from, y: level, tone: long ? "bear" : "bull", label: "lost", dashed: false },
          {
            type: "marker",
            x: failedAt,
            y: long ? data.h[failedAt] : data.l[failedAt],
            tone: long ? "bear" : "bull",
            text: "failed",
            above: long
          }
        ]
      });
      continue;
    }
    if (retestAt >= 0) {
      const bars = retestAt - b.to;
      out.push({
        id: `retest-${b.to}`,
        kind: "retest",
        label: "Break and retest",
        direction: long ? "long" : "short",
        from: b.from,
        to: retestAt,
        confidence: clamp01(0.4 + 0.25 * clamp01(1 - bars / (reclaimBars + 1)) + 0.15 * b.confidence),
        reason: `${b.label} broke ${px(level)} on bar ${b.to}; price came back within ${retestAtr} ATR of it ${bars} bar${bars === 1 ? "" : "s"} later and did not close through. Same side as the break, and the exact complement of a failed break over the same population — the two records together are what say whether a retest helps here.`,
        shapes: [
          { type: "level", x0: b.from, y: level, tone: long ? "bull" : "bear", label: "held", dashed: false },
          {
            type: "marker",
            x: retestAt,
            y: long ? data.l[retestAt] : data.h[retestAt],
            tone: long ? "bull" : "bear",
            text: "retest",
            above: !long
          }
        ]
      });
    }
  }
  return capPerKind(out, maxPerKind);
}
function detectMitigation(data, opts = {}, len = data.c.length) {
  const maxPerKind = opts.maxPerKind ?? DEFAULTS$3.maxPerKind;
  if (len < 40) return [];
  const blocks = detectOrderBlocks(data, { hideMitigated: false, maxZones: 24 }, len);
  const out = [];
  for (const block of blocks) {
    const edges = boxEdges(block);
    if (!edges) continue;
    const { lo, hi } = edges;
    const long = block.direction === "long";
    let enteredAt = -1;
    let leftAt = -1;
    for (let i = block.to + 1; i < len; i++) {
      const barLow = data.l[i];
      const barHigh = data.h[i];
      const c = data.c[i];
      if (enteredAt < 0) {
        if (barLow <= hi && barHigh >= lo) enteredAt = i;
        continue;
      }
      if (long ? c < lo : c > hi) {
        enteredAt = -1;
        leftAt = -1;
        break;
      }
      if (long ? c > hi : c < lo) {
        leftAt = i;
        break;
      }
    }
    if (enteredAt < 0 || leftAt < 0) continue;
    out.push({
      id: `mitigation-${block.from}-${leftAt}`,
      kind: "mitigation",
      label: "Mitigated order block",
      direction: long ? "long" : "short",
      from: block.from,
      to: leftAt,
      confidence: clamp01(0.35 + 0.3 * block.confidence + 0.2 * clamp01(1 / (leftAt - enteredAt + 1))),
      reason: `Price returned into the ${long ? "demand" : "supply"} block at ${px(lo)}-${px(hi)} on bar ${enteredAt}, never closed through it, and left the same way ${leftAt - enteredAt} bar${leftAt - enteredAt === 1 ? "" : "s"} later. The zone did its job — the opposite outcome to the breaker record.`,
      shapes: [
        { type: "box", x0: block.from, x1: leftAt, y0: lo, y1: hi, tone: long ? "bull" : "bear", dashed: false, label: "mitigated" },
        {
          type: "marker",
          x: leftAt,
          y: long ? data.l[leftAt] : data.h[leftAt],
          tone: long ? "bull" : "bear",
          text: "held",
          above: !long
        }
      ]
    });
  }
  return capPerKind(out, maxPerKind);
}
function capPerKind(found, max) {
  const byKind = /* @__PURE__ */ new Map();
  for (const d of found) {
    const list = byKind.get(d.kind) ?? [];
    list.push(d);
    byKind.set(d.kind, list);
  }
  const out = [];
  for (const list of byKind.values()) {
    list.sort((x, y) => y.to - x.to);
    out.push(...list.slice(0, max));
  }
  out.sort((x, y) => x.to - y.to);
  return out;
}
const MAX_BAR_MS = 4 * 36e5;
const DEFAULTS$2 = { days: 3, killzoneHours: 2, orbBars: 3, maxResults: 12 };
function barMs(data, len) {
  const gaps = [];
  for (let i = Math.max(1, len - 60); i < len; i++) {
    const g = data.t[i] - data.t[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
const dayOf = (ms) => Math.floor(ms / 864e5);
const hourOf = (ms) => new Date(ms).getUTCHours();
function killzones(hours) {
  return SESSIONS.filter((s) => s.id === "london" || s.id === "newyork" || s.id === "tokyo").map(
    (s) => ({
      id: `${s.id}-open`,
      name: `${s.name} open`,
      from: s.openUtc,
      to: (s.openUtc + hours) % 24
    })
  );
}
function inWindow(hour, from, to) {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
function detectKillzones(data, opts = {}, len = data.c.length) {
  const days = opts.days ?? DEFAULTS$2.days;
  const hours = opts.killzoneHours ?? DEFAULTS$2.killzoneHours;
  const maxResults = opts.maxResults ?? DEFAULTS$2.maxResults;
  if (len < 30) return [];
  const step = barMs(data, len);
  if (!(step > 0) || step > MAX_BAR_MS || step > hours * 36e5) return [];
  const zones = killzones(hours);
  const out = [];
  const share = /* @__PURE__ */ new Map();
  for (const z of zones) share.set(z.id, { inside: 0, total: 0, clock: hours / 24 });
  for (let i = 1; i < len; i++) {
    const move = Math.abs(data.c[i] - data.c[i - 1]);
    if (!Number.isFinite(move)) continue;
    const h = hourOf(data.t[i]);
    for (const z of zones) {
      const s = share.get(z.id);
      if (!s) continue;
      s.total += move;
      if (inWindow(h, z.from, z.to)) s.inside += move;
    }
  }
  const lastDay = dayOf(data.t[len - 1]);
  for (const z of zones) {
    const s = share.get(z.id);
    if (!s || s.total <= 0) continue;
    const measured = s.inside / s.total;
    const lift = measured / s.clock;
    for (let d = 0; d < days; d++) {
      const day = lastDay - d;
      let start = -1;
      let end = -1;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < len; i++) {
        const t = data.t[i];
        if (dayOf(t) !== day) continue;
        if (!inWindow(hourOf(t), z.from, z.to)) continue;
        if (start < 0) start = i;
        end = i;
        hi = Math.max(hi, data.h[i]);
        lo = Math.min(lo, data.l[i]);
      }
      if (start < 0 || end <= start) continue;
      out.push({
        id: `killzone-${z.id}-${day}`,
        kind: "killzone",
        label: z.name,
        direction: "neutral",
        from: start,
        to: end,
        /* The measurement IS the confidence. A window that carries no more
           than its share of the clock scores near zero and is drawn faint. */
        confidence: clamp01((lift - 1) / 1.5),
        reason: `${String(z.from).padStart(2, "0")}:00-${String(z.to).padStart(2, "0")}:00 UTC. Measured on the loaded history, ${(measured * 100).toFixed(1)}% of all price travel happened in this window, against ${(s.clock * 100).toFixed(1)}% of the clock — ${lift >= 1.05 ? `${lift.toFixed(2)}x its share` : lift <= 0.95 ? `below its share` : `about its share`}. The window is drawn; whether it is special is that number, not the name.`,
        shapes: [
          {
            type: "box",
            x0: start - 0.5,
            x1: end + 0.5,
            y0: lo,
            y1: hi,
            tone: "accent",
            dashed: true,
            label: z.name
          }
        ]
      });
    }
  }
  out.sort((a, b) => a.to - b.to);
  return out.slice(-maxResults);
}
function detectOpeningRange(data, opts = {}, len = data.c.length) {
  const days = opts.days ?? DEFAULTS$2.days;
  const orbBars = opts.orbBars ?? DEFAULTS$2.orbBars;
  if (len < 30) return [];
  const step = barMs(data, len);
  if (!(step > 0) || step > MAX_BAR_MS) return [];
  const out = [];
  const lastDay = dayOf(data.t[len - 1]);
  const london = SESSIONS.find((s) => s.id === "london");
  if (!london) return [];
  for (let d = 0; d < days; d++) {
    const day = lastDay - d;
    let open = -1;
    for (let i = 0; i < len; i++) {
      const t = data.t[i];
      if (dayOf(t) === day && hourOf(t) >= london.openUtc) {
        open = i;
        break;
      }
    }
    if (open < 0 || open + orbBars >= len) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = open; i < open + orbBars; i++) {
      hi = Math.max(hi, data.h[i]);
      lo = Math.min(lo, data.l[i]);
    }
    if (!(hi > lo)) continue;
    const last = open + orbBars - 1;
    out.push({
      id: `orb-${day}`,
      kind: "opening-range",
      label: "Opening range",
      direction: "neutral",
      from: open,
      to: last,
      confidence: 0.35,
      reason: `The first ${orbBars} bars after the London open set ${px(lo)} to ${px(hi)}. Drawn with no side: the break below is the event that carries a record.`,
      shapes: [
        { type: "box", x0: open - 0.5, x1: last + 0.5, y0: lo, y1: hi, tone: "neutral", dashed: true, label: "OR" },
        { type: "level", x0: last, y: hi, tone: "neutral", label: "ORH", dashed: true },
        { type: "level", x0: last, y: lo, tone: "neutral", label: "ORL", dashed: true }
      ]
    });
    for (let i = last + 1; i < len; i++) {
      if (dayOf(data.t[i]) !== day) break;
      const c = data.c[i];
      const up = c > hi;
      const down = c < lo;
      if (!up && !down) continue;
      const bars = i - last;
      out.push({
        id: `orb-break-${day}-${i}`,
        kind: "opening-range",
        label: `Opening range break ${up ? "up" : "down"}`,
        direction: up ? "long" : "short",
        from: open,
        to: i,
        confidence: clamp01(0.4 + 0.25 * clamp01(1 - bars / 12)),
        reason: `Closed ${up ? "above" : "below"} the opening range at ${px(up ? hi : lo)}, ${bars} bar${bars === 1 ? "" : "s"} after it was set.`,
        shapes: [
          { type: "box", x0: open - 0.5, x1: i, y0: lo, y1: hi, tone: "neutral", dashed: true },
          {
            type: "marker",
            x: i,
            y: up ? data.h[i] : data.l[i],
            tone: up ? "bull" : "bear",
            text: "ORB",
            above: up
          }
        ]
      });
      break;
    }
  }
  return out;
}
const DEFAULTS$1 = { tolerance: 0.12, maxResults: 3, lookback: 500 };
const TEMPLATES = [
  { name: "Gartley", ab: [0.618, 0.618], bc: [0.382, 0.886], cd: [1.13, 1.618], ad: [0.786, 0.786] },
  { name: "Bat", ab: [0.382, 0.5], bc: [0.382, 0.886], cd: [1.618, 2.618], ad: [0.886, 0.886] },
  { name: "Butterfly", ab: [0.786, 0.786], bc: [0.382, 0.886], cd: [1.618, 2.24], ad: [1.27, 1.618] },
  { name: "Crab", ab: [0.382, 0.618], bc: [0.382, 0.886], cd: [2.24, 3.618], ad: [1.618, 1.618] }
];
function within(v, band2, tol) {
  const [lo, hi] = band2;
  return v >= lo * (1 - tol) && v <= hi * (1 + tol);
}
function fit(v, band2, tol) {
  const [lo, hi] = band2;
  const min = lo * (1 - tol);
  const max = hi * (1 + tol);
  if (max <= min) return 0;
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  return clamp01(1 - Math.abs(v - mid) / half);
}
function detectHarmonics(data, opts = {}, len = data.c.length) {
  const tol = opts.tolerance ?? DEFAULTS$1.tolerance;
  const maxResults = opts.maxResults ?? DEFAULTS$1.maxResults;
  const lookback = opts.lookback ?? DEFAULTS$1.lookback;
  if (len < 60) return [];
  const floor = swingFloor(data.h, data.l, data.c, len);
  const pivots = alternate(
    findPivots(data.h, data.l, { left: 3, right: 3, minProminence: floor }, len)
  ).filter((p) => p.confirmedAt <= len - 1 && p.index >= len - lookback);
  if (pivots.length < 5) return [];
  const a14 = atr(data.h, data.l, data.c, 14, len);
  const out = [];
  for (let i = 0; i + 4 < pivots.length; i++) {
    const X = pivots[i];
    const A = pivots[i + 1];
    const B = pivots[i + 2];
    const C = pivots[i + 3];
    const D = pivots[i + 4];
    const xa = A.price - X.price;
    const ab = B.price - A.price;
    const bc = C.price - B.price;
    const cd = D.price - C.price;
    const ad = D.price - A.price;
    if (xa === 0 || ab === 0 || bc === 0) continue;
    if (Math.sign(ab) === Math.sign(xa)) continue;
    if (Math.sign(bc) === Math.sign(ab)) continue;
    if (Math.sign(cd) === Math.sign(bc)) continue;
    const rAB = Math.abs(ab / xa);
    const rBC = Math.abs(bc / ab);
    const rCD = Math.abs(cd / bc);
    const rAD = Math.abs(ad / xa);
    for (const t of TEMPLATES) {
      if (!within(rAB, t.ab, tol)) continue;
      if (!within(rBC, t.bc, tol)) continue;
      if (!within(rCD, t.cd, tol)) continue;
      if (!within(rAD, t.ad, tol)) continue;
      const bullish = D.kind === "low";
      const quality = (fit(rAB, t.ab, tol) + fit(rBC, t.bc, tol) + fit(rCD, t.cd, tol) + fit(rAD, t.ad, tol)) / 4;
      const unit2 = a14[D.index] || 1;
      const legAtr = Math.abs(xa) / unit2;
      const shapes = [
        { type: "line", x0: X.index, y0: X.price, x1: A.index, y1: A.price, tone: "neutral" },
        { type: "line", x0: A.index, y0: A.price, x1: B.index, y1: B.price, tone: "neutral" },
        { type: "line", x0: B.index, y0: B.price, x1: C.index, y1: C.price, tone: "neutral" },
        {
          type: "line",
          x0: C.index,
          y0: C.price,
          x1: D.index,
          y1: D.price,
          tone: bullish ? "bull" : "bear",
          label: t.name
        },
        {
          type: "marker",
          x: D.index,
          y: D.price,
          tone: bullish ? "bull" : "bear",
          text: "D",
          above: !bullish
        }
      ];
      out.push({
        id: `harmonic-${t.name}-${D.index}`,
        kind: "harmonic",
        label: `${bullish ? "Bullish" : "Bearish"} ${t.name}`,
        direction: bullish ? "long" : "short",
        from: X.index,
        /* The pivot's own confirmation bar, not its index. D is not knowable
           until its right-hand bars have closed, and dating the pattern at the
           extreme would let the simulator enter before it existed. */
        to: D.confirmedAt,
        confidence: clamp01(0.25 + 0.4 * quality + 0.15 * clamp01(legAtr / 10)),
        reason: `Five confirmed swings matching ${t.name} within ${(tol * 100).toFixed(0)}%: AB/XA ${rAB.toFixed(3)}, BC/AB ${rBC.toFixed(3)}, CD/BC ${rCD.toFixed(3)}, AD/XA ${rAD.toFixed(3)}. D completes at ${px(D.price)}. These ratios have no mechanism behind them — the record is the only argument for trading it.`,
        shapes
      });
      break;
    }
  }
  out.sort((x, y) => y.to - x.to);
  return out.slice(0, maxResults).sort((x, y) => x.to - y.to);
}
const DEFAULTS = { bandAtr: 0.75, minSources: 3, freshBars: 200, maxResults: 4 };
const REDUNDANT = [
  ["order-block", "fvg"],
  ["order-block", "mitigation"],
  ["breaker", "order-block"],
  ["range", "session-range"],
  ["range", "opening-range"],
  ["poc", "value-area"],
  ["bos", "choch"],
  ["equal-highs", "level"],
  ["equal-lows", "level"],
  ["liquidity-sweep", "spring"],
  ["liquidity-sweep", "upthrust"],
  ["failed-break", "retest"],
  ["prior-level", "pivot-level"]
];
const redundantWith = (a, b) => REDUNDANT.some(([x, y]) => x === a && y === b || x === b && y === a);
function priceOf(d) {
  for (const s of d.shapes) {
    if (s.type === "level") return s.y;
  }
  for (const s of d.shapes) {
    if (s.type === "box") return (s.y0 + s.y1) / 2;
  }
  for (const s of d.shapes) {
    if (s.type === "line") return s.y1;
  }
  for (const s of d.shapes) {
    if (s.type === "marker") return s.y;
  }
  return null;
}
function band(members, tol) {
  const sorted = [...members].sort((a, b) => a.price - b.price);
  const out = [];
  let current = [];
  for (const m of sorted) {
    const anchor = current[0];
    if (!anchor || m.price - anchor.price <= tol) current.push(m);
    else {
      out.push(current);
      current = [m];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}
function independentKinds(members) {
  const seen = [];
  for (const m of [...members].sort((a, b) => b.confidence - a.confidence)) {
    if (seen.includes(m.kind)) continue;
    if (seen.some((k) => redundantWith(k, m.kind))) continue;
    seen.push(m.kind);
  }
  return seen;
}
function detectConfluence(data, found, opts = {}, len = data.c.length) {
  const bandAtr = opts.bandAtr ?? DEFAULTS.bandAtr;
  const minSources = opts.minSources ?? DEFAULTS.minSources;
  const freshBars = opts.freshBars ?? DEFAULTS.freshBars;
  const maxResults = opts.maxResults ?? DEFAULTS.maxResults;
  if (len < 20) return [];
  const a = atr(data.h, data.l, data.c, 14, len);
  const unit2 = a[len - 1];
  if (!Number.isFinite(unit2) || unit2 <= 0) return [];
  const tol = unit2 * bandAtr;
  const members = [];
  for (const d of found) {
    if (d.kind === "confluence") continue;
    if (d.to < len - freshBars) continue;
    const price = priceOf(d);
    if (price === null || !Number.isFinite(price)) continue;
    members.push({
      kind: d.kind,
      label: d.label,
      price,
      direction: d.direction,
      confidence: d.confidence
    });
  }
  if (members.length < minSources) return [];
  const out = [];
  for (const group of band(members, tol)) {
    const kinds = independentKinds(group);
    if (kinds.length < minSources) continue;
    const prices = group.map((m) => m.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const mid = (lo + hi) / 2;
    const named = [];
    for (const k of kinds) {
      const best = group.filter((m) => m.kind === k).sort((x, y) => y.confidence - x.confidence)[0];
      if (best) named.push(best);
    }
    const longs = named.filter((m) => m.direction === "long");
    const shorts = named.filter((m) => m.direction === "short");
    const disagrees = longs.length > 0 && shorts.length > 0;
    const direction = disagrees ? "neutral" : longs.length > 0 ? "long" : shorts.length > 0 ? "short" : "neutral";
    const list = named.map((m) => m.label).join(", ");
    const width = hi - lo;
    const shapes = [
      {
        type: "box",
        x0: Math.max(0, len - 60),
        x1: len - 1,
        y0: lo === hi ? lo - tol * 0.15 : lo,
        y1: lo === hi ? hi + tol * 0.15 : hi,
        tone: direction === "long" ? "bull" : direction === "short" ? "bear" : "accent",
        extend: true,
        label: `${kinds.length} sources`
      },
      { type: "level", x0: Math.max(0, len - 60), y: mid, tone: "accent", label: px(mid), dashed: true }
    ];
    out.push({
      id: `confluence-${mid.toFixed(6)}`,
      kind: "confluence",
      label: disagrees ? `${kinds.length} sources, disagreeing` : `${kinds.length} sources agree`,
      direction,
      from: Math.min(...group.map(() => Math.max(0, len - freshBars))),
      to: len - 1,
      /**
       * Rises with independent sources and with their own confidences, and
       * SATURATES well short of 1.
       *
       * The first version was `0.12 * (kinds.length - minSources)`, unbounded,
       * and on the first live run an eight-source band reached 1.15 and
       * clamped to exactly 1.0 — a certainty, published by the one detector in
       * this directory whose header says at length that it does not score.
       * The fifth agreeing detector is worth less than the fourth, and no
       * number of them is worth certainty.
       *
       * It remains a display weight for drawing order. See the header for why
       * it is not offered anywhere a rule could be built on it.
       */
      confidence: clamp01(
        0.3 + 0.25 * clamp01((kinds.length - minSources) / 4) + 0.2 * mean(named.map((m) => m.confidence))
      ),
      reason: `${kinds.length} independent detectors land between ${px(lo)} and ${px(hi)}` + (width > 0 ? ` (${(width / unit2).toFixed(2)} ATR wide)` : "") + `: ${list}. ` + (disagrees ? `They do not agree on a side — ${longs.length} long, ${shorts.length} short — and that disagreement is the finding. It is not averaged into a lean.` : direction === "neutral" ? `All of them are levels rather than signals, so this band has no side.` : `All of the directional ones point ${direction}.`) + ` Redundant pairs are counted once; there is deliberately no confluence score.`,
      shapes
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out.slice(0, maxResults);
}
const mean = (xs) => xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length;
const DETECTORS = [
  {
    id: "structure",
    label: "Structure",
    blurb: "Break of structure and change of character, confirmed on close",
    family: "structure",
    defaultOn: true,
    run: (d, len) => detectStructure(d, {}, len)
  },
  {
    id: "levels",
    label: "S/R levels",
    blurb: "Horizontal levels where two or more swings clustered",
    family: "levels",
    defaultOn: true,
    run: (d, len) => detectLevels(d, {}, len)
  },
  {
    id: "fvg",
    label: "Fair value gaps",
    blurb: "Three-bar imbalances price left untraded, unmitigated only",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectFVG(d, {}, len)
  },
  {
    id: "order-blocks",
    label: "Order blocks",
    blurb: "Last opposing candle before a displacement move",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectOrderBlocks(d, {}, len)
  },
  {
    id: "doubles",
    label: "Double top/bottom",
    blurb: "Twin extremes confirmed by a close through the neckline",
    family: "shape",
    run: (d, len) => detectDoubles(d, {}, len)
  },
  {
    id: "head-shoulders",
    label: "Head & shoulders",
    blurb: "Five-pivot reversal confirmed on the neckline break",
    family: "shape",
    run: (d, len) => detectHeadShoulders(d, {}, len)
  },
  {
    id: "trendlines",
    label: "Trendlines",
    blurb: "Lines touching three or more swings — two points is not a trendline",
    family: "shape",
    run: (d, len) => detectTrendlines(d, {}, len)
  },
  {
    id: "divergence",
    label: "Divergence",
    blurb: "Price and RSI disagreeing across consecutive swings",
    family: "shape",
    run: (d, len) => detectDivergence(d, {}, len)
  },
  /* v49 — liquidity and context.
     The eight above all describe a SHAPE price traced out. These describe what
     was resting where, what got taken, and what condition the market is in,
     which is a different question and the one most of a session is spent in. */
  {
    id: "sweeps",
    label: "Liquidity sweeps",
    blurb: "A level taken on the wick and reclaimed on the close — with the stop attached",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectSweeps(d, {}, len)
  },
  {
    id: "pools",
    label: "Equal highs / lows",
    blurb: "Two or more swings at one price — where the stops are resting",
    family: "liquidity",
    run: (d, len) => detectPools(d, {}, len)
  },
  {
    id: "breakers",
    label: "Breaker blocks",
    blurb: "An order block that failed and flipped side",
    family: "liquidity",
    run: (d, len) => detectBreakers(d, {}, len)
  },
  {
    id: "ranges",
    label: "Ranges",
    blurb: "Sideways stretches, and the bar that leaves them",
    family: "structure",
    defaultOn: true,
    run: (d, len) => detectRanges(d, {}, len)
  },
  {
    id: "sessions",
    label: "Session ranges",
    blurb: "Asia, London and New York highs and lows. Nothing above 4h",
    family: "time",
    run: (d, len) => detectSessionRanges(d, {}, len)
  },
  /* ── v54 ─────────────────────────────────────────────────────────────── */
  {
    id: "candles",
    label: "Candle patterns",
    blurb: "Engulfings, pins, inside bars and stars — only where they sit on a level",
    family: "shape",
    run: (d, len) => detectCandles(d, {}, len)
  },
  {
    id: "wedges",
    label: "Wedges & triangles",
    blurb: "Two boundaries at once: wedges, triangles, channels and flags, with the break",
    family: "shape",
    run: (d, len) => detectWedges(d, {}, len)
  },
  {
    id: "profile",
    label: "Volume profile levels",
    blurb: "Point of control, value area and low-volume nodes. Nothing without volume",
    family: "volume",
    run: (d, len) => detectProfile(d, {}, len)
  },
  {
    id: "volume-events",
    label: "Volume climax",
    blurb: "Bars in the top 2% of this window's volume, with the side they closed",
    family: "volume",
    run: (d, len) => detectVolumeClimax(d, {}, len)
  },
  {
    id: "squeeze",
    label: "Squeeze",
    blurb: "Bollinger inside Keltner, and the bar the compression releases on",
    family: "volume",
    run: (d, len) => detectSqueeze(d, {}, len)
  },
  {
    id: "gaps",
    label: "Gaps",
    blurb: "Prices that were never offered, with whether they have been filled",
    family: "volume",
    run: (d, len) => detectGaps(d, {}, len)
  },
  {
    id: "round-numbers",
    label: "Round numbers",
    blurb: "The coarsest round ladder wider than 2 ATR, with its measured touch count",
    family: "levels",
    run: (d, len) => detectRoundNumbers(d, {}, len)
  },
  {
    id: "fibs",
    label: "Retracement & OTE",
    blurb: "Fib levels auto-anchored to the last completed leg, with premium/discount",
    family: "levels",
    run: (d, len) => detectFibs(d, {}, len)
  },
  {
    id: "pivot-points",
    label: "Floor pivots",
    blurb: "Classic PP, R1/R2 and S1/S2 from the previous session",
    family: "levels",
    run: (d, len) => detectPivotPoints(d, {}, len)
  },
  {
    id: "prior-levels",
    label: "Prior day / week",
    blurb: "Yesterday's and last week's high and low, and whether they have been taken",
    family: "levels",
    defaultOn: true,
    run: (d, len) => detectPriorLevels(d, {}, len)
  },
  {
    id: "avwap",
    label: "Anchored VWAP",
    blurb: "VWAP from the last swing high and low — where everyone since is on average",
    family: "volume",
    run: (d, len) => detectAnchoredVwap(d, {}, len)
  },
  {
    id: "wyckoff",
    label: "Springs & upthrusts",
    blurb: "A range boundary broken and then reclaimed on the close",
    family: "liquidity",
    defaultOn: true,
    run: (d, len) => detectSprings(d, {}, len)
  },
  {
    id: "failures",
    label: "Failed breaks & retests",
    blurb: "Structure breaks that did not hold, and the ones that did — the same population, split",
    family: "liquidity",
    run: (d, len) => [...detectFailedBreaks(d, {}, len), ...detectMitigation(d, {}, len)]
  },
  {
    id: "killzones",
    label: "Killzones & opening range",
    blurb: "Session-open windows, each carrying its measured share of the day's travel",
    family: "time",
    run: (d, len) => [...detectKillzones(d, {}, len), ...detectOpeningRange(d, {}, len)]
  },
  {
    id: "harmonics",
    label: "Harmonic patterns",
    blurb: "Gartley, bat, butterfly and crab. No mechanism — the record is the only argument",
    family: "shape",
    run: (d, len) => detectHarmonics(d, {}, len)
  },
  {
    id: "confluence",
    label: "Confluence bands",
    blurb: "Where three or more independent detectors agree, published as one band",
    family: "structure",
    defaultOn: true,
    meta: (d, len, found) => detectConfluence(d, found, {}, len)
  }
];
const BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));
DETECTORS.filter((d) => d.defaultOn).map(
  (d) => d.id
);
const DETECTOR_FOR_KIND = {
  bos: "structure",
  choch: "structure",
  level: "levels",
  fvg: "fvg",
  "order-block": "order-blocks",
  "double-top": "doubles",
  "double-bottom": "doubles",
  "head-shoulders": "head-shoulders",
  trendline: "trendlines",
  divergence: "divergence",
  "equal-highs": "pools",
  "equal-lows": "pools",
  "liquidity-sweep": "sweeps",
  breaker: "breakers",
  range: "ranges",
  expansion: "ranges",
  "session-range": "sessions",
  engulfing: "candles",
  "pin-bar": "candles",
  "inside-bar": "candles",
  star: "candles",
  wedge: "wedges",
  triangle: "wedges",
  channel: "wedges",
  flag: "wedges",
  poc: "profile",
  "value-area": "profile",
  lvn: "profile",
  "volume-climax": "volume-events",
  squeeze: "squeeze",
  gap: "gaps",
  "round-level": "round-numbers",
  fib: "fibs",
  "pivot-level": "pivot-points",
  "prior-level": "prior-levels",
  avwap: "avwap",
  spring: "wyckoff",
  upthrust: "wyckoff",
  "failed-break": "failures",
  retest: "failures",
  mitigation: "failures",
  killzone: "killzones",
  "opening-range": "killzones",
  harmonic: "harmonics",
  confluence: "confluence"
};
function runDetectors(data, enabled, len = data.c.length) {
  const out = [];
  const metas = [];
  for (const id of enabled) {
    const meta = BY_ID.get(id);
    if (!meta) continue;
    if (meta.meta) {
      metas.push(meta);
      continue;
    }
    if (!meta.run) continue;
    try {
      out.push(...meta.run(data, len));
    } catch (err) {
      console.error(`[detect] ${id} failed`, err);
    }
  }
  const firstPass = [...out];
  for (const meta of metas) {
    try {
      out.push(...meta.meta(data, len, firstPass));
    } catch (err) {
      console.error(`[detect] ${meta.id} failed`, err);
    }
  }
  out.sort((a, b) => a.to - b.to);
  return out;
}
function toDetectInput(bars) {
  const n = bars.length;
  const out = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n)
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    out.t[i] = b.t;
    out.o[i] = b.o;
    out.h[i] = b.h;
    out.l[i] = b.l;
    out.c[i] = b.c;
    out.v[i] = b.v;
  }
  return out;
}
function tfMs(timeframe) {
  const n = parseInt(timeframe, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (timeframe.endsWith("M")) return 0;
  if (timeframe.endsWith("m")) return n * 6e4;
  if (timeframe.endsWith("h")) return n * 36e5;
  if (timeframe.endsWith("d")) return n * 864e5;
  if (timeframe.endsWith("w")) return n * 6048e5;
  return 0;
}
const EMPTY = {
  bars: {
    t: new Float64Array(0),
    o: new Float64Array(0),
    h: new Float64Array(0),
    l: new Float64Array(0),
    c: new Float64Array(0),
    v: new Float64Array(0)
  },
  openIndex: [],
  closeIndex: []
};
function ltfStep(data, n) {
  let step = Infinity;
  for (let i = 1; i < n; i++) {
    const d = data.t[i] - data.t[i - 1];
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 0;
}
function aggregate(data, htfMs, len = data.c.length) {
  const n = Math.min(len, data.c.length);
  if (htfMs <= 0 || n === 0) return EMPTY;
  const t = [];
  const o = [];
  const hi = [];
  const lo = [];
  const c = [];
  const v = [];
  const openIndex = [];
  const closeIndex = [];
  let bucket = NaN;
  for (let i = 0; i < n; i++) {
    const time = data.t[i];
    const b = Math.floor(time / htfMs) * htfMs;
    if (b !== bucket) {
      bucket = b;
      t.push(b);
      o.push(data.o[i]);
      hi.push(data.h[i]);
      lo.push(data.l[i]);
      c.push(data.c[i]);
      v.push(data.v[i]);
      openIndex.push(i);
      closeIndex.push(i);
      continue;
    }
    const k = t.length - 1;
    hi[k] = Math.max(hi[k], data.h[i]);
    lo[k] = Math.min(lo[k], data.l[i]);
    c[k] = data.c[i];
    v[k] = v[k] + data.v[i];
    closeIndex[k] = i;
  }
  const step = ltfStep(data, n);
  const dropAt = (k) => {
    t.splice(k, 1);
    o.splice(k, 1);
    hi.splice(k, 1);
    lo.splice(k, 1);
    c.splice(k, 1);
    v.splice(k, 1);
    openIndex.splice(k, 1);
    closeIndex.splice(k, 1);
  };
  const lastK = t.length - 1;
  if (lastK >= 0) {
    const open = t[lastK];
    const lastBarTime = data.t[closeIndex[lastK]];
    if (lastBarTime + step < open + htfMs) dropAt(lastK);
  }
  if (t.length > 0) {
    const open = t[0];
    const firstBarTime = data.t[openIndex[0]];
    if (firstBarTime > open) dropAt(0);
  }
  return {
    bars: {
      t: Float64Array.from(t),
      o: Float64Array.from(o),
      h: Float64Array.from(hi),
      l: Float64Array.from(lo),
      c: Float64Array.from(c),
      v: Float64Array.from(v)
    },
    openIndex,
    closeIndex
  };
}
function projectX(x, agg) {
  const last = agg.openIndex.length - 1;
  if (last < 0) return 0;
  const i = Math.max(0, Math.min(last, Math.floor(x)));
  const open = agg.openIndex[i];
  const close = agg.closeIndex[i];
  const frac = x - i;
  if (frac <= 0) return open;
  const width = close - open + 1;
  return open + frac * width;
}
function projectShape(shape, agg) {
  switch (shape.type) {
    case "box":
      return { ...shape, x0: projectX(shape.x0, agg), x1: projectX(shape.x1, agg) };
    case "line":
      return { ...shape, x0: projectX(shape.x0, agg), x1: projectX(shape.x1, agg) };
    case "level":
      return { ...shape, x0: projectX(shape.x0, agg) };
    case "marker":
      return { ...shape, x: projectX(shape.x, agg) };
  }
}
function detectHigher(data, htfLabel, enabled, len = data.c.length) {
  const htfMs = tfMs(htfLabel);
  if (htfMs <= 0 || enabled.length === 0) return [];
  const agg = aggregate(data, htfMs, len);
  if (agg.bars.c.length < 30) return [];
  const found = runDetectors(agg.bars, enabled, agg.bars.c.length);
  return found.map((d) => ({
    ...d,
    id: `${htfLabel}:${d.id}`,
    timeframe: htfLabel,
    // The label carries the timeframe because a 4h break of structure and a 1h
    // one are different claims, and a list that shows both without saying which
    // is which is worse than showing neither.
    label: `${htfLabel.toUpperCase()} · ${d.label}`,
    from: agg.openIndex[Math.min(d.from, agg.openIndex.length - 1)] ?? 0,
    // THE LOOK-AHEAD GUARANTEE. Knowable when the higher-timeframe bar CLOSED.
    to: agg.closeIndex[Math.min(d.to, agg.closeIndex.length - 1)] ?? 0,
    reason: `${d.reason} (on the ${htfLabel} timeframe)`,
    shapes: d.shapes.map((sh) => projectShape(sh, agg))
  }));
}
function primaryShape(shapes) {
  for (const s of shapes) if (s.type === "line") return s;
  for (const s of shapes) if (s.type === "box") return s;
  for (const s of shapes) if (s.type === "level") return s;
  return null;
}
function pick(band2, edge) {
  switch (edge) {
    case "top":
      return { lo: band2.hi, hi: band2.hi };
    case "bottom":
      return { lo: band2.lo, hi: band2.lo };
    case "mid": {
      const m = (band2.lo + band2.hi) / 2;
      return { lo: m, hi: m };
    }
    case "band":
      return band2;
  }
}
function shapeAt(shape, i) {
  switch (shape.type) {
    case "level":
      return i >= shape.x0 ? { lo: shape.y, hi: shape.y } : null;
    case "line": {
      if (i < shape.x0) return null;
      const span = shape.x1 - shape.x0;
      if (span === 0) return { lo: shape.y0, hi: shape.y0 };
      const y = shape.y0 + (shape.y1 - shape.y0) * (i - shape.x0) / span;
      return { lo: y, hi: y };
    }
    case "box": {
      if (i < shape.x0) return null;
      if (!shape.extend && i > shape.x1) return null;
      const lo = Math.min(shape.y0, shape.y1);
      const hi = Math.max(shape.y0, shape.y1);
      return { lo, hi };
    }
    case "marker":
      return null;
  }
}
function findAnchorDetection(anchor, data, detections) {
  for (const d of detections) {
    if (d.kind !== anchor.detKind) continue;
    const t = data.t[d.from];
    if (t === void 0) continue;
    if (t === anchor.fromTime) return d;
  }
  return null;
}
function resolveAnchor(anchor, data, detections) {
  if (anchor.kind === "price") {
    const band2 = { lo: anchor.price, hi: anchor.price };
    return {
      ok: true,
      anchor: {
        at: () => band2,
        // A typed price is knowable from bar zero; nothing about it was learned
        // from the chart, so there is no hindsight to guard against.
        validFrom: 0,
        isBand: false,
        label: `price ${anchor.price}`
      }
    };
  }
  const det = findAnchorDetection(anchor, data, detections);
  if (!det) {
    return {
      ok: false,
      reason: `${anchor.label} is no longer detected — invalidated, mitigated, or scrolled out of range`
    };
  }
  const shape = primaryShape(det.shapes);
  if (!shape) {
    return { ok: false, reason: `${det.label} has no geometry an alert can watch` };
  }
  const raw = shapeAt(shape, det.to);
  const isBand = anchor.edge === "band" && raw !== null && raw.lo !== raw.hi;
  return {
    ok: true,
    anchor: {
      at: (i) => {
        const b = shapeAt(shape, i);
        return b === null ? null : pick(b, anchor.edge);
      },
      // The bar the structure completed on. Everything at or before it is
      // hindsight as far as this alert is concerned.
      validFrom: det.to + 1,
      isBand,
      label: det.label
    }
  };
}
function sideOf(close, band2) {
  if (close > band2.hi) return "above";
  if (close < band2.lo) return "below";
  return "inside";
}
function fmt(v) {
  const abs = Math.abs(v);
  return v.toFixed(abs >= 1e3 ? 2 : abs >= 1 ? 4 : 6);
}
function satisfied(cond, prev, cur) {
  switch (cond) {
    // "inside" counts as not-yet-above, so a close that starts on the line and
    // then clears it is a genuine cross rather than a missed one.
    case "cross-above":
      return prev !== "above" && cur === "above";
    case "cross-below":
      return prev !== "below" && cur === "below";
    case "cross-any":
      return prev !== "above" && cur === "above" || prev !== "below" && cur === "below";
    case "enter":
      return prev !== "inside" && cur === "inside";
    case "exit":
      return prev === "inside" && cur !== "inside";
    case "touch":
      return false;
  }
}
function reasonFor(cond, label, price, anchorPrice) {
  const at = `${label} at ${fmt(anchorPrice)}`;
  switch (cond) {
    case "cross-above":
      return `Closed ${fmt(price)}, above ${at}`;
    case "cross-below":
      return `Closed ${fmt(price)}, below ${at}`;
    case "cross-any":
      return `Closed ${fmt(price)}, through ${at}`;
    case "enter":
      return `Closed ${fmt(price)}, inside ${label}`;
    case "exit":
      return `Closed ${fmt(price)}, out of ${label}`;
    case "touch":
      return `Wick reached ${fmt(anchorPrice)} on ${label} — not confirmed by a close`;
  }
}
function evaluateAlert(spec, data, anchor, opts) {
  const out = [];
  const end = Math.min(opts.closedCount, data.c.length);
  const seed = Math.max(0, anchor.validFrom - 1);
  const since = opts.since ?? 0;
  let prev = null;
  let lastFire = -Infinity;
  let touching = false;
  for (let i = seed; i < end; i++) {
    const mayFire = i >= anchor.validFrom;
    const band2 = anchor.at(i);
    if (band2 === null) {
      prev = null;
      touching = false;
      continue;
    }
    const close = data.c[i];
    if (spec.condition === "touch") {
      const hi = data.h[i];
      const lo = data.l[i];
      const hit = hi >= band2.lo && lo <= band2.hi;
      const fires = mayFire && hit && !touching && i - lastFire >= spec.cooldownBars;
      touching = hit;
      if (!fires) continue;
      lastFire = i;
      if (i >= since) {
        const reached = hi >= band2.lo && hi <= band2.hi ? hi : lo;
        out.push({
          alertId: spec.id,
          index: i,
          time: data.t[i],
          price: reached,
          anchorPrice: (band2.lo + band2.hi) / 2,
          reason: reasonFor("touch", anchor.label, reached, (band2.lo + band2.hi) / 2)
        });
      }
      if (spec.once) break;
      continue;
    }
    const cur = sideOf(close, band2);
    if (prev === null) {
      prev = cur;
      continue;
    }
    if (mayFire && satisfied(spec.condition, prev, cur) && i - lastFire >= spec.cooldownBars) {
      lastFire = i;
      if (i >= since) {
        const anchorPrice = cur === "above" ? band2.hi : cur === "below" ? band2.lo : (band2.lo + band2.hi) / 2;
        out.push({
          alertId: spec.id,
          index: i,
          time: data.t[i],
          price: close,
          anchorPrice,
          reason: reasonFor(spec.condition, anchor.label, close, anchorPrice)
        });
      }
      prev = cur;
      if (spec.once) break;
      continue;
    }
    prev = cur;
  }
  return out;
}
function neededFor(specs) {
  const detectors = /* @__PURE__ */ new Set();
  const higher = /* @__PURE__ */ new Set();
  for (const s of specs) {
    if (!s.enabled) continue;
    if (s.anchor.kind !== "detection") continue;
    detectors.add(DETECTOR_FOR_KIND[s.anchor.detKind]);
    if (s.timeframeAnchor) higher.add(s.timeframeAnchor);
  }
  return { detectors: [...detectors], higher: [...higher] };
}
function evaluateBook(bars, specs, opts = {}) {
  const closedBars = Math.max(0, bars.length - (opts.includesFormingBar === false ? 0 : 1));
  const empty = { fires: [], orphaned: [], closedBars, detectors: [] };
  if (closedBars < 30 || specs.length === 0) return empty;
  const { detectors, higher } = neededFor(specs);
  const data = toDetectInput(bars.slice(0, closedBars));
  const detections = detectors.length > 0 ? runDetectors(data, detectors) : [];
  for (const tf of higher) {
    if (tfMs(tf) > 0) detections.push(...detectHigher(data, tf, detectors));
  }
  const fires = [];
  const orphaned = [];
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const res = resolveAnchor(spec.anchor, data, detections);
    if (!res.ok) {
      orphaned.push({ id: spec.id, reason: res.reason });
      continue;
    }
    fires.push(...evaluateAlert(spec, data, res.anchor, { closedCount: closedBars }));
  }
  return { fires, orphaned, closedBars, detectors };
}
function freshFires(fires, seen) {
  const next = { ...seen };
  const fresh = [];
  for (const f of fires) {
    const bucket = next[f.alertId] ?? [];
    if (bucket.includes(f.time)) continue;
    next[f.alertId] = [...bucket, f.time].slice(-500);
    fresh.push(f);
  }
  return { fresh, seen: next };
}
function makeBookFile(alerts, now) {
  return { version: 40, exportedAt: now, alerts: [...alerts] };
}
function readBookFile(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
  const doc = raw;
  if (doc.version !== 40) {
    return { ok: false, error: `alert book version ${String(doc.version)} — this build reads version 40` };
  }
  if (!Array.isArray(doc.alerts)) return { ok: false, error: "no alerts array" };
  const alerts = doc.alerts.filter(
    (a) => !!a && typeof a === "object" && typeof a.id === "string" && !!a.anchor && !!a.condition
  );
  return { ok: true, alerts };
}
export {
  evaluateBook,
  freshFires,
  makeBookFile,
  readBookFile
};
