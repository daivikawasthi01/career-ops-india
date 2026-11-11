"""
The do-not-apply list, shared with the scanners: career-ops' own data/blacklist.md (a markdown table: Company | Since | Scope | Reason).

scan.mjs and the other Node scanners skip listed companies already; tools/freshness.py applies the same list to everything mine.py saves.
This module is the extension's way to edit that one file (add from the Jobs tab, fix a reason or a name, take an entry off again) and to
hide listed companies from the Jobs list. Matching is never done here: tools/blacklist-match.mjs runs scan.mjs's own matcher, so
"Acme Corp." here and "acme corp" in a feed are the same company everywhere.

Rows are addressed by line number plus the company text on that line, so an edit made while the file changed underneath is refused
instead of landing on the wrong row. Everything else in the file (notes, other tables) is left alone, and writes are atomic.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
from datetime import date
from pathlib import Path
from typing import Callable, Iterable

from . import config

HELPER = config.CAREEROPS / "tools" / "blacklist-match.mjs"
_LOCK = threading.Lock()
_HEADER = ("# Company Blacklist\n\nYour own do-not-apply list. The Jobs tab of the extension edits it; so can you.\n"
           "Scope is `company` (name match, case and punctuation ignored) or `domain` (a hostname such as ibm.com).\n\n"
           "| Company | Since | Scope | Reason |\n|---------|-------|-------|--------|\n")


class BlacklistError(ValueError):
    pass


def path() -> Path:
    return config.CAREEROPS / "data" / "blacklist.md"


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").replace("|", "/")).strip()


def _key(company: str, scope: str) -> str:
    c = re.sub(r"[^\w]+", "", company.lower())
    return f"{scope}:{c}"


def _lines() -> list[str]:
    try:
        return path().read_text(encoding="utf-8").split("\n")
    except FileNotFoundError:
        return []


def _row(i: int, line: str) -> dict | None:
    if not line.strip().startswith("|"):
        return None
    cells = [c.strip() for c in line.split("|")]
    company = cells[1] if len(cells) > 1 else ""
    if not company or re.fullmatch(r"[-: ]+", company) or company.lower() == "company":
        return None
    scope = (cells[3] if len(cells) > 3 else "").lower()
    return {"line": i, "company": company, "since": cells[2] if len(cells) > 2 else "", "scope": "domain" if scope == "domain" else "company",
            "reason": cells[4] if len(cells) > 4 else ""}


def entries() -> list[dict]:
    return [r for i, line in enumerate(_lines()) if (r := _row(i, line))]


def _write(lines: list[str]) -> None:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".blacklist-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")
    os.replace(tmp, p)
    _CACHE.clear()


def _format(company: str, since: str, scope: str, reason: str) -> str:
    return f"| {company} | {since} | {scope} | {reason} |"


def add(company: str, reason: str = "", scope: str = "company") -> dict:
    """Put a company on the list. Returns {entry, added}; adding one that is already listed changes nothing."""
    company, reason = _clean(company), _clean(reason)
    scope = "domain" if scope == "domain" else "company"
    if not company:
        raise BlacklistError("A company name is required.")
    with _LOCK:
        lines = _lines()
        for r in entries():
            if _key(r["company"], r["scope"]) == _key(company, scope):
                return {"entry": r, "added": False}
        if not lines:
            lines = _HEADER.split("\n")
        # new rows go right after the last table row, or after the table header when the table is empty
        last = max((i for i, ln in enumerate(lines) if ln.strip().startswith("|")), default=len(lines) - 1)
        lines.insert(last + 1, _format(company, date.today().isoformat(), scope, reason or "added from the Jobs tab"))
        _write(lines)
        return {"entry": next(r for r in entries() if r["line"] == last + 1), "added": True}


def _locate(line: int, company: str) -> tuple[list[str], dict]:
    lines = _lines()
    row = _row(line, lines[line]) if 0 <= line < len(lines) else None
    if row is None or row["company"] != company:
        raise BlacklistError("The blacklist changed since it was loaded. Reload it and try again.")
    return lines, row


def update(line: int, company_was: str, company: str, reason: str, scope: str | None = None) -> dict:
    company, reason = _clean(company), _clean(reason)
    if not company:
        raise BlacklistError("A company name is required.")
    with _LOCK:
        lines, row = _locate(line, company_was)
        new_scope = ("domain" if scope == "domain" else "company") if scope else row["scope"]
        for r in entries():
            if r["line"] != line and _key(r["company"], r["scope"]) == _key(company, new_scope):
                raise BlacklistError(f"{r['company']} is already on the list.")
        lines[line] = _format(company, row["since"], new_scope, reason)
        _write(lines)
        return next(r for r in entries() if r["line"] == line)


def remove(line: int, company: str) -> dict:
    with _LOCK:
        lines, row = _locate(line, company)
        del lines[line]
        _write(lines)
        return row


# ---- matching ----------------------------------------------------------------------------------------------------------------------

def _run_node(pairs: list[dict]) -> list[int]:
    """The outside-world seam. Tests replace this name."""
    r = subprocess.run(["node", str(HELPER)], input=json.dumps(pairs), capture_output=True, text=True, timeout=60, cwd=config.CAREEROPS)
    if r.returncode != 0:
        raise OSError(r.stderr.strip()[-200:] or "blacklist helper failed")
    return json.loads(r.stdout or "[]")


run_node: Callable[[list[dict]], list[int]] = _run_node
_CACHE: dict = {}   # one search after another asks about the same jobs: answer once


def blocked(rows: Iterable[dict]) -> set[int]:
    """Positions in rows (dicts with company and url) that the blacklist rules out. If the helper cannot run, nothing is hidden."""
    pairs = [{"company": str(r.get("company") or ""), "url": str(r.get("url") or "")} for r in rows]
    if not pairs or not entries():
        return set()
    key = (path().stat().st_mtime_ns, hashlib.sha1(json.dumps(pairs).encode()).hexdigest())
    if key in _CACHE:
        return _CACHE[key]
    try:
        out = set(run_node(pairs))
    except (OSError, ValueError, subprocess.SubprocessError):
        return set()
    _CACHE.clear()
    _CACHE[key] = out
    return out
