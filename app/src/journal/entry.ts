/**
 * The journal entry — one trade you actually took.
 *
 * WHY THIS IS THE MOST IMPORTANT FILE ADDED IN v49
 * The Setup card has always ended with the line *"No record for this setup type
 * yet — nothing here has been measured on your trades."* That sentence is
 * honest and it is also a standing admission that the terminal cannot tell you
 * whether its own reads work. Everything upstream of it — the confluence
 * score, the gates, the plan, the detectors — produces an opinion, and until
 * something records what happened next, every one of those opinions is
 * unfalsifiable.
 *
 * A backtest cannot fill this gap and it is worth being precise about why. A
 * backtest measures a RULE over history. A journal measures YOU over your own
 * history — including the trades you skipped the plan on, the ones you cut
 * early, and the ones you took when a gate said no. The gap between those two
 * numbers is the single most useful figure a trading terminal can show
 * somebody, and no backtest can produce it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS RECORDED AND WHY EACH FIELD EARNS ITS PLACE
 *
 * The temptation is to record everything. The cost of that is a form nobody
 * fills in, and a journal with three entries measures nothing. So every field
 * here is either captured automatically from the terminal's own state, or is
 * one of two things a person must actually decide.
 *
 * AUTOMATIC: symbol, timeframe, direction, the plan's entry/stop/targets, the
 * setup kind, the confluence score at the time, which gates were passing, the
 * data source and its quality. All of it is on screen when the trade is taken,
 * and none of it is worth making somebody retype.
 *
 * MANUAL: the fill, and the exit. Those are facts only the broker knows.
 *
 * OPTIONAL: a note, and how closely the plan was followed. The second one is
 * the field that makes the journal worth more than a broker statement.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT DO
 *
 * It does not place, modify or close anything. An entry is created when you
 * tell it one exists. The terminal has never touched an order and this does
 * not change that — a journal that could open positions would be a trading
 * system with a diary attached, and the honesty contract this codebase runs on
 * says decision support only.
 */

/** How closely the trade followed the plan the card produced. */
export type Adherence =
  /** Entry, stop and target all as planned. */
  | "as-planned"
  /** Taken, but with a different entry, stop or size than the plan said. */
  | "modified"
  /** Taken with no plan on screen, or against a blocking gate. */
  | "off-plan";

export type Outcome = "win" | "loss" | "breakeven" | "open";

export interface JournalEntry {
  readonly id: string;
  /** When the position was opened, epoch ms. */
  readonly openedAt: number;
  /** When it was closed. Null while it is still open. */
  readonly closedAt: number | null;

  readonly symbol: string;
  readonly timeframe: string;
  readonly direction: "long" | "short";

  /** What was actually paid, not what the plan hoped for. */
  readonly entry: number;
  readonly stop: number;
  /** Null when the trade was taken without one. That is a fact worth keeping. */
  readonly target: number | null;
  /** Exit price. Null while open. */
  readonly exit: number | null;
  /** Position size in the instrument's own units. */
  readonly size: number;

  /**
   * The detector kind this setup came from — "liquidity-sweep", "fvg", "bos".
   *
   * THIS IS THE JOIN KEY, and it is why the journal can answer a question a
   * broker statement cannot: not "how am I doing" but "how am I doing on THIS
   * kind of setup". Null for a discretionary trade, which is itself a category
   * worth measuring separately.
   */
  readonly setupKind: string | null;

  /** Confluence score when the trade was opened, 0..100. Null if unknown. */
  readonly scoreAtEntry: number | null;
  /** Gates that were BLOCKING when the trade was opened. Usually empty. */
  readonly gatesBlocking: readonly string[];

  readonly adherence: Adherence;
  readonly note: string;

  /** Where the price came from, and how good it was. Kept for honesty. */
  readonly source: string;
  readonly quality: string;
}

/** A new entry before it has an id or an outcome. */
export type NewEntry = Omit<JournalEntry, "id" | "closedAt" | "exit"> &
  Partial<Pick<JournalEntry, "closedAt" | "exit">>;

/**
 * Realised R — profit measured in units of the risk taken.
 *
 * WHY R AND NOT CURRENCY
 * Currency P&L conflates being right with betting big, and a journal that
 * ranks setups by dollars will tell you your best setup is whichever one you
 * happened to size up on. R divides that out: a trade risking 1% and making 2%
 * is +2R whether the account is a thousand or a million, and two setups can
 * finally be compared.
 *
 * Returns null when the trade is open, or when the stop sat at the entry — a
 * zero-risk trade has no denominator and inventing one would produce infinite
 * R on the least informative trade in the book.
 */
