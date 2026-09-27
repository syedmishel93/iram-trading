/**
 * The day's plan as data: which symbols to focus on, and what was committed.
 *
 * PURE except for the KV reads and writes at the bottom, which take the store
 * as an argument — so every rule here is testable without a DOM.
 *
 * WHERE THE SUGGESTIONS COME FROM, AND WHERE THEY DO NOT
 * The focus list is SUGGESTED from what the terminal already knows, never
 * invented: symbols the opportunity scan (and the chart's own Setup card)
 * read as live, in the order the scan ranked them — the watch rail's own map,
 * which this reads rather than re-ranks. When nothing is live, the watchlist
 * in its own order, SAID to be the watchlist. When there is neither, nothing,
 * with the reason. A suggestion list padded with popular tickers would be
 * the fabricated data `CLAUDE.md` forbids.
 *
 * The operator's changes are kept as EDITS (added, dropped) over whatever is
 * suggested, not as a copy of the list: the scan re-ranks through the day,
 * and a dropped symbol must stay dropped when it does.
 */

import type { KV, Slot, WriteResult } from "../../store/kv";
import type { WatchSetup } from "../watchrail";
import type { RiskLimits } from "../../data/riskconfig";

/** How many suggestions the list starts with. A focus list of twenty is not a focus. */
export const FOCUS_SUGGEST_CAP = 6;
/** How long the list may grow with the operator's own additions. */
export const FOCUS_MAX = 12;

export type FocusSource = "scan" | "watchlist" | "none";

export interface FocusSuggestion {
  readonly symbols: readonly string[];
  readonly source: FocusSource;
  /** One line saying where the list came from. */
  readonly note: string;
}

export interface FocusInput {
  /** The watch rail's map: the scan's reads plus the chart's own, ranked. */
  readonly opportunities: ReadonlyMap<string, WatchSetup>;
  /** Whether the cross-symbol scan has run at all. */
  readonly scanned: boolean;
  /** The watchlist in its own order, or null when the desk was not given it. */
  readonly watchlist: readonly string[] | null;
}

export function suggestFocus(i: FocusInput): FocusSuggestion {
  const live = [...i.opportunities.entries()].filter(([, s]) => s.live).map(([sym]) => sym);
  if (live.length > 0) {
    return { symbols: live.slice(0, FOCUS_SUGGEST_CAP), source: "scan", note: "Flagged by the scan: each has a live setup." };
  }
  const wl = i.watchlist ?? [];
  if (wl.length > 0) {
    return {
      symbols: wl.slice(0, FOCUS_SUGGEST_CAP),
      source: "watchlist",
      note: i.scanned
        ? "From your watchlist — the scan found no live setup."
        : "From your watchlist — not scanned yet.",
    };
  }
  return {
    symbols: [],
    source: "none",
    note: i.scanned
      ? "The scan found no live setup and your watchlist is empty. Add your own."
      : "Nothing to suggest yet: no scan and no watchlist. Add your own.",
  };
}

/** The operator's changes over the suggestions. */
export interface FocusEdits {
  readonly added: readonly string[];
  readonly dropped: readonly string[];
}

export const NO_EDITS: FocusEdits = { added: [], dropped: [] };

/**
 * A typed symbol, upper-cased, or null when it cannot be one. Letters,
 * digits and the separators real tickers use (BTC/USDT, BRK.B, EUR-USD).
 */
export function normaliseSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._:/-]{0,23}$/.test(s) ? s : null;
}

/** Suggestions minus drops, then the operator's own additions. */
export function applyFocus(suggested: readonly string[], e: FocusEdits): string[] {
  const dropped = new Set(e.dropped);
  const out = suggested.filter((s) => !dropped.has(s));
  for (const a of e.added) if (!out.includes(a) && !dropped.has(a)) out.push(a);
  return out.slice(0, FOCUS_MAX);
}

export type AddResult =
  | { readonly ok: true; readonly edits: FocusEdits }
  | { readonly ok: false; readonly reason: string };

export function addFocus(suggested: readonly string[], e: FocusEdits, raw: string): AddResult {
  const sym = normaliseSymbol(raw);
  if (sym === null) return { ok: false, reason: "Not a symbol — letters and digits, like ETHUSDT." };
  const current = applyFocus(suggested, e);
  if (current.includes(sym)) return { ok: false, reason: `${sym} is already on the list.` };
  if (current.length >= FOCUS_MAX) return { ok: false, reason: `The list holds ${FOCUS_MAX}. Drop one first.` };
  const dropped = e.dropped.filter((d) => d !== sym);
  const added = suggested.includes(sym) ? e.added : [...e.added, sym];
  return { ok: true, edits: { added, dropped } };
}

export function dropFocus(e: FocusEdits, sym: string): FocusEdits {
  if (e.added.includes(sym)) return { added: e.added.filter((a) => a !== sym), dropped: e.dropped };
  return e.dropped.includes(sym) ? e : { added: e.added, dropped: [...e.dropped, sym] };
}

// ─────────────────────────────────────────────────────────── persistence ───

/** What was committed: the list as it stood, the limits the server confirmed. */
export interface CommittedPlan {
  /** Epoch ms of the commit. */
  readonly at: number;
  readonly focus: readonly string[];
  readonly limits: RiskLimits;
}

export interface SavedPlan {
  /** Local calendar day the plan is for, `YYYY-MM-DD`. */
  readonly day: string;
  readonly edits: FocusEdits;
  readonly committed: CommittedPlan | null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The LOCAL calendar day — the operator's day, not UTC's. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `09:12`, local, 24-hour. Written out so no locale can turn it into 9:12 a.m. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readCommitted(v: unknown): CommittedPlan | null {
  if (!isObj(v) || !fin(v["at"]) || !isObj(v["limits"])) return null;
  const focus = strList(v["focus"]);
  const l = v["limits"];
  const t = l["maxTradesPerDay"];
  const r = l["maxDailyLossR"];
  const p = l["maxRiskPerTradePct"];
  if (focus === null || !fin(t) || !fin(r) || !fin(p)) return null;
  return { at: v["at"], focus, limits: { maxTradesPerDay: t, maxDailyLossR: r, maxRiskPerTradePct: p } };
}

/**
 * `today.plan` v1. A new key rather than a field on an existing slot: the
 * plan has its own lifetime (one day) and its own shape.
 */
export const TODAY_PLAN_SLOT: Slot<SavedPlan | null> = {
  key: "today.plan",
  version: 1,
  fallback: () => null,
  validate: (v) => {
    if (!isObj(v) || typeof v["day"] !== "string" || !isObj(v["edits"])) return null;
    const added = strList(v["edits"]["added"]);
    const dropped = strList(v["edits"]["dropped"]);
    if (added === null || dropped === null) return null;
    return { day: v["day"], edits: { added, dropped }, committed: readCommitted(v["committed"]) };
  },
};

/** Today's plan, or a fresh one — yesterday's commit does not bind today. */
export function readPlan(kv: KV, nowMs: number): SavedPlan {
  const day = dayKey(nowMs);
  const saved = kv.get(TODAY_PLAN_SLOT);
  if (saved === null || saved.day !== day) return { day, edits: NO_EDITS, committed: null };
  return saved;
}

export function writePlan(kv: KV, plan: SavedPlan): WriteResult {
  return kv.write(TODAY_PLAN_SLOT, plan);
}
