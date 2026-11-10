"""
Vectors for question wordings and writing samples, stored as float32 blobs in kb.sqlite.
Scale is a few thousand rows, so a linear cosine scan in Python is fast enough and needs no extension.
When the local embedding model is down every function degrades to a lexical score instead of failing.
"""
from __future__ import annotations

import array
import difflib
import math
import re

from . import config, llm


def pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def unpack(blob: bytes) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


_WORD = re.compile(r"[a-z0-9]+")


def lexical_score(a: str, b: str) -> float:
    """Word overlap blended with character similarity; the fallback when no vectors are available."""
    wa, wb = set(_WORD.findall(a.lower())), set(_WORD.findall(b.lower()))
    jac = len(wa & wb) / len(wa | wb) if wa and wb else 0.0
    return 0.5 * jac + 0.5 * difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def embed_one(text: str) -> list[float] | None:
    try:
        return llm.embed([text])[0]
    except llm.LLMUnavailable:
        return None


def index_missing(conn, limit: int = 200) -> int:
    """Embed question variants and writing samples that have no vector yet. Returns how many were added."""
    model = config.load()["llm"]["embed_model"]
    added = 0
    rows = conn.execute("""
        SELECT v.variant_id, v.question_text FROM kb_question_variants v
        LEFT JOIN kb_embeddings e ON e.variant_id = v.variant_id
        WHERE e.variant_id IS NULL LIMIT ?""", (limit,)).fetchall()
    samples = conn.execute("SELECT sample_id, question_text FROM writing_samples WHERE vec IS NULL LIMIT ?", (limit,)).fetchall()
    try:
        if rows:
            for r, vec in zip(rows, llm.embed([r["question_text"] for r in rows])):
                conn.execute("INSERT OR REPLACE INTO kb_embeddings(variant_id, model, vec) VALUES (?,?,?)",
                             (r["variant_id"], model, pack(vec)))
                added += 1
        if samples:
            for r, vec in zip(samples, llm.embed([r["question_text"] for r in samples])):
                conn.execute("UPDATE writing_samples SET vec=?, model=? WHERE sample_id=?", (pack(vec), model, r["sample_id"]))
                added += 1
    except llm.LLMUnavailable:
        pass
    return added


def nearest_variants(conn, text: str, k: int = 3) -> list[dict]:
    """Closest stored wordings to `text`: [{intent_key, question_text, score}], best first."""
    model = config.load()["llm"]["embed_model"]
    q = embed_one(text)
    out = []
    if q is not None:
        for r in conn.execute("""
                SELECT v.intent_key, v.question_text, e.vec FROM kb_embeddings e
                JOIN kb_question_variants v ON v.variant_id = e.variant_id WHERE e.model = ?""", (model,)):
            out.append({"intent_key": r["intent_key"], "question_text": r["question_text"], "score": cosine(q, unpack(r["vec"]))})
    else:
        for r in conn.execute("SELECT intent_key, question_text FROM kb_question_variants"):
            out.append({"intent_key": r["intent_key"], "question_text": r["question_text"], "score": lexical_score(text, r["question_text"])})
    out.sort(key=lambda d: -d["score"])
    return out[:k]


def style_examples(conn, question: str, k: int) -> list[dict]:
    """Past long answers whose question is closest to this one; newest first when vectors are unavailable."""
    q = embed_one(question)
    rows = conn.execute("SELECT question_text, answer, vec, model FROM writing_samples ORDER BY created_at DESC LIMIT 300").fetchall()
    model = config.load()["llm"]["embed_model"]
    scored = []
    for r in rows:
        if q is not None and r["vec"] and r["model"] == model:
            s = cosine(q, unpack(r["vec"]))
        else:
            s = lexical_score(question, r["question_text"])
        scored.append({"question_text": r["question_text"], "answer": r["answer"], "score": s})
    scored.sort(key=lambda d: -d["score"])
    return scored[:k]
