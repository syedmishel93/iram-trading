/**
 * The server's risk governor: can a new trade be taken right now?
 *
 * `server/svc/risk.py` serves `GET /svc/risk/state`, which returns three
 * things side by side — `state` (from `mishel_risk.compute_state`, plus
 * `position_source_error` and `equity_source` added by `risk_state()`),
 * `config` (the limits, `mishel_risk.DEFAULTS` overlaid with the `risk_cfg`
 * table) and `verdict` (from `mishel_risk.evaluate(state, None, cfg)`). The
 * overall decision is `verdict.verdict`, one of the strings "allow" / "warn" /
 * "block" (`BLOCK, WARN, ALLOW` in `mishel_risk.py`), and every reason is
 * `{rule, level, msg}` with `level` drawn from the same three strings.
 *
 * Nothing in the frontend asked this question before this file.
 *
 * HONESTY, CARRIED THROUGH FROM THE SERVER
 * - When the bridge cannot read the book, `position_source_error` is set and
 *   `open_risk_R` is still 0.0 — because the server summed nothing. That zero
 *   is NOT a reading, so it is parsed to `openRiskR: null` here, once, and no
 *   caller can print it as "0.0R".
 * - A position whose risk in R is null (no stop, or no contract spec, or no
 *   equity) is skipped by `compute_state`'s sum. The total is then a FLOOR,
 *   and `openRiskIsFloor` says so.
 * - `realized_R_today` sums only GRADED trades; `ungraded_today` counts the
 *   rest, so the day's figure is labelled as leaving them out.
 * - A body missing any limit or counter parses to null rather than defaulting:
 *   a default limit shown as the operator's own limit would be fabricated.
 */

import { serviceBase } from "./backend";

export type GovLevel = "allow" | "warn" | "block";

/** One entry of `verdict.reasons`, exactly as `evaluate` builds it. */
export interface GovReason {
  /** `unprotected`, `daily_loss`, `cooldown`, `trade_count`, `open_risk`,
   *  `concentration`, `per_trade`, `coverage`, `blind`, `ok` — or a rule a
   *  newer server added, which is kept rather than dropped. */
  readonly rule: string;
  readonly level: GovLevel;
  readonly msg: string;
}

/** The limits, from the top-level `config` of the response. */
export interface GovLimits {
  readonly maxOpenRiskR: number; // max_open_risk_R
  readonly maxDailyLossR: number; // max_daily_loss_R (a positive number; the limit is its negative)
  readonly maxTradesPerDay: number; // max_trades_per_day
  readonly consecutiveLossLimit: number; // consecutive_loss_limit
  readonly cooldownMinutes: number; // cooldown_minutes
  readonly maxConcentrationR: number; // max_concentration_R
  readonly maxRiskPerTradePct: number; // max_risk_per_trade_pct
}

export interface GovState {
  /** `verdict.verdict` — the governor's own decision, never recomputed here. */
  readonly verdict: GovLevel;
  readonly reasons: readonly GovReason[];
  readonly limits: GovLimits;
  /** `state.open_risk_R`, or null when `position_source_error` is set: the
   *  server could not see the book, so its 0.0 is absence, not a value. */
  readonly openRiskR: number | null;
  /** True when at least one open position has `risk_R: null` and so is not in
   *  the sum — the figure is a lower bound. */
  readonly openRiskIsFloor: boolean;
  /** `state.position_source_error` — why the open book could not be read. */
  readonly positionSourceError: string | null;
  readonly realizedRToday: number; // state.realized_R_today (graded trades only)
  readonly tradesToday: number; // state.trades_today
  readonly ungradedToday: number; // state.ungraded_today
  readonly consecutiveLosses: number; // state.consecutive_losses
  readonly equity: number; // state.equity
  readonly equitySource: string; // state.equity_source
  /** Symbols of `state.unprotected` — open positions with no stop. */
  readonly unprotected: readonly string[];
  readonly nowMs: number | null; // state.now_ms
}

export type GovResult =
  | { readonly state: "ok"; readonly value: GovState }
  | { readonly state: "offline"; readonly reason: string };

export const GOV_TIMEOUT_MS = 10_000;

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isLevel = (v: unknown): v is GovLevel => v === "allow" || v === "warn" || v === "block";

