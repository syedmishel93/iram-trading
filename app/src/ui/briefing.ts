/**
 * The Briefing — the terminal's front door.
 *
 * WHAT WAS MISSING, AND HOW IT WAS MISSING
 * Twenty-one desks behind five dropdown menus, and the terminal opens on a
 * chart of whatever instrument was last looked at. Every question the product
 * can answer is answerable; NONE of them is answered until you know which of
 * the twenty-one rooms to walk into. There was no surface that said "here is
 * where you stand, here is what changed, here is what to look at" — so the
 * answer to "what should I do now" was: remember the map.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DESK STATES NO NEW FACTS, AND THAT IS THE DESIGN
 *
 * Every figure on it is pulled from the module that OWNS that figure and
 * carries a link back to the desk that owns it. Heat comes from
 * `risk/sizing.ts portfolioHeat`; the verdict from the Setup card's own
 * `SetupView`; the cross-symbol reads from the opportunity scan the watch rail
 * already drives; "what changed" from the live engine; fires from the alert
 * store's log; the regime from the model service.
 *
 * It is a table of contents with values on it, not a second analysis. That is a
 * deliberate refusal: the repository's rule is one fact, one owner, and the
 * fastest way to break it is a dashboard that recomputes a number "for
 * convenience" and then disagrees with the desk it came from. The equity defect
 * in `core/account.ts` is that mistake, written down.
 *
 * WHAT IT WILL NOT DO
 * It does not net anything into a score. Six cards answering six different
 * questions on six different axes cannot be added up, and a single "readiness"
 * number would be exactly the opaque score `CLAUDE.md` forbids. The cards sit
 * beside each other and the reader does the joining, which is the only honest
 * arrangement.
 *
 * EVERY CARD REFUSES
 * No positions, no scan yet, no events since load, nothing fired, no model
 * service — each says so in the operator's words, with what would fix it. A
 * card that renders a dash when it has nothing is a card that looks broken;
 * a card that renders a plausible zero is worse.
 */

import { h } from "./dom";
import { pkChip, pkEmpty, pkRowsLive, pkWhy, type PkRow } from "./panelkit";
import { computed, renderEffect, type ReadSignal } from "../core/signal";
import { ago } from "./toast";
import { KIND_LABEL } from "./livefeed";
import { portfolioHeat } from "../risk/sizing";
import { sessionStatuses } from "../data/sessionmap";
/* The SAME price formatter the chart legend and the crosshair use. A second
   one here would print a different number of decimals for the same price on
   two surfaces of one screen. */
import { fmt } from "./shell/format";
/* An id is not a word. `strategy` on a verdict is a detector id ("choch"),
   which is the right key for a record and the wrong thing to read — the
   mistake this function exists to stop, recorded in CLAUDE.md. */
import { nameForKind } from "../detect";
import type { Account, AccountStore } from "../core/account";
import type { HeatResult, Position } from "../risk/sizing";
import type { SetupView } from "../setup/ui";
import type { LiveEvent } from "../analysis/live";
import type { AlertFire } from "../alert/types";
import type { WatchSetup } from "./watchrail";
import type { IntelResult, RegimeRead } from "../data/intel";
import type { ScanRow } from "../scan/scanner";
import { createKV, type KV } from "../store/kv";
import { createBriefCard } from "./today/brief";
import { createPlan } from "./today/plan";
import { createScanList } from "./today/scanlist";
import { suggestFocus } from "./today/focus";
import { whoTag } from "./today/card";

