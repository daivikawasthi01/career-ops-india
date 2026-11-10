"""
Learn from the fields the browser extension captures when you press Next or Submit.

Field shape:
  {"label": "...", "field_type": "radio", "value": "Yes", "options": [...],
   "was_prefilled": true, "prefilled_value": "Yes"}

For each field, normalize label -> intent_key, then upsert into KB.
event_type in {new, reinforced, corrected} is tracked in learning_events.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import hashlib

from lib import db, embed, knowledge, llm, rules

# Never learn from these: they are job-specific and shouldn't persist as reusable answers.
SKIP_INTENTS = {
    "cover_letter", "resume_upload", "job_specific_question",
    "captcha", "additional_notes", "why_company", "why_this_role",
    "why_company_free", "additional_information",
}
SKIP_FIELD_TYPES = {"file", "hidden", "password"}
LONG_ANSWER_CHARS = 120  # a long free-text answer is style data for drafting, not a reusable fact


def _url_key(url: str) -> str:
    from urllib.parse import urlsplit
    u = urlsplit(url)
    return f"{u.netloc.lower()}{u.path.rstrip('/')}"


def learn_fields(db_path: str, fields: list[dict], *, url_key: str = "", app_id: int | None = None,
                 company: str = "") -> dict:
    """Learn every field in its own transaction, so one model failure queues that field and keeps the rest."""
    events = {"new": [], "reinforced": [], "corrected": [], "skipped": [], "queued": []}
    for field in fields:
        try:
            with db.tx(db_path) as conn:
                outcome = _process_field(conn, field, app_id, url_key, company)
        except (llm.LLMUnavailable, ValueError) as e:
            _queue(db_path, field, url_key, str(e))
            outcome = {"event_type": "queued", "label": field.get("label", ""), "reason": str(e)[:200]}
        events[outcome["event_type"]].append(outcome)
    with db.tx(db_path) as conn:
        embed.index_missing(conn)
    return events


def retry_pending(db_path: str, max_attempts: int = 5) -> dict:
    """Re-run fields that failed earlier, e.g. because Ollama was not running."""
    with db.tx(db_path) as conn:
        rows = conn.execute("SELECT pending_id, field_json, url_key FROM pending_fields WHERE attempts < ?", (max_attempts,)).fetchall()
    done = {"learned": 0, "still_failing": 0}
    for r in rows:
        field = json.loads(r["field_json"])
        try:
            with db.tx(db_path) as conn:
                _process_field(conn, field, None, r["url_key"] or "", "", force=True)
                conn.execute("DELETE FROM pending_fields WHERE pending_id = ?", (r["pending_id"],))
            done["learned"] += 1
        except (llm.LLMUnavailable, ValueError) as e:
            with db.tx(db_path) as conn:
                conn.execute("UPDATE pending_fields SET attempts = attempts + 1, last_error = ? WHERE pending_id = ?", (str(e)[:300], r["pending_id"]))
            done["still_failing"] += 1
    return done


def _queue(db_path: str, field: dict, url_key: str, error: str) -> None:
    with db.tx(db_path) as conn:
        conn.execute("INSERT INTO pending_fields(field_json, url_key, last_error) VALUES (?,?,?)",
                     (json.dumps(field), url_key, error[:300]))


def _hash(value: str) -> str:
    return hashlib.sha1(value.encode()).hexdigest()[:16]


def _process_field(conn, field: dict, app_id: int | None, url_key: str = "", company: str = "", *, force: bool = False) -> dict:
    label = (field.get("label") or "").strip()
    value = field.get("value")
    field_type = field.get("field_type") or field.get("type") or "text"

    if not label or value in (None, "", []) or field_type in SKIP_FIELD_TYPES:
        return {"event_type": "skipped", "label": label, "reason": "empty or non-learnable"}
    if rules.never_read({**field, "label": label}) or rules.manual_only({**field, "label": label}):
        return {"event_type": "skipped", "label": label, "reason": "rules: never learned"}

    stored_value = _coerce(value)
    seen_key = (url_key, label, _hash(stored_value))
    if not force and url_key and conn.execute("SELECT 1 FROM capture_seen WHERE url_key=? AND label=? AND value_hash=?", seen_key).fetchone():
        return {"event_type": "skipped", "label": label, "reason": "already captured on this page"}

    if field_type == "textarea" or len(stored_value) >= LONG_ANSWER_CHARS:
        conn.execute("INSERT OR IGNORE INTO writing_samples(question_text, answer, url_key, company) VALUES (?,?,?,?)",
                     (label, stored_value, url_key, company))
        return _mark_seen(conn, seen_key, {"event_type": "skipped", "label": label, "reason": "kept as a writing sample"})

    norm = knowledge.normalize_question(conn, label, field_type)
    intent_key = norm["intent_key"]
    if intent_key in SKIP_INTENTS:
        return _mark_seen(conn, seen_key, {"event_type": "skipped", "label": label, "reason": f"blocklisted intent: {intent_key}"})

    prefilled_unchanged = bool(field.get("was_prefilled")) and _same_text(field.get("prefilled_value"), stored_value)
    event_type = knowledge.upsert(
        conn, intent_key=intent_key, answer=stored_value, question_text=label, field_type=field_type,
        answer_type=norm.get("answer_type", "text"),
        source="manual" if not field.get("was_prefilled") else "corrected",
        confidence=1.0, app_id=app_id,
    )
    if prefilled_unchanged and event_type == "corrected":
        event_type = "reinforced"
    return _mark_seen(conn, seen_key, {"event_type": event_type, "label": label, "intent_key": intent_key, "value": stored_value})


def _same_text(a, b) -> bool:
    return str(a or "").strip().lower() == str(b or "").strip().lower()


def _mark_seen(conn, seen_key: tuple, outcome: dict) -> dict:
    if seen_key[0]:
        conn.execute("INSERT OR IGNORE INTO capture_seen(url_key, label, value_hash) VALUES (?,?,?)", seen_key)
    return outcome


def _coerce(v) -> str:
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)
