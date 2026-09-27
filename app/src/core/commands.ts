/**
 * The command registry.
 *
 * ONE LIST, THREE SURFACES. A command is registered once and then appears in
 * the palette, in the menu bar and in the shortcuts sheet without any of those
 * three knowing anything about the others. That is the whole reason this file
 * exists: in v40 the tab strip, the topbar buttons and the keyboard `switch`
 * each held their own copy of "what the terminal can do", so a new capability
 * had to be added in three places and inevitably was not.
 *
 * WHAT A COMMAND MUST BE ABLE TO SAY
 *  - `when`      — whether it applies right now. A disabled item is better than
 *                  a missing one only when the user can see WHY, so menus grey
 *                  it out and the palette hides it; both read the same gate.
 *  - `checked`   — whether a toggle is currently on. A palette that offers
 *                  "Toggle EMA 200" without telling you which way you are about
 *                  to toggle it is a coin flip.
 *  - `detail`    — the current value, on the right. "Theme" is a command;
 *                  "Theme — institutional" is an answer.
 *  - `danger`    — destructive. Rendered differently and never auto-run.
 *
 * RECENCY, NOT FREQUENCY. The palette promotes what you used LAST, not what you
 * have used MOST: a terminal session has phases, and the thing you reached for
 * a minute ago is far more likely to be next than the thing you reach for every
 * morning. Frequency ranking makes the list feel stuck.
 */

import { rank, type Ranked } from "./fuzzy";

export interface Command {
  /** Stable, dotted, machine-readable: "chart.toggleEma200". Never shown. */
  readonly id: string;
  /** What the user reads. Sentence case, no trailing period. */
  readonly title: string;
  /**
   * The title to use inside a menu, when the surrounding menu already supplies
   * the context that `title` has to carry on its own.
   *
   * These are two different jobs and one string cannot do both. In the command
   * palette every command is loose in a flat list, so the title must be
   * globally unambiguous: "Draw: Trend line", "Chart style: Candles", "Go to
   * Risk". Inside the Draw menu, under the heading Draw, fourteen items each
   * beginning "Draw:" is a column of noise with the distinguishing word pushed
   * to the right — the prefix is doing nothing except making the items harder
   * to scan.
   *
   * So the command owns BOTH names and the menu picks the shorter one. The
   * alternative — overriding the label at each of forty call sites in
   * commandset.ts — puts the text somewhere the command cannot see, which is
   * exactly the drift this registry exists to prevent.
   */
  readonly menuTitle?: string;
  /** Menu/section this belongs to: "Chart", "Data", "Workspace". */
  readonly group: string;
  /** Extra words that should match but are not shown. "ma average trend". */
  readonly keywords?: string;
  /** Current value or state, rendered right-aligned and muted. */
  readonly detail?: () => string;
  /** False hides it from the palette and greys it in menus. */
  readonly when?: () => boolean;
  /** For toggles: is it on? Drives the check mark. */
  readonly checked?: () => boolean;
  /** Destructive. Styled as such; never the default selection. */
  readonly danger?: boolean;
  readonly run: () => void | Promise<void>;
}

export interface CommandRegistry {
  register(...commands: Command[]): () => void;
  get(id: string): Command | undefined;
  all(): readonly Command[];
  /** Available right now — `when` satisfied. */
  available(): readonly Command[];
  /** Run by id. Unknown ids warn rather than throw; a menu must not crash. */
  run(id: string): void;
  /** Ranked matches for the palette. Empty query returns the recency list. */
  search(query: string, limit?: number): Ranked<Command>[];
  /** Ids most recently run, newest first. Persisted by the shell. */
  recent(): readonly string[];
  /** Seed the recency list from storage on boot. */
  seedRecent(ids: readonly string[]): void;
  /** Notified after every run, so the shell can persist recency. */
  onRun(fn: (id: string) => void): () => void;
}

/** How many ids to remember. Long enough to be useful, short to stay relevant. */
const RECENT_MAX = 24;

/**
 * Bonus applied to a recently-run command's score, decaying with position.
 *
 * Sized to reorder near-ties without overriding a clearly better text match:
 * typing "ema200" must still put "Toggle EMA 200" first even if you last ran
 * "Export vault". 90 is under one boundary-match (100), which is the threshold
 * that keeps text relevance dominant.
 */
