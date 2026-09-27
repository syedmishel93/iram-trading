/**
 * Saved scripts, and the one that is currently on the chart.
 *
 * WHY SCRIPTS ARE STORED SEPARATELY FROM PREFERENCES
 * A preference is a number the operator chose; a script is code they wrote, and
 * losing it is losing work rather than a setting. It gets its own KV slot with
 * its own version so a preferences migration can never take the scripts with
 * it, and so `workspace` export carries them as a first-class thing rather than
 * as a field inside a blob about dock widths.
 *
 * WHAT IS NOT STORED
 * Results. A script's output is a function of the script and the bars, both of
 * which are already kept, and a cached line would be the one thing on the chart
 * that could disagree with the code that claims to have produced it.
 */

import { signal, type Signal } from "../core/signal";
import type { KV, Slot } from "../store/kv";

export interface UserScript {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  /** Numeric inputs the script reads from `params`. */
  readonly params: Readonly<Record<string, number>>;
  /** Epoch ms of the last edit. */
  readonly at: number;
}

export const SCRIPTS_SLOT: Slot<UserScript[]> = {
  key: "scripts",
  version: 1,
  fallback: () => [],
  validate(raw: unknown): UserScript[] | null {
    if (!Array.isArray(raw)) return null;
    const out: UserScript[] = [];
    for (const entry of raw) {
      const s = entry as Record<string, unknown>;
      if (typeof s["id"] !== "string" || typeof s["source"] !== "string") continue;
      out.push({
        id: s["id"],
        name: typeof s["name"] === "string" ? s["name"] : "Untitled",
        source: s["source"],
        params:
          typeof s["params"] === "object" && s["params"] !== null
            ? (s["params"] as Record<string, number>)
            : {},
        at: typeof s["at"] === "number" ? s["at"] : 0,
      });
    }
    return out;
  },
};

/**
 * The example that opens the editor on a fresh install.
 *
 * Deliberately something the built-ins do NOT already do, so the first thing
 * anyone sees is a reason for the feature to exist rather than a worse RSI.
 * It is also short enough to read in one go, which a starting template has to
 * be — a forty-line example is a wall, not an invitation.
 */
export const STARTER = `// Rolling percentile rank of close within its own window.
// Not one of the built-ins: it answers "is this high FOR THIS MARKET",
// which a fixed 0-100 oscillator cannot.

const win = params.window ?? 100;
const out = new Array(bars.c.length).fill(helpers.nan);

for (let i = win; i < bars.c.length; i++) {
  let below = 0;
  for (let j = i - win; j < i; j++) if (bars.c[j] < bars.c[i]) below++;
  out[i] = (below / win) * 100;
}

// One line, or several: return [{ id: "pct", values: out }] to name it.
return out;
`;

export interface ScriptStore {
  readonly scripts: Signal<readonly UserScript[]>;
  /** Ids currently drawn on the chart. */
  readonly active: Signal<readonly string[]>;
  save(script: UserScript): void;
  remove(id: string): void;
  toggle(id: string, on: boolean): void;
  get(id: string): UserScript | undefined;
}

export function createScriptStore(kv: KV): ScriptStore {
  const report = kv.read(SCRIPTS_SLOT);
  const initial =
    report.outcome === "hit" || report.outcome === "migrated" ? report.value : [];

  const scripts = signal<readonly UserScript[]>(initial);
  const active = signal<readonly string[]>([], (a, b) => a.length === b.length && a.every((v, i) => v === b[i]));

  const persist = (): void => {
    kv.write(SCRIPTS_SLOT, [...scripts.peek()]);
  };

  return {
    scripts,
    active,
    get: (id) => scripts.peek().find((s) => s.id === id),
    save(script) {
      const list = [...scripts.peek()];
      const at = list.findIndex((s) => s.id === script.id);
      if (at >= 0) list[at] = script;
      else list.push(script);
      scripts.set(list);
      persist();
    },
    remove(id) {
      scripts.set(scripts.peek().filter((s) => s.id !== id));
      active.set(active.peek().filter((x) => x !== id));
      persist();
    },
    toggle(id, on) {
      const current = active.peek();
      if (on === current.includes(id)) return;
      active.set(on ? [...current, id] : current.filter((x) => x !== id));
    },
  };
}
