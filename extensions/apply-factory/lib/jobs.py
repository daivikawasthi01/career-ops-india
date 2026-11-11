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

from . import config

MARKS = ("applied", "dismissed", "saved")
_PAGE_MAX = 100


def _open() -> sqlite3.Connection:
    path = config.path("jobs_db")
    if not path.exists():
        raise FileNotFoundError(f"jobs database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def _sources(found_by: str | None) -> list[str]:
    try:
        v = json.loads(found_by or "[]")
        return [str(x) for x in v] if isinstance(v, list) else []
    except json.JSONDecodeError:
        return []


def _row(r: sqlite3.Row, marks: dict[str, str]) -> dict:
    confirmed = r["confidence"] == "employer-confirmed"
    return {
        "id": r["canonical_url"],
        # The employer's own page is the one to apply on; an aggregator listing is unconfirmed until it is found there.
        "url": (r["employer_url"] or r["url"] or r["canonical_url"]) if confirmed else (r["url"] or r["canonical_url"]),
        "company": r["company"] or "", "title": r["title"] or "", "location": r["location"] or "",
        "posted": r["posted"] if r["posted"] not in (None, "None") else "", "stipend": r["stipend"] if r["stipend"] not in (None, "None") else "",
        "first_seen": r["first_seen"], "last_seen": r["last_seen"], "sources": _sources(r["found_by"]), "confirmed": confirmed,
        "flags": [f.strip() for f in (r["flags"] or "").split(";") if f.strip()], "mark": marks.get(r["canonical_url"], ""),
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
           hide_marked: bool = True, sort: str = "new", limit: int = 40, offset: int = 0) -> dict:
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
    conn = _open()
    try:
        rows = conn.execute(f"SELECT * FROM jobs WHERE {' AND '.join(where)} ORDER BY {order}", args).fetchall()
        latest = conn.execute("SELECT max(last_seen) FROM jobs").fetchone()[0]
        everything = conn.execute("SELECT count(*) FROM jobs").fetchone()[0]
    finally:
        conn.close()
    out = [_row(r, done) for r in rows]
    if hide_marked:
        out = [j for j in out if not j["mark"]]
    counts: dict[str, int] = {}
    for j in out:
        for s in j["sources"]:
            counts[s] = counts.get(s, 0) + 1
    chosen = {s for s in (sources or []) if s}
    if chosen:
        out = [j for j in out if chosen & set(j["sources"])]
    return {"total": len(out), "all": everything, "latest": latest, "offset": offset, "rows": out[offset:offset + limit],
            "facets": {"sources": sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])), "marked": len(done)}}
