/**
 * The account — ONE copy of the numbers every position size starts from.
 *
 * THE DEFECT THIS REPLACES
 * `equity` and `riskPct` were stored twice, in two slots that never read each
 * other and each carried its own default of 10,000 and 1%:
 *
 *     risk.config     equity, riskPct, …   (ui/risk.ts)
 *     calculator.v1   equity, riskPct, …   (ui/calculator.ts)
 *
 * Set your equity to 4,200 on the Risk desk, open the Calculator, and it sized
 * your next position off 10,000 — silently, and looking exactly as authoritative
 * as a correct answer. The lot it returned was 2.4x too large. That is the same
 * failure class as the v47 pip-value and margin bugs: not a wrong pixel, a
 * confident wrong number under a lot size.
 *
 * Two desks cannot disagree about one fact if there is only one fact.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * Only the numbers that more than one desk legitimately needs: currency,
 * balance, equity, leverage, risk per trade. Fee models, ATR multiples, quantity
 * steps and the swap/commission fields stay with the desk that owns them —
 * moving those would be a reorganisation, not a fix, and this module exists to
 * stop a specific class of wrong answer rather than to become a settings dump.
 */

import { computed, signal, type ReadSignal, type Signal } from "./signal";
import type { KV } from "../store/kv";

export interface Account {
  /** Display currency for every money figure. Not a conversion rate. */
  readonly currency: string;
  /** Closed equity. Drives the daily-loss guard. */
  readonly balance: number;
  /** Balance plus open P&L. Drives free margin and EVERY lot size. */
  readonly equity: number;
  /** As the broker states it, e.g. 100 for 1:100. */
  readonly leverage: number;
  /** Percent of equity risked per trade. The user's choice; nothing suggests one. */
  readonly riskPct: number;
}

export const DEFAULT_ACCOUNT: Account = {
  currency: "USD",
  balance: 10_000,
  equity: 10_000,
  leverage: 100,
  riskPct: 1,
};

/** The overlapping fields — the only ones that could ever have disagreed. */
export const SHARED_FIELDS = ["equity", "riskPct"] as const;
export type SharedField = (typeof SHARED_FIELDS)[number];

export interface FieldConflict {
  readonly field: SharedField;
  readonly fromRisk: number;
  readonly fromCalculator: number;
}

export interface MigrationResult {
  readonly account: Account;
  /**
   * Populated when the two old slots disagreed and NEITHER was the default, so
   * both look deliberate. The value below is provisional until the user says
   * which is theirs.
   */
  readonly conflicts: readonly FieldConflict[];
}

/** The shapes we may find in storage. Everything optional: old data is untrusted. */
export interface LegacyRisk {
  readonly equity?: number | undefined;
  readonly riskPct?: number | undefined;
}
export interface LegacyCalculator {
  readonly balance?: number | undefined;
  readonly equity?: number | undefined;
  readonly leverage?: number | undefined;
  readonly riskPct?: number | undefined;
}

const finite = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Fold the two old slots into one account.
 *
 * THE RULE, AND WHY IT IS NOT "LAST WRITER WINS"
 * If the two disagree and neither is the default, one of them is the number the
 * user actually trades on and the other is stale. Picking either is a coin flip
 * on the input to every lot size — so it does not pick. It carries the Risk
 * desk's value forward (that desk owns sizing) and REPORTS the conflict, so the
 * terminal can ask once instead of being quietly wrong forever.
 *
 * When only one side was ever edited, there is no ambiguity: the non-default
 * value is the intent, whichever slot it came from.
 */
