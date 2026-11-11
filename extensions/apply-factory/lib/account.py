"""What the side panel's "You" tab needs: is the setup complete, the details used to fill forms, the answers learned so far, and local usage totals.

Everything here is local. Usage events hold a kind, a count and a time; no form text is stored in them.
"""
from __future__ import annotations

import json
import re

from . import config, llm, profile, resume

REQUIRED_FACTS = ("first_name", "last_name", "email", "phone")
# The details the panel lets you edit, in display order. Anything else in facts.yml is kept as it is.
FACT_FIELDS = [
    ("first_name", "First name"), ("last_name", "Last name"), ("email", "Email"), ("phone", "Phone (with country code)"),
    ("linkedin", "LinkedIn"), ("github", "GitHub"), ("portfolio", "Website"),
    ("city", "City"), ("state", "State"), ("country", "Country"), ("nationality", "Nationality"),
    ("college", "College"), ("degree", "Degree"), ("branch", "Branch"), ("graduation_year", "Graduation year"), ("cgpa", "CGPA"),
    ("years_experience", "Years of experience"), ("work_authorization", "Authorised to work (Yes/No)"), ("needs_sponsorship", "Needs sponsorship (Yes/No)"),
]
_ALLOWED = {k for k, _ in FACT_FIELDS} | {"full_name", "phone_national", "phone_country_code"}
USAGE_KINDS = ("fill", "draft", "form")
SECONDS_SAVED = {"fill": 10, "draft": 90}   # a rough, stated estimate per answer, shown as such


def readiness() -> dict:
    facts = profile.facts()
    missing = [k for k in REQUIRED_FACTS if not facts.get(k)]
    cv_ok = bool(profile.cv_text().strip())
    pdf = next((r for r in resume.status() if r.get("kind") == "default"), None)
    model = llm.status()
    steps = [
        {"key": "model", "done": bool(model.get("ok")), "title": "Connect a free AI service",
         "why": "Writes answers, scores jobs and researches companies. Saved answers fill without it."},
        {"key": "details", "done": not missing, "title": "Your details", "why": "Name, email and phone fill most forms.", "missing": missing},
        {"key": "cv_pdf", "done": bool(pdf and pdf.get("exists")), "title": "Your CV", "why": "The PDF is attached to application forms."},
        {"key": "cv_text", "done": cv_ok, "title": "Your CV as text", "why": "Drafts and scores are written from it."},
        {"key": "search", "done": (config.CAREEROPS / "config" / "profile.yml").exists(), "title": "What jobs to look for", "why": "Roles, level and place for the Jobs tab."},
    ]
    return {"steps": steps, "ready": all(s["done"] for s in steps), "facts_missing": missing}


# ---- details (facts.yml) ----
def get_facts() -> dict:
    f = profile.facts()
    return {"fields": [{"key": k, "label": lab, "value": f.get(k, ""), "required": k in REQUIRED_FACTS} for k, lab in FACT_FIELDS]}


def _line(key: str, value: str) -> str:
    return f"{key}: {json.dumps(value, ensure_ascii=False)}"


def set_facts(values: dict) -> dict:
    """Update only the keys given, in place, so the comments and the aliases block in facts.yml survive."""
    clean = {}
    for k, v in values.items():
        if k not in _ALLOWED:
            raise ValueError(f"unknown detail: {k}")
        v = str(v).strip()
        if "\n" in v or len(v) > 300:
            raise ValueError(f"{k} must be one short line")
        clean[k] = v
    if clean.get("email") and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", clean["email"]):
        raise ValueError("that email address does not look right")
    if clean.get("phone"):
        digits = re.sub(r"\D", "", clean["phone"])
        if not 8 <= len(digits) <= 15:
            raise ValueError("the phone number should have 8 to 15 digits")
        clean["phone"] = ("+" if clean["phone"].lstrip().startswith("+") else "") + digits
        # a phone box without a country code gets the national part; derive it when the code is known
        code = re.sub(r"\D", "", profile.facts().get("phone_country_code", ""))
        if clean["phone"].startswith("+") and code and digits.startswith(code):
            clean["phone_national"] = digits[len(code):]
        elif not clean["phone"].startswith("+"):
            clean["phone_national"] = digits
    first, last = clean.get("first_name", profile.facts().get("first_name", "")), clean.get("last_name", profile.facts().get("last_name", ""))
    if ("first_name" in clean or "last_name" in clean) and (first or last):
        clean["full_name"] = f"{first} {last}".strip()
    p = config.path("facts", "paths_extra")
    lines = p.read_text().splitlines() if p.exists() else []
    for k, v in clean.items():
        pat = re.compile(rf"^{re.escape(k)}\s*:")
        hit = next((i for i, ln in enumerate(lines) if pat.match(ln)), None)
        if v == "":
            if hit is not None:
                del lines[hit]
        elif hit is not None:
            lines[hit] = _line(k, v)
        else:
            at = next((i for i, ln in enumerate(lines) if ln.startswith("aliases:")), len(lines))
            lines.insert(at, _line(k, v))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(lines) + "\n")
    profile.reload()
    return readiness()


