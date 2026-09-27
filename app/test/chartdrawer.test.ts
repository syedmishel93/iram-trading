// @vitest-environment jsdom
/**
 * The drawer under the chart.
 *
 * Every expected value is written by hand from the fixture, never read back
 * from the code under test. URLs are checked by parsing what `fetch` was
 * actually called with (see CLAUDE.md on the QUANT_BASE test that compared a
 * bug to itself). Fixtures are built to the REAL types — the broker model and
 * the session are typed through `ReturnType` of the real factories.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChartDrawer,
  detectorCounts,
  firedCount,
  firedToday,
  lastExchange,
  positionRows,
  positionsCount,
  sanitiseDrawerTab,
  DRAWER_TABS,
  type ChartDrawerDeps,
  type DrawerTab,
} from "../src/ui/chartdrawer";
import { computed, signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import type { Detection, DetectorId } from "../src/detect/index";
import { createDrawingStore } from "../src/draw/store";
import { createDrawing } from "../src/draw/model";
import { createKV, memoryRawStore } from "../src/store/kv";
import { reconcile } from "../src/trade/book";
import type { BrokerAccount, BrokerHealth, BrokerPosition, BrokerResult } from "../src/data/broker";
import type { AgentSession, TranscriptEntry } from "../src/agent/session";
import type { createBrokerModel } from "../src/ui/model/broker";
import type { AlertsResult, PriceAlert } from "../src/data/pricealerts";
import type { FiredSignal, SigFiredResult } from "../src/data/sigfired";
import { parseSigFired } from "../src/data/sigfired";

/* ------------------------------------------------------------ fixtures --- */

const det = (id: string, kind: Detection["kind"]): Detection => ({
  id,
  kind,
  label: kind,
  direction: "neutral",
  from: 0,
  to: 1,
  confidence: 0.5,
  reason: "fixture",
  shapes: [],
});

const pos = (over: Partial<BrokerPosition> = {}): BrokerPosition => ({
  ticket: 101,
  symbol: "EURUSD",
  type: 0,
  volume: 1,
  price_open: 1.1,
  sl: 1.09,
  tp: 1.12,
  profit: 250,
  swap: -3,
  time_ms: 1_700_000_000_000,
  ...over,
});

type Broker = ReturnType<typeof createBrokerModel>;
function brokerFixture(r: BrokerResult<readonly BrokerPosition[]> | null): Broker {
  const positions = signal<BrokerResult<readonly BrokerPosition[]> | null>(r);
  const contracts = signal<ReadonlyMap<string, number>>(new Map());
  return {
    health: signal<BrokerResult<BrokerHealth> | null>(null),
    account: signal<BrokerResult<BrokerAccount> | null>(null),
    positions,
    contracts,
    book: computed(() =>
      reconcile({ broker: positions() ?? { state: "offline", reason: "not asked" }, manual: [], contracts: contracts() }),
    ),
    connected: computed(() => positions()?.state === "ok"),
    lastAt: signal(0),
    busy: signal(false),
    givenUp: signal(false),
    refresh: async () => {},
    reconnect: vi.fn(),
  };
}

function sessionFixture(entries: readonly TranscriptEntry[] = []): AgentSession & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    transcript: signal<readonly TranscriptEntry[]>(entries),
    busy: signal(false),
    streaming: signal(""),
    ask: async (text: string) => {
      asked.push(text);
    },
    cancel: () => {},
    reset: () => {},
    history: () => [],
  };
}

const alert = (over: Partial<PriceAlert>): PriceAlert => ({
  id: 1,
  sym: "BTCUSDT",
  op: "above",
  price: 85_000,
  note: "",
  created: 0,
  fired: null,
  ...over,
});

const sig = (over: Partial<FiredSignal>): FiredSignal => ({
  sym: "EURUSD",
  tf: "1h",
  strategy: "ema-cross",
  bar_t: 0,
  fired_at: 0,
  dir: "LONG",
  entry: 1.1,
  stop: 1.09,
  t1: 1.11,
  t2: 1.12,
  q: 72,
  record: "{}",
  ...over,
});

/** Local noon, 21 Sep 2026, and seconds helpers against it. */
const NOON = new Date(2026, 8, 21, 12, 0, 0).getTime();
const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  flushFrames();
};

let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      const path = new URL(url).pathname;
      const body = path === "/svc/alerts" ? [] : { ok: true, fired: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.textContent = "";
});

