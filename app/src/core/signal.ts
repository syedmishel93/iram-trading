/**
 * Fine-grained reactivity.
 *
 * WHY NOT A FRAMEWORK
 * This terminal's hot path is a price tick arriving several times a second and
 * touching a handful of readouts among thousands of DOM nodes. A virtual-DOM
 * diff does work proportional to the tree; a signal does work proportional to
 * what actually changed. v39 solved the same problem with a hand-rolled tick
 * bus plus `renderIfChanged` content-hash guards scattered through the modules
 * — this is that idea, made general and made typed.
 *
 * Effects batch to a microtask; render effects batch to an animation frame, so
 * a burst of ticks inside one frame repaints once.
 */

import { scheduleFrame } from "./frame";

type Cleanup = () => void;

interface Reaction {
  run(): void;
  /** How this reaction gets re-run when a dependency changes. */
  notify(): void;
  deps: Set<Set<Reaction>>;
  cleanups: Cleanup[];
  disposed: boolean;
}

let ACTIVE: Reaction | null = null;
let BATCH_DEPTH = 0;
let FLUSH_QUEUED = false;
const PENDING = new Set<Reaction>();

/** Detach a reaction from every signal it read on its last run. */
function unlink(r: Reaction): void {
  for (const dep of r.deps) dep.delete(r);
  r.deps.clear();
  for (const c of r.cleanups) c();
  r.cleanups.length = 0;
}

function flush(): void {
  // Snapshot: a reaction may enqueue others while running.
  while (PENDING.size) {
    const queue = [...PENDING];
    PENDING.clear();
    for (const r of queue) if (!r.disposed) r.run();
  }
}

/** Default notify: coalesce into one microtask flush. */
function notifyMicrotask(r: Reaction): void {
  PENDING.add(r);
  if (BATCH_DEPTH > 0 || FLUSH_QUEUED) return;
  FLUSH_QUEUED = true;
  queueMicrotask(() => {
    FLUSH_QUEUED = false;
    flush();
  });
}

export interface ReadSignal<T> {
  (): T;
  readonly peek: () => T;
}

export interface Signal<T> extends ReadSignal<T> {
  set(value: T): void;
  update(fn: (prev: T) => T): void;
}

/**
 * A writable reactive value.
 *
 * `equals` defaults to Object.is, which is what stops a feed republishing an
 * unchanged price from repainting the UI — the most common source of wasted
 * frames in the old build.
 */
export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  let value = initial;
  const subs = new Set<Reaction>();

  const read = (() => {
    if (ACTIVE) {
      subs.add(ACTIVE);
      ACTIVE.deps.add(subs);
    }
    return value;
  }) as Signal<T>;

  Object.defineProperty(read, "peek", { value: () => value });

  read.set = (next: T): void => {
    if (equals(value, next)) return;
    value = next;
    for (const r of [...subs]) r.notify();
  };
  read.update = (fn: (prev: T) => T): void => read.set(fn(value));

  return read;
}

/** How many swallowed effect errors are kept for diagnosis. */
const THROW_LOG_LIMIT = 50;

function recordThrow(err: unknown): void {
  const g = globalThis as unknown as { __signalErrors?: string[] };
  const log = (g.__signalErrors = g.__signalErrors ?? []);
  /* Oldest first, and the FIRST one is the one worth keeping: a computed that
     threw is the cause, and everything after it is the cascade of consumers
     reading the `undefined` it left behind. So the cap drops the newest, not
     the oldest — the opposite of the feed log, for the opposite reason. */
  if (log.length < THROW_LOG_LIMIT) log.push(String((err as Error)?.stack ?? err));
}

/**
 * How many reactions are alive right now.
 *
 * A count, not a registry: holding the reactions themselves would keep every
 * disposed one from being collected, which is the opposite of what a leak
 * counter is for.
 *
 * It exists because "is this subscription still running" is otherwise
 * unanswerable from outside. A desk built at boot and never opened still holds
 * live effects that re-run on every tick for the rest of the session, and
 * nothing on screen shows that — the desk is detached DOM, so it is invisible
 * in the element tree while remaining fully subscribed.
 */
let liveReactions = 0;

/** Live reaction count. Zero-cost to read; used by the dev handle and tests. */
export function reactionCount(): number {
  return liveReactions;
}

