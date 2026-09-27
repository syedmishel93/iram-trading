"""
RSS and Atom, fetched and parsed here because the browser cannot.

WHY THIS IS ON THE SERVER
`app/src/data/news.ts` explains at length that it reads two venues' own
announcement feeds because those are the only ones VERIFIED to send
`Access-Control-Allow-Origin`. That is a real constraint and it is why the
terminal has never had general news: almost no newsroom serves CORS headers on
its RSS, so a browser-side reader gets a network error on nearly every feed and
there is no way to tell that apart from the feed being down.

Fetching here removes the constraint entirely, and adds two things worth having
on their own: the operator can point it at any feed they like, and the parsed
result can be cached so twelve feeds do not become twelve requests every time
somebody opens a desk.

WHAT IT WILL NOT DO
-------------------
**No content fetching.** Titles, links, timestamps and the source name. It does
not follow the link, does not download the article, and does not summarise it.
A trading terminal that renders remote HTML has given a stranger a script tag.

**No sentiment score.** Every vendor sells one and none of them is measurable
here. A headline's effect on a price is exactly the kind of claim this
repository refuses to make without a record, and there is no record.

**No ranking by importance.** Items are ordered by time, newest first, full
stop. "Important" would be this module having an opinion about which stories
matter, invisibly, in a bar the operator reads at a glance.

**Attribution is never dropped.** Same rule `ui/tape.ts` states: an
unattributed headline in a trading terminal is worse than no headline. The
source name rides with every item and the client is expected to render it.

TIMESTAMPS ARE THE HARD PART
----------------------------
RSS dates are RFC 822, Atom dates are RFC 3339, and real feeds violate both.
`parse_date` tries the standard parsers and then a short list of shapes seen in
the wild; an item whose date cannot be read gets `at: None` rather than
`time.time()`. Substituting "now" would make the oldest item in a broken feed
look like breaking news, which is the single worst thing a news bar can do.
"""

import email.utils
import hashlib
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC

# Cheap and correct: the stdlib parses both date formats and both feed formats,
# so this module needs no dependency at all. `feedparser` would be one more
# thing in requirements.txt for about forty lines of code.

USER_AGENT = "IRAM/55 (local terminal; +https://localhost)"

# Per feed. A slow newsroom must not hold up the other eleven.
TIMEOUT_S = 6.0

# Refuse anything larger. A feed is a few hundred kilobytes; a megabyte means
# something has gone wrong at the other end and reading it all is how a local
# service becomes a memory problem.
MAX_BYTES = 2_000_000

# Items kept per feed after sorting. Deep history belongs in an archive, not in
# a ticker.
MAX_PER_FEED = 40

# Nothing older than this is offered. A ticker showing last week is not a
# ticker; and an operator glancing at it cannot see the date.
MAX_AGE_S = 3 * 86_400

# How long a fetched feed is reused. Newsrooms publish in minutes, not seconds,
# and polling faster is rude to a free endpoint and useless to the reader.
CACHE_S = 120.0

# Atom lives in its own namespace; RSS does not use one.
ATOM = "{http://www.w3.org/2005/Atom}"

_cache: dict[str, tuple[float, dict]] = {}


# Only something that looks like an HTML TAG: "<" or "</" followed by a letter.
#
# A blanket `<[^>]+>` is wrong here and the test caught it. ElementTree has
# already unescaped entities by the time this runs, so a headline published as
# "Growth &lt;2% and CPI &gt;3%" arrives as "Growth <2% and CPI >3%" — and the
# blanket pattern matches "<2% and CPI >" and deletes the middle of the
# sentence, leaving "Growth 3%". Economic headlines contain comparisons
# constantly, which makes this the realistic case rather than a contrived one.
#
# Requiring a letter after the bracket keeps "<b>" a tag and leaves "<2%" and
# "< 2%" alone.
_TAG = re.compile(r"</?[a-zA-Z][^<>]*>")


def _clean(text):
    """Strip HTML tags and collapse whitespace. Titles arrive with both."""
    if not text:
        return ""
    out = _TAG.sub(" ", str(text))
    # Numeric and named entities that survive a CDATA section, where the parser
    # does no unescaping at all.
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " ")):
        out = out.replace(a, b)
    return re.sub(r"\s+", " ", out).strip()