/* --------------------------------------------------------------- pure --- */

describe("sanitiseDrawerTab", () => {
  it("keeps each of the four tabs", () => {
    expect(DRAWER_TABS).toEqual(["objects", "ask", "positions", "alerts"]);
    for (const t of ["objects", "ask", "positions", "alerts"]) expect(sanitiseDrawerTab(t)).toBe(t);
  });
  it("defaults anything else to objects", () => {
    expect(sanitiseDrawerTab("Objects")).toBe("objects");
    expect(sanitiseDrawerTab(null)).toBe("objects");
    expect(sanitiseDrawerTab(3)).toBe("objects");
    expect(sanitiseDrawerTab(undefined)).toBe("objects");
  });
});

describe("detectorCounts", () => {
  it("counts through DETECTOR_FOR_KIND, folding kinds into their detector", () => {
    const c = detectorCounts([det("a", "bos"), det("b", "choch"), det("c", "fvg"), det("d", "double-top"), det("e", "double-bottom")]);
    expect(c.get("structure")).toBe(2);
    expect(c.get("fvg")).toBe(1);
    expect(c.get("doubles")).toBe(2);
    expect(c.has("levels")).toBe(false);
  });
});

describe("positionRows", () => {
  it("says none, in the attention tone, for a stop of zero", () => {
    const v = positionRows({ state: "ok", value: [pos({ sl: 0, type: 1, profit: -40 })] });
    expect(v.state).toBe("ok");
    if (v.state !== "ok") return;
    const r = v.rows[0];
    expect(r?.stop).toBe("none");
    expect(r?.stopTone).toBe("attn");
    expect(r?.side).toBe("Sell");
    expect(r?.pnlTone).toBe("neg");
  });
  it("prints a real stop and tones a profit positive", () => {
    const v = positionRows({ state: "ok", value: [pos()] }, (_s, x) => x.toFixed(4));
    if (v.state !== "ok") throw new Error("expected rows");
    expect(v.rows[0]?.stop).toBe("1.0900");
    expect(v.rows[0]?.stopTone).toBe("");
    expect(v.rows[0]?.side).toBe("Buy");
    expect(v.rows[0]?.pnlTone).toBe("pos");
  });
  it("gives the offline sentence, not zero positions, when MT5 is not connected", () => {
    const r: BrokerResult<readonly BrokerPosition[]> = { state: "disconnected", reason: "terminal not running" };
    const v = positionRows(r);
    expect(v.state).toBe("refused");
    if (v.state !== "refused") return;
    expect(v.text).toBe("MT5 is not connected — positions appear here live once it is.");
    expect(positionsCount(r)).toBe("—");
    expect(positionsCount({ state: "offline", reason: "x" })).toBe("—");
    expect(positionsCount(null)).toBe("—");
    expect(positionsCount({ state: "ok", value: [] })).toBe("0");
  });
});

describe("firedToday", () => {
  const ok = (a: PriceAlert[]): AlertsResult => ({ state: "ok", value: a });
  const sigs = (s: FiredSignal[]): SigFiredResult => ({ state: "ok", value: s });

  it("keeps only what fired on the local day, newest first", () => {
    const morning = sec(new Date(2026, 8, 21, 9, 30));
    const late = sec(new Date(2026, 8, 21, 11, 15));
    const yesterday = sec(new Date(2026, 8, 20, 23, 59));
    const log = firedToday(
      ok([alert({ id: 1, fired: morning }), alert({ id: 2, fired: yesterday }), alert({ id: 3, fired: null })]),
      sigs([sig({ fired_at: late }), sig({ fired_at: yesterday, strategy: "old" })]),
      NOON,
    );
    if (log.state !== "ok") throw new Error("expected ok");
    expect(log.rows.map((r) => r.at)).toEqual([late, morning]);
    expect(log.rows[0]?.source).toBe("Signal");
    expect(log.rows[0]?.what).toBe("EURUSD 1h long — ema-cross · quality 72");
    expect(log.rows[1]?.what).toBe(`BTCUSDT above ${(85_000).toLocaleString()}`);
    expect(firedCount(log)).toBe("2");
  });
  it("names a missing source and labels the count a floor", () => {
    const log = firedToday(ok([alert({ fired: sec(new Date(2026, 8, 21, 8, 0)) })]), { state: "offline", reason: "down" }, NOON);
    if (log.state !== "ok") throw new Error("expected ok");
    expect(log.missing).toEqual(["signals"]);
    expect(firedCount(log)).toBe("≥1");
  });
  it("is offline, with a dash, when neither answers", () => {
    const log = firedToday({ state: "offline", reason: "a" }, { state: "offline", reason: "b" }, NOON);
    expect(log.state).toBe("offline");
    expect(firedCount(log)).toBe("—");
  });
});

