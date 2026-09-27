/**
 * The "Price alerts" inspector card: rules the SERVER checks, so they fire with
 * the terminal closed.
 *
 * WHAT IT SHOWS
 * An add row for the chart's current symbol, then every pending alert for ANY
 * symbol (the current one first), then a quieter "Fired" group of the last
 * five. Distance from price is shown only where a price is known — the chart's
 * symbol. Another symbol's distance would need a quote this card does not have,
 * and a guessed one is worse than none.
 *
 * THREE STATES, NOT TWO. "Loading", "no alerts" and "the service is not
 * answering" are different sentences. An unreachable service never renders as
 * an empty list, because "you have no alerts" is a claim this card cannot make
 * when it could not ask.
 *
 * THE DIRECTION DEFAULT follows the typed price (above the current price ->
 * "above") and keeps following it as they type, until the operator picks one
 * by hand; then the choice sticks until the alert is added.
 *
 * The card title is drawn by the dock's card head, not here.
 */

import { h } from "../dom";
import { pkEmpty, pkNum, pkWhy } from "../panelkit";
import { renderEffect, signal } from "../../core/signal";
import {
  addAlert,
  deleteAlert,
  loadAlerts,
  suggestOp,
  validPrice,
  type AlertOp,
  type AlertsResult,
  type PriceAlert,
} from "../../data/pricealerts";
import { isShown, onShown } from "./shown";

export interface AlertsCardDeps {
  /** The chart's symbol — a signal getter, read inside effects. */
  readonly symbol: () => string;
  /** The chart's last price, or null when none is known. */
  readonly price: () => number | null;
  /** The chart's price formatter, for the CURRENT symbol's precision. */
  readonly fmtPx: (v: number) => string;
}

/** How often the list is re-read while the card is on screen. */
export const ALERTS_POLL_MS = 30_000;
/** Fired alerts kept on the card; the rest are the server's history, not a to-do. */
const FIRED_SHOWN = 5;

/** "85,000" or "85000" -> 85000. Anything else -> NaN, refused by the caller. */
export function parsePriceInput(text: string): number {
  const t = text.replace(/[,\s]/g, "");
  if (t === "") return NaN;
  return Number(t);
}

/** Signed distance of `target` from `current`, as a percentage of `current`. */
export function distancePct(target: number, current: number | null): number | null {
  if (current === null || !Number.isFinite(current) || current <= 0 || !Number.isFinite(target)) return null;
  return ((target - current) / current) * 100;
}

