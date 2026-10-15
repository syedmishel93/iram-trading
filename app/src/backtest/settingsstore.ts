/**
 * THE BACKTESTER'S SETTINGS, OWNED ONCE AND PERSISTED.
 *
 * `settings.ts` is the shape and the arithmetic, and holds no state. This is
 * the one owner of the operator's CURRENT configuration: a signal, seeded from
 * storage, written on every change.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A STORE AND NOT A SIGNAL IN THE SHELL
 *
 * Because more than one surface needs it. The control panel edits it, the
 * board charges with it, a result records it, and the autonomous loop reads
 * it. A signal declared in `mountShell` would make every one of those a
 * sibling dependency of the shell — and this repository's measured answer to
 * that is that the shell already has 218 declarations at depth 1 and the next
 * real reduction is giving shared state an owner object.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VALIDATOR IS THE INTERESTING PART
 *
 * Stored settings are the operator's data and arrive from an older build, a
 * hand-edited export, or another tab. Every field is read INDIVIDUALLY and
 * falls back to the standard, because the alternative — rejecting the whole
 * blob when one number is wrong — silently resets a configuration somebody
 * spent time on, with nothing on screen saying why.
 *
 * Numbers are also CLAMPED rather than trusted. A stored `perTrade` of 50 is
 * not a preference, it is a corrupt value that would size every position
 * fifty times too large; a stored `minCoverage` of -1 would accept any data at
 * all. The clamp is the refusal, applied where the value enters.
 */

import { signal, type Signal } from "../core/signal";
import type { KV, WriteResult } from "../store/kv";
import type { Costs } from "./engine";
import { PRESETS, STANDARD, presetById, type CostModel, type EntryAt, type RunSettings } from "./settings";

/** Keep a stored number inside the range the engine can act on. */
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

const ENTRIES: readonly EntryAt[] = ["next-open", "signal-close"];
const MODELS: readonly CostModel[] = ["standard", "measured", "none", "worst"];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * A stored blob as settings, field by field.
 *
 * Exported because the slot's validator and the import path both need it, and
 * two copies of "how to read stored settings" is how they come to disagree.
 */
export function sanitiseSettings(v: unknown): RunSettings {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return STANDARD;
  const o = v as Record<string, unknown>;
  const grp = (k: string): Record<string, unknown> => {
    const g = o[k];
    return g !== null && typeof g === "object" && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
  };
  const f = grp("fills");
  const c = grp("costs");
  const b = grp("bar");
  const r = grp("risk");
  const d = grp("data");
  const w = grp("windows");

  /* THE OVERRIDE IS SANITISED FIELD BY FIELD, not cast.
     It is the broker's measured figures, and a cast here would let a stored
     string through to arithmetic that silently produces NaN — which the engine
     would charge as a cost of nothing. Only the four real fields survive, and
     only as finite non-negative numbers; an absent one keeps the assumption,
     which `costsFor` already does. */
  const ov = c["override"];
  const said = ov !== null && typeof ov === "object" && !Array.isArray(ov) ? (ov as Record<string, unknown>) : {};
  const rate = (k: string): number | undefined => {
    const v = said[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(0.05, v) : undefined;
  };
  const override: Partial<Costs> = {};
  for (const k of ["spread", "commission", "slippage", "carryPerNight"] as const) {
    const v = rate(k);
    if (v !== undefined) override[k] = v;
  }

  return {
    fills: {
      entry: oneOf(f["entry"], ENTRIES, STANDARD.fills.entry),
      /* 0 to 100bp. Past that it is not slippage, it is a different market. */
      slippage: num(f["slippage"], 0, 0.01, STANDARD.fills.slippage),
      settleFromMinutes: bool(f["settleFromMinutes"], STANDARD.fills.settleFromMinutes),
    },
    costs: {
      model: oneOf(c["model"], MODELS, STANDARD.costs.model),
      ...(Object.keys(override).length > 0 ? { override } : {}),
    },
    bar: {
      minTrades: Math.round(num(b["minTrades"], 1, 10_000, STANDARD.bar.minTrades)),
      maxPbo: num(b["maxPbo"], 0, 1, STANDARD.bar.maxPbo),
      minRetention: num(b["minRetention"], 0, 1, STANDARD.bar.minRetention),
      chargeForSearch: bool(b["chargeForSearch"], STANDARD.bar.chargeForSearch),
    },
    /* 0.01% to 10%. A stored 50 would size every position fifty times too
       large, which is the unit defect this repository already records once. */
    risk: { perTrade: num(r["perTrade"], 0.0001, 0.1, STANDARD.risk.perTrade) },
    data: {
      minCoverage: num(d["minCoverage"], 0, 1, STANDARD.data.minCoverage),
      allowDemo: bool(d["allowDemo"], STANDARD.data.allowDemo),
    },
    windows: {
      count: Math.round(num(w["count"], 1, 24, STANDARD.windows.count)),
      trainBars: Math.round(num(w["trainBars"], 50, 500_000, STANDARD.windows.trainBars)),
      testBars: Math.round(num(w["testBars"], 20, 500_000, STANDARD.windows.testBars)),
      purgeBars: Math.round(num(w["purgeBars"], 0, 10_000, STANDARD.windows.purgeBars)),
    },
  };
}

export const BACKTEST_SETTINGS_SLOT = {
  key: "backtest.settings",
  version: 1,
  fallback: (): RunSettings => STANDARD,
  validate: (v: unknown): RunSettings | null => sanitiseSettings(v),
};

export interface SettingsStore {
  /** The current configuration. Read-only to consumers — write through below. */
  readonly settings: Signal<RunSettings>;
  /** Which preset this matches exactly, if any. Null once it is edited. */
  readonly presetId: () => string | null;
  /** Replace the whole configuration. Returns what storage said. */
  put(next: RunSettings): WriteResult;
  /** Adopt a preset by id. Refuses an id it does not have. */
  usePreset(id: string): WriteResult | null;
  /** Change one group, leaving the rest alone. */
  patch<K extends keyof RunSettings>(group: K, part: Partial<RunSettings[K]>): WriteResult;
}

/**
 * The store.
 *
 * `kv` is REQUIRED and has no default. A default that reached the real store is
 * the rule this repository has broken six times through three doors, so a test
 * passes a memory store and there is no spelling of this call that touches the
 * operator's settings by accident.
 */
export function createSettingsStore(kv: KV): SettingsStore {
  const settings = signal<RunSettings>(kv.read(BACKTEST_SETTINGS_SLOT).value);

  const write = (next: RunSettings): WriteResult => {
    settings.set(next);
    /* Written in the setter, not by an effect: a preference that is not
       durable at the moment it changes is not a preference. */
    return kv.write(BACKTEST_SETTINGS_SLOT, next);
  };

  return {
    settings,
    presetId: () => {
      const now = JSON.stringify(settings());
      return PRESETS.find((p) => JSON.stringify(p.settings) === now)?.id ?? null;
    },
    put: write,
    usePreset: (id) => {
      const p = presetById(id);
      return p === undefined ? null : write(p.settings);
    },
    patch: (group, part) => write({ ...settings(), [group]: { ...settings()[group], ...part } }),
  };
}