export function migrateAccount(
  risk: LegacyRisk | null,
  calc: LegacyCalculator | null,
): MigrationResult {
  const conflicts: FieldConflict[] = [];

  const pick = (field: SharedField): number => {
    const fromRisk = risk?.[field];
    const fromCalc = calc?.[field];
    const d = DEFAULT_ACCOUNT[field];

    const haveRisk = finite(fromRisk);
    const haveCalc = finite(fromCalc);
    if (!haveRisk && !haveCalc) return d;
    if (haveRisk && !haveCalc) return fromRisk;
    if (!haveRisk && haveCalc) return fromCalc;

    const r = fromRisk as number;
    const c = fromCalc as number;
    if (r === c) return r;

    /* One of them is untouched, so the other is the only expressed intent. */
    if (r === d) return c;
    if (c === d) return r;

    /* Both edited, both different. Refuse to guess. */
    conflicts.push({ field, fromRisk: r, fromCalculator: c });
    return r;
  };

  const equity = pick("equity");
  const riskPct = pick("riskPct");

  return {
    account: {
      currency: DEFAULT_ACCOUNT.currency,
      /* Only the Calculator ever stored these two, so there is nothing to
         reconcile — take them when present, default otherwise. */
      balance: finite(calc?.balance) ? calc.balance : DEFAULT_ACCOUNT.balance,
      leverage: finite(calc?.leverage) ? calc.leverage : DEFAULT_ACCOUNT.leverage,
      equity,
      riskPct,
    },
    conflicts,
  };
}

// ------------------------------------------------------------------ store ---

export const ACCOUNT_SLOT = {
  key: "account.v1",
  version: 1,
  fallback: (): Account => DEFAULT_ACCOUNT,
  validate: (v: unknown): Account | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const num = (k: keyof Account, d: number): number =>
      typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : d;
    return {
      currency: typeof o["currency"] === "string" ? o["currency"] : DEFAULT_ACCOUNT.currency,
      balance: num("balance", DEFAULT_ACCOUNT.balance),
      equity: num("equity", DEFAULT_ACCOUNT.equity),
      leverage: num("leverage", DEFAULT_ACCOUNT.leverage),
      riskPct: num("riskPct", DEFAULT_ACCOUNT.riskPct),
    };
  },
};

/** Read-only views of the two slots we migrate from. */
const LEGACY_RISK_SLOT = {
  key: "risk.config",
  version: 1,
  fallback: (): LegacyRisk => ({}),
  validate: (v: unknown): LegacyRisk | null =>
    v !== null && typeof v === "object" ? (v as LegacyRisk) : null,
};

const LEGACY_CALC_SLOT = {
  key: "calculator.v1",
  version: 1,
  fallback: (): LegacyCalculator => ({}),
  validate: (v: unknown): LegacyCalculator | null =>
    v !== null && typeof v === "object" ? (v as LegacyCalculator) : null,
};

/**
 * Where the numbers being used right now actually came from.
 *
 * Carried beside every figure rather than inferred. A terminal that shows an
 * equity of 11,482.60 and cannot say whether that is your broker's number or
 * one you typed in six weeks ago is a terminal you cannot size a trade on.
 */
export type AccountSource =
  | { readonly kind: "manual" }
  | {
      readonly kind: "broker";
      readonly login: number;
      readonly server: string;
      /** When the broker last answered. Staleness is the operator's to judge. */
      readonly at: number;
    };

export interface AccountStore {
  /**
   * The numbers the OPERATOR entered. Persisted, editable, and never
   * overwritten by a broker.
   *
   * This is the editing surface. For anything that sizes a trade or measures
   * risk, read `effective` instead — see the note on it.
   */
  readonly account: Signal<Account>;
  /**
   * What the broker says, or null when no broker is connected.
   *
   * NOT PERSISTED, deliberately. A stored broker figure would be indis-
   * tinguishable from a typed one the moment MT5 was closed, and would keep
   * sizing trades off an equity from last Tuesday while looking live.
   */
  readonly live: Signal<{ readonly account: Account; readonly at: number; readonly login: number; readonly server: string } | null>;
  /**
   * The account every risk figure and every lot size must be computed from.
   *
   * The broker's numbers when there are any, the operator's otherwise. This
   * is the one that answers "what am I actually trading on", and it exists as
   * a separate name from `account` so the distinction cannot be lost by
   * accident — `core/account.ts` was written because two copies of an equity
   * produced a lot size 2.4x too large, and connecting a broker creates a
   * third copy unless it is named.
   */
  readonly effective: ReadSignal<Account>;
  readonly source: ReadSignal<AccountSource>;
  /** Patch one or more fields. Persists immediately. */
  update(patch: Partial<Account>): void;
  /**
   * Unresolved migration disagreements. Non-empty means the terminal is using a
   * provisional number and should say so before anyone sizes a trade on it.
   */
  readonly conflicts: Signal<readonly FieldConflict[]>;
  /** Record the user's answer and stop asking. */
  resolve(field: SharedField, value: number): void;
  /** Accept the provisional values as they stand. */
  dismissConflicts(): void;
}

