import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import audit_missed  # noqa: E402
import mark  # noqa: E402
import ranker  # noqa: E402
import store  # noqa: E402
import weekly_report as wr  # noqa: E402
from dedup import merge_offers  # noqa: E402

TODAY = date(2026, 11, 9)


def seeded():
    db = store.connect(":memory:")
    offers = {
        "jobspy": [{"company": "Acme", "title": "SDE Intern", "location": "Pune", "url": "https://www.linkedin.com/jobs/view/3912345678", "first_seen": "2026-11-06"},
                   {"company": "Beta", "title": "Backend Intern", "location": "Chennai", "url": "https://www.naukri.com/job-listings-backend-intern-beta-chennai-0-to-1-years-091125099999", "first_seen": "2026-11-08"}],
        "ats": [{"company": "Acme", "title": "SDE Intern", "location": "Pune", "url": "https://boards.greenhouse.io/acme/jobs/1", "first_seen": "2026-11-08"},
                {"company": "Gamma", "title": "ML Intern", "location": "Pune", "url": "https://jobs.lever.co/gamma/abcd-1234"}]}
    store.ingest(db, merge_offers(offers, today="2026-11-08"), "r1", today="2026-11-08")
    return db


class Report(unittest.TestCase):
    def test_sources_lead_time_overlap(self):
        db = seeded()
        jobs = wr.jobs_in_window(db, 7, TODAY)
        by = {r["source"]: r for r in wr.per_source(jobs)}
        self.assertEqual(by["linkedin"]["found"], 1)
        self.assertEqual(by["naukri"]["unique"], 1)
        lt = wr.lead_times(jobs)
        self.assertEqual(lt["linkedin"], 2)  # linkedin saw Acme two days before greenhouse
        self.assertEqual(wr.overlap_and_coverage(jobs)[0]["both"] >= 0, True)

    def test_precision_uses_marks(self):
        db = seeded()
        store.set_status(db, "https://www.linkedin.com/jobs/view/3912345678", "interested")
        by = {r["source"]: r for r in wr.per_source(wr.jobs_in_window(db, 7, TODAY))}
        self.assertEqual(by["linkedin"]["good"], 1)
        self.assertEqual(by["naukri"]["good"], 0)

    def test_discovered_boards_skip_tracked(self):
        db = seeded()
        boards = dict(wr.discovered_boards(db, {"acme"}))
        self.assertEqual(list(boards), ["gamma"])

    def test_insert_boards_goes_inside_tracked_companies(self):
        text = "a: 1\ntracked_companies:\n  - name: X\n    careers_url: https://x\n\njob_boards:\n  - name: J\n"
        out = wr.insert_boards(text, [("gamma", "https://jobs.lever.co/gamma")])
        self.assertLess(out.index("gamma"), out.index("job_boards:"))
        self.assertGreater(out.index("gamma"), out.index("name: X"))
        self.assertIn("name: J", out)

    def test_report_states_the_independence_caveat_and_applies_nothing(self):
        text = wr.render(seeded(), 7, [("gamma", "https://jobs.lever.co/gamma")], TODAY)
        self.assertIn("independently", text)
        self.assertIn("nothing is applied", text.lower())


class Mark(unittest.TestCase):
    def test_sync_excel(self):
        from openpyxl import Workbook
        db = seeded()
        wb = Workbook(); ws = wb.active; ws.title = "Offers"
        ws.append(["Company", "Link", "Status"])
        ws.append(["Acme", "https://boards.greenhouse.io/acme/jobs/1", "applied"])
        ws.append(["Beta", "https://www.naukri.com/x", "ignore"])
        ws.append(["Gamma", "https://jobs.lever.co/gamma/abcd-1234", "maybe"])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "o.xlsx"
            wb.save(p)
            self.assertEqual(mark.sync_excel(db, str(p)), (1, 1, 1))
        self.assertEqual(db.execute("SELECT status FROM jobs WHERE company='Acme'").fetchone()[0], "applied")


class Audit(unittest.TestCase):
    def test_three_verdicts(self):
        db = seeded()
        db.execute("INSERT INTO rejected VALUES ('Sales Intern','Zed','portals','https://zed.example/jobs/9','title','2026-11-05T00:00:00')")
        explain = lambda *a: {"rule": "negative: word:sales"}  # noqa: E731
        known = audit_missed.audit(db, "https://boards.greenhouse.io/acme/jobs/1", set(), explain)
        self.assertEqual(known["status"], "in database")
        filtered = audit_missed.audit(db, "https://zed.example/jobs/9", set(), explain)
        self.assertEqual(filtered["status"], "fetched but filtered")
        self.assertIn("word:sales", filtered["detail"])
        gap = audit_missed.audit(db, "https://boards.greenhouse.io/newco/jobs/5", {"acme"}, explain)
        self.assertIn("not on a tracked board", gap["status"])
        self.assertIn("boards.greenhouse.io/newco", gap["advice"])
        other = audit_missed.audit(db, "https://www.foundit.in/job/abc-123", set(), explain)
        self.assertIn("source or query gap", other["status"])


class Ranker(unittest.TestCase):
    def test_learns_a_preference_and_explains_it(self):
        rows = []
        for i in range(30):
            rows.append(({"title": "Backend Intern", "found_by": '["greenhouse"]', "location": "Pune", "confidence": "employer-confirmed"}, 1))
            rows.append(({"title": "Sales Executive", "found_by": '["naukri"]', "location": "Pune", "confidence": "aggregator"}, 0))
        w = ranker.train([(ranker.features(j), y) for j, y in rows])
        self.assertGreater(ranker.score(w, rows[0][0]), 0.8)
        self.assertLess(ranker.score(w, rows[1][0]), 0.2)
        self.assertIn("backend", ranker.explain(w))


if __name__ == "__main__":
    unittest.main()
