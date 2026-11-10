import unittest

from learner import learn
from lib import db, knowledge, llm, suggest
from tests.fakes import FakeOllama, temp_db


def F(id, label, type="text", **kw):
    return {"id": id, "label": label, "type": type, **kw}


class SuggestTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.db = temp_db()

    def tearDown(self):
        self.fake.uninstall()

    def run_suggest(self, fields):
        with db.tx(self.db) as conn:
            return {r["id"]: r for r in suggest.suggest(conn, fields)}

    def test_facts_fill_without_model(self):
        r = self.run_suggest([F("a", "First Name"), F("b", "Email"), F("c", "Nationality", "select", options=["Select", "American", "Indian"])])
        self.assertEqual(r["a"]["value"], "Daivik")
        self.assertEqual(r["b"]["value"], "daivikawasthi.01@gmail.com")
        self.assertEqual((r["c"]["value"], r["c"]["source"]), ("Indian", "fact"))
        self.assertEqual(self.fake.chat_calls, 0)

    def test_phone_format_follows_field_hints(self):
        r = self.run_suggest([F("a", "Mobile number", maxlength=10), F("b", "Phone", placeholder="+91 98765 43210"), F("c", "Contact number")])
        self.assertEqual(r["a"]["value"], "9311067931")
        self.assertEqual(r["b"]["value"], "+919311067931")
        self.assertEqual(r["c"]["value"], "9311067931")  # a plain box gets the national number

    def test_full_name_question_in_a_sentence(self):
        r = self.run_suggest([F("a", "What's your full name?"), F("b", "Your name")])
        self.assertEqual((r["a"]["value"], r["b"]["value"]), ("Daivik Awasthi", "Daivik Awasthi"))

    def test_a_learned_phone_in_another_format_does_not_override_facts(self):
        with db.tx(self.db) as conn:
            knowledge.upsert(conn, "phone", "093110 67931", question_text="Phone", source="manual")
        r = self.run_suggest([F("a", "What's your phone number?")])
        self.assertEqual((r["a"]["value"], r["a"]["source"]), ("9311067931", "fact"))

    def test_job_search_boxes_are_never_read(self):
        from lib import rules
        self.assertTrue(rules.never_read(F("a", "Search job title")))
        self.assertTrue(rules.never_read(F("a", "Search jobs")))
        self.assertFalse(rules.never_read(F("a", "Job title")))

    def test_private_consent_and_sensitive_are_never_filled(self):
        r = self.run_suggest([F("a", "Password", "password"), F("b", "I agree to the terms and conditions", "checkbox"),
                              F("c", "Gender", "select", options=["Male", "Female"]), F("d", "Expected CTC")])
        self.assertEqual([r[k]["status"] for k in "abcd"], ["skip", "manual", "manual", "manual"])

    def test_own_text_is_never_overwritten(self):
        r = self.run_suggest([F("a", "First name", value="Dev")])
        self.assertEqual(r["a"]["status"], "kept")

    def test_learned_answer_beats_fact_and_matches_new_wording(self):
        with db.tx(self.db) as conn:
            knowledge.upsert(conn, "notice_period_days", "Immediate", question_text="What is your notice period?", source="manual")
            knowledge.upsert(conn, "why_nsut_not_stored", "x", question_text="zzz", source="manual")
        learn.learn_fields(self.db, [], url_key="x")  # builds embeddings
        r = self.run_suggest([F("a", "What is your notice period?")])
        self.assertEqual((r["a"]["status"], r["a"]["value"], r["a"]["source"]), ("fill", "Immediate", "kb"))

    def test_similar_wording_fills_with_source_similar(self):
        with db.tx(self.db) as conn:
            knowledge.upsert(conn, "preferred_language", "Python", question_text="Which programming language do you prefer most", source="manual")
        learn.learn_fields(self.db, [], url_key="x")
        r = self.run_suggest([F("a", "Which programming language do you prefer most?")])
        self.assertEqual(r["a"]["value"], "Python")

    def test_long_unknown_question_is_draftable_not_filled(self):
        r = self.run_suggest([F("a", "Why do you want to work here?", "textarea"), F("b", "Favourite colour")])
        self.assertEqual(r["a"]["status"], "draftable")
        self.assertEqual(r["b"]["status"], "draftable")  # an unknown open box is offered to the model, never filled unasked
        self.assertEqual(self.fake.chat_calls, 0)

    def test_resume_field(self):
        r = self.run_suggest([F("a", "Upload your resume/CV", "file"), F("b", "Upload transcript", "file")])
        self.assertEqual((r["a"]["status"], r["b"]["status"]), ("resume", "skip"))

    def test_draft_uses_cv_and_returns_unknown_cleanly(self):
        long_reply = ("I built a self-service platform at Goldman Sachs — it cut a task from a minute to two seconds. " * 6).strip()
        self.fake.chat_replies = ["{\"words\": 60, \"paragraphs\": 1}", long_reply, "{\"words\": 60}", "UNKNOWN"]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Tell us about a project", "textarea"), {"jd_text": "Backend role"})
            self.assertEqual(d["status"], "draft")
            self.assertNotIn("—", d["value"])
            u = suggest.draft(conn, F("b", "Describe your experience with COBOL", "textarea"), {})
            self.assertEqual(u["status"], "unknown")

    def test_short_reply_to_open_question_is_expanded_once(self):
        self.fake.chat_replies = ["{\"words\": 140, \"paragraphs\": 2}", "I like the role.", " ".join(["detail"] * 120)]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})
        self.assertEqual(d["status"], "draft")
        self.assertEqual(self.fake.chat_calls, 3)  # plan, first write, one expansion
        self.assertGreater(len(d["value"].split()), 90)

    def test_length_follows_the_question_and_the_field_limit(self):
        from lib import rules
        self.assertEqual(rules.answer_length("Message for the hiring team", "textarea"), (100, 180))
        self.assertEqual(rules.answer_length("Favourite language", "text"), (0, 0))
        lo, hi = rules.answer_length("Message for the hiring team", "textarea", 300)
        self.assertLessEqual(hi * 6, 300)

    def test_the_model_plans_the_length_in_a_separate_call(self):
        with db.tx(self.db) as conn:
            self.fake.chat_replies = ['{"words": 25, "paragraphs": 1}']
            self.assertEqual(suggest.plan_length(F("a", "Your LinkedIn headline", "text"), "Your LinkedIn headline", {})[:2], (18, 25))
            self.fake.chat_replies = ['{"words": 200}']  # a character limit still caps what the model chose
            lo, hi, _ = suggest.plan_length(F("a", "Why us", "textarea", maxlength=300), "Why us", {})
            self.assertLessEqual(hi * 6, 300)

    def test_open_questions_keep_a_minimum_length_in_a_small_box(self):
        with db.tx(self.db) as conn:
            self.fake.chat_replies = ['{"words": 15, "paragraphs": 1}']  # the model picks a one-liner for a short-answer box
            lo, hi, _ = suggest.plan_length(F("a", "What is your best achievement till date?", "text"), "What is your best achievement till date?", {})
        self.assertGreaterEqual(lo, 70)
        self.assertGreaterEqual(hi, 150)
        with db.tx(self.db) as conn:
            self.fake.chat_replies = ['{"words": 15}']  # a character limit still wins
            lo, hi, _ = suggest.plan_length(F("a", "What is your best achievement till date?", "text", maxlength=100), "What is your best achievement till date?", {})
        self.assertLessEqual(hi * 6, 100)

    def test_a_useless_plan_falls_back_to_the_configured_rules(self):
        with db.tx(self.db) as conn:
            self.fake.chat_replies = ["not json"]
            lo, hi, _ = suggest.plan_length(F("a", "Message for the hiring team", "textarea"), "Message for the hiring team", {})
        self.assertEqual((lo, hi), (100, 180))

    def test_banned_phrases_are_removed_in_one_check_after_the_write(self):
        from lib import rules
        self.assertEqual(rules.answer_flaws("Certainly, I built a robust platform \u2014 fast."), ["robust", "certainly", "long dash"])
        self.fake.chat_replies = ['{"words": 30}', "Certainly, I built a robust platform in Go.", "I built a platform in Go."]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Tell us about a project", "textarea"), {})
        self.assertEqual(d["value"], "I built a platform in Go.")

    def test_unknown_on_an_open_question_is_retried_as_best_effort(self):
        best = " ".join(["built"] * 70)
        self.fake.chat_replies = ['{"words": 80}', "UNKNOWN", best]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What is your best achievement till date?", "textarea"), {})
        self.assertEqual(d["status"], "draft")
        self.assertEqual(self.fake.chat_calls, 3)

    def test_short_limited_text_boxes_are_still_offered(self):
        r = self.run_suggest([F("a", "Your best achievement in one line", "text", maxlength=50)])
        self.assertEqual(r["a"]["status"], "draftable")

    def test_draft_refuses_sensitive(self):
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What is your expected salary?", "textarea"), {})
        self.assertEqual(d["status"], "manual")
        self.assertEqual(self.fake.chat_calls, 0)


class LearnTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.db = temp_db()

    def tearDown(self):
        self.fake.uninstall()

    def snap(self, label, value, **kw):
        return {"label": label, "field_type": kw.pop("field_type", "text"), "value": value, **kw}

    def test_learns_fact_fields_without_model_and_dedups_repeats(self):
        fields = [self.snap("First name", "Daivik"), self.snap("Email", "me@x.com")]
        ev = learn.learn_fields(self.db, fields, url_key="a.com/apply")
        self.assertEqual(len(ev["new"]), 2)
        self.assertEqual(self.fake.chat_calls, 0)
        ev2 = learn.learn_fields(self.db, fields, url_key="a.com/apply")
        self.assertEqual((len(ev2["new"]), len(ev2["reinforced"])), (0, 0))
        self.assertTrue(all("already captured" in s["reason"] for s in ev2["skipped"]))

    def test_changed_value_is_a_correction_and_unchanged_prefill_is_not(self):
        learn.learn_fields(self.db, [self.snap("Email", "old@x.com")], url_key="a.com/1")
        ev = learn.learn_fields(self.db, [self.snap("Email", "new@x.com", was_prefilled=True, prefilled_value="old@x.com")], url_key="a.com/2")
        self.assertEqual(len(ev["corrected"]), 1)
        ev = learn.learn_fields(self.db, [self.snap("Email", "new@x.com", was_prefilled=True, prefilled_value="new@x.com")], url_key="a.com/3")
        self.assertEqual(len(ev["reinforced"]), 1)
        self.assertEqual(len(ev["corrected"]), 0)

    def test_one_model_failure_queues_that_field_only(self):
        # "Favourite colour" has no fact pattern and an empty KB, so it needs the model; "Email" does not.
        self.fake.down = True
        ev = learn.learn_fields(self.db, [self.snap("Favourite colour", "teal"), self.snap("Email", "me@x.com")], url_key="a.com/1")
        self.assertEqual(len(ev["queued"]), 1)
        self.assertEqual(len(ev["new"]), 1)
        self.fake.down = False
        self.fake.chat_replies = [{"intent_key": "favourite_colour", "is_new": True, "confidence": 0.9, "answer_type": "text", "reason": "x"}]
        done = learn.retry_pending(self.db)
        self.assertEqual(done, {"learned": 1, "still_failing": 0})
        with db.tx(self.db) as conn:
            self.assertEqual(knowledge.lookup_by_intent(conn, "favourite_colour")["answer"], "teal")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM pending_fields").fetchone()[0], 0)

    def test_private_and_consent_fields_are_not_stored(self):
        ev = learn.learn_fields(self.db, [self.snap("Aadhaar number", "1234"), self.snap("I agree to the terms and conditions", "Yes", field_type="checkbox")], url_key="a.com/1")
        self.assertEqual(len(ev["skipped"]), 2)
        with db.tx(self.db) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM kb_entries").fetchone()[0], 0)

    def test_long_answers_become_style_samples_and_never_reusable_answers(self):
        answer = "I like that the team ships small, tested changes and owns them end to end. That is how I worked at my internship."
        ev = learn.learn_fields(self.db, [self.snap("Why do you want to join Acme?", answer, field_type="textarea")], url_key="a.com/1", company="Acme")
        self.assertEqual(ev["skipped"][0]["reason"], "kept as a writing sample")
        self.assertEqual(self.fake.chat_calls, 0)  # no model call is needed for a style sample
        with db.tx(self.db) as conn:
            row = conn.execute("SELECT answer, company, vec FROM writing_samples").fetchone()
            self.assertEqual((row["answer"], row["company"]), (answer, "Acme"))
            self.assertIsNotNone(row["vec"])  # embedded after learning
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM kb_entries").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
