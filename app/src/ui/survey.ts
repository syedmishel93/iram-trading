/**
 * The cross-market survey, as a desk.
 *
 * WHY THIS IS ITS OWN MODULE
 * `ui/strategy.ts` renders ONE study: one family, one instrument, one verdict.
 * A survey is a different shape — a panel of markets to fetch, two ranked
 * tables, and a recommendation keyed on the condition you are in — and bolting
 * it into an 850-line desk would have meant threading a second async loader and
 * a second result signal through everything already there. It mounts beside the
 * lab instead and shares nothing but the history service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE LAYOUT IS ARGUING
 *
 * The same argument the lab's layout makes, one level up. The first thing on the
 * page is what survived; the tables are underneath and most of their rows say
 * "not measured" or "indistinguishable from noise". That ordering is the product.
 *
 * A survey is the most seductive object in a trading terminal: seventy-eight
 * cells, sorted, with a green one at the top. Sorting is exactly what produces a
 * green one at the top on data with no edge in it — so the standing column, not
 * the return column, is what carries the colour, and a cell that has not earned
 * a standing is grey however large its number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT LOADS ITS OWN HISTORY, PER MARKET, AND SAYS WHAT ARRIVED
 *
 * Four markets means four fetches, and on a normal install some of them fail:
 * only the crypto legs come from Binance directly, and gold, the index and the FX
 * pair depend on what the backend is connected to. A survey that quietly ran on
 * whatever downloaded would report "agrees across markets" about two markets, and
 * agreement is the entire evidence. So every market gets a row in the load
 * report — loaded, short, or failed with the reason — and it is visible before the
 * run and after it.
 */

import { signal, renderEffect, type ReadSignal, type Signal } from "../core/signal";
import { clear, h } from "./dom";
import { pkWhy } from "./panelkit";
import { scheduleFrame } from "../core/frame";
import type { BarView } from "../chart/series";
import { DEFAULT_COSTS } from "../backtest/engine";
import { brokerCosts, spreadFraction, type BrokerSpec } from "../data/brokercosts";
import { DEFAULT_COSTS as ASSUMED } from "../backtest/engine";
import { REGIME_BLURB, REGIME_LABEL, type Regime } from "../backtest/regime";
import { FDR } from "../backtest/resample";
import {
  recommendFor,
  runSurvey,
  type Cell,
  type CellStanding,
  type Survey,
  type SurveyMarket,
} from "../backtest/survey";
import { BLOC_LABEL, DEFAULT_SELECTION, PANEL, panelCaveat } from "../backtest/universe";
import type { HistoryService } from "../data/history";
import { openCoverage } from "../data/sessions";

export interface SurveyDeskOptions {
  timeframe: Signal<string>;
  /** The lab's archive-backed history. A survey needs depth, not the screen. */
  history: HistoryService;
  /**
   * The condition the desk believes the market is in right now, when anything
   * does. Drives which recommendation opens first — and nothing else, because a
   * survey conditioned on a live label would change its own numbers as the label
   * moved.
   */
  currentRegime?: ReadSignal<Regime | null>;
}

export interface SurveyHandle {
  el: HTMLElement;
}

/** One market's fetch outcome, shown whether it succeeded or not. */
interface LoadRow {
  symbol: string;
  label: string;
  state: "waiting" | "loading" | "ok" | "short" | "failed" | "refused";
  bars: number;
  note: string;
}

const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const rr = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "—");
const pc = (v: number): string => `${(v * 100).toFixed(0)}%`;

/**
 * How many bars a survey asks for per market.
 *
 * Larger than the lab's default because the survey divides its trades three ways
 * by regime before it measures anything, and a cell needs forty. Five thousand
 * hourly bars is about seven months, which yields a usable sample in the two
 * common regimes and usually not in the third — which the table then says.
 */
export const SURVEY_DEPTH = 6_000;

const STANDING_LABEL: Readonly<Record<CellStanding, string>> = {
  holds: "Held",
  mixed: "Mixed",
  "one-market": "One market",
  "no-edge": "No edge",
  thin: "Not measured",
};

