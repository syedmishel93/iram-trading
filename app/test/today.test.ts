// @vitest-environment jsdom
/**
 * The Today workspace: the risk-config client, the plan, the scanned list and
 * the brief.
 *
 * The `/svc/risk/config` fixtures are the bodies `server/svc/risk.py`
 * `svc_risk_config` builds — GET is `{ok, config: risk_cfg(), defaults:
 * RISK.DEFAULTS}`, POST is `{ok, config: risk_cfg()}` — with `DEFAULTS`
 * copied key for key from `server/mishel_risk.py`. Every expected value is a
 * literal written from those fixtures; none is produced by the code under
 * test. The POST is checked by parsing what `fetch` was actually called with.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRiskConfig,
  parseRiskConfig,
  saveRiskConfig,
  validateLimits,
} from "../src/data/riskconfig";
import {
  addFocus,
  applyFocus,
  dropFocus,
  normaliseSymbol,
  readPlan,
  suggestFocus,
  TODAY_PLAN_SLOT,
  NO_EDITS,
  type FocusSuggestion,
} from "../src/ui/today/focus";
import { commitBlock, createPlan } from "../src/ui/today/plan";
import { readFocus, type ScanInputs } from "../src/ui/today/scanlist";
import { briefOf } from "../src/ui/today/brief";
import { greeting } from "../src/ui/briefing";
import { createKV, memoryRawStore, type KV } from "../src/store/kv";
import type { SetupView } from "../src/setup/ui";
import type { Verdict } from "../src/setup/gates";
import type { ScanRow } from "../src/scan/scanner";
import type { WatchSetup } from "../src/ui/watchrail";
import type { LiveEvent } from "../src/analysis/live";
import { flushFrames } from "../src/core/frame";

/** Let computeds settle (microtasks), then run the queued paints. */
async function paint(): Promise<void> {
  for (let k = 0; k < 3; k++) {
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
  }
}

/** `mishel_risk.DEFAULTS`, verbatim. */
const DEFAULTS = {
  max_daily_loss_R: 2.0,
  max_open_risk_R: 3.0,
  max_concentration_R: 2.0,
  max_trades_per_day: 5,
  max_risk_per_trade_pct: 1.0,
  consecutive_loss_limit: 3,
  cooldown_minutes: 60,
  day_reset_hour_utc: 0,
  block_when_unprotected: true,
};

