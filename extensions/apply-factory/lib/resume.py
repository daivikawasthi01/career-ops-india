"""Which CV pdf goes with a job, and replacing a CV from the side panel.

The default CV is used unless the role reads as one of rules.json resume_roles (AI, DevOps). A role CV that does not
exist yet falls back to the default, so adding a new kind never leaves a form without a CV.
"""
from __future__ import annotations

import base64
import binascii
import os
import re
from pathlib import Path

from . import config, rules

MAX_BYTES = 10 * 1024 * 1024
DEFAULT_LABEL = "Default CV"


def _specs() -> dict:
    return rules.load()["resume_roles"]


def label_for(kind: str) -> str:
    return _specs().get(kind, {}).get("label", DEFAULT_LABEL)


def kind_for(title: str, jd_text: str = "") -> str:
    """A role kind from the title; else the first kind whose terms fill the JD while the title is not a developer one."""
    for kind, spec in _specs().items():
        if re.search("|".join(spec["title"]), title, re.I):
            return kind
    text = jd_text.lower()
    for kind, spec in _specs().items():
        hits = sum(1 for t in spec["jd_terms"] if t in text)
        if hits >= spec["jd_min_terms"] and not re.search("|".join(spec["not_in_title"]), title, re.I):
            return kind
    return "default"


def path_for(kind: str) -> Path:
    paths = config.load()["resumes"]
    return (config.ROOT / paths.get(kind, paths["default"])).resolve()


def pick(title: str, jd_text: str = "") -> tuple[str, Path]:
    """(kind, file). Falls back to the default CV when the role file is missing; raises when nothing exists."""
    kind = kind_for(title, jd_text)
    p = path_for(kind)
    if not p.exists() and kind != "default":
        kind, p = "default", path_for("default")
    if not p.exists():
        raise FileNotFoundError(f"put your CV at {p}")
    return kind, p


def status() -> list[dict]:
    """One row per CV slot for the panel: which file, whether it exists, and what is used meanwhile."""
    rows = []
    for kind in config.load()["resumes"]:
        p = path_for(kind)
        rows.append({"kind": kind, "label": label_for(kind), "file": p.name, "exists": p.exists(),
                     "uses_default": kind != "default" and not p.exists()})
    return rows


def save(kind: str, b64: str) -> dict:
    """Replace one CV slot. The old file is kept next to it as <name>.previous.pdf; the swap is atomic."""
    if kind not in config.load()["resumes"]:
        raise ValueError(f"unknown CV kind: {kind}")
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError("file is not valid base64") from e
    if len(data) > MAX_BYTES:
        raise ValueError("CV is larger than 10 MB")
    if not data.startswith(b"%PDF-"):
        raise ValueError("that file is not a PDF")
    target = path_for(kind)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.replace(target.with_suffix(".previous.pdf"))
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return {"kind": kind, "file": target.name, "bytes": len(data)}
