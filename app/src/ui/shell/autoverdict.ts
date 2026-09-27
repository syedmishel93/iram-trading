/**
 * The recommendation card in AUTONOMOUS mode: what the terminal's own
 * discoveries say about THIS chart, right now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT ASKS THE ENGINE, IT DOES NOT ASK AGAIN
 *
 * Each row on the shelf is a `RuleSpec` that survived a search. Whether its
 * entry is true on the latest closed bar is answered by `backtest/firing.ts`,
 * which compiles the spec with the engine's own `compileSpec` and calls the
 * resulting strategy's `entry()` — the same function the backtest called. There
 * is no second reading of "RSI below 30" on this path, because a second reading
 * is a second answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN IT RE-CHECKS, AND WHAT IT NEVER DOES ON ITS OWN
 *
 * On BAR CLOSE, and on demand. The pass depends on `closedBarCount` and reads
 * the bars with `peek()`, deliberately: a dependency on `bars()` would re-run
 * the whole field on every incoming tick, and the answer cannot change until a
 * bar closes anyway — everything the engine judges is judged on closes.
 *
 * A SWEEP RUNS ITSELF ONCE PER MARKET (v60.2), which the owner chose over a
 * button after being shown the cost. It is twenty to thirty seconds of
 * eighty-five studies, so the trigger is fenced:
 *
 *   VISIBLE, not merely mounted. Both panes of this card stay in the DOM and
 *     are switched with `display`, so `isConnected` is true for the autonomous
 *     pane while the operator is looking at the manual one. `isShown` measures
 *     rectangles — the guard v59.2's cards were fixed to use after one of them
 *     polled Binance from behind a closed panel.
 *   SETTLED. The pane must stay visible for `SETTLE_MS` first, so paging
 *     through symbols does not queue a sweep per symbol.
 *   ONCE. A market that has been searched is not searched again, INCLUDING
 *     when the search found nothing — "nothing survived" is an answer, and
 *     re-running it would spend the evidence again for the same result.
 *   NEVER TWICE AT ONCE. The driver refuses a second run; switching market
 *     while one is in flight cancels it rather than racing it.
 *   REFUSABLE. The toggle is on the card, not in a settings page, because a
 *     thing that spends thirty seconds of CPU unbidden must be visibly
 *     switchable by the person whose CPU it is.
 *
 * A bar closing still re-checks the SHELF — that is cheap, and it is what the
 * owner chose — but it never starts a new search.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE PLACES AN ORDER
 *
 * There is no execution path in this product — `grep order_send` over `server/`
 * returns nothing. A proposal here is a plan to read, answer and size by hand,
 * exactly like the Setup card's. "Arm" does not change that: see `arming.ts`
 * for what the server can and cannot watch, and why the button is usually off.
 */

import { computed, renderEffect, signal, type ReadSignal } from "../../core/signal";
import { scheduleFrame } from "../../core/frame";
import { clear, h } from "../dom";
import { pkWhy } from "../panelkit";
import { ARM_LIMITS, ARM_WHERE, armable } from "../../backtest/arming";
import { contextFor, firesOnLastClosed, type Firing } from "../../backtest/firing";
import { keyOf, type Discovered } from "../../backtest/discovered";
import { liveFor, type ShelfStore } from "../../backtest/shelfstore";
import { addAlert } from "../../data/pricealerts";
import type { BarView } from "../../chart/series";
import { createSayRow, type SayContext } from "./yoursay";
import { fmtPx, num } from "./format";
import { autoPlan } from "../model/autoplan";
import { isShown, onShown } from "../cards/shown";
import type { Account } from "../../core/account";
import type { GateEnvironment } from "../../setup/gates";
import type { Signal } from "../../core/signal";
import type { SweepDriver } from "../model/sweepdriver";

/**
 * The same narrow slice `createSayRow` takes, and for the same reason: this
 * panel reads the instrument and writes the operator's answer, and needs
 * nothing else from the shell. `mountShell` passes its whole `ShellContext`,
 * which satisfies it structurally.
 */