/**
 * Sanity floors.
 *
 * Not opinions about how to trade — guards against arithmetic that cannot mean
 * anything. A zero or negative equity makes every lot size either zero or
 * signed backwards, and leverage below 1 is not a leverage.
 */
export function sanitise(a: Account): Account {
  return {
    currency: a.currency.trim() === "" ? DEFAULT_ACCOUNT.currency : a.currency.trim().toUpperCase(),
    balance: Number.isFinite(a.balance) && a.balance > 0 ? a.balance : DEFAULT_ACCOUNT.balance,
    equity: Number.isFinite(a.equity) && a.equity > 0 ? a.equity : DEFAULT_ACCOUNT.equity,
    leverage: Number.isFinite(a.leverage) && a.leverage >= 1 ? a.leverage : DEFAULT_ACCOUNT.leverage,
    /* Zero risk is a legitimate "size nothing"; negative is not. */
    riskPct: Number.isFinite(a.riskPct) && a.riskPct >= 0 ? a.riskPct : DEFAULT_ACCOUNT.riskPct,
  };
}

/** The numeric fields a desk can bind an input straight to. */
export type NumericField = "balance" | "equity" | "leverage" | "riskPct";

/**
 * A `Signal<number>` view over ONE account field.
 *
 * Desks bind their number inputs to this instead of keeping a local signal, so
 * an edit on the Risk desk is the same write as an edit in the Calculator.
 * Reading is tracked exactly like a real signal, so a panel re-renders when the
 * account changes anywhere — including from the other desk, which is the whole
 * point.
 */
export function accountField(store: AccountStore, key: NumericField): Signal<number> {
  const read = (): number => store.account()[key];
  const write = (v: number): void => store.update({ [key]: v });
  const fn = (() => read()) as Signal<number>;
  Object.assign(fn, {
    peek: () => store.account.peek()[key],
    set: write,
    update: (f: (prev: number) => number) => write(f(store.account.peek()[key])),
  });
  return fn;
}

export function createAccountStore(kv: KV): AccountStore {
  const report = kv.read(ACCOUNT_SLOT);
  const conflicts = signal<readonly FieldConflict[]>([]);

  let initial: Account;
  /* `default` is the outcome for "nothing stored yet" — the enum has no
     "miss". Getting that wrong made the migration never run. */
  if (report.outcome === "default") {
    /* No account yet: fold the two old slots in, once. */
    const migrated = migrateAccount(kv.read(LEGACY_RISK_SLOT).value, kv.read(LEGACY_CALC_SLOT).value);
    initial = sanitise(migrated.account);
    conflicts.set(migrated.conflicts);
    kv.write(ACCOUNT_SLOT, initial);
  } else {
    initial = sanitise(report.value);
  }

  const account = signal<Account>(initial, (a, b) =>
    a.currency === b.currency &&
    a.balance === b.balance &&
    a.equity === b.equity &&
    a.leverage === b.leverage &&
    a.riskPct === b.riskPct,
  );

  const persist = (next: Account): void => {
    account.set(next);
    kv.write(ACCOUNT_SLOT, next);
  };

  const live = signal<{ account: Account; at: number; login: number; server: string } | null>(null);

  /* `riskPct` is ALWAYS the operator's. A broker reports balance, equity and
     leverage; it has no opinion about how much of that you are willing to lose
     on one trade, and taking the field from the live object would silently
     reset it to whatever `sanitise` defaults to. */
  const effective = computed<Account>(() => {
    const l = live();
    const own = account();
    return l === null ? own : { ...l.account, riskPct: own.riskPct };
  });

  const source = computed<AccountSource>(() => {
    const l = live();
    return l === null
      ? { kind: "manual" }
      : { kind: "broker", login: l.login, server: l.server, at: l.at };
  });

  return {
    account,
    live,
    effective,
    source,
    conflicts,
    update(patch) {
      persist(sanitise({ ...account.peek(), ...patch }));
    },
    resolve(field, value) {
      persist(sanitise({ ...account.peek(), [field]: value }));
      conflicts.update((list) => list.filter((c) => c.field !== field));
    },
    dismissConflicts() {
      conflicts.set([]);
    },
  };
}
