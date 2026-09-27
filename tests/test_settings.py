#!/usr/bin/env python3
"""OPERATOR-SETTABLE SERVER CONFIG — `server/svc/settings.py`.

WHY THIS MODULE EXISTS, which is what these pin.

`scratchpad/svcsweep.py` asked one mechanical question of all 61 backend modules
-- which config keys are READ by something and written by nothing -- and after
triage two survived:

  `store_budget_gb`   `svc/store.py budget_bytes()` reads it and the whole
                      eviction policy enforces it. Nothing could set it. And the
                      refusal the eviction planner raises when a budget cannot be
                      met without deleting recent history advises "raise the
                      budget, or drop a market" -- so the product was naming a
                      remedy it did not offer. `svc/store.py`'s own comment says
                      "anything beyond this is a deliberate choice", describing a
                      choice that could not be made.

  `pair_scan_tg`      gates the new-pair Telegram alert, defaults off, and nothing
                      could turn it on.

Same family as `bars_enrolled`: a key one module read and zero modules wrote, so
its loop ticked hourly, reported a fresh tick age, and produced no work for a
whole release.

THE TEST THAT MATTERS MOST IS `test_the_setting_reaches_the_code_that_reads_it`.
A setting that is written and never read is the same defect from the other side,
and asserting the row landed in `config` would prove nothing about that.

AND `test_the_default_has_one_owner`. This module held the literal "20" for one
draft while `svc/store.py` said 5 -- two owners for one default, disagreeing on
the first day. The default is now a callable reading the owning module, and this
test fails if anyone restates it.

Run:  python -m pytest tests/test_settings.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-settings-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc

st = sys.modules["svc.settings"]
store = sys.modules["svc.store"]
core = sys.modules["svc.core"]

GB = 1_073_741_824


class Base(unittest.TestCase):
    def setUp(self):
        svc.app.config["TESTING"] = True
        with svc.db() as c:
            # `svc_token` is cleared too, and that is not housekeeping. The
            # credential-leak test below WRITES it as a sentinel, and the auth
            # guard refuses every `/svc*` request once a token is configured --
            # so leaving it behind made two later route tests fail as
            # "unauthorized" for a reason that had nothing to do with them. A
            # test that writes a credential into shared config poisons its
            # siblings, and the failure it produces points at the wrong code.
            c.execute("DELETE FROM config WHERE k IN "
                      "('store_budget_gb','pair_scan_tg','svc_token')")


class ItReachesTheReader(Base):
    def test_the_setting_reaches_the_code_that_reads_it(self):
        """THE POINT OF THE MODULE. A written setting nobody reads is the same bug."""
        before = store.budget_bytes()
        self.assertEqual(before, store.DEFAULT_BUDGET_GB * GB)

        self.assertTrue(st.set_setting("store_budget_gb", 120)["ok"])
        self.assertEqual(store.budget_bytes(), 120 * GB)
        self.assertNotEqual(store.budget_bytes(), before)

    def test_the_alert_flag_reaches_its_reader(self):
        self.assertEqual(core.cfg("pair_scan_tg", "0"), "0", "off by default")
        st.set_setting("pair_scan_tg", "on")
        self.assertEqual(core.cfg("pair_scan_tg", "0"), "1")

    def test_a_fractional_budget_survives_the_round_trip(self):
        st.set_setting("store_budget_gb", 2.5)
        self.assertEqual(store.budget_bytes(), int(2.5 * GB))


class OneOwner(Base):
    def test_the_default_has_one_owner(self):
        """This module said 20 while store.py said 5. Never again."""
        row = next(r for r in st.current() if r["key"] == "store_budget_gb")
        self.assertEqual(row["default"], str(store.DEFAULT_BUDGET_GB))

    def test_chosen_and_merely_defaulted_are_different_facts(self):
        row = next(r for r in st.current() if r["key"] == "store_budget_gb")
        self.assertTrue(row["isDefault"], "nothing has been set yet")

        st.set_setting("store_budget_gb", store.DEFAULT_BUDGET_GB)
        row = next(r for r in st.current() if r["key"] == "store_budget_gb")
        self.assertFalse(
            row["isDefault"],
            "the SAME number chosen deliberately is not the same fact as nobody "
            "having chosen; only one of them means it was thought about",
        )

    def test_every_setting_names_the_code_that_reads_it(self):
        for row in st.current():
            self.assertTrue(row["readBy"], row["key"])
            module = row["readBy"].split()[0].replace("svc/", "").replace(".py", "")
            self.assertIn(module, sys.modules.get("svc." + module).__name__,
                          "%s names a reader that does not exist" % row["key"])


class RefusesWhatItMust(Base):
    def test_a_credential_key_is_refused_by_name(self):
        """THE WHITELIST IS A SECURITY BOUNDARY, not tidiness.

        `cfg()` also holds `svc_token`, `tg_token` and `tg_chat`. A route that
        writes any key rewrites the service's own auth token from the browser.
        """
        for key in ("svc_token", "tg_token", "tg_chat"):
            got = st.set_setting(key, "hijacked")
            self.assertFalse(got["ok"], key)
            self.assertIsNone(core.cfg(key, None), "%s must not have been written" % key)

    def test_an_unknown_key_says_what_IS_settable(self):
        got = st.set_setting("nonsense", "1")
        self.assertFalse(got["ok"])
        self.assertEqual(got["settable"], sorted(st.SETTABLE))

    def test_a_non_number_budget_is_refused(self):
        self.assertFalse(st.set_setting("store_budget_gb", "banana")["ok"])
        self.assertEqual(store.budget_bytes(), store.DEFAULT_BUDGET_GB * GB)

    def test_nan_and_infinity_are_refused(self):
        """`float("nan")` PARSES, then compares False against every bound."""
        for bad in (float("nan"), float("inf"), float("-inf")):
            got = st.set_setting("store_budget_gb", bad)
            self.assertFalse(got["ok"], repr(bad))

    def test_a_budget_of_zero_is_refused(self):
        """Zero asks the planner to delete everything, which it would refuse."""
        got = st.set_setting("store_budget_gb", 0)
        self.assertFalse(got["ok"])
        self.assertIn("smallest", got["why"])

    def test_an_absurd_budget_is_refused(self):
        self.assertFalse(st.set_setting("store_budget_gb", 99999)["ok"])

    def test_a_flag_that_is_neither_on_nor_off_is_refused(self):
        self.assertFalse(st.set_setting("pair_scan_tg", "maybe")["ok"])

    def test_the_usual_spellings_of_on_and_off_all_work(self):
        for raw, want in [(True, "1"), ("on", "1"), ("yes", "1"), (1, "1"),
                          (False, "0"), ("off", "0"), ("no", "0"), (0, "0")]:
            self.assertTrue(st.set_setting("pair_scan_tg", raw)["ok"], repr(raw))
            self.assertEqual(core.cfg("pair_scan_tg", None), want, repr(raw))


class Routes(Base):
    def test_the_route_lists_the_settings_with_what_each_does(self):
        with svc.app.test_client() as c:
            body = c.get("/svc/settings").get_json()
        self.assertTrue(body["ok"])
        self.assertEqual({s["key"] for s in body["settings"]}, set(st.SETTABLE))
        for s in body["settings"]:
            self.assertTrue(s["what"], "a setting with no explanation is a mystery knob")

    def test_the_route_sets_one(self):
        with svc.app.test_client() as c:
            body = c.post("/svc/settings", json={"key": "store_budget_gb",
                                                 "value": 42}).get_json()
        self.assertTrue(body["ok"], body)
        self.assertEqual(store.budget_bytes(), 42 * GB)

    def test_the_route_refuses_a_credential(self):
        with svc.app.test_client() as c:
            body = c.post("/svc/settings", json={"key": "svc_token",
                                                 "value": "x"}).get_json()
        self.assertFalse(body["ok"])

    def test_a_missing_value_is_not_read_as_off(self):
        """An absent field is not a value. `{"key": x}` with no value must refuse."""
        with svc.app.test_client() as c:
            body = c.post("/svc/settings", json={"key": "pair_scan_tg"}).get_json()
        self.assertFalse(body["ok"])
        self.assertIsNone(core.cfg("pair_scan_tg", None))

    def test_no_route_returns_a_credential(self):
        with svc.db() as c:
            c.execute("INSERT INTO config(k,v) VALUES('svc_token','tok-sentinel-991') "
                      "ON CONFLICT(k) DO UPDATE SET v=excluded.v")
        with svc.app.test_client() as c:
            body = c.get("/svc/settings").get_data(as_text=True)
        self.assertNotIn("tok-sentinel-991", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
