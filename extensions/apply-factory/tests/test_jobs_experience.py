import unittest

from lib import years


def rec(state="read", status="stated", mn=None):
    return {"state": state, "status": status, "min_years": mn}


class ExperienceFilter(unittest.TestCase):
    def test_zero_means_no_experience_needed(self):
        self.assertTrue(years.fits(rec(mn=0), 0))
        self.assertFalse(years.fits(rec(mn=2), 0))
        self.assertTrue(years.fits(rec(status="none"), 0))

    def test_unread_job_passes_zero_only_with_an_entry_title(self):
        self.assertFalse(years.fits(None, 0, entry=False))
        self.assertTrue(years.fits(None, 0, entry=True))
        self.assertTrue(years.fits(None, 2, entry=False))

    def test_up_to_n(self):
        self.assertTrue(years.fits(rec(mn=3), 3))
        self.assertFalse(years.fits(rec(mn=4), 3))


if __name__ == "__main__":
    unittest.main()
