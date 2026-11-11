"""Loads rules/rules.json once and exposes compiled matchers. The extension gets the same file from /rules."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

_RULES_PATH = Path(__file__).resolve().parent.parent / "rules" / "rules.json"


@lru_cache(maxsize=1)
def load() -> dict:
    return json.loads(_RULES_PATH.read_text())


def _compile(patterns: list[str]) -> re.Pattern:
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.I)


@lru_cache(maxsize=8)
def _matcher(key: str) -> re.Pattern:
    return _compile(load()[key])


def field_text(field: dict) -> str:
    """Everything a rule may match against: label first, then the hints a page gives."""
    parts = [field.get("label"), field.get("name"), field.get("placeholder"), field.get("section")]
    return " | ".join(str(p) for p in parts if p)


def never_read(field: dict) -> bool:
    return field.get("type") == "password" or bool(_matcher("never_read").search(field_text(field)))


def manual_only(field: dict) -> bool:
    return bool(_matcher("manual_only").search(field_text(field)))


def is_sensitive(field: dict) -> bool:
    return bool(_matcher("sensitive").search(field_text(field)))


def fact_for(field: dict) -> str | None:
    """Which profile fact a field asks for, or None. The autocomplete attribute is trusted over wording."""
    ac = (field.get("autocomplete") or "").split()
    for token in reversed(ac):
        if token in load()["autocomplete_facts"]:
            return load()["autocomplete_facts"][token]
    label = (field.get("label") or "").strip()
    for rule in _fact_rules():
        if rule[1].search(label):
            return rule[0]
    return None


@lru_cache(maxsize=1)
def _fact_rules() -> list[tuple[str, re.Pattern]]:
    return [(r["fact"], re.compile(r["re"], re.I)) for r in load()["fact_patterns"]]


def is_open_question(label: str) -> bool:
    """A question about the candidate's own story (achievement, strengths, why this role, a message) that a CV always answers in part.
    A question about a specific skill or fact is not one: the CV either has it or does not."""
    return bool(re.search(load().get("open_questions", "$^"), label or "", re.I))


def is_story_question(label: str) -> bool:
    """Questions that want a short story (your best achievement, a challenge you overcame), flagged "story" in answer_length."""
    return any(r.get("story") and re.search(r["re"], label or "", re.I) for r in load().get("answer_length", []))


def answer_flaws(text: str) -> list[str]:
    """Phrases in a drafted answer that career-ops' writing rules ban (listed in banned_in_answers), plus long dashes."""
    low = (text or "").lower()
    found = [w for w in load().get("banned_in_answers", []) if w in low]
    if "\u2014" in text or "\u2013" in text:
        found.append("long dash")
    return found


def answer_length(label: str, ftype: str, maxlength: int = 0) -> tuple[int, int]:
    """(min, max) words wanted for a free-text answer, from the first matching answer_length rule; (0, 0) for a short field.
    A field limit in characters caps the range (about 6 characters a word)."""
    lo = hi = 0
    for r in load().get("answer_length", []):
        if r.get("textarea_only") and ftype != "textarea":
            continue
        if re.search(r["re"], label or "", re.I):
            lo, hi = int(r["min"]), int(r["max"])
            break
    if maxlength and hi:
        cap = max(8, int(maxlength * 0.85 / 6))
        hi = min(hi, cap)
        lo = min(lo, max(5, int(hi * 0.6)))
    return lo, hi


def threshold(name: str) -> float:
    return load()["thresholds"][name]


def site_mode(host: str) -> str:
    """'assist' (fill and learn), 'watch' (learn only) or 'off', by registrable-host suffix."""
    host = host.lower()
    for site, mode in load()["guarded_sites"].items():
        if host == site or host.endswith("." + site):
            return mode
    return "assist"
