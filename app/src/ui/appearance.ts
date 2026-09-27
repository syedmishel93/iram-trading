/**
 * The appearance preferences that are NOTHING BUT A TOKEN.
 *
 * Six choices — card radius, shell gutter, inspector width, live-bar height,
 * chart grid style and wick weight — each of which re-points exactly one role
 * in `styles/tokens.css` through one attribute on `:root`. That is the shape
 * `data-accent` established in v55.0, and it is why these cost nothing until
 * somebody touches them: THE DEFAULT SETS NO ATTRIBUTE AT ALL, so an upgrade
 * cannot change anybody's terminal.
 *
 * WHY THIS OWNS ITS OWN SLOT, AND NOT `shell.prefs` — A NAMED DEVIATION.
 * Every other shell preference is written by one effect inside `mountShell`,
 * which snapshots ~30 signals into `PREFS_SLOT` on every change. Adding to it
 * means editing `ui/shell.ts`, which this change may not touch. Rather than
 * leave six controls wired to nothing, they are owned here, with the SAME
 * machinery the shell uses: a versioned `store/kv.ts` slot, validated on read,
 * quarantined rather than reset on corruption. `setup/rules.ts` (RULES_SLOT)
 * and `data/backend.ts` are the standing precedents for a preference whose
 * owner is a module rather than the shell — the guarantee is identical and the
 * blob stays small. Folding the six into `shell.prefs` later is a rename of
 * the storage key and nothing else; no consumer reads the slot directly.
 *
 * WHAT IS NOT HERE. The grid's OFF state is `state.gridOn` in the shell — the
 * signal the chart engine already reads — so the Settings control writes both
 * and this module never holds a second copy of it. One fact, one owner.
 */

import { effect, signal, type Signal } from "../core/signal";
import { browserRawStore, createKV, type KV } from "../store/kv";

export interface KnobOption {
  readonly value: string;
  readonly label: string;
}

/**
 * One knob: the attribute it writes, its choices, and the choice that writes
 * NOTHING.
 *
 * `fallback` is load-bearing twice over. It is the value a corrupt or unknown
 * stored string is replaced by, and it is the value at which the attribute is
 * REMOVED rather than set — so "today's look" is the absence of a rule, not a
 * rule that happens to repeat the default. A default expressed as a rule is a
 * default that can silently disagree with the token it copies.
 */
export interface Knob {
  readonly id: KnobId;
  readonly attribute: string;
  readonly fallback: string;
  readonly options: readonly KnobOption[];
}

export type KnobId = "radius" | "gutter" | "dock" | "livebar" | "grid" | "wick";

export const KNOBS: readonly Knob[] = [
  {
    id: "radius",
    attribute: "data-radius",
    fallback: "soft",
    options: [
      { value: "square", label: "Square" },
      { value: "soft", label: "Soft" },
      { value: "round", label: "Round" },
    ],
  },
  {
    id: "gutter",
    attribute: "data-gutter",
    fallback: "standard",
    options: [
      { value: "tight", label: "Tight" },
      { value: "standard", label: "Standard" },
      { value: "airy", label: "Airy" },
    ],
  },
  {
    id: "dock",
    attribute: "data-dock-size",
    fallback: "standard",
    options: [
      { value: "narrow", label: "Narrow" },
      { value: "standard", label: "Standard" },
      { value: "wide", label: "Wide" },
    ],
  },
  {
    id: "livebar",
    attribute: "data-livebar",
    fallback: "standard",
    options: [
      { value: "slim", label: "Slim" },
      { value: "standard", label: "Standard" },
      { value: "tall", label: "Tall" },
    ],
  },
  {
    id: "grid",
    attribute: "data-grid",
    fallback: "lines",
    options: [
      { value: "lines", label: "Lines" },
      { value: "dots", label: "Dots" },
    ],
  },
  {
    id: "wick",
    attribute: "data-wick",
    fallback: "hairline",
    options: [
      { value: "hairline", label: "Hairline" },
      { value: "medium", label: "Medium" },
      { value: "heavy", label: "Heavy" },
    ],
  },
];

export const APPEARANCE_SLOT = {
  key: "shell.appearance",
  version: 1,
  fallback: (): Record<string, string> => ({}),
  validate: (v: unknown): Record<string, string> | null => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const knob of KNOBS) {
      const raw = (v as Record<string, unknown>)[knob.id];
      /* An unknown string is dropped, not kept: it would set an attribute no
         rule matches, which looks exactly like the default and then survives
         every future read as a value nothing can explain. */
      if (typeof raw === "string" && knob.options.some((o) => o.value === raw)) out[knob.id] = raw;
    }
    return out;
  },
};

export interface AppearanceStore {
  readonly radius: Signal<string>;
  readonly gutter: Signal<string>;
  readonly dock: Signal<string>;
  readonly liveBar: Signal<string>;
  readonly grid: Signal<string>;
  readonly wick: Signal<string>;
}

export function knob(id: KnobId): Knob {
  const found = KNOBS.find((k) => k.id === id);
  /* Not a runtime possibility — KnobId is derived from this list — but the
     compiler cannot see that through `find`, and a `!` here would be the
     hand-written narrowing this repository has been bitten by three times. */
  if (!found) throw new Error(`unknown appearance knob ${id}`);
  return found;
}

/** The stored value if it is one of the choices, else the one that sets nothing. */
export function sanitiseKnob(id: KnobId, raw: unknown): string {
  const k = knob(id);
  return typeof raw === "string" && k.options.some((o) => o.value === raw) ? raw : k.fallback;
}

/**
 * Build the store over a KV and a document root.
 *
 * `root` is nullable on purpose: `buildSettings` is enumerated by tests that
 * run without a DOM, and a module that throws at import time in that
 * environment is a module nothing can test.
 */
export function createAppearance(kv: KV, root: HTMLElement | null): AppearanceStore {
  const saved = kv.read(APPEARANCE_SLOT).value;
  const make = (id: KnobId): Signal<string> => signal<string>(sanitiseKnob(id, saved[id]));

  const store: AppearanceStore = {
    radius: make("radius"),
    gutter: make("gutter"),
    dock: make("dock"),
    liveBar: make("livebar"),
    grid: make("grid"),
    wick: make("wick"),
  };

  const reads: ReadonlyArray<readonly [KnobId, Signal<string>]> = [
    ["radius", store.radius],
    ["gutter", store.gutter],
    ["dock", store.dock],
    ["livebar", store.liveBar],
    ["grid", store.grid],
    ["wick", store.wick],
  ];

  if (root) {
    for (const [id, sig] of reads) {
      const k = knob(id);
      effect(() => {
        const v = sig();
        if (v === k.fallback) root.removeAttribute(k.attribute);
        else root.setAttribute(k.attribute, v);
      });
    }
  }

  effect(() => {
    const snapshot: Record<string, string> = {};
    for (const [id, sig] of reads) snapshot[id] = sig();
    const res = kv.write(APPEARANCE_SLOT, snapshot);
    if (!res.ok) console.warn(`[iram] appearance not saved — ${res.error}`);
  });

  return store;
}

let shared: AppearanceStore | null = null;

/**
 * The one store the terminal uses.
 *
 * Lazy, because the module is imported by `settings/defs.ts` which is itself
 * enumerated in a DOM-less test. Nothing is read from storage until a setting
 * is actually built.
 */
export function appearance(): AppearanceStore {
  if (!shared) {
    shared = createAppearance(
      createKV(browserRawStore()),
      typeof document === "undefined" ? null : document.documentElement,
    );
  }
  return shared;
}
