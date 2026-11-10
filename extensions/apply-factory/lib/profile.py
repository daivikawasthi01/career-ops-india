"""The user's own facts (facts.yml) and the CV text used as grounding for drafted answers."""
from __future__ import annotations

import re
from functools import lru_cache

import yaml

from . import config


@lru_cache(maxsize=1)
def facts() -> dict:
    p = config.path("facts", "paths_extra")
    return {k: str(v) for k, v in (yaml.safe_load(p.read_text()) or {}).items() if k != "aliases" and v not in (None, "")} if p.exists() else {}


@lru_cache(maxsize=1)
def aliases() -> list[list[str]]:
    p = config.path("facts", "paths_extra")
    return (yaml.safe_load(p.read_text()) or {}).get("aliases", []) if p.exists() else []


def reload() -> None:
    facts.cache_clear()
    aliases.cache_clear()
    cv_text.cache_clear()


@lru_cache(maxsize=1)
def cv_text() -> str:
    p = config.path("cv", "paths_extra")
    return p.read_text() if p.exists() else ""


def fact_value(name: str, field: dict) -> str | None:
    """A fact formatted for the field that asks for it (phone digits vs +91, graduation year vs month)."""
    f = facts()
    if name == "phone":
        e164, national = f.get("phone"), f.get("phone_national")
        if not (e164 or national):
            return None
        ph = (field.get("placeholder") or "").strip()
        maxlen = int(field.get("maxlength") or 0)
        if national and ((ph and not ph.startswith("+") and re.match(r"^[\d\s()-]+$", ph)) or 0 < maxlen < 13):
            return national
        return e164 or national
    return f.get(name)


def summary() -> str:
    """A few lines of identity for prompts. The CV supplies everything else."""
    f = facts()
    bits = [f.get("full_name"), f"{f.get('degree', '')} {f.get('branch', '')}".strip(), f.get("college"),
            f"graduating {f['graduation_year']}" if f.get("graduation_year") else None, f"CGPA {f['cgpa']}" if f.get("cgpa") else None]
    return ", ".join(b for b in bits if b)


def cv_plain() -> str:
    """cv.md as plain text for forms that ask you to paste your resume."""
    t = cv_text()
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)          # [label](url) -> label
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)               # headings
    t = re.sub(r"\*\*|__|`", "", t)                           # bold, code
    t = re.sub(r"^\s*[-*]\s+", "- ", t, flags=re.M)           # bullets
    return re.sub(r"\n{3,}", "\n\n", t).strip()
