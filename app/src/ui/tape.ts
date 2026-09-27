/**
 * The tape — one line at the top saying what is happening right now.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A SCROLLING MARQUEE
 *
 * The obvious build is a ribbon of text sliding right to left. It is the wrong
 * one and it is worth saying why, because "make it a ticker" almost always
 * means "make it slide".
 *
 * Sliding text cannot be read at a glance — the eye has to track it, which is
 * the opposite of glanceable — and it cannot be clicked, because the target is
 * moving. It also gives every item the same weight and the same dwell time, so
 * "the feed has stopped" scrolls past at exactly the speed of "a token was
 * listed on a venue you do not use".
 *
 * So this holds ONE item still, for long enough to read, and rotates. It stops
 * on hover, so anything worth reading twice can be. The order is by how much
 * the item should interrupt you, not by when it arrived.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT GOES IN IT, AND THE ORDER
 *
 * 1. THE FEED, when it is not healthy. Everything else on this screen is
 *    derived from bars; if the bars have stopped, every other line in the
 *    terminal is describing a market that has moved on without it. It goes
 *    first and it does not rotate away while it is true.
 * 2. IMMINENT HIGH-IMPACT RELEASES, with a live countdown. This is the one
 *    item that already refuses trades — `evaluateGates` has an embargo gate —
 *    so a trader seeing "STAND DOWN" at the same moment as "CPI in 4 min" does
 *    not have to go and find the connection.
 * 3. ALERTS THAT HAVE FIRED. The operator's own conditions, in their own words.
 * 4. VENUE ANNOUNCEMENTS, corroborated across publishers where possible.
 * 5. THE NEXT SCHEDULED RELEASES, further out, when nothing louder is true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS GENERATED
 *
 * Every line is a real event from a source the terminal already consults, with
 * the publisher and the time attached. There is no summarising, no sentiment
 * and no "market commentary": a tape that paraphrases is a tape that can be
 * wrong in a way nobody can check, and this one is read at a glance, which is
 * exactly when a reader is least able to check anything.
 */

import type { CalendarFeed, EconEvent, Impact } from "../data/calendar";
import type { NewsFeed } from "../data/news";
import type { FeedState } from "../data/feed";

export type TapeKind = "feed" | "release" | "alert" | "announcement";

/** How loudly an item should interrupt. Lower sorts first. */
export type TapeTone = "alarm" | "attention" | "neutral";

export interface TapeItem {
  /** Stable across refreshes, so rotation does not restart on every poll. */
  readonly id: string;
  readonly kind: TapeKind;
  readonly tone: TapeTone;
  /** The line itself. Complete on its own — the tape has no second line. */
  readonly text: string;
  /** Where it came from: a venue, a publisher, "your alert". */
  readonly source: string;
  /**
   * When it happened, or when it WILL. Null for items with no moment — a
   * stalled feed is a state, not an event.
   */
  readonly at: number | null;
  /** Set for a scheduled item, so the line can carry a live countdown. */
  readonly countdownTo: number | null;
}

/** Releases inside this window are the loudest thing on the tape. */
export const IMMINENT_MS = 30 * 60 * 1000;
/**
 * How far ahead a scheduled item is worth a line, by impact.
 *
 * TWO HORIZONS, BECAUSE ONE WAS WRONG IN BOTH DIRECTIONS. A single 36-hour
 * window hid the thing a tape most needs to carry: measured on this machine,
 * the calendar's high-impact set was Non-Farm Payrolls, Unemployment Rate and
 * Average Hourly Earnings, all 41 hours out — the largest scheduled event of
 * the month for a gold trader, and the tape said nothing. Widen the single
 * window to fit them and it also fills with medium-impact items two days away
 * that nobody is trading around.
 */
export const HORIZON_HIGH_MS = 4 * 24 * 60 * 60 * 1000;
export const HORIZON_MS = 18 * 60 * 60 * 1000;
/** An announcement older than this is history, not news. */
export const NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TONE_ORDER: Record<TapeTone, number> = { alarm: 0, attention: 1, neutral: 2 };

/**
 * Tie-break within a tone: what it is, before when it is.
 *
 * MEASURED, AND IT WAS BACKWARDS WITHOUT THIS. Sorting a tone band purely by
 * closeness-to-now put four Bybit listings from eleven hours ago ahead of
 * Non-Farm Payrolls in forty-one — the largest scheduled event of the month
 * for anyone holding gold, pushed off the front of the tape by a perpetual
 * contract on a token the operator has never traded. Recency is not
 * importance, and a release you can still act on outranks an announcement you
 * cannot.
 */
const KIND_ORDER: Record<TapeKind, number> = { feed: 0, release: 1, alert: 2, announcement: 3 };

/**
 * "in 4 min", "in 2.1 hours", "in 3 days" — never "in 2582 min".
 *
 * The same failure `ui/countdown.ts` documents fixing for the bar clock and
 * `setup/gates.ts` for the embargo. Third clock, same rule: a four-digit
 * minutes field is not read as time by anybody.
 */
