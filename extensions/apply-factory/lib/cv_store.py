"""
Where the tex sources of your CVs live (data/cv-tex/<kind>.tex) and how they become the PDFs in output/resumes/.

    data/cv-tex/default.tex         the editable source for the default CV
    data/cv-tex/default.meta.json   {"confirmed": bool, "source": "import"|"manual"}
    data/cv-tex/tailored/<stamp>-<company>/{cv.tex, jd.txt, meta.json, cv.pdf}   one folder per tailored version

A tex that came from a PDF import is `confirmed: false` until you publish it from the studio. Publishing compiles first
and only replaces the PDF slot when the compile succeeds, so a broken edit can never leave a form without a CV.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path

from . import config, resume, tex


def root() -> Path:
    p = config.path("cv_tex", "paths_extra")
    p.mkdir(parents=True, exist_ok=True)
    return p


def tex_path(kind: str) -> Path:
    if kind not in config.load()["resumes"]:
        raise ValueError(f"unknown CV kind: {kind}")
    return root() / f"{kind}.tex"


def _meta_path(kind: str) -> Path:
    return root() / f"{kind}.meta.json"


def meta(kind: str) -> dict:
    try:
        return json.loads(_meta_path(kind).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def read(kind: str) -> str | None:
    p = tex_path(kind)
    return p.read_text() if p.exists() else None


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def save(kind: str, text: str, *, confirmed: bool, source: str = "manual") -> None:
    """Store the tex. The previous source is kept as <kind>.previous.tex."""
    p = tex_path(kind)
    if p.exists():
        p.replace(p.with_suffix(".previous.tex"))
    _atomic_write(p, text)
    _atomic_write(_meta_path(kind), json.dumps({"confirmed": confirmed, "source": source, "updated": time.strftime("%Y-%m-%dT%H:%M:%S")}))


def slots() -> list[dict]:
    rows = []
    for r in resume.status():
        m = meta(r["kind"])
        rows.append({**r, "tex": tex_path(r["kind"]).exists(), "confirmed": m.get("confirmed"), "source": m.get("source")})
    return rows


def publish(kind: str, text: str) -> dict:
    """Compile, then replace the PDF slot and keep the tex. On a failed compile nothing on disk changes."""
    res = tex.compile(text)
    if not res["ok"]:
        return {"ok": False, "errors": res["errors"], "published": False}
    resume.save(kind, base64.b64encode(res["pdf"]).decode())
    save(kind, text, confirmed=True)
    return {"ok": True, "errors": [], "published": True, "pdf": res["pdf"]}


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:40] or "company"


def save_tailored(kind: str, text: str, jd_text: str, title: str, company: str) -> dict:
    """Compile a tailored tex and keep it with its job description. Returns the PDF and a download name."""
    res = tex.compile(text)
    if not res["ok"]:
        return {"ok": False, "errors": res["errors"]}
    folder = root() / "tailored" / f"{time.strftime('%Y%m%d-%H%M%S')}-{slug(company)}"
    folder.mkdir(parents=True)
    (folder / "cv.tex").write_text(text)
    (folder / "jd.txt").write_text(jd_text)
    (folder / "cv.pdf").write_bytes(res["pdf"])
    (folder / "meta.json").write_text(json.dumps({"kind": kind, "title": title, "company": company}))
    base = resume.path_for(kind).stem
    return {"ok": True, "pdf": res["pdf"], "name": f"{base}-{slug(company)}.pdf", "folder": str(folder)}


def tailored_versions() -> list[dict]:
    out = []
    for f in sorted((root() / "tailored").glob("*/meta.json"), reverse=True) if (root() / "tailored").exists() else []:
        m = json.loads(f.read_text())
        out.append({**m, "folder": str(f.parent), "jd": (f.parent / "jd.txt").read_text() if (f.parent / "jd.txt").exists() else ""})
    return out
