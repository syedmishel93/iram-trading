/**
 * The offline desk note — "what should I do?" answered with no language model.
 *
 * WHY THE DEFAULT PROVIDER NEEDED THIS
 * Most operators never configure a key, so the offline analyst is the expert
 * they actually meet. Asked "what should I do", it used to return whichever
 * keyword-matched readings the question happened to trigger — a price line, an
 * RSI — and never the one thing the terminal has an answer for: the Setup
 * card's verdict. This composes the same six-part shape the connected expert is
 * told to use, from tool RESULTS only:
 *
 *   1 the call        from get_setup's verdict — never from anything else
 *   2 market read     decision, regime, price, indicators, structure, HTF, fundamentals
 *   3 scenarios       the outlook cone's quartiles, as shares of simulated paths
 *   4 the plan        the card's plan, the odds, and the size_position result
 *   5 what changes it gate clears, what the engine waits for, the decision's list
 *   6 risks           events, heat, a thin or adverse record, an uncalibrated band
 *
 * THE RULE IT KEEPS
 * No number here is produced by this file. Every figure is a field of a tool
 * result, placed into a sentence; the only arithmetic is unit formatting (a
 * fraction printed as a percent). The call is derived from the verdict kind by
 * a fixed table, so the note can be wrong only where the card is — and then it
 * is wrong in the same way, which is what makes it checkable.
 */

import type { ToolCall, ToolResult } from "./tools";

/** Questions that get the desk note rather than the keyword sweep. */
export const DESK_NOTE_QUESTION =
  /what should i do|brief me|should i (buy|sell|enter|long|short|go long|go short|take|trade)|what.?s the (call|trade|play)|what would you do/i;

export const isDeskNoteQuestion = (q: string): boolean => DESK_NOTE_QUESTION.test(q);

/** Run in this order; the note reads them by name, not position. */
export const DESK_NOTE_TOOLS: readonly string[] = [
  "get_context",
  "get_setup",
  "get_decision",
  "get_outlook",
  "get_setup_history",
  "get_calendar",
  "get_risk_state",
  "get_price_summary",
  "get_indicators",
  "list_structures",
  "get_higher_timeframes",
  "get_regime",
  "get_fundamentals",
];

