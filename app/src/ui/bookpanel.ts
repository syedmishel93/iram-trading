/**
 * The broker panel: what the account says, and where every row came from.
 *
 * WHY THIS IS A PANEL AND NOT A STATUS LIGHT
 * A green dot saying "connected" is worth almost nothing, because the question
 * an operator actually has is not "is there a connection" — it is "is the
 * number I am about to size a trade on the real one". That question is
 * answered per ROW, and the rows disagree for ordinary reasons: a position
 * closed on the phone this morning, a row typed in and forgotten, a second
 * account at another venue.
 *
 * So every row carries its own provenance, and the two states that change a
 * risk figure are stated rather than styled:
 *
 *   NOT COUNTED — hand-entered, the broker is connected, and it does not
 *   report this. One click says "it is real and it is elsewhere" and it counts.
 *
 *   UNSIZED — the broker reports it in lots and the contract size is not
 *   known. Counting it at one unit per lot would understate the risk by the
 *   contract size, so it is excluded and the refusal sits at the top in the
 *   negative role, not in a list of notes underneath.
 */

import { h } from "./dom";
import { renderEffect } from "../core/signal";
import type { BrokerModel } from "./model/broker";
import type { AccountStore } from "../core/account";
import type { BookEntry } from "../trade/book";
import { brokerLine } from "../data/broker";
import type { ManualPosition } from "../trade/book";
import type { Signal } from "../core/signal";
import type { Position } from "../risk/sizing";

const money = (v: number, ccy: string): string =>
  `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ccy}`;

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export interface BookPanelDeps {
  readonly broker: BrokerModel;
  readonly account: AccountStore;
  /**
   * The Risk desk's own rows, so an unmatched one can be marked external.
   *
   * The SIGNAL, not a copy — marking a row writes back through the desk that
   * owns it, which is what keeps `core/account.ts`'s one-owner rule intact
   * while letting this panel act on what it is showing.
   */
  readonly manual: Signal<readonly Position[]>;
}

export function createBookPanel(d: BookPanelDeps): HTMLElement {
  const { broker, account, manual } = d;

  /**
   * Mark a hand-entered row as genuinely held somewhere else.
   *
   * Matched by symbol AND direction, the same pair `reconcile` matches on. An
   * index would be wrong the moment the list re-sorted, and symbol alone would
   * flip both sides of a hedge.
   */
  const markExternal = (e: BookEntry): void => {
    manual.update((rows) =>
      rows.map((r) =>
        r.symbol === e.position.symbol && r.direction === e.position.direction
          ? ({ ...r, external: true } as ManualPosition)
          : r,
      ),
    );
  };

  const head = h("div", { class: "bk-head" });
  renderEffect(() => {
    const src = account.source();
    const live = broker.account();
    const kids: HTMLElement[] = [
      h(
        "div",
        { class: "bk-state", "data-on": src.kind === "broker" ? "1" : "0" },
        h("span", { class: "bk-dot" }),
        h("span", {
          class: "bk-state-t",
          text:
            src.kind === "broker"
              ? `MT5 ${src.login} · ${src.server}`
              : "No broker connected",
        }),
        h("span", {
          class: "bk-state-b",
          text: src.kind === "broker" ? ago(src.at, Date.now()) : "",
        }),
      ),
    ];

    if (src.kind === "broker" && live?.state === "ok") {
      const a = live.value;
      kids.push(
        h(
          "div",
          { class: "bk-figs" },
          fig("Balance", money(a.balance, a.currency)),
          fig("Equity", money(a.equity, a.currency)),
          fig("Free margin", money(a.margin_free, a.currency)),
          fig("Leverage", `1:${a.leverage}`),
        ),
      );
    } else {
      /* The reason, in the operator's terms, with what to do about it —
         `brokerLine` produces a different instruction for each of the four
         outcomes, which is the entire point of that union having four arms. */
      kids.push(h("p", { class: "bk-why", text: brokerLine(broker.positions()) }));
      kids.push(
        h("button", {
          class: "bk-retry",
          type: "button",
          text: () => (broker.busy() ? "checking…" : "Reconnect"),
          disabled: () => (broker.busy() ? "" : undefined),
          onclick: () => broker.reconnect(),
        }),
      );
    }
    head.replaceChildren(...kids);
  });

  const body = h("div", { class: "bk-rows" });
  renderEffect(() => {
    const book = broker.book();
    const ccy = account.effective().currency;
    const kids: HTMLElement[] = [];

    /* The refusal first and in the negative role: it means a number on this
       screen is WRONG-LOW, which is not the same kind of statement as the
       notes below it. */
    if (book.refusal !== null) {
      kids.push(h("div", { class: "bk-refusal", text: book.refusal }));
    }

    /* An empty book is explained ONCE. The empty state was the first note and
       the notes were rendered again below it, so the same sentence appeared
       twice — which reads as a stutter and, worse, as two separate findings. */
    const explained = book.entries.length === 0;
    if (explained) {
      kids.push(
        ...book.notes.map((n) => h("div", { class: "bk-empty", text: n })),
        ...(book.notes.length === 0 ? [h("div", { class: "bk-empty", text: "Nothing to show." })] : []),
      );
    }

    for (const e of book.entries) {
      kids.push(
        h(
          "div",
          { class: "bk-row", "data-kind": e.kind, "data-unsized": e.unsized === null ? "0" : "1" },
          h(
            "div",
            { class: "bk-id" },
            h("span", { class: "bk-sym", text: e.position.symbol }),
            h("span", { class: "bk-dir", "data-dir": e.position.direction, text: e.position.direction }),
          ),
          h("div", { class: "bk-qty num", text: `${e.position.qty}` }),
          h("div", { class: "bk-entry num", text: `${e.position.entry}` }),
          h("div", {
            class: "bk-stop num",
            "data-none": e.position.stop === null ? "1" : "0",
            text: e.position.stop === null ? "no stop" : `${e.position.stop}`,
          }),
          h("div", {
            class: "bk-pnl num",
            "data-tone": e.profit === null ? "none" : e.profit >= 0 ? "pos" : "neg",
            text: e.profit === null ? "—" : money(e.profit, ccy),
          }),
          h("span", { class: "bk-kind", text: kindLabel(e) }),
          ...(e.kind === "unmatched"
            ? [
                h("button", {
                  class: "bk-keep",
                  type: "button",
                  title: "This position is real and held at another venue. Count it.",
                  text: "It's elsewhere",
                  onclick: () => markExternal(e),
                }),
              ]
            : []),
          ...(e.unsized !== null ? [h("p", { class: "bk-unsized", text: e.unsized })] : []),
        ),
      );
    }

    if (!explained) for (const n of book.notes) kids.push(h("p", { class: "bk-note", text: n }));
    body.replaceChildren(...kids);
  });

  return h(
    "section",
    { class: "bk" },
    h("h3", { class: "bk-h", text: "The book" }),
    head,
    h(
      "div",
      { class: "bk-row bk-row-head" },
      h("div", { text: "Position" }),
      h("div", { text: "Qty" }),
      h("div", { text: "Entry" }),
      h("div", { text: "Stop" }),
      h("div", { text: "Open P&L" }),
      h("div", { text: "Source" }),
    ),
    body,
  );
}

function kindLabel(e: BookEntry): string {
  if (e.unsized !== null) return "not counted — unsized";
  switch (e.kind) {
    case "broker":
      return "broker";
    case "manual":
      return "yours";
    case "unmatched":
      return "not counted";
  }
}

function fig(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "bk-fig" },
    h("span", { class: "bk-fig-l", text: label }),
    h("span", { class: "bk-fig-v num", text: value }),
  );
}
