/**
 * The shell's shared foundation, as a declared contract.
 *
 * WHY THIS EXISTS — MEASURED, NOT ASSUMED
 * `mountShell` is one closure holding 237 top-level declarations, 99 of which
 * are read by three or more of its sections. `chart` is used by seventeen and
 * declared at line 1,023; `bars` by thirteen, declared at 855. Nothing states
 * that, nothing checks it, and the only way to discover what a section needs is
 * to read all seven thousand lines around it.
 *
 * That is why every attempt to break the file up stalled. Lifting a section out
 * meant inventing a twenty-argument options object, which relocates the coupling
 * into a signature instead of removing it — and the next section needs a
 * different twenty.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LINE THIS DRAWS, AND WHY IT IS THE RIGHT ONE
 *
 * A section depends on two different KINDS of thing, and conflating them is what
 * made the options objects unreadable:
 *
 *   THE FOUNDATION — the store, the preferences, the reactive state, the feed,
 *   the toaster, the desk memoiser. Available before any section is built, needed
 *   by nearly all of them, and stable. That is this interface.
 *
 *   ITS SIBLINGS — what one section needs from another: the chart's bar signal,
 *   the detector output, the risk desk's positions. Specific, small, and
 *   different for every section. Those stay explicit parameters, because naming
 *   them is the documentation of what actually couples to what.
 *
 * So a section reads `createDecisionSection(ctx, { bars, detections, … })`: the
 * foundation arrives as one object, and the four things it genuinely borrows
 * from its neighbours are listed where a reader can see them. The second list
 * being SHORT is the test of whether the split was worth making — thirteen for
 * the decision section, of which nine are siblings.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 *
 * Not a service locator, and not a place to put things to avoid an argument.
 * Everything here was already shared by most of the shell before it moved; the
 * moment something is added that only two sections want, it belongs in their
 * parameter lists instead. A context that grows to ninety-nine members is the
 * original closure with extra steps.
 */

import { signal } from "../../core/signal";
import type { KV } from "../../store/kv";
import type { AccountStore } from "../../core/account";
import type { FeedHandle } from "../../data/feed";
import type { Toaster } from "../toast";
import type { CommandRegistry } from "../../core/commands";
import type { Keymap } from "../../core/keys";
import type { PrefValue } from "./prefs";
import type { ShellState } from "./state";

/**
 * A desk built the first time it is opened, and never before.
 *
 * WHY A THUNK AND NOT AN EAGER CONSTRUCTION
 * Building nineteen desks at boot costs a boot; more importantly it forces a
 * declaration ORDER on the file, because a desk constructed at line 1,600 can
 * only read consts declared above it. A thunk is not evaluated until the view is
 * opened, by which point every binding in the closure is initialised — so the
 * ordering constraint stops being something a comment has to defend.
 */
export interface LazyDesk<T> {
  (): T;
  /**
   * Whether it has ever been opened.
   *
   * Needed because some effects act on desks rather than reading them —
   * "leaving the screener cancels its scan", "leaving Flow stops its stream".
   * Calling those through the thunk would CONSTRUCT the desk in order to tell
   * it to stop, on every view change, which is the precise opposite of the
   * point. Cancelling a scan on a desk that was never built is a no-op by
   * definition, so the probe lets the effect skip it.
   */
  built(): boolean;
}

/**
 * Wrap a builder so it runs at most once, on first use.
 *
 * `exists` is a SIGNAL and it has to be. A plain boolean is read once by a
 * guarded effect and never again, so an effect that skipped a desk at boot
 * would keep skipping it after the operator opened it. MEASURED: the
 * correlation matrix guarded on a plain `built()` stayed null for a whole
 * session because nothing ever re-ran it. A signal makes "this desk now exists"
 * an ordinary dependency.
 */
export function lazyDesk<T>(build: () => T): LazyDesk<T> {
  let made: T | undefined;
  const exists = signal(false);
  const get = (): T => {
    if (made === undefined) {
      made = build();
      exists.set(true);
    }
    return made;
  };
  (get as LazyDesk<T>).built = () => exists();
  return get as LazyDesk<T>;
}

/** The foundation every section may assume. */
export interface ShellContext {
  /** Versioned storage. Every persisted slot goes through it. */
  readonly kv: KV;
  /** The preferences snapshot read at boot. */
  readonly prefs: Record<string, PrefValue>;
  /** One account, one owner — see the equity defect in `core/account.ts`. */
  readonly account: AccountStore;
  /** Every reactive value the chrome and the desks share. */
  readonly state: ShellState;
  /** Bars, streams and the archive. */
  readonly feed: FeedHandle;
  /** The only way to interrupt the operator. */
  readonly toaster: Toaster;
  /**
   * The command registry and the keymap.
   *
   * Foundation because they take no arguments and almost everything reaches for
   * them — and because putting them here is what makes a section's OWN
   * dependency list honest: the workspace section needs `commands`, `keymap` and
   * `feed`, all three of which are foundation, so once they live here its
   * sibling list is empty. A section with no siblings is one that can be read on
   * its own, which is the entire objective.
   */
  readonly commands: CommandRegistry;
  readonly keymap: Keymap;
  /** Build-on-first-open, for desks and anything else expensive. */
  readonly lazyDesk: typeof lazyDesk;
}

/**
 * Assemble the context.
 *
 * Takes what it cannot build itself. Deliberately not a constructor that reaches
 * for globals: a context that fetches its own dependencies cannot be built twice,
 * which makes every section that takes one untestable.
 */
export function createShellContext(parts: Omit<ShellContext, "lazyDesk">): ShellContext {
  return { ...parts, lazyDesk };
}
