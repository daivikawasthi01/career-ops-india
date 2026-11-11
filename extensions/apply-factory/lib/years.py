"""
How many years of experience each job in the Jobs tab asks for, read from the posting's own text.

A title says little ("AI Product Engineer" can want 5 years), and jobs.db keeps no job text, so this reads it: career-ops' jd-years.mjs
through tools/years.mjs, over the ATS's public JSON API (Greenhouse, Lever, Ashby, Workday, SmartRecruiters ...). Rules only, no model,
no tokens. Answers are kept in kb.sqlite (job_years) so each posting is read once. A job is hidden only when its text clearly states a
required minimum above your years plus jobs.stretch_years; anything unclear, unread or without a public API stays visible.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterator

import yaml

from . import config, db

HELPER = config.ROOT / "tools" / "years.mjs"
_RETRY_UNREAD = timedelta(days=1)


def my_years() -> float:
    try:
        prof = yaml.safe_load(config.path("profile").read_text()) or {}
        return float((prof.get("candidate") or {}).get("years_of_experience") or 0)
    except (OSError, ValueError, yaml.YAMLError):
        return 0.0


def _mtimes() -> tuple:
    out = []
    for p in (config.ROOT / "config.yaml", config.path("profile")):
        try:
            out.append(p.stat().st_mtime)
        except OSError:
            out.append(0)
    return tuple(out)


_LIMIT: dict = {"key": None, "value": 0.0}


def limit() -> float:
    """The most years a job may ask for and still fit. Called for every row, so it is read from the two files only when they change."""
    key = _mtimes()
    if _LIMIT["key"] != key:
        _LIMIT.update(key=key, value=my_years() + float((config.load().get("jobs") or {}).get("stretch_years", 1)))
    return _LIMIT["value"]


def _run_node(jobs: list[dict]) -> Iterator[dict]:
    """The outside-world seam: yields one verdict dict per posting as the helper finishes it. Tests replace this name."""
    proc = subprocess.Popen(["node", str(HELPER)], cwd=config.CAREEROPS, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    proc.stdin.write(json.dumps(jobs))
    proc.stdin.close()
    try:
        for line in proc.stdout:
            try:
                yield json.loads(line)
            except ValueError:
                continue
    finally:
        proc.stdout.close()
        proc.wait(timeout=30)


run_node: Callable[[list[dict]], Iterator[dict]] = _run_node


def known(kb) -> dict[str, dict]:
    return {r["canonical_url"]: dict(r) for r in kb.execute("SELECT * FROM job_years")}


def needs_check(rec: dict | None, now: datetime | None = None) -> bool:
    """Not read yet, or a read that failed more than a day ago."""
    if rec is None:
        return True
    if rec["state"] != "unread":
        return False
    try:
        made = datetime.fromisoformat(str(rec["checked_at"]).replace(" ", "T")).replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return (now or datetime.now(timezone.utc)) - made > _RETRY_UNREAD


def too_many_years(rec: dict | None) -> bool:
    """True only for a clearly stated required minimum above the limit."""
    return bool(rec and rec["state"] == "read" and rec["status"] == "stated" and rec["confident"] and rec["min_years"] is not None and rec["min_years"] > limit())


def fits(rec: dict | None, most: float, entry: bool = False) -> bool:
    """For the experience filter: does this job ask for at most `most` years? A stated minimum decides. A text that was read and states
    no bar passes. A job not read yet passes, except for 0 years, where only an entry-level title does (nothing says it needs none)."""
    if rec and rec["state"] == "read":
        if rec["status"] == "stated" and rec["min_years"] is not None:
            return rec["min_years"] <= most
        return True
    return entry if most <= 0 else True


def label(rec: dict | None) -> str:
    """'5+', '3-5' ... for a job whose text states a bar; empty otherwise."""
    return rec["display"] if rec and rec["state"] == "read" and rec["status"] == "stated" else ""


# ---- the background check ----
_LOCK = threading.Lock()
PROGRESS = {"running": False, "done": 0, "total": 0, "error": "", "removed": 0}


def progress() -> dict:
    return dict(PROGRESS)


def _store(db_path: str, rows: list[dict]) -> None:
    with db.tx(db_path) as conn:
        for v in rows:
            conn.execute("INSERT OR REPLACE INTO job_years (canonical_url, state, status, min_years, confident, display, checked_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
                         (v["id"], v["state"], v.get("status"), v.get("min"), int(bool(v.get("confident"))), v.get("display", "")))


def start(db_path: str, todo: list[dict], on_done: Callable[[], int] | None = None) -> bool:
    """Read `todo` ([{id, url}], best first) in the background; then call on_done (it returns how many jobs it removed). False when a check
    is already running or there is nothing to do. With nothing to read, on_done still runs (the cleanup)."""
    with _LOCK:
        if PROGRESS["running"] or (not todo and not on_done):
            return False
        PROGRESS.update(running=True, done=0, total=len(todo), error="", removed=0)
    batch = int((config.load().get("jobs") or {}).get("years_batch", 150))

    def work():
        try:
            for i in range(0, len(todo), batch):
                chunk, got = todo[i:i + batch], []
                for verdict in run_node(chunk):
                    got.append(verdict)
                    PROGRESS["done"] += 1
                    if len(got) >= 20:
                        _store(db_path, got)
                        got = []
                if got:
                    _store(db_path, got)
            if on_done:
                PROGRESS["removed"] = on_done()
        except (OSError, subprocess.SubprocessError) as e:
            PROGRESS["error"] = f"could not run node: {e}"[:200]
        except ValueError as e:   # the scanner held the database; the jobs stay hidden and are removed on the next check
            PROGRESS["error"] = str(e)[:200]
        finally:
            PROGRESS["running"] = False
    threading.Thread(target=work, daemon=True).start()
    return True
