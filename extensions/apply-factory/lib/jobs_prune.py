"""
Remove jobs from the scanner's jobs.db that do not match this profile: their own text clearly asks for more years than you have, their title
is above entry level (Senior, Lead, Principal ... from jobs.seniority_words), or their location clearly lies outside India
(lib/locations.py; unknown places are kept).

This is the only place the extension writes to jobs.db, and only on an explicit confirm. It follows the scanner's own retention rules
(tools/store.py expire_jobs): the database is backed up first, the posting's URLs and fuzzy key go into `seen` as tombstones so the
scanner does not re-add it as new, and the reason is logged in `rejected`. Jobs you acted on (interested, applied) and jobs you marked
in the extension are never removed. If the scanner holds the write lock the call fails with a message and nothing is changed.
"""
from __future__ import annotations

import importlib
import json
import sqlite3
import sys
from datetime import date

from . import config, jobs, locations, years

EXPIRABLE = ("new", "ignore")   # the scanner never expires a job you marked interested or applied; neither does this


def _store():
    tools = str(config.CAREEROPS / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    return importlib.import_module("store")


def _rw() -> sqlite3.Connection:
    conn = sqlite3.connect(config.path("jobs_db"), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def candidates(kb) -> list[dict]:
    """Rows that clearly do not match and that nobody acted on, each with why. Read only."""
    done, yrs = jobs.marks(kb), years.known(kb)
    conn = jobs._open()
    try:
        rows = conn.execute("SELECT canonical_url, url, company, title, location, status FROM jobs").fetchall()
    finally:
        conn.close()
    abroad = locations.foreign(r["location"] for r in rows)
    out = []
    for r in rows:
        if r["status"] not in EXPIRABLE or r["canonical_url"] in done:
            continue
        if (r["location"] or "").strip() in abroad:
            why = f"location: {(r['location'] or '').strip()[:60]} is outside India"
        elif years.too_many_years(yrs.get(r["canonical_url"])):
            why = f"experience: asks {years.label(yrs[r['canonical_url']])} years, more than {years.limit():g}"
        elif jobs.too_senior_title(r["title"]):
            why = "title: above entry level"
        else:
            continue
        out.append({"id": r["canonical_url"], "title": r["title"] or "", "company": r["company"] or "", "why": why})
    return out


def remove(kb, ids: list[str] | None = None) -> dict:
    """Delete the candidates (or those of `ids` that are still candidates). Returns {removed, backup, limit}."""
    want = {c["id"]: c for c in candidates(kb)}
    if ids is not None:
        want = {i: want[i] for i in ids if i in want}
    if not want:
        return {"removed": 0, "backup": None, "limit": years.limit()}
    store = _store()
    today = date.today().isoformat()
    backup = store.backup_db(config.path("jobs_db"), keep=((config.load().get("retention") or {}).get("backups_kept")))
    conn = _rw()
    try:
        conn.execute("BEGIN IMMEDIATE")
        removed = 0
        for jid, c in want.items():
            r = conn.execute("SELECT * FROM jobs WHERE canonical_url=? AND status IN (?, ?)", (jid, *EXPIRABLE)).fetchone()
            if r is None:
                continue
            urls = set(json.loads(r["urls"] or "[]")) | {r["canonical_url"], store.canonical_url(r["url"] or "")}
            for u in filter(None, urls):
                conn.execute("INSERT OR IGNORE INTO seen (canonical_url, first_seen, fuzzy_key, expired_at) VALUES (?,?,?,?)", (u, r["first_seen"], r["fuzzy_key"], today))
            conn.execute("INSERT OR IGNORE INTO rejected VALUES (?,?,?,?,?,?)", (r["title"], r["company"], "apply-factory", r["url"], f"{c['why']} (apply-factory)", today))
            conn.execute("DELETE FROM jobs WHERE canonical_url=?", (jid,))
            removed += 1
        conn.commit()
    except sqlite3.OperationalError as e:
        conn.rollback()
        raise ValueError(f"The scanner is writing to jobs.db right now ({e}). Nothing was removed; try again in a minute.") from e
    finally:
        conn.close()
    return {"removed": removed, "backup": str(backup) if backup else None, "limit": years.limit()}
