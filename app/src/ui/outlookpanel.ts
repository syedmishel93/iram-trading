/**
 * The inspector's "What's likely next" section: the price outlook.
 *
 * WHAT IT SHOWS
 *  - A fan of where price could be over the next H bars, simulated from this
 *    instrument's own volatility-scaled moves (analysis/outlook.ts). The inner
 *    band holds half the paths, the outer band nine in ten.
 *  - When there is a plan: the odds the simulated paths reach target 1 before
 *    the stop, beside the break-even rate that R needs. The two numbers side
 *    by side are the whole point — 41% is good at 2R and ruinous at 1R.
 *  - The outer band's MEASURED track record: how often, over past checks on
 *    this instrument, the realised close landed inside it.
 *
 * WHAT IT REFUSES
 * Every number here is MODELLED except the track record, and the section says
 * so in words next to the numbers rather than in a tooltip. `pUp` is labelled
 * a base rate, never a forecast. With no plan there are no odds; with a thin
 * history there is no track record, and the line says how many checks it had.
 */

import { h, clear } from "./dom";
import { renderEffect, type ReadSignal } from "../core/signal";
import { pkWhy } from "./panelkit";
import { createMiniChart, extent, hRule, label, linear, emptyNote, DASH_THRESHOLD, PAD, type MiniFrame, type Probe } from "./minichart";
import type { Outlook, OutlookCalibration, Refused, TouchOdds } from "../analysis/outlook";

export interface OutlookPlan {
  readonly direction: "long" | "short";
  readonly entry: number;
  readonly stop: number;
  readonly target1: number;
}

export interface OutlookPanelOptions {
  readonly outlook: ReadSignal<Outlook | Refused | null>;
  readonly odds: ReadSignal<TouchOdds | Refused | null>;
  readonly calibration: ReadSignal<OutlookCalibration | Refused | null>;
  readonly plan: ReadSignal<OutlookPlan | null>;
  /** Formats a price the way the rest of the terminal does. */
  readonly price: (v: number) => string;
}

/** The sentences under the fan. Pure, so the wording is tested with literals. */
export function outlookLines(
  o: Outlook,
  odds: TouchOdds | Refused | null,
  plan: OutlookPlan | null,
  price: (v: number) => string,
): { range: string; lean: string; odds: string | null } {
  const c = o.cone;
  const last = c.steps[c.steps.length - 1];
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const rel = (v: number): string => {
    const d = (v / c.last - 1) * 100;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}%`;
  };
  const range = last
    ? `Next ${c.horizon} bars: 9 in 10 simulated paths end between ${price(last.p5)} (${rel(last.p5)}) and ${price(last.p95)} (${rel(last.p95)}).`
    : "";
  const lean = `${pct(c.pUp)} of paths end higher — a base rate from this instrument's own moves, not a call on direction.`;

  let oddsLine: string | null = null;
  if (plan && odds && odds.ok) {
    const r = Math.abs(plan.target1 - plan.entry) / Math.abs(plan.entry - plan.stop);
    const needed = r > 0 ? 1 / (1 + r) : 1;
    oddsLine =
      `Target 1 before the stop in ${pct(odds.target1First)} of paths, stop first in ${pct(odds.stopFirst)}, ` +
      `neither in ${pct(odds.neither)}. At ${r.toFixed(2)}R the target needs to come first ${pct(needed)} of the time to break even.`;
  } else if (plan && odds && !odds.ok) {
    oddsLine = `No odds for this plan: ${odds.refused}`;
  }
  return { range, lean, odds: oddsLine };
}

