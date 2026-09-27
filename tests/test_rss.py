"""
RSS and Atom parsing.

The dates carry most of the risk here. RSS is RFC 822, Atom is RFC 3339, and
real feeds violate both — so most of these tests are about a date that cannot
be read producing None rather than now(), because substituting the current time
would put the oldest item in a broken feed at the top of a live ticker.
"""

# ---------------------------------------------------------------------------
# This file used to live in `server/`, beside the module it tests, so
# `import mishel_rss` resolved for free. It moved here because a test
# directory that holds only some of the tests is worse than none: the gate ran
# what it could see, and three files sat outside it for months.
#
# The cost of the move is these four lines. `server/` is a flat directory of
# top-level modules rather than a package, so a test anywhere else has to put
# it on the path. Every other file in `tests/` does the same thing; see
# `conftest.py` for why the duplication stays.
# ---------------------------------------------------------------------------
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import mishel_rss as R

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>Fed holds rates steady</title>
    <link>https://example.com/a</link>
    <pubDate>Wed, 03 Sep 2026 11:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Gold &amp; the dollar]]></title>
    <link>https://example.com/b</link>
    <pubDate>Wed, 03 Sep 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>"""

ATOM = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title>ECB statement</title>
    <link rel="alternate" href="https://example.org/x"/>
    <published>2026-09-03T11:30:00Z</published>
  </entry>
</feed>"""

NOW = 1788_000_000_000.0


class Dates(unittest.TestCase):
    def test_reads_the_rss_form(self):
        self.assertIsNotNone(R.parse_date("Wed, 03 Sep 2026 11:00:00 GMT"))

    def test_reads_the_atom_form(self):
        self.assertIsNotNone(R.parse_date("2026-09-03T11:30:00Z"))

    def test_returns_none_for_a_date_it_cannot_read(self):
        """None, never now(). A substituted timestamp puts the oldest item in a
        broken feed at the top of a live ticker."""
        for bad in ("", None, "last Tuesday", "2026-13-45", "soon"):
            self.assertIsNone(R.parse_date(bad), bad)

    def test_assumes_utc_for_a_naive_timestamp(self):
        """A feed that did not say. UTC is at worst a few hours out; guessing
        the server's local time could be a whole day out."""
        self.assertIsNotNone(R.parse_date("2026-09-03T11:30:00"))


class Parsing(unittest.TestCase):
    def test_parses_rss(self):
        items = R.parse_feed(RSS.encode(), "Example")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["title"], "Fed holds rates steady")
        self.assertEqual(items[0]["link"], "https://example.com/a")
        self.assertEqual(items[0]["source"], "Example")

    def test_parses_atom_including_the_href_link(self):
        """RSS puts the URL in the element text, Atom in an href attribute."""
        items = R.parse_feed(ATOM.encode(), "ECB")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["link"], "https://example.org/x")

    def test_unescapes_entities_and_strips_tags(self):
        items = R.parse_feed(RSS.encode(), "Example")
        self.assertEqual(items[1]["title"], "Gold & the dollar")

    def test_keeps_comparisons_in_a_headline(self):
        """
        The bug this test found.

        ElementTree unescapes entities before anything here runs, so a headline
        published as "Growth &lt;2% and CPI &gt;3%" arrives as
        "Growth <2% and CPI >3%". A blanket `<[^>]+>` strip then matched
        "<2% and CPI >" and produced "Growth 3%" — the middle of the sentence
        silently deleted. Economic headlines carry comparisons constantly.
        """
        xml = ('<rss version="2.0"><channel><item>'
               "<title>Growth &lt;2% and CPI &gt;3%</title>"
               "<link>u</link></item></channel></rss>")
        self.assertEqual(
            R.parse_feed(xml.encode(), "S")[0]["title"], "Growth <2% and CPI >3%"
        )

    def test_still_strips_real_markup(self):
        xml = ('<rss version="2.0"><channel><item>'
               "<title>a &lt;b&gt;bold&lt;/b&gt; c</title>"
               "<link>u</link></item></channel></rss>")
        self.assertEqual(R.parse_feed(xml.encode(), "S")[0]["title"], "a bold c")

    def test_skips_an_item_with_no_title(self):
        xml = '<rss version="2.0"><channel><item><link>u</link></item></channel></rss>'
        self.assertEqual(R.parse_feed(xml.encode(), "S"), [])

    def test_identity_is_the_link_where_there_is_one(self):
        """The same story is re-published with an edited title far more often
        than with a new URL."""
        a = '<rss version="2.0"><channel><item><title>One</title><link>u</link></item></channel></rss>'
        b = '<rss version="2.0"><channel><item><title>One, updated</title><link>u</link></item></channel></rss>'
        self.assertEqual(
            R.parse_feed(a.encode(), "S")[0]["id"], R.parse_feed(b.encode(), "S")[0]["id"]
        )


class Fetching(unittest.TestCase):
    def test_a_dead_feed_returns_an_error_and_never_raises(self):
        """One newsroom being down must not take the other eleven with it, and
        the operator has to be told which one."""
        items, err = R.fetch_feed("http://127.0.0.1:1/nothing.xml", "Dead", timeout=1.0)
        self.assertEqual(items, [])
        self.assertIsNotNone(err)

    def test_refuses_a_url_that_is_not_http(self):
        out = R.load([{"url": "file:///etc/passwd", "source": "Local"}])
        self.assertFalse(out["status"][0]["ok"])
        self.assertIn("not an http", out["status"][0]["error"])
        self.assertEqual(out["items"], [])


