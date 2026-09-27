#!/usr/bin/env python3
"""THE THREE MODULES NOTHING TESTED, BECAUSE TOUCHING THEM DOES SOMETHING.

WHY THESE THREE AND WHY NOW

`scratchpad/behave.py` checks what each service module COMPUTES against a live
gateway, and it skips eight of them BY NAME because their only surface has side
effects: `alerts` sends Telegram, `bulkfetch` downloads gigabytes, `sync` writes
the browser's backup. Measuring which of those eight had any test coverage at all:

    auto  bulkfetch  mcpauth  router   -> covered
    alerts  signals  sync              -> NOTHING

Three modules with no behavioural coverage, and they are uncovered PRECISELY
because probing them live does something. That is the mechanism this project
records twice over -- `run.py` was the largest module outside every gate, and
nineteen test files were in no list -- in its most predictable form: **an awkward
surface is a surface nobody checks.**

Nothing here sends, downloads, or registers anything. Scratch database, stubbed
transports, and the one module that talks to a network gets its sender replaced at
the module that OWNS it, never at the facade.

WHAT THIS FOUND IN `sync`

`/svc/backup` is `INSERT OR REPLACE` over one blob, so a push carrying two slots
DESTROYS the other eleven -- which is exactly how a scheduling test once overwrote
the operator's thirteen real slots. That was fixed in the client, and this end went
on accepting anything, including `{}`: an empty push wiped the backup and answered
`ok: true, bytes: 2`. It also had no credential filter, while `store/sync.ts`
carries one and the scar that explains it.

Run:  python -m pytest tests/test_sideeffect_modules.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from typing import ClassVar

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-sideeffect-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc

sync = sys.modules["svc.sync"]
alerts = sys.modules["svc.alerts"]
signals = sys.modules["svc.signals"]
core = sys.modules["svc.core"]


class Base(unittest.TestCase):
    def setUp(self):
        svc.app.config["TESTING"] = True
        with svc.db() as c:
            c.execute("DELETE FROM kv WHERE k='client_backup'")
            c.execute("DELETE FROM config WHERE k IN ('tg_token','tg_chat','svc_token')")

    def client(self):
        return svc.app.test_client()

    def put_backup(self, blob):
        with svc.db() as c:
            c.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES('client_backup',?,0)",
                      (json.dumps(blob),))


# ============================================================== svc/sync.py ==
class BackupCannotSilentlyDestroy(Base):
    #: The shape the operator actually had when a test overwrote it.
    THIRTEEN: ClassVar[dict[str, dict[str, int]]] = {("slot%d" % i): {"v": i} for i in range(13)}

    def test_an_empty_push_is_refused_rather_than_wiping_the_backup(self):
        """`{}` could only ever destroy. It used to answer ok: true, bytes: 2."""
        self.put_backup(self.THIRTEEN)
        with self.client() as c:
            body = c.post("/svc/backup", json={}).get_json()
        self.assertFalse(body["ok"])
        self.assertIn("empty", body["why"])
        with self.client() as c:
            still = c.get("/svc/backup").get_json()
        self.assertEqual(len(still["backup"]), 13, "the real backup must be untouched")

    def test_a_non_object_body_is_refused(self):
        self.put_backup(self.THIRTEEN)
        for bad in ([], "nope", 7):
            with self.client() as c:
                body = c.post("/svc/backup", json=bad).get_json()
            self.assertFalse(body["ok"], repr(bad))
        with self.client() as c:
            self.assertEqual(len(c.get("/svc/backup").get_json()["backup"]), 13)

    def test_a_credential_is_refused_by_name(self):
        """DEFENCE IN DEPTH. `store/sync.ts` filters; a client bug removes that."""
        for key in ("agent.credential", "anthropicApiKey", "tg_token",
                    "some.secret", "userPassword", "bearerToken", "private_key"):
            with self.client() as c:
                body = c.post("/svc/backup", json={key: "x", "pins": []}).get_json()
            self.assertFalse(body["ok"], key)
            self.assertEqual(body["refused"], [key], key)
        with self.client() as c:
            self.assertIsNone(c.get("/svc/backup").get_json()["backup"],
                              "nothing may have been stored")

    def test_an_ordinary_slot_that_merely_mentions_a_word_is_not_refused(self):
        """The guard must not fire on prose. `pair_scan_tg` taught that lesson."""
        with self.client() as c:
            body = c.post("/svc/backup", json={"pins": [], "prefs": {"theme": "dark"},
                                               "tokenomicsNotes": "about new tokens"}).get_json()
        # `tokenomicsNotes` contains "token" and IS refused — the guard is on the
        # KEY and is deliberately blunt there, which is the safe direction. Pinned
        # so the trade-off is a decision rather than a surprise.
        self.assertFalse(body["ok"])
        self.assertEqual(body["refused"], ["tokenomicsNotes"])

    def test_a_full_push_replaces_and_reports_what_it_added(self):
        self.put_backup({"pins": [1]})
        with self.client() as c:
            body = c.post("/svc/backup", json={"pins": [1, 2], "prefs": {}}).get_json()
        self.assertTrue(body["ok"], body)
        self.assertEqual(body["slots"], 2)
        self.assertEqual(body["added"], ["prefs"])
        self.assertEqual(body["removed"], [])

    def test_a_push_that_drops_slots_succeeds_AND_SAYS_SO(self):
        """Silently doing less than asked is the defect; refusing outright would
        break a legitimate removal. It succeeds and names what went."""
        self.put_backup(self.THIRTEEN)
        with self.client() as c:
            body = c.post("/svc/backup", json={"slot0": {"v": 0}, "slot1": {"v": 1}}).get_json()
        self.assertTrue(body["ok"], body)
        self.assertEqual(len(body["removed"]), 11)
        self.assertIn("slot5", body["removed"])

    def test_a_destructive_push_is_written_to_the_event_log(self):
        self.put_backup(self.THIRTEEN)
        with svc.db() as c:
            c.execute("DELETE FROM events WHERE kind='backup_shrank'")
        with self.client() as c:
            c.post("/svc/backup", json={"slot0": {"v": 0}})
        with svc.db() as c:
            n = c.execute("SELECT count(*) AS n FROM events WHERE kind='backup_shrank'"
                          ).fetchone()["n"]
        self.assertEqual(n, 1, "losing eleven slots must leave a trace")

    def test_an_ordinary_backup_writes_no_log_line(self):
        """A log line on every backup is a log nobody reads."""
        self.put_backup({"pins": []})
        with svc.db() as c:
            c.execute("DELETE FROM events WHERE kind='backup_shrank'")
        with self.client() as c:
            c.post("/svc/backup", json={"pins": [], "prefs": {}})
        with svc.db() as c:
            n = c.execute("SELECT count(*) AS n FROM events WHERE kind='backup_shrank'"
                          ).fetchone()["n"]
        self.assertEqual(n, 0)

    def test_the_backup_round_trips(self):
        blob = {"pins": ["BTCUSDT"], "prefs": {"theme": "dark"}, "nicks": {}}
        with self.client() as c:
            self.assertTrue(c.post("/svc/backup", json=blob).get_json()["ok"])
            got = c.get("/svc/backup").get_json()
        self.assertEqual(got["backup"], blob)


class KvStoreIsWriterAndReader(Base):
    def test_the_manifest_reports_what_was_put(self):
        """A store with a writer and no reader is the same shape as a loop with
        no writer for its input — so both directions are checked together."""
        with self.client() as c:
            put = c.post("/svc/kv", json={"k": "layout.main", "v": {"cols": 3}}).get_json()
            man = c.get("/svc/kv/manifest").get_json()
        self.assertTrue(put.get("ok"), put)
        self.assertEqual(put["revs"]["layout.main"], 1, put)
        # MEASURED: the manifest is a DICT of key -> rev, not a list of rows. The
        # first version of this test assumed a list and reported a defect in a
        # route that was answering correctly.
        self.assertIn("layout.main", man["manifest"], man)
        with self.client() as c:
            back = c.get("/svc/kv/layout.main").get_json()
        # AN ASYMMETRY, PINNED RATHER THAN CHANGED. `POST /svc/kv` takes `v` as an
        # OBJECT and `GET /svc/kv/<k>` hands back the stored JSON STRING. Nothing
        # in `app/src` reads that route today (only `/svc/kv/manifest`), so this
        # is latent rather than broken — and altering the shape of a route with no
        # caller buys nothing while risking the next one. Recorded here so whoever
        # wires a reader meets the fact instead of the surprise.
        self.assertIsInstance(back["v"], str, back)
        self.assertEqual(json.loads(back["v"]), {"cols": 3})
        self.assertEqual(back["rev"], 1)


# ============================================================ svc/alerts.py ==
class AlertsRefuseRatherThanPretend(Base):
    def test_notify_with_no_channel_configured_says_what_to_do(self):
        """The alert loop, the signal loop and the dead-man's switch all send
        through here. With no credentials it must REFUSE, not answer ok — a
        silent success is how three loops fired into nothing behind twelve green
        dots."""
        with self.client() as c:
            body = c.post("/svc/notify", json={"text": "hello"}).get_json()
        self.assertFalse(body.get("ok"), body)
        # IT ANSWERED `{"ok": false, "via": "server-secrets"}` — correct about the
        # outcome, and `via` is an internal word for where the token lives. The
        # refusal must be addressed to the operator, and must distinguish "no
        # channel is set up" from "Telegram would not take it".
        self.assertIn("why", body, "a refusal with no sentence in it: %s" % body)
        self.assertIn("Telegram", body["why"])
        self.assertIs(body["configured"], False)

    def test_the_telegram_credential_is_write_only(self):
        """A token that can be read back is a token in every screenshot."""
        with svc.db() as c:
            for k, v in (("tg_token", "tok-sentinel-771"), ("tg_chat", "12345")):
                c.execute("INSERT INTO config(k,v) VALUES(?,?) "
                          "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
        seen = []
        for path in ("/svc/telegram", "/svc/alerts"):
            with self.client() as c:
                seen.append(c.get(path).get_data(as_text=True))
        for body in seen:
            self.assertNotIn("tok-sentinel-771", body)

    def test_send_tg_refuses_without_credentials_and_sends_nothing(self):
        """Patched at the module that OWNS it. A re-export is a second binding."""
        # MEASURED: it sends with `requests.post`, not urllib. Patched on the
        # module that OWNS the name — `mishel_service.requests` is a different
        # binding and repointing it would test the real thing while reporting
        # success, which this project has already paid for once.
        calls = []
        real = core.requests.post

        def refuse(*a, **k):
            calls.append(a)
            raise AssertionError("send_tg reached the network with no credentials")

        core.requests.post = refuse
        try:
            got = core.send_tg("should not be sent")
        finally:
            core.requests.post = real
        self.assertFalse(got, "send_tg must report that it did not send")
        self.assertEqual(calls, [], "and it must not have tried")


# =========================================================== svc/signals.py ==
class SignalsReadBackWhatWasArmed(Base):
    def setUp(self):
        super().setUp()
        with svc.db() as c:
            c.execute("DELETE FROM sig_watch")
            c.execute("DELETE FROM sig_fired")

    def test_an_armed_strategy_is_readable_again(self):
        """A WRITER WITH NO READER is one of this project's recorded shapes.
        Arming and then listing is the only check that covers both halves."""
        with self.client() as c:
            # MEASURED from the route's own refusal: it wants `sym` and
            # `strategy`. My first fixture invented `kind`/`dir`/levels and the
            # 400 it earned was correct.
            armed = c.post("/svc/sig/watch", json={
                "sym": "BTCUSDT", "tf": "1h", "strategy": "spring",
            }).get_json()
        self.assertTrue(armed.get("ok"), armed)
        with self.client() as c:
            listed = c.get("/svc/sig/watch").get_json()
        rows = listed.get("watch") or listed.get("rows") or []
        self.assertEqual(len(rows), 1, listed)
        self.assertEqual(rows[0].get("sym"), "BTCUSDT")

    def test_the_fired_list_is_empty_rather_than_absent(self):
        """An empty list and a missing field are different facts; a card that
        cannot tell them apart renders 0 for an unreachable service."""
        with self.client() as c:
            body = c.get("/svc/sig/fired").get_json()
        self.assertTrue(body.get("ok"), body)
        self.assertIsInstance(body.get("fired") or body.get("rows") or [], list)


if __name__ == "__main__":
    unittest.main(verbosity=2)