/** GET after the operator once set three trades and 0.5%. */
const GET_BODY = {
  ok: true,
  config: { ...DEFAULTS, max_trades_per_day: 3, max_risk_per_trade_pct: 0.5 },
  defaults: DEFAULTS,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────── risk config ───

describe("parseRiskConfig", () => {
  it("reads the three limits from the service's GET body", () => {
    expect(parseRiskConfig(GET_BODY)).toEqual({ maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 });
  });

  it("reads the POST answer, which has no defaults", () => {
    expect(parseRiskConfig({ ok: true, config: DEFAULTS })).toEqual({
      maxTradesPerDay: 5,
      maxDailyLossR: 2,
      maxRiskPerTradePct: 1,
    });
  });

  it("keeps the daily loss positive", () => {
    expect(parseRiskConfig({ ok: true, config: { ...DEFAULTS, max_daily_loss_R: -3 } })?.maxDailyLossR).toBe(3);
  });

  it("refuses a body missing a limit rather than defaulting it", () => {
    const { max_trades_per_day: _drop, ...rest } = DEFAULTS;
    expect(parseRiskConfig({ ok: true, config: rest })).toBeNull();
    expect(parseRiskConfig({ ok: false, config: DEFAULTS })).toBeNull();
    expect(parseRiskConfig({ ok: true, config: { ...DEFAULTS, max_risk_per_trade_pct: "1" } })).toBeNull();
    expect(parseRiskConfig(null)).toBeNull();
  });
});

describe("loadRiskConfig / saveRiskConfig", () => {
  it("GETs /svc/risk/config", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { status: 200, ok: true, json: async () => GET_BODY } as unknown as Response;
    });
    const r = await loadRiskConfig();
    expect(new URL(seen[0] ?? "").pathname).toBe("/svc/risk/config");
    expect(r).toEqual({ state: "ok", limits: { maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 } });
  });

  it("says offline, with a reason, when an HTML 404 answers", async () => {
    vi.stubGlobal("fetch", async () => ({
      status: 404,
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }) as unknown as Response);
    const r = await loadRiskConfig();
    expect(r.state).toBe("offline");
    if (r.state === "offline") expect(r.reason).toBe("The risk service answered, but not with its limits. It may be an older build.");
  });

  it("POSTs the three limits under the server's own key names", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          config: { ...DEFAULTS, max_trades_per_day: 4, max_daily_loss_R: 2.5, max_risk_per_trade_pct: 0.75 },
        }),
      } as unknown as Response;
    });
    const r = await saveRiskConfig({ maxTradesPerDay: 4, maxDailyLossR: 2.5, maxRiskPerTradePct: 0.75 });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(new URL(c?.url ?? "").pathname).toBe("/svc/risk/config");
    expect(c?.init?.method).toBe("POST");
    expect(JSON.parse(String(c?.init?.body))).toEqual({
      max_trades_per_day: 4,
      max_daily_loss_R: 2.5,
      max_risk_per_trade_pct: 0.75,
    });
    expect(r).toEqual({ state: "ok", limits: { maxTradesPerDay: 4, maxDailyLossR: 2.5, maxRiskPerTradePct: 0.75 } });
  });

  it("refuses to call it saved when the server answers with other values", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200, ok: true, json: async () => ({ ok: true, config: DEFAULTS }) }) as unknown as Response);
    const r = await saveRiskConfig({ maxTradesPerDay: 4, maxDailyLossR: 2.5, maxRiskPerTradePct: 0.75 });
    expect(r.state).toBe("offline");
    if (r.state === "offline") {
      expect(r.reason).toBe("The risk service answered with different limits than were sent. Check them on the Risk desk.");
    }
  });

  it("says offline when nothing answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await saveRiskConfig({ maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 1 });
    expect(r.state).toBe("offline");
    if (r.state === "offline") expect(r.reason).toMatch(/^The risk service is not answering at .+\. Start it with: python run\.py$/);
  });
});

describe("validateLimits", () => {
  it("accepts sane limits and returns them as numbers", () => {
    expect(validateLimits({ maxTradesPerDay: "3", maxDailyLossR: "2", maxRiskPerTradePct: "0.5" })).toEqual({
      ok: true,
      limits: { maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 },
    });
  });

  it("names what is wrong, per field", () => {
    expect(validateLimits({ maxTradesPerDay: "2.5", maxDailyLossR: "", maxRiskPerTradePct: "25" })).toEqual({
      ok: false,
      errors: {
        maxTradesPerDay: "Whole trades only.",
        maxDailyLossR: "Enter a number.",
        maxRiskPerTradePct: "Between 0.01 and 10.",
      },
    });
    expect(validateLimits({ maxTradesPerDay: "0", maxDailyLossR: "-1", maxRiskPerTradePct: "1" })).toEqual({
      ok: false,
      errors: { maxTradesPerDay: "Between 1 and 50.", maxDailyLossR: "Between 0.25 and 20." },
    });
  });
});

// ─────────────────────────────────────────────────────────── focus list ───

const opp = (label: string, live: boolean): WatchSetup => ({ label, direction: "long", live });

describe("suggestFocus", () => {
  it("takes the scan's live reads, in the scan's order", () => {
    const m = new Map<string, WatchSetup>([
      ["SOLUSDT", opp("Long · Break of structure", true)],
      ["BTCUSDT", opp("Long · stand down", false)],
      ["ETHUSDT", opp("Long · armed", true)],
    ]);
    expect(suggestFocus({ opportunities: m, scanned: true, watchlist: ["XAUUSD"] })).toEqual({
      symbols: ["SOLUSDT", "ETHUSDT"],
      source: "scan",
      note: "Flagged by the scan: each has a live setup.",
    });
  });

  it("falls back to the watchlist, and says so", () => {
    const s = suggestFocus({ opportunities: new Map(), scanned: false, watchlist: ["BTCUSDT", "ETHUSDT"] });
    expect(s).toEqual({ symbols: ["BTCUSDT", "ETHUSDT"], source: "watchlist", note: "From your watchlist — not scanned yet." });
  });

  it("suggests nothing when it knows nothing", () => {
    const s = suggestFocus({ opportunities: new Map(), scanned: false, watchlist: null });
    expect(s.symbols).toEqual([]);
    expect(s.source).toBe("none");
  });
});

