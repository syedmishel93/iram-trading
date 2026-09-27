/**
 * Cross-checking: deciding what is TRUE when several sources have an opinion.
 *
 * THE PROBLEM THIS SOLVES
 * Every other data module in this terminal answers "what does source X say?".
 * None of them answers "is X right?", and the difference matters most exactly
 * where the stakes are highest — a calendar entry with the wrong release time
 * makes you read a scheduled spike as structure, and a headline that only one
 * venue is carrying is usually that venue advertising, not news.
 *
 * THREE RULES, AND THEY ARE ALL ABOUT NOT OVERCLAIMING
 *
 * 1. CORROBORATION IS COUNTED IN PUBLISHERS, NEVER IN ITEMS. Binance posting
 *    the same listing three times is one publisher saying it once. This is the
 *    single most important line in the file, because item-counting is the
 *    obvious implementation and it manufactures confidence out of repetition.
 *
 * 2. DISAGREEMENT IS REPORTED, NEVER RESOLVED BY AVERAGING. When two sources
 *    give different forecasts for the same release, the honest output is "these
 *    two disagree, here is both" — an average of two numbers, one of which is
 *    wrong, is a third number that no source stands behind.
 *
 * 3. SAME-ORIGIN AGREEMENT IS NOT VERIFICATION. Comparing a live pull against
 *    an hourly snapshot OF THE SAME FEED tells you the feed has not changed
 *    under you. It tells you nothing about whether the feed is correct. That
 *    distinction is carried in the type system as `Trust`, not left to a
 *    comment, because the whole value of this module is destroyed the moment
 *    "consistent" gets displayed as "verified".
 */

export type Trust =
  /** Independent sources agree. The strongest thing this module can say. */
  | "confirmed"
  /** One source. Not wrong — just unchecked. */
  | "single"
  /** Sources disagree. Both values are kept; neither is chosen silently. */
  | "disputed"
  /** The same feed, seen twice, unchanged. Consistent — NOT verified. */
  | "consistent"
  /** Nothing recent enough to act on. */
  | "stale";

/** How the trust level should read in one short phrase. */
export function trustLabel(t: Trust): string {
  switch (t) {
    case "confirmed":
      return "confirmed by independent sources";
    case "single":
      return "single source, unchecked";
    case "disputed":
      return "sources disagree";
    case "consistent":
      return "consistent with the stored copy (same feed — not independent)";
    case "stale":
      return "too old to rely on";
  }
}

/**
 * Weight multiplier for a fact at each trust level, for the evidence bus.
 *
 * `disputed` is 0.2 rather than 0: a disputed release is still a scheduled
 * release, and the fact that SOMETHING is happening at that hour survives the
 * disagreement about what the forecast is. Dropping it to zero would quietly
 * remove a real risk from the picture because two vendors argued about a
 * decimal.
 */
export function trustWeight(t: Trust): number {
  switch (t) {
    case "confirmed":
      return 1;
    case "consistent":
      return 0.75;
    case "single":
      return 0.6;
    case "disputed":
      return 0.2;
    case "stale":
      return 0;
  }
}

/* ------------------------------------------------------------- text keys -- */

/**
 * Words that carry no identity. Dropped before comparing two headlines.
 *
 * Deliberately short. A long stoplist starts removing words that ARE the story
 * — "spot", "futures" and "margin" all look like filler and all change what a
 * listing announcement means.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "at", "be", "for", "from", "in", "is", "of", "on", "or",
  "the", "to", "will", "with", "its", "has", "have", "new", "now", "up",
]);

/** Lowercase alphanumeric tokens, stopwords removed. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Jaccard overlap of two token sets. 0 when either is empty. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * Above this overlap two headlines are the same story — but see the asset gate
 * below, which does most of the actual work.
 *
 * MEASURED ON 170 REAL ANNOUNCEMENT TITLES (140 Binance, 30 Bybit), and the
 * measurement overturned the obvious design. Token overlap ALONE is close to
 * useless on exchange announcements, because they are templated: the ticker is
 * one token in ten and the other nine are boilerplate. At a threshold of 0.7 —
 * high enough that it feels safe — 18 of the 21 clusters it formed had merged
 * announcements about DIFFERENT assets. "BMT Trading Tournament: Trade to Share
 * Up to 400 BNB Token Vouchers" and the identical sentence about ENSO are 90%
 * the same string and are not the same story at all.
 *
 * That failure is the dangerous direction: merging two unrelated events reports
 * one as corroboration of the other, which is precisely the confidence this
 * module exists to refuse to manufacture.
 *
 * With the asset gate in front of it, wrong merges went to ZERO at 0.4, 0.5 and
 * 0.6 alike. 0.5 is taken as the middle of a range where the choice no longer
 * changes the answer.
 */
