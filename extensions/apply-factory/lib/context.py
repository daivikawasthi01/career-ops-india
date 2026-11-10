"""Existing career-ops material that drafts should lean on: voice, proof points, and answers drafted during evaluation."""
from __future__ import annotations

import json
import re

from . import config, nodecli, rules
from .embed import lexical_score


def _read(name: str, cap: int) -> str:
    p = config.CAREEROPS / name
    return p.read_text(errors="ignore")[:cap] if p.exists() else ""


def voice() -> str:
    return _read("voice-dna.md", 1800)


def writing_rules() -> str:
    """career-ops' own writing rules for candidate-facing text: the 'Professional Writing' section of modes/_writing.md plus the
    candidate's '## Writing Style' block in modes/_profile.md, which wins where they differ."""
    out = []
    text = _read("modes/_writing.md", 20000)
    i = text.find("## Professional Writing")
    if i >= 0:
        body = re.sub(r"^_.*_$", "", text[i:], flags=re.M)  # drop the italic maintainer notes
        out.append(re.sub(r"\n{3,}", "\n\n", body).strip()[:2200])
    prof = _read("modes/_profile.md", 40000)
    m = re.search(r"^## Writing Style\s*\n(.*?)(?=^## |\Z)", prof, re.S | re.M)
    if m:
        out.append("THE CANDIDATE'S OWN STYLE (wins over the rules above):\n" + m.group(1).strip()[:900])
    return "\n\n".join(out)


def digest() -> str:
    return _read("article-digest.md", 1800)


def report_text(report_path: str) -> str:
    p = config.CAREEROPS / report_path
    return p.read_text(errors="ignore") if report_path and p.exists() and p.is_relative_to(config.CAREEROPS / "reports") else ""


def report_answers(report_path: str) -> list[dict]:
    """[{question, answer}] from the report's Application Answers, else its draft block H. Empty when there are none."""
    if not report_text(report_path):
        return []
    for flag in (["--read", "--strict"], ["--read-draft"]):
        rc, out, _ = nodecli.run(["application-answers.mjs", "--report", report_path, *flag])
        if rc != 0 or not out.strip() or out.strip() == "null":
            continue
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            continue
        items = data.get("freeText") or data.get("answers") or []
        found = [{"question": str(i.get("question") or i.get("label") or ""), "answer": str(i.get("answer") or i.get("value") or "")}
                 for i in items if isinstance(i, dict)]
        found = [i for i in found if i["question"] and i["answer"]]
        if found:
            return found
    return []


def answer_for(label: str, answers: list[dict]) -> dict | None:
    """The evaluation's own answer to a question like this one, when the wording is close enough."""
    best = max(answers, key=lambda a: lexical_score(label, a["question"]), default=None)
    return best if best and lexical_score(label, best["question"]) >= 0.55 else None


def cover_letter(report_path: str) -> str:
    m = re.search(r"^## Cover Letter Draft\s*\n(.*?)(?=^## |\Z)", report_text(report_path), re.S | re.M)
    return m.group(1).strip() if m else ""
