// @vitest-environment jsdom
/**
 * The recommendation card in Autonomous mode, and what "Arm" is allowed to do.
 *
 * What is pinned:
 *  1. AN EMPTY SHELF for this instrument says so and offers the sweep — it
 *     does not render an empty box or a false "nothing is firing".
 *  2. A FIRING RULE becomes a proposal with the plan the ENGINE produced, and
 *     the same "Your say" row the Setup card's verdict carries.
 *  3. NOTHING FIRING says that plainly, per rule.
 *  4. RE-CHECK IS ON BAR CLOSE. New bars alone change nothing; a closed bar
 *     re-runs the pass. That is the behaviour the operator chose, and the
 *     difference between the two is invisible without a test.
 *  5. ARM tells the truth. Disabled with the real reason for a rule the
 *     server cannot evaluate; enabled only for the one thing `alert_loop`
 *     actually does, and then it posts exactly that.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createAutoVerdict } from "../src/ui/shell/autoverdict";
import { createShelfStore } from "../src/backtest/shelfstore";
import { armable, SIG_WORKER_WHY } from "../src/backtest/arming";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import { SAYS_SLOT } from "../src/journal/says";
import type { Discovered } from "../src/backtest/discovered";
import type { RuleSpec } from "../src/backtest/rules";
import type { BarView } from "../src/chart/series";

const T0 = Date.UTC(2025, 0, 1);
const HOUR = 3_600_000;

/** Test-only bars: a deterministic ramp from 100. Never product data. */
function bars(n: number): BarView[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.5;
    return { t: T0 + i * HOUR, o: c, h: c + 0.2, l: c - 0.2, c, v: 10 };
  });
}

const spec = (id: string, long: RuleSpec["long"]): RuleSpec => ({
  id,
  name: `Rule ${id}`,
  style: "custom",
  long,
  stop: { type: "pct", value: 1 },
  target: { type: "rr", value: 2 },
});

const row = (s: RuleSpec, over: Partial<Discovered> = {}): Discovered => ({
  spec: s,
  origin: "library",
  foundAt: T0,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 3_000,
  trials: 87,
  trades: 120,
  expectancy: 0.31,
  sharpe: 0.26,
  deflated: 0.05,
  hurdle: 0.21,
  costs: DEFAULT_COSTS,
  status: "unproven",
  ...over,
});

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
  }
}

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (el: Element, sel: string): HTMLElement | null => el.querySelector(sel);
const click = (el: Element | null): void => (el as HTMLElement | null)?.click();

/**
 * A driver that records what it was asked to do and never runs anything.
 *
 * The point of these tests is WHEN `run` is called, not what a sweep returns —
 * that is `autonomous.test.ts`'s job. Counting calls is the only way to catch
 * a guard that has stopped guarding, because a sweep that starts when it should
 * not is invisible on screen until the CPU fan does.
 */
function fakeSweep(o: { remembers?: boolean } = {}) {
  const running = signal(false);
  const subject = signal<{ symbol: string; timeframe: string } | null>(null);
  const calls: { symbol: string; timeframe: string }[] = [];
  let cancels = 0;
  return {
    calls,
    cancelled: () => cancels,
    driver: {
      /* A market this driver already has an answer for. `null` is "nothing is
         known", which is NOT "nothing was found" — the card must still search. */
      recall: () => (o.remembers === true ? { line: "Nothing survived.", at: 0, bars: 5000, nearest: "" } : null),
      run: async (symbol: string, timeframe: string) => {
        calls.push({ symbol, timeframe });
        subject.set({ symbol, timeframe });
      },
      cancel: () => {
        cancels += 1;
      },
      running,
      subject,
      progress: signal(null),
      report: signal(null),
      blocked: signal(""),
      note: signal(""),
      loaded: signal(null),
      history: signal(null),
      elapsed: signal(0),
      savedCount: signal<number | null>(null),
      nameById: signal(new Map<string, string>()),
    },
  };
}