export function createOutlookPanel(opts: OutlookPanelOptions): HTMLElement {
  const fan = createMiniChart(
    {
      height: 130,
      label: "Simulated range of price over the coming bars",
      pad: { ...PAD, l: 4, r: 58, b: 14 },
      paint: (f: MiniFrame): Probe | null => {
        const o = opts.outlook.peek();
        if (!o || !o.ok) {
          emptyNote(f, o && !o.ok ? "no outlook — see below" : "waiting for bars");
          return null;
        }
        const steps = o.cone.steps;
        const H = steps.length;
        const plan = opts.plan.peek();
        const ys: number[] = [o.cone.last];
        for (const s of steps) ys.push(s.p5, s.p95);
        if (plan) ys.push(plan.stop, plan.target1);
        /* `extent` pads nothing on a real range and its `widen` is absolute, so
           the margin is added here: 6% of the span, so the fan's edges and the
           plan's levels never sit on the canvas border. */
        const raw = extent(ys, o.cone.last, o.cone.last * 0.001);
        const padY = (raw.hi - raw.lo) * 0.06;
        const lo = raw.lo - padY;
        const hi = raw.hi + padY;
        const x = linear(0, H, f.x0, f.x1);
        const y = linear(lo, hi, f.y1, f.y0);
        const { ctx, theme } = f;

        const band = (a: (i: number) => number, b: (i: number) => number, alpha: number): void => {
          ctx.beginPath();
          ctx.moveTo(x(0), y(o.cone.last));
          for (let i = 0; i < H; i++) ctx.lineTo(x(i + 1), y(a(i)));
          for (let i = H - 1; i >= 0; i--) ctx.lineTo(x(i + 1), y(b(i)));
          ctx.closePath();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = theme.accent;
          ctx.fill();
          ctx.globalAlpha = 1;
        };
        const at = (i: number): (typeof steps)[number] => steps[i] as (typeof steps)[number];
        band((i) => at(i).p95, (i) => at(i).p5, 0.14);
        band((i) => at(i).p75, (i) => at(i).p25, 0.26);

        ctx.beginPath();
        ctx.moveTo(x(0), y(o.cone.last));
        for (let i = 0; i < H; i++) ctx.lineTo(x(i + 1), y(at(i).p50));
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1.25;
        ctx.stroke();

        const tags: { text: string; y: number; color: string }[] = [
          { text: "now", y: y(o.cone.last), color: theme.faint },
        ];
        hRule(f, y(o.cone.last), { color: theme.faint, dash: DASH_THRESHOLD });
        if (plan) {
          hRule(f, y(plan.target1), { color: theme.pos, dash: DASH_THRESHOLD });
          hRule(f, y(plan.stop), { color: theme.neg, dash: DASH_THRESHOLD });
          tags.push({ text: "target", y: y(plan.target1), color: theme.pos });
          tags.push({ text: "stop", y: y(plan.stop), color: theme.neg });
        }
        /* The rules stay where the prices are; only the NAMES are spread out.
           A 1R plan puts target, price and stop within a few pixels of each
           other on a 24-bar scale, and the first version printed all three
           words on top of one another. */
        for (const t of spreadLabels(tags, 11, f.y0 + 6, f.y1)) label(f, t.text, f.x1 + 4, t.y + 3, "left", t.color);
        label(f, "now", f.x0, f.h - 2);
        label(f, `+${H} bars`, f.x1, f.h - 2, "right");

        return (px) => {
          if (px < f.x0 || px > f.x1) return null;
          const i = Math.max(1, Math.min(H, Math.round(((px - f.x0) / (f.x1 - f.x0)) * H)));
          const s = at(i - 1);
          return {
            x: x(i),
            y: y(s.p50),
            mark: "cross",
            lines: [
              `+${i} bar${i === 1 ? "" : "s"}`,
              `middle ${opts.price(s.p50)}`,
              `half of paths ${opts.price(s.p25)}–${opts.price(s.p75)}`,
              `9 in 10 ${opts.price(s.p5)}–${opts.price(s.p95)}`,
            ],
          };
        };
      },
    },
    "height:130px",
  );

  renderEffect(() => {
    opts.outlook();
    opts.plan();
    fan.repaint();
  });

  const text = h("div", { class: "ol-text" });
  renderEffect(() => {
    const o = opts.outlook();
    const odds = opts.odds();
    const plan = opts.plan();
    clear(text);
    if (!o) {
      text.appendChild(h("p", { class: "pk-empty", "data-kind": "loading", text: "Waiting for enough closed bars." }));
      return;
    }
    if (!o.ok) {
      text.appendChild(h("p", { class: "pk-empty", "data-kind": "unavailable", text: `No outlook: ${o.refused}` }));
      return;
    }
    const l = outlookLines(o, odds, plan, opts.price);
    text.appendChild(h("p", { class: "ol-range", text: l.range }));
    if (l.odds) text.appendChild(h("p", { class: "ol-odds", text: l.odds }));
    text.appendChild(h("p", { class: "ol-lean", text: l.lean }));
  });

  const track = h("p", { class: "ol-track" });
  renderEffect(() => {
    const c = opts.calibration();
    const o = opts.outlook();
    track.dataset["state"] = !c ? "loading" : !c.ok ? "refused" : c.usable ? "measured" : "thin";
    track.textContent = !c
      ? "Checking the band against this instrument's history…"
      : !c.ok
        ? `Track record not available: ${c.refused}`
        : c.usable
          ? `Measured: ${c.note}`
          : `Not enough history to check the band yet — ${c.trials} past checks, ${30} needed.`;
    track.hidden = o !== null && !o.ok;
  });

  return h(
    "div",
    { class: "ol-panel" },
    fan.el,
    text,
    track,
    pkWhy(
      () => {
        const o = opts.outlook();
        const odds = opts.odds();
        const base =
          o && o.ok
            ? `Simulated: ${o.cone.draws.toLocaleString()} paths of ${o.cone.horizon} bars, drawn from ${o.cone.n.toLocaleString()} of this instrument's own past moves, each rescaled to today's volatility (${(o.cone.sigmaNow * 100).toFixed(2)}% per bar). `
            : "";
        const assumptions = [...(o && o.ok ? o.cone.assumptions : []), ...(odds && odds.ok ? odds.assumptions : [])];
        const unique = [...new Set(assumptions)];
        return `${base}Assumes: ${unique.join("; ")}. Everything above is modelled except the track record, which is measured.`;
      },
      "How this is simulated",
    ),
  ) as HTMLElement;
}

/**
 * Push label positions apart so no two sit closer than `gap` px, keeping them
 * inside [top, bottom] and in their original vertical order. Pure; tested.
 */
export function spreadLabels<T extends { y: number }>(items: readonly T[], gap: number, top: number, bottom: number): T[] {
  const out = [...items].map((t) => ({ ...t })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as T;
    const cur = out[i] as T;
    if (cur.y - prev.y < gap) cur.y = prev.y + gap;
  }
  const last = out[out.length - 1];
  if (last && last.y > bottom) {
    const shift = last.y - bottom;
    for (const t of out) t.y -= shift;
  }
  const first = out[0];
  if (first && first.y < top) {
    const shift = top - first.y;
    for (const t of out) t.y += shift;
  }
  return out;
}
