import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import launcher  # noqa: E402


def q(url):
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


class Builders(unittest.TestCase):
    def test_all_twenty_terms_and_every_site_present(self):
        terms = launcher.terms_from_config()
        self.assertEqual(len(terms), 20)
        for name in ("google", "google-jobs", "linkedin", "linkedin-jobs", "indeed", "naukri", "internshala", "foundit", "wellfound", "unstop"):
            self.assertIn(name, launcher.SITES)
        self.assertEqual(len(launcher.build_plan(list(launcher.SITES), terms, 1)), 20 * len(launcher.SITES))

    def test_google_past_24h_sorted_by_date(self):
        self.assertEqual(q(launcher.google("sde 1", 1))["tbs"], "qdr:d,sbd:1")
        self.assertEqual(q(launcher.google("sde 1", 3))["tbs"], "qdr:d3,sbd:1")
        self.assertEqual(q(launcher.google("sde 1", 7))["tbs"], "qdr:w,sbd:1")

    def test_google_jobs_date_chip_in_both_params(self):
        p = q(launcher.google_jobs("sde 1", 1))
        self.assertEqual(p["htichips"], "date_posted:today")
        self.assertEqual(p["htischips"], "date_posted;today")
        self.assertEqual(p["udm"], "8")

    def test_linkedin_posts_and_jobs_filters(self):
        p = q(launcher.linkedin("sde 1", 1))
        self.assertEqual((p["datePosted"], p["sortBy"]), ('"past-24h"', '"date_posted"'))
        j = q(launcher.linkedin_jobs("sde 1", 1))
        self.assertEqual((j["f_TPR"], j["f_E"], j["sortBy"]), ("r86400", "1,2", "DD"))

    def test_sites_with_fixed_day_choices_snap_up(self):
        self.assertEqual(q(launcher.indeed("x", 2))["fromage"], "3")
        self.assertEqual(q(launcher.indeed("x", 1))["fromage"], "1")
        self.assertEqual(q(launcher.naukri("x", 2))["jobAge"], "3")
        self.assertEqual(q(launcher.naukri("x", 10))["jobAge"], "15")
        self.assertEqual(q(launcher.foundit("x", 4))["jobFreshness"], "7")

    def test_unstop_is_a_site(self):
        self.assertTrue(launcher.unstop("sde 1", 1).startswith("https://unstop.com/"))

    def test_every_url_is_https_and_has_the_term(self):
        for name, fn in launcher.SITES.items():
            url = fn("python developer fresher", 1)
            self.assertTrue(url.startswith("https://"), name)
            self.assertTrue("python" in url, name)

    def test_samples_are_per_site(self):
        plan = launcher.build_plan(["google", "indeed"], ["a b", "c d", "e f"], 1)
        self.assertEqual([s for s, _, _ in launcher.sample(plan, 2)], ["google", "google", "indeed", "indeed"])


class WeeklyAndCsv(unittest.TestCase):
    def test_parse_weekly(self):
        text = "# comment\n\nGSoC | https://summerofcode.withgoogle.com/\nhttps://cutshort.io/jobs\nnot a link\n"
        self.assertEqual(launcher.parse_weekly(text), [("weekly", "GSoC", "https://summerofcode.withgoogle.com/"),
                                                       ("weekly", "https://cutshort.io/jobs", "https://cutshort.io/jobs")])

    def test_shipped_weekly_file_has_no_live_links_until_the_user_adds_them(self):
        text = (Path(__file__).parent / "weekly_links.txt").read_text()
        self.assertEqual(launcher.parse_weekly(text), [])

    def test_csv_columns(self):
        import csv, tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.csv"
            launcher.write_csv(p, [("indeed", "sde 1", "https://in.indeed.com/jobs?q=sde+1")])
            rows = list(csv.reader(p.open()))
        self.assertEqual(rows[0], ["label", "url", "done"])
        self.assertEqual(rows[1], ["indeed: sde 1", "https://in.indeed.com/jobs?q=sde+1", ""])


if __name__ == "__main__":
    unittest.main()
