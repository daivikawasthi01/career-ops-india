import unittest

from lib import options, rules


class RulesTest(unittest.TestCase):
    def test_private_fields_are_never_read(self):
        for label in ("Password", "Enter OTP", "Aadhaar number", "Card number", "PAN card number"):
            self.assertTrue(rules.never_read({"label": label}), label)
        self.assertTrue(rules.never_read({"label": "Anything", "type": "password"}))
        self.assertFalse(rules.never_read({"label": "First name"}))

    def test_consent_is_manual(self):
        self.assertTrue(rules.manual_only({"label": "I agree to the terms and conditions"}))
        self.assertTrue(rules.manual_only({"label": "Signature"}))
        self.assertFalse(rules.manual_only({"label": "Why do you want to join us?"}))

    def test_sensitive(self):
        for label in ("Gender", "Are you a veteran?", "Expected CTC", "Do you require visa sponsorship?", "Notice period"):
            self.assertTrue(rules.is_sensitive({"label": label}), label)
        self.assertFalse(rules.is_sensitive({"label": "College name"}))

    def test_fact_for_label_and_autocomplete(self):
        self.assertEqual(rules.fact_for({"label": "First Name"}), "first_name")
        self.assertEqual(rules.fact_for({"label": "Mobile number"}), "phone")
        self.assertEqual(rules.fact_for({"label": "Email address"}), "email")
        self.assertEqual(rules.fact_for({"label": "Nationality"}), "nationality")
        self.assertEqual(rules.fact_for({"label": "Whatever", "autocomplete": "section-x family-name"}), "last_name")
        self.assertIsNone(rules.fact_for({"label": "Tell us about a project you are proud of"}))

    def test_site_modes(self):
        self.assertEqual(rules.site_mode("www.linkedin.com"), "watch")
        self.assertEqual(rules.site_mode("boards.greenhouse.io"), "assist")
        self.assertEqual(rules.site_mode("www.glassdoor.co.in"), "off")


class OptionsTest(unittest.TestCase):
    def test_nationality_alias(self):
        self.assertEqual(options.pick("Indian", ["American", "India", "Nepal"])[0], "India")
        self.assertEqual(options.pick("India", ["Select", "Indian", "Other"])[0], "Indian")

    def test_college_aliases_from_facts(self):
        opts = ["IIT Delhi", "NSIT", "DTU"]
        self.assertEqual(options.pick("Netaji Subhas University of Technology", opts)[0], "NSIT")
        self.assertEqual(options.pick("Netaji Subhas University of Technology", ["Netaji Subhas Institute of Technology (NSIT)", "DTU"])[0].split(" (")[0], "Netaji Subhas Institute of Technology")
        self.assertEqual(options.pick("Netaji Subhas University of Technology", ["NSUT", "DTU"])[0], "NSUT")

    def test_yes_no_lead_word(self):
        opts = ["Yes, I am authorized to work in India", "No, I will require sponsorship"]
        self.assertTrue(options.pick("Yes", opts)[0].startswith("Yes"))
        self.assertTrue(options.pick("No", opts)[0].startswith("No"))

    def test_degree_aliases(self):
        self.assertEqual(options.pick("B.Tech", ["B.E.", "Bachelor of Technology", "MBA"])[0], "Bachelor of Technology")

    def test_placeholder_ignored_and_no_match(self):
        self.assertIsNone(options.pick("Indian", ["Select...", "France", "Peru"]))
        self.assertEqual(options.usable(["Select", "-- ", "A"]), ["A"])

    def test_branch_it(self):
        self.assertEqual(options.pick("Information Technology", ["Computer Science", "IT", "Mechanical"])[0], "IT")


if __name__ == "__main__":
    unittest.main()
