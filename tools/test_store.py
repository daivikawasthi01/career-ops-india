import csv
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import store  # noqa: E402
from dedup import merge_offers  # noqa: E402

LI = {"company": "Acme Pvt Ltd", "title": "Software Engineer Intern", "location": "Bengaluru", "source": "linkedin",
      "url": "https://in.linkedin.com/jobs/view/x-at-acme-3912345678?trk=a"}
GH = {"company": "Acme", "title": "Software Engineer Intern", "location": "Bangalore", "source": "greenhouse",
      "url": "https://boards.greenhouse.io/acme/jobs/7001234"}
OTHER = {"company": "Beta", "title": "Backend Intern", "location": "Pune", "source": "naukri",
         "url": "https://www.naukri.com/job-listings-backend-intern-beta-pune-0-to-1-years-091125099999"}


class Ingest(unittest.TestCase):
    def setUp(self):
        self.db = store.connect(":memory:")

    def run_once(self, run_id, per_step):
        return store.ingest(self.db, merge_offers(per_step), run_id, today="2026-11-09")

    def test_second_identical_run_adds_nothing(self):
        per = {"jobspy": [LI, OTHER], "ats": [GH]}
        new1, _ = self.run_once("r1", per)
        new2, known2 = self.run_once("r2", per)
        self.assertEqual(len(new1), 2)
        self.assertEqual((len(new2), known2), (0, 2))

    def test_same_job_on_another_source_later_is_not_new(self):
        self.run_once("r1", {"jobspy": [LI]})
        new, known = self.run_once("r2", {"ats": [GH]})
        self.assertEqual((len(new), known), (0, 1))
        row = self.db.execute("SELECT found_by, last_run_id FROM jobs").fetchone()
        self.assertIn("greenhouse", row["found_by"])
        self.assertEqual(row["last_run_id"], "r2")

    def test_url_in_seen_memory_is_not_new(self):
        self.db.execute("INSERT INTO seen VALUES (?, ?)", ("https://www.linkedin.com/jobs/view/3912345678", "2026-10-01"))
        new, known = self.run_once("r1", {"jobspy": [LI]})
        self.assertEqual((len(new), known), (0, 1))

    def test_status_roundtrip_by_original_or_canonical_url(self):
        self.run_once("r1", {"jobspy": [LI]})
        self.assertTrue(store.set_status(self.db, LI["url"], "interested"))
        self.assertEqual(self.db.execute("SELECT status FROM jobs").fetchone()[0], "interested")
        with self.assertRaises(ValueError):
            store.set_status(self.db, LI["url"], "maybe")
        self.assertFalse(store.set_status(self.db, "https://nowhere.example/x", "ignore"))

    def test_refresh_keeps_status(self):
        self.run_once("r1", {"jobspy": [LI]})
        store.set_status(self.db, LI["url"], "applied")
        self.run_once("r2", {"jobspy": [LI]})
        self.assertEqual(self.db.execute("SELECT status FROM jobs").fetchone()[0], "applied")


class Rejected(unittest.TestCase):
    def test_prune_and_idempotent_spool(self):
        db = store.connect(":memory:")
        now = datetime(2026, 11, 9)
        old = (now - timedelta(days=40)).isoformat()
        new = (now - timedelta(days=2)).isoformat()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "rejected.tsv"
            with p.open("w", newline="") as f:
                w = csv.writer(f, delimiter="\t")
                w.writerow(["timestamp", "source", "company", "title", "url", "reason"])
                w.writerow([old, "x", "A", "Old", "https://a/1", "title"])
                w.writerow([new, "x", "B", "Recent", "https://b/1", "title"])
            self.assertEqual(store.ingest_rejected_tsv(db, p), 2)
            self.assertEqual(store.ingest_rejected_tsv(db, p), 0)
        self.assertEqual(store.prune_rejected(db, 30, now), 1)
        self.assertEqual(db.execute("SELECT title FROM rejected").fetchone()[0], "Recent")


class History(unittest.TestCase):
    def test_migration_counts_noise_and_keeps_added_as_memory(self):
        db = store.connect(":memory:")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "scan-history.tsv"
            p.write_text("url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n"
                         "https://boards.greenhouse.io/a/jobs/1\t2026-11-01\tgreenhouse-api\tSDE\tA\tadded\tPune\n"
                         "https://boards.greenhouse.io/b/jobs/2\t2026-11-01\tgreenhouse-api\tChef\tB\tskipped_title\tBerlin\n"
                         "https://boards.greenhouse.io/c/jobs/3\t2026-11-01\tgreenhouse-api\tChef\tC\tskipped_title\tBengaluru, India\n")
            rep = store.migrate_scan_history(db, p)
        self.assertEqual(rep["by_status"], {"added": 1, "skipped_title": 2})
        self.assertEqual((rep["skipped_with_india_location"], rep["skipped_other_location"]), (1, 1))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM seen").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM rejected").fetchone()[0], 2)


class Pipeline(unittest.TestCase):
    def test_render_replaces_pending_keeps_processed_and_foreign_lines(self):
        db = store.connect(":memory:")
        store.ingest(db, merge_offers({"j": [LI]}), "r1", today="2026-11-09")
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / "pipeline.md"
            md.write_text("# P\n\n## Pending\n- [ ] https://other.example/job/9 | Z | Hand pasted\n\n## Processed\n- [x] #001 | https://done.example/1 | D | T\n")
            text, added, foreign = store.render_pipeline(db, md, write=True)
            self.assertEqual((added, foreign), (1, 1))
            out = md.read_text()
            self.assertIn("Hand pasted", out)
            self.assertIn("linkedin.com/jobs/view", out)
            self.assertTrue(out.rstrip().endswith("| D | T"))
            self.assertFalse(Path(str(md) + ".tmp").exists())
            # rendering again changes nothing
            self.assertEqual(store.render_pipeline(db, md, write=False)[0], out)

    def test_refuses_a_file_without_headings(self):
        db = store.connect(":memory:")
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / "p.md"
            md.write_text("nothing here")
            with self.assertRaises(ValueError):
                store.render_pipeline(db, md)

    def test_stale_and_non_new_rows_are_left_out(self):
        db = store.connect(":memory:")
        store.ingest(db, merge_offers({"j": [LI, OTHER]}), "r1", today="2026-11-09")
        store.set_status(db, OTHER["url"], "ignore")
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / "p.md"
            md.write_text("## Pending\n\n## Processed\n")
            _, added, _ = store.render_pipeline(db, md)
        self.assertEqual(added, 1)


class DryRun(unittest.TestCase):
    def test_dry_run_connection_never_creates_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "jobs.db"
            conn = store.dry_run_connection(path)
            store.ingest(conn, merge_offers({"j": [LI]}), "r1")
            self.assertFalse(path.exists())

    def test_dry_run_sees_existing_rows_without_changing_them(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "jobs.db"
            real = store.connect(path)
            store.ingest(real, merge_offers({"j": [LI]}), "r0")
            real.close()
            conn = store.dry_run_connection(path)
            new, known = store.ingest(conn, merge_offers({"j": [LI, OTHER]}), "r1")
            self.assertEqual((len(new), known), (1, 1))
            check = store.connect(path)
            self.assertEqual(check.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
