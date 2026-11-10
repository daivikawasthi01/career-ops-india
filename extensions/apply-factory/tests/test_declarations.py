import unittest

from lib import db, declarations, knowledge, options, suggest
from tests.fakes import FakeOllama, temp_db


class StatementTest(unittest.TestCase):
    def test_polarity_decides(self):
        s = declarations.same_statement
        self.assertTrue(s("I am not a protected veteran", "I am not a veteran"))
        self.assertTrue(s("No, I do not have a disability", "No, I don't have a disability"))
        self.assertFalse(s("I am a protected veteran", "I am not a protected veteran"))
        self.assertFalse(s("I identify as a veteran", "Not a veteran"))
        self.assertFalse(s("I am not a veteran", "I am not a student"))

    def test_options_never_pick_the_opposite_statement(self):
        opts = ["I am a protected veteran", "I am not a protected veteran"]
        self.assertEqual(options.pick("I am not a protected veteran", opts)[0], "I am not a protected veteran")
        self.assertIsNone(options.pick("I am not a protected veteran", ["I am a protected veteran"]))
        self.assertEqual(options.pick("Yes", ["Yes, I am authorized", "No, I am not"])[0], "Yes, I am authorized")

    def test_option_with_an_abbreviation_in_brackets_matches_the_long_name(self):
        opts = ["Delhi Technological University", "Netaji Subhas Institute of Technology (NSIT)", "Other"]
        self.assertEqual(options.pick("Netaji Subhas University of Technology", opts)[0], "Netaji Subhas Institute of Technology (NSIT)")
        self.assertEqual(options.pick("NSUT", ["Netaji Subhas Institute of Technology (NSIT)"])[0], "Netaji Subhas Institute of Technology (NSIT)")

    def test_search_queries_include_aliases_and_short_forms(self):
        q = options.queries("Netaji Subhas University of Technology")
        self.assertEqual(q[0], "Netaji Subhas University of Technology")
        self.assertIn("nsut", q)
        self.assertIn("Netaji Subhas", q)


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.db = temp_db()

    def tearDown(self):
        self.fake.uninstall()

    def learn(self, intent, answer, question):
        with db.tx(self.db) as conn:
            knowledge.upsert(conn, intent, answer, question_text=question, source="manual")

    def test_facts_decide_authorization_and_sponsorship(self):
        with db.tx(self.db) as conn:
            c = lambda t: declarations.check(conn, t)
            self.assertIs(c("I am legally authorized to work in India"), True)
            self.assertIs(c("I am not legally authorized to work in India"), False)
            self.assertIs(c("I do not require visa sponsorship"), True)
            self.assertIs(c("I will require visa sponsorship now or in the future"), False)

    def test_a_checkbox_you_ticked_before_is_ticked_again_in_new_words(self):
        self.learn("not_a_veteran", "Yes", "I am not a protected veteran")
        with db.tx(self.db) as conn:
            self.assertIs(declarations.check(conn, "I am not a veteran"), True)
            self.assertIsNone(declarations.check(conn, "I am a protected veteran"))
            self.assertIsNone(declarations.check(conn, "I am a student"))

    def test_option_lists_pick_the_statement_you_chose_before(self):
        self.learn("disability_status", "No, I do not have a disability", "Disability status")
        with db.tx(self.db) as conn:
            got = declarations.agreeing_options(conn, ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"])
        self.assertEqual(got, ["No, I do not have a disability"])

    def test_suggest_ticks_statements_and_fills_a_differently_labelled_group(self):
        self.learn("not_a_veteran", "Yes", "I am not a protected veteran")
        self.learn("disability_status", "No, I do not have a disability", "Disability status")
        with db.tx(self.db) as conn:
            r = {x["id"]: x for x in suggest.suggest(conn, [
                {"id": "a", "label": "I am not a veteran", "type": "checkbox"},
                {"id": "b", "label": "I am a protected veteran", "type": "checkbox"},
                {"id": "c", "label": "Self-identification (voluntary)", "type": "radio",
                 "options": ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"]},
                {"id": "d", "label": "I am legally authorized to work in India", "type": "checkbox"},
            ])}
        self.assertEqual((r["a"]["status"], r["a"]["value"]), ("fill", "Yes"))
        self.assertEqual(r["b"]["status"], "manual")  # sensitive, and the opposite of what you confirmed: never ticked
        self.assertEqual((r["c"]["status"], r["c"]["value"]), ("fill", "No, I do not have a disability"))
        self.assertEqual((r["d"]["status"], r["d"]["value"]), ("fill", "Yes"))


if __name__ == "__main__":
    unittest.main()