export const SAME_STORY = 0.5;

/**
 * Uppercase tokens that are never the asset a story is about.
 *
 * Quote currencies and product words appear in nearly every announcement, so
 * leaving them in would make every headline "share an asset" with every other
 * and defeat the gate entirely.
 */
const NOT_AN_ASSET = new Set([
  "USDT", "USDC", "USD", "USD1", "FDUSD", "TRY", "EUR", "BTC", "BNB",
  "API", "P2P", "VIP", "NFT", "AMA", "UTC", "ETF", "CEO", "AI", "IEO",
  "KYC", "OTC", "TGE", "APR", "APY",
]);

/**
 * Ticker-like tokens in a headline.
 *
 * Case matters and is the whole trick: "Spot" is a product word, "SPOT" would
 * be a ticker. Lowercasing before this runs — the natural thing to do, and what
 * `tokenise` does — destroys the only signal that separates two otherwise
 * identical templated announcements.
 */
export function assetsIn(title: string): Set<string> {
  const found = title.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? [];
  return new Set(found.filter((w) => !NOT_AN_ASSET.has(w)));
}

/**
 * Same story?
 *
 * The asset gate is STRICT: if EITHER side names an asset, they must share one.
 * The looser version — gate only when BOTH name assets — leaves an obvious hole,
 * and the measurement found it immediately: a headline naming no ticker slipped
 * past the gate and merged with a specific one. Only when NEITHER names an asset
 * does this fall back to overlap alone.
 */
function sameStory(aTitle: string, aAssets: ReadonlySet<string>, headTokens: readonly string[], headAssets: ReadonlySet<string>): boolean {
  if (aAssets.size > 0 || headAssets.size > 0) {
    let shared = false;
    for (const x of aAssets) {
      if (headAssets.has(x)) {
        shared = true;
        break;
      }
    }
    if (!shared) return false;
  }
  return similarity(tokenise(aTitle), headTokens) >= SAME_STORY;
}

/* ------------------------------------------------------ news corroboration */

export interface NewsItem {
  /** The PUBLISHER, not the article. Corroboration is counted in these. */
  readonly source: string;
  readonly title: string;
  readonly at: number;
  readonly url?: string;
  readonly category?: string;
}

export interface Story {
  readonly title: string;
  /** Earliest report. When the story BROKE, not when it was last repeated. */
  readonly at: number;
  readonly items: readonly NewsItem[];
  /** Distinct publishers. This, not `items.length`, drives trust. */
  readonly publishers: readonly string[];
  readonly trust: Trust;
}

export interface CorroborateOptions {
  readonly now: number;
  /** Older than this and a story is stale regardless of who carried it. */
  readonly staleAfterMs?: number;
}

const DEFAULT_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Group headlines into stories and say how well corroborated each is.
 *
 * Greedy single-pass clustering against cluster HEADS rather than full
 * pairwise linkage. Chosen deliberately: transitive linkage lets A~B and B~C
 * drag unrelated A and C into one cluster, and for headlines — where the
 * boilerplate is most of the string — that chains almost everything from one
 * venue into a single blob.
 */