export type AutoVerdictContext = SayContext;

export interface AutoVerdictDeps {
  readonly shelf: ShelfStore;
  /** The chart's window. Read on bar close only — see the header. */
  readonly bars: ReadSignal<readonly BarView[]>;
  readonly closedBarCount: ReadSignal<number>;
  readonly onOpenStrategy: () => void;
  readonly onUse: () => void;
  readonly onAdjust: () => void;
  readonly now?: () => number;
  /**
   * The search, shared with the Strategy desk — see `ui/model/sweepdriver.ts`.
   * Optional so this card can still be built without one, in which case it
   * offers the desk instead of searching, as it did before v60.2.
   */
  readonly sweep?: SweepDriver;
  /** Whether a market may be searched without being asked. Persisted. */
  readonly autoSearch?: Signal<boolean>;
  /** The one account every size is computed from — `core/account.ts`. */
  readonly account?: () => Account;
  /** Live ATR, for the stop check. */
  readonly atr?: () => number;
  /**
   * The market's readings, from the Setup model, so both modes of this card
   * are judged by ONE set — see `GateEnvironment`.
   */
  readonly env?: () => GateEnvironment | null;
  /** Test seam for the settle delay. */
  readonly settleMs?: number;
}

/**
 * How long the pane must stay visible before a search starts by itself.
 *
 * Long enough that flicking through a watchlist does not start one per symbol;
 * short enough that a deliberate switch to Autonomous feels like it acted.
 */
export const SETTLE_MS = 1_500;

interface Checked {
  readonly row: Discovered;
  readonly firing: Firing;
}

const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const sR = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
/** One figure with its label, the same shape the dock verdict uses. */
const cell = (k: string, v: string, tone: string | null): HTMLElement =>
  h(
    "span",
    { class: "dv-cell", ...(tone ? { "data-tone": tone } : {}) },
    h("span", { class: "dv-k", text: k }),
    h("span", { class: "dv-v num", text: v }),
  );

/**
 * What to size against when the shell did not pass an account.
 *
 * Only reachable from a test that builds this card standalone; `mountShell`
 * always passes the one account `core/account.ts` owns. Stated rather than
 * defaulted silently, because a size computed against an invented equity is
 * the class of defect CLAUDE.md records for `contractSize`.
 */
const FALLBACK_ACCOUNT = { currency: "USD", balance: 0, equity: 0, leverage: 1, riskPct: 0 };

/** Appends when there is something to append. `h` refuses a null child. */
const appendMaybe = (host: HTMLElement, node: HTMLElement | null): void => {
  if (node) host.appendChild(node);
};

