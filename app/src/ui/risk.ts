/**
 * The Risk desk.
 *
 * Every other desk in this terminal answers WHETHER. This one answers HOW MUCH,
 * which is the question that decides whether an account survives being wrong —
 * and it is the question a chart cannot help with at all.
 *
 * THE DESK IS A CALCULATOR, NOT AN ADVISOR
 * You supply the equity, the risk you are willing to take, the entry and the
 * stop. It multiplies. It never proposes a risk percentage, never says whether
 * a trade is worth taking, and cannot place, size or close anything at a
 * broker. The guardrails are limits YOU set, checked against numbers YOU
 * report — the desk has no connection to an account and says so on screen,
 * because a risk panel that looks like it is watching your positions when it is
 * not is worse than no risk panel.
 *
 * WHAT IT REFUSES TO ROUND OFF
 * The headline figure is the risk you will ACTUALLY take after the venue's
 * quantity step has been applied, not the one you asked for. Those differ, and
 * every calculator that shows only the second is quietly wrong.
 */

import { h } from "./dom";
import { symbolField, symbolOptions } from "./cards/symbolfield";
import { riskSize, type SizeResult as BrokerSize } from "../data/governor";
import { pkWhy } from "./panelkit";
import { signal, computed, effect, renderEffect, type ReadSignal, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import {
  analysePortfolio,
  SCENARIOS,
  MIN_HISTORY,
  type PortfolioRisk,
} from "../risk/portfolio";
import { sizeHedge, residualRiskFraction, type HedgeResult } from "../risk/hedge";
import type { ClosesSeries } from "../data/correlation";
import {
  sizePosition,
  rewardToRisk,
  portfolioHeat,
  checkGuards,
  stopFromAtr,
  stepDecimals,
  DEFAULT_GUARDS,
  type GuardConfig,
  type Position,
  type SizeResult,
} from "../risk/sizing";
import type { AccountStore } from "../core/account";

export interface RiskConfig {
  equity: number;
  riskPct: number;
  maxNotionalPct: number;
  feesPct: number;
  qtyStep: number;
  atrMultiple: number;
  guards: GuardConfig;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  equity: 10_000,
  riskPct: 1,
  maxNotionalPct: 100,
  feesPct: 0.1,
  qtyStep: 0,
  atrMultiple: 1.5,
  guards: DEFAULT_GUARDS,
};

const CONFIG_SLOT = {
  key: "risk.config",
  version: 1,
  fallback: (): RiskConfig => DEFAULT_RISK_CONFIG,
  validate: (v: unknown): RiskConfig | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const num = (k: string, d: number): number =>
      typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : d;
    const g = (o["guards"] ?? {}) as Record<string, unknown>;
    const gnum = (k: string, d: number): number =>
      typeof g[k] === "number" && Number.isFinite(g[k] as number) ? (g[k] as number) : d;
    return {
      equity: num("equity", DEFAULT_RISK_CONFIG.equity),
      riskPct: num("riskPct", DEFAULT_RISK_CONFIG.riskPct),
      maxNotionalPct: num("maxNotionalPct", DEFAULT_RISK_CONFIG.maxNotionalPct),
      feesPct: num("feesPct", DEFAULT_RISK_CONFIG.feesPct),
      qtyStep: num("qtyStep", 0),
      atrMultiple: num("atrMultiple", 1.5),
      guards: {
        dailyLossPct: gnum("dailyLossPct", DEFAULT_GUARDS.dailyLossPct),
        maxHeatPct: gnum("maxHeatPct", DEFAULT_GUARDS.maxHeatPct),
        maxPositions: gnum("maxPositions", DEFAULT_GUARDS.maxPositions),
      },
    };
  },
};

const BOOK_SLOT = {
  key: "risk.book",
  version: 1,
  fallback: (): Position[] => [],
  validate: (v: unknown): Position[] | null => {
    if (!Array.isArray(v)) return null;
    const out: Position[] = [];
    for (const raw of v) {
      if (raw === null || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o["symbol"] !== "string" || typeof o["qty"] !== "number") continue;
      if (typeof o["entry"] !== "number" || !Number.isFinite(o["entry"])) continue;
      out.push({
        symbol: o["symbol"],
        direction: o["direction"] === "short" ? "short" : "long",
        qty: o["qty"],
        entry: o["entry"],
        stop: typeof o["stop"] === "number" && Number.isFinite(o["stop"]) ? o["stop"] : null,
      });
    }
    return out;
  },
};

const DAY_SLOT = {
  key: "risk.today",
  version: 1,
  fallback: (): { day: string; realised: number } => ({ day: "", realised: 0 }),
  validate: (v: unknown): { day: string; realised: number } | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    return {
      day: typeof o["day"] === "string" ? o["day"] : "",
      realised: typeof o["realised"] === "number" ? o["realised"] : 0,
    };
  },
};

export interface RiskDeskOptions {
  readonly kv: KV;
  /** The one owner of equity and risk-per-trade. See `core/account.ts`. */
  readonly account: AccountStore;
  readonly symbol: Signal<string>;
  /** Last traded price on the chart, for the "use last price" buttons. */
  readonly lastPrice: () => number;
  /** Measured ATR at the newest closed bar. */
  readonly atr: () => number;
  /**
   * Closing history for a set of symbols, from the LOCAL ARCHIVE only.
   *
   * Deliberately not a fetcher. The portfolio figures are statistics of bars
   * that were genuinely stored, and a version of this that quietly went to the
   * network would turn a refusal ("no history for LINKUSDT") into a slow
   * request storm across every symbol in a book the moment the panel opened.
   */
  readonly loadCloses?: (symbols: readonly string[]) => Promise<ClosesSeries[]>;
  /** The instrument every beta is measured against. */
  readonly factorSymbol?: () => string;
  /**
   * Average daily traded value per symbol, for time-to-exit.
   *
   * Read after `loadCloses` resolves, because the archive walk that produces
   * the closes is also what measures the volume.
   */
  readonly advBySymbol?: () => ReadonlyMap<string, number>;
  /**
   * An empty element mounted above the hand-entered book, filled by the shell.
   *
   * A SLOT AND NOT A DEPENDENCY, because the alternative is a cycle: the
   * broker panel needs the reconciled book, the reconciliation needs this
   * desk's hand-entered rows, and this desk would then need the broker model
   * to build its own DOM. Handing over an empty container lets the shell build
   * both in order and fill the hole afterwards, with no forward reference and
   * nothing here knowing a broker exists.
   */
  readonly bookSlot?: HTMLElement;
  /**
   * The RECONCILED book, when something upstream is reconciling one.
   *
   * Null means nothing is, and the hand-entered rows are the whole truth.
   *
   * A SIGNAL rather than a thunk, and that is not a style choice: this desk is
   * built eagerly, its `heat` computed evaluates during construction, and the
   * broker model cannot exist yet because reconciliation needs this desk's own
   * rows. A plain function assigned afterwards would be read once, before it
   * was set, and the desk would show hand-entered heat for the rest of the
   * session with nothing on screen suggesting it.
   */
  readonly counted?: ReadSignal<readonly Position[] | null>;
}