export interface BriefingOptions {
  /** The chart's instrument, so "this chart" names what it is about. */
  readonly symbol: ReadSignal<string>;
  readonly timeframe: ReadSignal<string>;
  /** Equity and the currency every money figure is stated in. One owner. */
  readonly account: AccountStore;
  /** The book, from the Risk desk. */
  readonly positions: ReadSignal<readonly Position[]>;
  /** The Setup card's own view model — never a second derivation of it. */
  readonly setup: ReadSignal<SetupView | null>;
  /** The live engine's transitions, newest last. */
  readonly events: ReadSignal<readonly LiveEvent[]>;
  /** The alert store's log, newest first. */
  readonly fires: ReadSignal<readonly AlertFire[]>;
  /** What the opportunity scan found, by symbol. The watch rail's own map. */
  readonly opportunities: ReadSignal<ReadonlyMap<string, WatchSetup>>;
  /**
   * Whether the cross-symbol scan has ever run.
   *
   * SEPARATE FROM THE MAP BEING EMPTY, and the first version conflated them.
   * The map always holds at least the chart's own read, so "one entry, and it
   * is the symbol on screen" was being reported as "the scan found nothing
   * else" — which states that a scan happened. It had not. A refusal that
   * implies work was done is worse than no refusal.
   *
   * A plain accessor rather than a `ReadSignal`, because the shell answers it
   * with `lazyDesk().built` — which is reactive but is not a signal object.
   */
  readonly scanned: () => boolean;
  /** The model service's regime read, or its refusal, or null before it runs. */
  readonly regime: ReadSignal<IntelResult<RegimeRead> | null>;
  /** The shell's one clock. Ticks; never `Date.now()` read in a render. */
  readonly nowMs: ReadSignal<number>;
  /** Put a symbol on the chart. */
  onPick(symbol: string): void;
  /** Open the desk that owns a figure. */
  onOpen(view: string): void;
  /*
   * v60 Today workspace. All OPTIONAL, so a shell that has not been updated
   * still compiles and the desk degrades with a stated reason for each.
   */
  /** Open the analyst. The shell's `askAgent`. Absent: "Ask a follow-up" is disabled. */
  readonly onAsk?: (question?: string) => void;
  /** The watchlist in its own order — the focus list's fallback source. */
  readonly watchlist?: () => readonly string[];
  /** The last Opportunities scan's rows, for the per-symbol reasons. */
  readonly scanRows?: () => readonly ScanRow[];
  /** Where the day's plan is kept. Defaults to the browser store. */
  readonly kv?: KV;
}

/** "Good morning", by the operator's own clock. PURE. */
export function greeting(ms: number): string {
  const hr = new Date(ms).getHours();
  return hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
}

/** How many rows a card will show before it stops and says how many it has. */
const ROW_CAP = 6;

/**
 * The link on a card's header.
 *
 * Every card carries one, and it is the second half of "states no new facts":
 * a number here that you cannot get back to its owner from is a number you
 * have to take on trust.
 */
function ownerLink(label: string, onOpen: () => void): HTMLElement {
  return h("button", {
    class: "bf-owner",
    type: "button",
    text: label,
    onclick: onOpen,
  }) as HTMLElement;
}

function card(title: string, question: string, link: HTMLElement, ...body: HTMLElement[]): HTMLElement {
  return h(
    "section",
    { class: "dd-panel bf-card" },
    h(
      "header",
      { class: "bf-card-head" },
      h(
        "div",
        { class: "bf-card-titles" },
        h("h2", { class: "bf-card-title", text: title }),
        h("p", { class: "bf-card-q", text: question }),
      ),
      link,
    ),
    ...body,
  ) as HTMLElement;
}

/**
 * A live list.
 *
 * One render effect per card rather than reactive props per row: `h()` binds a
 * reactive prop with an un-owned effect, and a list that rebuilds its rows
 * would leak one per row per rebuild. Same rule the watch rail follows.
 */
function liveList(cls: string, rows: () => readonly HTMLElement[]): HTMLElement {
  const host = h("div", { class: cls }) as HTMLElement;
  renderEffect(() => {
    host.replaceChildren(...rows());
  });
  return host;
}

function money(v: number, currency: string): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

/**
 * "Where you stand", as rows — pure, so the rules in it can be tested.
 *
 * WHY THIS IS THE PART THAT IS TESTED
 * Almost everything else on this desk is composition: it takes another
 * module's answer and puts it on screen, and a test of that would be a test
 * that `h()` appends children. What is NOT composition is here — which
 * qualifications appear, and when:
 *
 *   - an unprotected position makes the heat figure an UNDERSTATEMENT, and the
 *     row has to say so, because a percentage that silently omits an unbounded
 *     loss is the most dangerous number this desk could print;
 *   - a heat figure is toned badly only against the operator's OWN per-trade
 *     risk, never for being large in the abstract;
 *   - unmeasurable equity produces a refusal rather than a percentage of a
 *     number that does not mean anything;
 *   - an unresolved account conflict is stated before anyone sizes on it.
 *
 * Taking the four inputs rather than reading signals is what makes those
 * testable at all.
 */