export function realisedR(e: JournalEntry): number | null {
  if (e.exit === null) return null;
  const risk = Math.abs(e.entry - e.stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const move = e.direction === "long" ? e.exit - e.entry : e.entry - e.exit;
  return move / risk;
}

/**
 * Planned R — what the trade was aiming at when it was opened.
 *
 * Kept alongside realised R because the DIFFERENCE is the interesting number.
 * A book full of +3R plans that realise +0.6R is not a bad strategy; it is a
 * person taking profit early, and those two problems have opposite fixes.
 */
export function plannedR(e: JournalEntry): number | null {
  if (e.target === null) return null;
  const risk = Math.abs(e.entry - e.stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const move = e.direction === "long" ? e.target - e.entry : e.entry - e.target;
  return move / risk;
}

/**
 * Win, loss or scratch.
 *
 * The breakeven band is a tenth of R rather than exactly zero: a trade that
 * closed a tick from entry is a scratch in every sense that matters, and
 * filing it as a win because of one tick would flatter every hit rate in the
 * journal.
 */
export const BREAKEVEN_R = 0.1;

export function outcome(e: JournalEntry): Outcome {
  if (e.exit === null) return "open";
  const r = realisedR(e);
  if (r === null) return "breakeven";
  if (r > BREAKEVEN_R) return "win";
  if (r < -BREAKEVEN_R) return "loss";
  return "breakeven";
}

/** How long it was held, in ms. Null while open. */
export function holdingMs(e: JournalEntry): number | null {
  return e.closedAt === null ? null : Math.max(0, e.closedAt - e.openedAt);
}

const FIELDS: readonly (keyof JournalEntry)[] = [
  "id", "openedAt", "closedAt", "symbol", "timeframe", "direction",
  "entry", "stop", "target", "exit", "size", "setupKind", "scoreAtEntry",
  "gatesBlocking", "adherence", "note", "source", "quality",
];

const ADHERENCE: readonly Adherence[] = ["as-planned", "modified", "off-plan"];

/**
 * Read one stored entry, or null.
 *
 * Strict on the fields that carry meaning and forgiving on the ones that do
 * not: a missing note is an empty string, and a missing entry price is a
 * refusal. An entry with no price is not a partial record of a trade, it is
 * not a record of a trade, and admitting it would put a NaN into every
 * statistic downstream.
 */
export function sanitiseEntry(value: unknown): JournalEntry | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;

  const num = (k: string): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const str = (k: string, fallback = ""): string =>
    typeof o[k] === "string" ? (o[k] as string) : fallback;

  const id = str("id");
  const symbol = str("symbol");
  const entry = num("entry");
  const stop = num("stop");
  const size = num("size");
  const openedAt = num("openedAt");
  if (id === "" || symbol === "" || entry === null || stop === null || openedAt === null) {
    return null;
  }

  const dir = o["direction"];
  const direction: "long" | "short" = dir === "short" ? "short" : "long";
  const adh = o["adherence"];
  const adherence: Adherence = ADHERENCE.includes(adh as Adherence)
    ? (adh as Adherence)
    : "off-plan";

  return {
    id,
    openedAt,
    closedAt: num("closedAt"),
    symbol,
    timeframe: str("timeframe", "1h"),
    direction,
    entry,
    stop,
    target: num("target"),
    exit: num("exit"),
    size: size ?? 0,
    setupKind: typeof o["setupKind"] === "string" ? (o["setupKind"] as string) : null,
    scoreAtEntry: num("scoreAtEntry"),
    gatesBlocking: Array.isArray(o["gatesBlocking"])
      ? (o["gatesBlocking"] as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    adherence,
    note: str("note"),
    source: str("source", "unknown"),
    quality: str("quality", "unknown"),
  };
}

/** Fields, in a stable order, for CSV export. */
export const CSV_FIELDS = FIELDS;

/**
 * The journal as CSV.
 *
 * Exists because a journal you cannot get out of the tool is a journal you
 * will not keep. Everything here is yours and the format is the most boring
 * one that every spreadsheet opens.
 */
export function toCsv(entries: readonly JournalEntry[]): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [...CSV_FIELDS, "realisedR", "plannedR", "outcome"].join(",");
  const rows = entries.map((e) =>
    [
      ...CSV_FIELDS.map((f) => esc(e[f])),
      esc(realisedR(e)?.toFixed(3) ?? ""),
      esc(plannedR(e)?.toFixed(3) ?? ""),
      esc(outcome(e)),
    ].join(","),
  );
  return [head, ...rows].join("\n");
}
