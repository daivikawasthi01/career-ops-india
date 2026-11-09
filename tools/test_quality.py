import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import confirm  # noqa: E402
import liveness  # noqa: E402
import store  # noqa: E402
from dedup import merge_offers  # noqa: E402

CFG = {"concurrency": 2, "host_delay_seconds": 0, "timeout_seconds": 5, "stale_after_days": 21,
       "generic_paths": ["/jobs", "/careers", "/"], "gone_markers": ["no longer available", "position has been filled"]}


class Classify(unittest.TestCase):
    def test_states(self):
        c = lambda o, f, s=200, b="": liveness.classify(o, f, s, b, CFG)  # noqa: E731
        deep = "https://boards.greenhouse.io/acme/jobs/7001"
        self.assertEqual(c(deep, deep), "alive")
        self.assertEqual(c(deep, deep, 404), "gone")
        self.assertEqual(c(deep, "https://boards.greenhouse.io/acme"), "generic")
        self.assertEqual(c(deep, "https://acme.com/careers/"), "generic")
        self.assertEqual(c(deep, deep, 200, "Sorry, this position has been filled"), "gone")
        self.assertEqual(c(deep, deep, 503), "error")


class Pacer(unittest.TestCase):
    def test_same_host_is_spaced_other_hosts_are_not(self):
        t = [0.0]
        slept = []
        pacer = liveness.HostPacer(2, clock=lambda: t[0], sleep=lambda s: slept.append(s))
        pacer.wait("a.com"); pacer.wait("a.com"); pacer.wait("b.com")
        self.assertEqual(slept, [2])


class Run(unittest.TestCase):
    def setUp(self):
        self.db = store.connect(":memory:")
        offers = [{"company": "Acme", "title": "SDE Intern", "location": "Pune", "url": "https://boards.greenhouse.io/acme/jobs/1"},
                  {"company": "Acme", "title": "QA Intern", "location": "Pune", "url": "https://boards.greenhouse.io/acme/jobs/2"},
                  {"company": "Zed", "title": "Dev", "location": "Pune", "url": "https://www.linkedin.com/jobs/view/3912345678"}]
        store.ingest(self.db, merge_offers({"s": offers}), "r1", today="2026-10-01")

    def test_aggregator_rows_are_never_fetched(self):
        rows = liveness.candidates(self.db, today=date(2026, 11, 9))
        self.assertEqual(len(rows), 2)

    def test_alive_gone_error(self):
        def fake(url, timeout):
            if url.endswith("/1"):
                return 200, url, ""
            raise OSError("boom")
        rows = liveness.candidates(self.db, today=date(2026, 11, 9))
        counts = liveness.run(self.db, rows, CFG, fake, today=date(2026, 11, 9))
        self.assertEqual((counts["alive"], counts["error"]), (1, 1))
        self.assertEqual(self.db.execute("SELECT last_seen FROM jobs WHERE url LIKE '%/1'").fetchone()[0], "2026-11-09")
        self.assertEqual(self.db.execute("SELECT stale FROM jobs WHERE url LIKE '%/2'").fetchone()[0], 0)

    def test_gone_marks_stale_and_mark_stale_by_age(self):
        rows = liveness.candidates(self.db, today=date(2026, 11, 9))
        liveness.run(self.db, rows, CFG, lambda u, t: (404, u, ""), today=date(2026, 11, 9))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM jobs WHERE stale=1").fetchone()[0], 2)
        n = liveness.mark_stale(self.db, 21, date(2026, 11, 9))
        self.assertEqual(n, 1)  # the linkedin row, last seen 2026-10-01


class Confirm(unittest.TestCase):
    def test_match_role(self):
        job = {"title": "Software Engineer Intern", "location": "Bengaluru, India"}
        board = [{"title": "Software Engineer - Intern", "location": "Bangalore", "url": "https://b/1"},
                 {"title": "Software Engineer Intern", "location": "Pune", "url": "https://b/2"},
                 {"title": "Sales Manager", "location": "Bangalore", "url": "https://b/3"}]
        self.assertEqual(confirm.match_role(job, board, 0.7)["url"], "https://b/1")
        self.assertIsNone(confirm.match_role(job, board[2:], 0.7))

    def test_confirm_updates_only_matching_rows(self):
        db = store.connect(":memory:")
        store.ingest(db, merge_offers({"s": [
            {"company": "Acme Pvt Ltd", "title": "SDE Intern", "location": "Pune", "url": "https://www.linkedin.com/jobs/view/3912345678"},
            {"company": "Other", "title": "SDE Intern", "location": "Pune", "url": "https://www.linkedin.com/jobs/view/3912345679"}]}), "r1")
        hits = confirm.confirm(db, {"Acme": [{"title": "SDE Intern", "location": "Pune", "url": "https://boards.greenhouse.io/acme/jobs/9"}]}, 0.7)
        self.assertEqual(len(hits), 1)
        row = db.execute("SELECT confidence, employer_url FROM jobs WHERE company LIKE 'Acme%'").fetchone()
        self.assertEqual((row[0], row[1]), ("employer-confirmed", "https://boards.greenhouse.io/acme/jobs/9"))
        self.assertEqual(db.execute("SELECT confidence FROM jobs WHERE company='Other'").fetchone()[0], "aggregator")


if __name__ == "__main__":
    unittest.main()
