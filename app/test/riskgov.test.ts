// @vitest-environment jsdom
/**
 * The risk governor client and the "Can I trade now?" card.
 *
 * The fixture is the body `/svc/risk/state` returned from the running service
 * with MT5 offline, completed field by field from `server/svc/risk.py`
 * (`svc_risk_state`, `risk_state`) and `server/mishel_risk.py`
 * (`compute_state`, `evaluate`, `DEFAULTS`). Every expected value is written
 * by hand from that fixture, never read back from the code under test, and the
 * URL is checked by parsing what `fetch` was actually called with.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGov, parseGov, type GovState } from "../src/data/riskgov";
import { createGovCard, govHeadline, govRows, govShortReason } from "../src/ui/cards/govcard";

const BLIND_ERR =
  "MT5 bridge unreachable (HTTPConnectionPool(host='127.0.0.1', port=8787): Max retries exceeded) — open positions are UNKNOWN, not zero";

const CONFIG = {
  block_when_unprotected: true,
  consecutive_loss_limit: 3,
  cooldown_minutes: 60,
  day_reset_hour_utc: 0,
  max_concentration_R: 2.0,
  max_daily_loss_R: 2.0,
  max_open_risk_R: 3.0,
  max_risk_per_trade_pct: 1.0,
  max_trades_per_day: 5,
};

const STATE = {
  concentration: { R: 0.0, currency: null, net: {}, unmapped: [] },
  consecutive_losses: 0,
  day_start_ms: 1789948800000,
  equity: 0.0,
  equity_source: "none",
  graded_today: 0,
  last_loss_ms: null,
  now_ms: 1789992049058,
  open_positions: [],
  open_risk_R: 0.0,
  position_source_error: BLIND_ERR,
  realized_R_today: 0,
  trades_today: 0,
  ungraded_today: 0,
  unprotected: [],
};

/** The real offline body: verdict WARN from rule "blind", twice. */
const REAL = {
  ok: true,
  config: CONFIG,
  state: STATE,
  verdict: {
    verdict: "warn",
    reasons: [
      {
        level: "warn",
        rule: "blind",
        msg: `OPEN POSITIONS UNKNOWN — ${BLIND_ERR}. Open risk and currency concentration are NOT being checked right now. This is not an all-clear; it is a blind spot.`,
      },
      {
        level: "warn",
        rule: "blind",
        msg: "No account equity — position sizes cannot be checked against a real balance. Connect the MT5 bridge, or set your real balance in Settings.",
      },
    ],
    concentration: { R: 0.0, currency: null, net: {}, unmapped: [] },
    open_risk_R: 0.0,
    would_be_risk_R: 0.0,
    realized_R_today: 0,
    consecutive_losses: 0,
    config: CONFIG,
  },
};

/** The same body with the broker readable and a healthy book. */
const withState = (st: Record<string, unknown>, verdict: Record<string, unknown>): unknown => ({
  ...REAL,
  state: { ...STATE, position_source_error: null, equity: 10_000, equity_source: "MT5 bridge", ...st },
  verdict: { ...REAL.verdict, ...verdict },
});

const must = (body: unknown): GovState => {
  const g = parseGov(body);
  if (g === null) throw new Error("fixture did not parse");
  return g;
};

describe("parseGov", () => {
  it("reads the real offline body", () => {
    const g = must(REAL);
    expect(g.verdict).toBe("warn");
    expect(g.reasons).toHaveLength(2);
    expect(g.reasons[0]?.rule).toBe("blind");
    expect(g.limits).toEqual({
      maxOpenRiskR: 3,
      maxDailyLossR: 2,
      maxTradesPerDay: 5,
      consecutiveLossLimit: 3,
      cooldownMinutes: 60,
      maxConcentrationR: 2,
      maxRiskPerTradePct: 1,
    });
    expect(g.tradesToday).toBe(0);
    expect(g.consecutiveLosses).toBe(0);
    expect(g.equitySource).toBe("none");
  });

  it("makes open risk UNKNOWN, not zero, when the book could not be read", () => {
    const g = must(REAL);
    expect(g.openRiskR).toBeNull();
    expect(g.positionSourceError).toBe(BLIND_ERR);
    const open = govRows(g).find((r) => r.label === "Open risk");
    expect(open?.value).toBe("unknown / 3 R");
    expect(open?.tone).toBe("attn");
  });

  it("keeps a real zero when the book WAS read", () => {
    const g = must(withState({}, { verdict: "allow", reasons: [{ level: "allow", rule: "ok", msg: "Within every limit you set." }] }));
    expect(g.openRiskR).toBe(0);
    expect(govRows(g).find((r) => r.label === "Open risk")?.value).toBe("0.00 / 3 R");
  });

  it("labels open risk a floor when a position's risk is not counted", () => {
    const g = must(
      withState(
        { open_risk_R: 0.5, open_positions: [{ symbol: "EURUSD", side: "long", risk_R: 0.5, sl: 1.1, risk_unknown: false }, { symbol: "XAUUSD", side: "long", risk_R: null, sl: 2300, risk_unknown: true }] },
        { verdict: "warn", reasons: [{ level: "warn", rule: "blind", msg: "XAUUSD has a stop, but no contract spec — its risk in R is UNKNOWN." }] },
      ),
    );
    expect(g.openRiskIsFloor).toBe(true);
    expect(govRows(g).find((r) => r.label === "Open risk")?.value).toBe("≥ 0.50 / 3 R");
    expect(govShortReason(g.reasons[0]!, g)).toBe("XAUUSD: risk unknown, not counted");
  });

  it("refuses a malformed body rather than filling zeros in", () => {
    expect(parseGov(null)).toBeNull();
    expect(parseGov("<html>")).toBeNull();
    expect(parseGov({ ok: false, err: "boom" })).toBeNull();
    expect(parseGov({ ...REAL, verdict: { ...REAL.verdict, verdict: "maybe" } })).toBeNull();
    const { max_daily_loss_R: _dropped, ...noDaily } = CONFIG;
    expect(parseGov({ ...REAL, config: noDaily, verdict: { ...REAL.verdict, config: noDaily } })).toBeNull();
    const { trades_today: _t, ...noTrades } = STATE;
    expect(parseGov({ ...REAL, state: noTrades })).toBeNull();
    expect(parseGov({ ...REAL, verdict: { ...REAL.verdict, reasons: [{ level: "warn" }] } })).toBeNull();
  });
});

