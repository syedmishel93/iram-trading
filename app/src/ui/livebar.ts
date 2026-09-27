/**
 * The live bar — one row that answers "where am I, and what am I in?".
 *
 * WHAT IT REPLACES
 * The status bar reported on the TERMINAL: feed source, latency, bar count,
 * stream state, a note, the clock. All true, none of it about the market and
 * none of it about your money. The v39 build carried prices, ATR, funding, open
 * P&L, heat and the guard state in a live ticker; none of that survived the
 * rewrite, so the busiest row on screen said nothing you could trade on.
 *
 * This is that row, rebuilt. The plumbing collapses into one health chip that
 * expands on click, and the space it frees carries numbers.
 *
 * WHY IT DOES NOT SCROLL
 * v39's was a marquee cycling every field in turn. You cannot find a number
 * that is moving and you certainly cannot compare two. Fixed zones in a fixed
 * order mean the eye learns one map and keeps it; values update in place and
 * the layout does not.
 *
 * WHY FIELDS ARE RANKED, AND THE MEASUREMENT THAT FORCED IT
 * Drawing the first version, the field list came to **1,377px of content in a
 * 1,280px bar**. RSI, the funding countdown, the day-range percentage, the
 * position count and the UTC clock all had to go before it fitted — and RSI is
 * already drawn on the chart behind it.
 *
 * So the bar cannot assume it fits, and the three ways of pretending otherwise
 * are all worse than dropping a field: clipping hides a number that still looks
 * present, wrapping steals a row from the chart, and shrinking the type makes
 * every number harder to read to save the least important one. It drops the
 * lowest-ranked field first, exactly as `deskbar.ts` spills desks it cannot fit,
 * and the rank is fixed and inspectable rather than emergent from source order.
 *
 * THE TICKER SLOT, AND THE BUG THAT PUT IT HERE
 * v54 moved the tape down from the context bar. Up there it was `flex: 1 1
 * 18rem` competing with the symbol picker, the timeframes, the chart styles
 * and the moving averages for one row's width — and on a real layout it lost,
 * collapsing to about forty pixels and rendering as `Te…`. A reading surface
 * wedged between controls is a reading surface that gets squeezed to nothing.
 *
 * Down here it is a first-class participant in the fit rather than a flex item
 * fighting for scraps: it is measured at a MINIMUM legible width, ranked with
 * everything else, and dropped outright when the row cannot hold it. Kept, it
 * takes whatever slack is left. That is the same contract every field has —
 * either the operator can read it, or it is not on the bar.
 */

import { h, clear } from "./dom";
import { renderEffect } from "../core/signal";

/** Left to right. `health` is pinned and never participates in fitting. */
export type Zone = "instrument" | "market" | "money";

export interface LiveField {
  readonly id: string;
  readonly zone: Zone;
  /**
   * Lower survives longer. Ranks are absolute across the whole bar, not per
   * zone: when space runs out, the least useful number goes wherever it sits.
   */
  readonly rank: number;
  /** Uppercase micro-label, or omitted when the value reads for itself. */
  readonly label?: string;
  readonly value: () => string;
  /**
   * The long form, as a native tooltip. Omitted means the value reads for
   * itself.
   *
   * Added for the live-analysis field, which is two or three words standing in
   * for a whole sentence — "structure broke" for "Change of character confirmed
   * downward on the bar that just closed, confidence 0.81 against a 0.5 floor".
   * A field this compact either has somewhere to put the rest or it is a label
   * pretending to be a readout. A `title` attribute and not a CSS hover, so
   * nothing here needs `@media (hover: hover)` and it still reaches a keyboard
   * and a screen reader.
   */
  readonly title?: () => string;
  /** Colour role; omitted means default text. */
  readonly tone?: () => TickTone | "pos" | "neg" | "warn" | "mute" | undefined;
  /**
   * False when no source covers this field for the current instrument. The
   * field is then rendered as a NAMED GAP rather than dropped silently or
   * printed as a zero — see `honest` below.
   */
  readonly covered?: () => boolean;
}

/**
 * Which fields fit, best-ranked first.
 *
 * Pure, so the rule is testable without a layout engine. `widths` is measured
 * once per field by the caller; `available` is the room the zones actually have.
 *
 * Returns ids in the ORIGINAL order, not rank order — the bar's whole value is
 * that positions are stable, so dropping a field must never reshuffle the rest.
 */