function mount(o: {
  rows?: readonly Discovered[];
  barCount?: number;
  symbol?: string;
  closed?: number;
  sweep?: ReturnType<typeof fakeSweep>;
  autoSearch?: boolean;
  visible?: boolean;
} = {}) {
  const kv = createKV(memoryRawStore());
  const shelf = createShelfStore(kv);
  for (const r of o.rows ?? []) shelf.addAll([r]);
  const n = o.barCount ?? 60;
  const barSig = signal<readonly BarView[]>(bars(n));
  /*
   * `closed` defaults to `n` here, which the older tests were written against.
   * PRODUCTION IS `n - 1` (`ui/model/structure.ts`: `bars().length - 1`) — the
   * last element of the array is the bar FORMING, not a closed one. The tests
   * that care about the fill price pass the real number, because the bar that
   * fills a signal is exactly the one this default pretends does not exist.
   */
  const closed = signal(o.closed ?? n);
  const ctx = { kv, state: { symbol: signal(o.symbol ?? "BTCUSDT"), timeframe: signal("1h") } };
  const onOpenStrategy = vi.fn();
  const onUse = vi.fn();
  const onAdjust = vi.fn();
  const pref = signal(o.autoSearch ?? true);
  /*
   * NOTHING HAS A SIZE IN JSDOM, so `isShown` — which asks for
   * `getClientRects().length` — is false for every element unless it is told
   * otherwise. That is the guard under test, and it has to be in place BEFORE
   * the card is built: the visibility check runs during construction, and
   * `onShown`'s ResizeObserver does not exist here to re-run it afterwards.
   * A test that wants the pane hidden passes `visible: false` and gets the
   * real jsdom answer.
   */
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue(
    (o.visible === false ? [] : [{ width: 300, height: 200 }]) as unknown as DOMRectList,
  );
  const el = createAutoVerdict(ctx, {
    shelf,
    bars: barSig,
    closedBarCount: closed,
    onOpenStrategy,
    onUse,
    onAdjust,
    now: () => T0,
    settleMs: 1,
    ...(o.sweep ? { sweep: o.sweep.driver as never } : {}),
    autoSearch: pref,
  });
  document.body.replaceChildren(el);
  return { el, kv, shelf, barSig, closed, ctx, pref, onOpenStrategy, onUse, onAdjust };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------- empty --- */

describe("the card with nothing on the shelf", () => {
  it("says so for this instrument and offers the sweep", async () => {
    const m = mount();
    await settle();
    expect(text(q(m.el, ".av-empty"))).toBe("Nothing has been found for BTCUSDT 1h yet.");
    expect(q(m.el, '[data-act="open-strategy"]')).not.toBeNull();
    click(q(m.el, '[data-act="open-strategy"]'));
    expect(m.onOpenStrategy).toHaveBeenCalledTimes(1);
  });

  it("a row found on ANOTHER market is not this market's answer", async () => {
    const m = mount({ rows: [row(spec("s1", [["close", ">", "100"]]), { symbol: "ETHUSDT" })] });
    await settle();
    expect(text(q(m.el, ".av-empty"))).toBe("Nothing has been found for BTCUSDT 1h yet.");
  });

  it("a retired row is not offered", async () => {
    const m = mount({
      rows: [row(spec("s1", [["close", ">", "100"]]), { status: "retired", retiredWhy: "fixture" })],
    });
    await settle();
    expect(text(q(m.el, ".av-empty"))).toBe("Nothing has been found for BTCUSDT 1h yet.");
  });
});

/* --------------------------------------------------------------- firing --- */

describe("the card with a firing rule", () => {
  const firing = spec("fire", [["close", ">", "100"]]);

  it("offers the engine's own plan, and says the rule is unproven", async () => {
    /* The REAL relationship between the array and the closed count — 60 bars,
       59 of them closed — so the bar that fills the signal exists. */
    const m = mount({ rows: [row(firing)], barCount: 60, closed: 59 });
    await settle();

    expect(text(q(m.el, ".av-lead-name"))).toBe("Rule fire");
    expect(text(q(m.el, ".av-dir"))).toBe("Long");
    expect(text(q(m.el, ".av-lead-line"))).toMatch(/^Its entry is true on the bar that closed at .+ UTC\.$/);
    /* Entry is the closed bar's close; the stop is 1% under it, which is what
       the compiled spec computes — not a number this card invented. */
    const plan = text(q(m.el, ".av-plan"));
    expect(plan).toContain("Entry");
    expect(plan).toContain("Stop");
    expect(plan).toContain("Target");
    /*
     * AND THE REST OF WHAT MANUAL SHOWS. Until v60.2 this pane stopped at
     * three cells: no size, no cash at risk, no checks — so the autonomous
     * half of the card offered strictly less than the manual half for the same
     * decision. `ui/model/autoplan.ts` builds all of it from the rule's own
     * levels; `autoplan.test.ts` pins the arithmetic, this pins that it
     * reaches the screen.
     */
    expect(text(q(m.el, ".av-fill"))).toContain("the open of the bar forming now");
    expect(text(q(m.el, ".av-checks"))).not.toBe("");
    expect(text(q(m.el, ".av-size"))).not.toBe("");
    expect(text(q(m.el, ".av-unproven"))).toContain("UNPROVEN");
    expect(text(q(m.el, ".av-figs"))).toContain("120 out-of-sample trades");
  });

  it("carries the same Your say row, and records the answer against this rule", async () => {
    const m = mount({ rows: [row(firing)] });
    await settle();

    const say = q(m.el, ".say");
    expect(say).not.toBeNull();
    expect(text(say)).toContain("Use this plan");
    expect(text(say)).toContain("Not for me");

    const use = [...(say as Element).querySelectorAll("button")].find((b) => b.textContent === "Use this plan");
    click(use ?? null);
    await settle();

    expect(m.onUse).toHaveBeenCalledTimes(1);
    const said = m.kv.get(SAYS_SLOT);
    expect(said).toHaveLength(1);
    expect(said[0]?.choice).toBe("use");
    expect(said[0]?.verdict).toBe("auto:fire");
    expect(said[0]?.direction).toBe("long");
  });

  it("says nothing is firing, per rule, when nothing is", async () => {
    const m = mount({ rows: [row(spec("quiet", [["close", "<", "1"]]))] });
    await settle();
    expect(text(q(m.el, ".av-empty"))).toBe(
      "None of the 1 strategies found for BTCUSDT 1h has its entry true on the last closed bar.",
    );
    expect(text(q(m.el, '.av-quiet[data-kind="quiet"]'))).toContain("not triggered on the bar that closed at");
  });

  it("refuses rather than answering when there is less history than the warm-up", async () => {
    const m = mount({ rows: [row(firing)], barCount: 10 });
    await settle();
    const line = text(q(m.el, '.av-quiet[data-kind="cannot"]'));
    expect(line).toContain("needs 25 bars of warm-up");
    expect(line).toContain("there are 10 closed");
  });
});

/* -------------------------------------------------- searching by itself --- */

describe("when the card searches a market on its own", () => {
  const wait = async (ms = 40): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms));
    await settle();
  };

  it("searches an unsearched market once it has been looked at", async () => {
    const sweep = fakeSweep();
    mount({ sweep });
    await wait();
    expect(sweep.calls).toEqual([{ symbol: "BTCUSDT", timeframe: "1h" }]);
  });

  /*
   * MOUNTED IS NOT VISIBLE. Both panes of this card live in the DOM at once and
   * are switched with `display`, so a card that triggered on `isConnected`
   * would sweep every market while the operator was reading the Manual pane.
   */
  it("does not search while the pane is not on screen", async () => {
    const sweep = fakeSweep();
    mount({ sweep, visible: false });
    await wait();
    expect(sweep.calls).toHaveLength(0);
  });

  it("does not search twice for the same market", async () => {
    const sweep = fakeSweep();
    const m = mount({ sweep });
    await wait();
    expect(sweep.calls).toHaveLength(1);
    /* A bar closes, the shelf re-checks — but the market has had its search. */
    m.closed.set(61);
    await wait();
    expect(sweep.calls).toHaveLength(1);
  });

  /* "Nothing survived" is an answer. A market whose shelf already holds a row
     was searched in an earlier session and must not be searched again. */
  it("does not search a market that already has rows", async () => {
    const sweep = fakeSweep();
    mount({ sweep, rows: [row(spec("s1", [["close", ">", "100"]]))] });
    await wait();
    expect(sweep.calls).toHaveLength(0);
  });

  it("does not search when the operator has turned it off", async () => {
    const sweep = fakeSweep();
    mount({ sweep, autoSearch: false });
    await wait();
    expect(sweep.calls).toHaveLength(0);
  });

  it("searches the new market when the instrument changes, and abandons the old run", async () => {
    const sweep = fakeSweep();
    const m = mount({ sweep });
    await wait();
    expect(sweep.calls).toHaveLength(1);

    /* A run is in flight on the old market when the operator moves on. */
    sweep.driver.running.set(true);
    m.ctx.state.symbol.set("ETHUSDT");
    await wait();
    expect(sweep.cancelled(), "a sweep of the market you left is abandoned, not raced").toBe(1);

    sweep.driver.running.set(false);
    m.ctx.state.symbol.set("SOLUSDT");
    await wait();
    expect(sweep.calls.at(-1)).toEqual({ symbol: "SOLUSDT", timeframe: "1h" });
  });

  /*
   * "NOTHING SURVIVED" IS AN ANSWER. Searching a market that has already been
   * searched and found empty spends thirty seconds reproducing a conclusion
   * already reached — the whole reason the cache exists.
   */
  it("does not search a market it already has a remembered answer for", async () => {
    const sweep = fakeSweep({ remembers: true });
    mount({ sweep });
    await wait();
    expect(sweep.calls).toHaveLength(0);
  });

  it("offers the desk, not a search, when no driver was given", async () => {
    const m = mount();
    await wait();
    expect(q(m.el, '[data-act="search"]')).toBeNull();
    expect(q(m.el, '[data-act="open-strategy"]')).not.toBeNull();
  });
});

