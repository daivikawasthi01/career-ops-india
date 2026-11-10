"""
Pick the dropdown / radio option that means the same as an answer.
Order: exact, same alias group, yes/no lead word, containment, fuzzy ratio. No model is involved here;
the caller asks one only when this returns None for a field that is safe to guess.
"""
from __future__ import annotations

import difflib
import re

from . import declarations, profile, rules

PLACEHOLDER = re.compile(r"^(select|choose|please select|--+|\.\.\.|pick|none selected|select an? .*|— ?select ?—)$", re.I)
_YES = re.compile(r"^(yes|y|true|i do|i am|i have)\b", re.I)
_NO = re.compile(r"^(no|n|false|i do not|i don'?t|i am not|i have not|not)\b", re.I)


def norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9+ ]", " ", str(s).lower())
    return re.sub(r"\s+", " ", s).strip()


def usable(options: list[str]) -> list[str]:
    return [o for o in options if o and not PLACEHOLDER.match(o.strip())]


def _groups() -> dict[str, int]:
    out: dict[str, int] = {}
    for i, g in enumerate(rules.load()["option_aliases"] + profile.aliases()):
        for w in g:
            out.setdefault(norm(w), i)
    return out


def pick(answer: str, options: list[str]) -> tuple[str, float, str] | None:
    """(option, score, how) for the best option, or None when nothing is close enough or two are tied."""
    opts = usable(options)
    if not opts or not str(answer).strip():
        return None
    a = norm(answer)
    groups = _groups()
    scored: list[tuple[float, str, str]] = []
    polarity_matters = len(a.split()) >= 3  # "I am not a veteran" must never pick "I am a veteran"
    for o in opts:
        n = norm(o)
        forms = {n, norm(re.sub(r"\(.*?\)", "", o)), *(norm(x) for x in re.findall(r"\((.*?)\)", o))} - {""}  # "Netaji Subhas Institute of Technology (NSIT)"
        if polarity_matters and n != a and declarations.negated(answer) != declarations.negated(o):
            continue
        if a in forms:
            scored.append((1.0, o, "exact"))
        elif a in groups and any(groups.get(f) == groups[a] for f in forms):
            scored.append((0.96, o, "alias"))
        elif _YES.match(answer.strip()) and _YES.match(o.strip()) and not _NO.match(o.strip()):
            scored.append((0.93, o, "yes"))
        elif _NO.match(answer.strip()) and _NO.match(o.strip()):
            scored.append((0.93, o, "no"))
        elif len(a) > 3 and (re.search(rf"\b{re.escape(a)}\b", n) or (len(n) > 3 and re.search(rf"\b{re.escape(n)}\b", a))):
            scored.append((0.88, o, "contains"))
        else:
            r = difflib.SequenceMatcher(None, a, n).ratio()
            if r >= rules.threshold("option_fuzzy"):
                scored.append((r * 0.9, o, "fuzzy"))
    if not scored:
        return None
    scored.sort(key=lambda t: -t[0])
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.02 and scored[0][2] == "fuzzy":
        return None
    s, o, how = scored[0]
    return o, s, how


def queries(answer: str) -> list[str]:
    """Things to type into a search box for this answer: the answer, its first words, then its known aliases."""
    out = [answer.strip()]
    words = answer.split()
    if len(words) > 3:
        out.append(" ".join(words[:2]))
    a = norm(answer)
    groups = _groups()
    if a in groups:
        out += [w for w, g in groups.items() if g == groups[a] and w != a]
    return [q for q in dict.fromkeys(out) if q][:8]
