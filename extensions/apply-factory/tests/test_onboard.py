import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import yaml

from lib import config, db, llm, onboard, profile


class OnboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        (self.root / "config").mkdir()
        self.facts = self.root / "facts.yml"
        self.facts.write_text('first_name: "Ada"\nlast_name: "L"\nemail: "a@b.co"\nphone: "+15550001111"\n')
        self.patches = [
            mock.patch.object(config, "CAREEROPS", self.root),
            mock.patch.object(config, "LOCAL", self.root / "config.local.yaml"),
            mock.patch.object(config, "path", lambda key, section="paths": self.facts if key == "facts" else self.root / "cv.md"),
            mock.patch.dict("os.environ", {}, clear=False),
        ]
        for p in self.patches:
            p.start()
        config.load.cache_clear()
        profile.reload()
        llm._pool.cache_clear()
        for n in ("GROQ_API_KEY", "GROQ_API_KEY_2", "GEMINI_API_KEY"):
            __import__("os").environ.pop(n, None)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        config.load.cache_clear()
        profile.reload()
        llm._pool.cache_clear()
        self.tmp.cleanup()

    # ---- keys ----
    def test_a_good_key_is_stored_and_a_second_one_goes_beside_it(self):
        with mock.patch.object(onboard, "fetch", lambda url, headers: 200):
            r = onboard.save_key("groq", "gsk_" + "a" * 40)
            self.assertTrue(r["added"])
            self.assertEqual(r["keys"]["groq"]["count"], 1)
            r = onboard.save_key("groq", "gsk_" + "b" * 40)
            self.assertEqual(r["keys"]["groq"]["count"], 2)
            again = onboard.save_key("groq", "gsk_" + "b" * 40)
            self.assertFalse(again["added"])
        text = (self.root / ".env").read_text()
        self.assertIn("GROQ_API_KEY=gsk_aaaa", text)
        self.assertIn("GROQ_API_KEY_2=gsk_bbbb", text)
        self.assertEqual((self.root / ".env").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("gsk_", str(onboard.keys_status()))

    def test_a_rejected_key_is_not_stored_and_says_why(self):
        with mock.patch.object(onboard, "fetch", lambda url, headers: 401):
            with self.assertRaises(ValueError) as e:
                onboard.save_key("gemini", "AIza" + "c" * 35)
        self.assertIn("did not accept", str(e.exception))
        self.assertFalse((self.root / ".env").exists())

    def test_offline_and_junk_are_told_apart(self):
        def down(url, headers):
            raise urllib.error.URLError("no network")
        with mock.patch.object(onboard, "fetch", down):
            with self.assertRaises(ValueError) as e:
                onboard.save_key("groq", "gsk_" + "a" * 40)
        self.assertIn("internet", str(e.exception))
        with self.assertRaises(ValueError):
            onboard.save_key("groq", "not a key")
        with self.assertRaises(ValueError):
            onboard.save_key("nope", "x" * 30)

    def test_env_set_keeps_other_lines(self):
        (self.root / ".env").write_text("# mine\nOTHER=1\nGROQ_API_KEY=old\n")
        onboard.env_set("GROQ_API_KEY", "new")
        self.assertEqual((self.root / ".env").read_text(), "# mine\nOTHER=1\nGROQ_API_KEY=new\n")

    # ---- cv ----
    def test_cv_text_is_saved_and_the_old_one_kept(self):
        with self.assertRaises(ValueError):
            onboard.cv_set("short")
        onboard.cv_set("A" * 200)
        onboard.cv_set("B" * 200)
        self.assertTrue((self.root / "cv.previous.md").exists())
        self.assertTrue(onboard.cv_get()["text"].startswith("B"))

    # ---- search ----
    def test_role_keywords_cover_engineer_and_developer(self):
        self.assertEqual(onboard.role_keywords(["Backend Engineer"]), ["backend engineer", "backend developer"])

    def test_pipeline_copy_follows_the_answers_and_leaves_the_shared_file_alone(self):
        prefs = {"roles": ["Data Analyst"], "avoid": ["sales"], "keywords": ["sql"], "country": "Germany", "cities": ["Berlin"], "level": "mid", "years": 4}
        p = onboard._pipeline_for(prefs)
        self.assertEqual(p["title_filter"]["positive"], ["data analyst", "sql"])
        self.assertIn("word:principal", p["title_filter"]["negative"])
        self.assertNotIn("word:senior", p["title_filter"]["negative"])   # mid level may take senior roles
        self.assertEqual(p["search"], {"location": "Berlin, Germany", "country": "Germany"})
        self.assertEqual(p["max_min_experience_years"], 5)
        self.assertFalse(p["freshness"]["drop_foreign_location"])
        self.assertNotIn("internshala", [s["id"] for s in p["steps"]])
        self.assertEqual(p["batch_years"], [])
        entry = onboard._pipeline_for({**prefs, "level": "entry", "years": 0, "country": "India", "cities": []})
        self.assertIn("junior data analyst", entry["jobspy"]["terms"])
        self.assertIn("word:senior", entry["title_filter"]["negative"])
        self.assertIn("internshala", [s["id"] for s in entry["steps"]])

    def test_search_needs_the_basics(self):
        for bad in ({}, {"roles": "x"}, {"roles": "x", "level": "entry"}, {"roles": "x", "level": "entry", "country": "India", "years": "many"}):
            with self.assertRaises(ValueError):
                onboard.search_set(bad)

    def test_saving_a_search_writes_the_files_and_keeps_a_hand_made_profile(self):
        raw = {"roles": "Backend Engineer, Platform Engineer", "level": "entry", "country": "India", "cities": "Pune", "years": "1"}
        (self.root / "config" / "profile.yml").write_text("candidate: {full_name: Hand Made}\n")   # not written by the wizard
        r = onboard.search_set(raw)
        self.assertTrue(r["ok"])
        self.assertIn("Kept your existing profile.yml.", r["notes"])
        self.assertTrue((self.root / "portals.yml").exists())
        self.assertIn("Hand Made", (self.root / "config" / "profile.yml").read_text())
        user = yaml.safe_load((self.root / "data" / "pipeline.user.yml").read_text())
        self.assertIn("backend engineer", user["title_filter"]["positive"])
        local = yaml.safe_load((self.root / "config.local.yaml").read_text())
        self.assertEqual(local["company"]["home_region"], "India")
        self.assertEqual(config.home_region(), "India")
        # a second save may now replace what the wizard wrote
        r = onboard.search_set({**raw, "roles": "Site Reliability Engineer"})
        self.assertEqual(r["notes"], [])
        self.assertTrue(list((self.root / "config").glob("profile.yml.bak-*")))
        self.assertIn("Site Reliability Engineer", (self.root / "config" / "profile.yml").read_text())
        self.assertEqual(profile.facts()["country"], "India")   # asked once, not again in the details form

    def test_example_values_in_env_are_not_keys(self):
        (self.root / ".env").write_text("GEMINI_API_KEY=your_gemini_api_key_here\nGROQ_API_KEY=gsk_realvalue123456789012\n")
        self.assertIsNone(config.env("GEMINI_API_KEY"))
        self.assertEqual(config.env("GROQ_API_KEY"), "gsk_realvalue123456789012")
        self.assertEqual(onboard.keys_status()["gemini"]["count"], 0)

    def test_keys_show_only_their_last_four_characters_and_can_be_removed_one_at_a_time(self):
        with mock.patch.object(onboard, "fetch", lambda url, headers: 200):
            onboard.save_key("groq", "gsk_" + "a" * 36 + "WXYZ")
            r = onboard.save_key("groq", "gsk_" + "b" * 36 + "1234")
        g = r["keys"]["groq"]
        self.assertEqual((g["count"], g["max"]), (2, 9))
        self.assertEqual([k["tail"] for k in g["keys"]], ["WXYZ", "1234"])
        self.assertNotIn("gsk_aaaa", str(r))
        r = onboard.remove_key("groq", "GROQ_API_KEY")
        self.assertEqual([k["tail"] for k in r["keys"]["groq"]["keys"]], ["1234"])
        self.assertNotIn("WXYZ", (self.root / ".env").read_text())
        with self.assertRaises(ValueError):
            onboard.remove_key("groq", "PATH")
        with self.assertRaises(ValueError):
            onboard.remove_key("openai", "GROQ_API_KEY")

    def test_the_key_limit_is_enforced_per_provider(self):
        with mock.patch.object(onboard, "fetch", lambda url, headers: 200):
            for i in range(9):
                onboard.save_key("groq", "gsk_" + str(i) * 36 + "abcd")
            with self.assertRaises(ValueError) as e:
                onboard.save_key("groq", "gsk_" + "z" * 36 + "abcd")
        self.assertIn("most", str(e.exception))

    def test_more_titles_are_suggested_without_repeating_the_ones_given(self):
        from tests.fakes import FakeOllama
        fake = FakeOllama(['{"titles": ["Business Analyst", "data analyst", "Reporting Analyst"], "keywords": ["sql", "tableau", "x"]}'])
        fake.install()
        try:
            out = onboard.suggest_roles("Data Analyst", "mid", "United Kingdom")
        finally:
            fake.uninstall()
        self.assertEqual(out["titles"], ["Business Analyst", "Reporting Analyst"])      # "data analyst" was already asked for
        self.assertEqual(out["keywords"], ["sql", "tableau"])                            # too short to be useful: dropped
        with self.assertRaises(ValueError):
            onboard.suggest_roles("", "mid", "UK")

    def test_scan_says_what_is_missing_instead_of_failing(self):
        from lib import scan
        self.assertIn("not in this folder", scan.can_scan())
        self.assertIn("error", scan.start())


if __name__ == "__main__":
    unittest.main()
