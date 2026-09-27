/**
 * The Paper desk — practice fills against the live feed.
 *
 * THE DISTINCTION THIS DESK EXISTS TO KEEP
 * The old terminal's "DEMO" mode generated synthetic BARS and drew them on the
 * chart. That is the one thing forbidden outright: a price nothing observed,
 * rendered identically to one that was. It was removed and stays removed.
 *
 * Here the prices are the real feed and only the FILLS are simulated. Every
 * position is labelled simulated, the cost assumptions are on screen and
 * editable, and the desk says plainly what a simulated fill cannot know — book
 * depth, queue position, and the fact that your order had no effect on a market
 * it never reached.
 *
 * WHY THERE IS NO "TRADE THE SIGNAL" BUTTON
 * Every fill starts with a click. `trade/paper.ts` has no entry point that
 * takes a signal, a score or a strategy, and a test pins the export list so one
 * cannot quietly appear. The standing recommendation on this terminal is that
 * nothing be automated off the confluence score — PBO is 89% — and an
 * auto-trade switch on a practice desk is how that recommendation gets ignored
 * first and forgotten second.
 */

import { h } from "./dom";
import { pkWhy } from "./panelkit";
import { signal, computed, renderEffect, effect, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import type { BarView } from "../chart/series";
import {
  emptyBook,
  openPosition,
  closePosition,
  applyLevels,
  summarise,
  realise,
  equityCurve,
  DEFAULT_ASSUMPTIONS,
  type CostAssumptions,
  type PaperBook,
} from "../trade/paper";

export interface PaperDeskOptions {
  readonly symbol: Signal<string>;
  readonly kv: KV;
  /** Live last price for the charted symbol. */
  readonly lastPrice: () => number;
  /** Closed bars for the charted symbol, for stop and target checks. */
  readonly bars: () => readonly BarView[];
  readonly notify?: (message: string) => void;
}

interface Saved {
  book: PaperBook;
  costs: CostAssumptions;
}

const SLOT = {
  key: "paper.v1",
  version: 1,
  fallback: (): Saved => ({ book: emptyBook(10_000), costs: DEFAULT_ASSUMPTIONS }),
  validate: (v: unknown): Saved | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const b = o["book"] as PaperBook | undefined;
    if (!b || !Array.isArray(b.positions) || !Array.isArray(b.trades)) return null;
    if (!Number.isFinite(b.startingEquity)) return null;
    const c = o["costs"] as CostAssumptions | undefined;
    const costs =
      c && Number.isFinite(c.spreadPct) && Number.isFinite(c.slippagePct) && Number.isFinite(c.commissionPct)
        ? c
        : DEFAULT_ASSUMPTIONS;
    return { book: b, costs };
  },
};

const money = (n: number): string =>
  Number.isFinite(n)
    ? `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";

const signedMoney = (n: number): string =>
  Number.isFinite(n) ? `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";

const pct = (n: number): string => (Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "—");

