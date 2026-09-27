/**
 * "Your say" — what the operator did with each recommendation (v59.2).
 *
 * The verdict above the inspector is the terminal's; this is the operator's
 * answer to it: USE the plan, ADJUST it, or PASS with a reason. It is the
 * human half of the loop the v5 design is built around, and it is RECORDED,
 * because a recommendation nobody's answer was kept for can never be checked
 * against what the operator actually decided — the Review workspace reads it.
 *
 * One say per SETUP, identified by symbol, timeframe, verdict kind, direction
 * and the plan's entry: when any of those changes it is a different
 * recommendation, and the earlier answer no longer applies to it.
 */

import type { KV, Slot } from "../store/kv";

export type SayChoice = "use" | "adjust" | "pass";

/** Why the operator passed — short, fixed, countable; "other" is free text. */
export const PASS_REASONS = ["Too late — it already ran", "Against my plan for today", "News is too close", "I don't trust the read", "Other"] as const;
export type PassReason = (typeof PASS_REASONS)[number];

export interface Say {
  readonly at: number;
  readonly key: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly verdict: string;
  readonly direction: "long" | "short" | null;
  readonly choice: SayChoice;
  readonly reason: string;
}

/** The identity of one recommendation — see the header. */
export function setupKey(p: {
  readonly symbol: string;
  readonly timeframe: string;
  readonly verdict: string;
  readonly direction: "long" | "short" | null;
  readonly entry: number | null;
}): string {
  const e = p.entry === null || !Number.isFinite(p.entry) ? "-" : p.entry.toPrecision(6);
  return `${p.symbol}|${p.timeframe}|${p.verdict}|${p.direction ?? "-"}|${e}`;
}

/** Most recent first, capped: this is a log for review, not an archive. */
export const SAYS_MAX = 500;

function isSay(v: unknown): v is Say {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["at"] === "number" &&
    typeof o["key"] === "string" &&
    typeof o["symbol"] === "string" &&
    typeof o["timeframe"] === "string" &&
    typeof o["verdict"] === "string" &&
    (o["direction"] === "long" || o["direction"] === "short" || o["direction"] === null) &&
    (o["choice"] === "use" || o["choice"] === "adjust" || o["choice"] === "pass") &&
    typeof o["reason"] === "string"
  );
}

/** `verdict.says` v1: the log, newest first. Malformed rows are dropped, not the log. */
export const SAYS_SLOT: Slot<readonly Say[]> = {
  key: "verdict.says",
  version: 1,
  fallback: () => [],
  validate: (v) => (Array.isArray(v) ? v.filter(isSay) : null),
};

/** Record an answer. A new answer to the SAME setup replaces the old one. */
export function addSay(log: readonly Say[], say: Say): Say[] {
  return [say, ...log.filter((s) => s.key !== say.key)].slice(0, SAYS_MAX);
}

/** Take an answer back (the "undo" beside it). */
export function removeSay(log: readonly Say[], key: string): Say[] {
  return log.filter((s) => s.key !== key);
}

export function sayFor(log: readonly Say[], key: string): Say | null {
  return log.find((s) => s.key === key) ?? null;
}

export interface SayStore {
  readonly all: () => readonly Say[];
  record(say: Say): void;
  undo(key: string): void;
}

export function createSayStore(kv: KV): SayStore {
  return {
    all: () => kv.get(SAYS_SLOT),
    record: (say) => void kv.write(SAYS_SLOT, addSay(kv.get(SAYS_SLOT), say)),
    undo: (key) => void kv.write(SAYS_SLOT, removeSay(kv.get(SAYS_SLOT), key)),
  };
}
