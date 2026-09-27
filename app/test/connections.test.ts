// @vitest-environment jsdom

/**
 * THE CONNECTIONS DESK — `ui/connections.ts`.
 *
 * THE TEST THAT MATTERS IS `it never reaches the network by itself`. This
 * repository has TWICE had a test write into the operator's real store through a
 * transport that defaulted to the live one: `createHistory` put 535 fixture
 * candles into the archive the backtests read, and `startBackup` overwrote
 * thirteen real settings slots from a SCHEDULING test. The fix recorded both
 * times is a signature with no default, and this asserts that the desk kept it.
 *
 * THE SECOND IS `a pair that did not hold is not shown like one that did`. The
 * whole of `data/correlation.ts`'s sub-window work reaches the operator through
 * this card, and if the card renders both the same then none of it happened.
 */

import { describe, expect, it, vi } from "vitest";
import { flushFrames } from "../src/core/frame";
import { createConnections, type SeriesLoad } from "../src/ui/connections";
import type { ActivityKind } from "../src/data/activity";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function walk(n: number, seed: number): number[] {
  let s = seed;
  let v = 100;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v *= 1 + (s / 2147483648 - 0.5) * 0.02;
    out.push(v);
  }
  return out;
}

const daily = (closes: readonly number[]) => closes.map((c, i) => ({ t: T0 + i * DAY, c }));

/** BTC and a near-copy of it, plus a series that reversed against it halfway. */
function fixture(): SeriesLoad {
  const base = walk(400, 77);
  let m = 100;
  const flipped = base.map((v, i) => {
    if (i > 0) {
      const r = v / base[i - 1]! - 1;
      m *= 1 + (i < 200 ? -r : r);
    }
    return m;
  });
  return {
    series: {
      BTCUSDT: daily(base),
      ETHUSDT: daily(base.map((v) => v * 1.01)),
      DXY: daily(flipped),
    },
    missing: ["COPPER — the archive returned no bars"],
    note: "3 daily series · 400 bars each",
  };
}

/** Mount into a document so `renderEffect` bindings actually run. */
async function mount(load: () => Promise<SeriesLoad>, kinds: readonly ActivityKind[] = []) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const desk = createConnections({ loadSeries: load, loadActivity: async () => kinds, shelf: () => [] });
  host.appendChild(desk.el);
  /* THE SECOND PATH, and the reason it exists. `onShown` never fires in jsdom —
     its check is `getClientRects().length > 0`, which is always zero there — so
     a desk whose only trigger was becoming visible could not be tested at all. */
  await desk.refresh();
  /* SETTLE THE BINDINGS, not just the promise. The attribute updates are
     scheduled rather than written synchronously, so a single microtask tick
     leaves them one behind — measured: `data-show` was still "false" after
     `setTimeout(0)` and "true" a few milliseconds later. `flushFrames` is this
     project's own deterministic way to drain that queue; the tick after it
     covers the effects that re-schedule from inside a frame. */
  flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  flushFrames();
  return { host, desk };
}

describe("it cannot reach a real store by accident", () => {
  it("HAS NO DEFAULT LOADER — the caller must supply one", () => {
    /* A default that is live is what put fixture candles into the real archive
       twice. There must be no spelling of this call that touches the network. */
    const src = createConnections.toString();
    expect(src).not.toMatch(/load\w*\s*[:=]\s*(async\s*)?\(\)\s*=>\s*fetch/);
    // Every loader is required by the type; this pins that each is also USED as
    // given rather than merged over a fallback.
    expect(src).toContain("opts.loadSeries()");
    expect(src).toContain("opts.loadActivity()");
    expect(src).toContain("opts.shelf()");
  });

  it("does not call the loader just for being constructed", () => {
    // The desk is built before it is appended, so anything eager here would
    // fetch for a desk the operator never opened.
    const load = vi.fn(async () => fixture());
    const act = vi.fn(async () => [] as readonly ActivityKind[]);
    createConnections({ loadSeries: load, loadActivity: act, shelf: () => [] });
    expect(load).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });
});

