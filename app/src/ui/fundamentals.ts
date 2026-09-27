/**
 * The fundamentals panel.
 *
 * Sits in the inspector beside the chart, because these numbers are context for
 * what you are looking at rather than a destination of their own. You do not go
 * to a desk to find out that the float is 6%; you notice it while reading the
 * chart, and then the chart means something different.
 *
 * THREE THINGS IT IS CAREFUL ABOUT
 *
 * 1. IT SAYS WHEN IT HAS NOTHING. Gold, FX majors and most equities are not in
 *    a crypto aggregator, and the panel says exactly that instead of rendering
 *    an empty frame that looks like a loading state that never finishes.
 *
 * 2. IT NAMES THE SOURCE AND ITS WEAKEST FIELD. Circulating supply is
 *    SELF-REPORTED by projects, and float and dilution are both computed from
 *    it. Every derived figure inherits that uncertainty, and a panel that hides
 *    the provenance of a number invites sizing against it.
 *
 * 3. IT DOES NOT COLOUR THE DERIVED FIGURES GREEN OR RED. A low float is not
 *    bad and a high turnover is not good; both are facts whose meaning depends
 *    entirely on what you are doing. Only the price changes, which have an
 *    unambiguous sign, use the market hues.
 */

import { h, clear } from "./dom";
import { renderEffect, type Signal } from "../core/signal";
import {
  derive,
  fmtCap,
  fmtSupply,
  type Fundamentals,
  type FundamentalsService,
} from "../data/fundamentals";

export interface FundamentalsPanelOptions {
  readonly service: FundamentalsService;
  readonly symbol: Signal<string>;
}

const pct = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—");

function row(label: string, value: string, sub = "", tone = ""): HTMLElement {
  return h(
    "div",
    { class: "fund-row" },
    h("span", { class: "fund-label", text: label }),
    h(
      "span",
      { class: "fund-value" },
      h("span", { class: "fund-num num", ...(tone ? { "data-tone": tone } : {}), text: value }),
      sub ? h("span", { class: "fund-sub", text: sub }) : null,
    ),
  );
}

export function createFundamentalsPanel(opts: FundamentalsPanelOptions): HTMLElement {
  const body = h("div", { class: "fund" });

  const paint = (f: Fundamentals | null): void => {
    clear(body);

    if (opts.service.loading() && f === null) {
      body.appendChild(
        h(
          "div",
          { class: "fund-empty" },
          h("div", { class: "skel skel-row" }),
          h("div", { class: "skel skel-row" }),
          h("div", { class: "skel skel-row" }),
        ),
      );
      return;
    }

    if (!f) {
      body.appendChild(
        h("div", {
          class: "fund-empty",
          text: `No fundamental data for ${opts.symbol()}. The aggregator covers crypto assets by market capitalisation — metals, FX and equities are not in it.`,
        }),
      );
      body.appendChild(
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          text: () => (opts.service.loading() ? "Loading…" : "Load fundamentals"),
          disabled: () => opts.service.loading(),
          onclick: () => opts.service.refresh(),
        }),
      );
      body.appendChild(h("div", { class: "fund-source", text: () => opts.service.note() }));
      return;
    }

    const d = derive(f);

    body.appendChild(
      h(
        "div",
        { class: "fund-head" },
        h("span", { class: "fund-name", text: f.name }),
        h("span", { class: "chip", text: `#${f.rank}` }),
      ),
    );

    body.appendChild(row("Market cap", fmtCap(f.marketCap)));
    body.appendChild(
      row(
        "Fully diluted",
        fmtCap(f.fullyDiluted),
        d.dilution !== null ? `${d.dilution.toFixed(2)}× cap` : "no cap to compare",
      ),
    );
    body.appendChild(
      row(
        "Float",
        d.float !== null ? `${(d.float * 100).toFixed(1)}%` : "—",
        f.maxSupply !== null
          ? `${fmtSupply(f.circulating)} of ${fmtSupply(f.maxSupply)}`
          : "supply is uncapped",
      ),
    );
    body.appendChild(
      row("Turnover", `${(d.turnover * 100).toFixed(2)}%`, `${fmtCap(f.volume24h)} in 24h`),
    );
    body.appendChild(
      row(
        "From high",
        `−${d.belowAth.toFixed(1)}%`,
        `${fmtCap(f.ath)} on ${f.athDate.slice(0, 10)}`,
      ),
    );

    /* The only figures with an unambiguous sign, and so the only ones that get
       the market hues. */
    body.appendChild(
      h(
        "div",
        { class: "fund-changes" },
        row("24h", pct(f.change24h), "", f.change24h >= 0 ? "pos" : "neg"),
        row("7d", pct(f.change7d), "", f.change7d >= 0 ? "pos" : "neg"),
        row("30d", pct(f.change30d), "", f.change30d >= 0 ? "pos" : "neg"),
      ),
    );

    for (const note of d.notes) {
      body.appendChild(h("div", { class: "fund-note", text: note }));
    }

    body.appendChild(
      h("div", {
        class: "fund-source",
        text: `CoinGecko, ${f.updatedAt.slice(0, 16).replace("T", " ")}Z. Circulating supply is self-reported by the project, and float and dilution are computed from it.`,
      }),
    );
  };

  renderEffect(() => {
    /* Depend on the row set AND the symbol, so switching instruments repaints
       even when the aggregator data has not changed. */
    opts.service.rows();
    opts.service.loading();
    const symbol = opts.symbol();
    paint(opts.service.find(symbol));
  });

  return body;
}
