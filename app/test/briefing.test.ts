/**
 * The Briefing's "where you stand" rules.
 *
 * WHAT IS AND IS NOT COVERED HERE, STATED RATHER THAN IMPLIED
 * The desk is mostly composition — it takes the Setup card's own view model,
 * the alert store's own log and the live engine's own events and puts them on
 * screen — and a test of that would only assert that `h()` appends children.
 * What is NOT composition is `standingRows`, which decides which
 * qualifications appear on the one figure on this desk that could get somebody
 * hurt: how much is at risk right now.
 *
 * Every expected value below is a literal. None of it is produced by calling
 * the code under test, which is how `expect(reason).toContain(QUANT_BASE)`
 * came to pass for months on a URL that could never resolve.
 */

import { describe, expect, it } from "vitest";
import { standingRows } from "../src/ui/briefing";
import type { Account } from "../src/core/account";
import type { HeatResult } from "../src/risk/sizing";

const ACCOUNT: Account = {
  currency: "USD",
  balance: 10_000,
  equity: 10_000,
  leverage: 100,
  riskPct: 1,
};

function heat(patch: Partial<HeatResult> = {}): HeatResult {
  return {
    heatPct: 1.5,
    openRisk: 150,
    grossNotional: 5_000,
    netNotional: 5_000,
    unprotected: [],
    measured: true,
    secured: [],
    bySymbol: [],
    warnings: [],
    ...patch,
  };
}

const labels = (rows: readonly { label: string }[]): string[] => rows.map((r) => r.label);

describe("standingRows", () => {
  it("says nothing is at risk when the book is empty, and shows no heat", () => {
    const rows = standingRows(ACCOUNT, heat({ heatPct: 0, openRisk: 0 }), 0, 0);
    expect(labels(rows)).toEqual(["Equity", "Open positions"]);
    expect(rows[1]?.note).toBe("No open positions — the figures below are what-ifs.");
  });

  it("states the money at stake beside the percentage", () => {
    const rows = standingRows(ACCOUNT, heat(), 2, 0);
    const risk = rows.find((r) => r.label === "At risk now");
    expect(risk?.value).toBe("1.50% of equity");
    expect(risk?.note).toBe("150 USD if every stop is hit.");
  });

  it("refuses a percentage when equity is not a usable number", () => {
    const rows = standingRows(ACCOUNT, heat({ measured: false }), 1, 0);
    const risk = rows.find((r) => r.label === "At risk now");
    expect(risk?.value).toBe("not measurable");
    expect(risk?.note).toBe(
      "Account equity is not set, so percentages can't be shown.",
    );
    expect(risk?.tone).toBeUndefined();
  });

  /**
   * The one that matters most.
   *
   * A position with no stop contributes NOTHING to `openRisk` — `portfolioHeat`
   * cannot price an unbounded loss, so it lists the symbol instead. A briefing
   * that printed the percentage without that qualification would be reporting a
   * smaller number than the truth, in the calmest possible voice.
   */
  it("says the figure understates when a position carries no stop", () => {
    const rows = standingRows(ACCOUNT, heat({ unprotected: ["ETHUSDT"] }), 2, 0);
    const row = rows.find((r) => r.label === "No stop");
    expect(row?.value).toBe("ETHUSDT");
    expect(row?.note).toBe(
      "Some positions have no stop — real risk is HIGHER than shown.",
    );
    expect(row?.tone).toBe("neg");
  });

  it("names positions whose stop is already past entry", () => {
    const rows = standingRows(ACCOUNT, heat({ secured: ["BTCUSDT"] }), 1, 0);
    const row = rows.find((r) => r.label === "Stop past entry");
    expect(row?.value).toBe("BTCUSDT");
    expect(row?.tone).toBe("pos");
  });

  /**
   * The threshold is the OPERATOR's own per-trade risk, three times over —
   * not an absolute percentage this file invented. An account set to risk 5%
   * a trade is not in trouble at 4% total heat, and one set to risk 0.25% is.
   */
  it("tones heat against the account's own per-trade risk, not an absolute", () => {
    const loose = { ...ACCOUNT, riskPct: 5 };
    expect(standingRows(loose, heat({ heatPct: 4 }), 1, 0).find((r) => r.label === "At risk now")?.tone)
      .toBeUndefined();

    const tight = { ...ACCOUNT, riskPct: 0.25 };
    expect(standingRows(tight, heat({ heatPct: 4 }), 1, 0).find((r) => r.label === "At risk now")?.tone)
      .toBe("neg");
  });

  it("does not tone heat that is merely large when the account allows it", () => {
    const rows = standingRows({ ...ACCOUNT, riskPct: 2 }, heat({ heatPct: 5.9 }), 3, 0);
    expect(rows.find((r) => r.label === "At risk now")?.tone).toBeUndefined();
  });

  it("says the account is provisional while a migration disagreement is unresolved", () => {
    const rows = standingRows(ACCOUNT, heat({ heatPct: 0, openRisk: 0 }), 0, 1);
    const row = rows.find((r) => r.label === "Account");
    expect(row?.value).toBe("provisional");
    expect(row?.tone).toBe("attn");
  });

  it("omits the account row when there is nothing unresolved", () => {
    const rows = standingRows(ACCOUNT, heat(), 1, 0);
    expect(labels(rows)).not.toContain("Account");
  });
});