export function fitFields(
  fields: readonly LiveField[],
  widths: ReadonlyMap<string, number>,
  available: number,
): string[] {
  const total = (list: readonly LiveField[]): number =>
    list.reduce((sum, f) => sum + (widths.get(f.id) ?? 0), 0);

  const kept = [...fields];
  if (total(kept) <= available) return kept.map((f) => f.id);

  /* Drop worst-ranked until it fits. A field with no measured width counts as
     zero, so an unmeasured field is never the reason something else is cut. */
  const byRank = [...fields].sort((a, b) => b.rank - a.rank);
  const dropped = new Set<string>();
  for (const f of byRank) {
    if (total(kept.filter((k) => !dropped.has(k.id))) <= available) break;
    dropped.add(f.id);
  }

  return kept.filter((f) => !dropped.has(f.id)).map((f) => f.id);
}

/**
 * What a field is allowed to render.
 *
 * The honesty contract, as a function. A field with no source is a NAMED GAP —
 * never a zero, never a dash that could be read as one, and never the last
 * value it happened to have. A covered field renders its value.
 */
export function honest(field: LiveField): { text: string; gap: boolean } {
  if (field.covered && !field.covered()) {
    /* The field renders its own label beside this, so repeating the name here
       produced "SPREAD spread — none" on screen. A labelled field says only
       what is wrong; an unlabelled one has to name itself. */
    return { text: field.label ? "none" : `${field.id} — none`, gap: true };
  }
  return { text: field.value(), gap: false };
}

export interface LiveBarOptions {
  readonly fields: readonly LiveField[];
  /**
   * Pinned to the right and never dropped: the half-typed-chord indicator and
   * the notification bell. Both are about the terminal's CURRENT state rather
   * than the market, and a mode you cannot see is a mode you are stuck in.
   */
  readonly trailing?: readonly HTMLElement[];
  /**
   * A line of running text — the tape. Unlike a field it has no single value
   * to render, so it arrives as an element and the bar only decides whether
   * there is room for it.
   */
  readonly ticker?: {
    readonly el: HTMLElement;
    /** Ranked against the fields. High, because a headline is a convenience. */
    readonly rank: number;
    /**
     * Below this it is not readable and is dropped instead of truncated. The
     * `Te…` bug in one number: a ticker narrower than this is worse than no
     * ticker, because the dot still says the feed is live.
     */
    readonly minWidth: number;
  };
  /** The pinned health chip. Rendered first and never dropped. */
  readonly health: {
    readonly dot: () => "live" | "delayed" | "stale" | "off";
    readonly text: () => string;
    readonly onExpand: () => void;
  };
}

export interface LiveBar {
  readonly el: HTMLElement;
  /** Re-measure and re-fit. Called on resize and when the density changes. */
  refit(): void;
  destroy(): void;
}

const ZONE_ORDER: readonly Zone[] = ["instrument", "market", "money"];