const clock = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function createAutoVerdict(ctx: AutoVerdictContext, deps: AutoVerdictDeps): HTMLElement {
  const { state } = ctx;
  const now = deps.now ?? Date.now;
  /** Bumped by "Check again" — the on-demand half of the operator's choice. */
  const rev = signal(0);
  /** The last arm attempt, by row key, so the answer appears where it was asked. */
  const armed = signal<{ readonly key: string; readonly ok: boolean; readonly text: string } | null>(null);
  const arming = signal<string | null>(null);

  const checked = computed((): { readonly rows: readonly Checked[]; readonly closed: number } => {
    rev();
    const sym = state.symbol();
    const tf = state.timeframe();
    const closed = deps.closedBarCount();
    const rows = liveFor(deps.shelf.rows(), sym, tf);
    if (rows.length === 0) return { rows: [], closed };
    /* PEEK: the check re-runs on bar close, not on every tick. See the header. */
    const bars = deps.bars.peek();
    const engineCtx = contextFor(bars);
    return { rows: rows.map((row) => ({ row, firing: firesOnLastClosed(row.spec, engineCtx, closed) })), closed };
  });

  /** Firing rows, most edge-after-the-search first. The first is the proposal. */
  const firing = computed((): readonly Checked[] =>
    checked()
      .rows.filter((c) => c.firing.kind === "fires")
      .sort((a, b) => b.row.deflated - a.row.deflated),
  );

  const lead = computed((): Checked | null => firing()[0] ?? null);

  /*
   * `entryPriceOf` IS GONE, and this note is why it must not come back.
   *
   * It returned the SIGNAL BAR'S CLOSE as the entry. The backtest holds a
   * signal and fills it at the next bar's open charged half the spread plus
   * slippage, so that number was a price the engine never paid, printed
   * directly above the out-of-sample figures the engine earned. The fill now
   * comes from `autoPlan`, through the engine's own `modelledFill`.
   */

  async function arm(row: Discovered): Promise<void> {
    const key = keyOf(row);
    const can = armable(row.spec);
    if (!can.ok || arming.peek() !== null) return;
    arming.set(key);
    try {
      const res = await addAlert({ sym: row.symbol, op: can.op, price: can.price, note: can.note });
      if (res.ok) {
        deps.shelf.arm(key, now());
        armed.set({ key, ok: true, text: `Armed: ${row.symbol} ${can.op} ${can.price}. ${ARM_WHERE}` });
      } else {
        armed.set({ key, ok: false, text: `Not armed: ${res.reason}` });
      }
    } finally {
      arming.set(null);
      rev.update((n) => n + 1);
    }
  }

  const armBlock = (c: Checked): HTMLElement => {
    const key = keyOf(c.row);
    const can = armable(c.row.spec);
    const result = armed();
    const block = h("div", { class: "av-arm" });
    block.appendChild(
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "arm",
        disabled: !can.ok || arming() !== null,
        title: can.ok ? ARM_WHERE : can.why,
        text: arming() === key ? "Arming…" : "Arm",
        onclick: () => void arm(c.row),
      }),
    );
    block.appendChild(
      h("p", {
        class: "av-arm-why small",
        "data-armable": String(can.ok),
        text: can.ok
          ? `Arming stores a server-side price alert for ${can.condition}. ${ARM_LIMITS}`
          : `Cannot be armed. ${can.why}`,
      }),
    );
    if (result && result.key === key) {
      block.appendChild(h("p", { class: "av-arm-said small", "data-ok": String(result.ok), text: result.text }));
    }
    return block;
  };

  const figures = (row: Discovered): HTMLElement =>
    h(
      "p",
      { class: "av-figs muted small" },
      h("span", {
        text:
          `${row.trades} out-of-sample trades · ${sR(row.expectancy)} a trade · ${r2(row.sharpe)} Sharpe a trade · ` +
          `${r2(row.deflated)} left after a ${r2(row.hurdle)} hurdle over ${row.trials.toLocaleString()} configurations, ` +
          `on ${row.bars.toLocaleString()} bars.`,
      }),
    );

  /**
   * The switch for the automatic search.
   *
   * On the card rather than in Settings, because it is the control for
   * something that spends thirty seconds of this machine's CPU without being
   * asked, and a preference like that belongs where its effect is visible.
   */
  const autoToggle = (): HTMLElement | null => {
    const pref = deps.autoSearch;
    if (!pref || !deps.sweep) return null;
    return h(
      "label",
      { class: "av-auto small" },
      h("input", {
        type: "checkbox",
        "data-act": "auto-search",
        checked: () => pref(),
        onchange: (e: Event) => pref.set((e.target as HTMLInputElement).checked),
      }),
      h("span", {
        text: () =>
          pref()
            ? "Searching a new market by itself, once each. Uncheck to search only when you ask."
            : "Searching only when you ask.",
      }),
    );
  };

  /**
   * THE PLAN, and it is the same shape the Manual card shows.
   *
   * Direction, the fill, the rule's own stop and target, the size that risks
   * what the account says, and the eight checks — built by
   * `ui/model/autoplan.ts`, which reuses `sizePosition` and `gatesFor` whole
   * and deliberately does NOT reuse `buildPlan` (it would re-price the rule's
   * stop and force its target to 1R).
   */
  const planBlock = (c: Checked): HTMLElement => {
    if (c.firing.kind !== "fires") return h("div", { class: "av-plan" });
    const p = autoPlan({
      row: c.row,
      signal: c.firing.signal,
      index: c.firing.index,
      bars: deps.bars.peek(),
      account: deps.account ? deps.account() : FALLBACK_ACCOUNT,
      atr: deps.atr ? deps.atr() : Number.NaN,
      env: deps.env ? deps.env() : null,
    });

    if (!p.ok) return h("p", { class: "av-refused small", text: p.refusal });

    const sized = p.size?.ok === true ? p.size : null;
    return h(
      "div",
      { class: "av-plan-wrap" },
      h(
        "div",
        { class: "av-plan" },
        cell("Entry", p.entry === null ? "—" : fmtPx(p.entry), null),
        cell("Stop", fmtPx(p.stop), "neg"),
        cell(
          "Target",
          p.target === null ? (p.rr === null ? "exit rule" : "—") : `${fmtPx(p.target)}${p.rr === null ? "" : ` · ${r2(p.rr)}R`}`,
          "pos",
        ),
        sized ? cell("Size", num(sized.qty, sized.qty < 1 ? 5 : 2), null) : null,
      ),
      /* WHERE THE ENTRY CAME FROM. The backtest fills at the next bar's open
         plus costs, not at the signal bar's close, and the difference is the
         whole honesty of the figures underneath it. */
      h("p", {
        class: "av-fill small muted",
        text:
          p.entry === null
            ? p.entryNote
            : `${p.entryNote} That is ${fmtPx(p.entry)}` +
              (p.drift === null ? "." : `, and price has since moved ${sR(p.drift)} from it.`),
      }),
      sized
        ? h("p", {
            class: "av-size small muted",
            text: `Risking ${sized.riskAmount.toFixed(2)} (${sized.riskPct.toFixed(2)}% of equity) to the rule's own stop.`,
          })
        : h("p", {
            class: "av-size small muted",
            text: p.size && !p.size.ok ? `Not sized: ${p.size.reason}` : "Not sized — there is no fill price yet.",
          }),
      /* THE SAME EIGHT CHECKS Manual runs, over the same readings. An
         unchecked market reads "can't check yet", never as a pass — see
         `UNCHECKED` in autoplan.ts. */
      h(
        "div",
        { class: "av-checks", "data-kind": p.verdict.kind },
        h("span", { class: "av-checks-head", text: p.verdict.headline }),
        h("span", {
          class: "av-checks-count small",
          text: p.checked ? `${p.verdict.passed} of ${p.verdict.total} checks pass` : "nothing checked yet",
        }),
      ),
      ...p.verdict.blocking.map((g) => h("p", { class: "av-block small", "data-gate": g.id, text: g.text })),
      ...p.verdict.unknown.map((g) => h("p", { class: "av-unknown small", "data-gate": g.id, text: g.text })),
    );
  };

  const body = h("div", { class: "av-body" });
  const root = h("div", { class: "av-root" }, body) as HTMLElement;

  /*
   * MARKETS ALREADY SEARCHED — including the ones that turned up nothing.
   *
   * "Nothing survived" is a RESULT, and the most common one: eighty-five rules
   * over a market with no edge in it is supposed to come back empty. Re-running
   * it on every glance would spend the same evidence for the same answer and
   * charge the operator thirty seconds each time.
   */
  const attempted = new Set<string>();
  const marketKey = (sym: string, tf: string): string => `${sym}|${tf}`;
  let settle: ReturnType<typeof setTimeout> | null = null;

  /** The market the driver is working on, or has finished — null when idle. */
  const sweptHere = (): boolean => {
    const sub = deps.sweep?.subject();
    return sub !== null && sub !== undefined && sub.symbol === state.symbol() && sub.timeframe === state.timeframe();
  };

  function startSearch(): void {
    const sweep = deps.sweep;
    if (!sweep || sweep.running.peek()) return;
    const sym = state.symbol.peek();
    const tf = state.timeframe.peek();
    attempted.add(marketKey(sym, tf));
    void sweep.run(sym, tf);
  }

  /**
   * Whether to start one WITHOUT being asked, and every reason not to.
   *
   * Read as a list of refusals rather than a condition, because each one is a
   * different mistake: spending CPU on a market nobody is looking at, spending
   * it twice, spending it on an answer already given, or spending it while the
   * operator has said not to.
   */
  function mayAutoSearch(): boolean {
    if (!deps.sweep || deps.autoSearch?.peek() === false) return false;
    if (deps.sweep.running.peek()) return false;
    /* MOUNTED IS NOT VISIBLE. Both panes of this card live in the DOM at once
       and are switched with `display`. */
    if (!isShown(root)) return false;
    if (attempted.has(marketKey(state.symbol.peek(), state.timeframe.peek()))) return false;
    /* Something is already on the shelf for this market: it has been searched
       before, in an earlier session. */
    if (liveFor(deps.shelf.rows.peek(), state.symbol.peek(), state.timeframe.peek()).length > 0) return false;
    /*
     * AND A REMEMBERED SEARCH IS AN ANSWER. "Nothing survived" is the common
     * and correct result, so a market that has been searched and found empty
     * must not be searched again on every visit — that is thirty seconds spent
     * to reproduce a conclusion already reached. `recall` returns null once
     * the market has moved far enough for the answer to be worth revisiting.
     */
    const bars = deps.bars.peek();
    const newest = bars[bars.length - 1];
    if (deps.sweep.recall(state.symbol.peek(), state.timeframe.peek(), newest ? newest.t : 0)) return false;
    return true;
  }

  function considerAutoSearch(): void {
    if (settle !== null) clearTimeout(settle);
    if (!mayAutoSearch()) return;
    /* Settle first: paging through a watchlist must not queue a sweep per
       symbol, and the pane may be about to be switched away from again. */
    settle = setTimeout(() => {
      settle = null;
      if (mayAutoSearch()) startSearch();
    }, deps.settleMs ?? SETTLE_MS);
  }

  /* Coming into view is a trigger; so is arriving on a new market while
     already in view. The driver refuses a second concurrent run, and a market
     change mid-run abandons the one in flight rather than racing it. */
  onShown(root, considerAutoSearch);
  renderEffect(() => {
    state.symbol();
    state.timeframe();
    if (deps.sweep?.running.peek() === true && !sweptHere()) deps.sweep.cancel();
    considerAutoSearch();
  });
  /*
   * AND ONCE AFTER MOUNTING, because the effect above runs while this element
   * is still detached — `mountShell` builds the card and appends it afterwards,
   * so `isShown` is false for the whole of construction. Without this the only
   * thing that could ever start the first search is `onShown`'s
   * ResizeObserver, which is one mechanism carrying the entire feature and
   * does not exist at all in a test environment.
   */
  scheduleFrame(() => considerAutoSearch());

  renderEffect(() => {
    const { rows, closed } = checked();
    const lead0 = lead();
    const others = firing().slice(1);
    armed();
    arming();
    clear(body);

    const sym = state.symbol();
    const tf = state.timeframe();

    if (rows.length === 0) {
      /* SEARCHING, HERE. The progress line and the cancel are on this card, so
         the operator never has to leave the inspector to watch or stop it. */
      if (deps.sweep && deps.sweep.running() && sweptHere()) {
        const p = deps.sweep.progress();
        body.appendChild(h("p", { class: "av-empty", text: `Searching ${sym} ${tf}…` }));
        body.appendChild(
          h("p", {
            class: "small av-progress",
            text: p ? `${p.done} of ${p.total} studied · just finished ${p.last}.` : deps.sweep.note(),
          }),
        );
        body.appendChild(
          h("button", {
            class: "ghost-btn",
            type: "button",
            "data-act": "cancel-search",
            text: "Cancel",
            onclick: () => deps.sweep?.cancel(),
          }),
        );
        appendMaybe(body, autoToggle());
        return;
      }

      /* A search that RAN and found nothing is a result, not an empty state,
         and the refusal says which kind — see `backtest/search.ts`. */
      const rep = deps.sweep && sweptHere() ? deps.sweep.report() : null;
      /* A search this session, or one remembered from an earlier one. */
      const bars0 = deps.bars.peek();
      const newest0 = bars0[bars0.length - 1];
      const recalled =
        rep === null && deps.sweep
          ? deps.sweep.recall(sym, tf, newest0 ? newest0.t : 0)
          : null;
      const why = deps.sweep && sweptHere() ? deps.sweep.blocked() : "";
      body.appendChild(
        h("p", {
          class: "av-empty",
          text: rep || recalled
            ? `Nothing survived the search of ${sym} ${tf}.`
            : `Nothing has been found for ${sym} ${tf} yet.`,
        }),
      );
      if (why) {
        body.appendChild(h("p", { class: "small av-blocked", text: why }));
      } else if (rep) {
        body.appendChild(h("p", { class: "small", text: rep.line }));
        /*
         * WHY they could not be studied, not just how many.
         *
         * "85 could not be studied on this history" is a count with no cause,
         * and a refusal an operator cannot act on is the thing this file's own
         * header promises not to produce. The reasons are collapsed to the
         * distinct ones because eighty-five copies of one sentence is not
         * eighty-five facts.
         */
        const reasons = [...new Set(rep.failed.map((f) => f.why))];
        for (const why of reasons.slice(0, 3)) {
          body.appendChild(h("p", { class: "small av-reason", text: why }));
        }
        if (reasons.length > 3) {
          body.appendChild(h("p", { class: "small av-reason", text: `…and ${reasons.length - 3} other reasons.` }));
        }
        const near = rep.search.refusal;
        if (near && near.kind !== "no-candidates") {
          body.appendChild(h("p", { class: "small av-near", text: `Nearest miss: ${near.why}` }));
        }
      } else if (recalled) {
        /* A HIT STATES ITS OWN AGE. A verdict that looks live and is three days
           old is worse than no verdict. */
        body.appendChild(h("p", { class: "small", text: recalled.line }));
        if (recalled.nearest) {
          body.appendChild(h("p", { class: "small av-near", text: `Nearest miss: ${recalled.nearest}` }));
        }
        body.appendChild(
          h("p", {
            class: "small av-age",
            text: `Searched ${clock(recalled.at)} on ${recalled.bars.toLocaleString()} bars. Search again to redo it now.`,
          }),
        );
      } else {
        body.appendChild(
          h("p", {
            class: "small",
            text: "The terminal only proposes strategies it found by searching this market — nothing here is a guess about it.",
          }),
        );
      }
      body.appendChild(
        h(
          "div",
          { class: "av-foot" },
          deps.sweep
            ? h("button", {
                class: "primary-btn",
                type: "button",
                "data-act": "search",
                text: rep || why || recalled ? "Search again" : `Search ${sym} ${tf}`,
                onclick: () => startSearch(),
              })
            : null,
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            "data-act": "open-strategy",
            text: "Open the Strategy desk",
            onclick: () => deps.onOpenStrategy(),
          }),
        ),
      );
      appendMaybe(body, autoToggle());
      return;
    }

    if (!lead0) {
      body.appendChild(
        h("p", {
          class: "av-empty",
          text: `None of the ${rows.length} strategies found for ${sym} ${tf} has its entry true on the last closed bar.`,
        }),
      );
      for (const c of rows) {
        body.appendChild(
          h(
            "p",
            { class: "av-quiet small", "data-kind": c.firing.kind },
            h("span", { class: "av-quiet-name", text: c.row.spec.name }),
            h("span", {
              text:
                c.firing.kind === "cannot"
                  ? ` — ${c.firing.why}`
                  : ` — not triggered on the bar that closed at ${clock(c.firing.at)}.`,
            }),
          ),
        );
      }
    } else {
      const c = lead0;
      const sig = c.firing.kind === "fires" ? c.firing.signal : null;
      body.appendChild(
        h(
          "div",
          { class: "av-lead", "data-dir": sig?.direction ?? "" },
          h(
            "div",
            { class: "av-lead-head" },
            h("span", { class: "av-lead-name", text: c.row.spec.name }),
            h("span", { class: "av-dir", "data-dir": sig?.direction ?? "", text: sig?.direction === "short" ? "Short" : "Long" }),
            h("span", { class: "shelf-status", "data-status": c.row.status, text: c.row.status === "promoted" ? "Promoted" : "Unproven" }),
          ),
          h("p", {
            class: "av-lead-line",
            text:
              c.firing.kind === "fires"
                ? `Its entry is true on the bar that closed at ${clock(c.firing.at)}.`
                : "",
          }),
          planBlock(c),
          h("p", { class: "av-reason small", text: sig ? sig.reason : "" }),
          figures(c.row),
          c.row.status === "unproven"
            ? h("p", {
                class: "small av-unproven",
                text: "This is UNPROVEN: it survived a search and has no forward record. Promote it on the Strategy desk if you want it treated as more than that.",
              })
            : null,
          armBlock(c),
        ),
      );

      body.appendChild(
        createSayRow(ctx, {
          subject: () => {
            const l = lead();
            if (!l || l.firing.kind !== "fires") return null;
            const b = deps.bars.peek()[l.firing.index];
            return {
              verdict: `auto:${l.row.spec.id}`,
              direction: l.firing.signal.direction,
              entry: b ? b.c : null,
            };
          },
          onUse: deps.onUse,
          onAdjust: deps.onAdjust,
        }),
      );

      if (others.length > 0) {
        body.appendChild(
          h("p", {
            class: "small av-others",
            text: `${others.length} more firing on this bar: ${others.map((x) => x.row.spec.name).join(", ")}.`,
          }),
        );
      }
      const quiet = rows.filter((x) => x.firing.kind !== "fires");
      if (quiet.length > 0) {
        body.appendChild(
          h("p", { class: "muted small", text: `${quiet.length} of the ${rows.length} here are not firing on this bar.` }),
        );
      }
    }

    body.appendChild(
      h(
        "div",
        { class: "av-foot" },
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          "data-act": "recheck",
          text: "Check again",
          onclick: () => rev.update((n) => n + 1),
        }),
        h("span", { class: "muted small", text: `${closed} closed bars` }),
      ),
    );
    body.appendChild(
      h("p", {
        class: "small av-note",
        text: () =>
          `Re-checked when a bar closes, and when you press Check again. ` +
          (deps.autoSearch?.() === false
            ? "A search runs only when you ask for one. "
            : "A market with nothing found is searched once, by itself, while this panel is open. ") +
          `Nothing here places an order.`,
      }),
    );
    body.appendChild(
      pkWhy(
        "Each strategy on the shelf is compiled with the same function the backtest used and asked, at the index of " +
          "the newest CLOSED bar, whether it would enter. A forming bar is not asked: its close is the last trade and " +
          "changes every tick, so a rule judged on it fires and un-fires. A rule with fewer bars than its warm-up is " +
          "reported as unanswerable rather than as 'not firing' — that would be stating a measurement never made. " +
          "The figures beside a proposal are its BACKTEST's, out of sample, charged for the size of the search that " +
          "found it; none of them is a claim about this trade.",
        "Why?",
      ),
    );
  });

  return root;
}
