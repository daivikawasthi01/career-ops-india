import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).parent))
import mine  # noqa: E402

NOW = datetime(2026, 11, 9, 12, 0, 0)
STEPS = [{"id": "freehire"}, {"id": "jobspy"}, {"id": "ats"}]


def ago(days):
    return (NOW - timedelta(days=days)).isoformat()


class RecordRun(unittest.TestCase):
    def test_real_run_records_time_and_coverage(self):
        state = {}
        self.assertTrue(mine.record_run(state, {"id": "ats", "status": "partial", "coverage": 0.6}, False, NOW))
        self.assertEqual(state["ats"], {"at": "2026-11-09T12:00:00", "coverage": 0.6})

    def test_dry_run_never_moves_the_schedule(self):
        state = {}
        self.assertFalse(mine.record_run(state, {"id": "ats", "status": "ok", "coverage": 0.9}, True, NOW))
        self.assertEqual(state, {})

    def test_failed_step_is_not_recorded(self):
        state = {}
        self.assertFalse(mine.record_run(state, {"id": "ats", "status": "failed"}, False, NOW))
        self.assertEqual(state, {})


class Coverage(unittest.TestCase):
    def test_share_of_boards_read(self):
        self.assertAlmostEqual(mine.receipt_coverage({"companiesScanned": 1000, "unreachableBoards": 400}), 0.6)

    def test_missing_or_zero_scanned_is_unknown(self):
        self.assertIsNone(mine.receipt_coverage(None))
        self.assertIsNone(mine.receipt_coverage({"companiesScanned": 0, "unreachableBoards": 0}))
        self.assertIsNone(mine.receipt_coverage({}))


class StateFile(unittest.TestCase):
    def test_round_trip_and_missing_file(self):
        with TemporaryDirectory() as d:
            path = Path(d) / "sub" / "state.json"
            self.assertEqual(mine.load_state(path), {})
            mine.save_state({"ats": {"at": "2026-11-09T12:00:00", "coverage": 0.9}}, path)
            self.assertEqual(mine.load_state(path)["ats"]["coverage"], 0.9)



class BareLines(unittest.TestCase):
    class Bar:
        total = n = 0
        def refresh(self): pass

    def test_receipt_is_returned_and_offer_lines_are_ignored(self):
        bar = self.Bar()
        self.assertIsNone(mine.parse_bare_line("ats", '{"kind":"offer","url":"https://x","company":"A","title":"B"}', bar))
        self.assertEqual(mine.parse_bare_line("portals", '{"added_urls":["u"],"errors":[]}', bar)["added_urls"], ["u"])
        self.assertEqual(mine.parse_bare_line("ats", '{"postingsKept":3}', bar)["postingsKept"], 3)

    def test_progress_tick(self):
        bar = self.Bar()
        mine.parse_bare_line("portals", "scan: 5/20", bar)
        self.assertEqual((bar.n, bar.total), (5, 20))


class SitesAndWindows(unittest.TestCase):
    def test_merge_collapses_across_steps_and_keeps_found_by(self):
        rows = mine.merge({"jobspy": [{"company": "Acme", "title": "SDE Intern", "location": "Pune", "source": "jobspy:linkedin",
                                      "url": "https://www.linkedin.com/jobs/view/3912345678"}],
                           "ats": [{"company": "Acme", "title": "SDE Intern", "location": "Pune", "source": "greenhouse",
                                    "url": "https://boards.greenhouse.io/acme/jobs/1"}]})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["found_by"], ["greenhouse", "linkedin"])

    def test_fetched_count_per_scanner(self):
        self.assertEqual(mine.receipt_fetched("freehire", None, {"fetched": 40}, 3), 40)
        self.assertEqual(mine.receipt_fetched("portals", {"found": 120}, {}, 3), 120)
        self.assertEqual(mine.receipt_fetched("ats", {"postingsKept": 5, "postingsDroppedNoDate": 7}, {}, 5), 12)
        self.assertEqual(mine.receipt_fetched("internshala", None, {}, 9), 9)


class SlowLane(unittest.TestCase):
    def test_plan_defaults_and_empty_sites(self):
        self.assertEqual(mine.slow_plan(None), (8, 60))
        self.assertEqual(mine.slow_plan({"batches": 3, "gap_minutes": 30}), (3, 30))
        self.assertIsNone(mine.slow_plan({}, slow_sites=[]))
        self.assertEqual(mine.jobspy_sites("first_pass"), ["naukri", "indeed"])
        self.assertEqual(mine.jobspy_sites("slow"), ["linkedin", "glassdoor"])
        self.assertEqual(mine.slow_plan({"batches": 0, "gap_minutes": 0}), (1, 1))

    def test_lock_tracks_a_live_process(self):
        with TemporaryDirectory() as d:
            lock = Path(d) / "slow.pid"
            self.assertFalse(mine.slow_lane_running(lock))
            lock.write_text(str(mine.os.getpid()))
            self.assertTrue(mine.slow_lane_running(lock))
            lock.write_text("not a pid")
            self.assertFalse(mine.slow_lane_running(lock))

    def test_batches_sleep_between_runs_and_clear_the_lock(self):
        with TemporaryDirectory() as d:
            lock, naps, runs = Path(d) / "slow.pid", [], []

            class Done:
                returncode = 0

            real = mine.subprocess.run
            mine.subprocess.run = lambda cmd, **kw: (runs.append(cmd), Done())[1]
            try:
                self.assertEqual(mine.run_slow_batches(3, 10, lock=lock, sleep=naps.append), 0)
            finally:
                mine.subprocess.run = real
            self.assertEqual(len(runs), 3)
            self.assertEqual(naps, [600, 600])
            self.assertFalse(lock.exists())

    def test_two_failed_batches_in_a_row_stop_the_lane(self):
        with TemporaryDirectory() as d:
            runs = []

            class Bad:
                returncode = 1

            real = mine.subprocess.run
            mine.subprocess.run = lambda cmd, **kw: (runs.append(cmd), Bad())[1]
            try:
                self.assertEqual(mine.run_slow_batches(5, 1, lock=Path(d) / "s.pid", sleep=lambda s: None), 1)
            finally:
                mine.subprocess.run = real
            self.assertEqual(len(runs), 2)


class StepRegistry(unittest.TestCase):
    REG = [{"id": "a", "file": "a.mjs", "windowed": True}, {"id": "b", "file": "b.mjs", "bare_json": True},
           {"id": "slow", "file": "s.mjs", "standalone": True, "cli": "--slow", "state_id": "s-slow"}]

    def test_default_run_excludes_standalone_and_windows_only_windowed(self):
        self.assertEqual(mine.default_step_ids(self.REG), ["a", "b", "slow"][:2])
        self.assertEqual(mine.windowed_ids(self.REG), ["a"])

    def test_every_registered_step_has_an_argument_builder(self):
        self.assertEqual({e["id"] for e in mine.step_registry()} - set(mine.STEP_ARGS), set())

    def test_standalone_step_records_under_its_state_id_and_carries_its_flag(self):
        import argparse
        a = argparse.Namespace(days=None, dry_run=True)
        mine.STEP_ARGS["slow"] = lambda ns, w: []
        step = mine.make_step(self.REG[2], a)
        self.assertEqual((step["id"], step["args"]), ("s-slow", ["--slow", "--dry-run"]))


if __name__ == "__main__":
    unittest.main()