function createReaction(fn: () => void | Cleanup, notify: (r: Reaction) => void): Reaction {
  liveReactions++;
  const r: Reaction = {
    deps: new Set(),
    cleanups: [],
    disposed: false,
    notify: () => notify(r),
    run() {
      if (r.disposed) return;
      unlink(r);
      const prev = ACTIVE;
      ACTIVE = r;
      try {
        const cleanup = fn();
        if (typeof cleanup === "function") r.cleanups.push(cleanup);
      } catch (err) {
        // A throwing effect must not take the scheduler down with it. v39 learned
        // this the hard way: one bad job silently killed the whole timer loop.
        //
        // But swallowing is only half a policy, and the other half was missing.
        // A `computed` is an effect that assigns; when its function throws, this
        // catch leaves the computed holding `undefined` FOR EVER — and every
        // consumer then throws too, on a line that has nothing wrong with it.
        // Chasing one of those back to its origin means reading a console full
        // of `Cannot read properties of undefined` where the ONE useful entry
        // is whichever happened to be logged first.
        //
        // So the stacks are kept, in order, where a diagnostic can reach them:
        // `window.__signalErrors`. Bounded, because an effect that throws once
        // per frame would otherwise be a leak on top of a bug.
        recordThrow(err);
        console.error("[signal] effect threw", err);
      } finally {
        ACTIVE = prev;
      }
    },
  };
  return r;
}

/**
 * Run `fn`, re-running whenever any signal it read changes.
 * Returns a disposer. `onCleanup` inside `fn` registers teardown for the next run.
 */
export function effect(fn: () => void | Cleanup): Cleanup {
  const r = createReaction(fn, notifyMicrotask);
  r.run();
  return () => {
    if (r.disposed) return;
    r.disposed = true;
    liveReactions--;
    PENDING.delete(r);
    unlink(r);
  };
}

/**
 * An effect whose re-runs are driven by requestAnimationFrame.
 *
 * Anything that writes to the DOM or a canvas belongs here. It guarantees at
 * most one repaint per frame however many ticks land between frames, and it
 * parks entirely while the tab is hidden — which matters because this terminal
 * is ALWAYS a background tab (you are in MT5) and Chrome throttles hidden tabs.
 * Queued paints coalesce into the single frame that runs on tab return, rather
 * than replaying every intermediate state.
 */
export function renderEffect(fn: () => void | Cleanup): Cleanup {
  let cancel: (() => void) | null = null;
  const r = createReaction(fn, (reaction) => {
    if (cancel) return; // already queued for this frame
    cancel = scheduleFrame(() => {
      cancel = null;
      if (!reaction.disposed) reaction.run();
    });
  });
  r.run(); // paint once immediately so first render is not a frame late
  return () => {
    if (r.disposed) return;
    r.disposed = true;
    liveReactions--;
    cancel?.();
    unlink(r);
  };
}

/** A value derived from other signals. */
export function computed<T>(fn: () => T, equals: (a: T, b: T) => boolean = Object.is): ReadSignal<T> {
  const out = signal<T>(undefined as T, equals);
  effect(() => {
    out.set(fn());
  });
  const read = (() => out()) as ReadSignal<T>;
  Object.defineProperty(read, "peek", { value: () => out.peek() });
  return read;
}

/** Register teardown for the current effect run. */
export function onCleanup(fn: Cleanup): void {
  ACTIVE?.cleanups.push(fn);
}

/** Read without subscribing. */
export function untrack<T>(fn: () => T): T {
  const prev = ACTIVE;
  ACTIVE = null;
  try {
    return fn();
  } finally {
    ACTIVE = prev;
  }
}

/** Coalesce many writes into a single flush. */
export function batch<T>(fn: () => T): T {
  BATCH_DEPTH++;
  try {
    return fn();
  } finally {
    BATCH_DEPTH--;
    if (BATCH_DEPTH === 0) flush();
  }
}

/**
 * A writable boolean view of a signal that holds something else.
 *
 * WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL
 * The obvious shortcut is `{ ...other, peek, set }`. It type-checks through a
 * cast and fails at runtime, because a `Signal` IS a function with properties
 * hung off it and object spread copies the properties without the callable. The
 * result is a value that satisfies `Signal<boolean>` everywhere the compiler
 * looks and throws "is not a function" the first time anything reads it.
 *
 * So the adapter starts as a real function and gets its members attached. It
 * holds no state: every read and write goes through the signal underneath, so
 * the two can never drift apart the way a mirrored copy would.
 */
export function booleanView<T>(
  source: Signal<T>,
  isTrue: (value: T) => boolean,
  toValue: (on: boolean) => T,
): Signal<boolean> {
  const view = (() => isTrue(source())) as Signal<boolean>;
  Object.defineProperties(view, {
    peek: { value: () => isTrue(source.peek()) },
    set: { value: (on: boolean) => source.set(toValue(on)) },
    update: { value: (fn: (prev: boolean) => boolean) => source.set(toValue(fn(isTrue(source.peek())))) },
  });
  return view;
}
