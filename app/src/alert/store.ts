/**
 * The alert book: specs, persistence, and one evaluation pass.
 *
 * Alerts outlive the tab, so they are persisted. What is NOT persisted is the
 * fire history's authority: on every load the whole book is re-evaluated from
 * the bars. If a stored "already fired" flag disagreed with what the data says,
 * the data wins. A cache of past conclusions is exactly the thing that goes
 * subtly wrong and is never noticed.
 *
 * De-duplication is by (alert, bar time). A given alert fires at most once for
 * a given bar no matter how many times the pass runs, which is what lets the
 * evaluator re-walk all of history every tick without spamming.
 */

import { signal, type Signal } from "../core/signal";
import type { Detection, DetectInput } from "../detect/types";
import { DETECTOR_FOR_KIND, type DetectorId } from "../detect";
import { resolveAnchor } from "./anchor";
import { evaluateAlert } from "./engine";
import type { AlertFire, AlertRuntime, AlertSpec } from "./types";
import { createKV, listSlot, type KV } from "../store/kv";

/** The pre-v41 raw key. Read once, to carry an existing book forward. */
const LEGACY_KEY = "iram.alerts.v40";
const MAX_LOG = 200;

const isSpec = (a: unknown): a is AlertSpec =>
  !!a &&
  typeof a === "object" &&
  typeof (a as AlertSpec).id === "string" &&
  typeof (a as AlertSpec).symbol === "string" &&
  !!(a as AlertSpec).anchor;

/**
 * The book, in the versioned store.
 *
 * It lives under a syncable key on purpose: an alert book that does not follow
 * you to the laptop is half a feature. Per-item validation means one
 * half-written entry drops out rather than taking the whole book with it.
 */
export const ALERT_BOOK_SLOT = listSlot<AlertSpec>("alerts.book", 1, isSpec);

export interface AlertStore {
  specs: Signal<AlertSpec[]>;
  /** Newest first. Capped, because an unbounded log is a memory leak with a UI. */
  log: Signal<AlertFire[]>;
  runtimes: Signal<AlertRuntime[]>;
  add(spec: AlertSpec): void;
  remove(id: string): void;
  toggle(id: string): void;
  clearLog(): void;
  /**
   * Evaluate every alert for this symbol/timeframe and return only the fires
   * that had not been recorded before.
   */
  evaluate(ctx: EvaluateContext): AlertFire[];
}

export interface EvaluateContext {
  symbol: string;
  timeframe: string;
  data: DetectInput;
  detections: readonly Detection[];
  closedCount: number;
}

/**
 * Read the book, adopting a pre-v41 one if that is all there is.
 *
 * The legacy key is only consulted when the new slot is empty, and it is left
 * in place rather than deleted — if this build turns out to be wrong about
 * something, the old bytes are still there.
 */
function load(kv: KV): AlertSpec[] {
  const current = kv.get(ALERT_BOOK_SLOT);
  if (current.length > 0) return current;

  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]") as unknown;
    const legacy = Array.isArray(raw) ? raw.filter(isSpec) : [];
    if (legacy.length > 0) kv.write(ALERT_BOOK_SLOT, legacy);
    return legacy;
  } catch {
    return [];
  }
}

/** Stable-ish id without a clock dependency in the pure path. */
let seq = 0;
export function alertId(now: number): string {
  seq += 1;
  return `al_${now.toString(36)}_${seq.toString(36)}`;
}

export function createAlertStore(kv: KV = createKV()): AlertStore {
  const specs = signal<AlertSpec[]>(load(kv));
  const log = signal<AlertFire[]>([]);
  const runtimes = signal<AlertRuntime[]>([]);

  /** alertId -> set of bar times already reported. */
  const seen = new Map<string, Set<number>>();

  // A failed write is not fatal: alerts still work for this session, and losing
  // them on reload is a far smaller failure than refusing to arm them.
  const persist = (): void => {
    kv.write(ALERT_BOOK_SLOT, specs.peek());
  };

  const store: AlertStore = {
    specs,
    log,
    runtimes,

    add(spec) {
      specs.update((list) => [...list, spec]);
      persist();
    },

    remove(id) {
      specs.update((list) => list.filter((a) => a.id !== id));
      seen.delete(id);
      persist();
    },

    toggle(id) {
      specs.update((list) => list.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
      persist();
    },

    clearLog() {
      log.set([]);
    },

    evaluate(ctx) {
      const fresh: AlertFire[] = [];
      const rts: AlertRuntime[] = [];
      const mine = specs
        .peek()
        .filter((a) => a.symbol === ctx.symbol && a.timeframe === ctx.timeframe);

      for (const spec of mine) {
        if (!spec.enabled) {
          rts.push({ spec, status: "off", statusNote: "disabled", fires: [], currentAnchor: null });
          continue;
        }

        const res = resolveAnchor(spec.anchor, ctx.data, ctx.detections);
        if (!res.ok) {
          rts.push({
            spec,
            status: "orphaned",
            statusNote: res.reason,
            fires: [],
            currentAnchor: null,
          });
          continue;
        }

        const fires = evaluateAlert(spec, ctx.data, res.anchor, { closedCount: ctx.closedCount });

        let bucket = seen.get(spec.id);
        if (!bucket) {
          bucket = new Set<number>();
          seen.set(spec.id, bucket);
        }
        for (const f of fires) {
          if (bucket.has(f.time)) continue;
          bucket.add(f.time);
          fresh.push(f);
        }

        // Where the anchor sits on the newest bar, for the "now at" readout.
        const last = Math.max(0, Math.min(ctx.closedCount, ctx.data.c.length) - 1);
        const band = res.anchor.at(last);

        rts.push({
          spec,
          status: spec.once && fires.length > 0 ? "done" : "armed",
          statusNote: "",
          fires,
          currentAnchor: band ? (band.lo + band.hi) / 2 : null,
        });
      }

      runtimes.set(rts);
      if (fresh.length > 0) {
        log.update((l) => [...fresh].reverse().concat(l).slice(0, MAX_LOG));
      }
      return fresh;
    },
  };

  return store;
}

/**
 * First evaluation must not announce history.
 *
 * A book of alerts loaded against six months of bars will legitimately produce
 * hundreds of past fires. Those belong in the log, not in a notification storm.
 * The caller primes the store once, then treats everything after as live.
 */
export function primeSeen(store: AlertStore, ctx: EvaluateContext): AlertFire[] {
  const past = store.evaluate(ctx);
  return past;
}

/**
 * The detectors that must run for this book of alerts to be evaluable.
 *
 * An alert anchored to an order block needs the order-block detector running
 * even when the user has switched that overlay off on the chart. Display
 * preferences must not silently disarm alerts — that is precisely the kind of
 * failure nobody notices until the alert they were relying on never came.
 */
export function requiredDetectors(
  specs: readonly AlertSpec[],
  symbol: string,
  timeframe: string,
): DetectorId[] {
  const out = new Set<DetectorId>();
  for (const s of specs) {
    if (!s.enabled) continue;
    if (s.symbol !== symbol || s.timeframe !== timeframe) continue;
    if (s.anchor.kind !== "detection") continue;
    out.add(DETECTOR_FOR_KIND[s.anchor.detKind]);
  }
  return [...out];
}
