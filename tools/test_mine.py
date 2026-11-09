import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).parent))
import mine  # noqa: E402


class StepDue(unittest.TestCase):
    now = datetime(2026, 11, 9, 12, 0, 0)

    def test_never_run_is_due(self):
        self.assertTrue(mine.step_due({}, "ats", 7, self.now))

    def test_recent_run_is_not_due(self):
        state = {"ats": (self.now - timedelta(days=3)).isoformat()}
        self.assertFalse(mine.step_due(state, "ats", 7, self.now))

    def test_old_run_is_due(self):
        state = {"ats": (self.now - timedelta(days=7)).isoformat()}
        self.assertTrue(mine.step_due(state, "ats", 7, self.now))

    def test_garbage_timestamp_is_due(self):
        self.assertTrue(mine.step_due({"ats": "not a date"}, "ats", 7, self.now))

    def test_state_round_trip_and_missing_file(self):
        with TemporaryDirectory() as d:
            path = Path(d) / "sub" / "state.json"
            self.assertEqual(mine.load_state(path), {})
            mine.save_state({"ats": "2026-11-09T12:00:00"}, path)
            self.assertEqual(mine.load_state(path), {"ats": "2026-11-09T12:00:00"})


if __name__ == "__main__":
    unittest.main()