export function createSurvey(opts: SurveyDeskOptions): SurveyHandle {
  const selected = signal<readonly string[]>(DEFAULT_SELECTION);
  const rows = signal<readonly LoadRow[]>([]);
  const result = signal<Survey | null>(null);
  const running = signal(false);
  const progress = signal("");

  /*
   * WHAT THIS SURVEY CHARGES, AND WHAT THE BROKER CHARGES.
   *
   * This desk RANKS markets, so the hurdle decides the ranking — and it charges
   * `DEFAULT_COSTS`, a flat 2bp spread on every instrument. Measured against
   * this account that is about 4.8x the real spread on gold, which means a
   * market can be ranked below another for a cost it does not actually pay.
   *
   * FIXING THE INSTANCE IS NOT FIXING THE CLASS. v63.9 gave the Playbook a
   * measured-cost option; this desk's sweep takes ONE cost model for all
   * markets, so charging each its own spread is a change to `runSurvey`'s
   * signature rather than a toggle. What can be done now without pretending
   * otherwise is to SAY SO — show both numbers, and never let the measured one
   * silently replace the assumption, which is this project's stated rule.
   */
  /** Last price seen per market, filled by a run. Empty before the first.
      DECLARED ABOVE its reader: a `computed` here is EAGER, and this file's
      neighbours have thrown a temporal-dead-zone error at construction for
      exactly this ordering. `costGap` is a plain function and safe either way;
      the order costs nothing and removes the question. */
  const lastPrice = signal<Readonly<Record<string, number>>>({});

  /* Off unless asked. A hurdle that moved because a service answered is a
     ranking that changed for a reason nobody chose. */
  const useMeasured = signal(false);
  const brokerSpreads = signal<Readonly<Record<string, BrokerSpec>>>({});
  void brokerCosts().then((got) => {
    if (got.kind === "ok") brokerSpreads.set(got.value.specs);
  });

  /** One line naming the gap, or empty when there is nothing to compare. */
  const costGap = (): string => {
    const table = brokerSpreads();
    const names = Object.keys(table);
    if (names.length === 0) return "";
    const assumed = DEFAULT_COSTS.spread;
    const gaps: string[] = [];
    for (const key of names) {
      if (key.includes(".")) continue; // the broker-suffixed twin of one already counted
      const spec = table[key];
      if (!spec) continue;
      /* The spec's own spread in points needs a price to become a fraction, and
         this desk has no price for a market it has not fetched. `tick_value`
         and `point` give the ratio without one only when the contract is
         priced in the quote currency, which is not knowable here — so the
         comparison uses the LAST surveyed price when there is one, and is
         skipped otherwise rather than guessed. */
      const px = lastPrice()[key];
      if (px === undefined || !(px > 0)) continue;
      const measured = spreadFraction(spec, px);
      if (measured === null || !(measured > 0)) continue;
      gaps.push(`${key} ${(measured * 10_000).toFixed(2)}bp`);
    }
    if (gaps.length === 0) return "";
    return (
      `This survey charges a flat ${(assumed * 10_000).toFixed(2)}bp spread to every market. ` +
      `Your broker's measured spreads: ${gaps.join(", ")}. Where the assumption is harsher, a ` +
      "market may rank lower for a cost it does not pay. Only the Playbook can charge the " +
      "measured figure; this desk's sweep takes one cost model for all markets."
    );
  };

  const ranFor = signal("");
  const table = signal<"styles" | "rules">("styles");
  const focus = signal<Regime>("trend");

  const toggle = (symbol: string, on: boolean): void => {
    const now = selected.peek();
    if (on === now.includes(symbol)) return;
    selected.set(on ? [...now, symbol] : now.filter((s) => s !== symbol));
  };

  /**
   * Fetch one market, backfilling if the archive is short.
   *
   * Returns null rather than throwing: one dead vendor must not abandon the other
   * three markets, and "EURUSD did not load" is a line in the report rather than
   * an exception for the caller.
   */
  async function fetchMarket(symbol: string, tf: string, want: number): Promise<SurveyMarket | null> {
    const patch = (over: Partial<LoadRow>): void => {
      rows.set(rows.peek().map((r) => (r.symbol === symbol ? { ...r, ...over } : r)));
    };
    patch({ state: "loading", note: "fetching…" });

    try {
      let res = await opts.history.load(symbol, tf, { limit: want });
      if (res.bars.length < want) {
        patch({ note: `have ${res.bars.length}, reaching back…`, bars: res.bars.length });
        try {
          await opts.history.backfill(symbol, tf, want, {
            onProgress: (added) => patch({ note: `backfilled ${added}…` }),
          });
          res = await opts.history.load(symbol, tf, { limit: want });
        } catch {
          /* A vendor limit or a dead proxy. Survey what is held and say the
             window is short — the alternative is dropping the market, and a
             quietly absent market is what makes agreement counts a lie. */
        }
      }

      if (res.bars.length === 0) {
        patch({ state: "failed", bars: 0, note: "no bars from any source" });
        return null;
      }

      /**
       * Session-aware coverage, exactly as the lab does it.
       *
       * The archive measures coverage over wall-clock time, which is wrong by
       * construction for anything that closes: a complete year of EURUSD hourly
       * bars is "missing" every weekend and scores about 71%, so the engine's 98%
       * floor would refuse every non-crypto market in the panel — and the survey
       * would report a crypto-only result while showing four markets selected.
       */
      let coverage = 1;
      if (res.bars.length >= 2) {
        const first = (res.bars[0] as BarView).t;
        const last = (res.bars[res.bars.length - 1] as BarView).t;
        coverage = openCoverage(symbol, { from: first, to: last }, res.gaps);
      }

      patch({
        state: res.bars.length < want * 0.6 ? "short" : "ok",
        bars: res.bars.length,
        note: `${res.source} · ${pc(coverage)} covered`,
      });

      return {
        symbol,
        timeframe: tf,
        bars: res.bars,
        coverage,
        containsDemo: res.containsDemo,
      };
    } catch (err) {
      patch({ state: "failed", bars: 0, note: String(err).slice(0, 80) });
      return null;
    }
  }

  async function run(): Promise<void> {
    if (running.peek()) return;
    const symbols = selected.peek();
    if (symbols.length === 0) return;

    running.set(true);
    result.set(null);
    const tf = opts.timeframe.peek();

    rows.set(
      symbols.map((symbol) => ({
        symbol,
        label: PANEL.find((m) => m.symbol === symbol)?.label ?? symbol,
        state: "waiting" as const,
        bars: 0,
        note: "",
      })),
    );

    try {
      progress.set(`fetching ${symbols.length} markets…`);
      /* SEQUENTIALLY, not in parallel. Every one of these goes through the same
         proxy and the same rate limiter, and four simultaneous backfills is how
         you get four rate-limit refusals instead of four series. The wait is
         visible per market in the load report, which is the honest way to spend
         it. */
      const markets: SurveyMarket[] = [];
      for (const symbol of symbols) {
        const m = await fetchMarket(symbol, tf, SURVEY_DEPTH);
        if (m) markets.push(m);
      }

      if (markets.length === 0) {
        progress.set("no market produced bars — nothing to survey");
        return;
      }

      /* THE LAST CLOSE PER MARKET, so the cost comparison has the price its
         spread is a fraction OF. Without this the disclosure below could never
         appear — a control that cannot fire, which is the defect this session
         has already found three times. */
      lastPrice.set(
        Object.fromEntries(
          markets
            .map((m) => [m.symbol, m.bars[m.bars.length - 1]?.c ?? 0] as const)
            .filter(([, px]) => px > 0),
        ),
      );

      progress.set(`surveying ${markets.length} markets…`);
      // Yield twice through scheduleFrame so the button repaints before the
      // sweep blocks the thread. Raw rAF is never served in a background tab.
      await new Promise((res) => scheduleFrame(() => scheduleFrame(() => res(null))));

      /*
       * EACH MARKET CHARGED ITS OWN SPREAD, when the operator has asked for it.
       *
       * This desk RANKS markets, so one flat spread across all of them means a
       * market can rank below another for a cost it does not pay — 4.8x the real
       * figure on gold and 3.8x on EURUSD are not the same distortion, and one
       * number folds them into a single order.
       *
       * OFF BY DEFAULT and `undefined` for anything not measured: a market given
       * a guessed spread would be worse than one given the assumption, because
       * nothing on screen would say which it was.
       */
      const costsFor = (sym: string): typeof ASSUMED | undefined => {
        if (!useMeasured()) return undefined;
        const spec = brokerSpreads()[sym] ?? brokerSpreads()[`${sym}.S`];
        const px = lastPrice()[sym];
        if (!spec || px === undefined || !(px > 0)) return undefined;
        const measured = spreadFraction(spec, px);
        if (measured === null || !(measured > 0)) return undefined;
        return { ...ASSUMED, spread: measured };
      };

      const survey = runSurvey(markets, {
        costs: DEFAULT_COSTS,
        costsFor,
        riskPerTrade: 0.01,
      });
      /**
        * RECONCILE THE LOAD REPORT WITH WHAT THE SURVEY ACTUALLY USED.
        *
        * MEASURED, watching a real run: gold downloaded 6,000 bars and the report
        * showed it green and loaded — while the headline said "3 markets", because
        * `runSurvey` had refused it at 96% coverage against the engine's 98% floor.
        * Both statements were true and the panel contradicted itself, which is the
        * one thing a report whose entire job is "say what contributed" must not do.
        *
        * Downloading is not contributing. A market refused after it arrived gets
        * its own state and the survey's own reason, so the report reads the same
        * way the headline counts.
        */
      for (const skip of survey.skipped) {
        rows.set(
          rows.peek().map((r) =>
            r.symbol === skip.symbol ? { ...r, state: "refused" as const, note: skip.reason } : r,
          ),
        );
      }

      result.set(survey);
      ranFor.set(
        `${survey.markets.length} markets · ${tf} · ${survey.markets.reduce((a, m) => a + m.bars, 0).toLocaleString()} bars · ${survey.ms} ms`,
      );
      progress.set("");

      /* Open on the condition the desk says we are in, when it says anything.
         Falling back to whichever regime the history spent most of its time in
         beats defaulting to "trend" and implying a claim about now. */
      const live = opts.currentRegime?.peek() ?? null;
      if (live) focus.set(live);
      else {
        const busiest = (["trend", "chop", "volatile"] as const).reduce((best, reg) =>
          survey.exposure[reg] > survey.exposure[best] ? reg : best,
        );
        focus.set(busiest);
      }
    } finally {
      running.set(false);
    }
  }

  // ------------------------------------------------------------- panel ---

  const marketPicker = h("div", { class: "survey-picker" });
  for (const m of PANEL) {
    marketPicker.appendChild(
      h(
        "label",
        { class: "survey-pick", title: `${BLOC_LABEL[m.bloc]} — ${m.why}` },
        h("input", {
          type: "checkbox",
          checked: () => selected().includes(m.symbol),
          onchange: (e: Event) => toggle(m.symbol, (e.target as HTMLInputElement).checked),
        }),
        h("span", { class: "survey-pick-name", text: m.label }),
        h("span", { class: "survey-pick-bloc", text: BLOC_LABEL[m.bloc] }),
      ),
    );
  }

  const setupCard = h(
    "section",
    { class: "panel span-all" },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Which style works, and where" }),
      h("span", { class: "chip", text: () => opts.timeframe() }),
    ),
    h(
      "div",
      { class: "panel-body" },
      pkWhy(
        `Every shipped rule, run across every selected market, split by the condition it entered ` +
          `in. A cell is only called held when independent markets agree AND it survives a ` +
          `${pc(FDR)} false-discovery correction over every cell tested.`,
        "About this test",
      ),
      marketPicker,
      h("p", {
        class: "survey-caveat small",
        text: () => panelCaveat([...selected()]) ?? "",
      }),
      h(
        "div",
        { class: "alert-form-actions" },
        h("button", {
          class: "primary-btn",
          disabled: () => running() || selected().length === 0,
          text: () => (running() ? "Running…" : "Run survey"),
          onclick: () => void run(),
        }),
        h("span", { class: "muted small", text: () => progress() }),
      ),
      /* SHOWN ONLY WHEN THERE IS A REAL COMPARISON TO MAKE. With no broker spec
         synced there is nothing to say, and a permanent caveat nobody can act on
         is a line people learn to skip. */
      h("p", {
        class: "muted small survey-costgap",
        text: costGap,
        style: () => (costGap() === "" ? "display:none" : ""),
      }),
      /* THE CONTROL, not just the disclosure. Offering the comparison and no way
         to act on it is the "capability nobody can see" defect one step along:
         the operator can read that the hurdle is wrong and change nothing. */
      h(
        "label",
        {
          class: "muted small survey-costuse",
          style: () => (Object.keys(brokerSpreads()).length === 0 ? "display:none" : ""),
        },
        (() => {
          const box = h("input", { type: "checkbox" }) as HTMLInputElement;
          box.checked = useMeasured();
          box.onchange = () => {
            useMeasured.set(box.checked);
            /* A CHANGED HURDLE IS A CHANGED RANKING, so the old one is not left
               on screen under a new cost model. */
            result.set(null);
            progress.set(
              box.checked
                ? "Costs switched to your broker's measured spreads — run the survey again."
                : "Costs switched back to the assumed spread — run the survey again.",
            );
          };
          return box;
        })(),
        h("span", { text: " Charge each market my broker's measured spread" }),
      ),
    ),
  );

  // -------------------------------------------------------- load report ---

  const loadBody = h("div", { class: "survey-loads" });
  renderEffect(() => {
    const list = rows();
    clear(loadBody);
    for (const row of list) {
      loadBody.appendChild(
        h(
          "div",
          { class: "survey-load", "data-state": row.state },
          h("span", { class: "survey-load-name", text: row.label }),
          h("span", { class: "num survey-load-bars", text: row.bars > 0 ? row.bars.toLocaleString() : "—" }),
          h("span", { class: "survey-load-note", text: row.note }),
        ),
      );
    }
  });

  const loadCard = h(
    "section",
    { class: "panel span-all", hidden: () => rows().length === 0 },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "What loaded" }),
      h("span", { class: "chip", text: () => ranFor() }),
    ),
    h(
      "div",
      { class: "panel-body" },
      loadBody,
      pkWhy(
        "Agreement is counted only over markets that arrived. A market that failed is not a " +
          "market that agreed.",
        "What this can't tell you",
      ),
    ),
  );

  // ----------------------------------------------------------- headline ---

  const headlineCard = h(
    "section",
    {
      class: "panel verdict-card span-all",
      hidden: () => result() === null,
      "data-standing": () => {
        const s = result();
        if (!s) return "refused";
        if (s.blocked) return "refused";
        return s.held > 0 ? "survived" : "no-edge";
      },
    },
    h(
      "div",
      { class: "panel-body" },
      h("p", { class: "verdict-line", text: () => (result()?.held ?? 0) > 0 ? `${result()?.held} cells held` : "Nothing held" }),
      h("p", { class: "verdict-why", text: () => result()?.headline ?? "" }),
    ),
  );

  // ----------------------------------------------- the recommendation ---

  const regimeTabs = h("div", { class: "survey-tabs" });
  for (const reg of ["trend", "chop", "volatile"] as const) {
    regimeTabs.appendChild(
      h("button", {
        class: "survey-tab",
        "data-on": () => String(focus() === reg),
        title: REGIME_BLURB[reg],
        text: REGIME_LABEL[reg],
        onclick: () => focus.set(reg),
      }),
    );
  }

  const recCard = h(
    "section",
    { class: "panel span-all", hidden: () => result() === null },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "In this condition" }),
      h("span", {
        class: "chip",
        text: () => {
          const s = result();
          return s ? `${pc(s.exposure[focus()])} of tested bars` : "";
        },
      }),
    ),
    h(
      "div",
      { class: "panel-body" },
      regimeTabs,
      h("p", {
        class: "verdict-why",
        text: () => {
          const s = result();
          return s ? recommendFor(s, focus(), table()).text : "";
        },
      }),
    ),
  );

  // --------------------------------------------------------- the tables ---

  const tableToggle = h("div", { class: "survey-tabs" });
  for (const which of [
    { id: "styles" as const, label: "By style" },
    { id: "rules" as const, label: "By rule" },
  ]) {
    tableToggle.appendChild(
      h("button", {
        class: "survey-tab",
        "data-on": () => String(table() === which.id),
        text: which.label,
        onclick: () => table.set(which.id),
      }),
    );
  }

  const cellRow = (c: Cell): HTMLElement =>
    h(
      "div",
      { class: "survey-row", "data-standing": c.standing, title: c.verdict },
      h("span", { class: "survey-cell-name", text: c.label.split(" in a ")[0] ?? c.label }),
      h("span", { class: "survey-standing", text: STANDING_LABEL[c.standing] }),
      h("span", { class: "num", text: String(c.trades) }),
      h("span", { class: "num survey-r", text: rr(c.expectancyR) }),
      h("span", { class: "num", text: c.standing === "thin" ? "—" : rr(c.medianR) }),
      h("span", { class: "num", text: c.blocs === 0 ? "—" : `${c.agree}/${c.blocs}` }),
      h("span", { class: "num", text: c.standing === "thin" ? "—" : r2(c.q) }),
    );

  const tableBody = h("div", { class: "survey-table" });
  renderEffect(() => {
    const s = result();
    clear(tableBody);
    if (!s) return;

    const cells = (table() === "styles" ? s.styles : s.rules).filter((c) => c.regime === focus());
    tableBody.appendChild(
      h(
        "div",
        { class: "survey-row survey-head" },
        h("span", { text: table() === "styles" ? "Style" : "Rule" }),
        h("span", { text: "Standing" }),
        h("span", { class: "num", text: "Trades" }),
        h("span", { class: "num", text: "Pooled R" }),
        h("span", { class: "num", text: "Median R" }),
        h("span", { class: "num", text: "Blocs" }),
        h("span", { class: "num", text: "q" }),
      ),
    );
    for (const c of cells) tableBody.appendChild(cellRow(c));

    if (cells.length === 0) {
      tableBody.appendChild(h("p", { class: "muted small", text: "No cells in this condition." }));
    }
  });

  /** The per-market breakdown for whichever cell the reader opened. */
  const legsBody = h("div", { class: "survey-legs" });
  const legsFor = signal<string | null>(null);
  tableBody.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".survey-row:not(.survey-head)");
    if (!row) return;
    const name = row.querySelector(".survey-cell-name")?.textContent ?? "";
    legsFor.set(legsFor.peek() === name ? null : name);
  });

  renderEffect(() => {
    const s = result();
    const want = legsFor();
    clear(legsBody);
    if (!s || !want) return;

    const cells = table() === "styles" ? s.styles : s.rules;
    const cell = cells.find((c) => c.regime === focus() && (c.label.split(" in a ")[0] ?? "") === want);
    if (!cell) return;

    legsBody.appendChild(h("p", { class: "survey-legs-why", text: cell.verdict }));
    for (const leg of cell.legs) {
      legsBody.appendChild(
        h(
          "div",
          { class: "survey-leg", "data-qualifies": String(leg.qualifies) },
          h("span", { class: "survey-leg-name", text: leg.label }),
          h("span", { class: "survey-leg-bloc", text: leg.bloc ? BLOC_LABEL[leg.bloc] : "—" }),
          h("span", { class: "num", text: String(leg.trades) }),
          h("span", { class: "num survey-r", text: leg.trades === 0 ? "—" : rr(leg.expectancyR) }),
          h("span", {
            class: "muted small",
            text: leg.trades === 0 ? "no trades" : leg.qualifies ? "counts" : "too few to count",
          }),
        ),
      );
    }
  });

  const tableCard = h(
    "section",
    { class: "panel span-all", hidden: () => result() === null },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Every cell" }),
      h("span", { class: "chip", text: () => `${result()?.tested ?? 0} tested` }),
    ),
    h(
      "div",
      { class: "panel-body" },
      tableToggle,
      tableBody,
      legsBody,
      pkWhy(
        "Click a row for the per-market breakdown. Pooled R is trade-weighted — what it made per " +
          "trade. Median R is the middle market. The two disagreeing means one market is carrying " +
          "the cell, which is why both are here.",
        "How to read this table",
      ),
    ),
  );

  // ---------------------------------------------------------- caveats ---

  const caveatList = h("ul", { class: "warn-list" });
  renderEffect(() => {
    const s = result();
    clear(caveatList);
    for (const c of s?.caveats ?? []) caveatList.appendChild(h("li", { class: "warn-item", text: c }));
  });

  const caveatCard = h(
    "section",
    { class: "panel span-all", hidden: () => (result()?.caveats.length ?? 0) === 0 },
    h(
      "header",
      { class: "panel-head" },
      h("h3", { class: "panel-title", text: "Read this before acting on any of it" }),
    ),
    h("div", { class: "panel-body" }, caveatList),
  );

  const el = h(
    "div",
    { class: "view view-survey" },
    h(
      "div",
      { class: "view-head" },
      h("h2", { class: "view-title", text: "Condition survey" }),
      h("p", {
        class: "view-sub",
        text:
          "Which strategy, and which style, worked in which market condition — measured across " +
          "several markets at once so a result cannot be one market's character wearing a rule's name.",
      }),
    ),
    h("div", { class: "view-grid" }, setupCard, headlineCard, recCard, tableCard, loadCard, caveatCard),
  );

  return { el };
}