export function corroborate(items: readonly NewsItem[], opts: CorroborateOptions): Story[] {
  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  /* Newest first, so the cluster head is the freshest wording of the story. */
  const sorted = items.slice().sort((a, b) => b.at - a.at);

  const clusters: { head: string[]; assets: Set<string>; items: NewsItem[] }[] = [];
  for (const item of sorted) {
    const assets = assetsIn(item.title);
    const hit = clusters.find((c) => sameStory(item.title, assets, c.head, c.assets));
    if (hit) {
      hit.items.push(item);
      for (const a of assets) hit.assets.add(a);
    } else {
      clusters.push({ head: tokenise(item.title), assets, items: [item] });
    }
  }

  return clusters
    .map((c): Story => {
      const publishers = [...new Set(c.items.map((i) => i.source))];
      const at = Math.min(...c.items.map((i) => i.at));
      const first = c.items[0] as NewsItem;
      const trust: Trust =
        opts.now - at > staleAfter
          ? "stale"
          : publishers.length > 1
            ? "confirmed"
            : "single";
      return { title: first.title, at, items: c.items, publishers, trust };
    })
    .sort((a, b) => {
      /* Corroborated first, then newest. A story two venues carry outranks a
         fresher one that only its own venue is talking about. */
      const rank = (s: Story): number =>
        s.trust === "confirmed" ? 0 : s.trust === "single" ? 1 : 2;
      return rank(a) - rank(b) || b.at - a.at;
    });
}

/* -------------------------------------------------- calendar reconciliation */

export interface DatedFact {
  readonly at: number;
  readonly currency: string;
  readonly title: string;
  readonly forecast?: string;
  readonly previous?: string;
}

export interface FieldDrift {
  readonly field: string;
  readonly a: string;
  readonly b: string;
}

export interface ReconciledEvent<T extends DatedFact> {
  readonly event: T;
  readonly trust: Trust;
  /** Empty when nothing disagreed. */
  readonly drift: readonly FieldDrift[];
  readonly note: string;
}

/**
 * How far apart two entries for the same release may sit and still be the same
 * release. Sources round to the minute differently and some publish in local
 * time with a stale DST offset; an hour is wide enough to survive that and
 * narrow enough that two different releases on the same day do not merge.
 */
export const SAME_EVENT_MS = 60 * 60 * 1000;

/**
 * Title overlap required to call two calendar entries the same release.
 *
 * MUCH stricter than SAME_STORY, and the difference was found in live data
 * rather than reasoned about. Reusing the news threshold here produced a FALSE
 * VERIFICATION on screen: "ISM Manufacturing Prices" was reported as agreeing
 * with the stored copy, which holds only high-impact events and does not
 * contain it. It had matched "ISM Manufacturing PMI" — same minute, same
 * currency, and a Jaccard of exactly 0.50, landing precisely on the news
 * threshold. Claiming a fact is cross-checked when it is not is the one
 * failure that makes this whole module worse than having no module.
 *
 * MEASURED against the real feeds: every genuinely matching pair scores 1.00,
 * because both copies carry the identical published title and the stored copy's
 * 48-character truncation never bites (the longest real title was 27). The
 * near-misses are the danger, and they run high: "Non-Farm Employment Change"
 * against "ADP Non-Farm Employment Change" scores 0.80 and they are completely
 * different releases from different agencies.
 *
 * 0.9 sits above every observed wrong match and below every right one. It is
 * deliberately NOT 1.0, to leave room for a source that truncates or
 * re-punctuates, but there is no evidence anything between 0.81 and 0.99 is
 * ever correct.
 */
export const SAME_EVENT_TITLE = 0.9;

function sameEvent(a: DatedFact, b: DatedFact): boolean {
  if (a.currency !== b.currency) return false;
  if (Math.abs(a.at - b.at) > SAME_EVENT_MS) return false;
  return similarity(tokenise(a.title), tokenise(b.title)) >= SAME_EVENT_TITLE;
}

/**
 * Reconcile a live calendar pull against a second copy.
 *
 * `independent` is the argument that decides what this function is ALLOWED to
 * claim, and it is required rather than defaulted because getting it wrong is
 * the one failure that makes the whole module lie. Passing `false` — the case
 * here, where the second copy is an hourly snapshot of the same upstream feed —
 * caps agreement at "consistent". Only genuinely separate providers may report
 * "confirmed".
 */
