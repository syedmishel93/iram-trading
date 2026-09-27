/**
 * The table primitive — sort, filter, select, copy.
 *
 * THE MEASUREMENT
 * Across the whole of `src/ui` there were ZERO occurrences of any column-sort
 * machinery — no `sortKey`, no `onSort`, no sort-direction state anywhere — and
 * no selection set in the screener, the watchlist or the alerts desk. So the
 * screener scanned a universe and rendered it in whatever order the scan
 * happened to finish, and there was no multi-select anywhere in the terminal.
 *
 * A screener you cannot rank by score is a list.
 *
 * WHY THIS IS LOGIC AND NOT A WIDGET
 * Every desk that needs a table already renders its own rows, some with
 * expandable detail panes and per-row tools. Replacing all of that with one
 * component would be a rewrite of five desks to gain sorting. So this module
 * owns the DECISIONS — what order, what is filtered out, what is selected, what
 * a copy produces — and leaves each desk its own cells. The header and filter
 * rows are offered as builders a desk can drop in, not imposed.
 *
 * Everything below the rendering section is pure, so the filter grammar and the
 * multi-key sort are testable without a DOM.
 */

import { h } from "./dom";

export type CellValue = string | number | null;

export interface Column<T> {
  readonly id: string;
  readonly label: string;
  /** The sortable, filterable, copyable value. Not the rendered cell. */
  readonly value: (row: T) => CellValue;
  /** Right-align numbers so magnitudes line up down the page. */
  readonly align?: "left" | "right";
  /** `none` opts a column out of the filter row (an actions column, say). */
  readonly filter?: "text" | "number" | "none";
}

export type SortDir = "asc" | "desc";

export interface SortKey {
  readonly column: string;
  readonly dir: SortDir;
}

// ------------------------------------------------------------------ sort ---

/**
 * What a header click does.
 *
 * Plain click: sort by this column alone, descending first for numbers you are
 * ranking — clicking "Score" and getting the WORST setups first is the wrong
 * default and everyone who has used a screener knows it. A second click flips
 * it; a third clears it, because there is no other way back to the natural
 * order once you have sorted.
 *
 * Shift-click ADDS a key rather than replacing, so "score descending, then
 * spread ascending" is two clicks rather than a settings dialog.
 */
export function toggleSort(
  current: readonly SortKey[],
  column: string,
  opts: { additive?: boolean; firstDir?: SortDir } = {},
): SortKey[] {
  const first: SortDir = opts.firstDir ?? "desc";
  const existing = current.find((k) => k.column === column);

  if (!opts.additive) {
    if (!existing) return [{ column, dir: first }];
    if (existing.dir === first) return [{ column, dir: first === "desc" ? "asc" : "desc" }];
    return [];
  }

  if (!existing) return [...current, { column, dir: first }];
  return current
    .map((k) =>
      k.column === column
        ? { column, dir: (k.dir === first ? (first === "desc" ? "asc" : "desc") : first) as SortDir }
        : k,
    )
    .filter((k) => !(k.column === column && existing.dir !== first));
}

/** Nulls last in BOTH directions: "no value" is not smaller than every value. */
function compareValues(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Multi-key sort, stable, original order preserved for full ties.
 *
 * Stability matters more than it sounds: without it, rows with equal scores
 * reshuffle on every re-render and the eye cannot follow a row it was reading.
 */
export function applySort<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  sort: readonly SortKey[],
): T[] {
  if (sort.length === 0) return [...rows];
  const byId = new Map(columns.map((c) => [c.id, c]));

  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const key of sort) {
        const col = byId.get(key.column);
        if (!col) continue;
        /* Nulls stay last whichever way the column is sorted, so flipping the
           direction never floats "no data" to the top. */
        const a = col.value(x.row);
        const b = col.value(y.row);
        if (a === null || b === null) {
          const nulls = compareValues(a, b);
          if (nulls !== 0) return nulls;
          continue;
        }
        const cmp = compareValues(a, b);
        if (cmp !== 0) return key.dir === "asc" ? cmp : -cmp;
      }
      return x.i - y.i;
    })
    .map((w) => w.row);
}

