import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import health  # noqa: E402

CFG = {"history_runs": 14, "degraded_ratio": 0.4, "min_history": 3}


def hist(*counts):
    return [{"fetched": c, "status": "ok"} for c in counts]


class Assess(unittest.TestCase):
    def test_three_rows_against_median_of_100_is_degraded(self):
        status, why = health.assess(3, "ok", hist(*[100] * 14), CFG)
        self.assertEqual(status, health.DEGRADED)
        self.assertIn("median 100", why)

    def test_normal_run_is_ok(self):
        self.assertEqual(health.assess(90, "ok", hist(*[100] * 5), CFG)[0], health.OK)

    def test_exactly_at_threshold_is_ok(self):
        self.assertEqual(health.assess(40, "ok", hist(*[100] * 5), CFG)[0], health.OK)

    def test_zero_is_dead(self):
        self.assertEqual(health.assess(0, "ok", hist(100, 100, 100), CFG)[0], health.DEAD)

    def test_zero_without_history_is_still_dead(self):
        self.assertEqual(health.assess(0, "ok", [], CFG)[0], health.DEAD)

    def test_failed_scanner(self):
        self.assertEqual(health.assess(50, "failed", hist(100, 100, 100), CFG)[0], health.FAILED)

    def test_too_little_history_cannot_judge_degraded(self):
        self.assertEqual(health.assess(1, "ok", hist(100, 100), CFG)[0], health.OK)

    def test_failed_runs_do_not_lower_the_median(self):
        h = [{"fetched": 0, "status": "failed"}] * 5 + hist(100, 100, 100)
        self.assertEqual(health.baseline(h, CFG), 100)

    def test_only_last_14_runs_count(self):
        h = hist(*[10] * 14) + hist(*[1000] * 20)
        self.assertEqual(health.baseline(h, CFG), 10)


class ExitCode(unittest.TestCase):
    def test_codes(self):
        self.assertEqual(health.exit_code([{"health": "OK"}]), 0)
        self.assertEqual(health.exit_code([{"health": "OK"}, {"health": "DEGRADED"}]), 3)
        self.assertEqual(health.exit_code([{"health": "DEGRADED"}, {"health": "DEAD"}]), 1)
        self.assertEqual(health.exit_code([{"health": "FAILED"}]), 1)


class Window(unittest.TestCase):
    NOW = datetime(2026, 11, 9, 12, 0)
    CFG = {"overlap_days": 1, "default_days": 3, "max_days": 14}

    def test_since_last_success_plus_overlap(self):
        self.assertEqual(health.window_days("2026-11-07T12:00:00", None, self.NOW, self.CFG), 3)

    def test_explicit_days_win(self):
        self.assertEqual(health.window_days("2026-11-07T12:00:00", 9, self.NOW, self.CFG), 9)

    def test_never_run_uses_default(self):
        self.assertEqual(health.window_days(None, None, self.NOW, self.CFG), 3)

    def test_long_sleep_is_capped(self):
        self.assertEqual(health.window_days("2026-09-01T00:00:00", None, self.NOW, self.CFG), 14)

    def test_minimum_one_day(self):
        self.assertEqual(health.window_days("2026-11-09T11:59:00", None, self.NOW, {**self.CFG, "overlap_days": 0}), 1)


class Classify(unittest.TestCase):
    def test_classes(self):
        c = health.classify_failure
        self.assertEqual(c("freehire 429 for https://x"), "rate_limited")
        self.assertEqual(c("HTTP 404"), "not_found")
        self.assertEqual(c("no answer after 60s"), "timeout")
        self.assertEqual(c("Unexpected token < in JSON"), "parse_error")
        self.assertEqual(c("returned nothing"), "empty")
        self.assertEqual(c("fetch failed ECONNRESET"), "network")
        self.assertEqual(c("something odd"), "other")


class Table(unittest.TestCase):
    def test_table_has_every_column(self):
        t = health.summary_table([{"source": "freehire", "fetched": 3, "kept": 1, "new": 1, "duplicates": 0, "errors": 0, "health": "DEGRADED", "seconds": 4}])
        self.assertIn("DEGRADED", t.splitlines()[2])
        self.assertIn("fetched", t.splitlines()[0])


if __name__ == "__main__":
    unittest.main()
