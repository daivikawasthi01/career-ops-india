"""A person's own sample emails and cover letter layout steer the drafts; their layout is kept exactly."""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import context, cover, llm, outreach, profile, style, tex
from tests.fakes import FakeOllama

TEMPLATE = (Path(__file__).parent / "fixtures" / "cover-template.tex").read_text()
SAMPLE = """Respected Ma'am

I am a final year student at Acme University, graduating in 2027. I recently completed a summer internship at Beta, and I am writing to apply for the Backend intern role at Gamma.

I am comfortable with Go and SQL. You can find more about my work at my portfolio, and my resume is attached.

Kind Regards,
Ada Lovelace"""
FACTS = {"first_name": "Ada", "last_name": "Lovelace", "full_name": "Ada Lovelace", "email": "ada@example.com", "phone": "+442079460958",
         "city": "London", "country": "United Kingdom", "linkedin": "https://www.linkedin.com/in/ada/"}


class StyleTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self._p = [mock.patch.object(style, "DIR", self.dir), mock.patch.object(profile, "facts", lambda: FACTS),
                   mock.patch.object(profile, "cv_text", lambda: "Built Go services at Beta. SQL. Kubernetes."),
                   mock.patch.object(context, "cover_letter", lambda p: ""), mock.patch.object(context, "voice", lambda: ""), mock.patch.object(context, "digest", lambda: "")]
        for p in self._p:
            p.start()
        self.fake = FakeOllama()
        self.fake.install()

    def tearDown(self):
        self.fake.uninstall()
        for p in self._p:
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_samples_are_saved_validated_and_removable(self):
        self.assertEqual(style.get(), {"emails": "", "cover_tex": ""})
        style.set_(SAMPLE, TEMPLATE)
        self.assertEqual(len(style.email_samples()), 1)
        with self.assertRaises(ValueError):
            style.set_(None, "not a letter")
        style.set_("", "")
        self.assertEqual(style.get(), {"emails": "", "cover_tex": ""})

    def test_a_sample_email_is_split_into_greeting_body_and_sign_off(self):
        greeting, body, sign = style.email_parts(SAMPLE)
        self.assertEqual(greeting, "Respected")
        self.assertTrue(body.startswith("I am a final year student"))
        self.assertEqual(sign, "Kind Regards,\nAda Lovelace")

    def test_the_email_follows_the_sample_voice_greeting_and_sign_off(self):
        style.set_(SAMPLE, None)
        self.fake.chat_replies = ["I am a final year student, and I am writing about the Backend role at Acme. I use Go and SQL, and my resume is attached."]
        seen = []
        orig = llm.call
        with mock.patch.object(llm, "call", lambda prompt, **kw: (seen.append((prompt, kw.get("system", ""))), orig(prompt, **kw))[1]):
            out = outreach.draft({"name": "Priya Rao", "title": "Hiring manager", "kind": "manager"}, "Acme", "Backend Engineer", "Build services in Go.")
        self.assertIn("EXAMPLE EMAILS", seen[0][0])
        self.assertIn("graduating in 2027", seen[0][0])
        self.assertIn("Follow EXAMPLE EMAILS", seen[0][1])
        self.assertTrue(out["body"].startswith("Respected Priya,\n\n"))
        self.assertTrue(out["body"].endswith("Kind Regards,\nAda Lovelace"))

    def test_without_samples_the_email_is_unchanged(self):
        self.fake.chat_replies = ["I built Go services at Beta, which maps to your team. Could we talk for 10 minutes?"]
        out = outreach.draft({"name": "Priya Rao", "title": "Hiring manager", "kind": "manager"}, "Acme", "Backend Engineer", "Build services in Go.")
        self.assertTrue(out["body"].startswith("Hi Priya,\n\n"))

    def test_the_letter_keeps_the_persons_own_layout_and_replaces_only_the_job_specific_parts(self):
        out = style.from_template(TEMPLATE, "I want to join **Acme** for the 50% growth & scale.\n\nI use **Go, AWS**.", "Acme & Co", "Dear Priya,", "Backend intern", "Priya Rao")
        self.assertIn(r"\documentclass[11pt,a4paper,roman]{moderncv}", out)           # their preamble, untouched
        self.assertIn(r"\patchcmd{\makeletterhead}", out)
        self.assertIn(r"\closing{Warm regards, \vspace{-1em}}", out)
        self.assertIn(r"\name{Ada}{Lovelace}", out)
        self.assertIn(r"\email{ada@example.com}", out)
        self.assertIn(r"\phone[mobile]{+442079460958}", out)
        self.assertIn(r"\recipient{Priya Rao}{Acme \& Co, \\}", out)
        self.assertIn(r"\textbf{Sub: Backend intern}", out)
        self.assertIn(r"I want to join \textbf{Acme} for the 50\% growth \& scale.", out)
        self.assertIn("Dear Priya,", out)
        self.assertNotIn("Twilio", out)                                                  # the sample's own facts are gone
        self.assertNotIn("9,000", out)

    def test_the_model_sees_the_sample_letter_and_the_subject_is_read_from_its_reply(self):
        style.set_(None, TEMPLATE)
        self.fake.chat_replies = ["SUBJECT: Application for Backend Intern\n\nI want to join **Gamma** because it ships Go services.\n\nI built **Go** services at Beta."]
        seen = []
        orig = llm.call
        with mock.patch.object(llm, "call", lambda prompt, **kw: (seen.append((prompt, kw.get("system", ""))), orig(prompt, **kw))[1]):
            out = cover.draft("Backend Intern", "Gamma", "Go services.", person_name="Priya Rao")
        self.assertIn("EXAMPLE LETTER", seen[0][0])
        self.assertIn("**B.Tech student in Information Technology", seen[0][0])          # bold is shown the way the sample uses it
        self.assertNotIn("Dear Hiring Team", seen[0][0])                                # the greeting is added per person, not copied
        self.assertEqual(out["subject"], "Application for Backend Intern")
        self.assertIn(r"\textbf{Sub: Application for Backend Intern}", out["tex"])
        self.assertIn("Dear Priya,", out["tex"])
        self.assertIn(r"\textbf{Gamma}", out["tex"])
        # the text you edit and attach later goes through the same layout
        self.assertIn(r"\documentclass[11pt,a4paper,roman]{moderncv}", cover.to_tex("Edited body.", "Gamma", title="Backend Intern"))

    @unittest.skipUnless(tex.shutil.which("tectonic"), "tectonic is not installed")
    def test_the_filled_layout_really_compiles(self):
        out = style.from_template(TEMPLATE, "Body with **bold** & 100%.", "A&B Co", "Dear Hiring Team,", "Backend intern")
        self.assertTrue(tex.compile(out)["ok"])


if __name__ == "__main__":
    unittest.main()
