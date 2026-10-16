/**
 * The economic calendar, at the fidelity a terminal actually needs.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 * There was no calendar SOURCE. `loadCalendar` read a single key out of the
 * local Python service's feature store — a key the collector built by fetching
 * the full ForexFactory weekly feed and then throwing almost all of it away:
 * USD only, high impact only, the top ten, title truncated to 48 characters,
 * and only a time and a name kept. The forecast, the previous print, the impact
 * tier and every non-USD currency were fetched and discarded. If the service
 * was not running there was no calendar at all.
 *
 * MEASURED, on the live feed: 112 events across 10 currencies, 15 of them high
 * impact, 78 carrying a forecast. The old path surfaced 10 titles.
 *
 * WHY THE FEED GOES THROUGH THE LOCAL SERVICE
 * The ForexFactory weekly JSON mirror is the same feed the MetaTrader-adjacent
 * tools read, and it is the right source. It serves NO
 * `Access-Control-Allow-Origin` header, so a browser cannot read it directly —
 * verified, not assumed. The local service already exposes a `/fetch`
 * passthrough for exactly this, and the desktop build can reach it too.
 *
 * So there are two routes and the UI is told which one answered:
 *
 *   LIVE   via the local service's passthrough — every field the feed carries,
 *          for the current week. That horizon is the mirror's, not a choice:
 *          it is the only file published. See FF_WEEK.
 *   STORED via the feature store's hourly snapshot — the old thin path, kept
 *          as a floor rather than deleted, because it survives the passthrough
 *          being unavailable and it is what makes cross-checking possible.
 *
 * WHAT IS NOT HERE, AND WHY
 * There is no second calendar VENDOR. TradingView's calendar endpoint answers
 * only to requests carrying its own site as the Origin; using it would mean
 * forging that header to reach an endpoint they have not opened, which is both
 * bad faith and precisely the behaviour that gets a client blocked — the
 * opposite of what this terminal is trying to be. Trading Economics retired its
 * guest access. So agreement between the two routes above is reported as
 * CONSISTENT, never CONFIRMED: they share an upstream, and core/crosscheck.ts
 * carries that distinction in its types.
 */

import { fetchJson, HttpError } from "./net";
import { reconcileEvents, type ReconciledEvent, type Trust } from "../core/crosscheck";
import { proxyBase, serviceBase } from "./backend";

export type Impact = "high" | "medium" | "low" | "holiday";

export interface EconEvent {
  /** Epoch ms. */
  readonly at: number;
  /** ISO-4217-ish code as published, e.g. "USD". "ALL" for global items. */
  readonly currency: string;
  readonly title: string;
  readonly impact: Impact;
  /** As published — a string, because "0.3%" and "1.2M" are not numbers. */
  readonly forecast: string;
  readonly previous: string;
}

export type CalendarRoute = "live" | "stored" | "none";

export interface CalendarFeed {
  readonly ok: boolean;
  readonly route: CalendarRoute;
  readonly events: readonly ReconciledEvent<EconEvent>[];
  /** When the answering route produced this data. */
  readonly asOf: number;
  /** One sentence naming the route and its limits. Always populated. */
  readonly provenance: string;
  readonly error: string;
}

const IMPACTS: Record<string, Impact> = {
  high: "high",
  medium: "medium",
  low: "low",
  holiday: "holiday",
};

/** Rank for sorting and for deciding what counts as market-moving. */
export function impactRank(i: Impact): number {
  return i === "high" ? 3 : i === "medium" ? 2 : i === "low" ? 1 : 0;
}

interface RawFF {
  readonly title?: string;
  readonly country?: string;
  readonly date?: string;
  readonly impact?: string;
  readonly forecast?: string;
  readonly previous?: string;
}

/**
 * Parse the ForexFactory weekly shape.
 *
 * Every field is treated as absent-by-default rather than trusted, because
 * this is a community mirror of a scraped page and the failure mode is a field
 * quietly changing name, not the endpoint going down. An event with an
 * unparseable date is DROPPED rather than defaulted to now — a calendar entry
 * at the wrong time is worse than a missing one, since it will be read as a
 * scheduled release and used to explain a move it had nothing to do with.
 */
