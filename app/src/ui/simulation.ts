/**
 * THE SIMULATION DESK — what the machine found while nobody was watching.
 *
 * WHAT IT SHOWS AND WHY IN THIS ORDER
 *
 * The question this desk answers is "what would have happened to my money", so
 * the money leads: a balance, what it became, and the worst it got on the way.
 * The rules that produced it come second, and the model's opinion of them last
 * — because a model that beats nothing is still a result and belongs on screen,
 * and because putting it first would imply it decided something.
 *
 * FOUR STATES, EACH SAYING WHICH IT IS
 *
 *   not ready   node missing, engine unbuilt, or nothing held worth studying.
 *               All three are things the operator can fix and all three are the
 *               loop working correctly — rendering them as a failure is how a
 *               capability becomes something people switch off.
 *   running     a pass is in flight, and it says which market.
 *   empty       ready, never run. Offers the button rather than a blank panel.
 *   answered    results, with when they were measured.
 *
 * NOTHING HERE IS COMPUTED A SECOND TIME. The metrics, the account curve and
 * the ruin verdict all arrive from `lab-engine.mjs`, which IS the TypeScript in
 * `backtest/` compiled for Node. A desk that recomputed any of them would be a
 * second opinion about a number the loop already published, and the first
 * disagreement would be unattributable.
 */

import { h } from "./dom";
import { pkFold, pkWhy } from "./panelkit";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import { onShown } from "./cards/shown";
import { calibrationCard, liveBuckets, skillSentence } from "./cards/calibration";
import { longestRun, pathFor, sharedDomain, underwater, xFraction, yFraction, type Domain, type Point } from "./cards/plot";
import { deflatedSharpe } from "../study/stats";
import { intervalMs } from "../data/history";
import {
  autoResults,
  autoRunNow,
  autoStatus,
  type AutoResult,
  type AutoRule,
  type AutoStatus,
} from "../data/autorun";
import type { CalibrationBucket, RouterReport } from "../data/router";

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const money = (v: number): string =>
  Number.isFinite(v) ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
const fixedOr = (v: number | undefined, dp = 2): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(dp) : "—";
const day = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—");

/**
 * A count of BARS as a length of time, using the series' own bar size.
 *
 * "936 bars" is a number nobody can weigh. At 1h it is thirty-nine days, which
 * is a decision. The bar size is passed in rather than guessed, because
 * `intervalMs` answers one hour for anything it cannot read and a silent
 * default here would quietly rescale the one figure this is for.
 */
const barSpan = (bars: number, timeframe: string): string => {
  if (!(bars > 0)) return "none";
  const ms = bars * intervalMs(timeframe);
  const days = ms / 86_400_000;
  if (days < 1) return `${Math.round(ms / 3_600_000)} h`;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
};

