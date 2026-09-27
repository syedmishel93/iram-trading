import { describe, it, expect, vi } from "vitest";
import { signal, computed, effect, batch, reactionCount, untrack, booleanView } from "../src/core/signal";

const tick = (): Promise<void> => new Promise<void>((r) => queueMicrotask(r));

describe("signal", () => {
  it("runs an effect once on creation and again on change", async () => {
    const s = signal(1);
    const seen: number[] = [];
    effect(() => seen.push(s()));

    expect(seen).toEqual([1]);
    s.set(2);
    await tick();
    expect(seen).toEqual([1, 2]);
  });

  it("does NOT re-run when the value is unchanged", async () => {
    // The guard that stops a feed republishing an identical price from
    // repainting the UI — the largest source of wasted frames in v39.
    const s = signal(5);
    const spy = vi.fn(() => {
      s();
    });
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);

    s.set(5);
    s.set(5);
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of writes into one effect run", async () => {
    const s = signal(0);
    const spy = vi.fn(() => {
      s();
    });
    effect(spy);

    for (let i = 1; i <= 20; i++) s.set(i);
    await tick();

    expect(spy).toHaveBeenCalledTimes(2); // initial + one coalesced flush
  });

  it("peek reads without subscribing", async () => {
    const s = signal(1);
    const spy = vi.fn(() => {
      s.peek();
    });
    effect(spy);
    s.set(9);
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("untrack reads without subscribing", async () => {
    const a = signal(1);
    const b = signal(1);
    const spy = vi.fn(() => {
      a();
      untrack(() => b());
    });
    effect(spy);

    b.set(2);
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);

    a.set(2);
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("dependency tracking", () => {
  it("drops dependencies that a re-run no longer reads", async () => {
    // Without unlinking, a branch that stopped being read keeps waking the
    // effect for ever — a slow leak that only shows up as mystery repaints.
    const on = signal(true);
    const a = signal("a");
    const b = signal("b");
    const spy = vi.fn(() => (on() ? a() : b()));
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);

    on.set(false);
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);

    a.set("a2"); // no longer a dependency
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);

    b.set("b2");
    await tick();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("stops notifying after dispose", async () => {
    const s = signal(0);
    const spy = vi.fn(() => {
      s();
    });
    const dispose = effect(spy);
    dispose();
    s.set(1);
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runs cleanups between runs", async () => {
    const s = signal(0);
    const cleanup = vi.fn();
    effect(() => {
      s();
      return cleanup;
    });
    s.set(1);
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("resilience", () => {
  it("a throwing effect does not take the scheduler down with it", async () => {
    // v39 lost a whole timer loop to one throwing job. Isolation is the fix.
    const bad = signal(0);
    const good = signal(0);
    const goodSpy = vi.fn(() => {
      good();
    });

    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    effect(() => {
      bad();
      throw new Error("boom");
    });
    effect(goodSpy);

    bad.set(1);
    good.set(1);
    await tick();

    expect(goodSpy).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

describe("computed and batch", () => {
  it("derives a value and updates it", async () => {
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a() + b());
    expect(sum()).toBe(5);

    a.set(10);
    await tick();
    expect(sum()).toBe(13);
  });

  it("batch defers the flush to the end of the block", () => {
    const s = signal(0);
    const spy = vi.fn(() => {
      s();
    });
    effect(spy);

    batch(() => {
      s.set(1);
      s.set(2);
      s.set(3);
      expect(spy).toHaveBeenCalledTimes(1); // nothing flushed yet
    });

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/**
 * The live-reaction counter.
 *
 * It exists to answer "is this subscription still running", which is otherwise
 * unanswerable from outside: a desk built at boot and never opened is detached
 * DOM, invisible in the element tree, and fully subscribed. Measured on the
 * chart view, 994 live reactions against 1,452 nodes — most of them belonging
 * to desks nobody had opened.
 *
 * A counter that drifts is worse than none, because the number still looks
 * authoritative, so what is pinned here is the arithmetic rather than any
 * particular total.
 */
describe("reactionCount", () => {
  it("rises with each effect and falls when it is disposed", () => {
    const before = reactionCount();
    const a = effect(() => {});
    const b = effect(() => {});
    expect(reactionCount()).toBe(before + 2);
    a();
    expect(reactionCount()).toBe(before + 1);
    b();
    expect(reactionCount()).toBe(before);
  });

  it("does not double-count a disposer called twice", () => {
    /* Disposers get called from cleanup paths that can overlap. Without the
       guard the count would drift negative and quietly stop meaning anything. */
    const before = reactionCount();
    const dispose = effect(() => {});
    dispose();
    dispose();
    dispose();
    expect(reactionCount()).toBe(before);
  });

  it("counts the effect a computed creates", () => {
    const before = reactionCount();
    const s = signal(1);
    computed(() => s() * 2);
    expect(reactionCount()).toBeGreaterThan(before);
  });

  it("does not leak when an effect throws", async () => {
    /* A throwing effect is swallowed by design so one bad job cannot take the
       scheduler down. It must still be counted and still be disposable. */
    const before = reactionCount();
    const dispose = effect(() => {
      throw new Error("boom");
    });
    expect(reactionCount()).toBe(before + 1);
    dispose();
    expect(reactionCount()).toBe(before);
  });
});

/**
 * `booleanView`.
 *
 * The bug it exists to prevent type-checks perfectly: `{ ...someSignal, peek,
 * set }` satisfies `Signal<boolean>` after a cast through `unknown`, and throws
 * "is not a function" the first time anything calls it — because a signal is a
 * FUNCTION with properties, and object spread copies the properties only.
 */
describe("booleanView", () => {
  const scale = () => signal<"linear" | "log">("linear");
  const view = (s: ReturnType<typeof scale>) =>
    booleanView(s, (v) => v === "log", (on) => (on ? "log" : "linear"));

  it("is callable — the whole reason it is not an object literal", () => {
    const s = scale();
    const v = view(s);
    expect(typeof v).toBe("function");
    expect(v()).toBe(false);
    s.set("log");
    expect(v()).toBe(true);
  });

  it("peeks without subscribing", () => {
    const s = scale();
    const v = view(s);
    expect(v.peek()).toBe(false);
    s.set("log");
    expect(v.peek()).toBe(true);
  });

  it("writes through to the source, in the source's own vocabulary", () => {
    const s = scale();
    const v = view(s);
    v.set(true);
    expect(s.peek()).toBe("log");
    v.set(false);
    expect(s.peek()).toBe("linear");
  });

  it("updates from the current value", () => {
    const s = scale();
    const v = view(s);
    v.update((on) => !on);
    expect(s.peek()).toBe("log");
    v.update((on) => !on);
    expect(s.peek()).toBe("linear");
  });

  it("holds no state of its own — a change at the source is visible at once", () => {
    // A mirrored copy would need syncing and could drift; this cannot.
    const s = scale();
    const v = view(s);
    s.set("log");
    expect(v()).toBe(true);
    expect(v.peek()).toBe(true);
  });

  it("is reactive, so a checkmark bound to it repaints", async () => {
    const s = scale();
    const v = view(s);
    const seen: boolean[] = [];
    effect(() => seen.push(v()));
    expect(seen).toEqual([false]);

    /* Awaited between writes: effects are scheduled, and a burst coalesces into
       one run — so setting both in a row would prove nothing about the second. */
    s.set("log");
    await tick();
    s.set("linear");
    await tick();
    expect(seen).toEqual([false, true, false]);
  });
});

/**
 * A `computed` IS EAGER, AND THAT DECIDES WHERE IT CAN BE WRITTEN.
 *
 * `computed(fn)` is `effect(() => out.set(fn()))`, and an effect runs
 * immediately. So a computed placed ABOVE a `const` its body names throws a
 * temporal-dead-zone ReferenceError at construction — and `effect` catches and
 * logs, so the computed then holds `undefined` for the life of the page while
 * everything around it looks normal.
 *
 * MEASURED in `ui/playbook.ts`: two computeds sat above the two they read.
 * Console said `[signal] effect threw {ReferenceError: Cannot access 'N' before
 * initialization}`, `combined()` was undefined, a second computed threw again
 * on `"spec" in undefined`, and `run()` — which opens `const spec =
 * effective(); if (!spec) return;` — returned before its first line of work.
 * THE RUN BUTTON DID NOTHING: no note, no visible error, zero DOM mutations.
 * `tsc` cannot see it; TypeScript allows a closure to name a binding declared
 * later, because normally the closure runs later too.
 *
 * These pin the property so the constraint is written down somewhere that
 * fails when it changes, rather than only in a comment.
 */
describe("a computed evaluates immediately", () => {
  it("runs its body once at construction, before anyone reads it", () => {
    let runs = 0;
    const a = signal(2);
    computed(() => {
      runs += 1;
      return a() * 2;
    });
    // Not "0 until read". If this ever becomes lazy, the ordering rule above
    // stops applying and the comments that cite it become wrong.
    expect(runs).toBe(1);
  });

  it("holds undefined forever when its first run throws", () => {
    // The mechanism exactly: the throw is swallowed by the effect, so the
    // computed reads as undefined and nothing downstream is told why.
    const bad = computed<number>(() => {
      throw new ReferenceError("Cannot access 'later' before initialization");
    });
    expect(bad()).toBeUndefined();
    // And it does not recover on a later read either.
    expect(bad()).toBeUndefined();
  });
});
