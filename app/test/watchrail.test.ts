// @vitest-environment jsdom
/**
 * The watchlist rail: pure helpers with literal expectations, then the DOM.
 * Every expected value below is written out, never derived from the code under
 * test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeText,
  createWatchRail,
  liveSetupCount,
  quoteFailure,
  rowQuote,
  sparkPath,
  sparkTone,
  type QuoteSnapshot,
  type WatchSetup,
} from "../src/ui/watchrail";
import { reactionCount, signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { RateLimited, type UniverseEntry } from "../src/scan/scanner";

const entry = (symbol: string, lastPrice: number, changePct: number): UniverseEntry => ({
  symbol,
  lastPrice,
  changePct,
  quoteVolume: 1e6,
});

describe("sparkPath", () => {
  it("scales closes into the box, high at the top", () => {
    expect(sparkPath([1, 3, 2], 10, 10, 1)).toBe("M0 9 L5 1 L10 5");
  });
  it("draws a flat series at mid height", () => {
    expect(sparkPath([5, 5, 5], 10, 10, 1)).toBe("M0 5 L5 5 L10 5");
  });
  it("refuses fewer than two finite points rather than inventing a line", () => {
    expect(sparkPath([])).toBe("");
    expect(sparkPath([4])).toBe("");
    expect(sparkPath([4, Number.NaN])).toBe("");
  });
  it("skips non-finite closes", () => {
    expect(sparkPath([1, Number.NaN, 3], 10, 10, 1)).toBe("M0 9 L10 1");
  });
  it("rounds to one decimal", () => {
    expect(sparkPath([0, 1, 2, 3], 10, 10, 0)).toBe("M0 10 L3.3 6.7 L6.7 3.3 L10 0");
  });
});

describe("sparkTone", () => {
  it("compares the first and last finite close", () => {
    expect(sparkTone([1, 5, 2])).toBe("pos");
    expect(sparkTone([3, 5, 2])).toBe("neg");
    expect(sparkTone([2, 5, 2])).toBe("flat");
    expect(sparkTone([2])).toBe("flat");
  });
});

describe("changeText", () => {
  it("signs and colours by direction", () => {
    expect(changeText(1.234)).toEqual({ text: "+1.23%", tone: "pos" });
    expect(changeText(-0.5)).toEqual({ text: "-0.50%", tone: "neg" });
    expect(changeText(0)).toEqual({ text: "+0.00%", tone: "flat" });
    expect(changeText(Number.NaN)).toEqual({ text: "—", tone: "" });
  });
});

describe("liveSetupCount", () => {
  const setups = new Map<string, WatchSetup>([
    ["BTCUSDT", { label: "Long · armed", direction: "long", live: true }],
    ["ETHUSDT", { label: "No setup", direction: "long", live: false }],
    ["SOLUSDT", { label: "Short · armed", direction: "short", live: true }],
  ]);
  it("counts live setups on the list only, once per symbol", () => {
    expect(liveSetupCount(["BTCUSDT", "ETHUSDT", "BTCUSDT"], setups)).toBe(1);
    expect(liveSetupCount(["BTCUSDT", "SOLUSDT", "XRPUSDT"], setups)).toBe(2);
    expect(liveSetupCount(["XRPUSDT"], setups)).toBe(0);
    expect(liveSetupCount(["BTCUSDT"], undefined)).toBe(0);
  });
});

describe("rowQuote", () => {
  const rows = new Map([["BTCUSDT", entry("BTCUSDT", 100, 2)]]);
  it("is loading before any snapshot", () => {
    expect(rowQuote("BTCUSDT", { rows: null, at: 0, loading: true, error: "" }, 0)).toEqual({ kind: "loading" });
  });
  it("is failed, with the reason, when the first snapshot failed", () => {
    expect(rowQuote("BTCUSDT", { rows: null, at: 0, loading: false, error: "down" }, 0)).toEqual({
      kind: "failed",
      reason: "down",
    });
  });
  it("says no quote for a symbol the snapshot does not carry", () => {
    const q = rowQuote("AAPL", { rows, at: 1000, loading: false, error: "" }, 1000);
    expect(q.kind).toBe("none");
  });
  it("keeps the old snapshot on a failed refresh and says how old", () => {
    const snap: QuoteSnapshot = { rows, at: 1_000, loading: false, error: "down." };
    expect(rowQuote("BTCUSDT", snap, 31_000)).toEqual({
      kind: "quote",
      entry: entry("BTCUSDT", 100, 2),
      stale: "down. Showing the snapshot from 30s ago.",
    });
  });
});

describe("quoteFailure", () => {
  it("words failures for the operator", () => {
    expect(quoteFailure(new RateLimited(5000))).toBe("Binance is rate-limiting this terminal; the rail will retry.");
    expect(quoteFailure(new TypeError("Failed to fetch"))).toBe("Binance could not be reached from here.");
    expect(quoteFailure(new Error("binance 500"))).toBe("Binance did not return a usable price snapshot.");
  });
});

// -------------------------------------------------------------------- DOM ---

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushFrames();
};

describe("createWatchRail", () => {
  let destroy: (() => void) | null = null;
  afterEach(() => {
    destroy?.();
    destroy = null;
    vi.restoreAllMocks();
  });

  const mount = (over: Partial<Parameters<typeof createWatchRail>[0]> = {}) => {
    const symbols = signal<readonly string[]>(["BTCUSDT", "AAPL"]);
    const active = signal("BTCUSDT");
    const picked: string[] = [];
    const rail = createWatchRail({
      symbols,
      active,
      onPick: (s) => picked.push(s),
      loadQuotes: async () => [entry("BTCUSDT", 65000, 1.5)],
      loadCloses: async () => [1, 2, 3],
      refreshMs: 60_000,
      ...over,
    });
    destroy = rail.destroy;
    document.body.appendChild(rail.el);
    return { rail, symbols, active, picked };
  };

  const row = (el: HTMLElement, sym: string): HTMLButtonElement =>
    el.querySelector(`.wr-row[data-symbol="${sym}"]`) as HTMLButtonElement;

  it("renders prices, refuses what it cannot price, and marks the active row", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rail } = mount();
    await settle();
    const btc = row(rail.el, "BTCUSDT");
    expect(btc.tagName).toBe("BUTTON");
    expect(btc.querySelector(".wr-px")?.textContent).toBe((65000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(btc.querySelector(".wr-chg")?.textContent).toBe("+1.50%");
    expect(btc.dataset["tone"]).toBe("pos");
    expect(btc.dataset["active"]).toBe("true");
    expect(btc.getAttribute("aria-current")).toBe("true");
    expect(btc.querySelector("path")?.getAttribute("d")).toBe("M0 17 L24 9 L48 1");

    const aapl = row(rail.el, "AAPL");
    expect(aapl.querySelector(".wr-px")?.textContent).toBe("no quote");
    expect(aapl.dataset["state"]).toBe("none");
    expect(aapl.title).toContain("Binance has no 24h ticker for AAPL");
    expect(aapl.querySelector("path")?.hasAttribute("d")).toBe(false);
  });

  it("picks on click", async () => {
    const { rail, picked } = mount();
    await settle();
    row(rail.el, "AAPL").click();
    expect(picked).toEqual(["AAPL"]);
  });

  it("shows loading, then failed with a reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let reject: (e: unknown) => void = () => undefined;
    const { rail } = mount({ loadQuotes: () => new Promise((_, rej) => (reject = rej)) });
    expect(row(rail.el, "BTCUSDT").querySelector(".wr-px")?.textContent).toBe("loading…");
    reject(new TypeError("Failed to fetch"));
    await settle();
    const btc = row(rail.el, "BTCUSDT");
    expect(btc.dataset["state"]).toBe("failed");
    expect(btc.title).toContain("Binance could not be reached from here.");
  });

  it("counts live setups and shows the setup line", async () => {
    const setups = signal<ReadonlyMap<string, WatchSetup>>(
      new Map([["BTCUSDT", { label: "Long · armed", direction: "long", live: true }]]),
    );
    const { rail } = mount({ setups });
    await settle();
    expect(rail.el.querySelector(".wr-count")?.textContent).toBe("1 live");
    expect(row(rail.el, "BTCUSDT").querySelector(".wr-setup")?.textContent).toBe("Long · armed");
    expect(row(rail.el, "AAPL").querySelector(".wr-setup")?.textContent).toBe("");
  });

  it("invites rather than blanks on an empty list, and keeps row nodes across updates", async () => {
    const { rail, symbols, active } = mount();
    await settle();
    const before = row(rail.el, "BTCUSDT");
    active.set("AAPL");
    await settle();
    expect(row(rail.el, "BTCUSDT")).toBe(before);
    expect(before.dataset["active"]).toBe("false");
    symbols.set([]);
    await settle();
    const empty = rail.el.querySelector(".wr-empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("Add symbols from Opportunities or with the palette.");
    expect(rail.el.querySelectorAll(".wr-row").length).toBe(0);
  });

  it("releases every reaction on destroy", async () => {
    const base = reactionCount();
    const { rail } = mount();
    await settle();
    expect(reactionCount()).toBeGreaterThan(base);
    rail.destroy();
    destroy = null;
    expect(reactionCount()).toBe(base);
  });
});
