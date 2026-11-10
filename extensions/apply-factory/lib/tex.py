"""
LaTeX and PDF plumbing: compile with tectonic, read a PDF's text, render its pages as PNGs.
Every function takes bytes or text and returns data; nothing here knows about resumes.
Compiling runs with --untrusted so a pasted .tex cannot run shell commands.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config

COMPILE_TIMEOUT = 180  # the first run downloads TeX support files
_ERR = re.compile(r"^(?P<kind>error|warning): (?:(?P<file>[^\s:]+\.tex):(?P<line>\d+): )?(?P<msg>.+)$", re.M)


class ToolMissing(RuntimeError):
    """A needed program is not installed; the message says which command installs it."""


def engine() -> str:
    local = config.CAREEROPS / "tectonic"  # career-ops' own install-latex-engine.mjs puts it here
    found = shutil.which("tectonic") or (str(local) if local.exists() else None)
    if not found:
        raise ToolMissing("tectonic is not installed: brew install tectonic")
    return found


def _need(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise ToolMissing(f"{name} is not installed: brew install poppler")
    return found


def compile(tex: str, timeout: int = COMPILE_TIMEOUT) -> dict:
    """{ok, pdf (bytes|None), errors: [{line, msg}], log}. Never raises for a bad document, only for a missing engine."""
    exe = engine()
    with tempfile.TemporaryDirectory(prefix="af-tex-") as d:
        (Path(d) / "main.tex").write_text(tex)
        try:
            r = subprocess.run([exe, "-X", "compile", "--untrusted", "--keep-logs", "main.tex"], cwd=d,
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"ok": False, "pdf": None, "errors": [{"line": None, "msg": "compile timed out"}], "log": ""}
        out = (r.stderr or "") + (r.stdout or "")
        pdf = Path(d) / "main.pdf"
        errors = [{"line": int(m["line"]) if m["line"] else None, "msg": m["msg"].strip()}
                  for m in _ERR.finditer(out) if m["kind"] == "error"]
        if r.returncode == 0 and pdf.exists():
            return {"ok": True, "pdf": pdf.read_bytes(), "errors": [], "log": out[-1500:]}
        if not errors:
            errors = [{"line": None, "msg": (out.strip().splitlines() or ["compile failed"])[-1][:300]}]
        return {"ok": False, "pdf": None, "errors": errors[:10], "log": out[-1500:]}


def pdf_text(pdf: bytes, layout: bool = False) -> str:
    exe = _need("pdftotext")
    with tempfile.TemporaryDirectory(prefix="af-pdf-") as d:
        (Path(d) / "in.pdf").write_bytes(pdf)
        args = [exe] + (["-layout"] if layout else []) + [str(Path(d) / "in.pdf"), "-"]
        r = subprocess.run(args, capture_output=True, timeout=60)
        return r.stdout.decode("utf-8", "replace")


def pdf_pages_png(pdf: bytes, dpi: int = 90, max_pages: int = 3) -> list[bytes]:
    exe = _need("pdftoppm")
    with tempfile.TemporaryDirectory(prefix="af-png-") as d:
        (Path(d) / "in.pdf").write_bytes(pdf)
        subprocess.run([exe, "-png", "-r", str(dpi), "-l", str(max_pages), str(Path(d) / "in.pdf"), str(Path(d) / "p")],
                       capture_output=True, timeout=60)
        return [p.read_bytes() for p in sorted(Path(d).glob("p-*.png"))]


_SPECIAL = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
            "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def escape(text: str) -> str:
    """Plain text to LaTeX-safe text."""
    return "".join(_SPECIAL.get(c, c) for c in str(text))


def strip_tex(tex: str) -> str:
    """Words of a tex fragment without commands, for comparing what a region says."""
    t = re.sub(r"(?<!\\)%.*", "", tex)
    t = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])?", " ", t)
    t = re.sub(r"[{}\\$&#_^~]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def pdf_links(pdf: bytes) -> list[tuple[str, str]]:
    """(visible text, url) for each hyperlink in the PDF, in reading order. Plain pdftotext drops the URLs."""
    exe = _need("pdftohtml")
    with tempfile.TemporaryDirectory(prefix="af-link-") as d:
        (Path(d) / "in.pdf").write_bytes(pdf)
        r = subprocess.run([exe, "-xml", "-i", "-stdout", str(Path(d) / "in.pdf")], capture_output=True, timeout=60)
    xml = r.stdout.decode("utf-8", "replace")
    seen, out = set(), []
    for url, text in re.findall(r'<a href="([^"]+)">(.*?)</a>', xml, re.S):
        text = re.sub(r"<[^>]+>", "", text).strip()
        if (text, url) not in seen and url.startswith(("http", "mailto")):
            seen.add((text, url))
            out.append((text, url))
    return out
