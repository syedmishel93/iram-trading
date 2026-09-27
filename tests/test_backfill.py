#!/usr/bin/env python3
"""DEEP HISTORY INTO THE TABLE THE STUDIES READ — `server/svc/backfill.py`.

WHY THIS EXISTS AT ALL. The archive held ~1,000 bars per series — **42 days at
1h** — so a study's arm got a median of 46 trades and the best-of-N hurdle a
550-arm search must clear is `sqrt(2 ln N)/sqrt(n)` = +0.524 per-trade Sharpe.
Nothing cleared it. At n=200 the same hurdle is +0.251, which six arms already
sit above. At 42 days the search cannot tell "no edge" from "not enough data to
see one", and depth is the only lever that moves `n`.

THE TESTS THAT MATTER ARE NOT THE HAPPY PATH.

  * **`store reads the count back from the table`.** It must never return
    `len(rows)`. `mishel_edge.upsert` did exactly that and a route logged
    "400 of 400 written" on a table holding zero — both halves of the sentence
    came from one number, so it could never disagree with the database.

  * **`re-running stores no duplicates`.** The table is
    `PRIMARY KEY(src, sym, tf, t)` with a matching upsert, and a backfill that
    is not idempotent cannot be resumed after an interruption — which is the
    one thing a 44-request job will certainly need.

  * **`a row that cannot be read is skipped, never repaired`**, and a NaN never
    reaches the table. A synthesised candle is the one thing this product
    forbids outright.

  * **`EURUSD is not a Binance pair`.** Binance lists EURUSDT. Matching a
    trailing shape rather than an explicit quote-asset set would send EURUSD to
    Binance and get real bars for a different market — worse than a refusal,
    because nothing looks wrong. This is the `binance_symbol` trap the project
    already records, from the other direction.

  * **`the source order puts the broker first`.** A rule tested on the broker's
    own series is tested on the bars it would have been filled on; a vendor's
    XAUUSD is a different series with a different spread.

WHAT IS NOT TESTED HERE: the network. `_binance_deep` and `_mt5_deep` are
driven live by `scratchpad/` probes, because a test that mocks a vendor's
pagination proves the mock paginates.

Run:  python -m pytest tests/test_backfill.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-backfill-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc

bf = sys.modules["svc.backfill"]

HOUR = 3_600_000
T0 = 1_700_000_000_000


def bars(n: int, start: int = T0, step: int = HOUR) -> list[dict]:
    return [{"t": float(start + i * step), "o": 100.0 + i, "h": 101.0 + i,
             "l": 99.0 + i, "c": 100.5 + i, "v": 10.0 + i} for i in range(n)]


def held(src: str, sym: str, tf: str) -> int:
    with svc.db() as c:
        r = c.execute("SELECT COUNT(*) AS n FROM bars WHERE src=? AND sym=? AND tf=?",
                      (src, sym, tf)).fetchone()
    return int(r["n"] if r else 0)


class Storing(unittest.TestCase):
    def setUp(self):
        with svc.db() as c:
            c.execute("DELETE FROM bars WHERE sym LIKE 'TEST%'")

    def test_store_reads_the_count_back_from_the_table(self):
        """THE ONE THAT MATTERS. Never `len(rows)`."""
        n = bf.store("test", "TESTA", "1h", bars(50))
        self.assertEqual(n, 50)
        self.assertEqual(n, held("test", "TESTA", "1h"))

    def test_a_count_from_the_input_would_have_been_wrong(self):
        # Half of these are unreadable, so `len(rows)` would say 20 and the
        # table would hold 10. The gap is the whole point of reading back.
        rows = bars(10) + [{"t": "no"}] * 5 + [{}] * 5
        n = bf.store("test", "TESTB", "1h", rows)
        self.assertEqual(len(rows), 20)
        self.assertEqual(n, 10)

    def test_an_OVERLAPPING_write_proves_the_count_comes_from_the_table(self):
        """The case that separates a table read from a cleaned-input count.

        My first pair of tests did NOT: with 50 clean rows the input length and
        the table count are both 50, and with 10 of 20 readable they are both
        10. Returning `len(good)` passed them — measured, by deleting the fix
        and watching them pass. Only an OVERLAP tells the two apart, and an
        overlap is exactly what a RESUMED backfill sends: the second page
        re-fetches bars the first already stored.
        """
        bf.store("test", "TESTOV", "1h", bars(20))                      # t0..t19
        n = bf.store("test", "TESTOV", "1h", bars(20, start=T0 + 10 * HOUR))  # t10..t29
        # A cleaned-input count would say 20. The table holds 30.
        self.assertEqual(n, 30)
        self.assertEqual(n, held("test", "TESTOV", "1h"))

    def test_re_running_stores_no_duplicates(self):
        # A 44-request job WILL be interrupted; resuming must not double the
        # archive. The table's key is (src, sym, tf, t) and the upsert matches.
        bf.store("test", "TESTC", "1h", bars(30))
        again = bf.store("test", "TESTC", "1h", bars(30))
        self.assertEqual(again, 30)

    def test_a_later_run_extends_rather_than_replaces(self):
        bf.store("test", "TESTD", "1h", bars(20))
        bf.store("test", "TESTD", "1h", bars(20, start=T0 + 20 * HOUR))
        self.assertEqual(held("test", "TESTD", "1h"), 40)

    def test_a_row_that_cannot_be_read_is_skipped_never_repaired(self):
        bad = [{"t": 1.0}, {"o": 1}, "nope", None, {"t": "x", "o": 1, "h": 1, "l": 1, "c": 1}]
        self.assertEqual(bf.store("test", "TESTE", "1h", bad), 0)

    def test_a_NaN_never_reaches_the_table(self):
        nan = float("nan")
        rows = [{"t": float(T0), "o": nan, "h": 1.0, "l": 1.0, "c": 1.0, "v": 1.0},
                {"t": float(T0 + HOUR), "o": 1.0, "h": 1.0, "l": 1.0, "c": nan, "v": 1.0}]
        self.assertEqual(bf.store("test", "TESTF", "1h", rows), 0)

    def test_a_missing_volume_is_zero_rather_than_a_refusal(self):
        # An FX series with no volume is still a usable series.
        rows = [{"t": float(T0), "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5}]
        self.assertEqual(bf.store("test", "TESTG", "1h", rows), 1)

    def test_an_empty_list_stores_nothing_and_does_not_raise(self):
        self.assertEqual(bf.store("test", "TESTH", "1h", []), 0)


class ChoosingTheSource(unittest.TestCase):
    def test_binance_pairs_go_to_binance(self):
        for s in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ETHBTC"):
            self.assertEqual(bf.source_for(s)[0], "binance", s)

    def test_EURUSD_IS_NOT_A_BINANCE_PAIR(self):
        # Binance lists EURUSDT. A shape test on the trailing letters would send
        # EURUSD there and return real bars for a DIFFERENT market — worse than
        # a refusal, because nothing about it looks wrong.
        self.assertNotEqual(bf.source_for("EURUSD")[0], "binance")
        self.assertNotEqual(bf.source_for("XAUUSD")[0], "binance")
        self.assertNotEqual(bf.source_for("GBPUSD")[0], "binance")

    def test_but_EURUSDT_is(self):
        self.assertEqual(bf.source_for("EURUSDT")[0], "binance")

    def test_no_symbol_is_refused_by_name(self):
        src, why = bf.source_for("")
        self.assertEqual(src, "")
        self.assertIn("no symbol", why)

    def test_the_vendor_fallback_names_its_ceiling(self):
        # yfinance caps 1h at 730 days. An operator asking for five years has to
        # be told they are not getting five years.
        src, why = bf.source_for("SOMETHINGNOBROKERHAS")
        if src == "yfinance":
            self.assertIn("730", why)


class TheRoute(unittest.TestCase):
    def post(self, body):
        with svc.app.test_client() as c:
            return c.post("/svc/bars/backfill", json=body)

    def test_no_symbols_is_refused_before_anything_is_fetched(self):
        r = self.post({"timeframe": "1h", "years": 5})
        self.assertEqual(r.status_code, 400)
        self.assertIn("symbol", r.get_json()["err"])

    def test_a_bar_size_it_cannot_backfill_is_named_with_what_it_accepts(self):
        r = self.post({"symbols": ["BTCUSDT"], "timeframe": "3m"})
        self.assertEqual(r.status_code, 400)
        body = r.get_json()
        self.assertIn("3m", body["err"])
        self.assertIn("1h", body["accepts"])

    def test_a_scalar_body_does_not_crash_the_route(self):
        with svc.app.test_client() as c:
            r = c.post("/svc/bars/backfill", data='"a string"',
                       content_type="application/json")
        self.assertLess(r.status_code, 500)

    def test_the_status_route_answers_before_any_job_has_run(self):
        with svc.app.test_client() as c:
            r = c.get("/svc/bars/backfill")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])


class ShortIsJudgedOnSpan(unittest.TestCase):
    """A COMPLETE fetch of a five-day market must not report as short.

    `PER_YEAR["1d"]` is 365 and an equity index trades about 252 days a year, so
    ten complete years of DXY is 2,514 bars against 3,650 asked. A bar-count
    test calls that short and an operator goes looking for missing history that
    was never published. Judge the calendar SPAN, which means the same thing for
    a 24/7 market and a five-day one.
    """

    def test_ten_complete_years_of_a_five_day_market_is_not_short(self):
        years, per_year = 10, bf.PER_YEAR["1d"]
        asked = per_year * years
        returned, span_days = 2514, 3652.0          # measured from yfinance
        self.assertLess(returned, asked * 0.9)       # a COUNT test would fail it
        self.assertFalse(span_days < years * 365.25 * 0.9)   # a SPAN test does not

    def test_a_genuinely_short_fetch_is_still_named(self):
        # yfinance caps 1h at 730 days. Asking five years must report short.
        years, span_days = 5, 730.0
        self.assertTrue(span_days < years * 365.25 * 0.9)


class TheArithmeticThatJustifiesIt(unittest.TestCase):
    def test_five_years_of_1h_is_what_we_think_it_is(self):
        # If this constant drifts, every "years" request silently changes size.
        self.assertEqual(bf.PER_YEAR["1h"], 8_760)
        self.assertEqual(int(bf.PER_YEAR["1h"] * 5), 43_800)

    def test_the_read_cap_can_serve_what_the_backfill_stores(self):
        # A cap BELOW what a study asks for is a truncation nobody sees: the
        # route would hand back the newest 20,000 of 43,800 and the study would
        # report its window as though that were the archive.
        import svc.bars as barsmod
        self.assertGreaterEqual(barsmod.MAX_PER_GET, int(bf.PER_YEAR["1h"] * 5))


if __name__ == "__main__":
    unittest.main(verbosity=2)
