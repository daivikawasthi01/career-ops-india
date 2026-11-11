"""Jobs tab level filter: seniority titles, the years a posting's own text asks for, and the cache that keeps each read to one."""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import config, db, jobs, locations, years
from tests.fakes import temp_db

COLS = ("canonical_url, url, company, title, location, posted, stipend, first_seen, last_seen, found_by, first_seen_by, confidence, employer_url, flags, status")


def make_jobs_db(rows):
    path = Path(tempfile.mkdtemp()) / "jobs.db"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE jobs (canonical_url TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, posted TEXT, stipend TEXT, first_seen TEXT, "
              "last_seen TEXT, found_by TEXT, first_seen_by TEXT, confidence TEXT DEFAULT 'aggregator', employer_url TEXT, flags TEXT DEFAULT '', status TEXT DEFAULT 'new', "
              "notes TEXT DEFAULT '', fuzzy_key TEXT, first_run_id TEXT, last_run_id TEXT, live_checked TEXT, stale INTEGER DEFAULT 0, urls TEXT)")
    for i, (title, host) in enumerate(rows):
        u = f"https://{host}/{i}"
        c.execute(f"INSERT INTO jobs ({COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (u, u, "Acme", title, "Bangalore", "", "", f"2026-11-{10 + (i % 2):02d}", "2026-11-11",
                                                                                    '["ashbyhq"]', "ashbyhq", "employer-confirmed", u, "", "new"))
    c.commit()
    c.close()
    return path


class TitleTest(unittest.TestCase):
    def test_seniority_in_the_title(self):
        senior = ["Senior Software Engineer", "Sr. Backend Developer", "Lead DevOps Engineer", "Staff Engineer", "Engineering Manager", "Principal SRE",
                  "Software Engineer II", "SDE 3", "SDE-2", "Software Engineer III", "Backend Engineer L5", "Backend Developer (5+ years)", "Head of AI", "Tech Lead"]
        fresher = ["Software Engineer", "SDE 1", "SDE Intern", "Graduate Engineer Trainee", "Junior DevOps Engineer", "Associate Software Engineer", "AI Engineer",
                   "Backend Developer (0-2 years)", "Software Engineer I", "Cloud Engineer - Campus Hire"]
        self.assertEqual([t for t in senior if not jobs.too_senior_title(t)], [])
        self.assertEqual([t for t in fresher if jobs.too_senior_title(t)], [])
        self.assertTrue(jobs.too_senior_title("Senior Associate Engineer"))          # an entry word does not rescue a senior one
        self.assertTrue(jobs.entry_title("Graduate Engineer Trainee"))
        self.assertFalse(jobs.entry_title("Senior Associate Engineer"))


class YearsBase(unittest.TestCase):
    def setUp(self):
        self.kb = temp_db()
        self._cfg = mock.patch.object(years, "my_years", lambda: 0.0)
        self._cfg.start()
        years._LIMIT["key"] = None
        self._saved = years.run_node
        self.rows = [("AI Product Engineer", "jobs.ashbyhq.com/3y"), ("Software Engineer", "boards.greenhouse.io/acme"), ("Senior Engineer", "jobs.lever.co/x"),
                     ("Backend Engineer", "www.naukri.com"), ("DevOps Engineer", "jobs.ashbyhq.com/other")]
        self.jdb = make_jobs_db(self.rows)
        self._open = mock.patch.object(jobs, "_open", lambda: _ro(self.jdb))
        self._open.start()
        self._loc = mock.patch.object(locations, "run_node", lambda locs: [l for l in locs if "London" in l or "US" in l])   # stands in for tools/foreign-locations.mjs
        self._loc.start()
        locations._LAST.update(key=None, out=set())

    def tearDown(self):
        years._LIMIT["key"] = None
        self._loc.stop()
        years.run_node = self._saved
        years.PROGRESS.update(running=False, done=0, total=0, error="")
        self._open.stop()
        self._cfg.stop()

    def ids(self, **kw):
        with db.tx(self.kb) as conn:
            return [j["title"] for j in jobs.search(conn, limit=100, **kw)["rows"]]


