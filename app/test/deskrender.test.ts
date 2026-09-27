// @vitest-environment jsdom
/**
 * A DESK THAT MOUNTS MUST NOT RENDER A DEFECT SIGNATURE.
 *
 * WHY THIS EXISTS
 *
 * "Check every desk" was being done by opening them in a browser and looking,
 * which is neither repeatable nor complete: the preview pane's own navigation
 * resisted reaching most of them, and this project already warns against
 * drawing conclusions from that pane. Clicking through 24 desks proves nothing
 * about the 25th, and proves nothing again next week.
 *
 * So the check is mechanical. Mount a desk with stub dependencies and read its
 * rendered text for the signatures this codebase has actually shipped:
 *
 *   NaN            a formatter handed an unset number. `metrics.ts` returns NaN
 *                  DELIBERATELY for "cannot be computed" and every formatter here
 *                  renders that as an em dash — so a literal "NaN" on screen means
 *                  one of them was missed.
 *   undefined      a binding reading a field that does not exist. `tsc` cannot
 *                  see it through an index signature or a cast.
 *   Infinity       a division that ran away and carried on. INFINITY IS A BUG.
 *   [object Object]  a value interpolated into a template. The Quant desk was
 *                  DEAD for months from exactly this — a function stringified by
 *                  its source into a URL, which `tsc` accepts as legal.
 *   0 of 0         a count of what REPORTED mistaken for a count of what exists,
 *                  the mistake `/svc/health` made and painted green.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * Mounting a desk with stubs is not using it. This catches a class of rendering
 * defect and says nothing about whether the numbers are right — that is what the
 * per-module tests are for. It is a floor, and a floor that did not exist.
 *
 * ONLY DESKS WITH A CHEAP DEPENDENCY SURFACE ARE HERE, each named. A desk
 * needing a chart engine and a live feed is not mounted rather than being
 * mounted wrongly: a stub that satisfies a call site and then disagrees with the
 * real thing has caused three defects in this project already.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createAccountStore } from "../src/core/account";

/*
 * A MOUNTED DESK FETCHES, AND A TEST THAT LETS IT IS NOT HERMETIC.
 *
 * The Calculator mounts the broker-cost card, which calls `brokerCosts()` on
 * construction. Under vitest the global `fetch` reaches a RUNNING GATEWAY — the
 * door this project has been burned through six times, and the reason
 * `tests/test_no_live_store.py` exists. That guard greps frontend tests for
 * `svcUrl` and cannot see a call made transitively by a desk being mounted, so
 * this file has to close the door itself.
 *
 * IT ALSO BROKE THE GATE. The fetch resolved AFTER the environment was torn
 * down, the resulting signal write scheduled a frame, and `requestAnimationFrame`
 * no longer existed — three unhandled rejections, every test passing, and vitest
 * exiting non-zero. That was the intermittent failure, and it was mine.
 */
const stubFetch = (): void => {
  globalThis.fetch = (() =>
    Promise.reject(new Error("no network in this test"))) as typeof fetch;
};

/** Let every promise the mount started settle INSIDE the test. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let realFetch: typeof fetch | undefined;
beforeEach(() => {
  realFetch = globalThis.fetch;
  stubFetch();
});
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

/** The signatures, with what each one means when it appears. */
const SIGNATURES: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bNaN\b/, what: "a formatter was handed an unset number; NaN should render as an em dash" },
  { re: /\bundefined\b/, what: "a binding read a field that does not exist" },
  { re: /\bInfinity\b/, what: "a division that ran away — INFINITY IS A BUG" },
  { re: /\[object [A-Z]/, what: "a value was interpolated into a template instead of being read" },
  { re: /\b0 of 0\b/, what: "a count of what reported, mistaken for a count of what exists" },
];