const whenText = (sec: number): string =>
  new Date(sec * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function createAlertsCard(deps: AlertsCardDeps): { readonly el: HTMLElement; refresh(): void; dispose(): void } {
  const result = signal<AlertsResult | null>(null);
  const typed = signal("");
  const manualOp = signal<AlertOp | null>(null);
  const message = signal("");
  const adding = signal(false);
  const removing = signal<number | null>(null);

  let seq = 0;
  const refresh = (): void => {
    const mine = ++seq;
    void loadAlerts().then((r) => {
      if (mine === seq) result.set(r); // a slow answer never overwrites a newer one
    });
  };

  const target = (): number => parsePriceInput(typed());
  const opNow = (): AlertOp => manualOp() ?? suggestOp(target(), deps.price());

  const submit = async (): Promise<void> => {
    const px = parsePriceInput(typed.peek());
    if (!validPrice(px)) {
      message.set("Enter a price above zero.");
      return;
    }
    adding.set(true);
    message.set("");
    const r = await addAlert({ sym: deps.symbol(), op: manualOp.peek() ?? suggestOp(px, deps.price()), price: px });
    adding.set(false);
    if (!r.ok) {
      message.set(r.reason);
      return;
    }
    typed.set("");
    manualOp.set(null);
    refresh();
  };

  const remove = async (id: number): Promise<void> => {
    removing.set(id);
    const r = await deleteAlert(id);
    removing.set(null);
    message.set(r.ok ? "" : r.reason);
    refresh();
  };

  /* ---- add row: built once, so typing is never interrupted by a re-render */
  const input = h("input", {
    class: "alc-input num",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    "aria-label": "Alert price",
    value: () => typed(),
    placeholder: () => {
      const p = deps.price();
      return p === null ? "Price" : deps.fmtPx(p);
    },
    oninput: (e: Event) => {
      typed.set((e.target as HTMLInputElement).value);
      message.set("");
    },
    onkeydown: (e: Event) => {
      if ((e as KeyboardEvent).key === "Enter") void submit();
    },
  });

  const select = h(
    "select",
    {
      class: "alc-op",
      "aria-label": "Direction",
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        manualOp.set(v === "below" ? "below" : "above");
      },
    },
    h("option", { value: "above", text: "above" }),
    h("option", { value: "below", text: "below" }),
  );
  /* After the options exist: `h` applies props before children, so a `value`
     prop would be set on an empty select and match nothing. */
  renderEffect(() => {
    const v = opNow();
    if (select.value !== v) select.value = v;
  });

  const distance = h("span", {
    class: "alc-dist num",
    title: "Distance from the chart's current price.",
    text: () => {
      const d = distancePct(target(), deps.price());
      return d === null || !validPrice(target()) ? "" : `${d > 0 ? "+" : ""}${d.toFixed(2)}%`;
    },
  });

  const addRow = h(
    "div",
    { class: "alc-add" },
    h("span", { class: "alc-sym", text: () => deps.symbol() }),
    select,
    input,
    distance,
    h("button", {
      class: "ghost-btn alc-btn",
      type: "button",
      text: () => (adding() ? "Adding…" : "Add"),
      disabled: () => adding(),
      onclick: () => void submit(),
    }),
  );

  /* ---- list */
  const rowFor = (a: PriceAlert, cur: string, px: number | null): HTMLElement => {
    const isCur = a.sym.toUpperCase() === cur;
    const priceText = isCur ? deps.fmtPx(a.price) : pkNum(a.price);
    let tail = "";
    if (a.fired !== null) {
      tail = `fired ${whenText(a.fired)}`;
    } else if (isCur) {
      const d = distancePct(a.price, px);
      if (d !== null) {
        const crossed = (a.op === "above" && d <= 0) || (a.op === "below" && d >= 0);
        tail = crossed ? "already past on the chart" : `${Math.abs(d).toFixed(1)}% away`;
      }
    }
    return h(
      "div",
      { class: "alc-row", "data-current": isCur ? "true" : "false", "data-fired": a.fired !== null ? "true" : "false" },
      h(
        "span",
        { class: "alc-row-text", title: a.note === "" ? `Set ${whenText(a.created)}` : `${a.note} · set ${whenText(a.created)}` },
        h("span", { class: "alc-row-sym", text: a.sym }),
        ` ${a.op} `,
        h("span", { class: "num", text: priceText }),
        tail === "" ? null : h("span", { class: "alc-row-tail", text: ` · ${tail}` }),
      ),
      h("button", {
        class: "alc-x",
        type: "button",
        text: "×",
        title: "Remove this alert",
        "aria-label": `Remove ${a.sym} ${a.op} ${priceText}`,
        disabled: () => removing() === a.id,
        onclick: () => void remove(a.id),
      }),
    ) as HTMLElement;
  };

  const list = (): Node => {
    const r = result();
    const cur = deps.symbol().toUpperCase();
    const px = deps.price();
    if (r === null) return pkEmpty("loading", "Loading alerts…");
    if (r.state === "offline") {
      const p = pkEmpty("unavailable", "The alert service is not answering.");
      p.title = r.reason;
      return p;
    }
    const pending = r.value
      .filter((a) => a.fired === null)
      .map((a, i) => ({ a, i }))
      .sort((x, y) => Number(x.a.sym.toUpperCase() !== cur) - Number(y.a.sym.toUpperCase() !== cur) || x.i - y.i)
      .map((x) => x.a);
    const fired = r.value
      .filter((a) => a.fired !== null)
      .sort((x, y) => (y.fired ?? 0) - (x.fired ?? 0))
      .slice(0, FIRED_SHOWN);
    if (pending.length === 0 && fired.length === 0) {
      return pkEmpty("empty", "No alerts. They fire from the server — even with the terminal closed.");
    }
    return h(
      "div",
      { class: "alc-groups" },
      pending.length === 0
        ? pkEmpty("empty", "Nothing waiting.")
        : h("div", { class: "alc-rows" }, ...pending.map((a) => rowFor(a, cur, px))),
      fired.length === 0
        ? null
        : h(
            "div",
            { class: "alc-fired" },
            h("div", { class: "alc-fired-head", text: "Fired" }),
            h("div", { class: "alc-rows" }, ...fired.map((a) => rowFor(a, cur, px))),
          ),
      h("p", { class: "alc-note", text: "Checked on the server every 30s — they fire even with the terminal closed." }),
    );
  };

  const el = h(
    "div",
    { class: "alc" },
    addRow,
    h("p", { class: "alc-msg", role: "status", text: () => message() }),
    h("div", { class: "alc-list" }, list),
    pkWhy(
      "The server checks each waiting alert against a yfinance quote, which can be about 15 minutes late and is not the chart's feed. " +
        "A symbol yfinance cannot quote is skipped, not guessed, so its alert will not fire. An alert fires once, then moves to Fired. " +
        "The notification goes to Telegram if it is set up. Verify the price at your broker before acting.",
      "Where the price comes from",
    ),
  ) as HTMLElement;

  refresh();
  const timer = setInterval(() => {
    // While DRAWN (`./shown.ts`): a removed card or a shut inspector does not
    // poll. A HIDDEN tab still does — this terminal is normally a background
    // tab while you work in MT5.
    if (isShown(el)) refresh();
  }, ALERTS_POLL_MS);
  onShown(el, refresh);

  return {
    el,
    refresh,
    dispose: () => clearInterval(timer),
  };
}
