/**
 * The AI's related-asset proposals (`study/related.ts`).
 *
 * What is pinned here is what would make the proposals DISHONEST if it broke:
 * a pick with no reason, a pick nothing can load (v5x measured DXY and US10Y
 * returning no bars from any source, in a live study), a reason that claims a
 * direction, and an operator's removal being quietly undone.
 */

import { describe, expect, it } from "vitest";
import {
  canLoad,
  chosenPicks,
  LOADABLE_ALIAS,
  proposeRelated,
  relatedRows,
  sourceOf,
  type RelatedProposal,
} from "../src/study/related";
import { newStudy, relatedContext } from "../src/study/spec";

const symbols = (p: RelatedProposal): string[] => p.picks.map((x) => x.symbol);

describe("proposeRelated — per asset class", () => {
  it("crypto major (BTC): dollar, yield, equities, gold and ether, under loadable tickers", () => {
    const p = proposeRelated("BTCUSDT");
    expect(p.family).toBe("crypto-major");
    expect(symbols(p)).toEqual(["DX-Y.NYB", "^TNX", "SPX500", "XAUUSD", "ETHUSDT"]);
  });

  it("crypto major (ETH): adds BTC as a possible leader, which the driver map lacks", () => {
    const p = proposeRelated("ETHUSDT");
    const btc = p.picks.find((x) => x.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc?.driverRole).toBe("lead");
    expect(symbols(p)).not.toContain("ETHUSDT");
  });

  it("crypto alt: BTC and ETH lead", () => {
    const p = proposeRelated("SOLUSDT");
    expect(p.family).toBe("crypto-alt");
    const leads = p.picks.filter((x) => x.driverRole === "lead").map((x) => x.symbol);
    expect(leads).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("metals: dollar, 10-year yield and silver — and says the real yield is missing", () => {
    const p = proposeRelated("XAUUSD");
    expect(p.family).toBe("gold");
    expect(symbols(p)).toEqual(expect.arrayContaining(["DX-Y.NYB", "^TNX", "XAGUSD"]));
    expect(p.picks.find((x) => x.symbol === "^TNX")?.reason).toContain("nominal");
    expect(p.withheld.map((w) => w.label)).toContain("US 10-year real yield");
  });

  it("FX majors: dollar index and rates, and names the rate gap it cannot build", () => {
    const p = proposeRelated("EURUSD");
    expect(p.family).toBe("fx-major");
    expect(symbols(p)).toEqual(expect.arrayContaining(["DX-Y.NYB", "^TNX"]));
    expect(p.withheld.some((w) => w.label.includes("rate differential"))).toBe(true);
  });

  it("indices: the volatility index and the other index, never itself", () => {
    const spx = proposeRelated("SPX500");
    expect(symbols(spx)).toEqual(expect.arrayContaining(["^VIX", "NAS100"]));
    expect(symbols(spx)).not.toContain("SPX500");
    const ndx = proposeRelated("NAS100");
    expect(symbols(ndx)).toEqual(expect.arrayContaining(["^VIX", "SPX500"]));
    expect(symbols(ndx)).not.toContain("NAS100");
  });

  it("an unknown symbol gets nothing — no guessed driver set", () => {
    const p = proposeRelated("ZZTOP");
    expect(p.family).toBeNull();
    expect(p.picks).toHaveLength(0);
    expect(p.intro).toContain("adds nothing rather than guess");
  });
});

describe("proposeRelated — reasons", () => {
  const subjects = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUUSD", "EURUSD", "USDJPY", "SPX500", "NAS100"];

  it("every pick has a short reason and a full why", () => {
    for (const s of subjects) {
      for (const pick of proposeRelated(s).picks) {
        expect(pick.reason.trim().length, `${s} → ${pick.symbol}`).toBeGreaterThan(5);
        expect(pick.why.trim().length, `${s} → ${pick.symbol}`).toBeGreaterThan(pick.reason.length);
        expect(pick.why).toContain("Bars from");
      }
    }
  });

  it("no reason claims a direction — that is measured, never typed in", () => {
    const directional = /\b(against it|inverse|falls when|rises when|usually moves|tends to (rise|fall)|weighs? on)\b/i;
    for (const s of subjects) {
      for (const pick of proposeRelated(s).picks) {
        expect(pick.reason, `${s} → ${pick.symbol}`).not.toMatch(directional);
      }
    }
  });

  it("an aliased pick says what it replaced and why", () => {
    const dollar = proposeRelated("BTCUSDT").picks.find((x) => x.symbol === "DX-Y.NYB");
    expect(dollar?.why).toContain("404");
  });
});

describe("proposeRelated — only what can load", () => {
  it("never proposes the tickers measured to return nothing", () => {
    for (const s of ["BTCUSDT", "XAUUSD", "EURUSD", "SPX500", "USOIL"]) {
      const syms = symbols(proposeRelated(s));
      expect(syms).not.toContain("DXY");
      expect(syms).not.toContain("US10Y");
    }
    expect(Object.keys(LOADABLE_ALIAS)).toEqual(["DXY", "US10Y"]);
  });

  it("every default pick has a known source", () => {
    for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUUSD", "EURUSD", "SPX500"]) {
      for (const pick of proposeRelated(s).picks) expect(canLoad(pick.symbol), pick.symbol).toBe(true);
    }
  });

  it("a symbol the injected source cannot serve is withheld with its reason, not proposed", () => {
    const p = proposeRelated("BTCUSDT", { loadable: (sym) => sym !== "^TNX" });
    expect(symbols(p)).not.toContain("^TNX");
    const w = p.withheld.find((x) => x.symbol === "^TNX");
    expect(w?.reason).toContain("left out");
  });

  it("sourceOf routes crypto to Binance and the rest to the proxy, and knows nothing else", () => {
    expect(sourceOf("SOLUSDT")).toBe("Binance");
    expect(sourceOf("EURUSD")).toContain("proxy");
    expect(sourceOf("DXY")).toBeNull();
    expect(sourceOf("US10Y")).toBeNull();
  });
});

describe("relatedRows — the operator's removals and additions", () => {
  const p = proposeRelated("BTCUSDT");
  const ctx = relatedContext("BTCUSDT", p.picks);

  it("everything is on when the study holds every pick", () => {
    expect(relatedRows(p, ctx).every((r) => r.on && r.who === "ai")).toBe(true);
  });

  it("a removed pick stays listed, OFF — the absence is the memory", () => {
    const rows = relatedRows(p, ctx.filter((c) => c.symbol !== "SPX500"));
    const spx = rows.find((r) => r.symbol === "SPX500");
    expect(spx?.on).toBe(false);
    expect(spx?.who).toBe("ai");
    expect(rows.filter((r) => r.on)).toHaveLength(p.picks.length - 1);
  });

  it("the operator's own addition is tagged You and says when nothing is known to serve it", () => {
    const rows = relatedRows(p, [...ctx, { symbol: "NAS100", label: "NAS100", why: "" }, { symbol: "FOOBAR", label: "FOOBAR", why: "" }]);
    const nas = rows.find((r) => r.symbol === "NAS100");
    const foo = rows.find((r) => r.symbol === "FOOBAR");
    expect(nas).toMatchObject({ who: "you", on: true, reason: "Added by you" });
    expect(foo?.reason).toContain("no known source");
    expect(foo?.why).toContain("No mechanism is stated");
  });

  it("chosenPicks drops what the operator removed, case-insensitively", () => {
    const kept = chosenPicks(p, new Set(["spx500", "XAUUSD"]));
    expect(kept.map((k) => k.symbol)).not.toContain("SPX500");
    expect(kept.map((k) => k.symbol)).not.toContain("XAUUSD");
    expect(kept).toHaveLength(p.picks.length - 2);
  });
});

describe("newStudy seeds from the proposal", () => {
  it("uses loadable tickers, with the role translation unchanged", () => {
    const s = newStudy("s1", "BTCUSDT", "1h", 0);
    const bySym = new Map(s.context.map((c) => [c.symbol, c.role]));
    expect(bySym.has("DXY")).toBe(false);
    expect(bySym.get("^TNX")).toBe("driver");
    expect(bySym.get("DX-Y.NYB")).toBe("regime");
    expect(bySym.get("ETHUSDT")).toBe("peer");
  });
});