describe("govHeadline", () => {
  it("allow: yes, in pos", () => {
    const g = must(withState({}, { verdict: "allow", reasons: [{ level: "allow", rule: "ok", msg: "Within every limit you set." }] }));
    expect(govHeadline({ state: "ok", value: g })).toEqual({ text: "Yes — within your limits", tone: "pos" });
  });

  it("warn: counts the warnings, in attn", () => {
    expect(govHeadline({ state: "ok", value: must(REAL) })).toEqual({ text: "Careful — 2 warnings", tone: "attn" });
  });

  it("block: no, with the first BLOCK reason in plain words", () => {
    const g = must(
      withState(
        { realized_R_today: -2.1, trades_today: 5 },
        {
          verdict: "block",
          reasons: [
            { level: "block", rule: "daily_loss", msg: "DAY IS DONE: -2.10R realized today, limit -2.00R. The next trade is not a setup, it is a refund request." },
            { level: "block", rule: "trade_count", msg: "5 trades today (limit 5). Past this point you are not trading, you are clicking." },
          ],
        },
      ),
    );
    expect(govHeadline({ state: "ok", value: g })).toEqual({ text: "No — daily loss limit hit: −2.10R of −2R", tone: "neg" });
    const rows = govRows(g);
    expect(rows.find((r) => r.label === "Today")).toMatchObject({ value: "−2.10 / −2 R", tone: "neg" });
    expect(rows.find((r) => r.label === "Trades today")).toMatchObject({ value: "5 / 5", tone: "neg" });
  });

  it("offline: never a green answer", () => {
    const h = govHeadline({ state: "offline", reason: "down" });
    expect(h.text).toBe("The risk service is not answering.");
    expect(h.tone).not.toBe("pos");
  });

  it("short reasons are one plain line, not the server's capitals", () => {
    const g = must(REAL);
    expect(g.reasons.map((r) => govShortReason(r, g))).toEqual([
      "open positions unknown — broker not reachable",
      "no account balance to check sizes against",
    ]);
  });
});

describe("loadGov", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks /svc/risk/state", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { status: 200, ok: true, json: async () => REAL } as Response;
    });
    const r = await loadGov();
    expect(new URL(seen[0] ?? "").pathname).toBe("/svc/risk/state");
    expect(r.state).toBe("ok");
  });

  it("reports an unreachable service as OFFLINE", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await loadGov();
    expect(r.state).toBe("offline");
  });

  it("reports an HTML 404 as OFFLINE, not as a verdict", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 404, ok: false, json: async () => { throw new SyntaxError("Unexpected token <"); } }) as unknown as Response);
    expect((await loadGov()).state).toBe("offline");
  });
});

describe("createGovCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the verdict, the rows and one Why? per reason", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200, ok: true, json: async () => REAL }) as Response);
    const card = createGovCard();
    await vi.waitFor(() => expect(card.el.querySelector(".gov-head")?.textContent).toBe("Careful — 2 warnings"));
    expect(card.el.querySelector(".gov-head")?.getAttribute("data-tone")).toBe("attn");
    expect(card.el.textContent).toContain("unknown / 3 R");
    expect(card.el.querySelectorAll(".gov-reason .pk-why")).toHaveLength(2);
    expect(card.el.textContent).toContain("Limits: the server's risk governor");
  });

  it("shows the offline state, never a stale yes", async () => {
    let up = true;
    vi.stubGlobal("fetch", async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return { status: 200, ok: true, json: async () => withState({}, { verdict: "allow", reasons: [] }) } as Response;
    });
    const card = createGovCard();
    await vi.waitFor(() => expect(card.el.querySelector(".gov-head")?.textContent).toBe("Yes — within your limits"));
    up = false;
    card.refresh();
    await vi.waitFor(() => expect(card.el.querySelector(".gov-head")?.textContent).toBe("The risk service is not answering."));
    expect(card.el.textContent).not.toContain("Yes");
  });
});