function parseReasons(v: unknown): GovReason[] | null {
  if (!Array.isArray(v)) return null;
  const out: GovReason[] = [];
  for (const r of v) {
    if (!isObj(r) || !isLevel(r["level"]) || typeof r["msg"] !== "string") return null;
    out.push({ rule: typeof r["rule"] === "string" ? r["rule"] : "", level: r["level"], msg: r["msg"] });
  }
  return out;
}

function parseLimits(c: unknown): GovLimits | null {
  if (!isObj(c)) return null;
  const maxOpenRiskR = num(c["max_open_risk_R"]);
  const maxDailyLossR = num(c["max_daily_loss_R"]);
  const maxTradesPerDay = num(c["max_trades_per_day"]);
  const consecutiveLossLimit = num(c["consecutive_loss_limit"]);
  const cooldownMinutes = num(c["cooldown_minutes"]);
  const maxConcentrationR = num(c["max_concentration_R"]);
  const maxRiskPerTradePct = num(c["max_risk_per_trade_pct"]);
  if (
    maxOpenRiskR === null ||
    maxDailyLossR === null ||
    maxTradesPerDay === null ||
    consecutiveLossLimit === null ||
    cooldownMinutes === null ||
    maxConcentrationR === null ||
    maxRiskPerTradePct === null
  )
    return null;
  return {
    maxOpenRiskR,
    maxDailyLossR: Math.abs(maxDailyLossR),
    maxTradesPerDay,
    consecutiveLossLimit,
    cooldownMinutes,
    maxConcentrationR,
    maxRiskPerTradePct,
  };
}

/**
 * The `/svc/risk/state` body, typed. PURE. Null when the body is not the
 * governor's shape — any missing counter, limit or verdict refuses the whole
 * thing rather than filling a zero in.
 */
export function parseGov(body: unknown): GovState | null {
  if (!isObj(body) || body["ok"] !== true) return null;
  const st = body["state"];
  const vd = body["verdict"];
  if (!isObj(st) || !isObj(vd) || !isLevel(vd["verdict"])) return null;
  const reasons = parseReasons(vd["reasons"]);
  const limits = parseLimits(body["config"] ?? vd["config"]);
  if (reasons === null || limits === null) return null;

  const openRisk = num(st["open_risk_R"]);
  const realized = num(st["realized_R_today"]);
  const trades = num(st["trades_today"]);
  const losses = num(st["consecutive_losses"]);
  const equity = num(st["equity"]);
  if (openRisk === null || realized === null || trades === null || losses === null || equity === null) return null;

  const err = st["position_source_error"];
  const positionSourceError = typeof err === "string" && err !== "" ? err : null;
  const positions = Array.isArray(st["open_positions"]) ? st["open_positions"] : [];
  const unprot = Array.isArray(st["unprotected"]) ? st["unprotected"] : [];

  return {
    verdict: vd["verdict"],
    reasons,
    limits,
    openRiskR: positionSourceError === null ? openRisk : null,
    openRiskIsFloor: positions.some((p) => isObj(p) && num(p["risk_R"]) === null),
    positionSourceError,
    realizedRToday: realized,
    tradesToday: trades,
    ungradedToday: num(st["ungraded_today"]) ?? 0,
    consecutiveLosses: losses,
    equity,
    equitySource: typeof st["equity_source"] === "string" ? st["equity_source"] : "none",
    unprotected: unprot.map((p) => (isObj(p) && typeof p["symbol"] === "string" ? p["symbol"] : "?")),
    nowMs: num(st["now_ms"]),
  };
}

/** Ask the governor. Offline — never a verdict — when it cannot be asked. */
export async function loadGov(): Promise<GovResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOV_TIMEOUT_MS);
  try {
    const res = await fetch(`${serviceBase()}/svc/risk/state`, { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const value = res.ok ? parseGov(body) : null;
    if (value === null) {
      console.warn("[riskgov] /svc/risk/state answered without a verdict", res.status, body);
      return { state: "offline", reason: "The risk service answered, but not with a verdict. It may be an older build." };
    }
    return { state: "ok", value };
  } catch (err) {
    console.warn("[riskgov] /svc/risk/state failed", err);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      state: "offline",
      reason: aborted
        ? `The risk service did not answer within ${Math.round(GOV_TIMEOUT_MS / 1000)}s.`
        : `The risk service is not answering at ${serviceBase()}. Start it with: python run.py`,
    };
  } finally {
    clearTimeout(timer);
  }
}
