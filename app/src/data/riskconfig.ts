/**
 * The risk governor's LIMITS: read them, and write the three the day's plan sets.
 *
 * `server/svc/risk.py` `svc_risk_config` serves `/svc/risk/config`:
 *   GET  -> `{ok: true, config: risk_cfg(), defaults: RISK.DEFAULTS}`
 *   POST -> writes every key of the JSON body that is ALSO a key of
 *           `mishel_risk.DEFAULTS` into the `risk_cfg` table, ignores the rest,
 *           and answers `{ok: true, config: risk_cfg()}`.
 * `risk_cfg()` is `DEFAULTS` overlaid with the table, so `config` always holds
 * every limit. The three this module handles are the ones a morning plan sets:
 * `max_trades_per_day`, `max_daily_loss_R` and `max_risk_per_trade_pct`.
 * `/svc/risk/state` evaluates against the same table, which is why a commit
 * here is enforced and not merely remembered.
 *
 * HONESTY
 * - A body missing any of the three parses to null. A default shown as the
 *   operator's own limit would be a fabricated setting.
 * - A POST is reported as saved only when the config the server sends BACK
 *   holds the values that were sent. The server silently drops unknown keys,
 *   so an older build that renamed one would otherwise answer `ok: true` and
 *   enforce nothing.
 * - `max_daily_loss_R` is a positive number on the server (the governor
 *   compares realised R against `-abs(...)`), and is kept positive here.
 */

import { serviceBase } from "./backend";

/** The three limits the day's plan sets. */
export interface RiskLimits {
  /** `max_trades_per_day` — whole trades. */
  readonly maxTradesPerDay: number;
  /** `max_daily_loss_R` — positive; the governor stops the day at minus this. */
  readonly maxDailyLossR: number;
  /** `max_risk_per_trade_pct` — percent of equity. */
  readonly maxRiskPerTradePct: number;
}

export type RiskConfigResult =
  | { readonly state: "ok"; readonly limits: RiskLimits }
  | { readonly state: "offline"; readonly reason: string };

export const RISK_CONFIG_PATH = "/svc/risk/config";
export const RISK_CONFIG_TIMEOUT_MS = 8_000;

/**
 * The bounds a limit must sit inside. Wide on purpose — they catch a typo
 * (a risk of 100% for 1.00, a loss limit of 0), not the operator's style.
 */
export const LIMIT_BOUNDS = {
  maxTradesPerDay: { min: 1, max: 50 },
  maxDailyLossR: { min: 0.25, max: 20 },
  maxRiskPerTradePct: { min: 0.01, max: 10 },
} as const;

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The three limits out of a `/svc/risk/config` body. PURE.
 * Null when the body is not the service's shape or any of the three is missing.
 */
export function parseRiskConfig(body: unknown): RiskLimits | null {
  if (!isObj(body) || body["ok"] !== true || !isObj(body["config"])) return null;
  const c = body["config"];
  const trades = num(c["max_trades_per_day"]);
  const loss = num(c["max_daily_loss_R"]);
  const risk = num(c["max_risk_per_trade_pct"]);
  if (trades === null || loss === null || risk === null) return null;
  return { maxTradesPerDay: trades, maxDailyLossR: Math.abs(loss), maxRiskPerTradePct: risk };
}

/** The POST body for a set of limits — the server's own key names. PURE. */
export function riskConfigBody(l: RiskLimits): Record<string, number> {
  return {
    max_trades_per_day: l.maxTradesPerDay,
    max_daily_loss_R: l.maxDailyLossR,
    max_risk_per_trade_pct: l.maxRiskPerTradePct,
  };
}

/** What the operator typed, before it is a number. */
export interface LimitsInput {
  readonly maxTradesPerDay: string;
  readonly maxDailyLossR: string;
  readonly maxRiskPerTradePct: string;
}

export type LimitField = keyof RiskLimits;

export type LimitsCheck =
  | { readonly ok: true; readonly limits: RiskLimits }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<LimitField, string>>> };

/**
 * Typed text to limits, or the reason per field. PURE.
 * Each message names the bound it broke, so the fix is in the sentence.
 */
export function validateLimits(input: LimitsInput): LimitsCheck {
  const errors: Partial<Record<LimitField, string>> = {};
  const read = (field: LimitField, raw: string, whole: boolean): number => {
    const b = LIMIT_BOUNDS[field];
    const t = raw.trim();
    const v = t === "" ? Number.NaN : Number(t);
    if (!Number.isFinite(v)) {
      errors[field] = "Enter a number.";
    } else if (whole && !Number.isInteger(v)) {
      errors[field] = "Whole trades only.";
    } else if (v < b.min || v > b.max) {
      errors[field] = `Between ${b.min} and ${b.max}.`;
    }
    return v;
  };
  const maxTradesPerDay = read("maxTradesPerDay", input.maxTradesPerDay, true);
  const maxDailyLossR = read("maxDailyLossR", input.maxDailyLossR, false);
  const maxRiskPerTradePct = read("maxRiskPerTradePct", input.maxRiskPerTradePct, false);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, limits: { maxTradesPerDay, maxDailyLossR, maxRiskPerTradePct } };
}

async function call(init?: RequestInit): Promise<{ ok: true; status: number; body: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RISK_CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}${RISK_CONFIG_PATH}`, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null; // an HTML error page: the shape check below refuses it
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    console.warn("[riskconfig] /svc/risk/config failed", err);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? `The risk service did not answer within ${Math.round(RISK_CONFIG_TIMEOUT_MS / 1000)}s.`
        : `The risk service is not answering at ${serviceBase()}. Start it with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The governor's current limits, or why they could not be read. */
export async function loadRiskConfig(): Promise<RiskConfigResult> {
  const r = await call();
  if (!r.ok) return { state: "offline", reason: r.reason };
  const limits = r.status < 400 ? parseRiskConfig(r.body) : null;
  if (limits === null) {
    console.warn("[riskconfig] GET answered without limits", r.status, r.body);
    return { state: "offline", reason: "The risk service answered, but not with its limits. It may be an older build." };
  }
  return { state: "ok", limits };
}

/**
 * Write the three limits. `ok` only when the server's answer holds them —
 * see the header for why an `ok: true` alone is not proof.
 */
export async function saveRiskConfig(limits: RiskLimits): Promise<RiskConfigResult> {
  const r = await call({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(riskConfigBody(limits)),
  });
  if (!r.ok) return { state: "offline", reason: r.reason };
  const back = r.status < 400 ? parseRiskConfig(r.body) : null;
  if (back === null) {
    console.warn("[riskconfig] POST answered without limits", r.status, r.body);
    return { state: "offline", reason: `The risk service did not confirm the limits (HTTP ${r.status}). Nothing is enforced.` };
  }
  if (
    back.maxTradesPerDay !== limits.maxTradesPerDay ||
    back.maxDailyLossR !== limits.maxDailyLossR ||
    back.maxRiskPerTradePct !== limits.maxRiskPerTradePct
  ) {
    return { state: "offline", reason: "The risk service answered with different limits than were sent. Check them on the Risk desk." };
  }
  return { state: "ok", limits: back };
}
