// @vitest-environment jsdom
/**
 * Research ▸ Study, the steered flow, rendered.
 *
 * The empty state is the first thing anyone sees of this page, so it is what
 * is pinned: the four numbered cards with the SAME who-tags as the inspector,
 * every AI-chosen related asset with its one-line reason and "measured on run"
 * rather than a number, a Results card that promises nothing it has not
 * measured, and the switch-off actually taking the asset out of the study.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createToaster } from "../src/ui/toast";
import { createStudyState } from "../src/ui/study/state";
import { createSteeredStudy } from "../src/ui/research/steered";
import { proposeRelated } from "../src/study/related";
import type { HistoryResult, HistoryService } from "../src/data/history";

const empty: HistoryResult = {
  bars: [],
  source: "none",
  quality: "unknown",
  fromCache: false,
  gaps: [],
  coverage: 0,
  containsDemo: false,
  attempts: [],
};

const history: HistoryService = {
  load: () => Promise.resolve(empty),
  record: () => Promise.resolve(),
  backfill: () => Promise.resolve(0),
};

/* DOM effects re-run on the next frame (`renderEffect`); flush it rather than wait. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  flushFrames();
};

function mount() {
  const state = createStudyState(
    { kv: createKV(memoryRawStore()), toaster: createToaster() },
    { history, symbol: signal("BTCUSDT"), timeframe: signal("1h") },
  );
  const openFull = vi.fn();
  const el = createSteeredStudy(state, { chartSymbol: signal("BTCUSDT"), openFull });
  document.body.replaceChildren(el);
  return { state, el, openFull };
}

beforeEach(() => {
  /* The quant health probe must not reach a real service from a test. */
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("steered study — empty state", () => {
  it("shows the four steps with You and AI tags that match the inspector's", () => {
    const { el } = mount();
    const titles = [...el.querySelectorAll(".rs-card-title")].map((t) => t.textContent);
    expect(titles).toEqual([
      "1 · Your asset",
      "2 · Your question",
      "4 · How strict",
      "3 · Related assets — chosen by AI",
      "Inputs and checks — chosen by AI",
      "Results",
    ]);
    const who = [...el.querySelectorAll(".card-who")].map((t) => t.getAttribute("data-who"));
    expect(who).toEqual(["you", "you", "you", "ai", "ai", "both"]);
  });

  it("lists every AI pick with its reason, and no number before a run", () => {
    const { el } = mount();
    const rows = [...el.querySelectorAll(".rs-rel")];
    const picks = proposeRelated("BTCUSDT").picks;
    expect(rows).toHaveLength(picks.length);
    for (const row of rows) {
      expect(row.getAttribute("data-who")).toBe("ai");
      expect(row.querySelector(".rs-rel-why")?.textContent?.length ?? 0).toBeGreaterThan(5);
      expect(row.querySelector(".rs-rel-state")?.textContent).toBe("measured on run");
      expect(row.querySelector("details summary")?.textContent).toBe("Why?");
    }
  });

  it("promises nothing in Results until something is measured", () => {
    const { el } = mount();
    const out = el.querySelector(".rs-results")?.textContent ?? "";
    expect(out).toContain("Run the research");
    expect(out).toContain("Numbers appear only once they are measured");
    expect(el.querySelector(".rs-verdict")).toBeNull();
  });

  it("offers Run research before any fetch, because running fetches first", () => {
    const { el } = mount();
    const run = el.querySelector<HTMLButtonElement>(".rs-run");
    expect(run?.textContent).toBe("Run research");
    expect(run?.disabled).toBe(false);
  });

  it("switching a pick off takes it out of the study and keeps it listed", async () => {
    const { el, state } = mount();
    const box = el.querySelector<HTMLInputElement>('.rs-rel input[aria-label="Leave out SPX500"]');
    expect(box).not.toBeNull();
    if (box === null) return;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await tick();
    expect(state.spec().context.map((c) => c.symbol)).not.toContain("SPX500");
    const row = [...el.querySelectorAll(".rs-rel")].find((r) => r.querySelector(".rs-rel-sym")?.textContent === "SPX500");
    expect(row?.getAttribute("data-on")).toBe("false");
  });

  it("rounds and costs are disabled, with the reason, unless the question tests rules", async () => {
    const { el, state } = mount();
    const range = (): HTMLInputElement | null => el.querySelector<HTMLInputElement>(".rs-range");
    expect(range()?.disabled).toBe(true);
    expect(el.querySelector(".rs-strict")?.textContent).toContain("No rule is tested for this question");
    state.setQuestion("setup");
    await tick();
    expect(range()?.disabled).toBe(false);
    expect(state.spec().methods).toContain("sweep-ema");
  });

  it("a new asset gets the AI's picks afresh", async () => {
    const { el, state } = mount();
    state.setAsset("XAUUSD");
    await tick();
    const syms = [...el.querySelectorAll(".rs-rel-sym")].map((s) => s.textContent);
    expect(syms).toContain("XAGUSD");
    expect(el.querySelector(".rs-related")?.textContent).toContain("Left out (1)");
  });
});
