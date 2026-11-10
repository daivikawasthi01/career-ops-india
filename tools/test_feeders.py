import unittest
import feeders


class FeederSelection(unittest.TestCase):
    def setUp(self):
        self.fs = feeders.feeder_list()

    def test_default_run_takes_every_feeder_in_order(self):
        got, notes = feeders.select_feeders(self.fs, [], False)
        self.assertEqual([f["id"] for f in got], ["directory", "boards", "ats-tenants", "boards-review", "telegram", "funding", "campus"])
        self.assertEqual(notes, [])

    def test_named_steps_run_exactly_those_feeders(self):
        got, _ = feeders.select_feeders(self.fs, ["campus", "freehire"], False)
        self.assertEqual([f["id"] for f in got], ["campus"])

    def test_scanner_only_steps_run_no_feeders(self):
        got, _ = feeders.select_feeders(self.fs, ["freehire", "jobspy"], False)
        self.assertEqual(got, [])

    def test_dry_run_and_opt_out_run_none(self):
        self.assertEqual(feeders.select_feeders(self.fs, [], True)[0], [])
        self.assertEqual(feeders.select_feeders(self.fs, [], False, no_feeders=True), ([], []))

    def test_no_feeder_carries_a_schedule(self):
        self.assertTrue(all("every" not in f for f in self.fs))

    def test_feeder_files_exist(self):
        for f in self.fs:
            self.assertTrue((feeders.ROOT / "tools" / f["file"]).exists(), f["file"])


if __name__ == "__main__":
    unittest.main()
