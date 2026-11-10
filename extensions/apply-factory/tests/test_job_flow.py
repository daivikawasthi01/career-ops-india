import json
import shutil
import tempfile
import unittest
from pathlib import Path

from lib import checks, config, context, cover, db, knockout, nodecli, score, suggest, tracker
from tests.fakes import FakeOllama, temp_db

needs_tex = unittest.skipUnless(shutil.which("tectonic"), "tectonic is not installed")

JD = ("Backend engineer intern. You will build Go and Python services on AWS, write tests, and work with a small team. "
      "We ask for strong data structures and operating systems fundamentals, curiosity, and clear communication. Stipend 40k a month, hybrid in Bengaluru. ") * 2


class ScoreTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.db = temp_db()

    def tearDown(self):
        self.fake.uninstall()

    def reply(self, g):
        return {"match": {"score": 4, "evidence": "Go and AWS in CV"}, "north_star": {"score": 5, "evidence": "SDE"}, "comp": {"score": 3, "evidence": "40k stipend"},
                "culture": {"score": 4, "evidence": "small team"}, "red_flags": {"score": 5, "evidence": "none"}, "global": g, "dealbreakers": [], "summary": "Good fit."}

    def test_score_uses_career_ops_bands_and_caches(self):
        self.fake.chat_replies = [self.reply(4.3)]
        with db.tx(self.db) as conn:
            r = score.score(conn, "Backend Intern", "Acme", JD)
            self.assertEqual((r["global"], r["verdict"], r["provisional"], r["cached"]), (4.3, "Good match. Worth applying.", True, False))
            self.assertEqual([d["name"] for d in r["dimensions"]], ["CV match", "North Star alignment", "Compensation", "Cultural signals", "Red flags"])
            again = score.score(conn, "Backend Intern", "Acme", JD)
        self.assertTrue(again["cached"])
        self.assertEqual(self.fake.chat_calls, 1)

    def test_bands(self):
        self.assertEqual([score.band(s)[:12] for s in (4.5, 4.0, 3.5, 2.0)], ["Strong match", "Good match. ", "Decent but n", "Recommend ag"])

    def test_bad_model_output_is_clamped(self):
        self.fake.chat_replies = [{"match": {"score": 9}, "global": "x"}]
        with db.tx(self.db) as conn:
            r = score.score(conn, "t", "c", JD)
        self.assertTrue(all(1 <= d["score"] <= 5 for d in r["dimensions"]))
        self.assertTrue(1.0 <= r["global"] <= 5.0)

    def test_too_little_job_text_is_refused(self):
        with db.tx(self.db) as conn:
            with self.assertRaisesRegex(ValueError, "not enough job text"):
                score.score(conn, "t", "c", "short")