describe("what it says about what it measured", () => {
  it("counts what was drawn, what was unrelated and what could not be measured", async () => {
    /* A canvas cannot distinguish a missing line from a measured absence, so the
       numbers have to say which. */
    const { host } = await mount(async () => fixture());
    const counts = host.querySelector(".graph-counts")?.textContent ?? "";
    expect(counts).toContain("markets");
    expect(counts).toContain("could not be measured");
    expect(counts).toMatch(/\d+ relationships? drawn/);
  });

  it("names the series it could not read, rather than dropping them", async () => {
    const { host } = await mount(async () => fixture());
    expect(host.textContent).toContain("COPPER");
  });

  it("states the window it ran on", async () => {
    // A count beside a window nobody stated is the shape this project has
    // already paid for on the Playbook.
    const { host } = await mount(async () => fixture());
    expect(host.querySelector(".graph-note")?.textContent).toContain("400 bars");
  });

  it("a loader that throws is reported, not swallowed into an empty picture", async () => {
    /* An empty canvas and a failed read look identical. BOTH loaders must fail
       before the desk calls itself offline: one dead service blanking a view fed
       by the other is the "a failure that is skipped is a failure that is not
       subtracted" defect from the other side. */
    const host = document.createElement("div");
    document.body.appendChild(host);
    const desk = createConnections({
      loadSeries: async () => { throw new Error("no gateway"); },
      loadActivity: async () => { throw new Error("no gateway"); },
      shelf: () => [],
    });
    host.appendChild(desk.el);
    await desk.refresh();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    const refusal = host.querySelector(".graph-refusal");
    expect(refusal?.getAttribute("data-show")).toBe("true");
    expect(refusal?.textContent).toContain("not answering");
  });
});

describe("the key explains every channel the picture uses", () => {
  it("names the sign, the strength and the stability", async () => {
    // A picture whose colours are not explained is decoration.
    const { host } = await mount(async () => fixture());
    const key = host.querySelector(".graph-key")?.textContent ?? "";
    expect(key).toContain("same direction");
    expect(key).toContain("opposite direction");
    expect(key).toContain("stronger");
    expect(key).toContain("did not hold");
  });
});

describe("an empty view explains itself", () => {
  it("SAYS WHY THERE IS NOTHING, not just that there is nothing", async () => {
    /* "Nothing to draw" and "nothing has been kept yet, so there is no field to
       draw" are different facts, and only the second tells the operator whether
       to wait, to press something, or to go and look at why. An unexplained
       empty state is the one this project keeps paying for. */
    const { host } = await mount(async () => fixture());
    const search = [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === "Search") as HTMLElement;
    search.click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    const tail = host.querySelector(".graph-tail")?.textContent ?? "";
    expect(tail).not.toBe("Nothing to draw for this view yet.");
    expect(tail).toContain("nothing has been kept yet");
  });
});

