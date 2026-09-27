/**
 * Your side of the Review: which patterns you judged true, and the rules you
 * committed to because of them.
 *
 * WHERE IT LIVES
 * Two versioned slots in the browser KV store (`store/kv.ts`), so it survives
 * a reload and rides the existing cloud sync like every other setting. A
 * committed rule is also written to the local service's durable key store
 * (`POST /svc/kv`, key `review.rules`), so it outlives a cleared browser. The
 * claims ledger (`/svc/claims`) was considered and REJECTED: a claim there is
 * a market call with an outcome to resolve, and a rule about your own
 * behaviour has neither — filing it there would put rows into the terminal's
 * track record that are not predictions.
 *
 * The server write is best-effort and its result is REPORTED: "saved in this
 * browser only" is a different fact from "saved in both", and the screen says
 * which one happened.
 */

import { signal, type Signal } from "../core/signal";
import { listSlot, recordSlot, type KV } from "../store/kv";
import { serviceBase } from "../data/backend";
import type { PatternId, Verdict } from "./patterns";

export interface Judgement {
  readonly verdict: Verdict;
  readonly at: number;
  /** The claim as it read when you judged it — it may read differently after more trades. */
  readonly claim: string;
}

export interface CommittedRule {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  /** The pattern it came from, or null when you wrote it from scratch. */
  readonly from: PatternId | null;
  /** The finding it answered, in words, as it read on the day. */
  readonly because: string;
}

const PATTERN_IDS: readonly string[] = ["news", "trend", "early-exit", "session", "holding", "after-loss", "passes"];

const JUDGEMENTS = recordSlot("review.judgements", 1);

const isRule = (v: unknown): v is CommittedRule => {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["text"] === "string" &&
    o["text"] !== "" &&
    typeof o["at"] === "number" &&
    Number.isFinite(o["at"]) &&
    (o["from"] === null || (typeof o["from"] === "string" && PATTERN_IDS.includes(o["from"]))) &&
    typeof o["because"] === "string"
  );
};

const RULES = listSlot<CommittedRule>("review.rules", 1, isRule);

/** The server key a committed rule list is mirrored to. */
export const SERVER_KEY = "review.rules";

function readJudgements(raw: Record<string, unknown>): Record<string, Judgement> {
  const out: Record<string, Judgement> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PATTERN_IDS.includes(k) || v === null || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if ((o["verdict"] === "true" || o["verdict"] === "false") && typeof o["at"] === "number" && typeof o["claim"] === "string") {
      out[k] = { verdict: o["verdict"], at: o["at"], claim: o["claim"] };
    }
  }
  return out;
}

export type ServerSave =
  | { readonly state: "saved"; readonly where: string }
  | { readonly state: "browser-only"; readonly reason: string };

export type CommitResult =
  | { readonly ok: true; readonly rule: CommittedRule; readonly local: string }
  | { readonly ok: false; readonly reason: string };

export interface ReviewStore {
  readonly judgements: Signal<Readonly<Record<string, Judgement>>>;
  readonly rules: Signal<readonly CommittedRule[]>;
  /** What happened to the last server write, or null before the first. */
  readonly server: Signal<ServerSave | null>;
  /** True when nothing is persisted — no KV was supplied. Said on screen. */
  readonly memoryOnly: boolean;
  verdict(id: PatternId): Judgement | null;
  judge(id: PatternId, verdict: Verdict, claim: string): void;
  /** Undo a judgement. */
  unjudge(id: PatternId): void;
  commit(text: string, from: PatternId | null, because: string): CommitResult;
  retire(ruleId: string): void;
}

export interface ReviewStoreOptions {
  readonly now?: () => number;
  /** Injected for tests. Defaults to the global fetch. Null skips the server write. */
  readonly fetch?: typeof fetch | null;
  readonly base?: () => string;
}

/**
 * The store. With no KV it still works — in memory — and says so, because a
 * judgement that silently vanishes on reload is worse than one never asked for.
 */
export function createReviewStore(kv: KV | null, opts: ReviewStoreOptions = {}): ReviewStore {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch === undefined ? (typeof fetch === "function" ? fetch : null) : opts.fetch;
  const base = opts.base ?? serviceBase;

  const judgements = signal<Readonly<Record<string, Judgement>>>(kv ? readJudgements(kv.get(JUDGEMENTS)) : {});
  const rules = signal<readonly CommittedRule[]>(kv ? kv.get(RULES) : []);
  const server = signal<ServerSave | null>(null);
  let counter = 0;

  const saveJudgements = (next: Record<string, Judgement>): void => {
    judgements.set(next);
    kv?.write(JUDGEMENTS, { ...next });
  };

  const pushServer = async (list: readonly CommittedRule[]): Promise<void> => {
    if (doFetch === null) {
      server.set({ state: "browser-only", reason: "No network in this context." });
      return;
    }
    const url = `${base()}/svc/kv`;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ k: SERVER_KEY, v: list }),
      });
      const body = (await res.json()) as { ok?: boolean; err?: string };
      server.set(
        res.ok && body.ok !== false
          ? { state: "saved", where: `the terminal's service (key ${SERVER_KEY})` }
          : { state: "browser-only", reason: body.err ?? `The service answered HTTP ${res.status}.` },
      );
    } catch {
      server.set({ state: "browser-only", reason: `The terminal's service is not answering at ${base()}.` });
    }
  };

  const saveRules = (next: readonly CommittedRule[]): string => {
    rules.set(next);
    if (!kv) return "Kept for this session only — no browser storage was available.";
    const w = kv.write(RULES, [...next]);
    void pushServer(next);
    return w.ok ? "Saved in this browser." : `Not saved in this browser — ${w.error}`;
  };

  return {
    judgements,
    rules,
    server,
    memoryOnly: kv === null,
    verdict: (id) => judgements.peek()[id] ?? null,
    judge(id, verdict, claim) {
      saveJudgements({ ...judgements.peek(), [id]: { verdict, at: now(), claim } });
    },
    unjudge(id) {
      const next = { ...judgements.peek() };
      delete next[id];
      saveJudgements(next);
    },
    commit(text, from, because) {
      const t = text.trim();
      if (t === "") return { ok: false, reason: "Write the rule first — an empty rule cannot be kept." };
      if (rules.peek().some((r) => r.text === t)) return { ok: false, reason: "That rule is already committed." };
      const at = now();
      counter = (counter + 1) % 100000;
      const rule: CommittedRule = { id: `r${at.toString(36)}-${counter.toString(36)}`, text: t, at, from, because };
      const local = saveRules([rule, ...rules.peek()]);
      return { ok: true, rule, local };
    },
    retire(ruleId) {
      saveRules(rules.peek().filter((r) => r.id !== ruleId));
    },
  };
}
