import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import freshness  # noqa: E402

RULES = {"max_age_days": 7, "undated_ok_steps": ["jobspy", "internshala"], "undated_ok_sources": ["instahyre"]}
TODAY = date(2026, 11, 10)


def row(**kw):
    return {"title": "Software Engineer", "posted": "2026-11-09", "steps": {"portals"}, "found_by": ["lever"], **kw}


class TitleYears(unittest.TestCase):
    def test_reads_ranges_and_plain_years(self):
        self.assertEqual(freshness.title_min_years("PHP Developer (3–5 Years Experience)"), 3)
        self.assertEqual(freshness.title_min_years("Analyst (2 - 4 yrs)"), 2)
        self.assertEqual(freshness.title_min_years("Engineer (0-2 Yrs)"), 0)
        self.assertEqual(freshness.title_min_years("Engineer 5+ years"), 5)
        self.assertIsNone(freshness.title_min_years("Software Engineer 2027 Batch"))
        self.assertIsNone(freshness.title_min_years(None))


class Verdict(unittest.TestCase):
    def v(self, r, **kw):
        return freshness.verdict(r, RULES, today=TODAY, **kw)

    def test_recent_dated_row_passes_and_old_one_is_stale(self):
        self.assertIsNone(self.v(row()))
        self.assertIsNone(self.v(row(posted="2026-11-03")))  # exactly 7 days
        self.assertEqual(self.v(row(posted="2026-11-02")), "stale")

    def test_undated_passes_only_from_a_windowed_step_or_capped_source(self):
        self.assertEqual(self.v(row(posted=None)), "undated")
        self.assertIsNone(self.v(row(posted=None, steps={"jobspy"})))
        self.assertIsNone(self.v(row(posted="", steps={"portals", "internshala"})))
        self.assertIsNone(self.v(row(posted=None, found_by=["instahyre"])))

    def test_unreadable_date_counts_as_undated(self):
        self.assertEqual(self.v(row(posted="soon")), "undated")

    def test_title_experience_above_the_limit_is_dropped_even_when_recent(self):
        self.assertEqual(self.v(row(title="Dev (3-5 Years)")), "experience")
        self.assertIsNone(self.v(row(title="Dev (0-2 Yrs)")))
        self.assertIsNone(freshness.verdict(row(title="Dev (1-3 Yrs)"), RULES, max_years=1, today=TODAY))

    def test_no_rules_means_only_the_experience_check(self):
        self.assertIsNone(freshness.verdict(row(posted=None), {}, today=TODAY))
        self.assertEqual(freshness.verdict(row(title="Dev (4 yrs)"), {}, today=TODAY), "experience")


class Apply(unittest.TestCase):
    def test_splits_rows_and_counts_reasons(self):
        rows = [row(), row(posted="2026-10-01"), row(posted=None), row(posted=None, steps={"jobspy"}), row(title="X (5 years)")]
        kept, dropped = freshness.apply(rows, RULES, today=TODAY)
        self.assertEqual(len(kept), 2)
        self.assertEqual(dict(dropped), {"stale": 1, "undated": 1, "experience": 1})
        self.assertEqual(freshness.apply([], RULES, today=TODAY), ([], {}))


if __name__ == "__main__":
    unittest.main()