def parse_date(raw):
    """
    Epoch milliseconds, or None.

    None rather than now(). An item whose date cannot be read is an item whose
    age is unknown, and rendering unknown age as "just now" would put a
    three-day-old headline at the top of a live ticker.
    """
    if not raw:
        return None
    text = str(raw).strip()

    # RFC 822 / 2822 — the RSS form. Handles the timezone names too.
    try:
        dt = email.utils.parsedate_to_datetime(text)
        if dt is not None:
            return dt.timestamp() * 1000.0
    except (TypeError, ValueError, IndexError):
        pass

    # RFC 3339 / ISO 8601 — the Atom form. Python 3.11+ takes "Z" directly;
    # the replace keeps it working if that ever changes.
    from datetime import datetime
    for shape in (text, text.replace("Z", "+00:00")):
        try:
            dt = datetime.fromisoformat(shape)
            if dt.tzinfo is None:
                # A naive timestamp is a feed that did not say. UTC is the only
                # defensible assumption and it is at worst a few hours out,
                # where guessing local time could be a day out.
                dt = dt.replace(tzinfo=UTC)
            return dt.timestamp() * 1000.0
        except ValueError:
            continue
    return None


def _text(node, *names):
    """First non-empty child among `names`, searched in order."""
    for name in names:
        found = node.find(name)
        if found is not None:
            value = _clean(found.text)
            if value:
                return value
    return ""


def _link(node):
    """RSS puts the URL in the text; Atom puts it in an href attribute."""
    rss = node.find("link")
    if rss is not None and (rss.text or "").strip():
        return rss.text.strip()
    for link in node.findall(f"{ATOM}link"):
        rel = link.get("rel", "alternate")
        if rel == "alternate" and link.get("href"):
            return link.get("href", "").strip()
    link = node.find(f"{ATOM}link")
    return (link.get("href", "").strip() if link is not None else "")


def parse_feed(xml_bytes, source):
    """
    Items from an RSS 2.0 or Atom document.

    Both shapes in one function because the difference is three element names,
    and two parsers would be two places for the date handling to drift.
    """
    root = ET.fromstring(xml_bytes)
    entries = root.iter("item")
    kind = "rss"
    found = list(entries)
    if not found:
        found = list(root.iter(f"{ATOM}entry"))
        kind = "atom"

    out = []
    for node in found:
        title = (
            _text(node, "title", f"{ATOM}title")
            if kind == "rss"
            else _text(node, f"{ATOM}title", "title")
        )
        if not title:
            continue
        link = _link(node)
        raw_date = _text(
            node, "pubDate", "published", f"{ATOM}published", f"{ATOM}updated", "updated", "date",
        )
        at = parse_date(raw_date)

        # Identity is the LINK where there is one, because the same story is
        # re-published with an edited title more often than with a new URL.
        seed = link or f"{source}|{title}"
        out.append({
            "id": hashlib.sha1(seed.encode("utf-8", "replace")).hexdigest()[:16],
            "title": title[:400],
            "link": link[:600],
            "source": source,
            "at": at,
        })
    return out


def reach_detail(reason):
    """The raw text, for the log. Never shown."""
    return f"{type(reason).__name__}: {reason}"


def reach_error(reason):
    """
    Why a feed could not be reached, ADDRESSED TO THE OPERATOR.

    It used to be `f"unreachable: {e.reason}"`, and `URLError.reason` is the
    underlying exception — so a machine without the issuer certificate in its
    store put this in the news panel, beside the source name, in red:

        unreachable: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify
        failed: unable to get local issuer certificate (_ssl.c:1082)

    A C source file and a line number, on the screen of somebody reading the
    news. CLAUDE.md's rule is the one `rss.ts` already follows on the client
    ("the news service is not answering on this address"): the operator gets
    the sentence, the log gets the raw. `reach_detail` is the raw half.

    Each branch says what the operator can DO about it, because the four
    causes below want four different actions — trust the certificate, fix the
    name, start the thing, or wait.
    """
    if isinstance(reason, ssl.SSLCertVerificationError):
        return "its security certificate could not be verified on this machine"
    if isinstance(reason, ssl.SSLError):
        return "the secure connection to it failed"
    if isinstance(reason, socket.gaierror):
        return "that address does not resolve — check the name, or the network"
    if isinstance(reason, ConnectionRefusedError):
        return "nothing is listening at that address"
    if isinstance(reason, TimeoutError | socket.timeout):
        return f"no answer within {int(TIMEOUT_S)}s"
    return "it could not be reached from this machine"