/* ----------------------------------------------------------- the fill --- */

describe("the entry price the card proposes", () => {
  const firing = spec("fire", [["close", ">", "100"]]);

  /*
   * THE BACKTEST DOES NOT FILL AT THE SIGNAL BAR'S CLOSE.
   *
   * `runBacktest` holds the signal as `pending` and fills at the NEXT bar's
   * open, adjusted against you by half the spread plus slippage. The card was
   * printing the signal bar's close — a price the engine never paid — directly
   * above that engine's out-of-sample expectancy.
   *
   * The arithmetic, written out so this expectation does not come from the code
   * it is testing: `bars(60)` closes at `100 + i * 0.5` and opens at the same
   * value. With 59 bars closed the signal is bar 58 (close 129.00) and the bar
   * now forming is 59, open 129.50. DEFAULT_COSTS is spread 0.0002 and slippage
   * 0.0001, so a long pays 129.50 * (1 + 0.0002 / 2 + 0.0001) = 129.50 * 1.0002
   * = 129.5259. Four decimals, because the price is between 1 and 1,000.
   */
  it("fills at the next bar's open plus costs, not at the signal bar's close", async () => {
    const m = mount({ rows: [row(firing)], barCount: 60, closed: 59 });
    await settle();

    const entry = text(q(m.el, '.av-plan .dv-cell:first-child .dv-v'));
    expect(entry).toBe("129.5259");
    expect(entry, "the signal bar's close is not a price the engine ever paid").not.toBe("129.0000");
  });

  it("says where that price comes from, and how far the market has moved from it", async () => {
    const m = mount({ rows: [row(firing)], barCount: 60, closed: 59 });
    await settle();
    const note = text(q(m.el, ".av-fill"));
    expect(note).toContain("the open of the bar forming now");
    expect(note).toContain("129.5259");
  });

  /*
   * A signal whose stop lands on the wrong side of the fill is one the engine
   * DROPS rather than books (`fillable` in engine.ts). A card that offered it
   * as a live plan would be proposing a trade the backtest refused to test.
   */
  it("refuses a signal the engine itself would not have filled", async () => {
    /* A short whose stop is 1% BELOW entry: `fillable` wants the stop above. */
    const impossible: RuleSpec = {
      id: "unfillable",
      name: "Unfillable",
      style: "custom",
      long: [],
      short: [["close", ">", "100"]],
      stop: { type: "pct", value: -1 },
      target: { type: "none" },
    };
    const m = mount({ rows: [row(impossible, { spec: impossible })], barCount: 60, closed: 59 });
    await settle();
    expect(text(m.el)).not.toContain("Use this plan");
  });
});

