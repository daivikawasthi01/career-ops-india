import json
import tempfile
import threading
import time
import unittest
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
        self.assertEqual((code, out["llm"]["ok"]), (200, False))

    def test_rules_endpoint_matches_file(self):
        token = self.pair()
        self.assertIn("never_read", self.call("/rules", token=token)[1])


if __name__ == "__main__":
    unittest.main()