export function standingRows(
  acct: Account,
  h0: HeatResult,
  openCount: number,
  conflicts: number,
): readonly PkRow[] {
  const rows: PkRow[] = [
    { label: "Equity", value: money(acct.equity, acct.currency) },
    {
      label: "Open positions",
      value: String(openCount),
      /* Spread rather than `note: cond ? x : undefined`, because
         `exactOptionalPropertyTypes` treats an explicit undefined as a
         different thing from an absent key — which is the point of the flag. */
      ...(openCount === 0
        ? { note: "No open positions — the figures below are what-ifs." }
        : {}),
    },
  ];
  if (openCount > 0) {
    rows.push({
      label: "At risk now",
      value: h0.measured ? `${h0.heatPct.toFixed(2)}% of equity` : "not measurable",
      note: h0.measured
        ? `${money(h0.openRisk, acct.currency)} if every stop is hit.`
        : "Account equity is not set, so percentages can't be shown.",
      /* Toned only when the standing is bad — three times the operator's own
         per-trade risk, in their own setting. Never for being merely large. */
      ...(h0.measured && h0.heatPct > acct.riskPct * 3 ? { tone: "neg" as const } : {}),
    });
    if (h0.unprotected.length > 0) {
      rows.push({
        label: "No stop",
        value: h0.unprotected.join(", "),
        note: "Some positions have no stop — real risk is HIGHER than shown.",
        tone: "neg",
      });
    }
    if (h0.secured.length > 0) {
      rows.push({
        label: "Stop past entry",
        value: h0.secured.join(", "),
        note: "These cannot lose from here.",
        tone: "pos",
      });
    }
  }
  if (conflicts > 0) {
    rows.push({
      label: "Account",
      value: "provisional",
      note: "Two different equity figures are set. Fix it on the Risk desk before sizing.",
      tone: "attn",
    });
  }
  return rows;
}

/** The tone a verdict kind reads in. Follows the STANDING, never a number. */
function verdictTone(kind: string): "pos" | "neg" | "attn" | "accent" {
  if (kind === "go") return "pos";
  if (kind === "armed") return "accent";
  if (kind === "stand-down") return "neg";
  return "attn";
}

