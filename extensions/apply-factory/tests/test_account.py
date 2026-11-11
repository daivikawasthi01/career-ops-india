import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import account, db, profile


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.facts = Path(self.tmp.name) / "facts.yml"
        self.facts.write_text('# keep me\nfirst_name: "Ada"\nlast_name: "L"\nemail: "a@b.co"\nphone: "+919999999999"\nphone_country_code: "+91"\n\naliases:\n  - ["a", "b"]\n')
        self.db = str(Path(self.tmp.name) / "kb.sqlite")
        db.init(self.db, str(Path(__file__).resolve().parent.parent / "schema.sql"))
        self.p = mock.patch.object(account.config, "path", lambda *a, **k: self.facts)
        self.p.start(); profile.reload()

    def tearDown(self):
        self.p.stop(); profile.reload(); self.tmp.cleanup()

    def test_set_facts_keeps_comments_and_aliases(self):
        account.set_facts({"city": "Pune", "first_name": "Grace"})
        text = self.facts.read_text()
        self.assertIn("# keep me", text)
        self.assertIn('aliases:', text)
        self.assertIn('city: "Pune"', text)
        self.assertIn('first_name: "Grace"', text)
        self.assertEqual(profile.facts()["full_name"], "Grace L")

    def test_rejects_bad_input(self):
        for bad in ({"email": "nope"}, {"phone": "12"}, {"password": "x"}, {"city": "a\nb"}):
            with self.assertRaises(ValueError):
                account.set_facts(bad)

    def test_phone_national_derived(self):
        account.set_facts({"phone": "+91 98765 43210"})
        self.assertEqual(profile.facts()["phone_national"], "9876543210")

    def test_answers_edit_delete(self):
        with db.tx(self.db) as c:
            c.execute("INSERT INTO kb_entries(intent_key, answer_type, answer) VALUES ('notice','text','30 days')")
            c.execute("INSERT INTO kb_question_variants(intent_key, question_text) VALUES ('notice','Notice period')")
            self.assertEqual(account.list_answers(c, "notice")["total"], 1)
            account.update_answer(c, "notice", "60 days")
            self.assertEqual(account.list_answers(c)["rows"][0]["answer"], "60 days")
            with self.assertRaises(ValueError):
                account.update_answer(c, "notice", " ")
            account.delete_answer(c, "notice")
            self.assertEqual(account.list_answers(c)["total"], 0)
            with self.assertRaises(KeyError):
                account.delete_answer(c, "notice")

    def test_stats(self):
        with db.tx(self.db) as c:
            account.record(c, "fill", 6); account.record(c, "draft", 2); account.record(c, "form")
            s = account.stats(c)
            self.assertEqual(s["week"]["fills"], 6)
            self.assertEqual(s["all"]["minutes_saved"], 4)
            with self.assertRaises(ValueError):
                account.record(c, "other")

    def test_readiness_flags_missing_details(self):
        account.set_facts({"phone": ""})
        self.assertIn("phone", account.readiness()["facts_missing"])


if __name__ == "__main__":
    unittest.main()
