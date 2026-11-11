import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import config, db, errors, gmail, llm, share, tex


class ErrorCounts(unittest.TestCase):
    def setUp(self):
        self.kb = str(Path(tempfile.mkdtemp()) / "kb.sqlite")
        db.init(self.kb, str(config.ROOT / "schema.sql"))

    def test_categories_come_from_the_kind_and_a_few_words(self):
        self.assertEqual(errors.classify(llm.LLMUnavailable("Groq 429 rate limit")), "model_rate_limited")
        self.assertEqual(errors.classify(llm.LLMUnavailable("401 invalid api key")), "model_bad_key")
        self.assertEqual(errors.classify(llm.LLMUnavailable("all models failed")), "model_unavailable")
        self.assertEqual(errors.classify(tex.ToolMissing("tectonic")), "latex_missing")
        self.assertEqual(errors.classify(gmail.GmailError("Gmail is not connected")), "gmail_not_connected")
        self.assertEqual(errors.classify(ValueError("x")), "bad_request")
        self.assertEqual(errors.classify(RuntimeError("boom")), "crash")

    def test_the_message_is_never_stored_or_sent(self):
        secret = "Acme Corp https://jobs.acme.test/123 my CV line"
        errors.note(self.kb, "/outreach/gmail", gmail.GmailError(secret))
        with db.tx(self.kb) as c:
            stored = json.dumps([list(r) for r in c.execute("SELECT * FROM error_events").fetchall()], default=str)
            report = json.dumps(errors.summary(c))
        for blob in (stored, report):
            self.assertNotIn("Acme", blob)
            self.assertNotIn("http", blob)

    def test_summary_counts_by_action_and_category(self):
        for _ in range(3):
            errors.note(self.kb, "/draft", llm.LLMUnavailable("429"))
        errors.note(self.kb, "/score", RuntimeError("x"))
        with db.tx(self.kb) as c:
            s = errors.summary(c)
        self.assertEqual(s[0], {"action": "/draft", "category": "model_rate_limited", "n": 3})
        self.assertEqual(len(s), 2)

    def test_note_never_raises(self):
        errors.note("/no/such/dir/kb.sqlite", "/x", RuntimeError("y"))

    def test_the_daily_report_carries_the_counts(self):
        errors.note(self.kb, "/draft", llm.LLMUnavailable("429"))
        with mock.patch.object(share, "STATE", Path(tempfile.mkdtemp()) / "share.json"), db.tx(self.kb) as c:
            self.assertEqual(share.report(c)["errors"][0]["category"], "model_rate_limited")


if __name__ == "__main__":
    unittest.main()
