/**
 * Saved views — a named sort + filter set you can come back to.
 *
 * WHY THIS IS THE PART THAT MATTERS
 * Sorting and filtering make a table usable once. Saving the arrangement is
 * what turns it into a workflow: "majors, confidence over 0.5, ranked by score"
 * is a question you ask every morning, and rebuilding it by hand every morning
 * is why people give up and go back to a spreadsheet.
 *
 * WHAT IT DELIBERATELY DOES NOT STORE
 * Rows. A view is a QUESTION, not an answer — it holds the sort keys and the
 * filter expressions and nothing else, so opening it re-asks the question of
 * whatever data is current. A view that cached results would show you yesterday
 * s market under today's name, which is exactly the class of quiet lie this
 * terminal is built to avoid.
 */

import { signal, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import type { SortKey } from "./table";

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly sort: readonly SortKey[];
  readonly filters: Readonly<Record<string, string>>;
}

/** What a view captures, before it is named. */
export interface ViewConfig {
  readonly sort: readonly SortKey[];
  readonly filters: Readonly<Record<string, string>>;
}

export interface ViewStore {
  readonly views: Signal<readonly SavedView[]>;
  /** Save under a name, replacing a view of the same name. Returns its id. */
  save(name: string, config: ViewConfig): string;
  remove(id: string): void;
  rename(id: string, name: string): void;
  get(id: string): SavedView | undefined;
}

/** Whitespace-insensitive, case-insensitive — "Majors" and "majors " are one view. */
const normaliseName = (raw: string): string => raw.trim().replace(/\s+/g, " ");
const sameName = (a: string, b: string): boolean =>
  normaliseName(a).toLowerCase() === normaliseName(b).toLowerCase();

let seq = 0;
export function viewId(now: number): string {
  seq += 1;
  return `vw_${now.toString(36)}_${seq.toString(36)}`;
}

/** Filters with an empty expression are noise; a saved view keeps only real ones. */
export function compactFilters(
  filters: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

/** A view with neither a sort nor a filter is not a view. */
export function isEmptyConfig(config: ViewConfig): boolean {
  return config.sort.length === 0 && Object.keys(compactFilters(config.filters)).length === 0;
}

function slot(key: string) {
  return {
    key,
    version: 1,
    fallback: (): SavedView[] => [],
    validate: (v: unknown): SavedView[] | null => {
      if (!Array.isArray(v)) return null;
      const out: SavedView[] = [];
      for (const raw of v) {
        if (raw === null || typeof raw !== "object") continue;
        const o = raw as Record<string, unknown>;
        if (typeof o["id"] !== "string" || typeof o["name"] !== "string") continue;

        /* Old or hand-edited data is untrusted: a sort key naming a column that
           no longer exists is dropped rather than carried, because `applySort`
           would silently ignore it and the view would claim an order it does
           not have. */
        const sort: SortKey[] = Array.isArray(o["sort"])
          ? (o["sort"] as unknown[]).flatMap((k) => {
              if (k === null || typeof k !== "object") return [];
              const e = k as Record<string, unknown>;
              if (typeof e["column"] !== "string") return [];
              const dir = e["dir"] === "asc" ? "asc" : "desc";
              return [{ column: e["column"], dir } as SortKey];
            })
          : [];

        const filters: Record<string, string> = {};
        const f = o["filters"];
        if (f !== null && typeof f === "object") {
          for (const [k, val] of Object.entries(f as Record<string, unknown>)) {
            if (typeof val === "string") filters[k] = val;
          }
        }

        out.push({ id: o["id"], name: o["name"], sort, filters });
      }
      return out;
    },
  };
}

export function createViewStore(kv: KV, key: string, now: () => number = Date.now): ViewStore {
  const SLOT = slot(key);
  const views = signal<readonly SavedView[]>(kv.read(SLOT).value);

  const persist = (next: readonly SavedView[]): void => {
    views.set(next);
    kv.write(SLOT, [...next]);
  };

  return {
    views,
    save(name, config) {
      const clean = normaliseName(name);
      const existing = views.peek().find((v) => sameName(v.name, clean));
      const id = existing?.id ?? viewId(now());
      const view: SavedView = {
        id,
        name: clean,
        sort: [...config.sort],
        filters: compactFilters(config.filters),
      };
      /* Replace in place so re-saving a view keeps its position in the tab
         strip — a view that jumped to the end every time you adjusted it would
         make the strip unlearnable. */
      persist(
        existing
          ? views.peek().map((v) => (v.id === id ? view : v))
          : [...views.peek(), view],
      );
      return id;
    },
    remove(id) {
      persist(views.peek().filter((v) => v.id !== id));
    },
    rename(id, name) {
      const clean = normaliseName(name);
      if (clean === "") return;
      persist(views.peek().map((v) => (v.id === id ? { ...v, name: clean } : v)));
    },
    get(id) {
      return views.peek().find((v) => v.id === id);
    },
  };
}

/**
 * Is the live arrangement the same question this view asks?
 *
 * Drives the "unsaved changes" mark on the active tab. Compared by VALUE, and
 * order matters for sort keys — "score then spread" is a different question
 * from "spread then score".
 */
export function configMatches(view: SavedView, config: ViewConfig): boolean {
  if (view.sort.length !== config.sort.length) return false;
  for (let i = 0; i < view.sort.length; i++) {
    const a = view.sort[i] as SortKey;
    const b = config.sort[i] as SortKey;
    if (a.column !== b.column || a.dir !== b.dir) return false;
  }

  const left = compactFilters(view.filters);
  const right = compactFilters(config.filters);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const k of keys) if (left[k] !== right[k]) return false;
  return true;
}
