/**
 * Bar-by-bar replay, with a look-ahead firewall.
 *
 * WHY THE FIREWALL IS STRUCTURAL AND NOT A CONVENTION
 * A replay is only worth anything if the terminal genuinely cannot see past the
 * cursor. The tempting implementation — keep the full series and ask each
 * consumer to respect an index — fails the first time one consumer forgets, and
 * the failure is invisible: the chart looks right, the detectors look right, and
 * the signals are quietly perfect because they were computed on bars that had
 * not happened yet.
 *
 * So replay does not hand out an index. It hands out a SHORTER ARRAY. There is
 * no future to leak because the future is not in the object anyone downstream
 * receives. Every detector, indicator, alert and study in the app already takes
 * "the bars"; pointing them at a truncated array needs no cooperation from any
 * of them and cannot be got wrong by a consumer that never learns replay exists.
 *
 * WHAT IT IS FOR
 * Two things, and the second is the one that matters more. It is the best way
 * to learn a market — you cannot cheat, so what you would actually have done is
 * what you find out. And it is a correctness test for the whole detection
 * stack: step through history and every structure must appear on the bar it
 * appeared on live, never earlier.
 */

import { computed, signal, type ReadSignal, type Signal } from "./signal";

export interface ReplayControls<T> {
  /**
   * The visible series.
   *
   * While replay is off this is the source array unchanged, by identity — so
   * nothing pays for replay existing when it is not being used.
   */
  bars: ReadSignal<readonly T[]>;
  active: Signal<boolean>;
  /** How many bars are visible. Never exceeds the source length. */
  cursor: Signal<number>;
  /** Bars per second while playing. */
  speed: Signal<number>;
  playing: Signal<boolean>;
  /** Advance by `n` bars, stopping at the end of the source. */
  step(n?: number): void;
  /** Enter replay at `from` bars visible, or a sensible default. */
  start(from?: number): void;
  stop(): void;
  toggle(): void;
  /** True when the cursor has reached the end of the available history. */
  atEnd: ReadSignal<boolean>;
  dispose(): void;
}

/** Where a replay begins when the caller does not say: a third of the way in. */
export const DEFAULT_START_FRACTION = 1 / 3;

/**
 * The minimum bars a replay may start with.
 *
 * Below the longest indicator warm-up the chart is not wrong, it is empty —
 * and an empty chart reads as a bug rather than as "not enough history yet".
 */
export const MIN_VISIBLE = 60;

export function createReplay<T>(source: ReadSignal<readonly T[]>): ReplayControls<T> {
  const active = signal(false);
  const playing = signal(false);
  const cursor = signal(0);
  const speed = signal(4);

  const bars = computed<readonly T[]>(() => {
    const all = source();
    if (!active()) return all;
    // Clamped on READ as well as on write: the source can shrink under us when
    // the symbol changes, and a stale cursor must not produce a slice longer
    // than the data or an empty one.
    const n = Math.max(0, Math.min(cursor(), all.length));
    return all.slice(0, n);
  });

  const atEnd = computed<boolean>(() => active() && cursor() >= source().length);

  let timer = 0;
  const clear = (): void => {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };

  const step = (n = 1): void => {
    const len = source.peek();
    cursor.update((c) => Math.max(0, Math.min(c + n, len.length)));
    if (cursor.peek() >= len.length) {
      // Reaching the end stops playback but stays IN replay: dropping straight
      // back to live would silently reveal the bars you were stepping towards.
      playing.set(false);
      clear();
    }
  };

  const controls: ReplayControls<T> = {
    bars,
    active,
    cursor,
    speed,
    playing,
    atEnd,
    step,

    start(from) {
      const len = source.peek().length;
      if (len === 0) return;
      const fallback = Math.floor(len * DEFAULT_START_FRACTION);
      const want = from ?? fallback;
      cursor.set(Math.max(Math.min(MIN_VISIBLE, len), Math.min(want, len)));
      active.set(true);
    },

    stop() {
      playing.set(false);
      clear();
      active.set(false);
    },

    toggle() {
      if (!active.peek()) return;
      const next = !playing.peek();
      playing.set(next);
      clear();
      if (!next) return;
      const perSecond = Math.max(0.25, speed.peek());
      timer = window.setInterval(() => step(1), 1000 / perSecond);
    },

    dispose() {
      clear();
    },
  };

  return controls;
}
