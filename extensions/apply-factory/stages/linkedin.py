"""LinkedIn inbox helpers. Search is manual (orchestrator.py linkedin-url / linkedin-add); nothing here drives a browser."""
from __future__ import annotations

import hashlib


def _slug(company: str, role: str) -> str:
    """Generate a career-ops-style slug: company-role-hash."""
    base = f"{company}-{role}".lower()
    base = "".join(c if c.isalnum() or c == "-" else "-" for c in base)
    base = "-".join(p for p in base.split("-") if p)[:60]
    h = hashlib.sha1(f"{company}|{role}".encode()).hexdigest()[:6]
    return f"{base}-{h}"
