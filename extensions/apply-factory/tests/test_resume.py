import base64
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from lib import config, resume


def with_resumes(files: dict[str, bytes | None]):
    """Point config at temp files; None means the file does not exist."""
    d = Path(tempfile.mkdtemp())
    paths = {}
    for kind, data in files.items():
        p = d / f"{kind}.pdf"
        if data is not None:
            p.write_bytes(data)
        paths[kind] = str(p)
    old = config.load().get("resumes")
    config.load()["resumes"] = paths
    return old


class KindTest(unittest.TestCase):
    def test_title_decides(self):
        for t in ("DevOps Engineer", "Site Reliability Engineer", "Platform Engineer, Infra", "Cloud Engineer Intern", "SRE Intern"):
            self.assertEqual(resume.kind_for(t), "devops", t)
        for t in ("AI Engineer", "Machine Learning Intern", "ML Engineer", "LLM Application Engineer", "Generative AI Developer Intern"):
            self.assertEqual(resume.kind_for(t), "ai", t)
        self.assertEqual(resume.kind_for("AI Platform Engineer"), "ai")  # AI is checked before DevOps
        for t in ("Software Development Engineer", "Backend Engineer", "Frontend Developer", "HTML and XML Developer"):
            self.assertEqual(resume.kind_for(t), "default", t)

    def test_dense_infra_jd_with_a_neutral_title_is_devops(self):
        jd = "You will run Kubernetes clusters, write Terraform and Helm charts, tune Prometheus and Grafana, own CI/CD on GitHub Actions and AWS."
        self.assertEqual(resume.kind_for("Graduate Engineer", jd), "devops")
        self.assertEqual(resume.kind_for("Backend Engineer", jd), "default")  # a developer title wins over JD words

    def test_dense_ml_jd_with_a_neutral_title_is_ai(self):
        jd = "Build RAG pipelines with LangChain and a vector database, fine-tune transformer models in PyTorch, work on embeddings and prompt design."
        self.assertEqual(resume.kind_for("Graduate Engineer", jd), "ai")

    def test_jd_words_alone_are_not_enough(self):
        self.assertEqual(resume.kind_for("Graduate Engineer", "We use Docker and AWS."), "default")


class PickTest(unittest.TestCase):
    def setUp(self):
        self.old = config.load().get("resumes")

    def tearDown(self):
        config.load()["resumes"] = self.old

    def test_picks_role_file_or_falls_back_to_default(self):
        with_resumes({"default": b"%PDF default", "devops": b"%PDF devops"})
        self.assertEqual((resume.pick("DevOps Engineer")[0], resume.pick("DevOps Engineer")[1].read_bytes()), ("devops", b"%PDF devops"))
        self.assertEqual(resume.pick("Backend Engineer")[0], "default")
        with_resumes({"default": b"%PDF default", "devops": None})
        self.assertEqual(resume.pick("DevOps Engineer")[0], "default")

    def test_ai_role_uses_the_default_cv_until_an_ai_cv_exists(self):
        with_resumes({"default": b"%PDF default", "devops": None, "ai": None})
        kind, p = resume.pick("AI Engineer")
        self.assertEqual((kind, p.read_bytes()), ("default", b"%PDF default"))
        with_resumes({"default": b"%PDF default", "devops": None, "ai": b"%PDF ai"})
        self.assertEqual(resume.pick("AI Engineer")[0], "ai")

    def test_missing_everything_names_the_expected_path(self):
        with_resumes({"default": None, "devops": None})
        with self.assertRaisesRegex(FileNotFoundError, "put your CV at .*default.pdf"):
            resume.pick("Backend Engineer")


class SaveTest(unittest.TestCase):
    def setUp(self):
        self.old = config.load().get("resumes")

    def tearDown(self):
        config.load()["resumes"] = self.old

    def b64(self, data):
        return base64.b64encode(data).decode()

    def test_replaces_the_slot_keeps_the_old_file_and_leaves_no_temp(self):
        with_resumes({"default": b"%PDF-old", "devops": None, "ai": None})
        out = resume.save("default", self.b64(b"%PDF-new"))
        p = resume.path_for("default")
        self.assertEqual((out["bytes"], p.read_bytes()), (8, b"%PDF-new"))
        self.assertEqual(p.with_suffix(".previous.pdf").read_bytes(), b"%PDF-old")
        self.assertEqual([f.name for f in p.parent.glob("*.tmp")], [])

    def test_rejects_non_pdf_oversize_bad_base64_and_unknown_kind(self):
        with_resumes({"default": b"%PDF-old"})
        for bad, msg in ((self.b64(b"<html>"), "not a PDF"), ("###", "base64"), (self.b64(b"%PDF-" + b"0" * (resume.MAX_BYTES + 1)), "10 MB")):
            with self.assertRaisesRegex(ValueError, msg):
                resume.save("default", bad)
        with self.assertRaisesRegex(ValueError, "unknown CV kind"):
            resume.save("marketing", self.b64(b"%PDF-x"))
        self.assertEqual(resume.path_for("default").read_bytes(), b"%PDF-old")  # nothing was touched

    def test_status_lists_slots_and_fallbacks(self):
        with_resumes({"default": b"%PDF-d", "devops": None, "ai": None})
        rows = {r["kind"]: r for r in resume.status()}
        self.assertTrue(rows["default"]["exists"])
        self.assertTrue(rows["ai"]["uses_default"])
        self.assertEqual(rows["ai"]["label"], "AI role")


class ServerResumeTest(unittest.TestCase):
    def test_endpoint_returns_the_file_for_the_role(self):
        from tests.test_server import ServerTest
        t = ServerTest("test_rules_endpoint_matches_file")
        t.setUp()
        old = config.load().get("resumes")
        try:
            with_resumes({"default": b"%PDF-default", "devops": b"%PDF-devops"})
            token = t.pair()
            code, out = t.call("/resume", {"title": "DevOps Engineer at Acme"}, token)
            self.assertEqual((code, out["kind"], base64.b64decode(out["base64"])), (200, "devops", b"%PDF-devops"))
            self.assertTrue(out["name"].endswith(".pdf"))
            with_resumes({"default": None, "devops": None})
            code, out = t.call("/resume", {"title": "x"}, token)
            self.assertEqual(code, 404)
            self.assertIn("put your CV at", out["error"])
            with_resumes({"default": b"%PDF-old", "devops": None, "ai": None})
            code, out = t.call("/resume/upload", {"kind": "default", "base64": base64.b64encode(b"%PDF-new").decode()}, token)
            self.assertEqual((code, out["bytes"]), (200, 8))
            code, out = t.call("/resume", {"title": "AI Engineer"}, token)
            self.assertEqual((out["kind"], out["label"], base64.b64decode(out["base64"])), ("default", "Default CV", b"%PDF-new"))
            code, out = t.call("/resume/upload", {"kind": "default", "base64": base64.b64encode(b"nope").decode()}, token)
            self.assertEqual(code, 400)
            self.assertEqual(t.call("/status", token=token)[1]["resumes"][0]["kind"], "default")
        finally:
            config.load()["resumes"] = old
            t.tearDown()


if __name__ == "__main__":
    unittest.main()