describe("focus edits", () => {
  const SUG = ["BTCUSDT", "ETHUSDT"];

  it("drops a suggestion and keeps it dropped", () => {
    const e = dropFocus(NO_EDITS, "BTCUSDT");
    expect(applyFocus(SUG, e)).toEqual(["ETHUSDT"]);
    /* The scan re-ranks: BTC comes back first. It stays dropped. */
    expect(applyFocus(["BTCUSDT", "SOLUSDT"], e)).toEqual(["SOLUSDT"]);
  });

  it("adds the operator's own, upper-cased, after the suggestions", () => {
    const r = addFocus(SUG, NO_EDITS, " xauusd ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(applyFocus(SUG, r.edits)).toEqual(["BTCUSDT", "ETHUSDT", "XAUUSD"]);
  });

  it("re-adding a dropped suggestion restores it", () => {
    const r = addFocus(SUG, dropFocus(NO_EDITS, "ETHUSDT"), "ETHUSDT");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.edits).toEqual({ added: [], dropped: [] });
  });

  it("dropping an added symbol removes it rather than recording a drop", () => {
    expect(dropFocus({ added: ["XAUUSD"], dropped: [] }, "XAUUSD")).toEqual({ added: [], dropped: [] });
  });

  it("refuses duplicates and things that are not symbols", () => {
    expect(addFocus(SUG, NO_EDITS, "btcusdt")).toEqual({ ok: false, reason: "BTCUSDT is already on the list." });
    expect(addFocus(SUG, NO_EDITS, "")).toEqual({ ok: false, reason: "Not a symbol — letters and digits, like ETHUSDT." });
    expect(normaliseSymbol("btc usdt")).toBeNull();
    expect(normaliseSymbol("brk.b")).toBe("BRK.B");
  });
});

// ──────────────────────────────────────────────────────────────── plan ───

const AT_0912 = new Date(2026, 8, 21, 9, 12, 30).getTime();
const NEXT_DAY = new Date(2026, 8, 22, 8, 0).getTime();
const OK_LIMITS = { maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 };

const SUGGEST: FocusSuggestion = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  source: "watchlist",
  note: "From your watchlist — not scanned yet.",
};

function mount(kv: KV, opts: { now?: number; online?: boolean; suggestion?: FocusSuggestion } = {}) {
  const saved: unknown[] = [];
  const plan = createPlan({
    suggestion: () => opts.suggestion ?? SUGGEST,
    kv,
    now: () => opts.now ?? AT_0912,
    loadConfig: async () =>
      opts.online === false
        ? { state: "offline", reason: "The risk service is not answering at http://127.0.0.1:8000. Start it with: python run.py" }
        : { state: "ok", limits: OK_LIMITS },
    saveConfig: async (l) => {
      saved.push(l);
      return { state: "ok", limits: l };
    },
  });
  document.body.replaceChildren(plan.el);
  return { plan, saved };
}

const commitBtn = (): HTMLButtonElement => document.querySelector(".td-commit") as HTMLButtonElement;
const text = (sel: string): string => (document.querySelector(sel)?.textContent ?? "").trim();

describe("commitBlock", () => {
  it("says why Commit cannot be pressed", () => {
    expect(commitBlock({ state: "loading" }, true, false)).toBe("Reading the risk governor's limits…");
    expect(commitBlock({ state: "offline", reason: "No answer." }, true, false)).toBe("Can't commit: No answer.");
    expect(commitBlock({ state: "ok", limits: OK_LIMITS }, false, false)).toBe("Fix the limits above to commit.");
    expect(commitBlock({ state: "ok", limits: OK_LIMITS }, true, false)).toBeNull();
  });
});

