"""
The scanner's job database (data/jobs.db, written by tools/mine.py) as the extension's Jobs tab reads it.

Read only: the file is opened with mode=ro, and what you do with a job (applied, dismissed, saved) is kept in this extension's own
database (job_marks), never written back. Filtering happens here so the panel only ever receives one page of rows.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, timedelta

from . import blacklist, config, locations, years

MARKS = ("applied", "dismissed", "saved")
_PAGE_MAX = 100


def _open() -> sqlite3.Connection:
    path = config.path("jobs_db")
    if not path.exists():
        raise FileNotFoundError(f"jobs database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def _words_re(words: list[str]) -> re.Pattern:
    return re.compile(r"(?<![a-z0-9])(?:" + "|".join(re.escape(w).replace(r"\ ", r"[\s-]+") for w in words) + r")(?![a-z0-9])", re.I)


# "Engineer II", "SDE 3", "L5", "(3-5 years)", "5+ yrs": a level or a number of years in the title itself.
_LEVEL = re.compile(r"(?:\b(?:sde|swe|sdet|engineer|developer|analyst|scientist)\s*[-]?\s*(?:2|3|4|5|ii|iii|iv|v)\b|\s(?:ii|iii|iv)\s*(?:\)|$)|\bl[4-9]\b)", re.I)
_TITLE_YEARS = re.compile(r"(\d+)\s*(?:\+|-\s*\d+|to\s*\d+)?\s*(?:years?|yrs?)\b", re.I)


_PATTERNS: dict = {"key": None, "senior": None, "entry": None}


def _patterns() -> tuple[re.Pattern | None, re.Pattern | None]:
    """The title word patterns, compiled once per change of config.yaml (this runs for every row of every search)."""
    try:
        key = (config.ROOT / "config.yaml").stat().st_mtime
    except OSError:
        key = 0
    if _PATTERNS["key"] != key:
        cfg = config.load().get("jobs") or {}
        _PATTERNS.update(key=key, senior=_words_re(cfg["seniority_words"]) if cfg.get("seniority_words") else None,
                         entry=_words_re(cfg["entry_words"]) if cfg.get("entry_words") else None)
    return _PATTERNS["senior"], _PATTERNS["entry"]


def too_senior_title(title: str) -> bool:
    """A title above entry level. An entry word does not rescue a senior one ("Senior Associate")."""
    senior, _ = _patterns()
    if senior and senior.search(title or ""):
        return True
    if _LEVEL.search(title or ""):
        return True
    m = _TITLE_YEARS.search(title or "")
    return bool(m and int(m.group(1)) > years.limit())


def entry_title(title: str) -> bool:
    _, entry = _patterns()
    return bool(entry and entry.search(title or "") and not too_senior_title(title))


def _sources(found_by: str | None) -> list[str]:
    try:
        v = json.loads(found_by or "[]")
        return [str(x) for x in v] if isinstance(v, list) else []
    except json.JSONDecodeError:
        return []


def _row(r: sqlite3.Row, marks: dict[str, str], yrs: dict | None = None) -> dict:
    confirmed = r["confidence"] == "employer-confirmed"
    return {
        "id": r["canonical_url"],
        # The employer's own page is the one to apply on; an aggregator listing is unconfirmed until it is found there.
        "url": (r["employer_url"] or r["url"] or r["canonical_url"]) if confirmed else (r["url"] or r["canonical_url"]),
        "company": r["company"] or "", "title": r["title"] or "", "location": r["location"] or "",
        "posted": r["posted"] if r["posted"] not in (None, "None") else "", "stipend": r["stipend"] if r["stipend"] not in (None, "None") else "",
        "first_seen": r["first_seen"], "last_seen": r["last_seen"], "sources": _sources(r["found_by"]), "confirmed": confirmed,
        "flags": [f.strip() for f in (r["flags"] or "").split(";") if f.strip()], "mark": marks.get(r["canonical_url"], ""),
        "years": years.label((yrs or {}).get(r["canonical_url"])), "entry": entry_title(r["title"] or ""),
    }


def marks(kb) -> dict[str, str]:
    return {r["canonical_url"]: r["mark"] for r in kb.execute("SELECT canonical_url, mark FROM job_marks")}


def set_mark(kb, job_id: str, mark: str) -> None:
    """mark "" clears it."""
    if mark and mark not in MARKS:
        raise ValueError(f"mark must be one of {', '.join(MARKS)}")
    if not mark:
        kb.execute("DELETE FROM job_marks WHERE canonical_url = ?", (job_id,))
    else:
        kb.execute("INSERT INTO job_marks (canonical_url, mark) VALUES (?, ?) ON CONFLICT(canonical_url) DO UPDATE SET mark = excluded.mark, marked_at = CURRENT_TIMESTAMP",
                   (job_id, mark))


def search(kb, *, q: str = "", sources: list[str] | None = None, days: int = 0, confirmed_only: bool = False, hide_flagged: bool = True,
           hide_marked: bool = True, sort: str = "new", limit: int = 40, offset: int = 0, fit: bool = True, max_years: float | None = None) -> dict:
    """One page of jobs plus the counts the filter chips show. The source counts ignore the source filter itself, so choosing one
    source still shows how many the others would add."""
    limit = max(1, min(int(limit), _PAGE_MAX))
    done = marks(kb)
    where, args = ["1=1"], []
    for tok in re.findall(r"[^\s,]+", q.lower())[:6]:
        where.append("(lower(title) LIKE ? OR lower(company) LIKE ? OR lower(location) LIKE ?)")
        args += [f"%{tok}%"] * 3
    if days:
        where.append("first_seen >= ?")
        args.append((date.today() - timedelta(days=int(days))).isoformat())
    if confirmed_only:
        where.append("confidence = 'employer-confirmed'")
    if hide_flagged:
        where.append("(flags IS NULL OR flags = '')")
    order = {"company": "lower(company) ASC, first_seen DESC", "new": "first_seen DESC, last_seen DESC, lower(company) ASC"}.get(sort, "first_seen DESC")
    try:
        conn = _open()
    except FileNotFoundError:   # nothing scanned yet: an empty list, and the panel offers to run the first search
        return {"total": 0, "all": 0, "latest": None, "offset": offset, "rows": [], "facets": {"sources": [], "marked": 0},
                "fit": {"on": fit, "limit": years.limit(), "hidden": {"senior": 0, "years": 0, "location": 0, "blacklist": 0}, "unchecked": 0, "check": years.progress()}}
    try:
        rows = conn.execute(f"SELECT * FROM jobs WHERE {' AND '.join(where)} ORDER BY {order}", args).fetchall()
        latest = conn.execute("SELECT max(last_seen) FROM jobs").fetchone()[0]
        everything = conn.execute("SELECT count(*) FROM jobs").fetchone()[0]
    finally:
        conn.close()
    yrs = years.known(kb)
    out = [_row(r, done, yrs) for r in rows]
    if hide_marked:
        out = [j for j in out if not j["mark"]]
    hidden = {"senior": 0, "years": 0, "location": 0, "blacklist": 0}
    banned = blacklist.blocked(out)   # the user's own do-not-apply list hides a company whether or not the level filter is on
    if banned:
        hidden["blacklist"] = len(banned)
        out = [j for i, j in enumerate(out) if i not in banned]
    unchecked = 0
    if fit:
        abroad = locations.foreign(j["location"] for j in out)
        kept = []
        for j in out:
            if j["location"].strip() in abroad:
                hidden["location"] += 1
            elif too_senior_title(j["title"]):
                hidden["senior"] += 1
            elif years.too_many_years(yrs.get(j["id"])):
                hidden["years"] += 1
            else:
                kept.append(j)
                unchecked += years.needs_check(yrs.get(j["id"]))
        out = kept
    if max_years is not None:   # the experience filter: 0 means no experience needed
        before = len(out)
        out = [j for j in out if years.fits(yrs.get(j["id"]), max_years, j["entry"])]
        hidden["experience"] = before - len(out)
    if sort == "fit":   # entry-level titles and jobs whose text states a small bar first, then newest
        out.sort(key=lambda j: (j["entry"], j["first_seen"] or ""), reverse=True)
    counts: dict[str, int] = {}
    for j in out:
        for s in j["sources"]:
            counts[s] = counts.get(s, 0) + 1
    chosen = {s for s in (sources or []) if s}
    if chosen:
        out = [j for j in out if chosen & set(j["sources"])]
    return {"total": len(out), "all": everything, "latest": latest, "offset": offset, "rows": out[offset:offset + limit],
            "facets": {"sources": sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])), "marked": len(done)},
            "fit": {"on": fit, "limit": years.limit(), "hidden": hidden, "unchecked": unchecked, "check": years.progress()}}


def years_todo(kb) -> list[dict]:
    """Postings worth reading the text of: they pass the title check, are not marked, and have no answer yet. Newest first."""
    done, yrs = marks(kb), years.known(kb)
    conn = _open()
    try:
        rows = conn.execute("SELECT * FROM jobs ORDER BY first_seen DESC, last_seen DESC").fetchall()
    finally:
        conn.close()
    abroad = locations.foreign(r["location"] for r in rows)
    listed = [_row(r, done, yrs) for r in rows]
    banned = blacklist.blocked(listed)
    out = []
    for i, j in enumerate(listed):
        if i in banned or j["mark"] or j["location"].strip() in abroad or too_senior_title(j["title"]) or not years.needs_check(yrs.get(j["id"])):
            continue
        out.append({"id": j["id"], "url": j["url"]})
    return out
