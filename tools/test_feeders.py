import unittest
import feeders


def due_fn(state, sid, every):
    return sid not in state


class FeederSelection(unittest.TestCase):
    def setUp(self):
        self.fs = feeders.feeder_list()

    def test_default_run_takes_only_due_feeders(self):
        got, notes = feeders.select_feeders(self.fs, {"campus": 1, "telegram": 1}, [], False, due_fn)
        self.assertEqual([f["id"] for f in got], ["directory", "boards", "ats-tenants", "boards-review", "funding"])
        self.assertIn("campus", notes[0])

    def test_named_steps_run_exactly_those_feeders_even_when_not_due(self):
        got, _ = feeders.select_feeders(self.fs, {"campus": 1}, ["campus", "freehire"], False, due_fn)
        self.assertEqual([f["id"] for f in got], ["campus"])

    def test_scanner_only_steps_run_no_feeders(self):
        got, _ = feeders.select_feeders(self.fs, {}, ["freehire", "jobspy"], False, due_fn)
        self.assertEqual(got, [])

    def test_dry_run_and_opt_out_run_none(self):
        self.assertEqual(feeders.select_feeders(self.fs, {}, [], True, due_fn)[0], [])
        self.assertEqual(feeders.select_feeders(self.fs, {}, [], False, due_fn, no_feeders=True), ([], []))

    def test_feeder_files_exist(self):
        for f in self.fs:
            self.assertTrue((feeders.ROOT / "tools" / f["file"]).exists(), f["file"])


if __name__ == "__main__":
    unittest.main()