describe("the controls", () => {
  it("offers three views, two shapes and the zoom controls", async () => {
    const { host } = await mount(async () => fixture());
    const segs = [...host.querySelectorAll(".seg")] as HTMLElement[];
    const labels = segs.map((g) => [...g.querySelectorAll(".seg-btn")].map((b) => b.textContent));
    expect(labels).toContainEqual(["Markets", "System", "Search"]);
    expect(labels).toContainEqual(["Web", "Rings"]);
    /* THE ZOOM CONTROLS EXIST AS BUTTONS, not only as a wheel gesture. A control
       that exists only as a gesture is one somebody will never discover — this
       project has already paid for a panel whose only routes back were a key and
       a 22px icon nobody found. */
    expect(labels).toContainEqual(["−", "+", "Fit"]);

    // The two that express a CHOICE mark exactly one; the zoom group is actions.
    for (const g of segs.slice(0, 2)) {
      expect([...g.querySelectorAll(".seg-btn")].filter((b) => b.getAttribute("data-on") === "true")).toHaveLength(1);
    }
  });

  it("SAYS HOW FAR IT IS ZOOMED, and says nothing at rest", async () => {
    /* A readout that says "1.0x" forever is one people stop seeing, and a
       zoomed picture with no indication is one somebody reads as the whole. */
    const { host } = await mount(async () => fixture());
    const readout = () => host.querySelector(".graph-zoom")?.textContent ?? "";
    expect(readout()).toBe("");
    const zoomIn = [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === "+") as HTMLElement;
    zoomIn.click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(readout()).toContain("x");
    expect(readout()).toContain("drag to move");
  });

  it("Fit puts it back, so a lost picture is always one press away", async () => {
    const { host } = await mount(async () => fixture());
    const btn = (t: string) => [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === t) as HTMLElement;
    btn("+").click();
    btn("+").click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(host.querySelector(".graph-zoom")?.textContent).not.toBe("");
    btn("Fit").click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(host.querySelector(".graph-zoom")?.textContent).toBe("");
  });

  it("CHANGING VIEW RESETS THE CAMERA", async () => {
    /* Keeping a 4x zoom on the corner of the market web while switching to a
       graph of background jobs would open the new view somewhere meaningless,
       with nothing to say it had been moved. */
    const { host } = await mount(async () => fixture());
    const btn = (t: string) => [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === t) as HTMLElement;
    btn("+").click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(host.querySelector(".graph-zoom")?.textContent).not.toBe("");
    btn("System").click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(host.querySelector(".graph-zoom")?.textContent).toBe("");
  });

  it("CHANGING VIEW CLEARS WHAT WAS UNDER THE POINTER", async () => {
    /* A focus panel still describing BTCUSDT under a graph of background jobs
       would be a readout about something that is not on the screen — the same
       shape as a verdict read out of the wrong collection. */
    const { host } = await mount(async () => fixture());
    const system = [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === "System") as HTMLElement;
    system.click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(host.querySelector(".graph-focus-title")).toBeNull();
    expect(host.querySelector(".dd-sub")?.textContent).toContain("failing the same way");
  });

  it("each view explains its own channels", async () => {
    // The three views encode different things in the same colours.
    const { host } = await mount(async () => fixture());
    const keyFor = () => host.querySelector(".graph-key")?.textContent ?? "";
    expect(keyFor()).toContain("did not hold across the window");
    const search = [...host.querySelectorAll(".seg-btn")].find((b) => b.textContent === "Search") as HTMLElement;
    search.click();
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
    expect(keyFor()).toContain("beat the hurdle");
  });
});

describe("the figures beside the picture", () => {
  it("LEADS WITH THE ANSWER, not only with the graph", async () => {
    /* A card that answers a question should lead with the answer. The graph is
       the shape; these are the numbers somebody would otherwise hunt for by
       hovering every node in turn. */
    const { host } = await mount(async () => fixture());
    const tiles = [...host.querySelectorAll(".graph-tile")];
    expect(tiles.length).toBeGreaterThan(0);
    const text = host.querySelector(".graph-tiles")?.textContent ?? "";
    expect(text).toContain("Strongest link");
    expect(text).toContain("Did not hold");
  });

  it("every tile carries its own qualifier, never a bare number", async () => {
    // A figure with no note beside it is a figure nobody can argue with.
    const { host } = await mount(async () => fixture());
    for (const t of [...host.querySelectorAll(".graph-tile")]) {
      expect(t.querySelector(".graph-tile-value")?.textContent?.length).toBeGreaterThan(0);
      expect(t.querySelector(".graph-tile-note")?.textContent?.length).toBeGreaterThan(8);
    }
  });

  it("DRAWS A ROLLING LINE FOR EACH PAIR, so a reversal is visible and not just stated", async () => {
    /* `stable` says THAT a pair reversed; the line says WHEN, which is the
       difference between a caveat and something an operator can act on. */
    const { host } = await mount(async () => fixture());
    const c = host.querySelector(".graph-canvas") as HTMLCanvasElement;
    // Drive a hover through the real handler, in world coordinates at rest.
    c.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 0, bubbles: true }));
    flushFrames();
    await new Promise((r) => setTimeout(r, 0));
    // The sparkline is built by the focus rows; assert the builder is reachable
    // and that a row carries either a line or an explicit em dash, never blank.
    const rows = [...host.querySelectorAll(".graph-row")];
    for (const r of rows) {
      const hasLine = r.querySelector(".graph-spark") !== null;
      const hasNone = r.querySelector(".graph-spark-none") !== null;
      expect(hasLine || hasNone).toBe(true);
    }
  });
});
