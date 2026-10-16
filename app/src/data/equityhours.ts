/**
 * US equity trading hours, holidays and half-days.
 *
 * WHY THIS EXISTS
 * `data/sessions.ts` returns `unknown` for equities, with a comment saying so:
 * "equities have holidays and half-days this does not model, so they return
 * unknown rather than a confident wrong answer". That was the right call while
 * nothing modelled them, and it has a cost — an `unknown` market falls back to
 * judging the feed on data age alone, so every weekday evening and every
 * weekend an equity chart reports DELAYED for a feed that is working perfectly.
 *
 * A warning that fires every single night is a warning nobody reads, and then
 * the real one on a Wednesday afternoon goes past unnoticed. That is the exact
 * failure `sessions.ts` was written to prevent for forex. This does the same
 * job for equities.
 *
 * WHY THE HOLIDAYS ARE COMPUTED AND NOT LISTED
 * A hard-coded table of dates is correct until January and then silently wrong,
 * and "silently wrong" here means the terminal insists the market is open on
 * Thanksgiving. Every US market holiday except Good Friday is a fixed date or
 * an nth-weekday rule, and Good Friday is two days before Easter, which has a
 * closed-form solution. So the rules go in and the calendar comes out, for any
 * year, with nothing to maintain.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL
 *  - **Pre- and post-market.** They exist, they are thin, and the prices there
 *    are not the prices you get filled at in size. Treating 04:00 as "open"
 *    would make the freshness contract accept a feed that is quoting a book
 *    nobody is in.
 *  - **Non-US exchanges.** GER40 and UK100 keep their own hours and their own
 *    holidays; claiming NYSE's calendar for them would be a confident wrong
 *    answer of exactly the kind this file exists to avoid. They stay `unknown`
 *    until someone models them properly. See `EQUITY_VENUE`.
 *  - **Unscheduled closures.** A hurricane closes the exchange and no rule
 *    predicts it. The feed going stale is the only signal there, which is what
 *    the freshness contract already does.
 */

/** Minutes past UTC midnight. */
export interface SessionSpan {
  readonly openMin: number;
  readonly closeMin: number;
}

export type EquityDay =
  | { readonly kind: "closed"; readonly why: string }
  | { readonly kind: "half"; readonly why: string; readonly span: SessionSpan }
  | { readonly kind: "full"; readonly span: SessionSpan };

/* Regular session, in Eastern wall-clock minutes: 09:30 to 16:00. */
const OPEN_ET = 9 * 60 + 30;
const CLOSE_ET = 16 * 60;
/* Half days end at 13:00 ET. */
const HALF_CLOSE_ET = 13 * 60;

const DAY_MS = 86_400_000;

/** UTC calendar parts, so nothing depends on the machine's own time zone. */
interface Ymd {
  readonly y: number;
  readonly m: number; // 1..12
  readonly d: number; // 1..31
  readonly dow: number; // 0 = Sunday
}

export function ymd(ms: number): Ymd {
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    dow: dt.getUTCDay(),
  };
}

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);