describe("parseSigFired", () => {
  it("keeps well-formed rows and drops ones with no direction or time", () => {
    const rows = parseSigFired({
      ok: true,
      fired: [
        { sym: "EURUSD", tf: "1h", strategy: "s1", bar_t: 1_700_000_000_000, fired_at: 1_700_000_100, dir: "SHORT", entry: 1.1, stop: 1.2, t1: 1, t2: 0.9, q: 60, record: "{}" },
        { sym: "EURUSD", tf: "1h", strategy: "s2", fired_at: 1_700_000_100, dir: "sideways" },
        { sym: "EURUSD", tf: "1h", strategy: "s3", dir: "LONG" },
      ],
    });
    expect(rows.map((r) => r.strategy)).toEqual(["s1"]);
    expect(rows[0]?.dir).toBe("SHORT");
  });
});

describe("lastExchange", () => {
  it("pairs the last question with the answer after it, never an earlier one", () => {
    const t: TranscriptEntry[] = [
      { kind: "user", at: 1, text: "first" },
      { kind: "assistant", at: 2, text: "old answer", provider: "P" },
      { kind: "user", at: 3, text: "second" },
    ];
    expect(lastExchange(t)).toEqual({ question: "second", answer: null, provider: "", error: null, note: null });
    expect(lastExchange([])).toBeNull();
  });
});

/* ------------------------------------------------------------- render --- */

function build(over: Partial<ChartDrawerDeps> = {}) {
  const store = createDrawingStore(createKV(memoryRawStore()));
  const deps: ChartDrawerDeps = {
    open: signal(false),
    tab: signal<DrawerTab>("objects"),
    symbol: () => "EURUSD",
    timeframe: () => "1h",
    detectors: signal<DetectorId[]>(["structure", "fvg"]),
    detections: () => [det("a", "bos"), det("b", "fvg")],
    drawStore: store,
    session: sessionFixture(),
    onOpenAnalyst: vi.fn(),
    broker: brokerFixture({ state: "disconnected", reason: "MT5 not running" }),
    fmtPx: (v) => v.toFixed(5),
    ...over,
  };
  const el = createChartDrawer(deps);
  document.body.append(el);
  return { el, deps, store };
}