/* ------------------------------------------------------- re-check timing --- */

describe("when the card re-checks", () => {
  const firing = spec("fire", [["close", ">", "125"]]);

  it("new bars alone change nothing; a CLOSED bar re-runs the pass", async () => {
    /* 30 bars: the last close is 114.5, under the rule's 125. */
    const m = mount({ rows: [row(firing)], barCount: 30 });
    await settle();
    expect(q(m.el, ".av-lead")).toBeNull();

    /* Ticks arrive: the bar array grows past the threshold, but no bar has
       closed. Nothing may change — the engine judges closes only. */
    m.barSig.set(bars(80));
    await settle();
    expect(q(m.el, ".av-lead"), "a tick must not re-run the pass").toBeNull();

    /* Now a bar closes. */
    m.closed.set(80);
    await settle();
    expect(q(m.el, ".av-lead"), "a closed bar must re-run the pass").not.toBeNull();
    expect(text(q(m.el, ".av-lead-name"))).toBe("Rule fire");
  });

  it("Check again re-runs it on demand, with no new bar", async () => {
    const m = mount({ rows: [row(firing)], barCount: 30 });
    await settle();
    expect(text(q(m.el, ".av-foot"))).toContain("30 closed bars");
    expect(q(m.el, ".av-lead")).toBeNull();

    /* The SAME thirty bars, with the last closed one revised upward — what a
       backfill does. No bar has closed, so only the on-demand press can find
       it. */
    const revised = bars(30);
    const last = revised[29] as BarView;
    revised[29] = { ...last, c: 130, h: 130.2 };
    m.barSig.set(revised);
    await settle();
    expect(q(m.el, ".av-lead"), "a revision alone must not re-run the pass").toBeNull();

    click(q(m.el, '[data-act="recheck"]'));
    await settle();
    expect(q(m.el, ".av-lead"), "Check again must re-run it").not.toBeNull();
    expect(text(q(m.el, ".av-foot"))).toContain("30 closed bars");
  });

  /*
   * THE FACT THIS PINS CHANGED BY DECISION, not by drift. Until v60.2 the card
   * never started a search by itself and said so; the owner was shown the cost
   * (20-30s of eighty-five studies) and chose automatic-once-per-market. So the
   * sentence changed and this test changed with it — what stays pinned is that
   * the card STATES which of the two it is doing, and that it places no order.
   */
  it("says whether it searches by itself, and always that it places no order", async () => {
    const m = mount({ rows: [row(spec("fire", [["close", ">", "100"]]))] });
    await settle();
    const note = text(q(m.el, ".av-note"));
    expect(note).toMatch(/searched once, by itself|search runs only when you ask/);
    expect(note).toContain("Nothing here places an order.");
  });
});

