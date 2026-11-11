import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import config, db, share


class ShareTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.kb = self.tmp / "kb.sqlite"
        db.init(str(self.kb), str(config.ROOT / "schema.sql"))
        patches = [mock.patch.object(share, "STATE", self.tmp / "share.json"),
                   mock.patch.object(share, "url", lambda: "https://example.test/hook")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def conn(self):
        return db.tx(str(self.kb))

    def test_report_has_counts_and_nothing_personal(self):
        with self.conn() as c:
            c.execute("INSERT INTO usage_events(kind, n) VALUES ('fill', 4)")
            r = share.report(c)
        self.assertEqual(r["week"]["fills"], 4)
        blob = json.dumps(r).lower()
        for word in ("email", "cv", "company", "key", "name", "http"):
            self.assertNotIn(f'"{word}', blob)

    def test_text_summary_has_no_install_id(self):
        with self.conn() as c:
            t = share.text(c)
            self.assertNotIn(share.report(c)["install"], t)
        self.assertIn("Apply stats", t)

    def test_sends_daily_when_an_address_is_set_and_not_when_turned_off(self):
        self.assertTrue(share.due())
        sent = []
        with self.conn() as c:
            share.send(c, post=lambda u, b: sent.append((u, json.loads(b))))
        self.assertEqual(sent[0][0], "https://example.test/hook")
        self.assertFalse(share.due())   # a day has not passed
        with mock.patch.object(config, "load", lambda: {"share": {"enabled": False}}):
            self.assertFalse(share.enabled())

    def test_nothing_is_sent_without_an_address(self):
        with mock.patch.object(share, "url", lambda: ""):
            self.assertFalse(share.due())

    def test_failed_send_is_recorded_not_raised(self):
        def boom(u, b):
            raise OSError("offline")
        with self.conn() as c:
            out = share.send(c, post=boom)
        self.assertIn("Could not send", out["error"])


if __name__ == "__main__":
    unittest.main()
