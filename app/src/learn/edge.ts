/**
 * The trial mirror, and the conditional table that comes back.
 *
 * WHY THE REPLAY STAYS IN THE BROWSER
 * The obvious way to slice a setup record by session, weekday and regime is to
 * port the detectors to Python and replay there over far more history than a
 * tab can hold. That was the plan and it is the wrong plan: twenty-nine
 * detectors reimplemented in a second language is twenty-nine chances for the
 * two to disagree, and this repository's governing bug — a value correct in
 * one context read in another — is exactly what that would industrialise.
 *
 * So the replay stays in `setup/simulate.ts`, which already does it honestly,
 * and what crosses the wire is OUTCOMES. Those are what need to accumulate:
 * a trial computed today from bars that will have rolled out of the window by
 * next month cannot be recomputed later at any price, and localStorage is not
 * where the only copy of it should live — the argument `server/mishel_claims.py`
 * makes at length about claims applies unchanged here.
 *
 * WHAT COMES BACK IS MOSTLY REFUSALS
 * The server slices one sample four ways into twenty-odd cells, so the best
 * cell is expected to look like an edge whether or not anything is there. The
 * response states how many cells were examined, corrects the threshold for it,
 * and usually declines to name a winner. Rendering that verbatim is the point;
 * see `server/mishel_edge.py`.
 */

import { looksLocal } from "./ledger";
import type { Simulation } from "../setup/simulate";
import { serviceBase } from "../data/backend";

export const DEFAULT_EDGE_URL = (): string => serviceBase();

/** One trial, in the shape the service stores. */
export interface TrialRow {
  readonly id: string;
  readonly at: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly direction: "long" | "short";
  readonly outcome: "target" | "stop" | "unknowable" | "open";
  readonly rGross: number | null;
  /** Stop distance as a percentage of entry. The cost model needs this. */
  readonly stopPct: number | null;
  readonly barsHeld: number;
  readonly regime?: string;
}

/**
 * Flatten a simulation into rows.
 *
 * The id is derived from the trial rather than generated, so re-running the
 * replay — which is deterministic — converges on the same rows instead of
 * accumulating a duplicate set every time the card refreshes. That failure has
 * already happened once in this codebase: 283 claims turned out to be 151
 * positions, and every duplicate narrowed a confidence interval around no new
 * evidence at all.
 */
export function rowsFrom(
  sim: Simulation,
  symbol: string,
  timeframe: string,
  regime?: string,
): TrialRow[] {
  const out: TrialRow[] = [];
  for (const t of sim.trials) {
    /* `expired` is not a server outcome. A trial that ran out of horizon
       without touching either barrier is not a loss and is not unknowable —
       it is a trial the horizon was too short for, and it is dropped rather
       than mapped onto something that would move a hit rate. */
    const outcome =
      t.outcome === "target" ? "target" : t.outcome === "stop" ? "stop"
      : t.outcome === "unknowable" ? "unknowable" : null;
    if (outcome === null) continue;

    const stopPct =
      t.entry > 0 && Number.isFinite(t.stop) ? (Math.abs(t.entry - t.stop) / t.entry) * 100 : null;

    out.push({
      id: `${symbol}|${timeframe}|${sim.kind}|${sim.direction}|${t.at}`,
      at: t.at,
      symbol,
      timeframe,
      kind: sim.kind,
      direction: sim.direction,
      outcome,
      rGross: t.r,
      stopPct,
      barsHeld: t.heldBars,
      ...(regime === undefined ? {} : { regime }),
    });
  }
  return out;
}

export interface Cell {
  readonly label: string;
  readonly n: number;
  readonly hits: number;
  readonly unknowable: number;
  readonly uncosted: number;
  readonly hitRate: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly expectancyR: number | null;
  readonly reportable: boolean;
}

export interface ConditionalTable {
  readonly available: boolean;
  readonly reason?: string;
  readonly trials: number;
  readonly days: number;
  readonly overall?: Cell;
  readonly groups?: Readonly<Record<string, readonly Cell[]>>;
  readonly comparisons?: number;
  readonly best?: { readonly found: boolean; readonly text: string };
  readonly costs?: { readonly bps: number; readonly note: string } | null;
}

export interface EdgeOptions {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly symbol: () => string;
  readonly timeframe: () => string;
}

export interface EdgeHandle {
  /** Mirror a batch of simulations. Returns rows written, or -1 on failure. */
  push(sims: readonly Simulation[], regime?: string): Promise<number>;
  /** The conditional table for one kind, or for everything when kind is null. */
  conditional(kind: string | null): Promise<ConditionalTable | null>;
  /** Why the last call failed, or "". */
  lastError(): string;
}

export function createEdge(opts: EdgeOptions): EdgeHandle {
  const url = (opts.url ?? DEFAULT_EDGE_URL()).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let error = "";

  /* Same gate the claims ledger uses. Trials are the operator's own measured
     history of their own instruments; posting them to a host that is not this
     machine is a data-export decision, not a sync detail. `looksLocal` parses
     the hostname rather than matching a substring, because "127.0.0.1.evil.com"
     contains "127.0.0.1". */
  if (!looksLocal(url)) {
    return {
      async push() {
        error = "Refusing to send trials to a non-local host.";
        return -1;
      },
      async conditional() {
        error = "Refusing to read trials from a non-local host.";
        return null;
      },
      lastError: () => error,
    };
  }

  return {
    async push(sims, regime) {
      const trials: TrialRow[] = [];
      for (const sim of sims) trials.push(...rowsFrom(sim, opts.symbol(), opts.timeframe(), regime));
      if (trials.length === 0) return 0;
      try {
        const res = await doFetch(`${url}/svc/edge/trials`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trials }),
        });
        const body = (await res.json()) as { ok?: boolean; written?: number; err?: string };
        if (!res.ok || !body.ok) {
          error = body.err ?? `HTTP ${res.status}`;
          return -1;
        }
        error = "";
        return body.written ?? 0;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        return -1;
      }
    },

    async conditional(kind) {
      const params = new URLSearchParams({
        symbol: opts.symbol(),
        timeframe: opts.timeframe(),
      });
      if (kind) params.set("kind", kind);
      try {
        const res = await doFetch(`${url}/svc/edge/conditional?${params}`);
        const body = (await res.json()) as ConditionalTable & { ok?: boolean; err?: string };
        if (!res.ok || body.ok === false) {
          error = body.err ?? `HTTP ${res.status}`;
          return null;
        }
        error = "";
        return body;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        return null;
      }
    },

    lastError: () => error,
  };
}

/**
 * One line summarising a table, for the places that have room for one line.
 *
 * Leads with the refusal when there is one. A caller that rendered the cells
 * and then appended "but none of this is significant" would be putting the
 * qualification after the number, which is the order in which nobody reads it.
 */
export function summarise(table: ConditionalTable | null): string {
  if (!table) return "No conditional table — the service did not answer.";
  if (!table.available) return table.reason ?? "Not enough to slice.";
  const best = table.best;
  if (best && !best.found) {
    return `${table.trials} trials over ${table.days} days, ${table.comparisons} cells examined — nothing survives the correction for having looked.`;
  }
  return best?.text ?? `${table.trials} trials over ${table.days} days.`;
}