export function parseForexFactory(raw: unknown): EconEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: EconEvent[] = [];
  for (const item of raw as RawFF[]) {
    if (!item || typeof item !== "object") continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title === "") continue;
    const at = Date.parse(String(item.date ?? ""));
    if (!Number.isFinite(at)) continue;
    const impact = IMPACTS[String(item.impact ?? "").toLowerCase()] ?? "low";
    out.push({
      at,
      currency: String(item.country ?? "").toUpperCase() || "ALL",
      title,
      impact,
      forecast: typeof item.forecast === "string" ? item.forecast.trim() : "",
      previous: typeof item.previous === "string" ? item.previous.trim() : "",
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The thin stored shape: `{ t: iso, n: name }`, USD high-impact only. */
export function parseStored(raw: unknown): EconEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: EconEvent[] = [];
  for (const item of raw as { t?: string; n?: string }[]) {
    if (!item || typeof item.n !== "string") continue;
    const at = Date.parse(String(item.t ?? ""));
    if (!Number.isFinite(at)) continue;
    /* The stored copy is USD-high by construction — the collector filters to
       it before writing. Recording that here rather than inferring it later
       keeps the reconciler's currency match honest. */
    out.push({ at, currency: "USD", title: item.n, impact: "high", forecast: "", previous: "" });
  }
  return out;
}

/**
 * The only file this mirror publishes.
 *
 * MEASURED, after assuming otherwise and being wrong: `ff_calendar_nextweek`,
 * `ff_calendar_next_week`, `ff_calendar_lastweek` and `ff_calendar_tomorrow`
 * all 404. Fetching a next week that does not exist put a permanent 404 on
 * every single load — harmless to the read, because the two fetches were raced
 * with `allSettled`, but a request that can never succeed is exactly the
 * needless traffic the governor exists to prevent.
 *
 * THE LIMIT THIS LEAVES, stated rather than hidden: the horizon is the current
 * week. Late on a Friday there may be nothing ahead, and the panel says
 * "nothing left in the loaded week" rather than "nothing scheduled" — those are
 * different claims and only the first one is true.
 */
const FF_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/** URL for the local service's CORS passthrough. */
export function viaProxy(base: string, target: string): string {
  return `${base}/fetch?url=${encodeURIComponent(target)}`;
}

export interface CalendarOptions {
  /** The data proxy, which is what makes the live route possible. */
  readonly proxyBase?: string;
  /** The analysis service, which holds the stored snapshot. */
  readonly serviceBase?: string;
  readonly signal?: AbortSignal;
  readonly now?: number;
}

/**
 * Load the calendar, cross-check it, and say exactly where it came from.
 *
 * The two fetches are raced with `allSettled` rather than awaited in sequence:
 * the stored copy is the cross-check for the live one, and if fetching it
 * sequentially were allowed to fail the whole load, a working live feed would
 * be thrown away because the verification of it was unavailable.
 */
export async function loadCalendar(opts: CalendarOptions = {}): Promise<CalendarFeed> {
  const proxy = opts.proxyBase ?? proxyBase();
  const service = opts.serviceBase ?? serviceBase();
  const now = opts.now ?? Date.now();
  const sig = opts.signal ? { signal: opts.signal } : {};

  /* Half an hour of cache: the upstream is a weekly file that cannot change
     more often than the releases in it are revised. */
  const live = async (): Promise<EconEvent[]> => {
    const raw = await fetchJson<unknown>(viaProxy(proxy, FF_WEEK), {
      priority: "background",
      /**
       * An hour, not the half hour this started at.
       *
       * MEASURED the hard way: repeated fetches while building this earned a
       * 429 from the mirror, and it stayed refused for minutes. This is a
       * WEEKLY file whose figures are revised a handful of times a day — a
       * cache shorter than the revision rate buys nothing and spends the one
       * budget that matters. The governor cannot help here either: it sees the
       * local passthrough as the host and knows nothing about the upstream's
       * limit, so the cache IS the rate limiter for this route.
       */
      ttlMs: 60 * 60_000,
      swr: true,
      /* The passthrough is a relay: a 429 here is the MIRROR refusing, and
         parking 127.0.0.1 over it would take out the bars and quotes that also
         route through the proxy. */
      relay: true,
      ...sig,
    });
    const events = parseForexFactory(raw);
    if (events.length === 0) throw new Error("the passthrough returned no usable events");
    return events;
  };

  const stored = async (): Promise<EconEvent[]> => {
    const rows = await fetchJson<{ source: string; k: string; v: string; t: number }[]>(
      `${service}/svc/data/snapshot`,
      { priority: "background", ttlMs: 15 * 60_000, swr: true, ...sig },
    );
    const row = rows.find((r) => r.source === "calendar" && r.k === "high_usd");
    if (!row) throw new Error("the feature store has no calendar entry yet");
    return parseStored(JSON.parse(row.v));
  };

  const [liveRes, storedRes] = await Promise.allSettled([live(), stored()]);

  if (liveRes.status === "fulfilled") {
    const secondary = storedRes.status === "fulfilled" ? storedRes.value : [];
    return {
      ok: true,
      route: "live",
      /* `independent: false` is the whole honesty of this module. Both routes
         descend from the same upstream feed. */
      events: reconcileEvents(liveRes.value, secondary, false),
      asOf: now,
      provenance:
        secondary.length > 0
          ? `ForexFactory weekly feed (current week only), live through the local passthrough, cross-checked against the service's hourly snapshot. Both descend from the same upstream, so agreement means the feed is steady — not that it is independently verified.`
          : `ForexFactory weekly feed (current week only), live through the local passthrough. The hourly snapshot was unavailable, so nothing has been cross-checked.`,
      error: "",
    };
  }

  /**
   * Why the live route failed, attributed to the right party.
   *
   * The passthrough and the mirror behind it are two different hosts, and the
   * first version blamed the passthrough for everything. When the mirror
   * answered 429 the panel said "the live passthrough is not answering" — the
   * passthrough was answering perfectly and relaying a refusal. Blaming the
   * wrong component sends you to restart a service that was never down.
   */
  const liveFailure = (reason: unknown): string => {
    if (reason instanceof HttpError) {
      if (reason.status === 429) {
        return "the calendar mirror is rate-limiting this machine (429) — it refuses for a few minutes at a time; the passthrough itself is fine";
      }
      return `the calendar mirror answered ${reason.status} through the passthrough`;
    }
    const msg = reason instanceof Error ? reason.message : String(reason);
    return /failed to fetch|networkerror|load failed/i.test(msg)
      ? `the data proxy at ${proxyBase} is not reachable — start everything with "python run.py"`
      : msg;
  };

  if (storedRes.status === "fulfilled" && storedRes.value.length > 0) {
    return {
      ok: true,
      route: "stored",
      events: reconcileEvents(storedRes.value, [], false),
      asOf: now,
      provenance: `The service's hourly snapshot only — high-impact USD releases, titles truncated, no forecast or previous. The live feed did not answer: ${liveFailure(liveRes.reason)}.`,
      error: liveFailure(liveRes.reason),
    };
  }

  const why = liveFailure(liveRes.reason);
  return {
    ok: false,
    route: "none",
    events: [],
    asOf: now,
    provenance: "No calendar source answered. Nothing is being shown rather than something invented.",
    error: `${why}; and the service at ${service} has no usable stored copy either`,
  };
}

/* --------------------------------------------------------------- selection */

export interface UpcomingOptions {
  readonly now: number;
  /** Only these currencies. Empty means all. "ALL" items always pass. */
  readonly currencies?: readonly string[];
  readonly minImpact?: Impact;
  readonly withinMs?: number;
  readonly limit?: number;
}

/** Releases still ahead, soonest first. */
export function upcoming(
  events: readonly ReconciledEvent<EconEvent>[],
  opts: UpcomingOptions,
): ReconciledEvent<EconEvent>[] {
  const floor = impactRank(opts.minImpact ?? "low");
  const horizon = opts.withinMs ?? Number.POSITIVE_INFINITY;
  const wanted = new Set((opts.currencies ?? []).map((c) => c.toUpperCase()));

  const out = events
    .filter((r) => {
      const e = r.event;
      if (e.at < opts.now) return false;
      if (e.at - opts.now > horizon) return false;
      if (impactRank(e.impact) < floor) return false;
      if (wanted.size > 0 && !wanted.has(e.currency) && e.currency !== "ALL") return false;
      return true;
    })
    .sort((a, b) => a.event.at - b.event.at);

  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

/**
 * Currencies a symbol is exposed to.
 *
 * Deliberately crude and deliberately INCLUSIVE of USD for crypto. A trader
 * looking at BTCUSDT during an FOMC decision is exposed to that decision
 * whether or not the pair contains a fiat leg, because the dollar leg is the
 * quote and the whole risk complex moves together. Omitting USD here would
 * hide the single most useful thing this calendar can tell a crypto trader.
 */
export function currenciesFor(symbol: string): string[] {
  const s = symbol.toUpperCase();
  const found = new Set<string>();
  for (const code of ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY"]) {
    if (s.includes(code)) found.add(code);
  }
  /* Every quote here is dollar-denominated in practice — USDT and USDC track
     the dollar, and the releases that move the dollar move them. */
  if (/USDT|USDC|BUSD|FDUSD|USD/.test(s)) found.add("USD");
  if (found.size === 0) found.add("USD");
  return [...found];
}

/**
 * How much a scheduled release should reduce confidence in a read.
 *
 * THE DIRECTION MATTERS AND IT IS NOT OBVIOUS. A known release does not tell
 * you which way price will go — it tells you that in N minutes the current
 * structure may stop mattering. So the calendar's only honest contribution to
 * a decision is a REDUCTION in confidence near a print, never a lean.
 *
 * The trust level scales it: a disputed entry still lowers confidence, because
 * something is still scheduled, just less than a clean one would.
 */
export interface ReleaseRisk {
  readonly discount: number;
  readonly next: ReconciledEvent<EconEvent> | null;
  readonly note: string;
}

/** Inside this window a high-impact release dominates everything else. */
export const IMMINENT_MS = 60 * 60_000;

/** Trust levels that still carry a scheduled release. */
const RISK_BY_TRUST: Record<Trust, number> = {
  confirmed: 1,
  consistent: 0.9,
  single: 0.75,
  disputed: 0.5,
  stale: 0,
};

export function releaseRisk(
  events: readonly ReconciledEvent<EconEvent>[],
  opts: UpcomingOptions,
): ReleaseRisk {
  const ahead = upcoming(events, { ...opts, minImpact: "medium", withinMs: IMMINENT_MS });
  const next = ahead[0] ?? null;
  if (!next) {
    return {
      discount: 0,
      next: null,
      note: "No medium- or high-impact release scheduled within the hour.",
    };
  }

  const minutes = Math.max(0, Math.round((next.event.at - opts.now) / 60_000));
  /* Linear in time-to-release: a print in 5 minutes is a bigger problem for a
     structural read than one in 55. Halved for medium impact. */
  const closeness = 1 - minutes / (IMMINENT_MS / 60_000);
  const severity = next.event.impact === "high" ? 1 : 0.5;
  const discount = closeness * severity * (RISK_BY_TRUST[next.trust] ?? 0);

  return {
    discount: Math.max(0, Math.min(1, discount)),
    next,
    note: `${next.event.currency} ${next.event.title} in ${minutes} min (${next.event.impact} impact). A scheduled release does not say which way price goes — it says the current structure may stop mattering at that minute.`,
  };
}
