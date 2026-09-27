/**
 * The Discovered shelf, with ONE owner.
 *
 * `discovered.ts` is the pure half — what a row is, how one is added, promoted,
 * retired and aged out. This is the half that holds them: a signal over
 * `DISCOVERED_SLOT`, so the Strategy desk that writes a row and the
 * recommendation card that reads it are looking at the same list in the same
 * frame.
 *
 * WHY NOT TWO READERS OF THE SLOT. `kv.get` is not reactive. Two components
 * each reading it would each hold a snapshot, and promoting a strategy on the
 * Strategy desk would leave the card showing it as unproven until something
 * unrelated re-rendered — the equity defect's shape exactly (two desks, each
 * with a copy). The shell builds one store and passes it to both.
 *
 * Every mutation goes through `discovered.ts`'s own functions. This module
 * decides nothing about what a row means; it decides only where the list lives.
 */

import { signal, type ReadSignal } from "../core/signal";
import { DISCOVERED_SLOT, addDiscovered, keyOf, promoteDiscovered, retireDiscovered, type Discovered } from "./discovered";
import type { KV } from "../store/kv";

export interface ShelfStore {
  readonly rows: ReadSignal<readonly Discovered[]>;
  /** Save a run's survivors. Returns how many rows the shelf now holds of them. */
  addAll(rows: readonly Discovered[]): number;
  promote(key: string): void;
  retire(key: string, why: string): void;
  /** Record that a server-side watch was armed for this row. */
  arm(key: string, at: number): void;
  /** Re-read the slot — for a write that happened in another tab. */
  reload(): void;
}

export function createShelfStore(kv: KV): ShelfStore {
  const rows = signal<readonly Discovered[]>(kv.get(DISCOVERED_SLOT));

  const commit = (next: readonly Discovered[]): void => {
    rows.set(next);
    /* A failed write is not fatal: the shelf is correct for this session and
       losing it on reload is a smaller failure than refusing to record a
       promotion the operator just made. */
    kv.write(DISCOVERED_SLOT, next);
  };

  return {
    rows: rows as ReadSignal<readonly Discovered[]>,
    addAll(incoming) {
      let next = rows.peek();
      for (const row of incoming) next = addDiscovered(next, row);
      commit(next);
      const keys = new Set(incoming.map(keyOf));
      return next.filter((d) => keys.has(keyOf(d))).length;
    },
    promote(key) {
      commit(promoteDiscovered(rows.peek(), key));
    },
    retire(key, why) {
      commit(retireDiscovered(rows.peek(), key, why));
    },
    arm(key, at) {
      commit(rows.peek().map((d) => (keyOf(d) === key ? { ...d, armedAt: at } : d)));
    },
    reload() {
      rows.set(kv.get(DISCOVERED_SLOT));
    },
  };
}

/** Rows that apply to one instrument and are still in play. Retired ones are not. */
export function liveFor(all: readonly Discovered[], symbol: string, timeframe: string): Discovered[] {
  return all.filter((d) => d.symbol === symbol && d.timeframe === timeframe && d.status !== "retired");
}