describe("the plan card", () => {
  it("prefills the limits from the governor's GET", async () => {
    const { plan } = mount(createKV(memoryRawStore()));
    await plan.ready;
    await paint();
    const vals = [...document.querySelectorAll<HTMLInputElement>(".td-limits input")].map((i) => i.value);
    expect(vals).toEqual(["3", "2", "0.5"]);
    expect(commitBtn().disabled).toBe(false);
  });

  it("disables Commit with the reason when the service is offline, and prefills nothing", async () => {
    const { plan } = mount(createKV(memoryRawStore()), { online: false });
    await plan.ready;
    await paint();
    expect(commitBtn().disabled).toBe(true);
    expect(text(".td-block")).toBe(
      "Can't commit: The risk service is not answering at http://127.0.0.1:8000. Start it with: python run.py",
    );
    const vals = [...document.querySelectorAll<HTMLInputElement>(".td-limits input")].map((i) => i.value);
    expect(vals).toEqual(["", "", ""]);
  });

  it("renders an empty focus list honestly", async () => {
    const { plan } = mount(createKV(memoryRawStore()), {
      suggestion: { symbols: [], source: "none", note: "Nothing to suggest yet: no scan and no watchlist. Add your own." },
    });
    await plan.ready;
    await paint();
    expect(text(".td-tags")).toBe("No symbols on the list yet.");
    expect(text(".td-note")).toBe("Nothing to suggest yet: no scan and no watchlist. Add your own.");
  });

  it("drops with × and adds with + add", async () => {
    const { plan } = mount(createKV(memoryRawStore()));
    await plan.ready;
    await paint();
    (document.querySelector('[aria-label="Drop BTCUSDT"]') as HTMLButtonElement).click();
    await paint();
    const input = document.querySelector(".td-add-in") as HTMLInputElement;
    input.value = "solusdt";
    input.dispatchEvent(new Event("input"));
    (document.querySelector(".td-add button") as HTMLButtonElement).click();
    await paint();
    expect(plan.focus()).toEqual(["ETHUSDT", "SOLUSDT"]);
    const syms = [...document.querySelectorAll(".td-plan-edit .td-tag-sym")].map((e) => e.textContent);
    expect(syms).toEqual(["ETHUSDT", "SOLUSDT"]);
  });

  it("commit posts the limits, persists the plan, and reloads read-only", async () => {
    const kv = createKV(memoryRawStore());
    const { plan, saved } = mount(kv);
    await plan.ready;
    await paint();
    (document.querySelector('[aria-label="Drop BTCUSDT"]') as HTMLButtonElement).click();
    await paint();
    await plan.commit();
    await paint();
    expect(saved).toEqual([{ maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 }]);
    expect(kv.get(TODAY_PLAN_SLOT)).toEqual({
      day: "2026-09-21",
      edits: { added: [], dropped: ["BTCUSDT"] },
      committed: { at: AT_0912, focus: ["ETHUSDT"], limits: { maxTradesPerDay: 3, maxDailyLossR: 2, maxRiskPerTradePct: 0.5 } },
    });

    /* A fresh mount on the same store: the plan reads back as decided. */
    const again = mount(kv);
    await again.plan.ready;
    await paint();
    expect(text(".td-done-at")).toBe("Committed at 09:12 — edit to change");
    expect((document.querySelector(".td-plan-edit") as HTMLElement).hidden).toBe(true);
    expect(again.plan.focus()).toEqual(["ETHUSDT"]);

    /* Edit unlocks the form. */
    const edit = [...document.querySelectorAll<HTMLButtonElement>(".td-done-head button")].find((b) => b.textContent === "Edit");
    edit?.click();
    await paint();
    expect((document.querySelector(".td-plan-edit") as HTMLElement).hidden).toBe(false);
  });

  it("does not carry yesterday's commit into today", async () => {
    const kv = createKV(memoryRawStore());
    const first = mount(kv);
    await first.plan.ready;
    await paint();
    await first.plan.commit();
    await paint();
    expect(readPlan(kv, NEXT_DAY)).toEqual({ day: "2026-09-22", edits: { added: [], dropped: [] }, committed: null });
    const next = mount(kv, { now: NEXT_DAY });
    await next.plan.ready;
    await paint();
    expect(document.querySelector(".td-done-at")).toBeNull();
  });

  it("does not commit when the governor refuses the write", async () => {
    const kv = createKV(memoryRawStore());
    const plan = createPlan({
      suggestion: () => SUGGEST,
      kv,
      now: () => AT_0912,
      loadConfig: async () => ({ state: "ok", limits: OK_LIMITS }),
      saveConfig: async () => ({ state: "offline", reason: "The risk service did not answer within 8s." }),
    });
    document.body.replaceChildren(plan.el);
    await plan.ready;
    await paint();
    await plan.commit();
    await paint();
    expect(kv.get(TODAY_PLAN_SLOT)).toBeNull();
    expect(text(".td-status")).toBe("Not committed. The risk service did not answer within 8s.");
  });
});