// ---------------------------------------------------------------- filter ---

export interface FilterExpr {
  readonly op: ">" | ">=" | "<" | "<=" | "=" | "!=" | "range" | "text";
  readonly n?: number;
  readonly hi?: number;
  readonly text?: string;
}

/**
 * Parse one filter cell.
 *
 * The grammar is deliberately tiny and guessable: an operator and a number, a
 * `a..b` range, or plain text that matches anywhere. `..` rather than `-` for
 * ranges because `-5` is a number and `1-5` would be ambiguous with it — a
 * filter that silently means something other than what it looks like is worse
 * than one that refuses.
 *
 * Returns null for an empty or unparseable cell, which means "no filter" —
 * never "match nothing", because a typo must not silently empty the table.
 */
export function parseFilter(raw: string): FilterExpr | null {
  const s = raw.trim();
  if (s === "") return null;

  const range = /^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)$/.exec(s);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { op: "range", n: Math.min(lo, hi), hi: Math.max(lo, hi) };
    }
  }

  const cmp = /^(>=|<=|!=|>|<|=)\s*(-?\d*\.?\d+)$/.exec(s);
  if (cmp) {
    const n = Number(cmp[2]);
    if (Number.isFinite(n)) return { op: cmp[1] as FilterExpr["op"], n };
  }

  return { op: "text", text: s.toLowerCase() };
}

/** Does one cell pass one expression? */
export function matches(value: CellValue, expr: FilterExpr): boolean {
  if (expr.op === "text") {
    if (value === null) return false;
    return String(value).toLowerCase().includes(expr.text ?? "");
  }

  /* A numeric comparison against a cell with no number is FALSE, not an error
     and not a pass: "score > 70" must not keep rows whose score is missing. */
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || !Number.isFinite(n) || expr.n === undefined) return false;

  switch (expr.op) {
    case ">": return n > expr.n;
    case ">=": return n >= expr.n;
    case "<": return n < expr.n;
    case "<=": return n <= expr.n;
    case "=": return n === expr.n;
    case "!=": return n !== expr.n;
    case "range": return n >= expr.n && n <= (expr.hi ?? expr.n);
    default: return true;
  }
}

export interface FilterResult<T> {
  readonly rows: T[];
  /** How many the filters removed. Shown so a filter can never hide silently. */
  readonly removed: number;
  readonly active: number;
}

export function applyFilters<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  filters: Readonly<Record<string, string>>,
): FilterResult<T> {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const parsed: Array<{ col: Column<T>; expr: FilterExpr }> = [];

  for (const [id, raw] of Object.entries(filters)) {
    const col = byId.get(id);
    const expr = col ? parseFilter(raw) : null;
    if (col && expr) parsed.push({ col, expr });
  }

  if (parsed.length === 0) return { rows: [...rows], removed: 0, active: 0 };

  const kept = rows.filter((row) => parsed.every((p) => matches(p.col.value(row), p.expr)));
  return { rows: kept, removed: rows.length - kept.length, active: parsed.length };
}

// ------------------------------------------------------------- selection ---

/**
 * Click, ctrl-click and shift-click, as everyone already expects them.
 *
 * `anchor` is the last plainly-clicked row; a shift-click selects the span from
 * it. Returns the new selection AND the new anchor, because a shift-click must
 * not move the anchor or a second shift-click would select the wrong span.
 */
export function selectRow(
  keys: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  key: string,
  mods: { shift?: boolean; ctrl?: boolean },
): { selected: Set<string>; anchor: string | null } {
  if (mods.shift && anchor !== null) {
    const from = keys.indexOf(anchor);
    const to = keys.indexOf(key);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return { selected: new Set(keys.slice(lo, hi + 1)), anchor };
    }
  }

  if (mods.ctrl) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { selected: next, anchor: key };
  }

  /* A plain click on the only selected row clears it, so there is a way out of
     a selection without hunting for a "deselect" affordance. */
  if (selected.size === 1 && selected.has(key)) return { selected: new Set(), anchor: null };
  return { selected: new Set([key]), anchor: key };
}

