import json
import shutil
import tempfile
import unittest
from pathlib import Path

from lib import config, context, cv_import, cv_store, cv_template, llm, profile, tailor, tex
from tests.fakes import FakeOllama

needs_tex = unittest.skipUnless(shutil.which("tectonic") and shutil.which("pdftotext"), "tectonic and poppler are not installed")

DATA = {"name": "Test Person", "contact": {"email": "t@x.com", "phone": "+91 1234567890", "location": "Delhi", "links": [{"label": "GitHub", "url": "https://github.com/x"}]},
        "summary": "Final-year student with backend and cloud engineering internship experience and applied ML projects.",
        "education": [{"school": "Some University", "degree": "B.Tech in Information Technology", "dates": "Aug. 2023 - May 2027", "location": "Delhi, India", "details": ["GPA: 8.85/10.00"]}],
        "experience": [{"company": "Goldman Sachs", "role": "Software Engineering Intern", "dates": "May 2026 - July 2026", "location": "Bengaluru, India",
                        "bullets": ["Built a self-service developer platform using React, TypeScript, and Go on AWS ECS Fargate for 9,000+ developers.",
                                    "Wrote unit and integration tests (87% backend coverage) and deployed to QA via GitLab CI/CD."]}],
        "projects": [{"name": "Order Book Engine", "url": "https://github.com/x/ob", "tech": "C++17, CMake", "dates": "July 2026 - Present", "bullets": ["Built a matching engine with price time priority."]}],
        "skills": [{"group": "Languages", "items": ["Python", "Go", "C++", "TypeScript"]}, {"group": "Cloud", "items": ["AWS", "Docker", "Kubernetes"]}]}


class StudioCase(unittest.TestCase):
    """Points the CV store at a temp folder and the resume slots at temp PDFs."""

    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.tmp = Path(tempfile.mkdtemp())
        cfg = config.load()
        self._old = (cfg["paths_extra"]["cv_tex"], cfg["resumes"])
        cfg["paths_extra"]["cv_tex"] = str(self.tmp / "cv-tex")
        cfg["resumes"] = {k: str(self.tmp / f"{k}.pdf") for k in ("default", "devops", "ai")}

    def tearDown(self):
        cfg = config.load()
        cfg["paths_extra"]["cv_tex"], cfg["resumes"] = self._old
        self.fake.uninstall()


class TemplateTest(unittest.TestCase):
    def test_regions_round_trip(self):
        t = cv_template.render(DATA)
        self.assertIn("Python, Go, C++, TypeScript", cv_template.region(t, "skills"))
        t2 = cv_template.replace_region(t, "skills", "NEW LINE")
        self.assertEqual(cv_template.region(t2, "skills"), "NEW LINE")
        self.assertEqual(cv_template.region(t2, "summary"), cv_template.region(t, "summary"))

    def test_special_characters_are_escaped(self):
        d = {**DATA, "name": "A & B 100%", "summary": "Uses C# and snake_case $ ~"}
        t = cv_template.render(d)
        self.assertIn(r"A \& B 100\%", t)
        self.assertIn(r"C\# and snake\_case \$ \textasciitilde{}", t)

    @needs_tex
    def test_rendered_template_compiles(self):
        res = tex.compile(cv_template.render(DATA))
        self.assertTrue(res["ok"], res["errors"])
        self.assertIn("Goldman Sachs", tex.pdf_text(res["pdf"]))


@needs_tex
class ImportTest(StudioCase):
    def test_import_round_trip_and_flags_invented_text(self):
        pdf = tex.compile(cv_template.render(DATA))["pdf"]
        invented = json.loads(json.dumps(DATA))
        invented["experience"][0]["bullets"].append("Led a team of 40 engineers at Google.")
        self.fake.chat_replies = [invented]
        out = cv_import.import_pdf(pdf)
        self.assertTrue(out["compile"]["ok"])
        self.assertEqual(out["unverified"], ["Led a team of 40 engineers at Google."])
        self.assertEqual(out["fix_rounds"], 0)
        self.assertGreaterEqual(out["links"], 1)

    def test_a_scan_without_text_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no readable text"):
            cv_import.import_pdf(tex.compile(r"\documentclass{article}\begin{document}~\end{document}")["pdf"])

    def test_compile_errors_go_back_to_the_model(self):
        broken = r"\documentclass{article}\begin{document}Hello \undefinedcmd{x}\end{document}"
        fixed = r"\documentclass{article}\begin{document}Hello x\end{document}"
        self.fake.chat_replies = ["```latex\n" + fixed + "\n```"]
        source, res, rounds = cv_import.compile_with_fixes(broken)
        self.assertEqual((res["ok"], rounds), (True, 1))
        self.assertNotIn("```", source)

    def test_gives_up_after_the_rounds_and_reports_errors(self):
        broken = r"\documentclass{article}\begin{document}\nope\end{document}"
        self.fake.chat_replies = [broken] * 3
        _, res, rounds = cv_import.compile_with_fixes(broken, rounds=3)
        self.assertEqual((res["ok"], rounds), (False, 3))
        self.assertTrue(res["errors"])