export interface NamedResult {
  readonly name: string;
  readonly result: ToolResult;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? (v as unknown[]).map(rec) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A fetched price, printed at the precision its magnitude needs. */
function px(v: unknown): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
/** A fetched fraction (0..1), printed as a percent. */
const pct = (v: unknown, dp = 0): string => (isNum(v) ? `${(v * 100).toFixed(dp)}%` : "—");
/** A fetched percentage (already ×100), printed with its sign. */
const sp = (v: unknown): string => (isNum(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "—");
const n2 = (v: unknown, dp = 2): string => (isNum(v) ? v.toFixed(dp) : "—");

/**
 * The one follow-up round: size the Setup card's plan.
 *
 * The entry and stop come from `get_setup`'s result — fetched values, never
 * prices parsed out of the operator's sentence, which is the heuristic the
 * keyword analyst refuses to use. No plan (or a withheld one) means no call.
 */
export function deskNoteFollowUp(results: readonly NamedResult[]): ToolCall[] {
  if (results.some((r) => r.name === "size_position")) return [];
  const setup = results.find((r) => r.name === "get_setup")?.result;
  if (!setup?.ok) return [];
  const plan = rec(rec(setup.data)["plan"]);
  if (!isNum(plan["entry"]) || !isNum(plan["stop"])) return [];
  return [{ id: "offline-size", name: "size_position", args: { entry: plan["entry"], stop: plan["stop"] } }];
}

/** The call, from the verdict kind. A fixed table, on purpose. */
function theCall(setup: ToolResult | undefined): string[] {
  if (!setup) return ["**No call.** The setup verdict was not read."];
  if (!setup.ok) {
    return [
      `**No call.** ${setup.error ?? "The setup verdict is unavailable."}`,
      "_The call is taken only from the Setup card's verdict; without it this note will not name one._",
    ];
  }
  const s = rec(setup.data);
  const blocking = list(s["blocking"]);
  const unchecked = list(s["unchecked"]);
  const headline = str(s["headline"]);
  switch (str(s["call"])) {
    case "go":
      return [`**Take the plan — it is live under your rules.** ${headline}`];
    case "armed":
      return [`**Wait for price at ${px(s["watch_level"])}.** The plan is valid and your gates pass; price has not reached the entry zone. ${headline}`];
    case "conflict":
      return [
        `**The plan is live, but the macro lane disagrees — size down or wait.** ${str(s["conflict_note"])}`,
      ];
    case "stand-down": {
      const g = blocking[0];
      return [
        `**Stand aside.** ${headline}`,
        ...(g ? [`Blocking: ${str(g["text"])}${str(g["clears"]) ? ` What would clear it: ${str(g["clears"])}` : ""}`] : []),
      ];
    }
    case "unknown": {
      const g = unchecked[0];
      return [
        "**Stand aside — a gate could not be checked, and an unchecked gate is not a pass.**",
        ...(g ? [`Unchecked: ${str(g["text"])}`] : []),
      ];
    }
    case "no-setup":
      return [
        `**No trade.** ${str(s["no_setup_reason"])}`,
        ...(str(s["waiting_for"]) ? [`What to watch: ${str(s["waiting_for"])}`] : []),
      ];
    default:
      return ["**No call.** The verdict came back in a state this note does not recognise."];
  }
}

export function composeDeskNote(results: readonly NamedResult[]): string {
  const get = (name: string): ToolResult | undefined => results.find((r) => r.name === name)?.result;
  const out: string[] = [];
  const failed = (label: string, r: ToolResult | undefined): string | null =>
    r && !r.ok ? `- ${label}: unavailable — ${r.error ?? r.summary ?? "no reason given"}` : null;

  /* ---- header: what this is about */
  const ctx = get("get_context");
  if (ctx?.ok) {
    const d = rec(ctx.data);
    out.push(
      `**${str(d["symbol"])} · ${str(d["timeframe"])}** — ${String(d["bars_loaded"] ?? "—")} bars from ${str(d["source"])}, ${str(d["freshness"])}${isNum(d["data_age_seconds"]) ? ` (${d["data_age_seconds"]}s old)` : ""}.`,
    );
    if (d["freshness"] !== undefined && d["freshness"] !== "live" && str(d["freshness_note"])) {
      out.push(`_${str(d["freshness_note"])}_`);
    }
  } else if (ctx) {
    out.push(`Could not read the terminal state: ${ctx.error ?? "unknown error"}.`);
  }

  /* ---- 1 the call */
  const setup = get("get_setup");
  out.push("", "**1 · The call**", ...theCall(setup));

  /* ---- 2 market read */
  out.push("", "**2 · Market read**", "_Technical_");
  const dec = get("get_decision");
  if (dec?.ok) out.push(`- Assembled read: ${str(rec(dec.data)["headline"])}`);
  const regime = get("get_regime");
  if (regime?.ok) {
    const d = rec(regime.data);
    out.push(`- Regime model: ${str(d["state"])} at ${pct(d["confidence"])} confidence (a 3-state Gaussian mixture).`);
  } else {
    const f = failed("Regime model", regime);
    if (f) out.push(f);
  }
  const price = get("get_price_summary");
  if (price?.ok) {
    const d = rec(price.data);
    out.push(
      `- Price: last close ${px(d["last_close"])}, ${sp(d["change_pct_over_lookback"])} over ${String(d["lookback_bars"] ?? "—")} bars; range ${px(d["range_low"])} – ${px(d["range_high"])}.`,
    );
  }
  const ind = get("get_indicators");
  if (ind?.ok) {
    const d = rec(ind.data);
    const stack =
      isNum(d["ema_20"]) && isNum(d["ema_50"])
        ? ` EMA20 ${px(d["ema_20"])} is ${d["ema_20"] >= d["ema_50"] ? "above" : "below"} EMA50 ${px(d["ema_50"])}.`
        : "";
    out.push(`- RSI(14) ${n2(d["rsi_14"], 1)}, ATR(14) ${n2(d["atr_pct_of_price"])}% of price.${stack}`);
  }
  const structures = get("list_structures");
  if (structures?.ok) {
    const rows = list(rec(structures.data)["structures"]);
    out.push(
      rows.length === 0
        ? "- Structure: the detectors found nothing on this series."
        : `- Structure, most recent first: ${rows
            .slice(-3)
            .reverse()
            .map((s) => `${str(s["label"])} (${n2(s["confidence"])})`)
            .join("; ")}.`,
    );
  }
  const htf = get("get_higher_timeframes");
  if (htf?.ok) {
    const d = rec(htf.data);
    out.push(
      d["enabled"] === true
        ? `- Higher timeframes: ${list(d["timeframes"]).map((r) => `${str(r["timeframe"])} ${str(r["bias"])}`).join(", ")}.`
        : "- Higher timeframes: none enabled — an absence of information, not a neutral reading.",
    );
  }
  out.push("_Fundamental and macro_");
  const fund = get("get_fundamentals");
  if (fund?.ok) {
    const d = rec(fund.data);
    out.push(
      `- ${str(d["name"])}: rank #${String(d["rank"] ?? "—")}, 24h ${sp(d["change24h"])}, 7d ${sp(d["change7d"])}, 30d ${sp(d["change30d"])}; ${n2(d["belowAthPct"], 1)}% below its all-time high. Source: ${str(d["source"])}`,
    );
  } else if (fund) {
    out.push(`- No fundamental data: ${fund.error ?? "not covered"}`);
  }
  const cal = get("get_calendar");
  const events = cal?.ok ? list(rec(cal.data)["events"]) : [];
  if (cal?.ok) {
    out.push(
      events.length === 0
        ? "- Calendar: no scheduled events returned for this instrument's currencies."
        : `- Calendar: next is ${str(events[0]?.["what"])} at ${str(events[0]?.["when"])} (${str(events[0]?.["importance"])}).`,
    );
  }
  if (dec?.ok) {
    const limits = (rec(dec.data)["limits"] as unknown[] | undefined) ?? [];
    for (const l of limits.slice(0, 2)) if (typeof l === "string") out.push(`- Limit: ${l}`);
  }

  /* ---- 3 scenarios */
  const outlook = get("get_outlook");
  const o = outlook?.ok ? rec(outlook.data) : null;
  const cone = o ? list(o["cone"]) : [];
  const far = cone[cone.length - 1];
  out.push("", `**3 · Scenarios${far ? ` — next ${String(far["bars_ahead"])} bars, modelled` : ""}**`);
  if (o && far) {
    out.push(
      `- Bear: 1 in 4 simulated paths end below ${px(far["p25"])} (${sp(far["p25_pct"])}); 1 in 20 below ${px(far["p5"])} (${sp(far["p5_pct"])}).`,
      `- Base: half end between ${px(far["p25"])} and ${px(far["p75"])}, median ${px(far["p50"])} (${sp(far["p50_pct"])}).`,
      `- Bull: 1 in 4 end above ${px(far["p75"])} (${sp(far["p75_pct"])}); 1 in 20 above ${px(far["p95"])} (${sp(far["p95_pct"])}).`,
      `- ${pct(o["p_up_base_rate"])} of paths end higher — ${str(o["p_up_label"])}`,
    );
    const calib = rec(o["calibration"]);
    if (str(calib["note"])) out.push(`- Track record of the band (measured): ${str(calib["note"])}`);
    else if (str(calib["refused"])) out.push(`- The band's track record could not be checked: ${str(calib["refused"])}.`);
  } else if (outlook && !outlook.ok) {
    out.push(`- No outlook: ${outlook.error ?? "unavailable"}`);
  } else {
    out.push("- No outlook was read.");
  }

  /* ---- 4 the plan */
  out.push("", "**4 · The plan**");
  const s = setup?.ok ? rec(setup.data) : null;
  const plan = s ? rec(s["plan"]) : {};
  if (s && isNum(plan["entry"])) {
    out.push(
      `- ${str(plan["direction"]) === "short" ? "Short" : "Long"} from the zone ${px(plan["entry_low"])} – ${px(plan["entry_high"])} (entry ${px(plan["entry"])}).`,
      `- Stop ${px(plan["stop"])} (${str(plan["stop_from"])} stop, ${n2(plan["stop_atr_now"])}× ATR now). Target 1 ${px(plan["target1"])}, target 2 ${px(plan["target2"])}.`,
      `- ${n2(plan["reward_to_risk_t1"])}R to target 1, which needs to come first ${pct(plan["break_even_hit_rate"])} of the time to break even.`,
    );
    const oddsLine = o ? str(rec(o["lines"])["odds"]) : "";
    if (oddsLine) out.push(`- Simulated: ${oddsLine}`);
    const size = get("size_position");
    if (size?.ok) {
      const z = rec(size.data);
      out.push(
        `- Size from your settings: ${String(z["qty"])} units, risking ${n2(z["riskAmount"])} (${n2(z["riskPct"], 3)}% of equity), stop ${n2(z["stopDistancePct"])}% away.`,
      );
      for (const w of (z["warnings"] as unknown[] | undefined) ?? []) if (typeof w === "string") out.push(`- Sizing warning: ${w}`);
    } else if (size) {
      out.push(`- Size: ${size.error ?? "could not be computed"}`);
    }
  } else if (s && str(s["plan_withheld"])) {
    out.push(`- ${str(s["plan_withheld"])}`);
  } else if (s && str(s["call"]) === "no-setup") {
    out.push("- No plan: there is no setup to plan.");
  } else if (s && s["plan_problem"]) {
    out.push(`- No plan: ${str(s["plan_problem"])}`);
  } else if (setup && !setup.ok) {
    out.push(`- No plan: ${setup.error ?? "the setup verdict is unavailable."}`);
  } else {
    out.push("- No plan was read.");
  }
  const hist = s ? rec(s["history"]) : {};
  if (str(hist["note"])) out.push(`- This setup's replayed record (in-sample): ${str(hist["note"])}`);

  /* ---- 5 what would change the view */
  out.push("", "**5 · What would change the view**");
  const changes: string[] = [];
  if (s) {
    for (const g of list(s["blocking"])) if (str(g["clears"])) changes.push(str(g["clears"]));
    if (str(s["waiting_for"])) changes.push(str(s["waiting_for"]));
    if (str(s["call"]) === "armed" && isNum(s["watch_level"])) changes.push(`Price reaching ${px(s["watch_level"])}.`);
  }
  if (dec?.ok) {
    for (const w of ((rec(dec.data)["wouldChange"] as unknown[] | undefined) ?? []).slice(0, 3)) {
      if (typeof w === "string") changes.push(w);
    }
  }
  if (changes.length === 0) out.push("- Nothing was named by the tools.");
  else for (const c of changes) out.push(`- ${c}`);

  /* ---- 6 risks */
  out.push("", "**6 · Risks**");
  const risks: string[] = [];
  for (const e of events.slice(0, 3)) risks.push(`Scheduled: ${str(e["what"])} at ${str(e["when"])} (${str(e["importance"])}).`);
  const risk = get("get_risk_state");
  if (risk?.ok) {
    const d = rec(risk.data);
    const guards = rec(d["guards"]);
    risks.push(
      isNum(d["heatPct"])
        ? `Open heat ${n2(d["heatPct"])}% across ${String(d["openPositions"])} position(s), against your ${n2(guards["maxHeatPct"])}% ceiling.`
        : `Open heat is not measurable — account equity is unset — across ${String(d["openPositions"])} position(s).`,
    );
    const unprotected = (d["unprotected"] as unknown[] | undefined) ?? [];
    if (unprotected.length > 0) risks.push(`${unprotected.join(", ")} carr${unprotected.length === 1 ? "ies" : "y"} no stop, so heat is a floor.`);
  }
  if (str(hist["note"]) && hist["enough_to_characterise"] === false) {
    risks.push(`Thin record: ${String(hist["instances"])} replayed instance(s) — too few to characterise this setup.`);
  }
  if (hist["adverse"] === true) risks.push("This setup's replayed record is adverse: its whole expectancy interval is below zero.");
  const shist = get("get_setup_history");
  if (shist?.ok && str(rec(shist.data)["disagreement"])) risks.push(str(rec(shist.data)["disagreement"]));
  if (o) {
    const calib = rec(o["calibration"]);
    if (calib["usable"] === false) risks.push("The outlook band has too few past checks to call it calibrated.");
  }
  if (risks.length === 0) out.push("- None named by the tools that answered.");
  else for (const r of risks) out.push(`- ${r}`);

  const unanswered = results.filter((r) => !r.result.ok).map((r) => r.name);
  out.push("");
  /* Outside the italic run: tool names carry underscores, which the desk's
     inline markdown would read as emphasis markers. */
  if (unanswered.length > 0) out.push(`Did not answer: ${unanswered.map((n) => `\`${n}\``).join(", ")}.`);
  out.push(
    "_Desk note composed from the tool results above by the offline analyst — no language model was consulted, and every figure is a fetched value. Decision support only: you place and manage any trade._",
  );
  return out.join("\n");
}
