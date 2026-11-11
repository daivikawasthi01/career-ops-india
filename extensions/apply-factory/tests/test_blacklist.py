import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import blacklist, config, db, jobs, jobs_prune
from tests.test_jobs_fit import YearsBase, _ro, make_jobs_db  # noqa: F401  (YearsBase sets up a jobs.db of five "Acme" jobs)


def stand_in(pairs):
    """Stands in for tools/blacklist-match.mjs: company names compared without case or punctuation."""
    listed = {re.sub(r"\W+", "", e["company"].lower()) for e in blacklist.entries() if e["scope"] == "company"}
    return [i for i, p in enumerate(pairs) if re.sub(r"\W+", "", p["company"].lower()) in listed]


class FileCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self._root = mock.patch.object(config, "CAREEROPS", self.root)
        self._root.start()
        self._node = mock.patch.object(blacklist, "run_node", stand_in)
        self._node.start()
        blacklist._CACHE.clear()

    def tearDown(self):
        self._node.stop()
        self._root.stop()


class FileTest(FileCase):
    def test_adding_creates_the_file_once_and_cleans_the_text(self):
        res = blacklist.add("  Ghost | Corp ", "posts the same job\nall day")
        self.assertTrue(res["added"])
        text = (self.root / "data" / "blacklist.md").read_text()
        self.assertIn("| Company | Since | Scope | Reason |", text)
        self.assertEqual([(e["company"], e["scope"], e["reason"]) for e in blacklist.entries()], [("Ghost / Corp", "company", "posts the same job all day")])
        self.assertFalse(blacklist.add("ghost / corp.")["added"])                     # the same company again changes nothing
        self.assertEqual(len(blacklist.entries()), 1)
        with self.assertRaises(blacklist.BlacklistError):
            blacklist.add("   ")

    def test_edit_and_remove_leave_the_rest_of_the_file_alone(self):
        p = self.root / "data" / "blacklist.md"
        p.parent.mkdir(parents=True)
        p.write_text("# Mine\n\nnotes I wrote\n\n| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-01 | company | old |\n| ibm.com | 2026-02-02 | domain | hosts |\n")
        acme, ibm = blacklist.entries()
        blacklist.update(acme["line"], "Acme", "Acme Ltd", "spam")
        self.assertEqual([(e["company"], e["since"], e["reason"]) for e in blacklist.entries()], [("Acme Ltd", "2026-01-01", "spam"), ("ibm.com", "2026-02-02", "hosts")])
        self.assertIn("notes I wrote", p.read_text())
        blacklist.remove(ibm["line"], "ibm.com")
        self.assertEqual([e["company"] for e in blacklist.entries()], ["Acme Ltd"])
        self.assertTrue(p.read_text().startswith("# Mine"))

    def test_a_stale_edit_is_refused_and_a_rename_cannot_collide(self):
        a = blacklist.add("Acme")["entry"]
        b = blacklist.add("Globex")["entry"]
        with self.assertRaises(blacklist.BlacklistError):
            blacklist.remove(a["line"], "Globex")                                       # the line holds a different company than the screen thinks
        with self.assertRaises(blacklist.BlacklistError):
            blacklist.update(b["line"], "Globex", "ACME", "")                           # would duplicate Acme
        self.assertEqual(len(blacklist.entries()), 2)

    def test_blocked_asks_the_matcher_once_per_state_and_skips_it_with_no_list(self):
        rows = [{"company": "Acme Corp", "url": "u1"}, {"company": "Fine", "url": "u2"}]
        with mock.patch.object(blacklist, "run_node", side_effect=AssertionError("no list, no call")):
            self.assertEqual(blacklist.blocked(rows), set())
        blacklist.add("acme corp")
        calls = []
        with mock.patch.object(blacklist, "run_node", lambda p: calls.append(1) or stand_in(p)):
            self.assertEqual(blacklist.blocked(rows), {0})
            self.assertEqual(blacklist.blocked(rows), {0})
        self.assertEqual(len(calls), 1)
        with mock.patch.object(blacklist, "run_node", side_effect=OSError("node missing")):
            blacklist._CACHE.clear()
            self.assertEqual(blacklist.blocked(rows), set())                           # a broken helper hides nothing


class JobsTest(FileCase, YearsBase):
    def setUp(self):
        FileCase.setUp(self)
        YearsBase.setUp(self)

    def tearDown(self):
        YearsBase.tearDown(self)
        FileCase.tearDown(self)

    def test_a_listed_company_leaves_the_list_even_with_the_level_filter_off(self):
        with db.tx(self.kb) as conn:
            self.assertEqual(len(jobs.search(conn, fit=False, limit=100)["rows"]), 5)
        blacklist.add("Acme")
        with db.tx(self.kb) as conn:
            res = jobs.search(conn, fit=False, limit=100)
        self.assertEqual((res["total"], res["fit"]["hidden"]["blacklist"]), (0, 5))
        with db.tx(self.kb) as conn:
            self.assertEqual(jobs.years_todo(conn), [])

    def test_adding_deletes_the_jobs_with_tombstones_and_removing_forgets_them(self):
        c = sqlite3.connect(self.jdb)
        c.execute("CREATE TABLE seen (canonical_url TEXT PRIMARY KEY, first_seen TEXT, fuzzy_key TEXT, expired_at TEXT)")
        c.execute("CREATE TABLE rejected (title TEXT, company TEXT, source TEXT, url TEXT, reject_reason TEXT, seen_at TEXT, UNIQUE(url, reject_reason, seen_at))")
        c.execute("UPDATE jobs SET urls = '[]', company = 'Globex' WHERE title = 'Backend Engineer'")
        c.execute("UPDATE jobs SET status = 'applied' WHERE title = 'DevOps Engineer'")
        c.commit()
        c.close()
        fake = type("S", (), {"backup_db": staticmethod(lambda p, keep=None: Path(str(p) + ".bak")), "canonical_url": staticmethod(lambda u: u)})
        paths = mock.patch.object(config, "path", lambda key, section="paths": self.jdb if key == "jobs_db" else config.ROOT / config.load()[section][key])
        with paths, mock.patch.object(jobs_prune, "_store", lambda: fake):
            blacklist.add("Acme")
            with db.tx(self.kb) as conn:
                ids = [x["id"] for x in jobs_prune.candidates(conn) if x["why"].startswith("blacklist:")]
                self.assertEqual(len(ids), 3)                                           # the applied one and Globex stay
                self.assertEqual(jobs_prune.remove(conn, ids)["removed"], 3)
            c = sqlite3.connect(self.jdb)
            self.assertEqual(sorted(r[0] for r in c.execute("SELECT title FROM jobs")), ["Backend Engineer", "DevOps Engineer"])
            self.assertEqual(c.execute("SELECT count(*) FROM seen").fetchone()[0], 3)
            self.assertIn("blacklist: Acme (apply-factory)", c.execute("SELECT reject_reason FROM rejected").fetchone()[0])
            c.close()
            self.assertEqual(jobs_prune.restore("Acme")["restored"], 3)
            c = sqlite3.connect(self.jdb)
            self.assertEqual((c.execute("SELECT count(*) FROM seen").fetchone()[0], c.execute("SELECT count(*) FROM rejected").fetchone()[0]), (0, 0))
            c.close()


if __name__ == "__main__":
    unittest.main()
