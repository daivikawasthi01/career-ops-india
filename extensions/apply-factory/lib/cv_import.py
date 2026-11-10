"""
PDF to tex. The model fills structured fields from the PDF text; lib/cv_template.py writes the tex; tectonic compiles it;
if it fails, the model is shown the compiler errors and fixes the tex (a few rounds). Nothing is trusted blindly:
every field the model returns is checked against the PDF text and anything it cannot find there is listed for you.
A human confirms the result in the studio before it replaces anything.
"""
from __future__ import annotations

import re

from . import cv_template, llm, tex

SCHEMA = """{
 "name": "", "contact": {"email": "", "phone": "", "location": "", "links": [{"label": "", "url": ""}]},
 "summary": "",
 "education": [{"school": "", "degree": "", "dates": "", "location": "", "details": [""]}],
 "experience": [{"company": "", "role": "", "dates": "", "location": "", "bullets": [""]}],
 "projects": [{"name": "", "url": "", "tech": "", "dates": "", "bullets": [""]}],
 "skills": [{"group": "", "items": [""]}],
 "other": [{"heading": "", "bullets": [""]}]
}"""

SYSTEM = """You turn the text of a resume into structured fields.
Copy wording exactly as written. Never add, summarise, reorder or improve anything.
Leave a field empty when the resume does not have it. Put each bullet as one string without the bullet symbol.
Use LINKS to fill urls: match a link to an entry by its visible text.
Reply with JSON in exactly this shape:
""" + SCHEMA


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _leaves(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _leaves(v)
    elif isinstance(node, list):
        for v in node:
            yield from _leaves(v)


def unverified(data: dict, source: str, links: list[tuple[str, str]]) -> list[str]:
    """Strings in the structured data that do not appear in the PDF text or its links."""
    hay = _norm(source) + "".join(_norm(t) + _norm(u) for t, u in links)
    return [s for s in _leaves(data) if _norm(s) and _norm(s) not in hay]


def extract(source: str, links: list[tuple[str, str]]) -> dict:
    link_lines = "\n".join(f"{t} -> {u}" for t, u in links) or "(none)"
    data = llm.call_json(f"RESUME TEXT:\n{source[:9000]}\n\nLINKS:\n{link_lines}", system=SYSTEM, temperature=0, num_ctx=8192, timeout=900)
    if not isinstance(data, dict) or "name" not in data:
        raise ValueError("the model did not return a resume structure")
    return data


FIX_SYSTEM = """You repair LaTeX so it compiles. You get the document and the compiler errors.
Change as little as possible and never change the wording of the content. Reply with the complete corrected document and nothing else."""


def fix_tex(source: str, errors: list[dict]) -> str:
    err = "\n".join(f"line {e['line']}: {e['msg']}" if e.get("line") else e["msg"] for e in errors)
    out = llm.call(f"ERRORS:\n{err}\n\nDOCUMENT:\n{source}", system=FIX_SYSTEM, temperature=0, num_ctx=8192, timeout=600)
    out = re.sub(r"^```(?:latex|tex)?\s*|\s*```$", "", out.strip())
    if "\\begin{document}" not in out:
        raise ValueError("the model did not return a LaTeX document")
    return out


def compile_with_fixes(source: str, rounds: int = 3) -> tuple[str, dict, int]:
    """(tex, compile result, fix rounds used). Stops at the first success."""
    res = tex.compile(source)
    used = 0
    while not res["ok"] and used < rounds:
        used += 1
        try:
            source = fix_tex(source, res["errors"])
        except (llm.LLMUnavailable, ValueError):
            break
        res = tex.compile(source)
    return source, res, used


def import_pdf(pdf: bytes) -> dict:
    source = tex.pdf_text(pdf)
    if len(source.strip()) < 200:
        raise ValueError("this PDF has no readable text (a scan?); paste the tex or use a text PDF")
    links = tex.pdf_links(pdf)
    data = extract(source, links)
    source_tex, res, fixes = compile_with_fixes(cv_template.render(data))
    return {"tex": source_tex, "unverified": unverified(data, source, links), "compile": {"ok": res["ok"], "errors": res["errors"]},
            "fix_rounds": fixes, "links": len(links), "chars": len(source)}