// ────────────────────────────────────────────────────── scanned list ───

const VERDICT: Verdict = {
  kind: "go",
  headline: "Clear to plan a long.",
  readLine: "The read is LONG, score 64, on 81% coverage.",
  blocking: [],
  unknown: [],
  passed: 8,
  total: 8,
  watchLevel: null,
  conflictNote: null,
  strategy: "bos",
};

const VIEW: SetupView = {
  verdict: VERDICT,
  plan: {
    direction: "long",
    entryLow: 3_010,
    entryHigh: 3_020,
    entry: 3_015,
    stop: 2_980,
    target1: 3_050,
    target2: 3_085,
    r: 35,
    stopAtrMultiple: 1.2,
    stopFrom: "structure",
    structureOutOfReach: null,
    drawnAt: 3_015,
  },
  stopAtrLive: 1.2,
  planProblem: null,
  size: null,
  gates: [],
  symbol: "ETHUSDT",
  timeframe: "1h",
  record: null,
  learned: null,
  exit: null,
  evidence: null,
  history: null,
};

const row = (patch: Partial<ScanRow> & { symbol: string }): ScanRow => ({
  lastPrice: 1,
  changePct: 0,
  quoteVolume: 0,
  result: null,
  closes: null,
  error: null,
  ...patch,
});

const inputs = (patch: Partial<ScanInputs> = {}): ScanInputs => ({
  chartSymbol: "ETHUSDT",
  setup: VIEW,
  scanRows: [
    row({ symbol: "BTCUSDT", opportunity: { ok: false, reason: "Moved 4.2× ATR past its level — wait for a retest." } }),
    row({ symbol: "SOLUSDT", error: "Binance answered HTTP 429." }),
  ],
  opportunities: new Map(),
  scanned: true,
  ...patch,
});