const RECENCY_BONUS = 90;

export function createCommands(): CommandRegistry {
  const byId = new Map<string, Command>();
  /* Registration order is the natural order for menus, so an array is kept
     alongside the map rather than relying on Map iteration by accident. */
  const order: Command[] = [];
  let recentIds: string[] = [];
  const listeners = new Set<(id: string) => void>();

  const remove = (cmd: Command): void => {
    byId.delete(cmd.id);
    const i = order.indexOf(cmd);
    if (i >= 0) order.splice(i, 1);
  };

  const registry: CommandRegistry = {
    register(...commands) {
      for (const cmd of commands) {
        const existing = byId.get(cmd.id);
        if (existing) {
          /* Silent replacement would make a duplicated id look like the first
             registration simply never happened. */
          console.warn(`[iram] command "${cmd.id}" registered twice — replacing`);
          remove(existing);
        }
        byId.set(cmd.id, cmd);
        order.push(cmd);
      }
      return () => {
        for (const cmd of commands) if (byId.get(cmd.id) === cmd) remove(cmd);
      };
    },

    get(id) {
      return byId.get(id);
    },

    all() {
      return order.slice();
    },

    available() {
      return order.filter((c) => !c.when || c.when());
    },

    run(id) {
      const cmd = byId.get(id);
      if (!cmd) {
        console.warn(`[iram] no command "${id}"`);
        return;
      }
      if (cmd.when && !cmd.when()) return;

      recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, RECENT_MAX);

      /**
       * A command that throws must not take the palette down with it. The
       * failure is reported and the shell stays usable, which matters more here
       * than anywhere else — the palette is how you reach every other feature,
       * including the ones that would let you recover.
       */
      try {
        const result = cmd.run();
        if (result instanceof Promise) {
          result.catch((err: unknown) => console.error(`[iram] command "${id}" failed`, err));
        }
      } catch (err) {
        console.error(`[iram] command "${id}" failed`, err);
      }

      for (const fn of listeners) fn(id);
    },

    search(query, limit = 60) {
      const pool = registry.available();
      const trimmed = query.trim();

      if (trimmed.length === 0) {
        /* Recency first, then registration order for everything else. This is
           the list you see the instant the palette opens, so it must be useful
           without typing — an alphabetical dump is not. */
        const recentSet = new Map(recentIds.map((id, i) => [id, i]));
        const sorted = pool.slice().sort((a, b) => {
          const ra = recentSet.get(a.id);
          const rb = recentSet.get(b.id);
          if (ra !== undefined && rb !== undefined) return ra - rb;
          if (ra !== undefined) return -1;
          if (rb !== undefined) return 1;
          return 0;
        });
        return sorted.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
      }

      const ranked = rank(
        pool,
        trimmed,
        (c) => [`${c.group}: ${c.title}`, c.title, c.keywords ?? "", c.id],
        limit * 2,
      );

      const boosted = ranked.map((r) => {
        const at = recentIds.indexOf(r.item.id);
        if (at < 0) return r;
        /* Linear decay across the list: the most recent gets the full bonus,
           the 24th gets almost none. */
        const bonus = Math.round(RECENCY_BONUS * (1 - at / RECENT_MAX));
        return { ...r, score: r.score + bonus };
      });

      boosted.sort((a, b) => b.score - a.score);
      return boosted.slice(0, limit);
    },

    recent() {
      return recentIds.slice();
    },

    seedRecent(ids) {
      recentIds = ids.filter((id) => typeof id === "string").slice(0, RECENT_MAX);
    },

    onRun(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  return registry;
}

/**
 * Group commands for a menu, preserving registration order inside each group.
 *
 * Menus are curated, not sorted: "Open", "Save", "Export" is the order somebody
 * chose, and alphabetising it into "Export", "Open", "Save" throws that away.
 */
export function groupCommands(commands: readonly Command[]): Map<string, Command[]> {
  const out = new Map<string, Command[]>();
  for (const cmd of commands) {
    const list = out.get(cmd.group);
    if (list) list.push(cmd);
    else out.set(cmd.group, [cmd]);
  }
  return out;
}
