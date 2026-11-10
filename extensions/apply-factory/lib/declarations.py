"""
Status declarations: "I am not a protected veteran", "I am legally authorized to work in India", "No, I do not have a disability".
They appear as checkboxes, bullets or radio options in wording that changes from form to form, and the opposite statement
reads almost the same ("I am a protected veteran"). So a match needs the same polarity (both negated or both not) and the
same content words; a statement is only ever ticked when it agrees with something you answered before or a profile fact.
Consent and signature boxes are not declarations of fact and stay manual (rules.json manual_only).
"""
from __future__ import annotations

import re

from . import knowledge, options, profile, rules

_NEG = re.compile(r"\b(not|no|never|none|neither|nor|without|don'?t|do not|doesn'?t|does not|isn'?t|aren'?t|cannot|can'?t|won'?t)\b|\bnon[- ]", re.I)
_FILLER = set("""i am a an the to of in for my have has with and or that this who is are be been if any do you your as at on by it its from
identify one more following statement apply applies please check select""".split())
_NEG_WORDS = {"not", "no", "never", "none", "neither", "nor", "without", "dont", "don", "doesn", "doesnt", "isn", "isnt", "aren", "arent", "cannot", "can", "cant", "won", "wont", "non"}
_YES = re.compile(r"^(yes|y|true|checked|i agree)\b", re.I)
_NO = re.compile(r"^(no|n|false)\b", re.I)


def negated(text: str) -> bool:
    return bool(_NEG.search(text))


def content(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in _FILLER and w not in _NEG_WORDS and len(w) > 1}


def same_statement(a: str, b: str) -> bool:
    """Same polarity and one statement's content words (almost) contained in the other's."""
    if negated(a) != negated(b):
        return False
    ca, cb = content(a), content(b)
    if not ca or not cb:
        return False
    return len(ca & cb) / min(len(ca), len(cb)) >= 0.8


def check(conn, statement: str) -> bool | None:
    """True when ticking this statement agrees with what you said before, False when it contradicts a fact, None when unknown."""
    fact = rules.fact_for({"label": statement})
    if fact in ("work_authorization", "needs_sponsorship"):
        stored = knowledge.lookup_by_intent(conn, fact)
        answer = stored["answer"] if stored else profile.facts().get(fact, "")
        yes, no = bool(_YES.match(answer.strip())), bool(_NO.match(answer.strip()))
        if yes or no:
            return yes != negated(statement)  # a yes agrees with a plain statement, a no agrees with a negated one

    for row in conn.execute("SELECT e.answer, v.question_text FROM kb_entries e JOIN kb_question_variants v ON v.intent_key = e.intent_key LIMIT 3000"):
        answer = row["answer"].strip()
        if _YES.match(answer) and same_statement(statement, row["question_text"]):
            return True
        if len(answer) > 8 and not _YES.match(answer) and same_statement(statement, answer):
            return True
    return None


def agreeing_options(conn, opts: list[str]) -> list[str]:
    """Options (radio, list or dropdown entries) that read as statements you have confirmed before."""
    return [o for o in options.usable(opts) if check(conn, o) is True]
