/**
 * Indicator parameters.
 *
 * WHAT THIS REVERSES, AND WHY THAT IS FINE
 * `studypanel.ts` used to say, in its own header, that it refused period
 * boxes: "a panel full of spinners invites tuning the indicator until the
 * chart agrees with you". That concern is real and it is not the same thing as
 * "nobody may change a period". A 14-period RSI on a 3-minute chart and a
 * 14-period RSI on a weekly are not the same instrument, every terminal worth
 * using lets you say so, and refusing to expose a number that `indicators.ts`
 * has always taken as an argument is not honesty — it is a missing feature
 * wearing honesty's coat.
 *
 * WHAT IS KEPT FROM THAT CONCERN
 * The published default is never lost. Every parameter carries the value its
 * definition specifies, `isDefault` can tell at any moment whether an
 * indicator is running standard settings, and anything that shows an indicator
 * — legend, panel, screenshot, backtest — can therefore say "tuned" out loud.
 * The failure the panel feared is not somebody changing a period; it is
 * somebody changing a period and then FORGETTING, and reading a tuned
 * indicator as a standard one. So the tuning is allowed and the forgetting is
 * made impossible.
 *
 * WHY VALUES ARE CLAMPED AND NEVER REJECTED
 * These are persisted. A build that narrows a range, or drops a parameter,
 * must not brick the panel for someone who saved a value under the old one —
 * the same rule `sanitiseOpen` and `runStudies` already follow. An unknown id
 * is dropped, an out-of-range number is pulled to the nearest legal value, and
 * a non-number falls back to the published default.
 *
 * WHY INTEGERS ARE ROUNDED RATHER THAN REFUSED
 * `rsi(close, 14.5)` does not throw. It runs, and it returns a series that is
 * subtly not an RSI. A period that indexes an array has to be an integer
 * before it reaches the arithmetic, so the coercion happens here, once,
 * instead of in fifteen indicator bodies.
 */

/** One tunable number on one indicator. */
export interface ParamDef {
  readonly id: string;
  readonly label: string;
  /** `int` is rounded before use; `float` is not. */
  readonly kind: "int" | "float";
  /** The value the published definition specifies. */
  readonly def: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** What moving it actually does. Shown under the control. */
  readonly hint?: string;
}

export type Params = Readonly<Record<string, number>>;

/**
 * Parameters per indicator id, matching the argument order in `indicators.ts`.
 *
 * Ranges are not taste. The minimum is the smallest value the arithmetic still
 * means something at — an RSI period of 1 is a sign function, a Bollinger
 * multiplier of 0 is the moving average — and the maximum is where the warm-up
 * would eat a normal window of bars.
 */
export const PARAMS: Readonly<Record<string, readonly ParamDef[]>> = {
  // ---------------------------------------------------------- overlays ---
  ichimoku: [
    { id: "conversion", label: "Conversion", kind: "int", def: 9, min: 2, max: 200, step: 1, hint: "Tenkan-sen. The fast line." },
    { id: "base", label: "Base", kind: "int", def: 26, min: 2, max: 400, step: 1, hint: "Kijun-sen, and the displacement of the cloud." },
    { id: "spanB", label: "Span B", kind: "int", def: 52, min: 2, max: 600, step: 1, hint: "The slow cloud edge." },
    { id: "displacement", label: "Displacement", kind: "int", def: 26, min: 1, max: 200, step: 1, hint: "How far the cloud and the lagging span are shifted." },
  ],
  keltner: [
    { id: "period", label: "Period", kind: "int", def: 20, min: 2, max: 400, step: 1 },
    { id: "mult", label: "ATR multiple", kind: "float", def: 2, min: 0.1, max: 10, step: 0.1, hint: "Band width, in ATRs of the same period." },
  ],
  bollinger: [
    { id: "period", label: "Period", kind: "int", def: 20, min: 2, max: 400, step: 1 },
    { id: "mult", label: "Std deviations", kind: "float", def: 2, min: 0.1, max: 10, step: 0.1 },
  ],
  donchian: [{ id: "period", label: "Period", kind: "int", def: 20, min: 2, max: 400, step: 1, hint: "Lookback for the highest high and lowest low." }],
  chandelier: [
    { id: "period", label: "Period", kind: "int", def: 22, min: 2, max: 400, step: 1 },
    { id: "mult", label: "ATR multiple", kind: "float", def: 3, min: 0.1, max: 10, step: 0.1, hint: "How far the trailing stop sits from the extreme." },
  ],
  /* All five, because all five are the indicator. A ribbon is read by whether
     the strands fan or tangle, and that is a property of the SPACING between
     them — exposing a "fast" and a "slow" and interpolating the rest would be
     inventing an indicator nobody published. */
  "ema-ribbon": [
    { id: "ema1", label: "EMA 1", kind: "int", def: 8, min: 2, max: 600, step: 1 },
    { id: "ema2", label: "EMA 2", kind: "int", def: 13, min: 2, max: 600, step: 1 },
    { id: "ema3", label: "EMA 3", kind: "int", def: 21, min: 2, max: 600, step: 1 },
    { id: "ema4", label: "EMA 4", kind: "int", def: 34, min: 2, max: 600, step: 1 },
    { id: "ema5", label: "EMA 5", kind: "int", def: 55, min: 2, max: 600, step: 1 },
  ],

  // ------------------------------------------------------------- panes ---
  rsi: [{ id: "period", label: "Period", kind: "int", def: 14, min: 2, max: 400, step: 1 }],
  macd: [
    { id: "fast", label: "Fast", kind: "int", def: 12, min: 2, max: 200, step: 1 },
    { id: "slow", label: "Slow", kind: "int", def: 26, min: 3, max: 400, step: 1 },
    { id: "signal", label: "Signal", kind: "int", def: 9, min: 1, max: 200, step: 1 },
  ],
  stoch: [
    { id: "period", label: "%K period", kind: "int", def: 14, min: 2, max: 400, step: 1 },
    { id: "smoothK", label: "%K smoothing", kind: "int", def: 3, min: 1, max: 100, step: 1 },
    { id: "smoothD", label: "%D smoothing", kind: "int", def: 3, min: 1, max: 100, step: 1 },
  ],
  adx: [{ id: "period", label: "Period", kind: "int", def: 14, min: 2, max: 400, step: 1 }],
  atr: [{ id: "period", label: "Period", kind: "int", def: 14, min: 2, max: 400, step: 1 }],
  mfi: [{ id: "period", label: "Period", kind: "int", def: 14, min: 2, max: 400, step: 1 }],
  cci: [{ id: "period", label: "Period", kind: "int", def: 20, min: 2, max: 400, step: 1 }],
  willr: [{ id: "period", label: "Period", kind: "int", def: 14, min: 2, max: 400, step: 1 }],
  roc: [{ id: "period", label: "Period", kind: "int", def: 12, min: 1, max: 400, step: 1 }],
};