/** Every leaf's text, which is what a person actually reads. */
function renderedText(root: HTMLElement): string[] {
  return [...root.querySelectorAll("*")]
    .filter((e) => e.children.length === 0)
    .map((e) => (e.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

function scan(root: HTMLElement): { text: string; what: string }[] {
  const found: { text: string; what: string }[] = [];
  for (const t of renderedText(root)) {
    for (const s of SIGNATURES) {
      if (s.re.test(t)) found.push({ text: t.slice(0, 80), what: s.what });
    }
  }
  return found;
}

describe("a mounted desk renders no defect signature", () => {
  it("the Calculator", async () => {
    const { createCalculator } = await import("../src/ui/calculator");
    const kv = createKV(memoryRawStore());
    const desk = createCalculator({
      account: createAccountStore(kv),
      symbol: () => "EURUSD",
      lastPrice: () => 1.085,
      kv,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    // AND IT MUST HAVE RENDERED SOMETHING. A scan over an empty element passes
    // trivially, which is the "audit that parses nothing reports success"
    // failure this project keeps finding in its own tools.
    expect(renderedText(el).length).toBeGreaterThan(10);
  });

  it("the Calculator with NO price, which is the state it opens in", async () => {
    // The interesting case: a desk that has not been given a number yet is where
    // NaN and undefined actually reach the screen.
    const { createCalculator } = await import("../src/ui/calculator");
    const kv = createKV(memoryRawStore());
    const desk = createCalculator({
      account: createAccountStore(kv),
      symbol: () => "",
      lastPrice: () => 0,
      kv,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });

  it("the Calculator on an instrument the table does not hold", async () => {
    // An unknown symbol is the path where a lookup returns undefined and a
    // formatter prints it.
    const { createCalculator } = await import("../src/ui/calculator");
    const kv = createKV(memoryRawStore());
    const desk = createCalculator({
      account: createAccountStore(kv),
      symbol: () => "NOT-A-REAL-SYMBOL",
      lastPrice: () => 123.45,
      kv,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    expect(scan(el)).toEqual([]);
  });
});

describe("more desks, each with a dependency surface small enough to stub honestly", () => {
  /* EACH ONE IS NAMED AND ITS STUBS ARE REAL SHAPES, not `as any`. A stub that
     satisfies a call site and then disagrees with the definition has caused
     three defects in this project; where a desk needs a chart engine or a live
     feed it is left out rather than faked. */

  it("Sessions — a clock desk, which is where a bad date shows first", async () => {
    const { createSessions } = await import("../src/ui/sessions");
    const { signal } = await import("../src/core/signal");
    const desk = createSessions({
      symbol: signal("BTCUSDT"),
      timeframe: signal("1h"),
      bars: () => [],
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    expect(renderedText(el).length).toBeGreaterThan(5);
  });

  it("the Watchlist, with an EMPTY list — the state it opens in", async () => {
    const { createWatchlist } = await import("../src/ui/watchlist");
    const { signal } = await import("../src/core/signal");
    const desk = createWatchlist({
      symbol: signal("BTCUSDT"),
      kv: createKV(memoryRawStore()),
      open: () => undefined,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });

  it("the Screener, before anything has been scanned", async () => {
    const { createScreener } = await import("../src/ui/screener");
    const { signal } = await import("../src/core/signal");
    const desk = createScreener({
      timeframe: signal("1h"),
      onPick: () => undefined,
      kv: createKV(memoryRawStore()),
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  });

  it("the Data library, with an EMPTY archive", async () => {
    /* A REAL in-memory archive, not a stub: `createArchive(memoryBackend())` is
       the same implementation `history.test.ts` and `retention.test.ts` use, so
       nothing here can satisfy a call site and then disagree with the real one.
       The empty archive is the state a new install opens in. */
    const { createData } = await import("../src/ui/data");
    const { createArchive, memoryBackend } = await import("../src/store/barstore");
    const desk = createData({
      archive: createArchive(memoryBackend()),
      kv: createKV(memoryRawStore()),
      pinned: () => [],
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    expect(renderedText(el).length).toBeGreaterThan(5);
  });

  it("the Learn desk, with NOTHING recorded", async () => {
    /* `createLearnStore(kv)` is the real store on a memory KV. Nothing claimed
       and nothing resolved is where a rate over an empty population would print
       0% instead of refusing — the defect this project records twice. */
    const { createLearnDesk } = await import("../src/ui/learndesk");
    const { createLearnStore } = await import("../src/learn/store");
    const desk = createLearnDesk({
      store: createLearnStore(createKV(memoryRawStore())),
      symbol: () => "BTCUSDT",
      openSymbol: () => undefined,
      resolveNow: () => undefined,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    expect(renderedText(el).length).toBeGreaterThan(5);
  });

  it("the Journal, with NOTHING recorded and no prices", async () => {
    /* `createJournal(kv)` is the real store on a memory KV — no stub. The empty
       journal with a null entry, stop and target is the state that exercises
       every formatter with nothing to format, which is where NaN and undefined
       reach a screen. */
    const { createJournalDesk } = await import("../src/ui/journal");
    const { createJournal } = await import("../src/journal/store");
    const kv = createKV(memoryRawStore());
    const desk = createJournalDesk({
      journal: createJournal(kv),
      context: () => ({
        symbol: "BTCUSDT",
        timeframe: "1h",
        direction: "long",
        entry: null,
        stop: null,
        target: null,
        setupKind: null,
        score: null,
        gatesBlocking: [],
        source: "",
        quality: "",
      }),
      price: () => null,
      notify: () => undefined,
      kv,
    });
    const el = (desk as { el: HTMLElement }).el ?? (desk as unknown as HTMLElement);
    await settle();
    const found = scan(el);
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    expect(renderedText(el).length).toBeGreaterThan(5);
  });
});

describe("the scanner would catch what it is looking for", () => {
  /* PROVE THE GUARD. A scan that matches nothing reports a clean tree, which is
     the defect this project has found in four of its own audits. */
  it("catches each signature in a deliberately broken element", () => {
    const broken = document.createElement("div");
    broken.innerHTML = [
      "<span>Expectancy NaN R</span>",
      "<span>Symbol undefined</span>",
      "<span>Ratio Infinity</span>",
      "<span>[object Object]</span>",
      "<span>0 of 0 running</span>",
    ].join("");
    const found = scan(broken);
    expect(found).toHaveLength(5);
    expect(found.map((f) => f.what)).toEqual([
      expect.stringContaining("em dash"),
      expect.stringContaining("does not exist"),
      expect.stringContaining("INFINITY"),
      expect.stringContaining("interpolated"),
      expect.stringContaining("what reported"),
    ]);
  });

  it("does not fire on ordinary copy", () => {
    // "undefined" inside a word, and a real em dash where NaN belongs, must not
    // trip it — a checker that cries wolf is one people stop reading.
    const fine = document.createElement("div");
    fine.innerHTML = [
      "<span>Expectancy — R</span>",
      "<span>13 of 22 running</span>",
      "<span>undefinedness is not a word this app uses</span>",
    ].join("");
    // NONE of these fire, including "undefinedness" — I expected that one to be
    // a false positive and it is not: `undefined` needs a word boundary, and
    // there is none between "undefined" and "ness". The guard is tighter than I
    // credited it with, which is worth pinning rather than assuming again.
    expect(scan(fine)).toEqual([]);
  });
});
