import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from canonical import canonical_url, city_key, company_key, fuzzy_key, title_key  # noqa: E402
from dedup import collapse_stats, merge_offers, similar_unmerged  # noqa: E402


class Canonical(unittest.TestCase):
    def test_linkedin_reduces_to_job_id(self):
        want = "https://www.linkedin.com/jobs/view/3912345678"
        self.assertEqual(canonical_url("https://in.linkedin.com/jobs/view/software-engineer-intern-at-acme-3912345678?refId=abc%3D%3D&trackingId=xyz&position=3&pageNum=0"), want)
        self.assertEqual(canonical_url("https://www.linkedin.com/jobs/view/3912345678/"), want)
        self.assertEqual(canonical_url("https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=sde"), want)

    def test_indeed_uses_jk(self):
        want = "https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718"
        self.assertEqual(canonical_url("https://in.indeed.com/viewjob?jk=a1b2c3d4e5f60718&tk=1h&from=serp&vjs=3"), want)
        self.assertEqual(canonical_url("https://in.indeed.com/jobs?q=sde&vjk=a1b2c3d4e5f60718"), want)

    def test_naukri_uses_job_id(self):
        a = canonical_url("https://www.naukri.com/job-listings-software-engineer-acme-bengaluru-0-to-2-years-091125012345?src=jobsearchDesk&sid=1&xp=1")
        b = canonical_url("https://www.naukri.com/job-listings-software-engineer-fresher-acme-technologies-bangalore-0-to-1-years-091125012345")
        self.assertEqual(a, b)

    def test_ats_urls_stay_stable(self):
        self.assertEqual(canonical_url("https://job-boards.greenhouse.io/celonis/jobs/7665962003?gh_jid=7665962003&utm_source=linkedin"),
                         "https://boards.greenhouse.io/celonis/jobs/7665962003")
        self.assertEqual(canonical_url("https://boards.greenhouse.io/celonis/jobs/7665962003"),
                         "https://boards.greenhouse.io/celonis/jobs/7665962003")
        self.assertEqual(canonical_url("https://jobs.lever.co/razorpay/0c1d2e3f-aaaa-bbbb-cccc-123456789012/apply?lever-source=Naukri"),
                         "https://jobs.lever.co/razorpay/0c1d2e3f-aaaa-bbbb-cccc-123456789012")
        self.assertEqual(canonical_url("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Pune/SDE-I_R1234?utm_medium=x"),
                         "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Pune/SDE-I_R1234")

    def test_unknown_site_keeps_meaningful_params_only(self):
        self.assertEqual(canonical_url("https://careers.example.com/jobs?id=42&utm_campaign=x&fbclid=1"), "https://careers.example.com/jobs?id=42")

    def test_empty(self):
        self.assertEqual(canonical_url(""), "")


class FuzzyKey(unittest.TestCase):
    def test_company_suffixes_and_case(self):
        self.assertEqual(company_key("Acme Technologies Pvt. Ltd."), company_key("ACME Technologies"))

    def test_title_order_noise_and_batch(self):
        self.assertEqual(title_key("Software Engineer Intern (2027 Batch)"), title_key("Intern - Software Engineer URGENT"))

    def test_city_aliases_and_generic(self):
        self.assertEqual(city_key("Bangalore, Karnataka, India"), city_key("Bengaluru / Remote"))
        self.assertEqual(city_key("India"), "")
        self.assertIsNone(fuzzy_key("Acme", "SDE Intern", "Remote"))

    def test_different_city_differs(self):
        self.assertNotEqual(fuzzy_key("Acme", "SDE Intern", "Pune"), fuzzy_key("Acme", "SDE Intern", "Chennai"))


LI = {"company": "Acme Technologies Pvt Ltd", "title": "Software Engineer Intern", "location": "Bengaluru, Karnataka, India",
      "url": "https://in.linkedin.com/jobs/view/software-engineer-intern-at-acme-3912345678?trackingId=x"}
NK = {"company": "Acme Technologies", "title": "Software Engineer - Intern", "location": "Bangalore",
      "url": "https://www.naukri.com/job-listings-software-engineer-intern-acme-bengaluru-0-to-1-years-091125012345"}
ATS = {"company": "Acme", "title": "Software Engineer Intern", "location": "Bengaluru",
       "url": "https://boards.greenhouse.io/acme/jobs/7001234"}


class Merge(unittest.TestCase):
    def test_three_sources_collapse_to_one_row_with_three_found_by(self):
        rows = merge_offers({"jobspy": [LI, NK], "ats": [ATS]}, today="2026-11-09")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["found_by"], ["greenhouse", "linkedin", "naukri"])
        self.assertEqual(r["url"], ATS["url"])  # employer URL beats the aggregators
        self.assertEqual(r["confidence"], "employer-confirmed")
        self.assertEqual(set(r["first_seen"]), {"greenhouse", "linkedin", "naukri"})

    def test_same_url_twice_is_one_row(self):
        rows = merge_offers({"a": [LI], "b": [{**LI, "url": LI["url"] + "&refId=zzz"}]})
        self.assertEqual(len(rows), 1)

    def test_transitive_merge(self):
        # A and C share nothing directly; B links them by URL and by fuzzy key
        a = {"company": "Beta", "title": "Backend Intern", "location": "Pune", "url": "https://x.example/a"}
        b = {"company": "Beta Inc", "title": "Backend Intern", "location": "Pune", "url": "https://x.example/b"}
        c = {"company": "Other", "title": "Whatever", "location": "Pune", "url": "https://x.example/b?utm_source=z"}
        self.assertEqual(len(merge_offers({"s": [a, b, c]})), 1)  # a+b by fuzzy key, b+c by URL

    def test_different_cities_do_not_merge(self):
        a = {**ATS, "url": "https://boards.greenhouse.io/acme/jobs/1", "location": "Pune"}
        b = {**ATS, "url": "https://boards.greenhouse.io/acme/jobs/2", "location": "Chennai"}
        self.assertEqual(len(merge_offers({"ats": [a, b]})), 2)

    def test_aggregator_only_is_not_employer_confirmed(self):
        self.assertEqual(merge_offers({"j": [LI]})[0]["confidence"], "aggregator")

    def test_first_seen_keeps_earliest_per_source(self):
        rows = merge_offers({"j": [{**LI, "first_seen": "2026-11-05"}, {**LI, "first_seen": "2026-11-08"}]})
        self.assertEqual(rows[0]["first_seen"]["linkedin"], "2026-11-05")

    def test_collapse_stats_pairs(self):
        stats = collapse_stats(merge_offers({"jobspy": [LI, NK], "ats": [ATS]}))
        self.assertEqual(stats, {("greenhouse", "linkedin"): 1, ("greenhouse", "naukri"): 1, ("linkedin", "naukri"): 1})

    def test_similar_but_unmerged_are_reported(self):
        a = {"company": "Acme", "title": "Software Engineer Intern", "location": "Pune", "url": "https://x.example/1"}
        b = {"company": "Acme", "title": "Software Engineer Intern Backend", "location": "Pune", "url": "https://x.example/2"}
        rows = merge_offers({"s": [a, b]})
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(similar_unmerged(rows)), 1)


if __name__ == "__main__":
    unittest.main()
