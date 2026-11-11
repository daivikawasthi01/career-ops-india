"""Cold email drafts and Gmail drafts: sign-in, draft creation with attachments (never a send), word and number limits, contact log."""
import base64
import datetime
import email
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from lib import config, context, gmail, llm, outreach, profile, resume, tex
from tests.fakes import FakeOllama

CRED = {"installed": {"client_id": "cid.apps.googleusercontent.com", "client_secret": "sec", "token_uri": "https://oauth2.googleapis.com/token"}}


class GmailTest(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp())
        self._p = [mock.patch.object(gmail, "CRED", d / "cred.json"), mock.patch.object(gmail, "TOKEN", d / "token.json")]
        for p in self._p:
            p.start()
        gmail.CRED.write_text(json.dumps(CRED))
        self.calls = []
        self._http = gmail.http
        gmail.http = self.fake_http
        self.reply = {}
        gmail._PENDING.clear()

    def tearDown(self):
        gmail.http = self._http
        for p in self._p:
            p.stop()

    def fake_http(self, method, url, headers, data, timeout=30):
        self.calls.append((method, url, headers, data))
        for needle, answer in self.reply.items():
            if needle in url:
                return answer
        raise AssertionError(f"unexpected call {method} {url}")

    def test_sign_in_uses_pkce_and_only_the_compose_scope_and_each_state_works_once(self):
        url = gmail.start()
        q = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))
        self.assertEqual((q["scope"].replace("%3A", ":").replace("%2F", "/"), q["code_challenge_method"], q["access_type"]), (gmail.SCOPE, "S256", "offline"))
        self.assertTrue(q["redirect_uri"].startswith("http%3A%2F%2F127.0.0.1%3A"))
        self.reply = {"oauth2.googleapis.com/token": (200, {"refresh_token": "rt", "access_token": "at", "expires_in": 3600})}
        gmail.finish(q["state"], "the-code")
        self.assertEqual(gmail.status(), {"configured": True, "connected": True})
        self.assertEqual(oct(os.stat(gmail.TOKEN).st_mode & 0o777), "0o600")
        self.assertIn(b"code_verifier=", self.calls[0][3])
        with self.assertRaises(gmail.GmailError):
            gmail.finish(q["state"], "again")                                                          # a state is used once
        with self.assertRaises(gmail.GmailError):
            gmail.finish("not-ours", "x")

    def test_missing_credentials_say_what_to_do(self):
        gmail.CRED.unlink()
        self.assertEqual(gmail.status()["configured"], False)
        with self.assertRaisesRegex(gmail.GmailError, "gmail-credentials.json"):
            gmail.start()

    def test_a_draft_carries_its_attachments_and_the_only_gmail_call_is_drafts_create(self):
        gmail._save({"refresh_token": "rt", "access_token": "", "expires_at": 0})
        self.reply = {"oauth2.googleapis.com/token": (200, {"access_token": "fresh", "expires_in": 3600}),
                      "gmail.googleapis.com/gmail/v1/users/me/drafts": (200, {"id": "d1", "message": {"id": "m1"}})}
        out = gmail.create_draft("ada@acme.com", "Hello", "Body text", [("CV.pdf", b"%PDF-cv", "application/pdf"), ("Cover.pdf", b"%PDF-cover", "application/pdf")])
        self.assertEqual((out["draft_id"], out["url"]), ("d1", "https://mail.google.com/mail/u/0/#drafts?compose=m1"))
        gmail_calls = [c for c in self.calls if "gmail.googleapis.com" in c[1]]
        self.assertEqual([(c[0], c[1]) for c in gmail_calls], [("POST", gmail.DRAFTS)])                 # no send, no read, no list
        self.assertEqual(gmail_calls[0][2]["Authorization"], "Bearer fresh")
        raw = json.loads(gmail_calls[0][3])["message"]["raw"]
        msg = email.message_from_bytes(base64.urlsafe_b64decode(raw))
        self.assertEqual((msg["To"], msg["Subject"]), ("ada@acme.com", "Hello"))
        self.assertEqual(sorted(p.get_filename() for p in msg.walk() if p.get_filename()), ["CV.pdf", "Cover.pdf"])

    def test_an_expired_sign_in_is_cleared_and_explained(self):
        gmail._save({"refresh_token": "rt", "access_token": "", "expires_at": 0})
        self.reply = {"oauth2.googleapis.com/token": (400, {"error": "invalid_grant"})}
        with self.assertRaisesRegex(gmail.GmailError, "new sign-in"):
            gmail.create_draft("a@b.com", "s", "b")
        self.assertFalse(gmail.status()["connected"])

    def test_oversized_attachments_are_refused_before_any_call(self):
        gmail._save({"refresh_token": "rt", "access_token": "x", "expires_at": 9e12})
        with self.assertRaisesRegex(gmail.GmailError, "20 MB"):
            gmail.create_draft("a@b.com", "s", "b", [("big.pdf", b"0" * (gmail.MAX_ATTACH + 1), "application/pdf")])
        self.assertEqual(self.calls, [])

    def test_compose_url_is_prefilled_and_safe(self):
        u = gmail.compose_url("a@b.com", "Hi & bye", "line one\nline two")
        self.assertTrue(u.startswith("https://mail.google.com/mail/?view=cm&fs=1&to=a%40b.com&su=Hi%20%26%20bye&body=line%20one%0Aline%20two"))


class OutreachTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self._p = [mock.patch.object(profile, "cv_text", lambda: "Built a deploy pipeline at Acme that cut release time from 40 to 10 minutes. Python, Kubernetes."),
                   mock.patch.object(profile, "facts", lambda: {"full_name": "Daivik Awasthi", "linkedin": "linkedin.com/in/daivik"}),
                   mock.patch.object(context, "digest", lambda: ""), mock.patch.object(context, "cover_letter", lambda p: "")]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()
        self.fake.uninstall()

    def test_the_draft_is_short_has_no_invented_number_and_ends_with_the_signature(self):
        long = "Hello Ada\n\n" + "I built a deploy pipeline at Acme that cut release time by 73 percent. " + " ".join(["That experience maps to your platform team."] * 20) + " Could we talk for fifteen minutes?"
        clean = "I built a deploy pipeline at Acme that cut release time from 40 to 10 minutes, which maps to your platform team. Could we talk for 10 minutes?"
        self.fake.chat_replies = [long, clean]
        out = outreach.draft({"name": "Ada Lovelace", "title": "Engineering Manager", "kind": "manager"}, "Acme", "Backend Engineer", "Build services.")
        self.assertTrue(out["body"].startswith("Hi Ada,\n\n"))
        self.assertTrue(out["body"].endswith("Best,\nDaivik Awasthi\nlinkedin.com/in/daivik"))
        self.assertLessEqual(out["words"], outreach.MAX_WORDS + 10)
        self.assertNotIn("73", out["body"])
        self.assertNotIn("—", out["body"])
        self.assertEqual(out["subject"], "Backend Engineer at Acme: a quick question")

    def test_follow_up_is_four_business_days_out(self):
        self.assertEqual(outreach.follow_up_date(datetime.date(2026, 11, 13)), datetime.date(2026, 11, 19))   # Friday -> Thursday
        self.assertEqual(outreach.follow_up_date(datetime.date(2026, 11, 11)), datetime.date(2026, 11, 17))   # Wednesday -> Tuesday

    def test_contact_log_adds_then_updates_one_row_and_keeps_hand_edits(self):
        path = Path(tempfile.mkdtemp()) / "contacts.tsv"
        today = datetime.date(2026, 11, 11)
        outreach.log_contact({"name": "Ada Lovelace", "title": "Eng\tManager", "kind": "manager", "linkedin": "https://linkedin.com/in/ada"}, "Acme", "ada@acme.com", today, path)
        lines = path.read_text().splitlines()
        self.assertTrue(lines[0].startswith("# name\tcompany"))
        cells = lines[1].split("\t")
        self.assertEqual((cells[0], cells[1], cells[2], cells[3], cells[5], cells[7]), ("Ada Lovelace", "Acme", "hiring-manager", "Eng Manager", "ada@acme.com", "-"))
        self.assertIn("follow up 2026-11-17", cells[8])
        lines[1] = lines[1].replace("\t\tada@acme.com", "\t+91 99999\tada@acme.com")        # a phone you added by hand
        path.write_text("\n".join(lines) + "\n")
        outreach.log_contact({"name": "ada lovelace", "title": "x", "kind": "manager"}, "ACME", "ada@acme.com", datetime.date(2026, 11, 12), path)
        rows = [l for l in path.read_text().splitlines() if not l.startswith("#")]
        self.assertEqual(len(rows), 1)
        self.assertIn("+91 99999", rows[0])
        self.assertEqual(rows[0].count("cold email draft"), 2)

    def test_attachments_include_cv_and_cover_and_say_when_the_cover_letter_cannot_be_made(self):
        d = Path(tempfile.mkdtemp())
        pdf = d / "Daivik-Awasthi-Resume.pdf"
        pdf.write_bytes(b"%PDF-cv")
        with mock.patch.object(resume, "pick", lambda t, j="": ("default", pdf)), mock.patch.object(outreach.cover, "compile_pdf", lambda src: b"%PDF-cover"):
            files, notes = outreach.attachments("SRE", "jd", "Acme Pvt Ltd", cv=True, cover_letter=True, cover_tex="\\documentclass{article}")
            self.assertEqual([f[0] for f in files], ["Daivik-Awasthi-Resume.pdf", "Cover-Letter-Acme-Pvt-Ltd.pdf"])
            self.assertIn("the tex you reviewed", notes[-1])
            files, notes = outreach.attachments("SRE", "jd", "Acme", cv=True, cover_letter=False)
            self.assertEqual(len(files), 1)
        def broken(src):
            raise tex.ToolMissing("tectonic is not installed")
        with mock.patch.object(resume, "pick", lambda t, j="": ("default", pdf)), mock.patch.object(outreach.cover, "compile_pdf", broken):
            files, notes = outreach.attachments("SRE", "jd", "Acme", cv=True, cover_letter=True, cover_tex="x")
        self.assertEqual(len(files), 1)                                                                # the CV still goes
        self.assertTrue(any("Cover letter NOT attached" in n and "tectonic" in n for n in notes))


class CoverTexTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self._p = [mock.patch.object(profile, "cv_text", lambda: "Built Kubernetes tooling at Acme."), mock.patch.object(context, "cover_letter", lambda p: ""),
                   mock.patch.object(context, "voice", lambda: ""),
                   mock.patch.object(profile, "facts", lambda: {"full_name": "Daivik Awasthi", "email": "d@example.com", "phone": "+91 99"})]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()
        self.fake.uninstall()

    def test_the_draft_is_tex_around_a_jd_specific_body_and_greets_the_person(self):
        from lib import cover
        self.fake.chat_replies = ["You ask for Kubernetes operations; at Acme I built the tooling for it.\n\nI would like to bring that to Beta & Co \u2014 100% sure."]
        seen = []
        orig = llm.call
        with mock.patch.object(llm, "call", lambda prompt, **kw: (seen.append((prompt, kw.get("system", ""))), orig(prompt, **kw))[1]):
            out = cover.draft("SRE", "Beta & Co", "We run Kubernetes at scale and need on-call ownership.", person_name="Ada Lovelace")
        self.assertIn("We run Kubernetes at scale", seen[0][0])                                          # the job text is in the prompt
        self.assertIn("2 or 3 things", seen[0][1])                                                       # and the system prompt asks to answer its main asks
        self.assertTrue(out["tex"].startswith("\\documentclass"))
        self.assertIn("Dear Ada,", out["tex"])
        self.assertIn("Beta \\& Co", out["tex"])                                                        # escaped for LaTeX
        self.assertNotIn("\u2014", out["text"])
        self.assertIn("Dear Hiring Team,", cover.to_tex("Body.", "Acme"))

    @unittest.skipUnless(tex.shutil.which("tectonic"), "tectonic is not installed")
    def test_the_tex_really_compiles_to_a_pdf(self):
        from lib import cover
        pdf = cover.compile_pdf(cover.to_tex("One paragraph with 100% and $5 and R&D.\n\nTwo.", "A&B Co"))
        self.assertTrue(pdf.startswith(b"%PDF"))
        with self.assertRaisesRegex(ValueError, "did not compile"):
            cover.compile_pdf("\\documentclass{article}\\begin{document}\\badmacro\\end{document}")


if __name__ == "__main__":
    unittest.main()