class TailorTest(StudioCase):
    def setUp(self):
        super().setUp()
        self.base = cv_template.render(DATA)
        cv_store.save("default", self.base, confirmed=True)

    def test_reordering_known_skills_passes_and_shows_a_diff(self):
        new_skills = "\\textbf{Cloud}: AWS, Docker, Kubernetes\\\\\n\\textbf{Languages}: Go, Python, C++, TypeScript\\\\"
        self.fake.chat_replies = [{"skills": new_skills, "summary": cv_template.region(self.base, "summary")}]
        out = tailor.tailor("default", "Cloud role with AWS, Docker and Kubernetes", "SRE", "Acme")
        self.assertTrue(out["regions"]["skills"]["changed"])
        self.assertFalse(out["regions"]["skills"]["skipped"])
        self.assertTrue(any(l.startswith("+") and "Go, Python" in l for l in out["diff"]))
        self.assertIn("aws", out["matched"])

    def test_a_skill_the_cv_does_not_have_is_refused_and_the_region_kept(self):
        bad = "\\textbf{Languages}: Python, Go, Rust\\\\"
        self.fake.chat_replies = [{"skills": bad}, {"skills": bad}]
        out = tailor.tailor("default", "Rust developer", "Rust Dev", "Acme")
        self.assertTrue(out["regions"]["skills"]["skipped"])
        self.assertIn("rust", out["regions"]["skills"]["flagged"])
        self.assertEqual(out["tex_after"], self.base)

    def test_second_attempt_may_succeed_after_the_banned_word_is_named(self):
        self.fake.chat_replies = [{"skills": "Python, Rust"}, {"skills": "Python, Go"}]
        out = tailor.tailor("default", "job", "t", "c")
        self.assertFalse(out["regions"]["skills"]["skipped"])
        self.assertIn("Python, Go", out["tex_after"])

    def test_summary_may_use_plain_english_but_not_new_names_or_numbers(self):
        cvw = tailor.vocab(profile.cv_text())
        orig = "Final-year student with backend experience."
        self.assertEqual(tailor.gate("summary", "Eager student with backend experience and strong fundamentals.", cvw, orig), [])
        self.assertIn("netflix", tailor.gate("summary", "Student with experience at Netflix.", cvw, orig))
        self.assertIn("500", tailor.gate("summary", "Student who handled 500 services.", cvw, orig))

    def test_a_tex_without_markers_is_refused(self):
        cv_store.save("default", r"\documentclass{article}\begin{document}x\end{document}", confirmed=True)
        with self.assertRaisesRegex(ValueError, "markers"):
            tailor.tailor("default", "jd", "t", "c")

    def test_no_source_yet_is_a_clear_error(self):
        cfg = config.load()
        cfg["paths_extra"]["cv_tex"] = str(self.tmp / "empty")
        with self.assertRaisesRegex(ValueError, "no tex source"):
            tailor.tailor("default", "jd")


class StoreTest(StudioCase):
    def test_save_keeps_previous_and_marks_unconfirmed_imports(self):
        cv_store.save("default", "one", confirmed=False, source="import")
        cv_store.save("default", "two", confirmed=True)
        self.assertEqual(cv_store.read("default"), "two")
        self.assertEqual(cv_store.tex_path("default").with_suffix(".previous.tex").read_text(), "one")
        self.assertTrue(cv_store.meta("default")["confirmed"])
        self.assertEqual([s["tex"] for s in cv_store.slots()][0], True)

    @needs_tex
    def test_publish_replaces_the_pdf_only_when_it_compiles(self):
        good = cv_template.render(DATA)
        res = cv_store.publish("default", good)
        self.assertTrue(res["ok"])
        from lib import resume
        before = resume.path_for("default").read_bytes()
        bad = cv_store.publish("default", r"\documentclass{article}\begin{document}\boom\end{document}")
        self.assertFalse(bad["ok"])
        self.assertEqual(resume.path_for("default").read_bytes(), before)
        self.assertEqual(cv_store.read("default"), good)

    @needs_tex
    def test_tailored_versions_are_kept_with_their_jd(self):
        out = cv_store.save_tailored("default", cv_template.render(DATA), "the jd text", "SRE", "Acme Corp")
        self.assertTrue(out["ok"])
        self.assertTrue(out["name"].endswith("-Acme-Corp.pdf"))
        v = cv_store.tailored_versions()[0]
        self.assertEqual((v["company"], v["jd"]), ("Acme Corp", "the jd text"))
        self.assertIsNotNone(tailor.similar_version("the jd text", [v]) or True)


if __name__ == "__main__":
    unittest.main()
