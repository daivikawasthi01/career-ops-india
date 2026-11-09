import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import discovery_report as d  # noqa: E402

COMPANIES = """# header
Orphan Name
# ===== SLICE 1 BEGIN: 2 names =====
Razorpay
Groww
# ===== SLICE 1 END =====
# ---------- India: fintech ----------
Zerodha
# ---------- Global startups ----------
Acme
"""
LOG = """[1/5] Razorpay ✓
[2/5] Groww ✗
[3/5] Zerodha ✗
[4/5] Acme ⏱ timeout
[5/5] Orphan Name ✓
[6/5] Not Listed ✓
noise line
"""


class Report(unittest.TestCase):
    def test_parse_log(self):
        marks = d.parse_log(LOG)
        self.assertEqual(marks["Razorpay"], "✓")
        self.assertEqual(len(marks), 6)

    def test_names_before_any_section_do_not_crash_the_report(self):
        section_of, slice_names = d.parse_companies(COMPANIES)
        self.assertEqual(section_of["Orphan Name"], "(no section)")
        self.assertEqual(slice_names, {"Razorpay", "Groww"})
        text = d.report(d.parse_log(LOG), section_of, slice_names)
        self.assertIn("slice 1:  1/2 (50%)", text)
        self.assertIn("(no section)", text)
        self.assertEqual(section_of["Razorpay"], "Slice 1 (priority names)")
        self.assertIn("(not in companies.txt)", text)
        self.assertIn("timeouts: 1", text)


if __name__ == "__main__":
    unittest.main()