// ------------------------------------------------------------------ copy ---

/**
 * Tab-separated, header included — the format a spreadsheet pastes cleanly.
 *
 * Traders keep spreadsheets, and refusing to interoperate does not stop that,
 * it just means retyping. Tabs and newlines inside a value are replaced rather
 * than quoted: a value containing a tab would silently become two columns.
 */
export function toTSV<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
): string {
  const clean = (v: CellValue): string =>
    v === null ? "" : String(v).replace(/[\t\r\n]+/g, " ");
  const head = columns.map((c) => clean(c.label)).join("\t");
  const body = rows.map((r) => columns.map((c) => clean(c.value(r))).join("\t"));
  return [head, ...body].join("\n");
}

// --------------------------------------------------------------- builders ---

export interface HeaderOptions<T> {
  readonly columns: readonly Column<T>[];
  readonly sort: () => readonly SortKey[];
  readonly onSort: (next: SortKey[]) => void;
  /** Extra classes so a desk can reuse its own grid. */
  readonly rowClass?: string;
  readonly cellClass?: string;
}

/**
 * A clickable header row.
 *
 * The sort is SHOWN — an arrow, and a number when more than one key is active —
 * because a table sorted by something you cannot see is a table you do not
 * trust.
 */
export function sortableHeader<T>(opts: HeaderOptions<T>): HTMLElement {
  return h(
    "div",
    { class: opts.rowClass ?? "tbl-header", role: "row" },
    ...opts.columns.map((col) =>
      h(
        "button",
        {
          class: opts.cellClass ?? "tbl-hcell",
          type: "button",
          "data-align": col.align ?? "left",
          "data-sorted": () => {
            const k = opts.sort().find((s) => s.column === col.id);
            return k ? k.dir : "";
          },
          title: `Sort by ${col.label} — shift-click to add a second key`,
          onclick: (e: Event) => {
            const ev = e as MouseEvent;
            opts.onSort(
              toggleSort(opts.sort(), col.id, {
                additive: ev.shiftKey,
                /* Text reads best A→Z first; numbers read best biggest first. */
                firstDir: col.filter === "text" ? "asc" : "desc",
              }),
            );
          },
        },
        h("span", { text: col.label }),
        h("span", {
          class: "tbl-arrow",
          text: () => {
            const k = opts.sort().find((s) => s.column === col.id);
            return k ? (k.dir === "asc" ? "▲" : "▼") : "";
          },
        }),
        h("span", {
          class: "tbl-rank",
          text: () => {
            const list = opts.sort();
            if (list.length < 2) return "";
            const i = list.findIndex((s) => s.column === col.id);
            return i >= 0 ? String(i + 1) : "";
          },
        }),
      ),
    ),
  ) as HTMLElement;
}

export interface FilterRowOptions<T> {
  readonly columns: readonly Column<T>[];
  readonly filters: () => Readonly<Record<string, string>>;
  readonly onFilter: (id: string, raw: string) => void;
  readonly rowClass?: string;
}

export function filterRow<T>(opts: FilterRowOptions<T>): HTMLElement {
  return h(
    "div",
    { class: opts.rowClass ?? "tbl-filters", role: "row" },
    ...opts.columns.map((col) =>
      col.filter === "none"
        ? h("span", { class: "tbl-fcell" })
        : h("input", {
            class: "tbl-fcell tbl-finput",
            type: "text",
            spellcheck: "false",
            "aria-label": `Filter ${col.label}`,
            placeholder: col.filter === "number" ? ">70" : "any",
            "data-set": () => String((opts.filters()[col.id] ?? "").trim() !== ""),
            value: () => opts.filters()[col.id] ?? "",
            oninput: (e: Event) => opts.onFilter(col.id, (e.target as HTMLInputElement).value),
          }),
    ),
  ) as HTMLElement;
}
