-- apply-factory KB schema

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS kb_entries (
    intent_key    TEXT PRIMARY KEY,
    answer_type   TEXT NOT NULL,
    answer        TEXT NOT NULL,
    confidence    REAL DEFAULT 1.0,
    source        TEXT DEFAULT 'manual',
    seen_count    INTEGER DEFAULT 1,
    last_seen     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes         TEXT
);

CREATE TABLE IF NOT EXISTS kb_question_variants (
    variant_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_key    TEXT NOT NULL REFERENCES kb_entries(intent_key),
    question_text TEXT NOT NULL,
    field_type    TEXT,
    first_seen    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(intent_key, question_text)
);

CREATE INDEX IF NOT EXISTS idx_variants_intent ON kb_question_variants(intent_key);

CREATE TABLE IF NOT EXISTS learning_events (
    event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id        INTEGER,
    intent_key    TEXT NOT NULL,
    question_text TEXT NOT NULL,
    old_answer    TEXT,
    new_answer    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Embedding of one stored question wording, for "same question, different words" lookups.
CREATE TABLE IF NOT EXISTS kb_embeddings (
    variant_id    INTEGER PRIMARY KEY REFERENCES kb_question_variants(variant_id) ON DELETE CASCADE,
    model         TEXT NOT NULL,
    vec           BLOB NOT NULL
);

-- Long free-text answers kept as writing style examples, including job-specific ones that
-- kb_entries deliberately does not store (why this company, cover letter, ...).
CREATE TABLE IF NOT EXISTS writing_samples (
    sample_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    question_text TEXT NOT NULL,
    answer        TEXT NOT NULL,
    url_key       TEXT,
    company       TEXT,
    model         TEXT,
    vec           BLOB,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(question_text, answer)
);

-- Fields whose learning failed (model down, bad JSON). Retried on the next server start and by `retry`.
CREATE TABLE IF NOT EXISTS pending_fields (
    pending_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    field_json    TEXT NOT NULL,
    url_key       TEXT,
    attempts      INTEGER DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A capture is sent on every Next/Submit click. This remembers what was already learned so a
-- repeated capture of an unchanged field does not count as another confirmation.
CREATE TABLE IF NOT EXISTS capture_seen (
    url_key       TEXT NOT NULL,
    label         TEXT NOT NULL,
    value_hash    TEXT NOT NULL,
    seen_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (url_key, label, value_hash)
);

-- A quick job score is a model call over a long prompt; the same posting and CV give the same answer, so keep it.
CREATE TABLE IF NOT EXISTS score_cache (
    cache_key     TEXT PRIMARY KEY,
    result_json   TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Your own marks on jobs from the scanner's jobs.db (applied, dismissed, saved). The scanner's file is never written to.
CREATE TABLE IF NOT EXISTS job_marks (
    canonical_url TEXT PRIMARY KEY,
    mark          TEXT NOT NULL,
    marked_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Company research (a few model searches each) is kept for company.cache_days; mail checks for mail.cache_days.
CREATE TABLE IF NOT EXISTS company_cache (
    cache_key   TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