const ago = (seconds: number): string => {
  if (!(seconds > 0)) return "never";
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

export interface SimulationOptions {
  /** So the desk can open on the market the chart is showing, when it has one. */
  readonly symbol: Signal<string>;
  /** And on the same BAR SIZE, which is half of what a series is. */
  readonly timeframe: Signal<string>;
}

export function createSimulation(opts: SimulationOptions): HTMLElement {
  const status = signal<AutoStatus | null>(null);
  const results = signal<readonly AutoResult[]>([]);
  const offline = signal("");
  const loading = signal(true);
  const picked = signal("");
  const note = signal("");

  /** The market being shown: an explicit pick, else the chart's, else the first. */
  const current = computed<AutoResult | null>(() => {
    const rows = results();
    if (rows.length === 0) return null;
    const want = picked();
    if (want) return rows.find((r) => `${r.sym} ${r.tf}` === want) ?? rows[0] ?? null;
    /* THE CHART'S SYMBOL AND BAR SIZE ARE THE DEFAULT AND NOT A LOCK — the
       same rule the Playbook took, for the same reason: reading what the
       machine found is a different activity from watching a market.

       BOTH, not just the symbol. Matching on the symbol alone picked whichever
       timeframe happened to come first: MEASURED on the running build, the
       chart was on BTCUSDT 1h and the desk opened on BTCUSDT 1d — a different
       series, a different base rate, and nothing on screen saying so. */
    const sym = opts.symbol().toUpperCase();
    const tf = opts.timeframe();
    return (
      rows.find((r) => r.sym.toUpperCase() === sym && r.tf === tf) ??
      rows.find((r) => r.sym.toUpperCase() === sym) ??
      rows[0] ??
      null
    );
  });

  /** Rules worth showing, best expectancy first. */
  const ranked = computed<readonly AutoRule[]>(() => {
    const r = current();
    if (!r) return [];
    return [...r.rules].sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR);
  });

  const best = computed<AutoRule | null>(() => ranked()[0] ?? null);

  /** Every rule's account curve as a % change on its start, in one list. */
  const allCurves = computed<{ rule: AutoRule; pts: Point[] }[]>(() =>
    ranked()
      .map((r) => ({
        rule: r,
        /* PER CENT OF THE START, NOT DOLLARS. Every rule here starts at the
           same balance so the two agree today — and they stop agreeing the
           moment the loop studies an account of a different size, at which
           point a dollar axis would compare two different questions. */
        pts: r.account.curve.map((p) => ({ x: p.t, y: ((p.equity - r.account.start) / r.account.start) * 100 })),
      }))
      .filter((c) => c.pts.length > 1),
  );

  /** One box for all of them. Scaled to itself, a flat rule looks like a good one. */
  const curveDomain = computed<Domain>(() => sharedDomain(allCurves().map((c) => c.pts)));

  const bestPts = computed<Point[]>(() => {
    const b = best();
    if (!b) return [];
    return b.account.curve.map((p) => ({ x: p.t, y: ((p.equity - b.account.start) / b.account.start) * 100 }));
  });

  const uwPts = computed<Point[]>(() => underwater(bestPts().map((p) => ({ x: p.x, y: p.y + 100 }))));
  const uwDomain = computed<Domain>(() => {
    const d = sharedDomain([uwPts()]);
    /* THE TOP OF A DRAWDOWN CHART IS ALWAYS ZERO. Letting it float would put a
       run that never fell more than 1% on the same picture as one that fell
       60%, and both would look equally survivable. */
    return d.ok ? { ...d, y1: 0 } : d;
  });

  /** Trades against expectancy: the picture of the search problem. */
  const scatterPts = computed<{ rule: AutoRule; p: Point }[]>(() =>
    ranked()
      .filter((r) => r.metrics.trades > 0 && Number.isFinite(r.metrics.expectancyR))
      .map((r) => ({ rule: r, p: { x: r.metrics.trades, y: r.metrics.expectancyR } })),
  );
  const scatterDomain = computed<Domain>(() => {
    const d = sharedDomain([scatterPts().map((s) => s.p)]);
    /* ZERO EXPECTANCY IS THE LINE THAT MATTERS, so it is always in frame. A
       chart of five losing rules that never shows zero implies the best of
       them made money. */
    if (!d.ok) return d;
    return { ...d, y0: Math.min(d.y0, 0), y1: Math.max(d.y1, 0), x0: 0 };
  });

  /**
   * What the search cost, charged rather than stated.
   *
   * THE UNITS ARE THE WHOLE RISK HERE. `deflatedSharpe` is defined on a
   * PER-TRADE Sharpe and takes a TRADE count; `metrics.sharpe` is annualised.
   * CLAUDE.md records an annualised 4.93 over 77 trades deflated with a
   * per-trade standard error and printed as though the search had been paid
   * for. `metrics.perTradeSharpe` exists so nothing here has to convert.
   *
   * `tries` counts every rule ATTEMPTED, including the ones that were refused:
   * a field that silently shrinks lowers the hurdle without telling anyone.
   */
  const hurdle = computed(() => {
    const r = current();
    const b = best();
    if (!r || !b) return null;
    const sharpe = b.metrics.perTradeSharpe;
    if (!Number.isFinite(sharpe)) return null;
    const tries = r.rules.length + r.refused.length;
    return { d: deflatedSharpe(sharpe, tries, b.metrics.trades), tries, rule: b };
  });

  const report = computed<RouterReport | null>(() => {
    const r = current()?.router;
    if (!r || r.ok !== true) return null;
    return r as RouterReport;
  });

  const cal = computed<readonly CalibrationBucket[]>(() => {
    const rep = report();
    return rep === null ? [] : liveBuckets(rep.calibration);
  });

  const refresh = (): void => {
    void Promise.all([autoStatus(), autoResults()]).then(([st, rs]) => {
      loading.set(false);
      if (st.kind === "offline") {
        offline.set(st.why);
        return;
      }
      offline.set("");
      status.set(st.value);
      if (rs.kind === "ok") results.set(rs.value.results);
    });
  };

  const runNow = (): void => {
    note.set("Asking for a pass…");
    void autoRunNow().then((a) => {
      if (a.kind === "offline") {
        note.set(a.why);
        return;
      }
      note.set(
        a.value.ok
          ? "A pass has started. It runs every rule over every market you hold enough of; this panel follows it."
          : a.value.why || "the pass was refused without saying why",
      );
      refresh();
      follow();
    });
  };

  /* WHILE A PASS IS RUNNING, FOLLOW IT. A progress line that never changes is
     indistinguishable from a hang — the note `ui/data.ts` records about an
     unchanging "Downloading…". Polling stops the moment the pass does. */
  let timer: ReturnType<typeof setInterval> | null = null;
  const follow = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (status()?.state.running !== true) {
        if (timer !== null) clearInterval(timer);
        timer = null;
        return;
      }
      refresh();
    }, 4000);
  };

  /** `barSpan` against whichever market is on screen. */
  const span = (bars: number): string => barSpan(bars, current()?.tf ?? "1h");

  /** One `<svg>` with a viewBox, built in the SVG namespace. */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = (cls: string, w: number, hgt: number): SVGSVGElement => {
    const el = document.createElementNS(SVG_NS, "svg");
    el.setAttribute("class", cls);
    el.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    el.setAttribute("preserveAspectRatio", "none");
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  /** A path inside one, kept in step with a series. */
  const svgPath = (parent: SVGSVGElement, cls: string, d: () => string): SVGPathElement => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", cls);
    parent.appendChild(p);
    renderEffect(() => {
      const v = d();
      /* REMOVED, not set to "": an empty `d` is a parse error in some engines
         and nothing in the rest, and "no data" and "a line at zero" are
         different facts. */
      if (v) p.setAttribute("d", v);
      else p.removeAttribute("d");
    });
    return p;
  };

  function fact(label: string, value: () => string): HTMLElement {
    return h(
      "div",
      { class: "sim-fact" },
      h("span", { class: "sim-fact-k", text: label }),
      h("span", { class: "sim-fact-v", text: value }),
    ) as HTMLElement;
  }

  // ------------------------------------------------------------- the head --
  const stateLine = computed(() => {
    if (loading()) return "Reading what the machine has found…";
    if (offline()) return offline();
    const st = status();
    if (!st) return "";
    if (!st.ready.ok) return st.ready.why;
    if (st.state.running) {
      const on = st.state.subject ? ` — on ${st.state.subject}` : "";
      return `A pass is running${on}. ${st.state.studied} of ${st.ready.subjects.length} markets done.`;
    }
    if (results().length === 0) return "Ready, and nothing studied yet.";
    return `${st.state.rules_run.toLocaleString()} rule runs across ${results().length} markets.`;
  });

  const runBtn = h("button", {
    class: "primary-btn",
    type: "button",
    text: () => (status()?.state.running === true ? "A pass is running…" : "Study everything now"),
    disabled: () => status()?.state.running === true || status()?.ready.ok !== true,
    onclick: runNow,
  });

  const head = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "The loop" }),
    h("p", { class: "sim-state", text: stateLine, "data-ready": () => String(status()?.ready.ok ?? false) }),
    h("div", { class: "sim-actions" }, runBtn),
    h("p", { class: "sim-note", text: note, style: () => (note() ? "" : "display:none") }),
    pkWhy(
      "It studies the markets you hold at least 800 bars of, and the archive IS the list — a list nobody writes " +
        "is a job that does nothing and reports itself healthy. Every rule in the shipped library is run over " +
        "each one, every setup they produced is recorded (not only the trades a backtest could take), and a model " +
        "is fitted forward-only on the result. It repeats every six hours while the terminal is open.",
      "What a pass actually does",
    ),
  );

  // ----------------------------------------------------------- the markets --
  const marketRows = h("div", { class: "sim-markets" }, () => {
    const frag = document.createDocumentFragment();
    for (const r of results()) {
      const key = `${r.sym} ${r.tf}`;
      const rep = r.router.ok === true ? (r.router as RouterReport) : null;
      const top = [...r.rules].sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR)[0];
      frag.appendChild(
        h(
          "button",
          {
            class: "sim-market",
            type: "button",
            "data-on": () => String(current() !== null && `${current()?.sym} ${current()?.tf}` === key),
            onclick: () => picked.set(key),
          },
          h("span", { class: "sim-market-sym", text: r.sym }),
          h("span", { class: "sim-market-tf", text: r.tf }),
          h("span", {
            class: "sim-market-end num",
            text: top ? money(top.account.end) : "—",
            "data-up": String((top?.account.end ?? 0) >= r.balance),
          }),
          h("span", {
            class: "sim-market-skill",
            "data-skill": rep === null ? "none" : rep.skill ? "yes" : "no",
            text: rep === null ? "no model" : rep.skill ? "learned" : "no skill",
          }),
        ),
      );
    }
    return frag as unknown as HTMLElement;
  });

  /* Every market's best rule on ONE axis. The per-market rows above answer
     "what did this one do"; this answers "is any of them different from the
     others", which no amount of reading down a column will. */
  const stripRows = h("div", { class: "sim-strip" }, () => {
    const frag = document.createDocumentFragment();
    const rows = results().map((r) => {
      const top = [...r.rules].sort((a2, b2) => b2.metrics.expectancyR - a2.metrics.expectancyR)[0];
      return { r, pctChange: top ? ((top.account.end - r.balance) / r.balance) * 100 : 0 };
    });
    /* ONE SCALE FOR ALL OF THEM, and it includes zero. A bar chart of
       percentage changes drawn to each row's own maximum says every market
       did equally well. */
    const widest = Math.max(1, ...rows.map((x) => Math.abs(x.pctChange)));
    for (const x of rows) {
      const share = (Math.abs(x.pctChange) / widest) * 50;
      frag.appendChild(
        h(
          "div",
          { class: "sim-strip-row" },
          h("span", { class: "sim-strip-k", text: `${x.r.sym} ${x.r.tf}` }),
          h(
            "span",
            { class: "sim-strip-track" },
            h("span", {
              class: "sim-strip-bar",
              "data-up": String(x.pctChange >= 0),
              /* Grown from the centre, because a negative and a positive of
                 the same size have to be the same length in opposite
                 directions or the picture flatters one of them. */
              style: `left:${(x.pctChange >= 0 ? 50 : 50 - share).toFixed(2)}%;width:${share.toFixed(2)}%`,
            }),
          ),
          h("span", {
            class: "sim-strip-v num",
            "data-up": String(x.pctChange >= 0),
            text: `${x.pctChange >= 0 ? "+" : ""}${x.pctChange.toFixed(1)}%`,
          }),
        ),
      );
    }
    return frag as unknown as HTMLElement;
  });

  const markets = h(
    "section",
    { class: "dd-panel", "data-on": () => String(results().length > 0) },
    h("h3", { class: "pf-sub", text: "Markets it studied" }),
    marketRows,
    h("h4", { class: "cal-h", text: "Best rule in each, on one scale" }),
    stripRows,
    h("p", {
      class: "sim-sub",
      text: () => {
        const st = status();
        const n = st?.ready.subjects.length ?? 0;
        const left = n - results().length;
        return left > 0 ? `${left} more are eligible and have not been studied yet.` : "";
      },
      style: () => ((status()?.ready.subjects.length ?? 0) > results().length ? "" : "display:none"),
    }),
  );

  /* THE CURVE IS BUILT WITH `createElementNS`, NOT `h`.
     `h` makes HTML elements, and an <svg> created in the HTML namespace has
     the right tag name and renders as nothing at all — a blank box with no
     error anywhere. `icons.ts` and `watchrail.ts` already take this route. */
  const curve = svg("sim-curve", 100, 30);
  svgPath(curve, "sim-curve-line", () => pathFor(bestPts(), sharedDomain([bestPts()]), 100, 30));

  // ----------------------------------------------------------- the account --
  const account = h(
    "section",
    { class: "dd-panel", "data-on": () => String(current() !== null) },
    /* THE PANEL NAMES ITS SUBJECT. "$545.67" is a figure about an unnamed
       series otherwise, and a figure that does not say what it was measured
       over is one nobody can argue with. */
    h("h3", {
      class: "pf-sub",
      text: () => {
        const r = current();
        return r ? `What it would have done to the account — ${r.sym} ${r.tf}` : "What it would have done to the account";
      },
    }),
    h(
      "div",
      { class: "sim-hero" },
      h("span", { class: "sim-hero-n", text: () => money(best()?.account.end ?? 0) }),
      h("span", {
        class: "sim-hero-sub",
        text: () => {
          const r = current();
          const b = best();
          if (!r || !b) return "";
          const change = ((b.account.end - r.balance) / r.balance) * 100;
          return `from ${money(r.balance)} at ${r.riskPct}% a trade — ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
        },
      }),
    ),
    curve,
    h(
      "div",
      { class: "sim-facts" },
      fact("Best rule", () => best()?.name ?? "—"),
      fact("Worst fall", () => pct(best()?.account.maxDrawdown ?? NaN)),
      fact("Trades", () => (best()?.metrics.trades ?? 0).toLocaleString()),
      fact("Window", () => {
        const r = current();
        return r ? `${day(r.from)} to ${day(r.to)}` : "—";
      }),
      fact("Bars, from", () => {
        const r = current();
        return r ? `${r.bars.toLocaleString()} from ${r.src}` : "—";
      }),
      /* THE FIGURE EVERY STRATEGY PITCH OMITS, in CLAUDE.md's own words. It
         was measured all along and thrown away at the render. */
      fact("Longest losing streak", () => String(best()?.metrics.maxConsecutiveLosses ?? 0)),
      fact("Longest time under water", () => span(best()?.metrics.maxTimeUnderWaterBars ?? 0)),
      fact("Peak, trough", () => {
        const b = best();
        return b ? `${money(b.account.peak)} / ${money(b.account.trough)}` : "—";
      }),
      fact("In the market", () => pct(best()?.metrics.exposure ?? NaN)),
    ),
    h("p", {
      class: "sim-ruin",
      text: () => best()?.account.why ?? "",
      style: () => (best()?.account.why ? "" : "display:none"),
    }),
    pkWhy(
      "One rule on one market over one window, with costs applied and the stop-versus-target order settled from " +
        "the bars themselves. It describes the past and promises nothing — and the best of twenty-five rules is " +
        "the best of a SEARCH, so part of what you are looking at is the search finding something rather than " +
        "the market containing it.",
      "What this can't tell you",
    ),
  );

  /* ======================================================================
     THE FIELD — every rule's curve, on one set of axes.

     The desk showed the winner alone, which is the shape of every strategy
     pitch ever made. MEASURED across the six markets studied: 7 of 25 rules
     profitable on BTCUSDT 1h, 6 of 25 on 15m, and the best rule on ETHUSDT 4h
     scoring 0.880R on THIRTEEN trades. Drawing one line out of twenty-five
     hides exactly the thing a reader needs: whether the winner is separated
     from the field or simply the top of a cloud.
     ====================================================================== */
  const fieldSvg = svg("sim-field", 100, 40);
  const fieldLines = document.createElementNS(SVG_NS, "g");
  fieldSvg.appendChild(fieldLines);
  const fieldZero = document.createElementNS(SVG_NS, "line");
  fieldZero.setAttribute("class", "sim-field-zero");
  fieldSvg.appendChild(fieldZero);
  svgPath(fieldSvg, "sim-field-best", () => pathFor(bestPts(), curveDomain(), 100, 40));

  renderEffect(() => {
    const d = curveDomain();
    const winner = best();
    while (fieldLines.firstChild) fieldLines.removeChild(fieldLines.firstChild);
    for (const c of allCurves()) {
      if (c.rule.id === winner?.id) continue; // drawn last, on top
      const path = document.createElementNS(SVG_NS, "path");
      /* The LOSERS are marked, because "most of these lost money" is the
         finding. Colour follows the standing, not the number. */
      path.setAttribute("class", c.rule.account.end >= c.rule.account.start ? "sim-field-up" : "sim-field-down");
      const v = pathFor(c.pts, d, 100, 40);
      if (v) path.setAttribute("d", v);
      fieldLines.appendChild(path);
    }
    /* BREAK-EVEN IS ALWAYS DRAWN, when it is in frame. A field of curves with
       no zero line is a picture in which every rule looks like it went up. */
    const y = 40 - yFraction(0, d) * 40;
    if (d.ok && y >= 0 && y <= 40) {
      fieldZero.setAttribute("x1", "0");
      fieldZero.setAttribute("x2", "100");
      fieldZero.setAttribute("y1", y.toFixed(2));
      fieldZero.setAttribute("y2", y.toFixed(2));
    } else {
      fieldZero.removeAttribute("y1");
    }
  });

  const field = h(
    "section",
    { class: "dd-panel", "data-on": () => String(allCurves().length > 1) },
    h("h3", { class: "pf-sub", text: "The winner against the field" }),
    fieldSvg,
    h("p", {
      class: "sim-sub",
      text: () => {
        const r = current();
        if (!r) return "";
        const up = r.rules.filter((x) => x.account.end >= x.account.start).length;
        const n = r.rules.length;
        return `${up} of ${n} rules ended above the balance they started with. Every curve is a percent change on the same axes — scaled to its own range, a rule that made five dollars draws the same line as one that doubled.`;
      },
    }),
    pkWhy(
      "One line is the shape of every strategy pitch ever made. The question this answers is whether the best " +
        "rule is SEPARATED from the others or just the top of a cloud — and with most of the field losing money, " +
        "a winner that sits inside the cloud is the search finding something rather than the market containing it. " +
        "The panel below puts a number on that.",
      "Why all of them, and not the best one",
    ),
  );

  /* ======================================================================
     WHAT THE SEARCH COST. Twenty-five rules were tried and the best was kept,
     so some of its score is the trying. `deflatedSharpe` prices that.
     ====================================================================== */
  const searchPanel = h(
    "section",
    { class: "dd-panel", "data-on": () => String(hurdle() !== null) },
    h("h3", { class: "pf-sub", text: "What the search cost" }),
    h(
      "div",
      { class: "sim-facts" },
      fact("Rules tried", () => String(hurdle()?.tries ?? 0)),
      fact("Best, per trade", () => {
        const x = hurdle();
        return x ? `${x.d.observed.toFixed(2)} Sharpe on ${x.d.observations} trades` : "—";
      }),
      fact("What trying costs", () => {
        const x = hurdle();
        return x ? `${x.d.hurdle.toFixed(2)} Sharpe` : "—";
      }),
      fact("Left over", () => {
        const x = hurdle();
        return x ? x.d.deflated.toFixed(2) : "—";
      }),
    ),
    h("div", {
      class: "sim-verdict",
      /* THE STANDING, NOT THE NUMBER: a positive remainder is a survivor, a
         negative one is the search, and that is what the colour says. */
      "data-skill": () => {
        const x = hurdle();
        if (x === null) return "none";
        return x.d.deflated > 0 ? "yes" : "no";
      },
      text: () => {
        const x = hurdle();
        if (x === null) return "";
        if (x.d.deflated > 0) {
          return (
            `${x.rule.name} survives the search: ${x.d.observed.toFixed(2)} per-trade Sharpe against a ` +
            `${x.d.hurdle.toFixed(2)} hurdle for the best of ${x.tries}, leaving ${x.d.deflated.toFixed(2)}. ` +
            "Survives is not the same as works — it means the result is bigger than what trying this many rules " +
            "finds in noise."
          );
        }
        return (
          `${x.rule.name} does NOT survive the search. Its ${x.d.observed.toFixed(2)} per-trade Sharpe over ` +
          `${x.d.observations} trades is below the ${x.d.hurdle.toFixed(2)} that the best of ${x.tries} rules ` +
          "scores on no edge at all. This is what a search of this width finds in a market with nothing in it."
        );
      },
    }),
    h("p", { class: "sim-sub", text: () => hurdle()?.d.working ?? "" }),
    pkWhy(
      "The Sharpe here is PER TRADE, which is the quantity the deflation is defined on — the annualised figure " +
        "elsewhere on this desk is a different number and feeding it to this correction is a defect this project " +
        "has already made once. The count of tries includes rules that were refused, because a field that " +
        "silently shrinks lowers the hurdle without telling anyone. The tries are treated as independent and are " +
        "not, so this deflates more than strictly necessary.",
      "The units, and what is being assumed",
    ),
  );

  /* ======================================================================
     UNDER WATER — the same run, asked a different question.

     An equity curve answers "did it make money" and this answers "could I
     have sat through it". They are not the same question and the second is
     the one that ends strategies: a rule can end the window up 9% having
     spent thirty-nine days below its last high.
     ====================================================================== */
  const uwSvg = svg("sim-uw", 100, 24);
  svgPath(uwSvg, "sim-uw-area", () => {
    const pts = uwPts();
    const d = uwDomain();
    const line = pathFor(pts, d, 100, 24);
    if (!line) return "";
    /* CLOSED BACK ALONG THE TOP, because the filled area IS the depth. A bare
       line at the bottom of an empty box reads as a floor rather than as a
       fall from the surface. */
    const y0 = (24 - yFraction(0, d) * 24).toFixed(2);
    return `${line}L100.00,${y0}L0.00,${y0}Z`;
  });

  const underwaterPanel = h(
    "section",
    { class: "dd-panel", "data-on": () => String(uwPts().length > 1) },
    h("h3", { class: "pf-sub", text: "How far below its last high it sat" }),
    uwSvg,
    h(
      "div",
      { class: "sim-facts" },
      fact("Deepest", () => pct(best()?.account.maxDrawdown ?? NaN)),
      fact("Longest spell", () => span(best()?.metrics.maxTimeUnderWaterBars ?? 0)),
      fact("Points under water", () => {
        const n = longestRun(uwPts(), -0.0001);
        return n > 0 ? `${n} of ${uwPts().length} closes` : "never";
      }),
      fact("Ulcer index", () => fixedOr(best()?.metrics.ulcerIndex)),
    ),
    pkWhy(
      "Zero is the top of this chart and always in frame, so a run that never fell 1% cannot be drawn to look " +
        "like one that fell 60%. The depth is a share of the peak rather than an amount of money, because the " +
        "question does not depend on the size of the account. The ulcer index is the root-mean-square of the " +
        "same series — one number for a shape, which is why it is beside the chart rather than instead of it.",
      "What is on the axes",
    ),
  );

  /* ======================================================================
     TRADES AGAINST EXPECTANCY — the search problem, as a picture.

     MEASURED: the winning rule on ETHUSDT 4h scores 0.880R on THIRTEEN
     trades. A table sorted by expectancy puts that at the top and says
     nothing; here it is a dot alone at the left edge, which is what it is.
     ====================================================================== */
  const scatterSvg = svg("sim-scatter", 100, 44);
  const scatterDots = document.createElementNS(SVG_NS, "g");
  const scatterZero = document.createElementNS(SVG_NS, "line");
  scatterZero.setAttribute("class", "sim-scatter-zero");
  scatterSvg.appendChild(scatterZero);
  scatterSvg.appendChild(scatterDots);

  renderEffect(() => {
    const d = scatterDomain();
    const winner = best();
    while (scatterDots.firstChild) scatterDots.removeChild(scatterDots.firstChild);
    for (const sp of scatterPts()) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", (xFraction(sp.p.x, d) * 100).toFixed(2));
      dot.setAttribute("cy", (44 - yFraction(sp.p.y, d) * 44).toFixed(2));
      dot.setAttribute("r", sp.rule.id === winner?.id ? "1.6" : "1");
      dot.setAttribute(
        "class",
        sp.rule.id === winner?.id ? "sim-dot-best" : sp.p.y >= 0 ? "sim-dot-up" : "sim-dot-down",
      );
      /* The only label anyone needs on a dot is which rule it is. A title is
         readable by a pointer AND by a screen reader, where text drawn into
         the SVG would be neither at this size. */
      const t = document.createElementNS(SVG_NS, "title");
      t.textContent = `${sp.rule.name} — ${sp.rule.metrics.trades} trades, ${sp.p.y.toFixed(3)}R`;
      dot.appendChild(t);
      scatterDots.appendChild(dot);
    }
    const y = 44 - yFraction(0, d) * 44;
    if (d.ok && y >= 0 && y <= 44) {
      scatterZero.setAttribute("x1", "0");
      scatterZero.setAttribute("x2", "100");
      scatterZero.setAttribute("y1", y.toFixed(2));
      scatterZero.setAttribute("y2", y.toFixed(2));
    } else {
      scatterZero.removeAttribute("y1");
    }
  });

  const scatterPanel = h(
    "section",
    { class: "dd-panel", "data-on": () => String(scatterPts().length > 2) },
    h("h3", { class: "pf-sub", text: "Expectancy against how often it traded" }),
    scatterSvg,
    h(
      "div",
      { class: "sim-axes" },
      h("span", { text: "few trades" }),
      h("span", { class: "sim-axes-mid", text: () => `break-even is the line` }),
      h("span", { text: "many" }),
    ),
    h("p", {
      class: "sim-sub",
      text: () => {
        const pts = scatterPts();
        if (pts.length === 0) return "";
        const thin = pts.filter((x) => x.rule.metrics.trades < 25).length;
        const b = best();
        return (
          `${thin} of ${pts.length} rules traded fewer than 25 times. The best here did so ` +
          `${b?.metrics.trades ?? 0} times — the fewer the trades, the more of the score can be luck, ` +
          "which is why the panel above charges for the search rather than taking the top of the table."
        );
      },
    }),
  );

  // ------------------------------------------------------------- the rules --
  const rulesTable = h(
    "section",
    { class: "dd-panel", "data-on": () => String(ranked().length > 0) },
    h("h3", { class: "pf-sub", text: "Every rule it ran" }),
    h(
      "div",
      { class: "sim-table" },
      h(
        "div",
        { class: "sim-row sim-head" },
        h("span", { text: "Rule" }),
        h("span", { class: "num", text: "Trades" }),
        h("span", { class: "num", text: "Win" }),
        h("span", { class: "num", text: "Per trade" }),
        h("span", { class: "num", text: "Balance" }),
        h("span", { class: "num", text: "Worst fall" }),
        h("span", { class: "num", text: "Streak" }),
        h("span", { class: "num", text: "Under water" }),
      ),
      () => {
        const frag = document.createDocumentFragment();
        for (const r of ranked()) {
          frag.appendChild(
            h(
              "div",
              { class: "sim-row", "data-dead": String(r.account.ruinedAt !== null) },
              h("span", { class: "sim-rule", text: r.name, title: `${r.style} · ${r.sample.found} setups found` }),
              h("span", { class: "num", text: String(r.metrics.trades) }),
              h("span", { class: "num", text: pct(r.metrics.winRate) }),
              /* EXPECTANCY IN R, NOT IN MONEY. R is the only measure that
                 compares across markets, and the money column beside it is
                 already this market's answer. */
              h("span", { class: "num", text: `${r.metrics.expectancyR.toFixed(3)} R` }),
              h("span", {
                class: "num",
                text: money(r.account.end),
                "data-up": String(r.account.end >= (current()?.balance ?? 0)),
              }),
              h("span", { class: "num", text: pct(r.account.maxDrawdown) }),
              /* Losses in a row and time spent below the last high: the two
                 numbers that decide whether a rule is SITTABLE, as opposed to
                 whether it is profitable. They are not the same question and
                 the table only answered the second. */
              h("span", { class: "num", text: String(r.metrics.maxConsecutiveLosses) }),
              h("span", { class: "num", text: span(r.metrics.maxTimeUnderWaterBars) }),
            ),
          );
        }
        return frag as unknown as HTMLElement;
      },
    ),
    h("p", {
      class: "sim-sub",
      text: () => {
        const r = current();
        if (!r || r.refused.length === 0) return "";
        return `${r.refused.length} could not be run: ${r.refused.map((x) => `${x.name} (${x.why})`).join("; ")}`;
      },
      style: () => ((current()?.refused.length ?? 0) > 0 ? "" : "display:none"),
    }),
  );

  // ------------------------------------------------------------ the model ---
  const model = h(
    "section",
    { class: "dd-panel", "data-on": () => String(current() !== null) },
    h("h3", { class: "pf-sub", text: "What a model makes of it" }),
    h(
      "div",
      { class: "sim-facts" },
      fact("Setups pooled", () => (current()?.pooled ?? 0).toLocaleString()),
      fact("Scored out of sample", () => (report()?.scored ?? 0).toLocaleString()),
      fact("Base rate", () => pct(report()?.baseRate ?? NaN)),
      fact("Measured", () => ago(current()?.at ?? 0)),
    ),
    h("div", {
      class: "sim-verdict",
      "data-skill": () => {
        const rep = report();
        return rep === null ? "none" : rep.skill ? "yes" : "no";
      },
      text: () => {
        const r = current();
        if (!r) return "";
        const rep = report();
        if (rep === null) return (r.router as { why: string }).why || "no model could be fitted on this market";
        return skillSentence(rep);
      },
    }),
    calibrationCard({
      buckets: () => cal(),
      note: () => {
        const rep = report();
        if (rep === null) return "";
        if (rep.thresholdBasis !== "calibration") {
          return "No bucket cleared the base rate with enough setups in it to mean anything, so there is no threshold to suggest.";
        }
        return `Above ${pct(rep.suggestedThreshold)} the observed rate clears the base rate — read off this curve, not assumed.`;
      },
    }),
    /* WHAT IT WAS ALLOWED TO KNOW, and WHERE it was scored. Both were
       published by the service from the first version and neither reached the
       screen — `foldSpans` exists precisely so a reader can check the
       forward-only claim instead of believing a docstring. */
    pkFold(
      "The model's inputs, and where each block was scored",
      h(
        "div",
        { class: "sim-folds" },
        h("p", {
          class: "sim-sub",
          text: () => {
            const rep = report();
            if (rep === null) return "";
            return `${rep.features.length} inputs: ${[...rep.features].sort().join(", ")}.`;
          },
        }),
        h("div", { class: "sim-table" }, () => {
          const frag = document.createDocumentFragment();
          const rep = report();
          if (rep === null) return frag as unknown as HTMLElement;
          frag.appendChild(
            h(
              "div",
              { class: "sim-fold-row sim-head" },
              h("span", { text: "Fold" }),
              h("span", { class: "num", text: "Trained on" }),
              h("span", { class: "num", text: "Scored on" }),
              h("span", { class: "num", text: "Rows" }),
            ),
          );
          rep.foldSpans.forEach((f, i) => {
            frag.appendChild(
              h(
                "div",
                { class: "sim-fold-row" },
                h("span", { text: `${i + 1}` }),
                h("span", { class: "num", text: `${day(f.trainFrom)} to ${day(f.trainTo)}` }),
                h("span", { class: "num", text: `${day(f.testFrom)} to ${day(f.testTo)}` }),
                h("span", { class: "num", text: `${f.trainRows.toLocaleString()} / ${f.testRows.toLocaleString()}` }),
              ),
            );
          });
          return frag as unknown as HTMLElement;
        }),
        h("p", {
          class: "sim-sub",
          text: () => {
            const rep = report();
            if (rep === null) return "";
            const bad = rep.foldSpans.filter((f) => f.testFrom < f.trainTo).length;
            return bad === 0
              ? "Every block was scored by a model trained only on what came before it — check the dates above rather than taking that on trust."
              : `${bad} fold(s) overlap their own training window, which would inflate every figure on this panel.`;
          },
        }),
      ),
    ),
    pkWhy(
      "Every setup from every rule, pooled, with the rule that produced it as one of the model's inputs. The " +
        "folds are contiguous and forward-only, so no block is ever scored by a model that has seen its future. " +
        "What it cannot tell you is whether any RULE has an edge — only whether, given that a rule fired, " +
        "anything measurable predicts which times it worked.",
      "How this was fitted, and what it can't say",
    ),
  );

  const el = h(
    "div",
    { class: "dd sim-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Simulation" }),
      h("p", {
        class: "view-sub",
        text: "What the terminal found on its own: every shipped rule, over every market you hold enough history for, with what it would have done to a real balance.",
      }),
    ),
    h(
      "div",
      { class: "dd-layout" },
      h("div", { class: "dd-primary" }, account, field, searchPanel, underwaterPanel, scatterPanel, rulesTable, model),
      h("div", { class: "dd-rail" }, head, markets),
    ),
  ) as HTMLElement;

  refresh();
  /* A desk is hidden rather than unmounted, so a pass that finished while you
     were elsewhere has to be picked up on the way back in. */
  onShown(el, () => {
    refresh();
    follow();
  });

  return el;
}