export function createBriefing(opts: BriefingOptions) {
  const {
    symbol,
    timeframe,
    account,
    positions,
    setup,
    events,
    fires,
    opportunities,
    scanned,
    regime,
    nowMs,
  } = opts;

  // ───────────────────────────────────────────────────── where you stand ───

  /**
   * The book, through its one owner.
   *
   * `portfolioHeat` is called here with the SAME arguments the Risk desk calls
   * it with — positions and `account.equity` — rather than a figure copied off
   * that desk. Calling the shared function is not a second owner; caching its
   * answer somewhere else would be.
   */
  const heat = computed(() => portfolioHeat(positions(), account.account().equity));

  const standRows = (): readonly PkRow[] =>
    standingRows(account.account(), heat(), positions().length, account.conflicts().length);

  const standCard = card(
    "Where you stand",
    "What is already at risk",
    ownerLink("Risk desk", () => opts.onOpen("risk")),
    pkRowsLive(standRows),
  );

  // ───────────────────────────────────────────────────────── this chart ───

  const chartBody = liveList("bf-verdict", () => {
    const sv = setup();
    if (sv === null) {
      return [
        pkEmpty("loading", "Not enough data yet — needs at least 30 closed bars."),
      ];
    }
    const v = sv.verdict;
    const out: HTMLElement[] = [
      h(
        "div",
        { class: "bf-verdict-head" },
        h("span", { class: "bf-verdict-count", text: `${v.passed}/${v.total}` }),
        h(
          "div",
          { class: "bf-verdict-words" },
          h("strong", { class: "bf-verdict-line", text: v.headline }),
          h("span", { class: "bf-verdict-read", text: v.readLine }),
        ),
        pkChip(v.strategy === null ? "discretionary" : nameForKind(v.strategy), verdictTone(v.kind)),
      ) as HTMLElement,
    ];
    if (sv.plan !== null) {
      const p = sv.plan;
      out.push(
        pkRowsLive(() => [
          { label: "Direction", value: p.direction === "long" ? "Long" : "Short" },
          { label: "Entry", value: `${fmt(p.entryLow)} – ${fmt(p.entryHigh)}` },
          {
            label: "Stop",
            value: fmt(p.stop),
            /* `stopAtrLive`, not `plan.stopAtrMultiple`. The plan is held still
               once drawn and its frozen ratio is only good for saying what the
               plan looked like at the time — setup/plan.ts says so. */
            note: `${sv.stopAtrLive.toFixed(2)}x ATR now, from ${p.stopFrom}.`,
          },
          { label: "Target 1 · 1R", value: fmt(p.target1) },
          { label: "Target 2 · 2R", value: fmt(p.target2) },
          {
            label: "Size",
            value: sv.size === null ? "not sized" : sv.size.qty,
            note:
              sv.size === null
                ? "Set account equity to see position size."
                : `${sv.size.riskMoney} at risk (${sv.size.riskPct}).`,
          },
        ]),
      );
    } else if (sv.planProblem !== null) {
      out.push(pkEmpty("unavailable", sv.planProblem));
    }
    if (v.watchLevel !== null) {
      out.push(
        h("p", {
          class: "bf-note",
          text: `Waiting for price to reach ${fmt(v.watchLevel)}.`,
        }) as HTMLElement,
      );
    }
    return out;
  });

  const chartCard = card(
    "This chart",
    "The instrument on screen",
    ownerLink("Open chart", () => opts.onOpen("chart")),
    h("p", { class: "bf-scope", text: () => `${symbol()} · ${timeframe()}` }) as HTMLElement,
    chartBody,
  );

  // ────────────────────────────────────────────────────── what changed ───

  const changedBody = liveList("bf-events", () => {
    const list = events();
    if (list.length === 0) {
      return [
        pkEmpty(
          "empty",
          "Nothing new since this chart loaded.",
        ),
      ];
    }
    const recent = list.slice(-ROW_CAP).reverse();
    const t = nowMs();
    return recent.map((e) =>
      h(
        "div",
        { class: "bf-event", "data-sev": e.severity },
        h(
          "div",
          { class: "bf-event-top" },
          h("span", { class: "bf-event-kind", text: KIND_LABEL[e.kind] }),
          h("span", { class: "bf-event-when", text: ago(e.time, t) }),
        ),
        h("p", { class: "bf-event-what", text: e.what }),
        h("p", { class: "bf-event-why", text: e.because }),
      ) as HTMLElement,
    );
  });

  const changedCard = card(
    "What changed",
    "Since you last looked",
    ownerLink("Full feed", () => opts.onOpen("chart")),
    changedBody,
  );

  // ───────────────────────────────────────────────── where else to look ───

  const elsewhereBody = liveList("bf-opps", () => {
    const map = opportunities();
    const here = symbol();
    const rows = [...map.entries()].filter(([sym]) => sym !== here);
    if (rows.length === 0) {
      return [
        pkEmpty(
          "empty",
          scanned()
            ? "Scan done — nothing else on your list worth a plan."
            : "Not scanned yet. Open Opportunities to scan your list.",
        ),
      ];
    }
    /* Live reads first, and inside each group the order the scan produced —
       which is already ranked. Re-sorting here would be a second ranking with
       no stated basis, which is exactly the opaque score this desk refuses. */
    rows.sort((a, b) => Number(b[1].live) - Number(a[1].live));
    const shown = rows.slice(0, ROW_CAP);
    const out = shown.map(
      ([sym, s]) =>
        h(
          "button",
          {
            class: "bf-opp",
            type: "button",
            "data-live": String(s.live),
            onclick: () => opts.onPick(sym),
          },
          h("span", { class: "bf-opp-sym", text: sym }),
          h("span", { class: "bf-opp-label", text: s.label }),
          h("span", {
            class: "bf-opp-state",
            text: s.live ? "live" : "history says no",
          }),
        ) as HTMLElement,
    );
    if (rows.length > shown.length) {
      out.push(
        h("p", {
          class: "bf-note",
          text: `${rows.length - shown.length} more on the Opportunities desk.`,
        }) as HTMLElement,
      );
    }
    return out;
  });

  const elsewhereCard = card(
    "Where else to look",
    "What the scan found on the rest of your list",
    ownerLink("Opportunities", () => opts.onOpen("screener")),
    elsewhereBody,
    pkWhy(
      "Each row is that symbol's setup, read the same way as the chart. Click one to open it — nothing is traded.",
      "What a row is",
    ),
  );

  // ──────────────────────────────────────────────────────────── alerts ───

  const alertsBody = liveList("bf-fires", () => {
    const list = fires();
    if (list.length === 0) {
      return [
        pkEmpty("empty", "No alerts fired. Set alerts on the Signals desk."),
      ];
    }
    const t = nowMs();
    return list.slice(0, ROW_CAP).map((f) =>
      h(
        "div",
        { class: "bf-fire" },
        h(
          "div",
          { class: "bf-fire-top" },
          h("span", { class: "bf-fire-when", text: ago(f.time, t) }),
          h("span", { class: "bf-fire-price num", text: fmt(f.price) }),
        ),
        h("p", { class: "bf-fire-why", text: f.reason }),
      ) as HTMLElement,
    );
  });

  const alertsCard = card(
    "Alerts that fired",
    "What you asked to be told about",
    ownerLink("Signals", () => opts.onOpen("signals")),
    alertsBody,
  );

  // ──────────────────────────────────────────────────────── conditions ───

  const conditionsBody = liveList("bf-cond", () => {
    const out: HTMLElement[] = [];
    const r = regime();
    if (r === null) {
      out.push(
        pkEmpty(
          "empty",
          "Market type not checked yet — run it from Regime & model.",
        ),
      );
    } else if (r.ok === false) {
      out.push(pkEmpty("unavailable", r.error));
    } else {
      out.push(
        pkRowsLive(() => [
          {
            label: "Regime",
            value: r.state,
            note: `${(r.confidence * 100).toFixed(0)}% confidence over ${r.n} bars. ${r.note}`,
          },
        ]),
      );
    }
    const open = sessionStatuses(nowMs()).filter((s) => s.open);
    out.push(
      pkRowsLive(() => [
        {
          label: "Open now",
          value: open.length === 0 ? "nothing" : open.map((s) => s.session.name).join(", "),
          ...(open.length === 0
            ? { note: "All major sessions are closed — thin markets move more on the same order." }
            : {}),
        },
      ]),
    );
    return out;
  });

  const conditionsCard = card(
    "Conditions",
    "What kind of market this is",
    ownerLink("Sessions", () => opts.onOpen("sessions")),
    conditionsBody,
  );

  // ───────────────────────────────────────────────────────── today (v60) ───

  const brief = createBriefCard({
    inputs: () => ({
      symbol: symbol(),
      setup: setup(),
      events: events(),
      opportunities: opportunities(),
      scanned: scanned(),
      unprotected: heat().unprotected,
    }),
    onOpenChart: () => opts.onOpen("chart"),
    onAsk: opts.onAsk,
  });

  const plan = createPlan({
    suggestion: () =>
      suggestFocus({
        opportunities: opportunities(),
        scanned: scanned(),
        watchlist: opts.watchlist === undefined ? null : opts.watchlist(),
      }),
    kv: opts.kv ?? createKV(),
    now: () => nowMs(),
  });

  const scanList = createScanList({
    focus: plan.focus,
    inputs: () => ({
      chartSymbol: symbol(),
      setup: setup(),
      scanRows: opts.scanRows === undefined ? null : opts.scanRows(),
      opportunities: opportunities(),
      scanned: scanned(),
    }),
    onPick: (sym) => opts.onPick(sym),
  });

  // ───────────────────────────────────────────────────────────── layout ───

  const el = h(
    "div",
    { class: "dd bf" },
    h(
      "div",
      { class: "desk-head td-head" },
      whoTag("both", "AI briefs · you plan"),
      h("h1", {
        class: "td-title",
        text: () => `${greeting(nowMs())} Here's what matters, and what you'll do about it.`,
      }),
    ),
    h("div", { class: "td-top" }, brief.el, plan.el),
    scanList.el,
    h(
      "div",
      { class: "td-detail-head" },
      h("h2", { class: "td-detail-title", text: "The detail" }),
      h("p", { class: "view-sub", text: "Each figure comes from the desk named beside it." }),
    ),
    h(
      "div",
      { class: "bf-grid" },
      standCard,
      chartCard,
      changedCard,
      elsewhereCard,
      alertsCard,
      conditionsCard,
    ),
  ) as HTMLElement;

  return { el, plan };
}