export function awayIn(ms: number): string {
  if (ms <= 0) return "now";
  const mins = ms / 60_000;
  if (mins < 1) return `in ${Math.max(1, Math.round(ms / 1000))}s`;
  if (mins < 90) return `in ${Math.round(mins)} min`;
  const hrs = mins / 60;
  if (hrs < 36) return `in ${hrs.toFixed(hrs < 10 ? 1 : 0)} hours`;
  return `in ${Math.round(hrs / 24)} days`;
}

/** "4 min ago", "3 hours ago" — for things that have already happened. */
export function agoIn(ms: number): string {
  if (ms < 60_000) return "just now";
  const mins = ms / 60_000;
  if (mins < 90) return `${Math.round(mins)} min ago`;
  const hrs = mins / 60;
  if (hrs < 36) return `${Math.round(hrs)} hours ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

const IMPACT_WORD: Record<Impact, string> = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
  holiday: "Holiday",
};

export interface TapeInputs {
  readonly now: number;
  readonly feed: FeedState | null;
  /** Whether the venue is shut. A quiet feed on a closed market is not a fault. */
  readonly marketClosed: boolean;
  readonly calendar: CalendarFeed | null;
  /** Currencies this instrument is exposed to; empty means do not filter. */
  readonly currencies: readonly string[];
  readonly news: NewsFeed | null;
  /** Alerts that have fired, newest first. */
  readonly alerts: readonly { readonly id: string; readonly text: string; readonly at: number }[];
}

/**
 * A stalled feed, when and only when it is genuinely a fault.
 *
 * `offline` and `stale` are faults. `delayed` is worth a quieter line. A quiet
 * feed on a CLOSED venue is neither — gold does not tick at the weekend and a
 * tape shouting about it would train the operator to ignore the one line that
 * must never be ignored.
 */
function feedItem(i: TapeInputs): TapeItem | null {
  const f = i.feed;
  if (f === null) return null;
  if (i.marketClosed) return null;
  if (f.quality === "live") return null;

  const alarm = f.quality === "offline" || f.quality === "stale";
  const age = Number.isFinite(f.tickAgeMs) ? ` — last message ${agoIn(f.tickAgeMs)}` : "";
  return {
    id: `feed:${f.quality}`,
    kind: "feed",
    tone: alarm ? "alarm" : "attention",
    text:
      f.quality === "offline"
        ? `No feed. Nothing on this screen is being updated${age}.`
        : f.quality === "stale"
          ? `The ${f.source} feed has stopped${age}. Every read here is describing a market that has moved on.`
          : `The ${f.source} feed is running late${age}.`,
    source: f.source,
    at: null,
    countdownTo: null,
  };
}

function releaseItems(i: TapeInputs): TapeItem[] {
  const cal = i.calendar;
  if (cal === null || !cal.ok) return [];
  const wanted = new Set(i.currencies.map((c) => c.toUpperCase()));

  const out: TapeItem[] = [];
  for (const r of cal.events) {
    const e = r.event as EconEvent;
    const away = e.at - i.now;
    if (e.impact === "low") continue;
    if (away < -5 * 60_000) continue;
    if (away > (e.impact === "high" ? HORIZON_HIGH_MS : HORIZON_MS)) continue;
    if (wanted.size > 0 && !wanted.has(e.currency.toUpperCase()) && e.currency !== "ALL") continue;

    const imminent = away <= IMMINENT_MS;
    out.push({
      id: `cal:${e.at}:${e.title}`,
      kind: "release",
      tone: imminent && e.impact === "high" ? "alarm" : imminent ? "attention" : "neutral",
      /* The countdown is NOT baked into the text — it is rendered live from
         `countdownTo`, so a line that has been on screen for a minute is not
         a minute out of date. */
      text: `${e.currency} ${e.title}`,
      source: `${IMPACT_WORD[e.impact]} · calendar`,
      at: e.at,
      countdownTo: e.at,
    });
  }
  return out;
}

function alertItems(i: TapeInputs): TapeItem[] {
  return i.alerts
    .filter((a) => i.now - a.at <= NEWS_MAX_AGE_MS)
    .slice(0, 5)
    .map((a) => ({
      id: `alert:${a.id}`,
      kind: "alert" as const,
      tone: "attention" as const,
      text: a.text,
      source: "your alert",
      at: a.at,
      countdownTo: null,
    }));
}

function newsItems(i: TapeInputs): TapeItem[] {
  const n = i.news;
  if (n === null) return [];
  return n.stories
    .filter((s) => i.now - s.at <= NEWS_MAX_AGE_MS)
    .slice(0, 8)
    .map((s) => ({
      id: `news:${s.at}:${s.title}`,
      kind: "announcement" as const,
      tone: "neutral" as const,
      text: s.title,
      /* The publisher COUNT, not a confidence score. One venue saying
         something and three venues saying it are different facts, and the
         difference is countable rather than judged. */
      source:
        s.publishers.length > 1
          ? `${s.publishers.length} venues`
          : (s.publishers[0] ?? "venue"),
      at: s.at,
      countdownTo: null,
    }));
}

/**
 * The tape, in the order it should interrupt.
 *
 * Sorted by tone first and time second, so an imminent high-impact release
 * outranks an announcement from this morning however recent the announcement
 * is. Within a tone, soonest-or-newest wins.
 */
export function buildTape(i: TapeInputs): TapeItem[] {
  const items: TapeItem[] = [];
  const f = feedItem(i);
  if (f !== null) items.push(f);
  items.push(...releaseItems(i), ...alertItems(i), ...newsItems(i));

  return items.sort((a, b) => {
    const t = TONE_ORDER[a.tone] - TONE_ORDER[b.tone];
    if (t !== 0) return t;
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    /* Scheduled items sort by how soon; past items by how recent. Both mean
       "closest to now", which is the only ordering that reads correctly with
       the two mixed together. */
    const da = a.at === null ? 0 : Math.abs(a.at - i.now);
    const db = b.at === null ? 0 : Math.abs(b.at - i.now);
    return da - db;
  });
}

/** The line as rendered, with the countdown resolved at `now`. */
export function tapeLine(item: TapeItem, now: number): string {
  if (item.countdownTo !== null) return `${item.text} ${awayIn(item.countdownTo - now)}`;
  if (item.at !== null && item.kind !== "feed") return `${item.text} · ${agoIn(now - item.at)}`;
  return item.text;
}

/* ═══════════════════════════════════════════════════════════ the component ═ */

import { h } from "./dom";
import { renderEffect, signal } from "../core/signal";

/** How long one item holds still before the next. */
export const DWELL_MS = 7_000;

export interface TapeOptions {
  readonly items: () => readonly TapeItem[];
  readonly now: () => number;
  /** Where clicking the line should take the operator, if anywhere. */
  readonly onOpen?: (item: TapeItem) => void;
}

export interface TapeHandle {
  readonly el: HTMLElement;
  dispose(): void;
}

/**
 * One item at a time, held still, rotating.
 *
 * PAUSES ON HOVER, and that is not a nicety: the only reason to look directly
 * at a rotating element is that you want to read it, and rotating it away
 * under the cursor is the single most annoying thing this component could do.
 * It also pauses while the tab is hidden, so returning to the terminal does not
 * mean returning to whatever item happened to be up when you left.
 */
export function createTape(opts: TapeOptions): TapeHandle {
  const cursor = signal(0);
  let paused = false;
  let timer: number | null = null;

  const line = h("span", { class: "tape-text" });
  const src = h("span", { class: "tape-src" });
  const dots = h("span", { class: "tape-dots" });

  const el = h(
    "div",
    {
      class: "tape",
      role: "status",
      /* Polite, not assertive: this must never interrupt a screen reader
         mid-sentence. The one item that genuinely should is the stalled feed,
         and that has its own place in the status bar. */
      "aria-live": "polite",
      onmouseenter: () => { paused = true; },
      onmouseleave: () => { paused = false; },
    },
    h("span", { class: "tape-dot" }),
    line,
    src,
    dots,
  ) as HTMLElement;

  const advance = (by: number): void => {
    const n = opts.items().length;
    if (n === 0) return;
    cursor.set(((cursor.peek() + by) % n + n) % n);
  };

  el.addEventListener("click", () => {
    const list = opts.items();
    const item = list[cursor.peek() % Math.max(1, list.length)];
    if (item !== undefined && opts.onOpen) opts.onOpen(item);
  });

  timer = window.setInterval(() => {
    if (paused || document.hidden) return;
    advance(1);
  }, DWELL_MS);

  renderEffect(() => {
    const list = opts.items();
    const now = opts.now();
    el.dataset["empty"] = String(list.length === 0);
    if (list.length === 0) {
      line.textContent = "";
      src.textContent = "";
      dots.textContent = "";
      el.removeAttribute("data-tone");
      return;
    }

    /* Clamp rather than modulo the stored cursor: the list shrinks when a
       release passes or an announcement ages out, and a stored index past the
       end would blank the tape until the next tick. */
    const idx = Math.min(cursor(), list.length - 1);
    const item = list[idx] as TapeItem;
    el.dataset["tone"] = item.tone;
    el.dataset["kind"] = item.kind;
    line.textContent = tapeLine(item, now);
    src.textContent = item.source;
    /* Position, not a set of clickable pips: at eight items, dots are three
       pixels each and hitting one is luck. The count says how much there is. */
    dots.textContent = list.length > 1 ? `${idx + 1}/${list.length}` : "";
    el.title = `${tapeLine(item, now)} — ${item.source}`;
  });

  return {
    el,
    dispose(): void {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}