describe("createChartDrawer", () => {
  it("is collapsed by default: four tabs and no body", async () => {
    const { el } = build();
    await settle();
    const tabs = el.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    expect([...tabs].map((t) => t.querySelector(".cd-tab-name")?.textContent)).toEqual([
      "Objects",
      "Ask the AI",
      "Positions",
      "Alerts log",
    ]);
    expect(el.querySelector(".cd-body")?.hasAttribute("hidden")).toBe(true);
    const toggle = el.querySelector(".cd-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toBe("Expand");
    /* Offline broker: a dash on the tab, never 0. */
    expect(el.querySelector('.cd-tab[data-tab="positions"] .cd-n')?.textContent).toBe("—");
    /* 2 detections + 0 drawings. */
    expect(el.querySelector('.cd-tab[data-tab="objects"] .cd-n')?.textContent).toBe("2");
  });

  it("clicking a tab expands the drawer and selects it", async () => {
    const { el, deps } = build();
    await settle();
    (el.querySelector('.cd-tab[data-tab="positions"]') as HTMLButtonElement).click();
    await settle();
    expect(deps.open.peek()).toBe(true);
    expect(deps.tab.peek()).toBe("positions");
    expect(el.querySelector(".cd-body")?.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector('.cd-tab[data-tab="positions"]')?.getAttribute("aria-selected")).toBe("true");
    expect(el.querySelector('[data-pane="positions"]')?.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector('[data-pane="objects"]')?.hasAttribute("hidden")).toBe(true);
    const pane = el.querySelector('[data-pane="positions"]')?.textContent ?? "";
    expect(pane).toContain("MT5 is not connected — positions appear here live once it is.");
    expect(pane).not.toContain("No open positions");
  });

  it("Delete removes the drawing through the store", async () => {
    const { el, store } = build();
    const d = createDrawing("hline", [{ t: 0, p: 1.2345 }], { symbol: "EURUSD", timeframe: "1h" });
    store.add(d);
    const spy = vi.spyOn(store, "remove");
    (el.querySelector('.cd-tab[data-tab="objects"]') as HTMLButtonElement).click();
    await settle();
    const row = el.querySelector(`.cd-draw[data-id="${d.id}"]`);
    expect(row?.textContent).toContain("Horizontal");
    expect(row?.textContent).toContain("1.23450");
    (row?.querySelector(".cd-del") as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith(d.id);
    await settle();
    expect(el.querySelector(".cd-draw")).toBeNull();
    expect(el.textContent).toContain("Nothing drawn yet — pick a tool on the left of the chart.");
  });

  it("toggling a detector writes the shell's selection, and an off detector shows a dash", async () => {
    const { el, deps } = build();
    await settle();
    const boxes = [...el.querySelectorAll<HTMLInputElement>(".cd-check")];
    expect(boxes.length).toBeGreaterThan(20);
    const structure = [...el.querySelectorAll(".cd-det")].find((r) => r.querySelector(".cd-det-name")?.textContent === "Structure");
    expect(structure?.querySelector(".cd-det-n")?.textContent).toBe("1");
    const box = structure?.querySelector<HTMLInputElement>(".cd-check");
    expect(box?.checked).toBe(true);
    if (box) {
      box.checked = false;
      box.dispatchEvent(new Event("change"));
    }
    expect(deps.detectors.peek()).toEqual(["fvg"]);
    await settle();
    expect(structure?.querySelector(".cd-det-n")?.textContent).toBe("—");
  });

  it("asks the analyst session and shows the last answer as text", async () => {
    const session = sessionFixture([
      { kind: "user", at: 1, text: "Where is the nearest liquidity?" },
      { kind: "assistant", at: 2, text: "<b>Above 1.1050</b>", provider: "Offline analyst (no language model)" },
    ]);
    const onOpenAnalyst = vi.fn();
    const { el } = build({ session, onOpenAnalyst, providerNote: () => "No model is configured." });
    (el.querySelector('.cd-tab[data-tab="ask"]') as HTMLButtonElement).click();
    await settle();
    const a = el.querySelector(".cd-a");
    expect(a?.textContent).toBe("<b>Above 1.1050</b>");
    expect(a?.querySelector("b")).toBeNull();
    expect(el.querySelector(".cd-by")?.textContent).toBe("Answered by Offline analyst (no language model)");
    (el.querySelector(".cd-chip") as HTMLButtonElement).click();
    expect(session.asked[0]).toBe("What invalidates this setup?\n(Chart: EURUSD 1h)");
    const setup = [...el.querySelectorAll("button")].find((b) => b.textContent === "Set up the analyst");
    setup?.click();
    expect(onOpenAnalyst).toHaveBeenCalledTimes(1);
  });

  it("reads the alert and signal routes when the alerts tab opens", async () => {
    const { el } = build();
    await settle();
    fetched = [];
    (el.querySelector('.cd-tab[data-tab="alerts"]') as HTMLButtonElement).click();
    await settle();
    await settle();
    const paths = fetched.map((u) => new URL(u).pathname).sort();
    expect(paths).toEqual(["/svc/alerts", "/svc/sig/fired"]);
    const sigUrl = fetched.find((u) => new URL(u).pathname === "/svc/sig/fired");
    expect(new URL(sigUrl ?? "http://x/").searchParams.get("n")).toBe("20");
    expect(el.querySelector('[data-pane="alerts"]')?.textContent).toContain("Nothing has fired today.");
    expect(el.querySelector('.cd-tab[data-tab="alerts"] .cd-n')?.textContent).toBe("0");
  });

  it("says the alert service is not answering, with a dash, when both routes fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const { el } = build({ open: signal(true), tab: signal<DrawerTab>("alerts") });
    await settle();
    await settle();
    expect(el.querySelector('[data-pane="alerts"]')?.textContent).toContain("The alert service is not answering.");
    expect(el.querySelector('.cd-tab[data-tab="alerts"] .cd-n')?.textContent).toBe("—");
  });
});