class Ordering(unittest.TestCase):
    def _item(self, i, at):
        return {"id": str(i), "title": f"t{i}", "link": "", "source": "S", "at": at}

    def test_newest_first(self):
        got = R.order([self._item(1, NOW - 5000), self._item(2, NOW)], now_ms=NOW)
        self.assertEqual([i["id"] for i in got], ["2", "1"])

    def test_undated_items_are_kept_but_sink_to_the_bottom(self):
        """A headline whose age is unknown is still a headline. What must never
        happen is one appearing at the TOP of a live ticker."""
        got = R.order([self._item(1, None), self._item(2, NOW)], now_ms=NOW)
        self.assertEqual([i["id"] for i in got], ["2", "1"])

    def test_drops_items_older_than_the_window(self):
        old = NOW - (R.MAX_AGE_S + 3600) * 1000
        got = R.order([self._item(1, old), self._item(2, NOW)], now_ms=NOW)
        self.assertEqual([i["id"] for i in got], ["2"])


class Dedupe(unittest.TestCase):
    def test_keeps_the_earliest_timestamp_for_a_repeated_story(self):
        """When the story broke, not when the slowest aggregator noticed."""
        rows = [
            {"id": "x", "title": "t", "link": "u", "source": "A", "at": NOW},
            {"id": "x", "title": "t", "link": "u", "source": "B", "at": NOW - 60_000},
        ]
        out = R.dedupe(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["at"], NOW - 60_000)

    def test_leaves_distinct_urls_alone(self):
        """A wire story syndicated to three sites has three URLs and stays
        three items. That is correct, not a miss."""
        rows = [
            {"id": "a", "title": "t", "link": "u1", "source": "A", "at": NOW},
            {"id": "b", "title": "t", "link": "u2", "source": "B", "at": NOW},
        ]
        self.assertEqual(len(R.dedupe(rows)), 2)


class FeedList(unittest.TestCase):
    def test_rejects_a_non_list(self):
        self.assertIsNone(R.sanitise_feeds("https://example.com/rss"))

    def test_drops_entries_that_are_not_http_urls(self):
        out = R.sanitise_feeds([
            {"url": "https://ok.example/rss", "source": "OK"},
            {"url": "javascript:alert(1)", "source": "Bad"},
            {"url": "file:///etc/passwd"},
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["source"], "OK")

    def test_caps_the_count(self):
        """Two hundred urls is a request to make this machine somebody's
        crawler."""
        many = [{"url": f"https://e{i}.example/rss"} for i in range(200)]
        self.assertEqual(len(R.sanitise_feeds(many)), 24)

    def test_returns_none_when_nothing_survives(self):
        """None means "use the defaults", which is right: a request whose every
        entry was junk should not produce an empty ticker."""
        self.assertIsNone(R.sanitise_feeds([{"url": "nope"}]))


class ReachErrors(unittest.TestCase):
    """
    THE MESSAGE IS ADDRESSED TO THE OPERATOR.

    A feed whose certificate could not be verified reported itself in the news
    panel as

        ECB   unreachable: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify
              failed: unable to get local issuer certificate (_ssl.c:1082)

    which names a C source file and a line number on the screen of somebody
    trying to read the news. CLAUDE.md's rule is that the operator gets the
    sentence and the log gets the raw text; these pin the sentence AND that the
    raw text is still carried for the log.
    """

    def test_a_certificate_failure_reads_as_one(self):
        import ssl

        why = R.reach_error(ssl.SSLCertVerificationError(
            1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
               "unable to get local issuer certificate (_ssl.c:1082)"))
        self.assertIn("certificate", why)
        self.assertNotIn("_ssl.c", why)
        self.assertNotIn("CERTIFICATE_VERIFY_FAILED", why)

    def test_a_name_that_does_not_resolve_says_so(self):
        import socket

        why = R.reach_error(socket.gaierror(-2, "Name or service not known"))
        self.assertIn("address", why)
        self.assertNotIn("gaierror", why)

    def test_a_refused_connection_says_nothing_is_listening(self):
        why = R.reach_error(ConnectionRefusedError(111, "Connection refused"))
        self.assertIn("listening", why)

    def test_a_timeout_names_the_wait(self):
        why = R.reach_error(TimeoutError("timed out"))
        self.assertIn("answer", why)
        self.assertIn(str(int(R.TIMEOUT_S)), why)

    def test_an_unknown_reason_still_reads_as_a_sentence(self):
        """No list covers every errno. The fallback must still be words, and
        must not be the empty string — a blank beside a source name is worse
        than a vague one."""
        why = R.reach_error(OSError(99, "Cannot assign requested address"))
        self.assertTrue(why[0].islower() or why[0].isalpha())
        self.assertGreater(len(why), 12)

    def test_the_raw_text_is_kept_for_the_log(self):
        """Translating for the screen must not lose what a developer needs."""
        import ssl

        raw = ("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
               "unable to get local issuer certificate (_ssl.c:1082)")
        self.assertIn("_ssl.c:1082", R.reach_detail(ssl.SSLCertVerificationError(1, raw)))


class Load(unittest.TestCase):
    def setUp(self):
        R.clear_cache()

    def test_says_so_plainly_when_nothing_answered(self):
        out = R.load([{"url": "http://127.0.0.1:1/a.xml", "source": "Dead"}])
        self.assertEqual(out["working"], 0)
        self.assertIn("connection problem", out["note"])


if __name__ == "__main__":
    unittest.main()
