import io
import json
import unittest

import notify_telegram as n


def rows(k):
    return [{"title": f"Job {i} <b>", "company": "Acme & Co", "location": "Pune", "url": f"https://x.example/{i}", "confidence": "aggregator"} for i in range(k)]


class Format(unittest.TestCase):
    def test_nothing_to_send(self):
        self.assertEqual(n.format_messages([]), [])

    def test_escapes_html_and_marks_unconfirmed(self):
        m = n.format_messages(rows(1))[0]
        self.assertIn("Job 0 &lt;b&gt;", m)
        self.assertIn("Acme &amp; Co", m)
        self.assertIn("(unconfirmed)", m)

    def test_fresher_titles_rank_first_and_output_is_capped(self):
        rs = rows(80) + [{"title": "SDE Intern 2027", "company": "Z", "location": "Delhi", "url": "https://x.example/z", "confidence": "employer-confirmed"}]
        msgs = n.format_messages(rs)
        self.assertLessEqual(len(msgs), n.MAX_MESSAGES)
        self.assertTrue(all(len(m) <= 4000 for m in msgs))
        self.assertIn("SDE Intern 2027", msgs[0].split("\n\n")[1])
        self.assertIn("showing 36", msgs[0])


class Send(unittest.TestCase):
    def test_no_credentials_is_a_silent_noop(self):
        import os
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as empty_root, mock.patch.dict(os.environ, {"CAREER_OPS_ROOT": empty_root}):
            for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
                os.environ.pop(k, None)
            # the data root has no .env here, so a developer's real credentials can never make this test send a message
            self.assertEqual(n.send_new(rows(3), opener=self.fail)[0], 0)

    def test_sends_and_never_raises(self):
        class R(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False
        ok = lambda req, timeout=0: R(json.dumps({"ok": True}).encode())
        self.assertEqual(n.send_new(rows(3), token="t", chat_id="c", opener=ok)[0], 1)
        def boom(req, timeout=0): raise OSError("down")
        sent, note = n.send_new(rows(3), token="t", chat_id="c", opener=boom)
        self.assertEqual(sent, 0)
        self.assertIn("ping failed", note)
        notok = lambda req, timeout=0: R(json.dumps({"ok": False}).encode())
        self.assertIn("not ok", n.send_new(rows(3), token="t", chat_id="c", opener=notok)[1])


if __name__ == "__main__":
    unittest.main()


class EnvFileTest(unittest.TestCase):
    def test_reads_values_from_env_file_and_ignores_missing(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, ".env")
            open(f, "w").write("OTHER=1\nTELEGRAM_BOT_TOKEN='abc:123'\nTELEGRAM_CHAT_ID=42\n")
            self.assertEqual(n._from_env_file("TELEGRAM_BOT_TOKEN", f), "abc:123")
            self.assertEqual(n._from_env_file("TELEGRAM_CHAT_ID", f), "42")
            self.assertIsNone(n._from_env_file("NOPE", f))
        self.assertIsNone(n._from_env_file("X", "/no/such/.env"))