export function createPaper(opts: PaperDeskOptions) {
  const stored = opts.kv.read(SLOT).value;

  const book = signal<PaperBook>(stored.book);
  const costs = signal<CostAssumptions>(stored.costs);
  const qty = signal(0.01);
  const stopPx = signal(0);
  const targetPx = signal(0);
  const message = signal("");

  const persist = (): void => {
    opts.kv.write(SLOT, { book: book(), costs: costs() });
  };

  /** Marks for open positions. Only the charted symbol has a live price. */
  const marks = computed<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>();
    const p = opts.lastPrice();
    if (p > 0) m.set(opts.symbol().toUpperCase(), p);
    return m;
  });

  const summary = computed(() => summarise(book(), marks(), costs()));

  /**
   * Check stops and targets against each newly CLOSED bar.
   *
   * Driven by the bar's high and low rather than the last price: a level that
   * traded between two polls of the last price would otherwise never fire, and
   * a paper record that misses its losers is worse than none.
   */
  let lastSeen = 0;
  effect(() => {
    const list = opts.bars();
    const last = list[list.length - 1];
    if (!last || last.t === lastSeen) return;
    lastSeen = last.t;

    const open = book.peek();
    if (open.positions.length === 0) return;

    const quotes = new Map([[opts.symbol().toUpperCase(), { high: last.h, low: last.l, close: last.c }]]);
    const { book: next, fired } = applyLevels(open, quotes, last.t, costs.peek());
    if (fired.length === 0) return;
    book.set(next);
    persist();
    for (const t of fired) {
      opts.notify?.(
        `Simulated ${t.symbol} ${t.direction} closed on its ${t.reason} — ${signedMoney(t.pnl)}`,
      );
    }
  });

  const doOpen = (direction: "long" | "short"): void => {
    const mid = opts.lastPrice();
    const r = openPosition(book(), {
      symbol: opts.symbol(),
      direction,
      qty: qty(),
      mid,
      at: Date.now(),
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      ...(stopPx() > 0 ? { stop: stopPx() } : {}),
      ...(targetPx() > 0 ? { target: targetPx() } : {}),
      costs: costs(),
    });
    if (!r.ok) {
      message.set(r.reason);
      return;
    }
    book.set(r.book);
    message.set("");
    persist();
  };

  const doClose = (id: string): void => {
    const mid = opts.lastPrice();
    if (!(mid > 0)) {
      message.set("No live price to close against.");
      return;
    }
    book.set(closePosition(book(), id, mid, Date.now(), "manual", costs()));
    persist();
  };

  const reset = (): void => {
    book.set(emptyBook(book().startingEquity));
    message.set("Book cleared.");
    persist();
  };

  const list = (cls: string, rows: () => HTMLElement[]) =>
    h("div", {
      class: cls,
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const r of rows()) el.appendChild(r);
        }),
    });

  const costField = (label: string, key: keyof CostAssumptions, hint: string) =>
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", text: label }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: "0.0001",
        value: () => String(costs()[key]),
        oninput: (e: Event) => {
          costs.set({ ...costs(), [key]: Number((e.target as HTMLInputElement).value) || 0 });
          persist();
        },
      }),
      h("div", { class: "field-hint", text: hint }),
    );

  const positionRows = (): HTMLElement[] => {
    const m = marks();
    return book().positions.map((p) => {
      const mark = m.get(p.symbol);
      /* Through `realise`, the SAME function the summary uses. Marking the row
         to the mid while the summary marks to the price a close would actually
         get put two different unrealised figures on one desk — the row read
         −$0.05 and the total read −$0.91 for the same position, and the smaller
         one was the flattering one. */
      const unreal = mark === undefined ? NaN : realise(p, mark, costs()).pnl;
      return h(
        "div",
        { class: "pp-row", "data-tone": Number.isFinite(unreal) ? (unreal >= 0 ? "pos" : "neg") : "" },
        h("span", { class: "pp-sym", text: `${p.symbol} ${p.direction}` }),
        h("span", { class: "pp-v num", text: String(p.qty) }),
        h("span", { class: "pp-v num", text: p.entry.toFixed(4) }),
        h("span", {
          class: "pp-v num",
          text: mark === undefined ? "no mark" : mark.toFixed(4),
        }),
        h("span", { class: "pp-pnl num", text: Number.isFinite(unreal) ? signedMoney(unreal) : "—" }),
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          text: "Close",
          onclick: () => doClose(p.id),
        }),
      );
    });
  };

  const tradeRows = (): HTMLElement[] =>
    [...book().trades]
      .reverse()
      .slice(0, 40)
      .map((t) =>
        h(
          "div",
          { class: "pp-row", "data-tone": t.pnl >= 0 ? "pos" : "neg" },
          h("span", { class: "pp-sym", text: `${t.symbol} ${t.direction}` }),
          h("span", { class: "pp-v num", text: String(t.qty) }),
          h("span", { class: "pp-v num", text: t.entry.toFixed(4) }),
          h("span", { class: "pp-v num", text: t.exit.toFixed(4) }),
          h("span", { class: "pp-pnl num", text: signedMoney(t.pnl) }),
          h("span", { class: "pp-why", text: t.reason }),
        ),
      );

  const curve = h("canvas", {
    class: "pp-curve",
    ref: (el: HTMLCanvasElement) =>
      renderEffect(() => {
        const pts = equityCurve(book());
        const ctx = el.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = el.clientWidth || 300;
        const hgt = el.clientHeight || 90;
        el.width = Math.round(w * dpr);
        el.height = Math.round(hgt * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, hgt);
        if (pts.length < 2) return;

        const css = getComputedStyle(document.documentElement);
        const line = css.getPropertyValue("--accent").trim() || "#6ea8fe";
        const base = css.getPropertyValue("--border").trim() || "#333";

        let lo = Infinity;
        let hi = -Infinity;
        for (const v of pts) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo < 1e-9) {
          hi += 1;
          lo -= 1;
        }
        const y = (v: number): number => hgt - ((v - lo) / (hi - lo)) * (hgt - 4) - 2;

        /* The starting-equity line, so a curve below it reads as a loss at a
           glance rather than as a shape. */
        ctx.strokeStyle = base;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y(book().startingEquity));
        ctx.lineTo(w, y(book().startingEquity));
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = line;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const px = (i / (pts.length - 1)) * w;
          const py = y(pts[i] as number);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }),
  });

  /* Lifted from the root call so the layout below can place them. */
  const ppTicket = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: () => `New simulated position in ${opts.symbol()}` }),
    h(
      "div",
      { class: "risk-inputs" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Quantity" }),
        h("input", {
          class: "field-input num",
          type: "number",
          step: "any",
          value: () => String(qty()),
          oninput: (e: Event) => qty.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("div", { class: "field-hint", text: "In units of the base asset." }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Stop (optional)" }),
        h("input", {
          class: "field-input num",
          type: "number",
          step: "any",
          value: () => String(stopPx()),
          oninput: (e: Event) => stopPx.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("div", { class: "field-hint", text: "Checked against each closed bar's low and high." }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Target (optional)" }),
        h("input", {
          class: "field-input num",
          type: "number",
          step: "any",
          value: () => String(targetPx()),
          oninput: (e: Event) => targetPx.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("div", {
          class: "field-hint",
          text: "If a bar contains both, the stop is taken — neither is knowable from a bar alone.",
        }),
      ),
    ),
    h(
      "div",
      { class: "pp-actions" },
      h("button", { class: "primary-btn", type: "button", text: "Buy", onclick: () => doOpen("long") }),
      h("button", { class: "primary-btn", type: "button", text: "Sell", onclick: () => doOpen("short") }),
      h("span", {
        class: "pp-live num",
        text: () => (opts.lastPrice() > 0 ? `live ${opts.lastPrice()}` : "no live price"),
      }),
    ),
    h("p", { class: "pp-message", text: () => message() }),
  );

  const ppStands = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Where it stands" }),
    h(
      "div",
      { class: "pf-stats" },
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Equity" }),
        h("span", { class: "pf-stat-v num", text: () => money(summary().equity) }),
      ),
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Return" }),
        h("span", { class: "pf-stat-v num", text: () => pct(summary().returnPct) }),
      ),
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Realised" }),
        h("span", { class: "pf-stat-v num", text: () => signedMoney(summary().realised) }),
      ),
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Unrealised" }),
        h("span", { class: "pf-stat-v num", text: () => signedMoney(summary().unrealised) }),
      ),
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Closed trades" }),
        h("span", { class: "pf-stat-v num", text: () => String(summary().trades) }),
      ),
      h("div", { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Win rate" }),
        h("span", { class: "pf-stat-v num", text: () => (Number.isFinite(summary().winRate) ? pct(summary().winRate) : "—") }),
      ),
    ),
    curve,
    pkWhy(
      "Open positions are marked at the price a CLOSE would actually get, costs included — not at the mid. A position marked at the mid shows a profit that closing would not realise.",
      "How positions are marked",
    ),
  );

  const ppOpen = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Open" }),
    list("pp-rows", positionRows),
    h("p", {
      class: "pp-empty",
      "data-on": () => String(book().positions.length === 0),
      text: "Nothing open.",
    }),
  );

  const ppClosed = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Closed" }),
    list("pp-rows", tradeRows),
    h("p", {
      class: "pp-empty",
      "data-on": () => String(book().trades.length === 0),
      text: "No closed trades yet.",
    }),
  );

  const ppCosts = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Cost assumptions" }),
    pkWhy(
      "Applied on the way in AND the way out, always adversely. Set them to zero and the desk will tell you what a strategy looks like when filling is free, which no strategy ever is.",
      "How costs are applied",
    ),
    h(
      "div",
      { class: "risk-inputs" },
      costField("Half-spread", "spreadPct", "As a fraction of price. 0.0002 is 2bp."),
      costField("Slippage", "slippagePct", "Extra adverse fill, as a fraction of price."),
      costField("Commission per side", "commissionPct", "As a fraction of notional."),
    ),
    h(
      "div",
      { class: "pp-actions" },
      h("button", { class: "ghost-btn", type: "button", text: "Clear the book", onclick: reset }),
    ),
  );


  const el = h(
    "div",
    { class: "dd pp-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Paper" }),
      h("p", {
        class: "view-sub",
        text: "Practice fills against the real feed. The prices are live; the fills are simulated, and every position here is marked as such.",
      }),
    ),
    h(
      "div",
      { class: "pp-banner" },
      h("span", { class: "pp-badge", text: "SIMULATED" }),
      h("span", {
        text: "No broker is connected and no order is ever sent. Book depth and queue position are not modelled at all — a size that would move the market fills here at one price.",
      }),
    ),
    /*
     * PRIMARY  the ticket and what it produced. Placing a practice fill
     *          and reading the trades it made are one activity.
     * RAIL     where it stands, and the cost model. The first is what
     *          every fill MOVES and you glance at between trades; the
     *          second is the assumption set the simulation runs on,
     *          including the caveat that depth and queue position are
     *          not modelled at all. Reference, not work.
     */
    h(
      "div",
      { class: "dd-layout" },
      h("div", { class: "dd-primary" }, ppTicket, ppOpen, ppClosed),
      h("div", { class: "dd-rail" }, ppStands, ppCosts),
    ),
  );

  return { el, book, summary };
}
