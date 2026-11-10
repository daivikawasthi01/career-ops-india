"""Questions that can reject you on the spot (years of experience, degree, sponsorship). Warn-only: never answers or skips."""
from __future__ import annotations

import datetime
import re

from . import profile

_YEARS = re.compile(r"(\d+)\s*\+?\s*(?:or more\s*)?years?", re.I)
_DEGREE = re.compile(r"\b(have|hold|completed|earned|possess)\b.*\b(bachelor|master|degree|b\.?tech|graduat)", re.I)
_SPONSOR = re.compile(r"sponsor|work visa|require.*visa", re.I)


def warnings(fields: list[dict]) -> list[dict]:
    f = profile.facts()
    years = float(f.get("years_experience") or 0)
    grad_year = int(f.get("graduation_year") or 0)
    this_year = datetime.date.today().year
    out = []
    for fld in fields:
        label = fld.get("label", "")
        m = _YEARS.search(label)
        if m and re.search(r"experience|worked|working|professional", label, re.I) and int(m.group(1)) > years:
            out.append({"id": fld["id"], "label": label, "why": f"Asks for {m.group(1)}+ years; your profile says {f.get('years_experience', '0')}. An honest answer may be auto-rejected."})
        elif _DEGREE.search(label) and grad_year > this_year:
            out.append({"id": fld["id"], "label": label, "why": f"Asks if you hold a degree; yours is expected in {grad_year}. Check how the form wants a current student to answer."})
        elif _SPONSOR.search(label) and f.get("needs_sponsorship", "").lower() == "yes":
            out.append({"id": fld["id"], "label": label, "why": "Your profile says you need sponsorship; many forms reject on this."})
    return out