class RootCase(unittest.TestCase):
    """A throw-away career-ops root with node calls recorded instead of run."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "reports").mkdir()
        (self.root / "config").mkdir()
        (self.root / "config" / "pipeline.yml").write_text("dedup:\n  aggregator_hosts: [linkedin.com, wellfound.com]\n")
        self._root, self._run = config.CAREEROPS, nodecli.run
        config.CAREEROPS = self.root
        self.calls, self.replies = [], {}

        def fake(args, timeout=30):
            self.calls.append(args)
            for key, val in self.replies.items():
                if key in args[0]:
                    return val
            return 0, "", ""
        nodecli.run = fake

    def tearDown(self):
        config.CAREEROPS, nodecli.run = self._root, self._run

    def report(self, name, url, score_, company):
        (self.root / "reports" / name).write_text(f"# Evaluation: {company} — Backend Intern\n\n**Score:** {score_}/5\n**URL:** {url}\n")


class ChecksTest(RootCase):
    def test_aggregator_and_employer(self):
        self.assertEqual(checks.aggregator("https://www.linkedin.com/jobs/view/1")["status"], "aggregator")
        self.assertEqual(checks.aggregator("https://boards.greenhouse.io/acme/jobs/1")["status"], "employer")

    def test_report_match_by_url_then_company(self):
        self.report("007-acme-2026-11-09.md", "https://boards.greenhouse.io/acme/jobs/1?utm_source=x", 4.2, "Acme")
        self.assertEqual(checks.report_for("Other", "https://boards.greenhouse.io/acme/jobs/1?utm_source=x")["num"], "007")
        self.assertEqual(checks.report_for("Acme", "https://elsewhere/1")["status"], "company")
        self.assertEqual(checks.report_for("Nobody", "https://x/1")["status"], "none")

    def test_blacklist_hit_and_clear(self):
        self.replies["--input-type=module"] = (0, json.dumps({"company": "Acme", "reason": "ghosted me", "since": "2026-01-01"}), "")
        self.assertEqual(checks.blacklist("Acme", "u")["status"], "hit")
        self.replies["--input-type=module"] = (0, "null", "")
        self.assertEqual(checks.blacklist("Acme", "u")["status"], "clear")

    def test_duplicate_rows(self):
        self.replies["precheck-duplicate.mjs"] = (0, json.dumps({"candidates": [{"num": 4, "company": "Acme", "role": "Intern"}]}), "")
        r = checks.duplicate("Acme", "Intern", "u")
        self.assertEqual((r["status"], r["rows"][0]["num"]), ("found", 4))

    def test_preflight_survives_one_failing_check(self):
        self.replies["precheck-duplicate.mjs"] = (1, "", "boom")
        out = checks.preflight("Acme", "Intern", "https://www.linkedin.com/jobs/view/1")
        self.assertEqual(out["duplicate"]["status"], "error")
        self.assertEqual(out["aggregator"]["status"], "aggregator")
        self.assertEqual(set(out), {"blacklist", "duplicate", "liveness", "aggregator", "report"})

    def test_liveness_verdict_is_read_from_output(self):
        self.replies["check-liveness.mjs"] = (0, "https://x  expired  (closed banner)", "")
        self.assertEqual(checks.liveness("https://x")["status"], "expired")


class KnockoutTest(unittest.TestCase):
    def test_years_degree_and_sponsorship(self):
        f = lambda i, l: {"id": i, "label": l}
        out = knockout.warnings([f("a", "Do you have at least 3 years of professional experience in Go?"), f("b", "Do you have a Bachelor's degree in Computer Science?"),
                                 f("c", "First name"), f("d", "Do you have 0 years of experience?")])
        ids = {w["id"] for w in out}
        self.assertEqual(ids, {"a", "b"})
        self.assertIn("3+ years", out[0]["why"])


class TrackerTest(RootCase):
    def setUp(self):
        super().setUp()
        (self.root / "data").mkdir()
        self.replies["reserve-report-num.mjs"] = (0, "035\n", "")

    def test_existing_report_is_updated_not_duplicated(self):
        self.report("007-acme-2026-11-09.md", "https://jobs.lever.co/acme/1", 4.2, "Acme")
        r = tracker.mark_applied("https://jobs.lever.co/acme/1", "Acme", "Backend Intern", "Daivik-Awasthi-Resume.pdf")
        self.assertEqual((r["ok"], r["action"], r["num"]), (True, "updated", "7"))
        self.assertEqual(self.calls[0][:4], ["set-status.mjs", "--report", "7", "Applied"])
        self.assertIn("followup-seed.mjs", [c[0] for c in self.calls])
        self.assertFalse(list((self.root / "batch").glob("**/*.tsv")) if (self.root / "batch").exists() else [])

    def test_unknown_posting_goes_through_the_tsv_and_merge(self):
        r = tracker.mark_applied("https://jobs.lever.co/new/1", "New Co", "SDE Intern", "Daivik-Awasthi-Resume.pdf")
        self.assertEqual((r["ok"], r["action"], r["num"]), (True, "added", "035"))
        tsv = (self.root / "batch" / "tracker-additions" / "035-new-co.tsv").read_text().splitlines()
        self.assertEqual(tsv[0], "num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl")
        cols = tsv[1].split("\t")
        self.assertEqual((cols[0], cols[2], cols[3], cols[4], cols[5], cols[7]), ("35", "New Co", "SDE Intern", "Applied", "N/A", "—"))
        self.assertIn("CV Daivik-Awasthi-Resume.pdf", cols[8])
        order = [c[0] for c in self.calls]
        self.assertEqual(order, ["precheck-duplicate.mjs", "reserve-report-num.mjs", "merge-tracker.mjs", "reserve-report-num.mjs", "followup-seed.mjs"])
        self.assertEqual(self.calls[3], ["reserve-report-num.mjs", "--release", "035"])

    def test_a_tracker_row_found_by_precheck_is_updated(self):
        self.replies["precheck-duplicate.mjs"] = (0, json.dumps({"candidates": [{"num": 12}]}), "")
        r = tracker.mark_applied("https://x/1", "Acme", "Intern")
        self.assertEqual((r["action"], r["num"]), ("updated", "12"))

    def test_failed_merge_is_reported_and_number_released(self):
        self.replies["merge-tracker.mjs"] = (1, "", "bad row")
        r = tracker.mark_applied("https://x/2", "Acme2", "Intern")
        self.assertFalse(r["ok"])
        self.assertIn(["reserve-report-num.mjs", "--release", "035"], self.calls)

    def test_queue_inserts_once_under_pending(self):
        (self.root / "data" / "pipeline.md").write_text("# Pipeline\n\n## Pending\n\n- [ ] https://old | Old | Role\n")
        self.assertTrue(tracker.queue("https://new/1", "New", "SDE")["queued"])
        self.assertFalse(tracker.queue("https://new/1", "New", "SDE")["queued"])
        text = (self.root / "data" / "pipeline.md").read_text()
        self.assertLess(text.index("https://new/1"), text.index("https://old"))


class ContextTest(RootCase):
    def test_report_answers_and_matching(self):
        self.report("007-acme.md", "https://x/1", 4, "Acme")
        self.replies["application-answers.mjs"] = (0, json.dumps({"freeText": [{"question": "Why do you want to work at Acme?", "answer": "Because of the payments focus."}]}), "")
        got = context.report_answers("reports/007-acme.md")
        self.assertEqual(got[0]["answer"], "Because of the payments focus.")
        self.assertIsNotNone(context.answer_for("Why do you want to join Acme?", got))
        self.assertIsNone(context.answer_for("Favourite colour", got))

    def test_paths_outside_reports_are_never_read(self):
        (self.root / "secret.md").write_text("x")
        self.assertEqual(context.report_text("secret.md"), "")
        self.assertEqual(context.report_text("../secret.md"), "")

    def test_cover_letter_section_from_report(self):
        (self.root / "reports" / "007-a.md").write_text("# E\n\n## Cover Letter Draft\n\nDear team, hello.\n\n## Next\nx")
        self.assertEqual(context.cover_letter("reports/007-a.md"), "Dear team, hello.")


class SuggestExtrasTest(RootCase):
    def setUp(self):
        super().setUp()
        self.fake = FakeOllama()
        self.fake.install()
        self.db = temp_db()

    def tearDown(self):
        self.fake.uninstall()
        super().tearDown()

    def test_cover_letter_file_paste_cv_and_report_answer(self):
        self.report("007-acme.md", "https://x/1", 4, "Acme")
        self.replies["application-answers.mjs"] = (0, json.dumps({"freeText": [{"question": "Why do you want to work at Acme?", "answer": "The payments focus."}]}), "")
        with db.tx(self.db) as conn:
            r = {x["id"]: x for x in suggest.suggest(conn, [
                {"id": "a", "label": "Cover letter", "type": "file"}, {"id": "b", "label": "Paste your resume", "type": "textarea"}])}
            self.assertEqual((r["a"]["status"], r["b"]["status"], r["b"]["source"]), ("cover", "fill", "fact"))
            self.assertIn("Daivik", r["b"]["value"])
            d = suggest.draft(conn, {"id": "c", "label": "Why do you want to work at Acme?", "type": "textarea"}, {"report_path": "reports/007-acme.md"})
        self.assertEqual((d["status"], d["source"], d["value"]), ("draft", "report", "The payments focus."))
        self.assertEqual(self.fake.chat_calls, 0)  # the evaluation's own answer needs no model call


class CoverTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama(["Para one.\n\nPara two — with a dash.\n\nPara three."])
        self.fake.install()

    def tearDown(self):
        self.fake.uninstall()

    def test_draft_has_no_em_dash(self):
        out = cover.draft("SDE", "Acme", JD)
        self.assertNotIn("—", out["text"])

    @needs_tex
    def test_pdf_compiles_with_special_characters(self):
        pdf = cover.to_pdf("I built a 100% reliable R&D tool.\n\nSecond paragraph with $5 and #tags.", "A&B Co")
        self.assertTrue(pdf.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