describe("readFocus", () => {
  it("reads the chart's symbol from the Setup card, with its checks", () => {
    expect(readFocus("ETHUSDT", inputs())).toEqual({
      symbol: "ETHUSDT",
      sees: "Clear to plan a long.",
      side: "long",
      checks: "8/8",
      why: "The read is LONG, score 64, on 81% coverage.",
      source: "chart",
      live: true,
    });
  });

  it("reads another symbol from the scan, with no checks it did not run", () => {
    expect(readFocus("BTCUSDT", inputs())).toEqual({
      symbol: "BTCUSDT",
      sees: "No setup",
      side: null,
      checks: null,
      why: "Moved 4.2× ATR past its level — wait for a retest.",
      source: "scan",
      live: false,
    });
  });

  it("shows a failed scan as a failure", () => {
    const r = readFocus("SOLUSDT", inputs());
    expect(r.sees).toBe("Scan failed");
    expect(r.why).toBe("Binance answered HTTP 429.");
  });

  it("never invents a read for a symbol nothing has scanned", () => {
    expect(readFocus("XAUUSD", inputs({ scanned: false }))).toEqual({
      symbol: "XAUUSD",
      sees: "not scanned yet",
      side: null,
      checks: null,
      why: "Open Opportunities to scan your list.",
      source: "none",
      live: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────── brief ───

const EVENT: LiveEvent = {
  id: "e1",
  time: AT_0912,
  symbol: "ETHUSDT",
  timeframe: "1h",
  kind: "structure-break",
  severity: "act",
  what: "Structure broke up on the last close.",
  because: "Close above the swing high at 3,002.",
  values: [],
  barTime: AT_0912,
};

describe("briefOf", () => {
  it("leads with the answer, then the danger, the change and the rest of the list", () => {
    const b = briefOf({
      symbol: "ETHUSDT",
      setup: VIEW,
      events: [EVENT],
      opportunities: new Map([
        ["ETHUSDT", opp("Long · gates pass", true)],
        ["SOLUSDT", opp("Long · Break of structure", true)],
      ]),
      scanned: true,
      unprotected: ["BTCUSDT"],
    });
    expect(b).toEqual({
      headline: "ETHUSDT: Clear to plan a long.",
      lines: [
        "The read is LONG, score 64, on 81% coverage.",
        "No stop on BTCUSDT — real risk is higher than shown.",
        "Latest: Structure broke up on the last close.",
        "Live setups elsewhere: SOLUSDT.",
      ],
    });
  });

  it("says what it does not have yet", () => {
    const b = briefOf({ symbol: "XAUUSD", setup: null, events: [], opportunities: new Map(), scanned: false, unprotected: [] });
    expect(b).toEqual({
      headline: "XAUUSD: not enough data yet.",
      lines: [
        "Needs at least 30 closed bars before it can be read.",
        "Nothing important has changed since this chart loaded.",
        "The rest of your list is not scanned yet.",
      ],
    });
  });
});

describe("greeting", () => {
  it("follows the operator's clock", () => {
    expect(greeting(new Date(2026, 8, 21, 9, 0).getTime())).toBe("Good morning.");
    expect(greeting(new Date(2026, 8, 21, 14, 0).getTime())).toBe("Good afternoon.");
    expect(greeting(new Date(2026, 8, 21, 21, 0).getTime())).toBe("Good evening.");
  });
});

// ───────────────────────────────────────────────── the composed desk ───

describe("the Briefing desk as the Today workspace", () => {
  it("mounts brief, plan and scanned list with the service offline and no shell extras", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const kv = createKV(memoryRawStore());
    const { createBriefing } = await import("../src/ui/briefing");
    const { createAccountStore } = await import("../src/core/account");
    const { signal } = await import("../src/core/signal");
    const desk = createBriefing({
      symbol: signal("ETHUSDT"),
      timeframe: signal("1h"),
      account: createAccountStore(kv),
      positions: signal([]),
      setup: signal<SetupView | null>(null),
      events: signal<readonly LiveEvent[]>([]),
      fires: signal([]),
      opportunities: signal<ReadonlyMap<string, WatchSetup>>(new Map()),
      scanned: () => false,
      regime: signal(null),
      nowMs: signal(AT_0912),
      onPick: () => undefined,
      onOpen: () => undefined,
      kv,
    });
    document.body.replaceChildren(desk.el);
    await desk.plan.ready;
    await paint();
    expect(text(".td-title")).toBe("Good morning. Here's what matters, and what you'll do about it.");
    expect(text(".td-head .card-who")).toBe("AI briefs · you plan");
    expect([...document.querySelectorAll(".td-card .card-who")].map((e) => e.getAttribute("data-who"))).toEqual(["ai", "you", "ai"]);
    expect(text(".td-brief-answer")).toBe("ETHUSDT: not enough data yet.");
    /* No `onAsk` from the shell: the button says so instead of doing nothing. */
    const ask = [...document.querySelectorAll<HTMLButtonElement>(".td-actions button")].find((b) => b.textContent === "Ask a follow-up");
    expect(ask?.disabled).toBe(true);
    /* No watchlist and no scan: nothing is suggested, and nothing is invented. */
    expect(text(".td-tags")).toBe("No symbols on the list yet.");
    expect(text(".td-scan-rows")).toBe("Nothing on your focus list. Add symbols in Your plan.");
    expect(commitBtn().disabled).toBe(true);
    expect(text(".td-block")).toMatch(/^Can't commit: The risk service is not answering at /);
  });
});