class YearsTest(YearsBase):
    def test_the_limit_is_your_years_plus_the_stretch(self):
        years._LIMIT["key"] = None                                    # limit() is cached until the files change
        self.assertEqual(years.limit(), 2.0)
        with mock.patch.object(years, "my_years", lambda: 3.0):
            years._LIMIT["key"] = None
            self.assertEqual(years.limit(), 5.0)
        years._LIMIT["key"] = None

    def test_a_clearly_stated_five_years_is_hidden_and_unclear_ones_stay(self):
        with db.tx(self.kb) as conn:
            for url, state, status, mn, conf in ((f"https://jobs.ashbyhq.com/3y/0", "read", "stated", 5, 1), ("https://boards.greenhouse.io/acme/1", "read", "stated", 1, 1),
                                                 ("https://jobs.ashbyhq.com/other/4", "read", "preferred-only", None, 0)):
                conn.execute("INSERT INTO job_years (canonical_url, state, status, min_years, confident, display) VALUES (?,?,?,?,?,?)", (url, state, status, mn, conf, f"{mn}+"))
        got = self.ids()
        self.assertEqual(sorted(got), ["Backend Engineer", "DevOps Engineer", "Software Engineer"])      # 5+ years and "Senior" are out; a preferred-only figure stays
        with db.tx(self.kb) as conn:
            out = jobs.search(conn, limit=100)
        self.assertEqual(out["fit"]["hidden"], {"senior": 1, "years": 1, "location": 0, "blacklist": 0})
        self.assertEqual(sorted(self.ids(fit=False)), sorted(t for t, _ in self.rows))                 # the filter can be turned off
        self.assertEqual({j["title"]: j["years"] for j in jobs.search(db.connect(self.kb), fit=False, limit=100)["rows"]}["Software Engineer"], "1+")

    def test_an_unsure_reading_never_hides_a_job(self):
        with db.tx(self.kb) as conn:
            conn.execute("INSERT INTO job_years (canonical_url, state, status, min_years, confident) VALUES ('https://jobs.ashbyhq.com/3y/0','read','stated',5,0)")
        self.assertIn("AI Product Engineer", self.ids())                                               # a bar the parser is not sure of is shown

    def test_each_posting_is_read_once_and_the_work_starts_with_what_still_needs_it(self):
        calls = []
        def fake(batch):
            calls.append([b["id"] for b in batch])
            for b in batch:
                yield ({"id": b["id"], "state": "read", "status": "stated", "min": 5, "confident": True, "display": "5+"} if "3y" in b["id"]
                        else {"id": b["id"], "state": "nohost"})
        years.run_node = fake
        with db.tx(self.kb) as conn:
            todo = jobs.years_todo(conn)
        self.assertEqual(len(todo), 4)                                                                 # the "Senior" title is never read
        self.assertTrue(years.start(self.kb, todo))
        for _ in range(100):
            if not years.progress()["running"]:
                break
            import time; time.sleep(0.02)
        self.assertEqual((years.progress()["done"], years.progress()["running"]), (4, False))
        with db.tx(self.kb) as conn:
            self.assertEqual(jobs.years_todo(conn), [])                                                # answered: nothing left to read
            self.assertNotIn("AI Product Engineer", [j["title"] for j in jobs.search(conn, limit=100)["rows"]])
        self.assertFalse(years.start(self.kb, []))

    def test_the_work_ends_with_the_removal_and_reports_how_many(self):
        years.run_node = lambda batch: iter([{"id": b["id"], "state": "nohost"} for b in batch])
        years.start(self.kb, [{"id": "a", "url": "u"}], on_done=lambda: 7)
        for _ in range(100):
            if not years.progress()["running"]:
                break
            import time; time.sleep(0.02)
        self.assertEqual((years.progress()["removed"], years.progress()["error"]), (7, ""))
        def locked():
            raise ValueError("The scanner is writing to jobs.db right now")
        years.start(self.kb, [{"id": "b", "url": "u"}], on_done=locked)
        for _ in range(100):
            if not years.progress()["running"]:
                break
            import time; time.sleep(0.02)
        self.assertIn("scanner is writing", years.progress()["error"])

    def test_a_failed_read_is_retried_after_a_day(self):
        rec = {"state": "unread", "checked_at": "2000-01-01 00:00:00"}
        self.assertTrue(years.needs_check(rec))
        self.assertFalse(years.needs_check({"state": "unread", "checked_at": years.datetime.now(years.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")}))
        self.assertFalse(years.needs_check({"state": "nohost", "checked_at": "2000-01-01 00:00:00"}))


class LocationHelperTest(unittest.TestCase):
    """The real tools/foreign-locations.mjs: foreign places go, Indian and unrecognised places stay, multi-place strings are judged place by place."""

    @unittest.skipUnless(__import__("shutil").which("node"), "node is not installed")
    def test_the_helper_removes_only_clearly_foreign_locations(self):
        locs = ["Remote - US", "Austin, TX", "Ann Arbor, MI, United States", "London, UK", "Canada - Remote AB", "Remote job, Switzerland", "Singapore",
                "Bangalore", "Thane", "Navi Mumbai", "Gandhinagar", "Hyderābād", "TN", "KA", "", "Remote", "Anywhere in the World", "Nashville, TN",
                "Bangalore · London · New York", "Thane · London", "Thane, London", "Pune, India or Remote US", "India, Bangalore · Ireland, Dublin · Remote",
                "Berlin or Bangalore", "Kochi, Kerala", "Chennai, TN", "Noida · Gurugram · Remote"]
        got = set(locations._run_node(locs))
        self.assertEqual(got, {"Remote - US", "Austin, TX", "Ann Arbor, MI, United States", "London, UK", "Canada - Remote AB", "Remote job, Switzerland", "Singapore"})


class PruneTest(YearsBase):
    def setUp(self):
        super().setUp()
        from lib import jobs_prune
        self.prune = jobs_prune
        c = sqlite3.connect(self.jdb)
        c.execute("CREATE TABLE seen (canonical_url TEXT PRIMARY KEY, first_seen TEXT, fuzzy_key TEXT, expired_at TEXT)")
        c.execute("CREATE TABLE rejected (title TEXT, company TEXT, source TEXT, url TEXT, reject_reason TEXT, seen_at TEXT, UNIQUE(url, reject_reason, seen_at))")
        c.execute("UPDATE jobs SET urls = '[]'")
        c.commit()
        c.close()
        self._paths = mock.patch.object(config, "path", lambda key, section="paths": self.jdb if key == "jobs_db" else config.ROOT / config.load()[section][key])
        self._paths.start()
        with db.tx(self.kb) as conn:
            for url, mn in (("https://jobs.ashbyhq.com/3y/0", 5), ("https://jobs.lever.co/x/2", 6), ("https://boards.greenhouse.io/acme/1", 2)):
                conn.execute("INSERT INTO job_years (canonical_url, state, status, min_years, confident, display) VALUES (?,?,?,?,?,?)", (url, "read", "stated", mn, 1, f"{mn}+"))

    def tearDown(self):
        self._paths.stop()
        super().tearDown()

    def test_candidates_are_only_clear_bars_nobody_acted_on(self):
        with db.tx(self.kb) as conn:
            self.assertEqual(sorted(c["title"] for c in self.prune.candidates(conn)), ["AI Product Engineer", "Senior Engineer"])
            jobs.set_mark(conn, "https://jobs.lever.co/x/2", "saved")                                  # a job you saved is never a candidate
            self.assertEqual([c["title"] for c in self.prune.candidates(conn)], ["AI Product Engineer"])

    def test_a_senior_title_with_no_stated_years_is_a_candidate(self):
        c = sqlite3.connect(self.jdb)
        c.execute("UPDATE jobs SET title='Lead Backend Engineer' WHERE title='Backend Engineer'")
        c.commit()
        c.close()
        with db.tx(self.kb) as conn:
            why = {c["title"]: c["why"] for c in self.prune.candidates(conn)}
        self.assertEqual(why["Lead Backend Engineer"], "title: above entry level")

    def test_remove_backs_up_tombstones_logs_and_spares_acted_on_jobs(self):
        c = sqlite3.connect(self.jdb)
        c.execute("UPDATE jobs SET status='applied' WHERE title='Senior Engineer'")
        c.commit()
        c.close()
        fake = type("S", (), {"backup_db": staticmethod(lambda p, keep=None: Path(str(p) + ".bak-test")), "canonical_url": staticmethod(lambda u: u)})
        with mock.patch.object(self.prune, "_store", lambda: fake), db.tx(self.kb) as conn:
            out = self.prune.remove(conn)
        self.assertEqual(out["removed"], 1)
        c = sqlite3.connect(self.jdb)
        self.assertEqual([r[0] for r in c.execute("SELECT title FROM jobs ORDER BY title")], ["Backend Engineer", "DevOps Engineer", "Senior Engineer", "Software Engineer"])
        self.assertEqual(c.execute("SELECT count(*) FROM seen WHERE canonical_url='https://jobs.ashbyhq.com/3y/0'").fetchone()[0], 1)   # the scanner will not re-add it as new
        reason = c.execute("SELECT reject_reason FROM rejected").fetchone()[0]
        self.assertIn("asks 5+ years, more than 2", reason)
        self.assertIn("apply-factory", reason)
        c.close()

    def test_a_foreign_location_is_a_candidate_and_unknown_places_are_kept(self):
        c = sqlite3.connect(self.jdb)
        c.execute("UPDATE jobs SET location='Remote - US' WHERE title='Software Engineer'")
        c.execute("UPDATE jobs SET location='Thane' WHERE title='Backend Engineer'")      # nobody lists every Indian town: unknown stays
        c.commit()
        c.close()
        locations._LAST.update(key=None, out=set())
        with db.tx(self.kb) as conn:
            got = {x["title"]: x["why"] for x in self.prune.candidates(conn)}
            hidden = jobs.search(conn, limit=100)["fit"]["hidden"]
            titles = [j["title"] for j in jobs.search(conn, limit=100)["rows"]]
        self.assertIn("outside India", got["Software Engineer"])
        self.assertNotIn("Backend Engineer", got)
        self.assertIn("Backend Engineer", titles)
        self.assertNotIn("Software Engineer", titles)
        self.assertEqual(hidden["location"], 1)

    def test_a_helper_that_cannot_run_hides_and_deletes_nothing(self):
        def broken(locs):
            raise OSError("node missing")
        with mock.patch.object(locations, "run_node", broken):
            locations._LAST.update(key=None, out=set())
            self.assertEqual(locations.foreign(["Remote - US", "Pune"]), set())

    def test_a_locked_database_changes_nothing_and_says_so(self):
        fake = type("S", (), {"backup_db": staticmethod(lambda p, keep=None: None), "canonical_url": staticmethod(lambda u: u)})
        blocker = sqlite3.connect(self.jdb)
        blocker.execute("BEGIN IMMEDIATE")
        def quick_rw():
            c = sqlite3.connect(self.jdb, timeout=0.1)     # the same writer, but it gives up fast instead of waiting 30 s
            c.row_factory = sqlite3.Row
            return c
        try:
            with mock.patch.object(self.prune, "_store", lambda: fake), mock.patch.object(self.prune, "_rw", quick_rw), db.tx(self.kb) as conn:
                with self.assertRaisesRegex(ValueError, "Nothing was removed"):
                    self.prune.remove(conn)
        finally:
            blocker.rollback()
            blocker.close()
        c = sqlite3.connect(self.jdb)
        self.assertEqual(c.execute("SELECT count(*) FROM jobs").fetchone()[0], 5)
        c.close()


def _ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


if __name__ == "__main__":
    unittest.main()
