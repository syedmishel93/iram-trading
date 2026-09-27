import { describe, expect, it } from "vitest";
import { allDetectorIds, detectSummary } from "../src/ui/detectpanel";
import { quoteAsset, quoteTier } from "../src/data/catalogue";

describe("quoteAsset", () => {
  it("names the quote currency of a normal pair", () => {
    expect(quoteAsset("BTCUSDT")).toBe("USDT");
    expect(quoteAsset("ETHBTC")).toBe("BTC");
    expect(quoteAsset("SOLUSDC")).toBe("USDC");
  });

  it("prefers the LONGEST matching suffix", () => {
    /* The whole subtlety. `USDCUSDT` ends in both "USDT" and — if the shorter
       suffixes were tested first — could be read as quoted in USDC. Sorting the
       candidates by length makes the answer independent of the order the tier
       lists happen to be written in. */
    expect(quoteAsset("USDCUSDT")).toBe("USDT");
    expect(quoteAsset("BTCUSDC")).toBe("USDC");
  });

  it("returns null for an instrument quoted in nothing it knows", () => {
    /* XAUUSD and EURUSD come from the MT5 bridge and are real instruments this
       terminal quotes. They belong under "Other", not under an invented group.
       Note USD is a tier-1 suffix, so these DO match — the null case is a
       symbol with no recognised quote at all. */
    expect(quoteAsset("SOMETHING")).toBeNull();
    expect(quoteAsset("USDT")).toBeNull(); // the quote alone is not a pair
  });

  it("agrees with quoteTier about what is dollar-quoted", () => {
    for (const s of ["BTCUSDT", "ETHUSDC", "XAUUSD"]) {
      expect(quoteTier(s)).toBe(0);
      expect(quoteAsset(s)).not.toBeNull();
    }
  });
});

describe("detectSummary", () => {
  it("says nothing is being looked for when every detector is off", () => {
    expect(detectSummary(0, 0, 0)).toContain("No detectors on");
  });

  it("distinguishes 'nothing found' from 'not looking'", () => {
    /* Two different facts, and collapsing them is how someone concludes the
       market is quiet when in fact the detectors are switched off. */
    expect(detectSummary(3, 0, 0)).toContain("Nothing detected");
    expect(detectSummary(3, 0, 0)).not.toContain("No detectors");
  });

  it("NAMES the gap when the chart is showing fewer than were found", () => {
    /* A chart drawing 6 of 31 structures under a panel that says "31 found" is
       a chart you will misread. */
    const line = detectSummary(3, 31, 6);
    expect(line).toContain("31 found");
    expect(line).toContain("6 drawn");
  });

  it("does not claim a gap when everything found is drawn", () => {
    expect(detectSummary(3, 4, 4)).toBe("4 structures drawn.");
    expect(detectSummary(3, 1, 1)).toBe("1 structure drawn.");
  });
});

describe("allDetectorIds", () => {
  it("returns every id, not a curated subset", () => {
    /* A control labelled All that turned on five of eight would be this module
       quietly having an opinion about which structures matter. */
    const set = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
    expect(allDetectorIds(set)).toEqual(["a", "b", "c"]);
  });
});