/** Every indicator that has something to tune. */
export function hasParams(id: string): boolean {
  return (PARAMS[id]?.length ?? 0) > 0;
}

export function paramDefs(id: string): readonly ParamDef[] {
  return PARAMS[id] ?? [];
}

/** The published defaults, as a value object. */
export function defaults(id: string): Params {
  const out: Record<string, number> = {};
  for (const d of paramDefs(id)) out[d.id] = d.def;
  return out;
}

/**
 * Pull one value to the nearest legal one.
 *
 * ONLY a number or a non-empty string is treated as a value. `Number(null)` is
 * 0 and so is `Number("")` and `Number([])` — all finite, all of which would
 * have clamped to the MINIMUM rather than falling back to the published
 * default. A persisted null would have silently turned a 14-period RSI into a
 * 2-period one, which still draws a plausible-looking line.
 */
export function clampParam(def: ParamDef, raw: unknown): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return def.def;
  const bounded = Math.min(def.max, Math.max(def.min, n));
  return def.kind === "int" ? Math.round(bounded) : bounded;
}

/**
 * Clean a persisted parameter set.
 *
 * Unknown ids are dropped and missing ones fall back to the published default,
 * so the result is always complete and always legal — no call site has to
 * check whether a parameter it needs is present.
 */
export function sanitiseParams(id: string, saved: unknown): Params {
  const defs = paramDefs(id);
  if (defs.length === 0) return {};
  const src = (saved ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const d of defs) {
    out[d.id] = Object.prototype.hasOwnProperty.call(src, d.id)
      ? clampParam(d, src[d.id])
      : d.def;
  }
  return out;
}

/** Clean a whole persisted map of them. */
export function sanitiseAll(saved: unknown): Record<string, Params> {
  const out: Record<string, Params> = {};
  if (saved === null || typeof saved !== "object") return out;
  for (const [id, v] of Object.entries(saved as Record<string, unknown>)) {
    if (!hasParams(id)) continue;
    const p = sanitiseParams(id, v);
    /* Only store what actually differs. A map full of defaults is noise in the
       preferences blob and makes "has anything been tuned" a scan. */
    if (!isDefault(id, p)) out[id] = p;
  }
  return out;
}

/** Read one parameter, whatever the caller has (or has not) got. */
export function param(id: string, params: Params | undefined, key: string): number {
  const defs = paramDefs(id);
  const def = defs.find((d) => d.id === key);
  if (def === undefined) return NaN;
  return params === undefined ? def.def : clampParam(def, params[key]);
}

/** Is this indicator running the settings its definition specifies? */
export function isDefault(id: string, params: Params | undefined): boolean {
  if (params === undefined) return true;
  for (const d of paramDefs(id)) {
    if (clampParam(d, params[d.id]) !== d.def) return false;
  }
  return true;
}

/** Which parameters are off-default, by label. Empty when standard. */
export function tuned(id: string, params: Params | undefined): string[] {
  if (params === undefined) return [];
  return paramDefs(id)
    .filter((d) => clampParam(d, params[d.id]) !== d.def)
    .map((d) => d.label);
}

/**
 * A short settings string for a legend, e.g. `"14"` or `"20, 2.5"`.
 *
 * Values only, in declaration order — the same convention every charting
 * package uses, and the reason `PARAMS` is ordered to match the argument list
 * in `indicators.ts` rather than alphabetically.
 */
export function paramLabel(id: string, params: Params | undefined): string {
  const defs = paramDefs(id);
  if (defs.length === 0) return "";
  return defs
    .map((d) => {
      const v = params === undefined ? d.def : clampParam(d, params[d.id]);
      return d.kind === "int" ? String(v) : String(Number(v.toFixed(3)));
    })
    .join(", ");
}

/**
 * How many indicators are running non-standard settings.
 *
 * The number the panel prints. It exists so that "am I looking at a tuned
 * chart" is answerable without opening anything.
 */
export function tunedCount(all: Readonly<Record<string, Params>>): number {
  let n = 0;
  for (const [id, p] of Object.entries(all)) if (!isDefault(id, p)) n += 1;
  return n;
}
