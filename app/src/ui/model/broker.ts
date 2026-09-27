/**
 * The broker connection, and the one book every risk figure is computed from.
 *
 * WHAT THIS OWNS
 * Exactly one fact: "what am I actually in, and on what account". The Risk
 * desk goes on owning a different fact — "what did the operator type in" —
 * and `trade/book.ts` reconciles the two with the broker winning per row and
 * saying so. Two facts, two owners, one reconciliation, all named.
 *
 * WHY THE POLL STOPS
 * On most machines the honest answer is `unavailable`: MetaTrader5 is a
 * Windows-only package and it may not be installed at all. Polling a route
 * every five seconds to be told the same thing forever is a waste the operator
 * pays for in battery and the log pays for in noise, so an `unavailable`
 * verdict stops the timer and leaves a Reconnect that the operator can press
 * after they have changed something. `disconnected` — the bridge is there, MT5
 * is shut — KEEPS polling, because that one genuinely changes on its own the
 * moment they open the terminal.
 */

import { computed, effect, onCleanup, signal } from "../../core/signal";
import type { ShellContext } from "../shell/context";
import type { ReadSignal } from "../../core/signal";
import {
  brokerAccount,
  brokerHealth,
  brokerPositions,
  brokerSymbol,
  type BrokerAccount,
  type BrokerHealth,
  type BrokerPosition,
  type BrokerResult,
} from "../../data/broker";
import { reconcile, symbolsNeedingContract, type Book, type ManualPosition } from "../../trade/book";
import { sanitise, type Account } from "../../core/account";

/**
 * How often the broker is asked again while it is answering.
 *
 * Five seconds. Open P&L moves every tick and nobody needs it at tick rate;
 * what has to be timely is a position appearing or a stop moving, and five
 * seconds is well inside the time it takes to notice either. It is also a
 * local IPC call, so the cost is close to nothing.
 */
export const POLL_MS = 5_000;

/**
 * How often the account is asked, as a multiple of the position poll.
 *
 * Balance and leverage change on deposits and margin calls, not on ticks.
 * Equity does move with open P&L — and the positions carry that already, so
 * the figure that matters most is refreshed at the faster rate through them.
 */
export const ACCOUNT_EVERY = 3;

export interface BrokerModelDeps {
  /** The operator's own rows. The Risk desk owns these; this only reads them. */
  readonly manual: ReadSignal<readonly ManualPosition[]>;
}

export function createBrokerModel(ctx: ShellContext, deps: BrokerModelDeps) {
  const health = signal<BrokerResult<BrokerHealth> | null>(null);
  const account = signal<BrokerResult<BrokerAccount> | null>(null);
  const positions = signal<BrokerResult<readonly BrokerPosition[]> | null>(null);
  const contracts = signal<ReadonlyMap<string, number>>(new Map());
  const lastAt = signal(0);
  const busy = signal(false);
  /** Set once the bridge says it can never work here. Stops the timer. */
  const givenUp = signal(false);

  const connected = computed(() => positions()?.state === "ok");

  /**
   * The book.
   *
   * A computed, so it re-derives whenever EITHER source changes — the broker
   * answering or the operator editing a row. Holding a copy and refreshing it
   * on one of those two events is how a reconciliation goes stale against the
   * other one.
   */
  const book = computed<Book>(() =>
    reconcile({
      broker: positions() ?? { state: "offline", reason: "The broker has not been asked yet." },
      manual: deps.manual(),
      contracts: contracts(),
    }),
  );

  /**
   * Fetch the contract size for any symbol we hold and do not have one for.
   *
   * Cached forever within a session and never re-fetched: a contract size is a
   * property of the instrument, not of the market. A symbol that FAILS is left
   * out of the map rather than cached as zero, so the book reports it as
   * unsized and refuses to count it — see the 100,000x note in `trade/book.ts`.
   */
  async function fillContracts(ps: readonly BrokerPosition[]): Promise<void> {
    const have = contracts.peek();
    const missing = symbolsNeedingContract(ps).filter((s) => !have.has(s));
    if (missing.length === 0) return;
    const next = new Map(have);
    for (const sym of missing) {
      const r = await brokerSymbol(sym);
      if (r.state === "ok" && Number.isFinite(r.value.contract_size) && r.value.contract_size > 0) {
        next.set(sym, r.value.contract_size);
      }
    }
    contracts.set(next);
  }

  /** Map the broker's account onto the shared shape, sanitised like any other. */
  function toAccount(a: BrokerAccount): Account {
    return sanitise({
      currency: a.currency,
      balance: a.balance,
      equity: a.equity,
      leverage: a.leverage,
      /* Not the broker's to set. `AccountStore.effective` puts the operator's
         own riskPct back over the top; this value is never read. */
      riskPct: ctx.account.account.peek().riskPct,
    });
  }

  let tick = 0;

  async function refresh(force = false): Promise<void> {
    if (busy.peek()) return;
    if (givenUp.peek() && !force) return;
    busy.set(true);
    try {
      const h = await brokerHealth();
      health.set(h);

      if (h.state === "unavailable") {
        /* Nothing on this machine will make this work. Stop asking, and clear
           the live account so nothing downstream goes on presenting the last
           broker figures as current. */
        givenUp.set(true);
        positions.set(h);
        account.set(h);
        ctx.account.live.set(null);
        return;
      }
      givenUp.set(false);

      const ps = await brokerPositions();
      positions.set(ps);
      if (ps.state === "ok") await fillContracts(ps.value);

      if (tick % ACCOUNT_EVERY === 0 || force || ctx.account.live.peek() === null) {
        const a = await brokerAccount();
        account.set(a);
        ctx.account.live.set(
          a.state === "ok"
            ? { account: toAccount(a.value), at: Date.now(), login: a.value.login, server: a.value.server }
            : null,
        );
      }
      tick += 1;
      if (ps.state === "ok") lastAt.set(Date.now());
    } finally {
      busy.set(false);
    }
  }

  /**
   * Try again after the operator has changed something on their machine.
   *
   * The only route out of `givenUp`, and it is deliberately a button rather
   * than a slow background retry: the thing that fixes `unavailable` is
   * installing a package and restarting the bridge, which is not something a
   * timer can wait for.
   */
  function reconnect(): void {
    givenUp.set(false);
    void refresh(true);
  }

  effect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!givenUp.peek()) void refresh();
    }, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  return {
    health,
    account,
    positions,
    contracts,
    book,
    connected,
    lastAt,
    busy,
    givenUp,
    refresh,
    reconnect,
  };
}

export type BrokerModel = ReturnType<typeof createBrokerModel>;