def fetch_feed(url, source, timeout=TIMEOUT_S):
    """
    One feed. Returns `(items, error)` — never raises.

    A dead feed must not take the other eleven with it, and the operator has to
    be told WHICH one died: a ticker that silently shows eleven feeds while the
    twelfth has been failing for a week is a ticker that is quietly lying about
    its coverage.
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return [], f"feed is larger than {MAX_BYTES // 1000}kB"
        return parse_feed(raw, source), None
    except urllib.error.HTTPError as e:
        return [], f"HTTP {e.code}"
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        print(f"[iram] rss: {source} at {url} — {reach_detail(reason)}", file=sys.stderr)
        return [], reach_error(reason)
    except ET.ParseError as e:
        return [], f"not valid XML: {e}"
    except Exception as e:  # noqa: BLE001 - one feed must never break the route
        return [], str(e)[:200]


def dedupe(items):
    """
    Collapse the same story arriving from several feeds.

    Keyed on the id, which is the link where there is one — a wire story
    syndicated to three sites has three URLs and stays three items, which is
    correct. What this catches is the same feed being listed twice and a feed
    that repeats an item across pages.

    The EARLIEST timestamp wins: it is when the story broke, not when the
    slowest aggregator noticed.
    """
    seen = {}
    for item in items:
        prev = seen.get(item["id"])
        if prev is None:
            seen[item["id"]] = item
            continue
        if item["at"] is not None and (prev["at"] is None or item["at"] < prev["at"]):
            seen[item["id"]] = item
    return list(seen.values())


def order(items, now_ms=None):
    """
    Newest first, undated last.

    Ordered by time and nothing else. Ranking by "importance" would be this
    module holding an invisible opinion about which stories matter, in a bar
    the operator reads at a glance and cannot interrogate.

    Undated items are kept rather than dropped — a headline whose age is
    unknown is still a headline — but they sort to the bottom, because the one
    thing that must never happen is an old item appearing at the top of a live
    ticker.
    """
    now = time.time() * 1000.0 if now_ms is None else now_ms
    fresh = [
        i for i in items
        if i["at"] is None or (now - i["at"]) <= MAX_AGE_S * 1000.0
    ]
    dated = sorted((i for i in fresh if i["at"] is not None), key=lambda i: -i["at"])
    undated = [i for i in fresh if i["at"] is None]
    return dated + undated


DEFAULT_FEEDS = [
    # Primary sources first: a central bank's own press page is the fastest and
    # least mediated thing on this list, and on gold it is the one that moves
    # the chart.
    {"source": "Federal Reserve", "url": "https://www.federalreserve.gov/feeds/press_all.xml"},
    {"source": "ECB", "url": "https://www.ecb.europa.eu/rss/press.html"},
    {"source": "BLS", "url": "https://www.bls.gov/feed/bls_latest.rss"},
    # Then the trade press, for the instruments this terminal actually carries.
    {"source": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
    {"source": "Cointelegraph", "url": "https://cointelegraph.com/rss"},
]


def load(feeds=None, now_ms=None):
    """
    Every feed, merged, with per-feed status.

    `feeds` defaults to `DEFAULT_FEEDS`. The status list is not decoration: the
    client renders it so that "quiet" and "broken" can be told apart, which is
    the same distinction the Flow desk had to learn to make.
    """
    chosen = DEFAULT_FEEDS if feeds is None else feeds
    now = time.time()
    items, status = [], []

    for feed in chosen:
        url = (feed.get("url") or "").strip()
        source = (feed.get("source") or url)[:60]
        if not url.lower().startswith(("http://", "https://")):
            status.append({"source": source, "url": url, "ok": False,
                           "error": "not an http(s) url", "items": 0})
            continue

        cached = _cache.get(url)
        if cached is not None and now - cached[0] < CACHE_S:
            entry = cached[1]
        else:
            got, err = fetch_feed(url, source)
            entry = {"items": got[:MAX_PER_FEED], "error": err}
            _cache[url] = (now, entry)

        status.append({
            "source": source,
            "url": url,
            "ok": entry["error"] is None,
            "error": entry["error"],
            "items": len(entry["items"]),
        })
        items.extend(entry["items"])

    merged = order(dedupe(items), now_ms)
    working = sum(1 for s in status if s["ok"])
    return {
        "items": merged,
        "status": status,
        "feeds": len(chosen),
        "working": working,
        # Said in words so the client can render it verbatim rather than
        # inventing its own phrasing for the same facts.
        "note": (
            f"{working} of {len(chosen)} feeds answered, {len(merged)} stories in the last "
            f"{MAX_AGE_S // 86400} days."
            if working
            else f"None of the {len(chosen)} feeds answered. This is a connection problem, not a quiet news day."
        ),
    }


def sanitise_feeds(raw):
    """
    Accept a caller's feed list, or refuse it.

    Rejects rather than repairs, and caps the count: a request with two hundred
    urls in it is a request to make this machine somebody's crawler.
    """
    if not isinstance(raw, list):
        return None
    out = []
    for entry in raw[:24]:
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        out.append({"url": url[:400], "source": str(entry.get("source") or url)[:60]})
    return out or None


def clear_cache():
    """Used by the tests, and by a caller that wants a forced refresh."""
    _cache.clear()
