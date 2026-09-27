/**
 * Live news, read through the local service.
 *
 * `data/news.ts` gets venue ANNOUNCEMENTS — a listing, a delisting, a margin
 * change — straight from Binance and Bybit, and it explains why those two: they
 * are the only feeds verified to send `Access-Control-Allow-Origin`, so they
 * work in a browser with no proxy and no key. That constraint is why this
 * terminal has never had general news. Almost no newsroom serves CORS headers
 * on its RSS, and a browser-side reader gets a network error on nearly every
 * one — indistinguishable from the feed being down.
 *
 * `server/mishel_rss.py` fetches and parses instead, so the constraint goes
 * away and the operator can point it at any feed they like.
 *
 * THE TWO THINGS THIS MODULE IS CAREFUL ABOUT
 *
 * **Attribution never gets dropped.** The rule `ui/tape.ts` already states: an
 * unattributed headline in a trading terminal is worse than no headline. Every
 * item carries its source and the renderer is expected to show it even when
 * the title has to truncate.
 *
 * **An unknown age is not a fresh one.** The server returns `at: null` when a
 * feed's date could not be parsed, rather than substituting now(). This module
 * keeps that null all the way to the screen, because "just now" on a
 * three-day-old headline is the single worst thing a news ticker can do.
 */

import { looksLocal } from "../learn/ledger";
import { serviceBase } from "./backend";

export const DEFAULT_NEWS_URL = (): string => serviceBase();

export interface RssItem {
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly source: string;
  /** Epoch ms, or null when the feed's date could not be read. */
  readonly at: number | null;
}

export interface FeedStatus {
  readonly source: string;
  readonly url: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly items: number;
}

export interface RssFeed {
  readonly items: readonly RssItem[];
  readonly status: readonly FeedStatus[];
  readonly feeds: number;
  readonly working: number;
  /** One sentence from the server, safe to render verbatim. */
  readonly note: string;
  /** Set when the call itself failed. `items` is then empty. */
  readonly error: string | null;
}

export const EMPTY: RssFeed = {
  items: [],
  status: [],
  feeds: 0,
  working: 0,
  note: "",
  error: null,
};

export interface RssOptions {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  /** Operator's own feeds. Omitted means the server's defaults. */
  readonly feeds?: () => readonly { url: string; source: string }[];
}

/**
 * `2 min ago` / `4 hours ago` / `unknown age`.
 *
 * The null case has its own words rather than a dash, because a dash in a
 * column of ages reads as "just now" to a reader scanning quickly, and the
 * whole point of keeping the null was to stop exactly that.
 */
export function age(at: number | null, now: number): string {
  if (at === null) return "unknown age";
  const s = Math.round((now - at) / 1000);
  if (s < 0) return "just now";
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"} ago`;
}

/**
 * What to say when there is nothing on screen.
 *
 * Three different silences, and collapsing them is the mistake the Flow desk
 * had to be taught not to make: a service that is not running, a set of feeds
 * that all failed, and a genuinely quiet hour are three different things to do
 * next.
 */
/**
 * Turn a transport failure into a sentence, rather than forwarding the parser's.
 *
 * SEEN ON SCREEN, which is how this got written. The news bar read:
 *
 *   No news service — Unexpected token '<', "<!doctype "... is not valid JSON.
 *   Start mishel_service.py to read feeds.
 *
 * Every word of that is true and it is addressed to the wrong person. What
 * happened is ordinary — the service is not running, so the gateway answered the
 * request with its own HTML 404 page and `res.json()` choked on the first `<`.
 * The operator does not need the shape of the bytes; they need to know the
 * service is down, which the second sentence already told them and the first
 * buried.
 *
 * The raw text is not discarded — it goes to the feed log, where a developer
 * looking for it will find it. A status strip is not a console.
 */
function humanError(raw: string): string {
  const e = raw.toLowerCase();
  /* A JSON parse failure on an HTML body is always the same thing: something
     that is not the service answered on the service's address. */
  if (e.includes("not valid json") || e.includes("unexpected token")) {
    return "the news service is not answering on this address";
  }
  if (e.includes("failed to fetch") || e.includes("networkerror") || e.includes("load failed")) {
    return "nothing is listening on the backend address";
  }
  if (e.includes("aborted") || e.includes("timeout")) return "the request timed out";
  if (e.startsWith("http 5")) return "the service answered with an error";
  if (e.startsWith("http 4")) return "the service has no news endpoint";
  /* Anything genuinely unexpected is passed through — inventing a friendly
     phrase for an error nobody has seen would hide the one case where the exact
     words matter. Trimmed, because a stack trace in a status strip is unreadable
     however true it is. */
  return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
}

export function emptyReason(feed: RssFeed): string {
  if (feed.error !== null) {
    /* The ONE launcher. This said "Start mishel_service.py", which on its own
       brings up the pre-consolidation layout the terminal cannot address —
       the remedy printed here was the route into the "Nine launchers" bug. */
    return `No news — ${humanError(feed.error)}. Start the terminal with python run.py to read feeds.`;
  }
  if (feed.feeds === 0) return "No feeds configured.";
  if (feed.working === 0) {
    return feed.note || "None of the feeds answered. That is a connection problem, not a quiet news day.";
  }
  return "Nothing published in the window this reads.";
}

export interface RssHandle {
  load(): Promise<RssFeed>;
}

export function createRss(opts: RssOptions = {}): RssHandle {
  const base = (opts.url ?? DEFAULT_NEWS_URL()).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  /* The same gate the claims ledger and the trial mirror use. This one posts
     the operator's own feed list, which is a small statement about what they
     read; `looksLocal` parses the hostname rather than matching a substring,
     because "127.0.0.1.evil.com" contains "127.0.0.1". */
  if (!looksLocal(base)) {
    return {
      async load() {
        return { ...EMPTY, error: "Refusing to reach a non-local news service." };
      },
    };
  }

  return {
    async load() {
      const custom = opts.feeds?.() ?? [];
      try {
        const res =
          custom.length > 0
            ? await doFetch(`${base}/svc/news/rss`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ feeds: custom }),
              })
            : await doFetch(`${base}/svc/news/rss`);
        const body = (await res.json()) as Partial<RssFeed> & { ok?: boolean; err?: string };
        if (!res.ok || body.ok === false) {
          return { ...EMPTY, error: body.err ?? `HTTP ${res.status}` };
        }
        return {
          items: body.items ?? [],
          status: body.status ?? [],
          feeds: body.feeds ?? 0,
          working: body.working ?? 0,
          note: body.note ?? "",
          error: null,
        };
      } catch (err) {
        return { ...EMPTY, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