/** Date of the `n`th `dow` in a month (n = 1..5). */
function nthWeekday(y: number, m: number, dow: number, n: number): number {
  const first = new Date(utc(y, m, 1)).getUTCDay();
  const offset = (dow - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** Date of the last `dow` in a month. */
function lastWeekday(y: number, m: number, dow: number): number {
  const daysInMonth = new Date(utc(y, m + 1 === 13 ? 1 : m + 1, 1) - DAY_MS).getUTCDate();
  const last = new Date(utc(y, m, daysInMonth)).getUTCDay();
  return daysInMonth - ((last - dow + 7) % 7);
}

/**
 * Easter Sunday, Gregorian — the anonymous algorithm.
 *
 * Needed only for Good Friday, which is the one US market holiday with no
 * fixed date and no nth-weekday rule. Valid for every year this terminal will
 * ever be asked about.
 */
export function easter(y: number): { m: number; d: number } {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/**
 * US DST, which decides whether Eastern is UTC−5 or UTC−4.
 *
 * Second Sunday in March at 02:00 local to first Sunday in November at 02:00
 * local. The boundary hour is approximated to the UTC day, which is off by at
 * most a couple of hours twice a year, at 06:00 UTC on a Sunday — a moment when
 * no equity market is open under either answer.
 */
export function easternOffsetHours(ms: number): number {
  const { y } = ymd(ms);
  const start = utc(y, 3, nthWeekday(y, 3, 0, 2)) + 7 * 3_600_000; // 02:00 EST
  const end = utc(y, 11, nthWeekday(y, 11, 0, 1)) + 6 * 3_600_000; // 02:00 EDT
  return ms >= start && ms < end ? -4 : -5;
}

/** Eastern wall-clock minutes to minutes past UTC midnight, for that instant. */
function span(ms: number, openEt: number, closeEt: number): SessionSpan {
  const shift = -easternOffsetHours(ms) * 60;
  return { openMin: openEt + shift, closeMin: closeEt + shift };
}

/**
 * Every closure and short session the NYSE and Nasdaq observe, by rule.
 *
 * A fixed-date holiday falling on a Saturday is observed the Friday before and
 * one falling on a Sunday the Monday after — the rule the exchanges actually
 * use, and the reason 4 July 2026 (a Saturday) closes the market on the 3rd.
 */
export function equityDay(ms: number): EquityDay {
  const { y, m, d, dow } = ymd(ms);

  if (dow === 0 || dow === 6) return { kind: "closed", why: "weekend" };

  const observed = (hm: number, hd: number): boolean => {
    const nominal = new Date(utc(y, hm, hd)).getUTCDay();
    if (nominal === 6) {
      /* Observed the Friday before — which may fall in the previous month. */
      const obs = ymd(utc(y, hm, hd) - DAY_MS);
      return obs.m === m && obs.d === d;
    }
    if (nominal === 0) {
      const obs = ymd(utc(y, hm, hd) + DAY_MS);
      return obs.m === m && obs.d === d;
    }
    return hm === m && hd === d;
  };

  const isNth = (hm: number, hdow: number, n: number): boolean =>
    m === hm && d === nthWeekday(y, hm, hdow, n);

  if (observed(1, 1)) return { kind: "closed", why: "New Year's Day" };
  if (isNth(1, 1, 3)) return { kind: "closed", why: "Martin Luther King Jr. Day" };
  if (isNth(2, 1, 3)) return { kind: "closed", why: "Presidents' Day" };

  const e = easter(y);
  const good = ymd(utc(y, e.m, e.d) - 2 * DAY_MS);
  if (good.m === m && good.d === d) return { kind: "closed", why: "Good Friday" };

  if (m === 5 && d === lastWeekday(y, 5, 1)) return { kind: "closed", why: "Memorial Day" };
  if (observed(6, 19)) return { kind: "closed", why: "Juneteenth" };
  if (observed(7, 4)) return { kind: "closed", why: "Independence Day" };
  if (isNth(9, 1, 1)) return { kind: "closed", why: "Labor Day" };

  const thanksgiving = nthWeekday(y, 11, 4, 4);
  if (m === 11 && d === thanksgiving) return { kind: "closed", why: "Thanksgiving" };
  if (observed(12, 25)) return { kind: "closed", why: "Christmas Day" };

  /* Half days. The exchange closes at 13:00 ET; a feed that stops updating
     then is not stale, and a terminal that says otherwise is crying wolf on
     three of the calmest afternoons of the year. */
  if (m === 11 && d === thanksgiving + 1) {
    return { kind: "half", why: "day after Thanksgiving", span: span(ms, OPEN_ET, HALF_CLOSE_ET) };
  }
  if (m === 12 && d === 24 && dow >= 1 && dow <= 5) {
    return { kind: "half", why: "Christmas Eve", span: span(ms, OPEN_ET, HALF_CLOSE_ET) };
  }
  if (m === 7 && d === 3 && dow >= 1 && dow <= 5) {
    return { kind: "half", why: "day before Independence Day", span: span(ms, OPEN_ET, HALF_CLOSE_ET) };
  }

  return { kind: "full", span: span(ms, OPEN_ET, CLOSE_ET) };
}

/** Is a US-listed equity or index tradeable at `ms`? */
export function isEquityOpen(ms: number): boolean {
  const day = equityDay(ms);
  if (day.kind === "closed") return false;
  const dt = new Date(ms);
  const minutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
  return minutes >= day.span.openMin && minutes < day.span.closeMin;
}

/**
 * Why the market is shut, in the words the status bar uses.
 *
 * Empty string when it is open. Named holidays rather than a generic "closed",
 * because "closed — Thanksgiving" is a fact you can check and "closed" is a
 * claim you have to take on trust.
 */
export function equityClosedNote(ms: number): string {
  const day = equityDay(ms);
  if (day.kind === "closed") {
    return day.why === "weekend" ? "market closed — weekend" : `market closed — ${day.why}`;
  }
  if (isEquityOpen(ms)) return "";
  const dt = new Date(ms);
  const minutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
  if (day.kind === "half" && minutes >= day.span.closeMin) {
    return `market closed — early close, ${day.why}`;
  }
  return minutes < day.span.openMin ? "market closed — before the open" : "market closed — after the close";
}

/**
 * Which venue's calendar an index or ticker follows.
 *
 * Only the US calendar is modelled. Everything else returns null, and a null
 * venue is treated as `unknown` upstream — which restores the old, honest
 * behaviour for GER40 and UK100 rather than quietly applying New York's
 * holidays to Frankfurt.
 */
export function equityVenue(symbol: string): "us" | null {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (US_INDICES.has(s)) return "us";
  if (NON_US_INDICES.has(s)) return null;
  /* A bare 1-to-5-letter ticker is a US listing as far as this terminal's data
     sources go — the proxy serves them from a US-listed universe. */
  return /^[A-Z]{1,5}$/.test(s) ? "us" : null;
}

const US_INDICES = new Set(["NAS100", "US30", "SPX500", "US2000"]);
const NON_US_INDICES = new Set(["GER40", "UK100", "JPN225", "AUS200", "FRA40", "EU50", "HK50"]);