export function reconcileEvents<T extends DatedFact>(
  primary: readonly T[],
  secondary: readonly DatedFact[],
  independent: boolean,
): ReconciledEvent<T>[] {
  const agreed: Trust = independent ? "confirmed" : "consistent";

  return primary.map((event): ReconciledEvent<T> => {
    const match = secondary.find((s) => sameEvent(event, s));
    if (!match) {
      return {
        event,
        trust: "single",
        drift: [],
        note:
          secondary.length === 0
            ? "Only one calendar source is available."
            : "Present in the live feed only — the stored copy predates it or dropped it.",
      };
    }

    const drift: FieldDrift[] = [];
    /* Only compare fields BOTH sources actually filled. A blank forecast is a
       source not publishing one, not a source disagreeing about it. */
    for (const field of ["forecast", "previous"] as const) {
      const a = (event[field] ?? "").trim();
      const b = (match[field] ?? "").trim();
      if (a !== "" && b !== "" && a !== b) drift.push({ field, a, b });
    }

    if (drift.length > 0) {
      return {
        event,
        trust: "disputed",
        drift,
        note: `The two copies disagree on ${drift.map((d) => d.field).join(" and ")} — ${drift
          .map((d) => `${d.field} ${d.a} vs ${d.b}`)
          .join("; ")}. Neither has been chosen.`,
      };
    }

    return {
      event,
      trust: agreed,
      drift: [],
      note: independent
        ? "Two independent sources agree on the time and the figures."
        : "Matches the stored hourly copy. Same upstream feed, so this confirms the feed is steady, not that it is right.",
    };
  });
}

/* --------------------------------------------------- verification vs. tape */

export interface TapeCheck {
  /** True when the market visibly reacted in the window around the release. */
  readonly reacted: boolean;
  /** Range over the release window as a multiple of the typical bar range. */
  readonly ratio: number;
  readonly note: string;
}

/**
 * Above this multiple of the typical bar range, something happened.
 *
 * A scheduled high-impact release that produces a completely ordinary bar is
 * either mistimed in the calendar or was not the event the calendar thought it
 * was. Two is deliberately unambitious: it is looking for evidence the SCHEDULE
 * is right, not trying to measure the shock.
 */
export const REACTION_RATIO = 2;

export interface TapeBars {
  readonly t: ArrayLike<number>;
  readonly h: ArrayLike<number>;
  readonly l: ArrayLike<number>;
  readonly length: number;
}

/**
 * Check a PAST scheduled release against what the tape actually did.
 *
 * This is the only genuinely independent check available for the calendar, and
 * it is worth more than a second vendor would be: a vendor agreeing tells you
 * two websites copied the same wire, whereas a volatility spike at the stated
 * minute is the market itself confirming the timing.
 *
 * It can only ever run BACKWARDS, on releases that have already happened, and
 * it says nothing about a release still ahead — which is the one you care
 * about. So it scores the SOURCE's timing accuracy, not the coming event.
 */
export function checkAgainstTape(
  releaseAt: number,
  bars: TapeBars,
  windowMs: number,
): TapeCheck | null {
  if (bars.length < 20) return null;

  let inWindow = 0;
  let windowRange = 0;
  const ranges: number[] = [];

  for (let i = 0; i < bars.length; i += 1) {
    const t = bars.t[i] as number;
    const range = (bars.h[i] as number) - (bars.l[i] as number);
    if (!Number.isFinite(range)) continue;
    ranges.push(range);
    if (t >= releaseAt && t <= releaseAt + windowMs) {
      inWindow += 1;
      windowRange = Math.max(windowRange, range);
    }
  }

  if (inWindow === 0 || ranges.length === 0) return null;

  /* Median, not mean: the release bar itself is in the sample, and a mean that
     includes the spike raises the bar the spike has to clear. */
  const sorted = ranges.slice().sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1] as number;
  if (!(typical > 0)) return null;

  const ratio = windowRange / typical;
  return {
    reacted: ratio >= REACTION_RATIO,
    ratio,
    note:
      ratio >= REACTION_RATIO
        ? `Range over the release window was ${ratio.toFixed(1)}x the typical bar — the tape reacted when this source said it would.`
        : `Range over the release window was only ${ratio.toFixed(1)}x the typical bar — nothing visible happened at the stated time.`,
  };
}