/* ----------------------------------------------------------------- arming --- */

describe("armable — what the server can actually watch", () => {
  it("refuses an indicator rule, and names both the gap and the signal worker", () => {
    const a = armable(spec("rsi", [["rsi", "<", "30"]]));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.why).toContain("RSI(14)");
    expect(a.why).toContain("only a price");
    expect(a.why).toContain(SIG_WORKER_WHY);
  });

  it("refuses a rule with more than one entry condition", () => {
    const a = armable(spec("two", [["close", ">", "100"], ["close", "<", "200"]]));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.why).toContain("2 conditions that must all hold on the same closed bar");
  });

  it("refuses a crossing, because the loop keeps no previous bar", () => {
    const a = armable(spec("x", [["close", "crossabove", "100"]]));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.why).toContain("cannot tell a crossing from a level that was already true");
  });

  it("refuses a comparison with another indicator", () => {
    const a = armable(spec("c", [["close", ">", "ema50"]]));
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.why).toContain("EMA 50");
    expect(a.why).toContain("no second series");
  });

  it("refuses a two-sided rule rather than arming half of it", () => {
    const s = { ...spec("both", [["close", ">", "100"]]), short: [["close", "<", "90"]] } as RuleSpec;
    const a = armable(s);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.why).toContain("weaker than the strategy");
  });

  it("accepts the one shape `alert_loop` evaluates: one price against one number", () => {
    const a = armable(spec("px", [["close", ">=", "120"]]));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.op).toBe("above");
    expect(a.price).toBe(120);
  });
});