export function createLiveBar(opts: LiveBarOptions): LiveBar {
  const el = h("footer", { class: "livebar", role: "status" }) as HTMLElement;

  const health = h(
    "button",
    {
      class: "lb-health",
      type: "button",
      title: "Feed and connection detail",
      onclick: () => opts.health.onExpand(),
    },
    h("span", { class: "lb-dot", "data-feed": () => opts.health.dot() }),
    h("span", { class: "lb-health-text", text: () => opts.health.text() }),
    h("span", { class: "lb-health-caret", text: "▴", "aria-hidden": "true" }),
  );

  const zoneEls = new Map<Zone, HTMLElement>();
  const fieldEls = new Map<string, HTMLElement>();

  el.appendChild(health);
  for (const zone of ZONE_ORDER) {
    const z = h("div", { class: "lb-zone", "data-zone": zone }) as HTMLElement;
    zoneEls.set(zone, z);
    el.appendChild(z);
  }

  /* Between the zones and the trailing controls: the numbers keep their fixed
     map on the left, the ticker takes the slack, the bell stays pinned right. */
  const tickerSlot = opts.ticker
    ? (h("div", { class: "lb-ticker" }, opts.ticker.el) as HTMLElement)
    : null;
  if (tickerSlot) el.appendChild(tickerSlot);

  const trailing = h("div", { class: "lb-trailing" }) as HTMLElement;
  for (const node of opts.trailing ?? []) trailing.appendChild(node);
  el.appendChild(trailing);

  for (const field of opts.fields) {
    const node = h(
      "span",
      {
        class: "lb-field",
        "data-tone": () => field.tone?.() ?? "",
        ...(field.title === undefined ? {} : { title: () => field.title?.() ?? "" }),
      },
      ...(field.label ? [h("span", { class: "lb-key", text: field.label })] : []),
      h("span", {
        class: "lb-val",
        "data-gap": () => String(honest(field).gap),
        text: () => honest(field).text,
      }),
    ) as HTMLElement;
    fieldEls.set(field.id, node);
    zoneEls.get(field.zone)?.appendChild(node);
  }

  /**
   * Measure with everything shown, or the widths are wrong.
   *
   * A hidden field reports zero, so measuring the current layout would say the
   * bar fits and it would never restore a field when the window grew back.
   */
  const measure = (): Map<string, number> => {
    const widths = new Map<string, number>();
    for (const [id, node] of fieldEls) {
      const wasHidden = node.hidden;
      node.hidden = false;
      /* Include the gap the flex layout puts after it, or the sum understates
         the real cost of every field but the last. */
      widths.set(id, node.getBoundingClientRect().width + FIELD_GAP);
      node.hidden = wasHidden;
    }
    return widths;
  };

  const refit = (): void => {
    const barWidth = el.getBoundingClientRect().width;
    if (barWidth === 0) return; // not laid out yet; nothing to decide
    const room =
      barWidth -
      health.getBoundingClientRect().width -
      trailing.getBoundingClientRect().width -
      ZONE_PADDING;
    const widths = measure();

    /* The ticker competes as a field whose width is its MINIMUM legible one,
       not its content's. Measuring its content would let a long headline
       evict three numbers and a short one evict none — the bar's geometry
       would then depend on what happened to be on the tape. */
    const contenders: LiveField[] = [...opts.fields];
    if (opts.ticker && tickerSlot) {
      widths.set(TICKER_ID, opts.ticker.minWidth + FIELD_GAP);
      contenders.push({
        id: TICKER_ID,
        zone: "market",
        rank: opts.ticker.rank,
        value: () => "",
      });
    }

    const keep = new Set(fitFields(contenders, widths, room));
    for (const [id, node] of fieldEls) node.hidden = !keep.has(id);
    if (tickerSlot) tickerSlot.hidden = !keep.has(TICKER_ID);
    for (const [, z] of zoneEls) {
      /* A zone with nothing left keeps no divider and no padding. */
      z.hidden = ![...z.children].some((c) => !(c as HTMLElement).hidden);
    }
  };

  /* Values are reactive; the FIT is not — it only has to change when the
     geometry does, and re-fitting on every tick would thrash the layout. */
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => refit()) : null;
  observer?.observe(el);

  /* One pass after the first paint, once the row has a width. */
  renderEffect(() => {
    refit();
  });

  return {
    el,
    refit,
    destroy() {
      observer?.disconnect();
      clear(el);
      el.remove();
    },
  };
}

/** The ticker's id in the fit, kept out of the caller's id space. */
const TICKER_ID = "__ticker";

/** Flex gap between fields, mirrored from the stylesheet. */
const FIELD_GAP = 14;
/** Zone padding and dividers the fields do not get to use. */
const ZONE_PADDING = 48;

/** Price direction of the latest print. NOT `pos`/`neg`, which are about value. */
export type TickTone = "up" | "down";

/**
 * The last price's colour: the direction of the most recent CHANGE.
 *
 * DELIBERATELY NOT ANIMATED. The obvious premium touch is a flash on every
 * tick, and CLAUDE.md's motion rule refuses it on frequency: a price prints
 * thousands of times a day, and anything met that often does not animate. The
 * information the flash carries — which way the last print went — is kept as a
 * state instead, applied instantly.
 *
 * An unchanged print HOLDS the previous direction. Blinking back to neutral
 * on every equal print would be motion by another name, and would say less.
 * Wears the candle colours, not the P&L ones: this is price direction, and
 * someone who set blue-and-orange candles means it here too.
 */
export function nextTickTone(prev: number | null, cur: number, held: TickTone | undefined): TickTone | undefined {
  if (prev === null || !Number.isFinite(prev) || !Number.isFinite(cur)) return held;
  if (cur > prev) return "up";
  if (cur < prev) return "down";
  return held;
}
