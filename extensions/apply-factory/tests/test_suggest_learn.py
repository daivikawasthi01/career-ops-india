import json
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
        suggest._CACHE.clear()

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
        self.fake.chat_replies = [long_reply, "UNKNOWN"]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Why do you want to work here?", "textarea"), {"jd_text": "Backend role"})
            self.assertEqual(d["status"], "draft")
            self.assertNotIn("—", d["value"])
            u = suggest.draft(conn, F("b", "Describe your experience with COBOL", "textarea"), {})
            self.assertEqual(u["status"], "unknown")

    def test_short_reply_to_open_question_is_expanded_once(self):
        self.fake.chat_replies = ["I like the role.", " ".join(["detail"] * 120)]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})
        self.assertEqual(d["status"], "draft")
        self.assertEqual(self.fake.chat_calls, 2)  # first write, one expansion (the length came from the rules, no plan call)
        self.assertGreater(len(d["value"].split()), 90)

    def test_length_follows_the_question_and_the_field_limit(self):
        from lib import rules
        self.assertEqual(rules.answer_length("Message for the hiring team", "textarea"), (100, 180))
        self.assertEqual(rules.answer_length("Favourite language", "text"), (0, 0))
        lo, hi = rules.answer_length("Message for the hiring team", "textarea", 300)
        self.assertLessEqual(hi * 6, 300)

    def test_the_model_plans_the_length_in_a_separate_call(self):
        with db.tx(self.db) as conn:
            q = "What would make you a strong fit for this team?"  # long enough to be a real question, matched by no length rule
            self.fake.chat_replies = ['{"words": 25, "paragraphs": 1}']
            self.assertEqual(suggest.plan_length(F("a", q, "text"), q, {})[:2], (18, 25))
            self.assertEqual(self.fake.chat_calls, 1)
            self.fake.chat_replies = ['{"words": 200}']  # a character limit still caps what the model chose
            self.assertLessEqual(suggest.plan_length(F("a", q, "text", maxlength=300), q, {})[1] * 6, 300)
            before = self.fake.chat_calls
            lo, hi, _ = suggest.plan_length(F("a", "Why us", "textarea", maxlength=300), "Why us", {})  # a rule covers it: no model call
            self.assertEqual(self.fake.chat_calls, before)
            self.assertLessEqual(hi * 6, 300)
            suggest.plan_length(F("a", "City", "text"), "City", {})  # a short label is a short box: no model call
            self.assertEqual(self.fake.chat_calls, before)

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

    def test_achievement_questions_are_story_questions_with_a_real_minimum(self):
        from lib import rules
        self.assertTrue(rules.is_story_question("What is your best achievement till date?"))
        self.assertFalse(rules.is_story_question("Message for the hiring team"))
        self.fake.chat_replies = ['{"words": 10}']
        with db.tx(self.db) as conn:
            lo, hi, _ = suggest.plan_length(F("a", "What is your best achievement till date?", "text"), "What is your best achievement till date?", {})
        self.assertGreaterEqual(lo, 90)

    def test_a_useless_plan_falls_back_to_the_configured_rules(self):
        with db.tx(self.db) as conn:
            self.fake.chat_replies = ["not json"]
            lo, hi, _ = suggest.plan_length(F("a", "Message for the hiring team", "textarea"), "Message for the hiring team", {})
        self.assertEqual((lo, hi), (100, 180))

    def test_banned_phrases_are_removed_in_one_check_after_the_write(self):
        from lib import rules
        self.assertEqual(rules.answer_flaws("Certainly, I built a robust platform \u2014 fast."), ["robust", "certainly", "long dash"])
        self.fake.chat_replies = ["Certainly, I built a robust platform in Go.", "I built a platform in Go."]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})
        self.assertEqual(d["value"], "I built a platform in Go.")

    def test_unknown_on_an_open_question_is_retried_as_best_effort(self):
        best = " ".join(["built"] * 70)
        self.fake.chat_replies = ["UNKNOWN", "UNKNOWN", best]  # the story try, the write, the best-effort retry
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What is your best achievement till date?", "textarea"), {})
        self.assertEqual(d["status"], "draft")
        self.assertEqual(self.fake.chat_calls, 3)

    def test_the_same_question_on_the_same_job_is_answered_from_the_cache(self):
        self.fake.chat_replies = [" ".join(["built"] * 100)]
        f, ctx = F("a", "Message for the hiring team", "textarea"), {"title": "SWE", "company": "Acme", "jd_text": "Backend"}
        with db.tx(self.db) as conn:
            first = suggest.draft(conn, f, ctx)
            calls = self.fake.chat_calls
            again = suggest.draft(conn, F("z", "Message for the hiring team", "textarea"), ctx)  # a reload gives the box a new id
            self.assertEqual(self.fake.chat_calls, calls)  # the second visit made no model call
            suggest.draft(conn, f, {**ctx, "company": "Other"})
            self.assertGreater(self.fake.chat_calls, calls)  # a different job is a different key
        self.assertEqual((first["status"], again["value"], again["id"], again.get("cached")), ("draft", first["value"], "z", True))
        self.fake.chat_replies = [" ".join(["wrote"] * 100)] * 3
        with db.tx(self.db) as conn:
            fresh = suggest.draft(conn, f, {**ctx, "fresh": True})  # Write again skips the cache
        self.assertIn("wrote", fresh["value"])

    def test_long_answers_rotate_hosted_keys_and_fall_back_to_local(self):
        from lib import llm
        llm._pool = lambda: (("groq", "k1aaaaaa"), ("groq", "k2bbbbbb"))
        import itertools
        llm._TURN = itertools.count()  # the rotation starts at the first key
        seen = []
        local = self.fake.post
        def post(url, body, headers=None, timeout=0):
            if "groq.com" in url:
                key = headers["Authorization"][-8:]
                seen.append(key)
                if key == "k1aaaaaa":
                    raise llm.RateLimited("slow down", 30)
                return {"choices": [{"message": {"content": " ".join(["hosted"] * 100)}}]}
            return local(url, body, headers, timeout)
        llm.post = post
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})
            self.assertIn("hosted", d["value"])
            self.assertEqual(seen, ["k1aaaaaa", "k2bbbbbb"])  # the limited key rested, the next one answered
            seen.clear()
            suggest._CACHE.clear()
            suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})
            self.assertNotIn("k1aaaaaa", seen)  # still resting
            llm._pool = lambda: ()  # no hosted key at all: the local model answers
            self.fake.chat_replies = [" ".join(["local"] * 100)]
            suggest._CACHE.clear()
            self.assertIn("local", suggest.draft(conn, F("a", "Message for the hiring team", "textarea"), {})["value"])

    def test_a_limited_model_falls_through_to_the_next_model_of_the_provider(self):
        from lib import llm
        llm._pool = lambda: (("gemini", "g1aaaaaa"),)
        saved = dict(llm._cfg()["cloud"])
        self.addCleanup(lambda: llm._cfg()["cloud"].update(saved))  # the config is shared with every other test
        llm._cfg()["cloud"].update(providers=["gemini"], gemini_model=["new-model", "old-model"])
        seen = []
        def post(url, body, headers=None, timeout=0):
            seen.append(body["model"])
            if body["model"] == "new-model":
                raise llm.RateLimited("limit", 30)
            return {"choices": [{"message": {"content": "ok"}}]}
        llm.post = post
        self.assertEqual(llm._cloud("hi", None, 0.1, False), "ok")
        self.assertEqual(seen, ["new-model", "old-model"])

    def test_long_questions_are_written_together_in_one_hosted_call(self):
        from lib import llm
        import itertools
        llm._pool = lambda: (("groq", "k1aaaaaa"),)
        llm._TURN = itertools.count()
        calls = []
        local = self.fake.post
        def post(url, body, headers=None, timeout=0):
            if "groq.com" in url:
                calls.append(body["messages"][-1]["content"])
                return {"choices": [{"message": {"content": json.dumps({"answers": {"q1": " ".join(["alpha"] * 110), "q2": " ".join(["beta"] * 110), "q3": "tiny"}})}}]}
            return local(url, body, headers, timeout)
        llm.post = post
        fields = [F("a", "Message for the hiring team", "textarea"), F("b", "Why do you want to work here?", "textarea"),
                  F("c", "Describe your experience with Rust", "textarea"), F("d", "Current city", "text"), F("e", "How did you hear about us?", "text")]
        with db.tx(self.db) as conn:
            out = suggest.draft_batch(conn, fields, {"title": "SWE", "company": "Acme"})
        by = {r["id"]: r for r in out["results"]}
        self.assertEqual(len(calls), 1)                                   # one hosted call carried the CV once for the three long questions
        self.assertIn("alpha", by["a"]["value"]); self.assertIn("beta", by["b"]["value"])
        self.assertEqual(sorted(out["single"]), ["c", "d", "e"])          # the too-short answer and the short fact are asked one by one; the source question is never drafted
        with db.tx(self.db) as conn:
            again = suggest.draft_batch(conn, fields[:2], {"title": "SWE", "company": "Acme"})
        self.assertEqual((len(calls), [r.get("cached") for r in again["results"]]), (1, [True, True]))  # a second visit costs nothing

    def test_without_a_hosted_key_the_batch_hands_every_question_back(self):
        with db.tx(self.db) as conn:
            out = suggest.draft_batch(conn, [F("a", "Message for the hiring team", "textarea"), F("b", "Why do you want to work here?", "textarea")], {})
        self.assertEqual((out["results"], sorted(out["single"])), ([], ["a", "b"]))
        self.assertEqual(self.fake.chat_calls, 0)

    def test_claude_fallback_uses_haiku_and_rests_after_a_plan_limit(self):
        from lib import llm
        seen = []
        def run(args, stdin, timeout, cwd):
            seen.append(args[args.index("--model") + 1])
            if len(seen) == 3:
                return 1, json.dumps({"result": "You have hit your usage limit, resets later", "is_error": True})
            return 0, json.dumps({"result": "ok"})
        llm.run_claude = run
        self.assertEqual(llm.call("short", num_predict=40), "ok")
        self.assertEqual(llm.call("long", num_predict=400), "ok")
        self.assertEqual(seen, ["haiku", "haiku"])                       # haiku only, whatever the size
        with self.assertRaises(llm.LLMUnavailable):
            llm.call("limit", num_predict=400)
        before = len(seen)
        with self.assertRaises(llm.LLMUnavailable):
            llm.call("again", num_predict=400)
        self.assertEqual(len(seen), before)                              # resting: claude is not called again for an hour

    def test_web_search_uses_groq_sources_then_gemini_when_groq_is_limited(self):
        from lib import llm
        import itertools
        llm._pool = lambda: (("groq", "gkeyaaaa"), ("gemini", "mkeybbbb"))
        llm._TURN = itertools.count()
        urls = []
        def post(url, body, headers=None, timeout=0):
            urls.append((url, body.get("model")))
            if "groq.com" in url:
                if body["model"] == "openai/gpt-oss-20b":
                    raise llm.RateLimited("daily limit", 600)
                return {"choices": [{"message": {"content": "CTO is Ada Lovelace【3†L1-L2】", "executed_tools": [
                    {"type": "browser_search", "search_results": {"results": [{"title": "News", "url": "https://news.example/a"}]}},
                    {"type": "browser.open", "search_results": {"results": [{"title": "example - viewing lines", "url": "https://page.example/open"}]}}]}}]}
            return {"candidates": [{"content": {"parts": [{"text": "from gemini"}]}, "groundingMetadata": {"groundingChunks": [{"web": {"title": "G", "uri": "https://g.example"}}]}}]}
        llm.post = post
        out = llm.web_search("who is the CTO?")
        self.assertEqual(out["text"], "CTO is Ada Lovelace")                      # citation marks removed
        self.assertEqual(out["sources"], [{"title": "News", "uri": "https://news.example/a"}])  # search hits only, not opened page bodies
        self.assertEqual([m for _, m in urls], ["openai/gpt-oss-20b", "openai/gpt-oss-120b"])  # the limited light model rests; the next one answers
        llm._REST.clear()
        def all_limited(url, body, headers=None, timeout=0):
            if "groq.com" in url:
                raise llm.RateLimited("limit", 600)
            return post(url, body, headers, timeout)
        llm.post = all_limited
        self.assertEqual(llm.web_search("who is the CTO?")["text"], "from gemini")
        llm._REST.clear()
        llm._pool = lambda: ()                                                      # no hosted key at all: claude -p is the last resort
        seen = []
        def run(args, stdin, timeout, cwd):
            seen.append((args[args.index("--model") + 1], args[args.index("--tools") + 1]))
            ev = [{"type": "user", "tool_use_result": {"results": [{"content": [{"title": "T", "url": "https://t.example/x"}]}]}},
                  {"type": "result", "result": "Ada Lovelace", "is_error": False}]
            return 0, "\n".join(json.dumps(e) for e in ev)
        llm.run_claude = run
        out = llm.web_search("who is the CTO?")
        self.assertEqual((seen, out["text"], out["sources"]), ([("haiku", "WebSearch")], "Ada Lovelace", [{"title": "T", "uri": "https://t.example/x"}]))

    def test_a_short_fact_makes_one_small_call_with_no_style_lookup(self):
        self.fake.chat_replies = ["Mumbai"]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Current city", "text"), {})
        self.assertEqual((d["status"], d["value"], self.fake.chat_calls), ("draft", "Mumbai", 1))

    def test_an_answer_far_over_its_target_is_cut_to_whole_sentences(self):
        text = " ".join(f"Sentence number {i} says something useful here." for i in range(30))
        out = suggest._trim_to(text, 100)
        self.assertLessEqual(len(out.split()), 115)
        self.assertTrue(out.endswith("."))
        self.assertEqual(suggest._trim_to("Short answer here.", 100), "Short answer here.")

    def test_length_follows_your_own_similar_answers(self):
        close = [{"question_text": "q", "answer": " ".join(["w"] * 60), "score": 0.8}] * 3
        lo, hi = suggest._calibrate(100, 180, close)
        self.assertLessEqual(hi, 100)
        self.assertGreaterEqual(lo, 70)  # held near the rule's range, never one line
        self.assertEqual(suggest._calibrate(100, 180, [{"question_text": "q", "answer": "x " * 60, "score": 0.3}]), (100, 180))  # far-off answers are ignored

    def test_short_limited_text_boxes_are_still_offered(self):
        r = self.run_suggest([F("a", "Your best achievement in one line", "text", maxlength=50)])
        self.assertEqual(r["a"]["status"], "draftable")

    def test_banned_wording_is_cut_when_the_model_keeps_repeating_it(self):
        bad = "I am excited to join X because it fits me. " + " ".join(["I built services in Go on AWS for developers."] * 14)  # long enough that no expansion call is made
        self.fake.chat_replies = [bad, bad, bad]  # the write, then two rewrites that still carry the phrase
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "Why do you want to work here?", "textarea"), {})
        self.assertEqual(d["status"], "draft")
        self.assertNotIn("excited to", d["value"].lower())
        self.assertIn("I built services in Go", d["value"])

    def test_a_choose_one_question_never_gets_free_text(self):
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What are you currently doing?", "radio", options=[]), {})
        self.assertEqual(d["status"], "unknown")
        self.assertEqual(self.fake.chat_calls, 0)  # the model is not asked at all

    def test_a_choose_one_answer_is_one_of_the_options(self):
        self.fake.chat_replies = ['{"option": "Studying"}']
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What are you currently doing?", "radio", options=["Working full-time", "Studying", "Freelancing"]), {})
        self.assertEqual((d["status"], d["value"], d["id"], d["label"]), ("draft", "Studying", "a", "What are you currently doing?"))

    def test_a_story_question_is_assembled_from_four_parts(self):
        story = {"situation": "At Goldman Sachs developers could only run one operation from a command line and it took a minute.",
                 "action": "I built a self-service platform with React, TypeScript and Go on AWS ECS Fargate for them.",
                 "result": "It cut that operation to about 2 seconds for 9,000 developers.",
                 "lesson": "I learned that removing a small daily friction is worth more than a big feature nobody uses."}
        self.fake.chat_replies = [json.dumps(story)]
        with db.tx(self.db) as conn:
            d = suggest.draft(conn, F("a", "What is your best achievement till date?", "text"), {})
        self.assertEqual(d["status"], "draft")
        self.assertTrue(d["value"].startswith("At Goldman Sachs"), repr(d["value"][:160]))   # it opens with the situation, not mid-thought
        self.assertIn("\n\n", d["value"])                           # two paragraphs
        self.assertEqual(self.fake.chat_calls, 1)

    def test_single_banned_words_are_removed_in_place_and_orphans_are_kept(self):
        self.assertEqual(suggest._scrub("I built a robust platform in Go. It served 9,000 developers."), "I built a platform in Go. It served 9,000 developers.")
        out = suggest._scrub("I am excited to join X. I built services in Go.")
        self.assertEqual(out, "I built services in Go.")
        keep = suggest._scrub("I am excited to say that I built it. This platform served 9,000 developers.")
        self.assertIn("This platform served", keep)

    def test_numbers_the_cv_does_not_contain_are_not_allowed(self):
        self.assertEqual(suggest._invented_numbers("It cut the time by 98% for 9,000 developers with 87% test coverage."), ["98"])
        self.assertEqual(suggest._scrub("It gave a 98% reduction in time for 9,000 developers."), "It gave a reduction in time for 9,000 developers.")

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
