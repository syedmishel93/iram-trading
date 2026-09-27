/**
 * The drawing book: persistence, undo, and nothing else.
 *
 * UNDO IS A STACK OF SNAPSHOTS, and it is allowed to be because the model is
 * immutable. Every edit already produces a new `Drawing` and a new array, so a
 * "snapshot" is a copy of an array of pointers — a few hundred bytes for a
 * chart full of drawings. The alternative, a command log with an inverse for
 * every operation, is where undo bugs live: each new operation needs its own
 * correct inverse, and the one nobody wrote is the one that corrupts the book.
 *
 * WHY DRAG DOES NOT PUSH A HUNDRED UNDO STEPS
 * A pointer drag emits an edit per frame. Pushed naively, one drag of a
 * trendline buries the undo stack under sixty identical-looking states and Ctrl+Z
 * becomes useless. So `begin()`/`commit()` bracket an interaction: the snapshot
 * is taken once at the start, and the frames in between mutate freely.
 */

import { signal, type Signal } from "../core/signal";
import { listSlot, type KV } from "../store/kv";
import { sanitizeDrawing, visibleOn, type Drawing } from "./model";

/** Undo depth. Deep enough to recover a session's work, bounded so it cannot grow. */
export const UNDO_DEPTH = 60;

const DRAWINGS_SLOT = listSlot<Drawing>(
  "drawings.book",
  1,
  /* The slot validates each entry through the same sanitiser the vault and sync
     paths use, so a drawing that arrived from another machine gets exactly the
     same scrutiny as one loaded from disk. */
  (v: unknown): v is Drawing => sanitizeDrawing(v) !== null,
);

export interface DrawingStore {
  readonly all: Signal<readonly Drawing[]>;
  /** Drawings that apply to one chart. */
  visible(symbol: string, timeframe: string): Drawing[];
  add(drawing: Drawing): void;
  update(id: string, next: Drawing): void;
  remove(id: string): void;
  /** Remove every drawing on one chart. Undoable, like any other edit. */
  clearChart(symbol: string, timeframe: string): void;
  /** Open an interaction: one undo entry covers everything until commit. */
  begin(): void;
  commit(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  readonly revision: Signal<number>;
}

export function createDrawingStore(kv: KV): DrawingStore {
  const report = kv.read(DRAWINGS_SLOT);
  if (report.outcome === "quarantined" || report.outcome === "refused-newer") {
    console.warn(`[iram] drawings — ${report.note}`);
  }

  const all = signal<readonly Drawing[]>(report.value);
  /* Bumped on every change, so a renderer can depend on "something moved"
     without diffing an array of objects it did not create. */
  const revision = signal(0);

  const undoStack: (readonly Drawing[])[] = [];
  const redoStack: (readonly Drawing[])[] = [];
  let batchDepth = 0;

  const persist = (): void => {
    const res = kv.write(DRAWINGS_SLOT, [...all.peek()]);
    if (!res.ok) console.warn(`[iram] drawings not saved — ${res.error}`);
  };

  const snapshot = (): void => {
    /* Inside a batch the snapshot was already taken at begin(); taking another
       per frame is exactly the bug this guard exists to prevent. */
    if (batchDepth > 0) return;
    undoStack.push(all.peek());
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    /* Any new edit invalidates the redo branch — the future you could have had
       is not the future you are in. */
    redoStack.length = 0;
  };

  const commitValue = (next: readonly Drawing[]): void => {
    all.set(next);
    revision.update((n) => n + 1);
    persist();
  };

  const store: DrawingStore = {
    all,
    revision,

    visible: (symbol, timeframe) => visibleOn(all(), symbol, timeframe),

    add(drawing) {
      snapshot();
      commitValue([...all.peek(), drawing]);
    },

    update(id, next) {
      const current = all.peek();
      const at = current.findIndex((d) => d.id === id);
      if (at < 0) return;
      if (current[at] === next) return;
      snapshot();
      const copy = current.slice();
      copy[at] = next;
      commitValue(copy);
    },

    remove(id) {
      const current = all.peek();
      if (!current.some((d) => d.id === id)) return;
      snapshot();
      commitValue(current.filter((d) => d.id !== id));
    },

    clearChart(symbol, timeframe) {
      const current = all.peek();
      const doomed = new Set(visibleOn(current, symbol, timeframe).map((d) => d.id));
      if (doomed.size === 0) return;
      snapshot();
      commitValue(current.filter((d) => !doomed.has(d.id)));
    },

    begin() {
      if (batchDepth === 0) snapshot();
      batchDepth++;
    },

    commit() {
      if (batchDepth > 0) batchDepth--;
    },

    undo() {
      const prev = undoStack.pop();
      if (prev === undefined) return false;
      redoStack.push(all.peek());
      commitValue(prev);
      return true;
    },

    redo() {
      const next = redoStack.pop();
      if (next === undefined) return false;
      undoStack.push(all.peek());
      commitValue(next);
      return true;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };

  return store;
}
