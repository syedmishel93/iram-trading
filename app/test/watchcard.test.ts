// @vitest-environment jsdom
/**
 * The watchlist card: the same list and the same snapshot wording as the rail.
 * Expected values are written out, never derived from the code under test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createWatchCard, watchRowText, WATCH_CARD_ROWS } from "../src/ui/cards/watchcard";
import type { QuoteSnapshot } from "../src/ui/watchrail";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import type { UniverseEntry } from "../src/scan/scanner";

const entry = (symbol: string, lastPrice: number, changePct: number): UniverseEntry => ({
  symbol,
  lastPrice,
  changePct,
  quoteVolume: 1e6,
});

const loaded = (rows: UniverseEntry[], error = ""): QuoteSnapshot => ({
  rows: new Map(rows.map((r) => [r.symbol, r])),
  at: 1_000,
  loading: false,
  error,
});
const notYet: QuoteSnapshot = { rows: null, at: 0, loading: true, error: "" };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushFrames();
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.textContent = "";
});

describe("watchRowText", () => {
  it("prints a dash, never zero, before the snapshot arrives", () => {
    expect(watchRowText("BTCUSDT", notYet, 0)).toEqual({ px: "—", chg: "—", tone: "", note: "Price not loaded yet." });
  });
  it("prints a dash with the reason for a symbol Binance cannot price", () => {
    expect(watchRowText("AAPL", loaded([]), 0)).toEqual({
      px: "—",
      chg: "—",
      tone: "",
      note: "Binance has no 24h ticker for AAPL, so the rail cannot price it.",
    });
  });
  it("prints the price and a signed change with its tone", () => {
    const t = watchRowText("ETHUSDT", loaded([entry("ETHUSDT", 3000, -1.25)]), 0);
    expect(t.chg).toBe("-1.25%");
    expect(t.tone).toBe("neg");
    expect(t.px).toBe((3000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  });
});

describe("createWatchCard", () => {
  const base = (symbols: readonly string[], quotes: QuoteSnapshot) => {
    const picked: string[] = [];
    let opened = 0;
    const sym = signal<readonly string[]>(symbols);
    const q = signal<QuoteSnapshot>(quotes);
    const el = createWatchCard({
      current: () => "ETHUSDT",
      onSelect: (s) => picked.push(s),
      onOpenDesk: () => opened++,
      symbols: sym,
      quotes: q,
    });
    return { el, picked, opened: () => opened, sym, q };
  };

  it("shows the empty line and a button to the desk", () => {
    const { el, opened } = base([], notYet);
    expect(el.querySelector(".wc-empty")?.textContent).toBe("No symbols on your watchlist yet.");
    el.querySelector<HTMLButtonElement>(".wc-open")?.click();
    expect(opened()).toBe(1);
  });

  it("shows a dash for an unloaded quote, then the price once it lands", () => {
    const { el, q } = base(["BTCUSDT", "ETHUSDT"], notYet);
    const px = (): string[] => [...el.querySelectorAll(".wc-px")].map((n) => n.textContent ?? "");
    expect(px()).toEqual(["—", "—"]);
    expect([...el.querySelectorAll(".wc-chg")].map((n) => n.textContent)).toEqual(["—", "—"]);

    q.set(loaded([entry("BTCUSDT", 65000, 1.5)]));
    flushFrames();
    expect(px()[0]).not.toBe("—");
    expect(px()[1]).toBe("—");
    expect(el.querySelector(".wc-chg")?.textContent).toBe("+1.50%");
  });

  it("highlights the chart's symbol and selects on click", () => {
    const { el, picked } = base(["BTCUSDT", "ETHUSDT"], loaded([]));
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".wc-row")];
    expect(rows.map((r) => r.dataset["active"])).toEqual(["false", "true"]);
    expect(rows[1]?.getAttribute("aria-current")).toBe("true");
    rows[0]?.click();
    expect(picked).toEqual(["BTCUSDT"]);
  });

  it("shows at most eight rows and offers the rest on the desk", () => {
    const syms = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];
    const { el, opened } = base(syms, loaded([]));
    expect(WATCH_CARD_ROWS).toBe(8);
    expect(el.querySelectorAll(".wc-row")).toHaveLength(8);
    const more = el.querySelector<HTMLButtonElement>(".wc-more");
    expect(more?.textContent).toBe("All 10");
    more?.click();
    expect(opened()).toBe(1);
  });

  it("follows the shared list rather than a copy", () => {
    const { el, sym } = base(["BTCUSDT"], loaded([]));
    sym.set(["BTCUSDT", "SOLUSDT"]);
    flushFrames();
    expect([...el.querySelectorAll(".wc-sym")].map((n) => n.textContent)).toEqual(["BTCUSDT", "SOLUSDT"]);
  });

  it("keeps its own snapshot when none is shared, and words a failure for the operator", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = createWatchCard({
      current: () => "",
      onSelect: () => undefined,
      onOpenDesk: () => undefined,
      symbols: signal<readonly string[]>(["BTCUSDT"]),
      loadQuotes: async () => {
        throw new TypeError("Failed to fetch");
      },
      refreshMs: 60_000,
    });
    await settle();
    expect(el.querySelector(".wc-px")?.textContent).toBe("—");
    expect(el.querySelector(".wc-warn")?.textContent).toBe("Binance could not be reached from here.");
  });
});