export interface RiskDesk {
  readonly el: HTMLElement;
  /** For the agent's `get_risk_state` and `size_position` tools. */
  readonly config: Signal<RiskConfig>;
  readonly positions: Signal<readonly Position[]>;
  readonly realisedToday: Signal<number>;
  size(entry: number, stop: number, riskPct?: number): SizeResult;
}

const n2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
const money = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

/** Today, in UTC, so the daily loss window matches the session boundaries. */
const todayKey = (): string => new Date().toISOString().slice(0, 10);

export function createRisk(opts: RiskDeskOptions): RiskDesk {
  /**
   * `equity` and `riskPct` are NOT owned here any more.
   *
   * They used to be, and the Calculator owned its own copy of the same two
   * numbers in a different slot, so the two desks could disagree about how much
   * money you have — see `core/account.ts`. `config` still CARRIES them, because
   * the sizer and the agent tools read it as one object, but the account store
   * is the source and the effect below is the only thing that sets them.
   */
  const stored = opts.kv.read(CONFIG_SLOT).value;
  const seed = opts.account.account.peek();
  const config = signal<RiskConfig>({ ...stored, equity: seed.equity, riskPct: seed.riskPct });
  const positions = signal<readonly Position[]>(opts.kv.read(BOOK_SLOT).value);

  const storedDay = opts.kv.read(DAY_SLOT).value;
  /* A new day resets the realised figure. Carrying yesterday's loss into
     today's guardrail would keep the desk permanently stopped out. */
  const realisedToday = signal<number>(storedDay.day === todayKey() ? storedDay.realised : 0);

  /* One direction only: account is the source, config mirrors it.
     `effective`, not `account`: when a broker is connected its equity is the
     one every lot size must be computed from, and this mirror is what the
     sizer reads. On disconnect it falls back to the operator's own figure and
     this effect restores it. */
  effect(() => {
    const a = opts.account.effective();
    config.update((c) =>
      c.equity === a.equity && c.riskPct === a.riskPct
        ? c
        : { ...c, equity: a.equity, riskPct: a.riskPct },
    );
  });

  effect(() => void opts.kv.write(CONFIG_SLOT, config()));
  effect(() => void opts.kv.write(BOOK_SLOT, [...positions()]));
  effect(() => void opts.kv.write(DAY_SLOT, { day: todayKey(), realised: realisedToday() }));

  // ------------------------------------------------------------- sizer ---

  const entry = signal<number>(0);
  const stop = signal<number>(0);
  const target = signal<number>(0);

  const size = (e: number, s: number, riskPct?: number): SizeResult => {
    const c = config.peek();
    return sizePosition({
      equity: c.equity,
      riskPct: riskPct ?? c.riskPct,
      entry: e,
      stop: s,
      maxNotionalPct: c.maxNotionalPct,
      feesPct: c.feesPct,
      ...(c.qtyStep > 0 ? { instrument: { symbol: opts.symbol.peek(), qtyStep: c.qtyStep } } : {}),
    });
  };

  const result = computed<SizeResult>(() => {
    const c = config();
    return sizePosition({
      equity: c.equity,
      riskPct: c.riskPct,
      entry: entry(),
      stop: stop(),
      maxNotionalPct: c.maxNotionalPct,
      feesPct: c.feesPct,
      ...(c.qtyStep > 0 ? { instrument: { symbol: opts.symbol(), qtyStep: c.qtyStep } } : {}),
    });
  });

  const reward = computed(() => rewardToRisk(entry(), stop(), target()));
  /**
   * What the risk figures are computed from.
   *
   * The reconciled book when there is one — broker rows, plus hand-entered
   * rows the operator marked as held elsewhere, minus anything that cannot be
   * sized. The hand-entered list otherwise. NOT the same thing as
   * `positions()`, which stays the operator's own editable rows and is what
   * the table below the broker panel shows.
   */
  const counted = computed<readonly Position[]>(() => opts.counted?.() ?? positions());

  const heat = computed(() => portfolioHeat(counted(), config().equity));

  const guard = computed(() =>
    checkGuards({
      equity: config().equity,
      realisedToday: realisedToday(),
      openPositions: counted().length,
      /**
       * PASSED THROUGH UNMEASURED, NOT SUBSTITUTED WITH ZERO.
       *
       * This used to read `Number.isFinite(h) ? h : 0`, which laundered "we
       * could not measure your open risk" into "you have no open risk" — the
       * most permissive value there is — right at the boundary, so the heat
       * ceiling then had all the room in the world. `checkGuards` now refuses
       * on a non-finite heat and says which input it could not read, which is
       * only reachable if the real value gets that far.
       */
      currentHeatPct: heat().heatPct,
      proposedRiskPct: result().ok ? result().riskPct : 0,
      config: config().guards,
    }),
  );

  // ------------------------------------------------------------ fields ---

  const numberField = (
    label: string,
    hint: string,
    get: () => number,
    set: (v: number) => void,
    step = "any",
  ): HTMLElement =>
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", text: label }),
      h("input", {
        class: "field-input num",
        type: "number",
        step,
        value: () => String(get()),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          set(Number.isFinite(v) ? v : 0);
        },
      }),
      h("div", { class: "field-hint", text: hint }),
    );

  const cfgField = (
    label: string,
    hint: string,
    key: keyof Omit<RiskConfig, "guards">,
    step = "any",
  ): HTMLElement =>
    numberField(
      label,
      hint,
      () => config()[key],
      (v) => {
        /* Shared with the Calculator: route to the one owner rather than
           writing a second copy that would immediately be out of step. */
        if (key === "equity" || key === "riskPct") opts.account.update({ [key]: v });
        else config.update((c) => ({ ...c, [key]: v }));
      },
      step,
    );

  const guardField = (label: string, hint: string, key: keyof GuardConfig): HTMLElement =>
    numberField(
      label,
      hint,
      () => config().guards[key],
      (v) => config.update((c) => ({ ...c, guards: { ...c.guards, [key]: v } })),
    );

  // ------------------------------------------------------------ render ---

  /* THE BROKER'S OWN ANSWER, asked for rather than assumed.
     `risk/instruments.ts` is a table this product maintains; the server reads
     the contract spec off the MT5 bridge. Where they differ the broker is
     right — CLAUDE.md records a shipped ticket dividing XAUUSD by 100,000 when
     its contract is 100 oz, sizing gold a thousand times too small. */
  const broker = signal<BrokerSize | null>(null);
  const brokerNote = signal("");
  const brokerBusy = signal(false);

  const askBroker = (): void => {
    const r = result();
    if (!r.ok) {
      brokerNote.set("Fill the four numbers in first — there is nothing to check yet.");
      return;
    }
    brokerBusy.set(true);
    broker.set(null);
    brokerNote.set("Asking the broker for its contract spec\u2026");
    void riskSize({
      symbol: opts.symbol().toUpperCase(),
      risk_pct: config().riskPct,
      entry: entry(),
      stop: stop(),
      equity: config().equity,
    }).then((a) => {
      brokerBusy.set(false);
      if (a.kind === "offline") {
        brokerNote.set(a.why);
        return;
      }
      broker.set(a.value);
      if (!a.value.ok) {
        /* The refusal is the operator's to act on — it names the sync that
           fetches the spec — so it is shown verbatim rather than summarised. */
        brokerNote.set(a.value.err ?? "the broker could not size this and did not say why");
        return;
      }
      brokerNote.set("");
    });
  };

  const sizerPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Position size" }),
    h("p", {
      class: "dd-sub",
      text: "You give it four numbers and it multiplies. It does not choose your risk, and it cannot place anything.",
    }),

    h(
      "div",
      { class: "risk-inputs" },
      cfgField("Account equity", "In the quote currency.", "equity"),
      cfgField("Risk per trade %", "Yours to choose. Nothing here suggests a value.", "riskPct"),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Entry" }),
        h(
          "div",
          { class: "risk-inline" },
          h("input", {
            class: "field-input num",
            type: "number",
            step: "any",
            value: () => String(entry()),
            oninput: (e: Event) => entry.set(Number((e.target as HTMLInputElement).value) || 0),
          }),
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            text: "Last",
            title: "Use the last traded price on the chart",
            onclick: () => entry.set(opts.lastPrice()),
          }),
        ),
        h("div", { class: "field-hint", text: "The price you expect to get, not the one you want." }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Stop" }),
        h(
          "div",
          { class: "risk-inline" },
          h("input", {
            class: "field-input num",
            type: "number",
            step: "any",
            value: () => String(stop()),
            oninput: (e: Event) => stop.set(Number((e.target as HTMLInputElement).value) || 0),
          }),
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            text: () => `${config().atrMultiple}×ATR`,
            title: "Where that ATR multiple sits below the entry. Volatility arithmetic, not a placement.",
            onclick: () => {
              const e = entry.peek() || opts.lastPrice();
              if (e > 0) entry.set(e);
              const out = stopFromAtr(e, opts.atr(), config.peek().atrMultiple, "long");
              if (out.ok) stop.set(Number(out.stop.toPrecision(10)));
            },
          }),
        ),
        h("div", {
          class: "field-hint",
          text: "Below the entry is a long; above it is a short. The direction is read from this.",
        }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", text: "Target (optional)" }),
        h("input", {
          class: "field-input num",
          type: "number",
          step: "any",
          value: () => String(target()),
          oninput: (e: Event) => target.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("div", { class: "field-hint", text: "Only used for the reward-to-risk figure." }),
      ),
    ),

    /* --- what the BROKER says, beside what the table says -------------- */
    h(
      "div",
      { class: "risk-broker" },
      h("button", {
        class: "ghost-btn",
        type: "button",
        text: () => `Check against the broker's contract spec`,
        disabled: () => brokerBusy(),
        onclick: askBroker,
      }),
      h("p", {
        class: "risk-broker-note",
        text: () => brokerNote(),
        style: () => (brokerNote() ? "" : "display:none"),
      }),
      h("div", {
        class: "risk-broker-out",
        /*
         * COMPARE THE MONEY, NOT THE QUANTITY.
         *
         * This desk sizes in the INSTRUMENT'S OWN UNITS — ounces for gold —
         * and applies your notional cap. The broker sizes in LOTS from its
         * contract spec, where one gold lot is 100 ounces, and applies no cap.
         * The first version of this compared 0.118499 against 0.0036 and
         * reported a 33x disagreement; there was none. 0.0036 lots IS 0.36
         * ounces, which is this desk's own uncapped answer. They agreed on the
         * arithmetic and differed on a CAP, and the number comparison hid both
         * facts. Money at risk is the one quantity both express the same way.
         */
        "data-agree": () => {
          const b = broker();
          const r = result();
          const mine = r.ok ? r.riskAmount : NaN;
          const theirs = typeof b?.detail?.["actual_risk_money"] === "number" ? b.detail["actual_risk_money"] : NaN;
          if (!b?.ok || !r.ok || !Number.isFinite(theirs)) return "none";
          /* Within a cent, or within 1% of the budget — rounding to a venue's
             step moves the money a little and that is not a disagreement. */
          const tol = Math.max(0.01, Math.abs(theirs) * 0.01);
          return Math.abs(mine - theirs) <= tol ? "yes" : "no";
        },
        style: () => (broker()?.ok ? "" : "display:none"),
        text: () => {
          const b = broker();
          const r = result();
          if (!b?.ok || !r.ok) return "";
          if (b.note) return b.note;
          const theirs = typeof b.detail?.["actual_risk_money"] === "number" ? b.detail["actual_risk_money"] : NaN;
          const lots = b.lots ?? 0;
          if (!Number.isFinite(theirs)) {
            return `The broker sizes this at ${lots} lots from its own contract spec.`;
          }
          const tol = Math.max(0.01, Math.abs(theirs) * 0.01);
          if (Math.abs(r.riskAmount - theirs) <= tol) {
            return `The broker agrees: ${lots} lots risks ${theirs.toFixed(2)}, which is what this desk sized for.`;
          }
          /* NAME BOTH UNITS. "0.0036 against 0.118" is two different
             quantities, and printing them side by side without their names is
             how a reader concludes the wrong thing — as I did. */
          return (
            `The broker sizes this at ${lots} lots (${theirs.toFixed(2)} at risk) where this desk sized ` +
            `${r.qty} units (${r.riskAmount.toFixed(2)} at risk). Those are different units, not a contradiction — ` +
            `the gap is your notional cap, which the broker does not apply. The broker's figure is the one you are ` +
            `filled at.`
          );
        },
      }),
    ),

    /* --- the answer --------------------------------------------------- */
    h(
      "div",
      { class: "risk-out", "data-ok": () => String(result().ok) },
      () => {
        const r = result();
        if (!r.ok) {
          return h(
            "div",
            { class: "risk-refuse" },
            h("div", { class: "risk-refuse-title", text: "No size" }),
            h("div", { class: "risk-refuse-why", text: r.reason ?? "" }),
          );
        }

        const c = config();
        const dp = c.qtyStep > 0 ? stepDecimals(c.qtyStep) : 6;
        const rr = reward();

        return h(
          "div",
          { class: "risk-answer" },
          h(
            "div",
            { class: "risk-headline" },
            h("div", { class: "risk-qty num", text: r.qty.toFixed(dp) }),
            h("div", { class: "risk-qty-label", text: `${opts.symbol()} · ${r.direction}` }),
          ),
          h(
            "div",
            { class: "risk-grid" },
            metric("Risk if stopped", `${money(r.riskAmount)}`, `${n2(r.riskPct)}% of equity`),
            metric("Notional", money(r.notional), `${n2(r.notionalPctOfEquity)}% of equity`),
            metric("Stop distance", `${n2(r.stopDistancePct)}%`, `${money(r.riskPerUnit)} per unit`),
            metric(
              "Round-trip cost",
              money(r.feeAmount),
              c.feesPct > 0 ? `break even at +${n2(r.breakEvenPct)}%` : "no cost supplied",
            ),
            rr.ok
              ? metric(
                  "Reward to risk",
                  `${n2(rr.r)}R`,
                  `breaks even at ${n2(rr.breakEvenWinRate)}% win rate`,
                )
              : metric("Reward to risk", "—", target() > 0 ? (rr.reason ?? "") : "set a target"),
          ),
        );
      },
    ),

    h("div", { class: "risk-notes" }, () => {
      const r = result();
      return h(
        "div",
        {},
        ...r.warnings.map((w) => h("div", { class: "risk-warn", text: w })),
        ...r.assumptions.map((a) => h("div", { class: "risk-assume", text: a })),
      );
    }),
  );

  function metric(label: string, value: string, sub: string): HTMLElement {
    return h(
      "div",
      { class: "risk-metric" },
      h("div", { class: "risk-metric-label", text: label }),
      h("div", { class: "risk-metric-value num", text: value }),
      h("div", { class: "risk-metric-sub", text: sub }),
    );
  }

  // ------------------------------------------------------------- book ---

  const bookRows = h("div", { class: "risk-book" });

  renderEffect(() => {
    const list = positions();
    bookRows.textContent = "";
    if (list.length === 0) {
      bookRows.appendChild(
        h("div", { class: "dd-empty", text: "Nothing entered by hand. Add a position here only if it is NOT at the connected broker — anything the broker reports appears above." }),
      );
      return;
    }
    const c = config();
    list.forEach((p, i) => {
      const risk = p.stop === null ? NaN : Math.abs(p.entry - p.stop) * p.qty;
      bookRows.appendChild(
        h(
          "div",
          { class: "risk-pos", "data-unprotected": String(p.stop === null) },
          h("span", { class: "risk-pos-sym", text: p.symbol }),
          h("span", { class: "risk-pos-dir", "data-dir": p.direction, text: p.direction }),
          h("span", { class: "risk-pos-qty num", text: String(p.qty) }),
          h("span", { class: "risk-pos-entry num", text: `@ ${money(p.entry)}` }),
          h("span", {
            class: "risk-pos-risk num",
            text: p.stop === null ? "NO STOP" : `${money(risk)} (${n2((risk / c.equity) * 100)}%)`,
          }),
          h("button", {
            class: "ghost-btn tiny",
            type: "button",
            text: "✕",
            title: "Remove",
            onclick: () => positions.update((cur) => cur.filter((_, j) => j !== i)),
          }),
        ),
      );
    });
  });

  const newSymbol = signal("");
  const newQty = signal(0);
  const newEntry = signal(0);
  const newStop = signal(0);
  const newDir = signal<"long" | "short">("long");

  const bookPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Open book and portfolio heat" }),
    h("p", {
      class: "dd-sub",
      text: "Positions you enter by hand. This desk has no broker connection — it cannot see your account and cannot close anything.",
    }),

    h("div", { class: "risk-heat" }, () => {
      const hh = heat();
      const g = guard();
      return h(
        "div",
        { class: "risk-grid" },
        metric(
          "Open risk",
          Number.isFinite(hh.heatPct) ? `${n2(hh.heatPct)}%` : "—",
          `ceiling ${config().guards.maxHeatPct}%`,
        ),
        metric("Gross exposure", money(hh.grossNotional), `net ${money(hh.netNotional)}`),
        metric(
          "Realised today",
          money(realisedToday()),
          `${n2(-g.dailyLossPct)}% of equity · stop at ${config().guards.dailyLossPct}%`,
        ),
        metric("Positions", String(counted().length), `limit ${config().guards.maxPositions}`),
      );
    }),

    h("div", { class: "risk-guard", "data-pass": () => String(guard().pass) }, () => {
      const g = guard();
      return h(
        "div",
        {},
        /* Three states, not two. "Your rules refused this" and "your rules
           could not be applied" are different answers, and a heading that
           collapses them tells you to close a position when the actual fix is
           to set your equity. */
        h("div", {
          class: "risk-guard-head",
          text: !g.measured
            ? "Your limits could not be checked"
            : g.pass
              ? "Inside your own limits"
              : "Your own limits say stop",
        }),
        ...g.breaches.map((b) => h("div", { class: "risk-warn", text: b })),
        ...g.notes.map((nt) => h("div", { class: "risk-assume", text: nt })),
      );
    }),

    /* The BROKER's book, above the hand-entered one, because when both are
       present the broker's is the one the figures above were computed from. */
    ...(opts.bookSlot ? [opts.bookSlot] : []),

    bookRows,

    h(
      "div",
      { class: "risk-add" },
      /* The instrument table IS the vocabulary here: a symbol it does not
         know has no pip value and no contract size, so the row cannot be
         sized. Suggesting the 129 it knows turns a silent refusal downstream
         into a choice. */
      symbolField({
        value: () => newSymbol(),
        options: () => symbolOptions([]),
        className: "field-input",
        placeholder: "symbol",
        ariaLabel: "Symbol to add",
        onChange: (sym) => newSymbol.set(sym),
      }),
      h("select", {
        class: "dd-select",
        onchange: (e: Event) => newDir.set((e.target as HTMLSelectElement).value as "long" | "short"),
        ref: (el: HTMLSelectElement) => {
          el.appendChild(h("option", { value: "long", text: "long" }));
          el.appendChild(h("option", { value: "short", text: "short" }));
        },
      }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: "any",
        placeholder: "qty",
        value: () => String(newQty() || ""),
        oninput: (e: Event) => newQty.set(Number((e.target as HTMLInputElement).value) || 0),
      }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: "any",
        placeholder: "entry",
        value: () => String(newEntry() || ""),
        oninput: (e: Event) => newEntry.set(Number((e.target as HTMLInputElement).value) || 0),
      }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: "any",
        placeholder: "stop (blank = none)",
        value: () => String(newStop() || ""),
        oninput: (e: Event) => newStop.set(Number((e.target as HTMLInputElement).value) || 0),
      }),
      h("button", {
        class: "primary-btn",
        type: "button",
        text: "Add",
        onclick: () => {
          const sym = newSymbol.peek().trim();
          if (!sym || newQty.peek() <= 0 || newEntry.peek() <= 0) return;
          positions.update((cur) => [
            ...cur,
            {
              symbol: sym,
              direction: newDir.peek(),
              qty: newQty.peek(),
              entry: newEntry.peek(),
              stop: newStop.peek() > 0 ? newStop.peek() : null,
            },
          ]);
          newSymbol.set("");
          newQty.set(0);
          newEntry.set(0);
          newStop.set(0);
        },
      }),
    ),

    h("div", { class: "risk-notes" }, () =>
      h("div", {}, ...heat().warnings.map((w) => h("div", { class: "risk-warn", text: w }))),
    ),

    h(
      "div",
      { class: "risk-add" },
      h("label", { class: "field-label", text: "Realised P&L today" }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: "any",
        value: () => String(realisedToday()),
        oninput: (e: Event) => realisedToday.set(Number((e.target as HTMLInputElement).value) || 0),
      }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Reset",
        onclick: () => realisedToday.set(0),
      }),
    ),
  );

  // ------------------------------------------------------------ config ---

  const configPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Your rules" }),
    h("p", {
      class: "dd-sub",
      text: "Limits you set for yourself. Nothing enforces them but you — this desk reports, it does not gate an order it cannot see.",
    }),
    h(
      "div",
      { class: "risk-inputs" },
      guardField("Daily loss stop %", "Past this, your rule says the day is over.", "dailyLossPct"),
      guardField("Max open risk %", "Total heat across every position.", "maxHeatPct"),
      guardField("Max positions", "How many at once.", "maxPositions"),
      cfgField("Exposure cap %", "Notional ceiling. 100 is spot with no leverage.", "maxNotionalPct"),
      cfgField("Round-trip cost %", "Spread + commission + slippage, as a percent of notional.", "feesPct"),
      cfgField("Quantity step", "Venue lot size. 0 to leave the quantity unrounded.", "qtyStep"),
      cfgField("ATR multiple", "Used by the ATR button on the stop field.", "atrMultiple"),
    ),
  );

  // --------------------------------------------------------- portfolio ---

  /**
   * The book as a portfolio rather than as a list.
   *
   * BEHIND A BUTTON, and that is a design decision rather than laziness. It
   * reads every held symbol out of IndexedDB and runs a covariance over the
   * result, which is far too much to do on every keystroke in the sizer above.
   * More importantly, an expensive number that recomputes silently is a number
   * nobody knows the age of — pressing the button is what makes "as of when"
   * answerable.
   */
  const portfolio = signal<PortfolioRisk | null>(null);
  const portfolioBusy = signal<boolean>(false);
  const portfolioAt = signal<number>(0);

  const runPortfolio = async (): Promise<void> => {
    const load = opts.loadCloses;
    if (!load || portfolioBusy.peek()) return;
    const book = positions.peek();
    portfolioBusy.set(true);
    try {
      const factor = opts.factorSymbol?.() ?? "BTCUSDT";
      const symbols = [...new Set([...book.map((p) => p.symbol), factor])];
      const series = await load(symbols);
      portfolio.set(
        analysePortfolio({
          positions: book,
          equity: config.peek().equity,
          series,
          factorSymbol: factor,
          ...(opts.advBySymbol ? { advBySymbol: opts.advBySymbol() } : {}),
        }),
      );
      portfolioAt.set(Date.now());
    } finally {
      portfolioBusy.set(false);
    }
  };

  /**
   * The hedge read, computed on demand against one nominated instrument.
   *
   * It lives on THIS desk rather than a desk of its own because it is a
   * question about the book, and the book is here. A separate Hedge desk would
   * have had to duplicate the position table to be usable at all.
   */
  const hedgeSymbol = signal<string>("BTCUSDT");
  const hedge = signal<HedgeResult | null>(null);
  const hedgeBusy = signal<boolean>(false);

  const runHedge = async (): Promise<void> => {
    const load = opts.loadCloses;
    if (!load || hedgeBusy.peek()) return;
    const book = positions.peek();
    const instrument = hedgeSymbol.peek().toUpperCase();
    hedgeBusy.set(true);
    try {
      const symbols = [...new Set([...book.map((p) => p.symbol.toUpperCase()), instrument])];
      const series = await load(symbols);
      hedge.set(sizeHedge({ positions: book, instrument, series }));
    } finally {
      hedgeBusy.set(false);
    }
  };

  const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
  const signedMoney = (v: number): string =>
    Number.isFinite(v) ? `${v >= 0 ? "+" : "\u2212"}${money(Math.abs(v))}` : "—";

  const tailRows = (): HTMLElement[] => {
    const r = portfolio();
    if (!r?.ok) return [];
    const equity = config().equity;
    return r.tails.map((t) =>
      h(
        "div",
        { class: "pf-row" },
        h("span", { class: "pf-k", text: `${(t.level * 100).toFixed(0)}% one-bar` }),
        h("span", { class: "pf-v num", text: money(t.var) }),
        h("span", {
          class: "pf-v num",
          text: equity > 0 ? `${((t.var / equity) * 100).toFixed(2)}% of equity` : "—",
        }),
        h("span", {
          class: "pf-note",
          text: `Worse on ${(100 - t.level * 100).toFixed(0)}% of bars; when it is worse it has averaged ${money(t.cvar)}.`,
        }),
      ),
    );
  };

  const contributionRows = (): HTMLElement[] => {
    const r = portfolio();
    if (!r?.ok) return [];
    return r.contributions.map((c) =>
      h(
        "div",
        { class: "pf-row", "data-hedge": String(c.cvarShare < 0) },
        h("span", { class: "pf-k", text: c.symbol }),
        h("span", { class: "pf-v num", text: signedMoney(-c.cvarShare) }),
        h("span", { class: "pf-v num", text: pct(c.fraction) }),
        h("span", {
          class: "pf-note",
          text:
            c.cvarShare < 0
              ? "Made money on the days the book lost most. This is a hedge."
              : `${c.signedNotional >= 0 ? "Long" : "Short"} ${money(Math.abs(c.signedNotional))} notional.`,
        }),
      ),
    );
  };

  const betaRows = (): HTMLElement[] => {
    const r = portfolio();
    if (!r?.ok) return [];
    /* Held symbols with no stored bars get a row of their own rather than
       vanishing. A table that silently omits half the book reads as a complete
       answer, and the whole point of the warning above is that it is not. */
    const absent = r.missing.map((symbol) =>
      h(
        "div",
        { class: "pf-row", "data-weak": "true" },
        h("span", { class: "pf-k", text: symbol }),
        h("span", { class: "pf-v num", text: "—" }),
        h("span", { class: "pf-v num", text: "—" }),
        h("span", {
          class: "pf-note",
          text: "No bars stored locally. Open it on the chart once and it is archived; nothing here is estimated from a symbol that has never been fetched.",
        }),
      ),
    );
    return r.betas
      .filter((b) => b.symbol !== r.factor)
      .map((b) =>
        h(
          "div",
          { class: "pf-row", "data-weak": String(b.caveat !== null) },
          h("span", { class: "pf-k", text: b.symbol }),
          h("span", { class: "pf-v num", text: Number.isFinite(b.beta) ? b.beta.toFixed(2) : "—" }),
          h("span", { class: "pf-v num", text: Number.isFinite(b.r2) ? `R\u00B2 ${b.r2.toFixed(2)}` : "—" }),
          h("span", { class: "pf-note", text: b.caveat ?? `Moves ${b.beta.toFixed(2)}x ${r.factor}, on ${b.sample} shared bars.` }),
        ),
      )
      .concat(absent);
  };

  const liquidityRows = (): HTMLElement[] => {
    const r = portfolio();
    if (!r?.ok) return [];
    /* Largest position first, and unknowns last rather than first: an Infinity
       sorted to the top would put "we do not know" above the position that is
       actually hard to get out of. */
    return [...r.liquidity]
      .sort((a, b) => {
        const av = Number.isFinite(a.days) ? a.days : -1;
        const bv = Number.isFinite(b.days) ? b.days : -1;
        return bv - av;
      })
      .map((l) =>
        h(
          "div",
          { class: "pf-row", "data-loss": String(Number.isFinite(l.days) && l.days > 1) },
          h("span", { class: "pf-k", text: l.symbol }),
          h("span", { class: "pf-v num", text: money(l.notional) }),
          h("span", {
            class: "pf-v num",
            text: Number.isFinite(l.days) ? `${l.days < 0.1 ? "<0.1" : l.days.toFixed(1)} d` : "unknown",
          }),
          h("span", { class: "pf-note", text: l.note }),
        ),
      );
  };

  const stressRows = (): HTMLElement[] => {
    const r = portfolio();
    if (!r?.ok) return [];
    return r.stress.map((sr) =>
      h(
        "div",
        { class: "pf-row", "data-loss": String(sr.pnl < 0) },
        h("span", { class: "pf-k", text: sr.scenario.label }),
        h("span", { class: "pf-v num", text: `${(sr.scenario.factorMove * 100).toFixed(0)}%` }),
        h("span", { class: "pf-v num", text: signedMoney(sr.pnl) }),
        h("span", {
          class: "pf-note",
          text:
            sr.unreliable.length > 0
              ? `${sr.scenario.note} ${sr.unreliable.join(", ")} had no trustworthy beta, so this is a floor on the move, not the move.`
              : sr.scenario.note,
        }),
      ),
    );
  };

  const hedgeRows = (): HTMLElement[] => {
    const r = hedge();
    if (!r?.ok) return [];
    return r.legs.map((l) =>
      h(
        "div",
        { class: "pf-row hedge-row", "data-loss": String(l.refusal !== null) },
        h("span", { class: "pf-k", text: l.symbol }),
        h("span", { class: "pf-v num", text: signedMoney(l.notional) }),
        h("span", {
          class: "pf-v num",
          text: Number.isFinite(l.beta) ? l.beta.toFixed(2) : "—",
        }),
        h("span", {
          class: "pf-v num",
          text: Number.isFinite(l.r2) ? `R² ${l.r2.toFixed(2)}` : "—",
        }),
        h("span", {
          class: "pf-note",
          text: l.refusal ?? `Hedge with ${signedMoney(l.hedgeNotional)} of ${r.instrument}`,
        }),
      ),
    );
  };

  const hedgePanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Hedge" }),
    h("p", {
      class: "dd-sub",
      text: "The size of one instrument that would cancel the most variance of the book — and, next to it, how much variance it can actually cancel. It reports; it cannot open the offsetting trade.",
    }),
    h(
      "div",
      { class: "risk-inline hedge-pick" },
      h("input", {
        class: "field-input",
        type: "text",
        value: () => hedgeSymbol(),
        title: "The instrument you would hedge WITH",
        oninput: (e: Event) => hedgeSymbol.set((e.target as HTMLInputElement).value),
      }),
      h("button", {
        class: "ghost-btn",
        type: "button",
        disabled: () => hedgeBusy() || opts.loadCloses === undefined,
        text: () => (hedgeBusy() ? "Measuring…" : "Size the hedge"),
        onclick: () => void runHedge(),
      }),
    ),
    h("p", {
      /* `pf-blocked` — the refusal style this desk already uses, rather than a
         new class with no stylesheet behind it. */
      class: "pf-blocked",
      "data-on": () => String(!!hedge() && !hedge()?.ok),
      text: () => hedge()?.reason ?? "",
    }),
    h(
      "div",
      { class: "pf-stats", "data-on": () => String(!!hedge()?.ok) },
      h(
        "div",
        { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Net hedge" }),
        h("span", { class: "pf-stat-v num", text: () => signedMoney(hedge()?.totalHedge ?? NaN) }),
      ),
      h(
        "div",
        { class: "pf-stat" },
        h("span", {
          class: "pf-stat-k",
          text: "Variance it removes",
          title: "Weighted by squared notional, because variance scales with the square of position size.",
        }),
        h("span", { class: "pf-stat-v num", text: () => pct(hedge()?.bookVarianceRemoved ?? NaN) }),
      ),
      h(
        "div",
        { class: "pf-stat" },
        h("span", {
          class: "pf-stat-k",
          text: "Risk still left",
          title: "The square root of the unexplained variance. R² is a share of VARIANCE; a daily move is a standard deviation.",
        }),
        h("span", {
          class: "pf-stat-v num",
          text: () => pct(residualRiskFraction(hedge()?.bookVarianceRemoved ?? NaN)),
        }),
      ),
      h(
        "div",
        { class: "pf-stat" },
        h("span", { class: "pf-stat-k", text: "Shared history" }),
        h("span", { class: "pf-stat-v num", text: () => `${hedge()?.sample ?? 0} bars` }),
      ),
    ),
    h("div", {
      class: "pf-table",
      ref: (el: HTMLElement) =>
        renderEffect(() => {
          el.textContent = "";
          for (const row of hedgeRows()) el.appendChild(row);
        }),
    }),
    pkWhy(
      "An R² of 0.75 removes three quarters of the VARIANCE and only half the volatility. A hedge below the fit threshold is refused rather than sized, because a number there would be acted on — and it would add a second position, two sets of costs and two things that can gap, while leaving most of the original risk in place. " +
        "Betas are measured on archived bars over the window above. Correlations move most in exactly the conditions that make people want a hedge.",
      "What this can't tell you",
    ),
  );

  const portfolioPanel = h(
    "section",
    { class: "dd-panel" },
    h(
      "div",
      { class: "pf-head" },
      h("h2", { class: "panel-title", text: "Portfolio risk" }),
      h("button", {
        /* `ghost-btn tiny`, the class every other button in a panel head wears.
           It was `btn`, which NO stylesheet in this tree declares -- so the
           control that runs the portfolio analysis computed as a transparent
           21px box with no border and rendered as plain text beside the title.
           Found by `scratchpad/classundeclared.py`, written after the same
           mistake was made in `cards/mcpservecard.ts`. */
        class: "ghost-btn tiny",
        type: "button",
        text: () => (portfolioBusy() ? "Reading the archive\u2026" : portfolio() ? "Recompute" : "Analyse the book"),
        disabled: () => portfolioBusy() || opts.loadCloses === undefined,
        onclick: () => void runPortfolio(),
      }),
    ),
    pkWhy(
      `Heat above adds your stops up as though the positions were independent. They are not. Everything here is measured from the book's own history in the local archive — no model, no assumed distribution, and a refusal rather than a guess when there are fewer than ${MIN_HISTORY} shared bars.`,
    ),

    h("div", {
      class: "pf-blocked",
      "data-on": () => String(portfolio()?.ok === false),
      text: () => portfolio()?.blocked ?? "",
    }),

    h(
      "div",
      { class: "pf-body", "data-on": () => String(portfolio()?.ok === true) },

      h(
        "div",
        { class: "pf-stats" },
        h(
          "div",
          { class: "pf-stat" },
          h("span", { class: "pf-stat-k", text: "Gross exposure" }),
          h("span", { class: "pf-stat-v num", text: () => money(portfolio()?.gross ?? NaN) }),
        ),
        h(
          "div",
          { class: "pf-stat" },
          h("span", { class: "pf-stat-k", text: "Net exposure" }),
          h("span", { class: "pf-stat-v num", text: () => signedMoney(portfolio()?.net ?? NaN) }),
        ),
        h(
          "div",
          { class: "pf-stat" },
          h("span", { class: "pf-stat-k", text: "Independent bets" , title: "Sum of each leg volatility taken alone, over the volatility the book actually had, squared. Counts only legs with stored history." }),
          h("span", {
            class: "pf-stat-v num",
            text: () => {
              const d = portfolio()?.diversification;
              if (!d || !Number.isFinite(d.effectiveBets)) return "—";
              /* Out of what was MEASURED, not out of what is held. The two
                 differ whenever a symbol has no stored bars, and quoting the
                 position count there would claim a correlation finding about a
                 leg nobody looked at. */
              return `${d.effectiveBets.toFixed(1)} of ${d.measured}`;
            },
          }),
        ),
        h(
          "div",
          { class: "pf-stat" },
          h("span", { class: "pf-stat-k", text: "Shared history" }),
          h("span", { class: "pf-stat-v num", text: () => `${portfolio()?.sample ?? 0} bars` }),
        ),
      ),

      h("p", { class: "pf-lede", text: () => portfolio()?.diversification.note ?? "" }),

      h("div", {
        class: "pf-warnings",
        ref: (el: HTMLElement) =>
          renderEffect(() => {
            el.textContent = "";
            for (const w of portfolio()?.warnings ?? []) {
              el.appendChild(h("p", { class: "pf-warn", text: w }));
            }
          }),
      }),

      h("h3", { class: "pf-sub", text: "Worst case, from bars that actually happened" }),
      h("div", { class: "pf-table", ref: (el: HTMLElement) => renderEffect(() => {
        el.textContent = "";
        for (const row of tailRows()) el.appendChild(row);
      }) }),

      h("h3", { class: "pf-sub", text: "Who carries the loss on the worst days" }),
      pkWhy("Average loss per symbol across the bars that made the 95% tail. These sum EXACTLY to the shortfall above — no residual and no rounding plug."),
      h("div", { class: "pf-table", ref: (el: HTMLElement) => renderEffect(() => {
        el.textContent = "";
        for (const row of contributionRows()) el.appendChild(row);
      }) }),

      h("h3", { class: "pf-sub", text: () => `Exposure to ${portfolio()?.factor ?? ""}` }),
      pkWhy("Beta with the R\u00B2 beside it, always. A beta on a relationship the factor barely explains is arithmetic, not exposure.", "How to read this"),
      h("div", { class: "pf-table", ref: (el: HTMLElement) => renderEffect(() => {
        el.textContent = "";
        for (const row of betaRows()) el.appendChild(row);
      }) }),

      h("h3", { class: "pf-sub", text: "If it happened again" }),
      pkWhy(`Each shock is propagated through the measured beta above. Betas taken in calm markets understate crashes — correlations converge to one exactly when it matters — so every figure here is OPTIMISTIC. ${SCENARIOS.length} scenarios, one of them upward, because a short book fails upward.`, "Why these figures are optimistic"),
      h("div", { class: "pf-table", ref: (el: HTMLElement) => renderEffect(() => {
        el.textContent = "";
        for (const row of stressRows()) el.appendChild(row);
      }) }),

      h("h3", { class: "pf-sub", text: "How long it would take to get out" }),
      pkWhy(
        "Position value over 20% of the median daily traded value in the archive. It is a FLOOR: volume is measured on one venue, and it falls in exactly the drawdowns that make you want out.",
        "Why this is a floor",
      ),
      h("div", { class: "pf-table", ref: (el: HTMLElement) => renderEffect(() => {
        el.textContent = "";
        for (const row of liquidityRows()) el.appendChild(row);
      }) }),

      h("p", {
        class: "pf-asof",
        text: () => (portfolioAt() ? `Computed ${new Date(portfolioAt()).toLocaleTimeString()} from stored bars.` : ""),
      }),
    ),
  );

  const el = h(
    "div",
    { class: "dd risk-desk" },
    h(
      "div",
      /* NOT `.dd-head` — that is the uppercase micro-label used for table
         header ROWS in desks.css, and borrowing it here shouted the desk title
         and its whole subtitle in capitals. */
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Risk" }),
      h("p", {
        class: "view-sub",
        text: "How much, and whether that is inside the rules you set. Decision support: it reports, it never trades.",
      }),
    ),
    /*
     * THE LAYOUT LAW, and this desk's own subtitle decides the split:
     * "How much, and whether that is inside the rules you set."
     *
     *   PRIMARY   how much — the sizer, the book it is sized against, and the
     *             aggregate that book adds up to. All three are about the
     *             state of the account RIGHT NOW, and all three want width:
     *             the book is a table and the portfolio a stat grid.
     *   RAIL      what it is measured against — the rules, which are the
     *             limits every figure on the left is checked by and which you
     *             set once a quarter; and the hedge, a five-figure block that
     *             is a different question you ask occasionally.
     *
     * Not a mechanical split. The Watchlist was refused one in v61.6 because
     * its second block is a 3,108-tile heatmap that a four-column rail would
     * make unreadable — the law applied against the content it exists for.
     */
    h(
      "div",
      { class: "dd-layout" },
      h("div", { class: "dd-primary" }, sizerPanel, bookPanel, portfolioPanel),
      h("div", { class: "dd-rail" }, configPanel, hedgePanel),
    ),
  );

  return { el, config, positions, realisedToday, size };
}