# ---- learned answers ----
def list_answers(conn, q: str = "", limit: int = 60, offset: int = 0) -> dict:
    like = f"%{q.strip().lower()}%"
    where = "WHERE lower(e.answer) LIKE ? OR lower(e.intent_key) LIKE ? OR EXISTS (SELECT 1 FROM kb_question_variants v WHERE v.intent_key=e.intent_key AND lower(v.question_text) LIKE ?)" if q.strip() else ""
    args = (like, like, like) if q.strip() else ()
    total = conn.execute(f"SELECT COUNT(*) FROM kb_entries e {where}", args).fetchone()[0]
    rows = conn.execute(f"""SELECT e.intent_key, e.answer, e.answer_type, e.seen_count, e.last_seen, e.source,
        (SELECT group_concat(question_text, ' || ') FROM (SELECT question_text FROM kb_question_variants v WHERE v.intent_key=e.intent_key ORDER BY variant_id LIMIT 3)) AS questions
        FROM kb_entries e {where} ORDER BY e.last_seen DESC LIMIT ? OFFSET ?""", (*args, max(1, min(int(limit), 200)), max(0, int(offset)))).fetchall()
    return {"total": total, "rows": [{**dict(r), "questions": (r["questions"] or "").split(" || ")[:3] if r["questions"] else []} for r in rows]}


def update_answer(conn, intent_key: str, answer: str) -> dict:
    answer = str(answer).strip()
    if not answer:
        raise ValueError("an answer cannot be empty; delete it instead")
    if len(answer) > 2000:
        raise ValueError("that answer is too long for a saved short answer")
    row = conn.execute("SELECT answer FROM kb_entries WHERE intent_key=?", (intent_key,)).fetchone()
    if not row:
        raise KeyError("no such saved answer")
    conn.execute("UPDATE kb_entries SET answer=?, source='manual', last_seen=CURRENT_TIMESTAMP WHERE intent_key=?", (answer, intent_key))
    conn.execute("INSERT INTO learning_events(intent_key, question_text, old_answer, new_answer, event_type) VALUES (?,?,?,?,?)",
                 (intent_key, "(edited in the panel)", row["answer"], answer, "manual_edit"))
    return {"ok": True}


def delete_answer(conn, intent_key: str) -> dict:
    """Forget a saved answer and the wordings that pointed at it. The next form that asks it will be learned again from scratch."""
    row = conn.execute("SELECT answer FROM kb_entries WHERE intent_key=?", (intent_key,)).fetchone()
    if not row:
        raise KeyError("no such saved answer")
    conn.execute("DELETE FROM kb_embeddings WHERE variant_id IN (SELECT variant_id FROM kb_question_variants WHERE intent_key=?)", (intent_key,))
    conn.execute("DELETE FROM kb_question_variants WHERE intent_key=?", (intent_key,))
    conn.execute("DELETE FROM kb_entries WHERE intent_key=?", (intent_key,))
    conn.execute("INSERT INTO learning_events(intent_key, question_text, old_answer, new_answer, event_type) VALUES (?,?,?,?,?)",
                 (intent_key, "(deleted in the panel)", row["answer"], "", "manual_delete"))
    return {"ok": True}


# ---- usage totals ----
def record(conn, kind: str, n: int = 1) -> dict:
    if kind not in USAGE_KINDS:
        raise ValueError("unknown event")
    n = max(1, min(int(n), 500))
    conn.execute("INSERT INTO usage_events(kind, n) VALUES (?,?)", (kind, n))
    return {"ok": True}


def stats(conn) -> dict:
    def window(days: int | None) -> dict:
        cond = f"WHERE at >= datetime('now', '-{int(days)} days')" if days else ""
        got = {k: n for k, n in conn.execute(f"SELECT kind, COALESCE(SUM(n),0) FROM usage_events {cond} GROUP BY kind").fetchall()}
        secs = sum(got.get(k, 0) * s for k, s in SECONDS_SAVED.items())
        return {"forms": got.get("form", 0), "fills": got.get("fill", 0), "drafts": got.get("draft", 0), "minutes_saved": round(secs / 60)}
    return {"week": window(7), "all": window(None), "note": "Estimate: 10 seconds per filled answer, 90 per drafted one."}
