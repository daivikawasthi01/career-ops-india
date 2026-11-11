"""What fails, counted by where and by a fixed category. Nothing else is kept.

An error message can hold a company, a link or a line of someone's CV, so it is never stored or sent. A failure is reduced to the name of the
action (a path of this app's own local API, such as /outreach/gmail) and one of the categories below, picked from the kind of error and a few
keywords in its text. Anything that fits none is "other". The daily usage report (lib/share.py) carries only the counts.
"""
from __future__ import annotations

import threading

from . import db, gmail, llm, tex

CATEGORIES = ("model_rate_limited", "model_bad_key", "model_unavailable", "gmail_not_connected", "gmail_not_set_up", "gmail_error",
              "latex_missing", "timeout", "bad_request", "crash", "other")

_here = threading.local()


def set_action(path: str) -> None:
    """The request being handled by this thread, so a slow job started from it can be counted under the same action."""
    _here.action = path


def current_action() -> str:
    return getattr(_here, "action", "") or "background"


def classify(exc: BaseException) -> str:
    text = str(exc).lower()
    if isinstance(exc, tex.ToolMissing):
        return "latex_missing"
    if isinstance(exc, llm.LLMUnavailable):
        if any(w in text for w in ("429", "rate", "quota", "limit", "exhausted")):
            return "model_rate_limited"
        if any(w in text for w in ("401", "403", "api key", "invalid key", "unauthor", "permission", "api_key")):
            return "model_bad_key"
        return "model_unavailable"
    if isinstance(exc, gmail.GmailError):
        if "not connected" in text or "connect gmail" in text or "sign in" in text:
            return "gmail_not_connected"
        if "credentials" in text or "not set up" in text or "configured" in text:
            return "gmail_not_set_up"
        return "gmail_error"
    if isinstance(exc, TimeoutError) or "timed out" in text or "timeout" in text:
        return "timeout"
    if isinstance(exc, (ValueError, KeyError)):
        return "bad_request"
    if isinstance(exc, Exception):
        return "crash"
    return "other"


def note(db_path: str, action: str, exc: BaseException) -> None:
    """Count one failure. Never raises: counting must not turn one error into two."""
    try:
        with db.tx(db_path) as conn:
            conn.execute("INSERT INTO error_events(action, category) VALUES (?,?)", (str(action)[:60], classify(exc)))
            conn.execute("DELETE FROM error_events WHERE at < datetime('now', '-60 days')")
    except Exception:
        pass


def summary(conn, days: int = 7, limit: int = 25) -> list[dict]:
    rows = conn.execute("SELECT action, category, COUNT(*) FROM error_events WHERE at >= datetime('now', ?) GROUP BY action, category ORDER BY COUNT(*) DESC LIMIT ?",
                        (f"-{int(days)} days", int(limit))).fetchall()
    return [{"action": a, "category": c, "n": n} for a, c, n in rows]
