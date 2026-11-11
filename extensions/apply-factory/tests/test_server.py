import json
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import server
from tests.fakes import FakeOllama, temp_db

EXT = "chrome-extension://abcdefabcdefabcdefabcdefabcdefab"


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.state = server.State(temp_db(), Path(tempfile.mkdtemp()) / "server.json")
        threading.Thread(target=self.state.worker, daemon=True).start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(self.state))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.fake.uninstall()

    def call(self, path, body=None, token=None, origin=EXT, host=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Token"] = token
        if origin:
            headers["Origin"] = origin
        if host:
            headers["Host"] = host
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers,
                                     method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def pair(self):
        return self.call("/pair", {})[1]["token"]

    def test_requires_pairing_and_pins_first_extension(self):
        self.assertEqual(self.call("/status")[0], 401)
        self.assertEqual(self.call("/pair", {}, origin="https://evil.example")[0], 403)
        token = self.pair()
        self.assertEqual(self.call("/status", token=token)[0], 200)
        self.assertEqual(self.call("/pair", {}, origin="chrome-extension://zzzz")[0], 403)
        self.assertEqual(self.call("/status", token="wrong")[0], 401)

    def test_rejects_non_loopback_host(self):
        token = self.pair()
        self.assertEqual(self.call("/status", token=token, host="evil.example")[0], 403)

    def test_suggest_and_guarded_sites(self):
        token = self.pair()
        fields = [{"id": "a", "label": "First name", "type": "text"}]
        code, out = self.call("/suggest", {"url": "https://boards.greenhouse.io/acme/jobs/1", "fields": fields}, token)
        self.assertEqual((code, out["results"][0]["value"]), (200, "Daivik"))
        code, out = self.call("/suggest", {"url": "https://www.linkedin.com/jobs/view/1", "fields": fields}, token)
        self.assertEqual((out["mode"], out["results"]), ("watch", []))

    def test_company_and_mail_routes_run_as_polled_jobs_and_cache(self):
        from lib import company, mailcheck
        token = self.pair()
        saved = (company.research, mailcheck.find_multi)
        calls = []
        company.research = lambda name, url="", title="", location="", website="": (calls.append(name), {"company": name, "people": [], "size": {}})[1]
        mailcheck.find_multi = lambda name, domains, known=None, prefer=None: {"domain": domains[0], "catch_all": False, "rows": [{"address": "a@" + domains[0], "verdict": "accepted", "shape": "flast"}]}
        try:
            code, out = self.call("/company/start", {"company": "Acme", "url": "", "title": "SWE"}, token)
            job = out["job"]
            for _ in range(50):
                res = self.call("/cv/job", {"id": job}, token)[1]
                if res["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual((res["status"], res["result"]["company"]), ("done", "Acme"))
            code, out = self.call("/company/start", {"company": "Acme"}, token)
            self.assertEqual((out["cached"], calls), (True, ["Acme"]))                                  # the second ask costs no search
            self.assertEqual(self.call("/company/start", {"company": " "}, token)[0], 400)
            self.assertEqual(self.call("/mail/find", {"name": "Priya", "domain": "acme.com"}, token)[0], 400)   # needs a first and last name
            self.assertEqual(self.call("/mail/find", {"name": "Priya Sharma", "domain": "not a domain"}, token)[0], 400)
            job = self.call("/mail/find", {"name": "Priya Sharma", "domain": "acme.com"}, token)[1]["job"]
            for _ in range(50):
                res = self.call("/cv/job", {"id": job}, token)[1]
                if res["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual(res["result"]["rows"][0]["address"], "a@acme.com")
            seen = []
            mailcheck.find_multi = lambda name, domains, known=None, prefer=None: (seen.append(prefer), {"domain": domains[0], "catch_all": False, "rows": []})[1]
            job = self.call("/mail/find", {"name": "Grace Hopper", "domain": "acme.com"}, token)[1]["job"]
            for _ in range(50):
                if self.call("/cv/job", {"id": job}, token)[1]["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual(seen, [["flast"]])                                                          # the next person starts from the shape that worked
        finally:
            company.research, mailcheck.find_multi = saved

    def test_outreach_and_gmail_routes_never_send_and_say_what_is_missing(self):
        from lib import gmail, outreach
        token = self.pair()
        saved = (outreach.draft, outreach.attachments, outreach.log_contact, gmail.create_draft, gmail.status, gmail.start)
        sent = []
        outreach.draft = lambda person, company, title, jd, report="": {"subject": "S", "body": "B", "words": 1}
        outreach.attachments = lambda *a, **k: ([("CV.pdf", b"x", "application/pdf")], ["CV: CV.pdf", "Cover letter attached"])
        outreach.log_contact = lambda person, company, email, *a, **k: "noted"
        gmail.create_draft = lambda to, subject, body, files=None: (sent.append((to, subject, [f[0] for f in files or []])), {"draft_id": "d", "message_id": "m", "url": "https://mail.google.com/x"})[1]
        gmail.status = lambda: {"configured": True, "connected": True}
        try:
            self.assertEqual(self.call("/gmail/status", {}, token)[1], {"configured": True, "connected": True})
            from lib import cover
            real = cover.draft
            cover.draft = lambda title, company, jd, report="", person_name="": {"text": "T", "tex": "\\documentclass{article}", "from_report": False, "who": person_name}
            try:
                self.assertEqual(self.call("/outreach/cover", {"company": "Acme", "title": "SRE", "jd_text": "jd", "person_name": "Ada Lovelace"}, token)[1]["who"], "Ada Lovelace")
            finally:
                cover.draft = real
            self.assertEqual(self.call("/outreach/draft", {"person": {"name": "Ada Lovelace"}, "company": "Acme"}, token)[1]["subject"], "S")
            job = self.call("/outreach/gmail", {"to": "ada@acme.com", "subject": "S", "body": "B", "company": "Acme", "person": {"name": "Ada Lovelace"}}, token)[1]["job"]
            for _ in range(50):
                res = self.call("/cv/job", {"id": job}, token)[1]
                if res["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual((res["status"], res["result"]["url"], res["result"]["files"], res["result"]["note"]), ("done", "https://mail.google.com/x", ["CV.pdf"], "noted"))
            self.assertEqual(sent, [("ada@acme.com", "S", ["CV.pdf"])])
            code, out = self.call("/outreach/compose", {"to": "a@b.com", "subject": "Hi", "body": "Yo"}, token)
            self.assertTrue(out["url"].startswith("https://mail.google.com/mail/?view=cm"))
            gmail.start = saved[5]
            with mock.patch.object(gmail, "CRED", Path(tempfile.mkdtemp()) / "none.json"):
                code, out = self.call("/gmail/connect", {}, token)
            self.assertEqual(code, 409)
            self.assertIn("gmail-credentials.json", out["error"])
            req = urllib.request.Request(self.base + "/gmail/callback?state=bogus&code=x", headers={"Host": "127.0.0.1"})   # the browser comes back without a token
            with urllib.request.urlopen(req) as r:
                self.assertIn("not one this app started", r.read().decode())
        finally:
            outreach.draft, outreach.attachments, outreach.log_contact, gmail.create_draft, gmail.status, gmail.start = saved

    def test_capture_is_learned_in_background(self):
        token = self.pair()
        code, out = self.call("/capture", {"url": "https://jobs.lever.co/acme/1", "company": "Acme", "fields": [
            {"label": "Email", "field_type": "text", "value": "me@x.com"}, {"label": "Password", "field_type": "password", "value": "pw"}]}, token)
        self.assertEqual((code, out["accepted"]), (202, 1))
        for _ in range(50):
            self.state.jobs.join()
            if self.state.last_capture.get("new") == 1:
                break
            time.sleep(0.05)
        self.assertEqual(self.state.last_capture["new"], 1)
        self.assertEqual(self.call("/status", token=token)[1]["counts"]["answers"], 1)

    def test_model_down_gives_503_on_draft_and_status_still_works(self):
        token = self.pair()
        self.fake.down = True
        code, _ = self.call("/draft", {"field": {"id": "a", "label": "Tell us about a project", "type": "textarea"}}, token)
        self.assertEqual(code, 503)
        code, out = self.call("/status", token=token)
        self.assertEqual((code, sorted(out["llm"])[:2]), (200, ["backend", "chat_model"]))  # status reads configuration, it does not call a model

    def test_rules_endpoint_matches_file(self):
        token = self.pair()
        self.assertIn("never_read", self.call("/rules", token=token)[1])


if __name__ == "__main__":
    unittest.main()
