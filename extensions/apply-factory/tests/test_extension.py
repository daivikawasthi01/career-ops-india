"""The browser extension and the server must agree on a few facts that live in two languages."""
import json
import re
import unittest
from pathlib import Path

import importlib.util
import sys

from lib import config, rules

sys.dont_write_bytecode = True  # Chrome refuses an extension folder that contains names starting with "_"
_spec = importlib.util.spec_from_file_location("af_build", Path(__file__).resolve().parent.parent / "browser" / "build.py")
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

BROWSER = Path(__file__).resolve().parent.parent / "browser"


class ExtensionConsistencyTest(unittest.TestCase):
    def test_manifest_is_generated_from_rules(self):
        committed = json.loads((BROWSER / "manifest.json").read_text())
        self.assertEqual(committed, build.manifest(), "run: .venv/bin/python browser/build.py")

    def test_generic_detection_injects_everywhere_and_stays_inert_elsewhere(self):
        g = rules.load()["generic"]
        self.assertEqual(build.match_patterns(), ["https://*/*"] if g["enabled"] else build.match_patterns())
        self.assertIn("apply", g["url_hints"])
        self.assertTrue({"google.com", "youtube.com"} <= set(g["never_hosts"]))

    def test_listed_sites_are_injected_when_generic_detection_is_off(self):
        saved = rules.load()["generic"]["enabled"]
        rules.load()["generic"]["enabled"] = False
        try:
            patterns = " ".join(build.match_patterns())
            for site in rules.load()["ats_sites"]:
                self.assertIn(site.split("/")[0], patterns)
            for host, mode in rules.load()["guarded_sites"].items():
                self.assertEqual(host in patterns, mode == "watch", host)
        finally:
            rules.load()["generic"]["enabled"] = saved

    def test_background_uses_the_configured_port(self):
        src = (BROWSER / "background.js").read_text()
        port = config.load()["server"]["port"]
        self.assertIn(f"http://127.0.0.1:{port}", src)

    def test_content_scripts_listed_exist(self):
        for f in build.CONTENT_FILES:
            self.assertTrue((BROWSER / f).exists(), f)

    def test_extension_never_clicks_submit(self):
        # Clicks on the page are only issued for options, checkboxes and radios; the submit regex is read-only.
        src = "".join((BROWSER / "content" / f).read_text() for f in ("core.js", "widgets.js", "capture.js", "main.js"))
        self.assertNotRegex(src, r"requestSubmit|\.submit\(\)|form\.submit")

    def test_background_has_no_remote_endpoints(self):
        src = (BROWSER / "background.js").read_text() + (BROWSER / "panel" / "panel.js").read_text()
        for url in re.findall(r"https?://[^\s'\"`)]+", src):
            self.assertTrue(url.startswith("http://127.0.0.1") or url.startswith("https://${"), url)


if __name__ == "__main__":
    unittest.main()


class ServiceTest(unittest.TestCase):
    def test_plist_runs_serve_with_the_venv_python(self):
        import plistlib
        from lib import service
        p = plistlib.loads(service.plist_bytes())
        self.assertEqual(p["ProgramArguments"][1:], [str(config.ROOT / "orchestrator.py"), "serve"])
        self.assertTrue(p["ProgramArguments"][0].endswith(".venv/bin/python"))
        self.assertTrue(p["KeepAlive"] and p["RunAtLoad"])