describe("the Arm button", () => {
  it("is disabled, with the true reason on screen, for a rule the server cannot read", async () => {
    /* `close > 100` fires; `rsi` in the group makes it unarmable. */
    const s = spec("mix", [["close", ">", "100"], ["rsi", ">", "0"]]);
    const m = mount({ rows: [row(s)] });
    await settle();

    const button = q(m.el, '[data-act="arm"]') as HTMLButtonElement | null;
    expect(button, "a firing proposal must offer the Arm control, even disabled").not.toBeNull();
    expect(button?.disabled).toBe(true);

    const why = text(q(m.el, ".av-arm-why"));
    expect(q(m.el, ".av-arm-why")?.dataset["armable"]).toBe("false");
    expect(why).toContain("Cannot be armed.");
    expect(why).toContain("2 conditions that must all hold on the same closed bar");
    expect(why).toContain("only knows the built-in strategies by name");
  });

  it("arms a price threshold at /svc/alerts, and says where it will fire", async () => {
    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const s = spec("px", [["close", ">", "120"]]);
    const m = mount({ rows: [row(s)], barCount: 80 });
    await settle();

    const button = q(m.el, '[data-act="arm"]') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
    click(button);
    await settle();

    expect(seen).toHaveLength(1);
    /* The URL is PARSED, never compared with an expression this code built. */
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/svc/alerts");
    expect(seen[0]?.body).toMatchObject({ sym: "BTCUSDT", op: "above", price: 120 });

    const said = text(q(m.el, ".av-arm-said"));
    expect(said).toContain("Armed: BTCUSDT above 120");
    expect(said).toContain("with the terminal closed");
    expect(q(m.el, ".av-arm-said")?.dataset["ok"]).toBe("true");
    /* And the shelf records that a watch exists, so it is not armed twice. */
    expect(m.shelf.rows()[0]?.armedAt).toBe(T0);
  });

  it("reports a refusal from the service instead of claiming it armed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, err: "sym/op" }), { status: 400, headers: { "content-type": "application/json" } })),
    );

    const m = mount({ rows: [row(spec("px", [["close", ">", "120"]]))], barCount: 80 });
    await settle();
    click(q(m.el, '[data-act="arm"]'));
    await settle();

    const said = text(q(m.el, ".av-arm-said"));
    expect(said).toContain("Not armed:");
    expect(q(m.el, ".av-arm-said")?.dataset["ok"]).toBe("false");
    expect(m.shelf.rows()[0]?.armedAt).toBeUndefined();
  });
});
