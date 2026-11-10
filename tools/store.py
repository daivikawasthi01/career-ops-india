"""SQLite store: data/jobs.db (Phase 4).

jobs      one row per job, canonical_url is the key; status new|interested|applied|ignore
seen      dedup memory imported from scan-history.tsv 'added' rows (urls already handled)
rejected  every dropped row with its reason; kept `rejected_log_days` days
runs      one row per source per mine.py run
failures  classified failures of a run
term_yield  new rows per search term per run
Everything here is plain sqlite3. Rows are deleted only by retention: old rejected rows (prune_rejected) and jobs nobody has
looked at (expire_jobs), which leaves a tombstone in `seen` so the same job is never reported as new again. A job you marked
interested or applied is never expired.
"""
import csv
import json
import shutil
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from canonical import canonical_url, company_key, fuzzy_key

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "jobs.db"
STATUSES = ("new", "interested", "applied", "ignore")

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  canonical_url TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, posted TEXT, stipend TEXT,
  first_seen TEXT, last_seen TEXT, found_by TEXT, first_seen_by TEXT, confidence TEXT DEFAULT 'aggregator',
  employer_url TEXT, flags TEXT DEFAULT '', status TEXT DEFAULT 'new', notes TEXT DEFAULT '',
  fuzzy_key TEXT, first_run_id TEXT, last_run_id TEXT, live_checked TEXT, stale INTEGER DEFAULT 0, urls TEXT
);
CREATE INDEX IF NOT EXISTS jobs_fuzzy ON jobs(fuzzy_key);
CREATE TABLE IF NOT EXISTS seen (canonical_url TEXT PRIMARY KEY, first_seen TEXT, fuzzy_key TEXT, expired_at TEXT);
CREATE TABLE IF NOT EXISTS rejected (
  title TEXT, company TEXT, source TEXT, url TEXT, reject_reason TEXT, seen_at TEXT,
  UNIQUE(url, reject_reason, seen_at)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT, source TEXT, started TEXT, ended TEXT, status TEXT, fetched INTEGER, kept INTEGER, new INTEGER,
  duplicates INTEGER, errors INTEGER, error TEXT, seconds INTEGER, health TEXT, window_days INTEGER, dry_run INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, source)
);
CREATE TABLE IF NOT EXISTS failures (run_id TEXT, source TEXT, kind TEXT, label TEXT, message TEXT, class TEXT);
CREATE TABLE IF NOT EXISTS term_yield (run_id TEXT, term TEXT, site TEXT, fetched INTEGER, new_rows INTEGER, at TEXT);
"""


def _migrate(conn):
    """Bring an older jobs.db up to the current schema (seen gained fuzzy_key and expired_at for tombstones)."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(seen)")}
    for col in ("fuzzy_key", "expired_at"):
        if col not in cols:
            conn.execute(f"ALTER TABLE seen ADD COLUMN {col} TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS seen_fuzzy ON seen(fuzzy_key)")
    conn.commit()


def connect(path=None):
    path = str(path or DB_PATH)
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def dry_run_connection(path=None):
    """In-memory copy of data/jobs.db (empty when there is none). Never creates or changes the file."""
    path = Path(path or DB_PATH)
    mem = sqlite3.connect(":memory:")
    mem.row_factory = sqlite3.Row
    if path.exists():
        src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        src.backup(mem)
        src.close()
    mem.executescript(SCHEMA)
    _migrate(mem)
    return mem


def memory_copy(conn):
    """A throwaway in-memory copy, so a --dry-run can compute 'new' without touching the file."""
    copy = sqlite3.connect(":memory:")
    copy.row_factory = sqlite3.Row
    conn.backup(copy)
    return copy


def backup_db(path=None, keep=None):
    """Copy jobs.db to jobs.db.bak-<time>. With `keep`, only that many newest backups are left afterwards."""
    path = Path(path or DB_PATH)
    if not path.exists():
        return None
    out = path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, out)
    if keep:
        for old in sorted(path.parent.glob(f"{path.name}.bak-*"))[:-keep]:
            old.unlink()
    return out


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _flags_of(row):
    f = row.get("flags") or []
    return f if isinstance(f, list) else [x for x in str(f).split(";") if x]


def find_job(conn, urls, fkey):
    """An existing job matching any canonical URL or the fuzzy key, else None."""
    for u in urls:
        hit = conn.execute("SELECT * FROM jobs WHERE canonical_url=?", (u,)).fetchone()
        if hit:
            return hit
    if fkey:
        return conn.execute("SELECT * FROM jobs WHERE fuzzy_key=? ORDER BY first_seen LIMIT 1", (fkey,)).fetchone()
    return None


def ingest(conn, merged, run_id, today=None):
    """Write merged offers. Returns (new_rows, known_count). A row already in jobs or seen is only refreshed."""
    today = today or datetime.now().date().isoformat()
    new_rows, known = [], 0
    for row in merged:
        urls = row.get("urls") or [canonical_url(row["url"])]
        fkey = fuzzy_key(row.get("company"), row.get("title"), row.get("location"))
        hit = find_job(conn, urls, fkey)
        found = list(row.get("found_by") or [])
        first_by = dict(row.get("first_seen") or {})
        flags = _flags_of(row)
        if hit:
            known += 1
            old_found = json.loads(hit["found_by"] or "[]")
            old_first = json.loads(hit["first_seen_by"] or "{}")
            for k, v in first_by.items():
                old_first[k] = min(old_first.get(k, v), v)
            old_flags = [f for f in (hit["flags"] or "").split(";") if f]
            all_urls = sorted(set(json.loads(hit["urls"] or "[]")) | set(urls))
            conn.execute(
                "UPDATE jobs SET last_seen=?, last_run_id=?, found_by=?, first_seen_by=?, flags=?, urls=?, stale=0,"
                " confidence=CASE WHEN confidence='employer-confirmed' THEN confidence ELSE ? END,"
                " employer_url=COALESCE(employer_url, ?) WHERE canonical_url=?",
                (today, run_id, json.dumps(sorted(set(old_found) | set(found))), json.dumps(old_first),
                 ";".join(dict.fromkeys(old_flags + flags)), json.dumps(all_urls), row.get("confidence", "aggregator"),
                 row["url"] if row.get("confidence") == "employer-confirmed" else None, hit["canonical_url"]))
            continue
        if any(conn.execute("SELECT 1 FROM seen WHERE canonical_url=?", (u,)).fetchone() for u in urls) or (
                fkey and conn.execute("SELECT 1 FROM seen WHERE fuzzy_key=?", (fkey,)).fetchone()):
            known += 1
            continue
        key = row.get("canonical_url") or urls[0]
        conn.execute(
            "INSERT INTO jobs (canonical_url,url,company,title,location,posted,stipend,first_seen,last_seen,found_by,"
            "first_seen_by,confidence,employer_url,flags,status,fuzzy_key,first_run_id,last_run_id,urls)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?)",
            (key, row["url"], row.get("company"), row.get("title"), row.get("location"), row.get("posted"),
             row.get("stipend"), today, today, json.dumps(found), json.dumps(first_by),
             row.get("confidence", "aggregator"), row["url"] if row.get("confidence") == "employer-confirmed" else None,
             ";".join(flags), fkey, run_id, run_id, json.dumps(sorted(set(urls)))))
        new_rows.append(row)
    conn.commit()
    return new_rows, known


def add_rejected(conn, rows):
    """rows: dicts with title, company, source, url, reason, timestamp. Duplicates are ignored."""
    n = 0
    for r in rows:
        cur = conn.execute("INSERT OR IGNORE INTO rejected VALUES (?,?,?,?,?,?)",
                           (r.get("title"), r.get("company"), r.get("source"), r.get("url"),
                            r.get("reason") or r.get("reject_reason"), r.get("timestamp") or r.get("seen_at") or _now()))
        n += cur.rowcount
    conn.commit()
    return n


def ingest_rejected_tsv(conn, path):
    """Spool data/rejected.tsv (written by the Node scanners) into the rejected table. Safe to repeat."""
    path = Path(path)
    if not path.exists():
        return 0
    with path.open(newline="", encoding="utf-8") as f:
        return add_rejected(conn, list(csv.DictReader(f, delimiter="\t")))


EXPIRABLE = ("new", "ignore")  # interested and applied are your records of what you did: never expired


def expire_jobs(conn, ttl_days, tombstone_days, now=None):
    """Retention for jobs.db. A job nobody acted on (status new or ignore) that no scan has seen for `ttl_days` is deleted, but its
    URLs and fuzzy key go to `seen` first, so if the posting reappears it is still "already known", not new. Jobs you marked
    interested or applied are kept for good. Tombstones older than `tombstone_days` are forgotten (imported scan history, which
    has no expired_at, is never forgotten). Returns {"expired", "kept_acted_on", "forgotten"}."""
    now = now or datetime.now()
    today = now.date().isoformat()
    cutoff = (now - timedelta(days=ttl_days)).date().isoformat()
    marks = ",".join("?" * len(EXPIRABLE))
    rows = conn.execute(f"SELECT * FROM jobs WHERE status IN ({marks}) AND COALESCE(last_seen, first_seen, '') < ?",
                        (*EXPIRABLE, cutoff)).fetchall()
    for r in rows:
        urls = set(json.loads(r["urls"] or "[]")) | {r["canonical_url"], canonical_url(r["url"] or "")}
        for u in filter(None, urls):
            conn.execute("INSERT OR IGNORE INTO seen (canonical_url, first_seen, fuzzy_key, expired_at) VALUES (?,?,?,?)",
                         (u, r["first_seen"], r["fuzzy_key"], today))
        conn.execute("DELETE FROM jobs WHERE canonical_url=?", (r["canonical_url"],))
    forget = (now - timedelta(days=tombstone_days)).date().isoformat()
    forgotten = conn.execute("DELETE FROM seen WHERE expired_at IS NOT NULL AND expired_at < ?", (forget,)).rowcount
    kept = conn.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN (%s) AND COALESCE(last_seen, first_seen, '') < ?" % marks,
                        (*EXPIRABLE, cutoff)).fetchone()[0]
    conn.commit()
    return {"expired": len(rows), "kept_acted_on": kept, "forgotten": forgotten}


def prune_rejected(conn, days, now=None):
    cutoff = ((now or datetime.now()) - timedelta(days=days)).isoformat(timespec="seconds")
    cur = conn.execute("DELETE FROM rejected WHERE seen_at < ?", (cutoff,))
    conn.commit()
    return cur.rowcount


def start_run(conn):
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def record_source_run(conn, run_id, source, **f):
    cols = ["started", "ended", "status", "fetched", "kept", "new", "duplicates", "errors", "error", "seconds",
            "health", "window_days", "dry_run"]
    vals = [f.get(c) for c in cols]
    conn.execute(f"INSERT OR REPLACE INTO runs (run_id, source, {','.join(cols)}) VALUES (?,?,{','.join('?' * len(cols))})",
                 [run_id, source, *vals])
    conn.commit()


def record_failures(conn, run_id, failures):
    conn.executemany("INSERT INTO failures VALUES (?,?,?,?,?,?)",
                     [(run_id, f["step"], f["kind"], f["label"], f["message"], f.get("class", "")) for f in failures])
    conn.commit()


def record_term_yield(conn, run_id, term_stats, new_by_term, today=None):
    """term_stats: {(term, site): fetched}. new_by_term: {term: count of new jobs it found}."""
    today = today or datetime.now().date().isoformat()
    for (term, site), fetched in term_stats.items():
        conn.execute("INSERT INTO term_yield VALUES (?,?,?,?,?,?)",
                     (run_id, term, site, fetched, new_by_term.get(term, 0) if site == "*" else 0, today))
    conn.commit()


def history(conn, source, limit=14):
    """Recent real runs of a source, newest first: dicts with fetched, kept, status."""
    rows = conn.execute("SELECT * FROM runs WHERE source=? AND dry_run=0 ORDER BY run_id DESC LIMIT ?", (source, limit))
    return [dict(r) for r in rows]


def set_status(conn, url, status, note=None):
    """Set the status of a job found by canonical URL or original URL. Returns True when a row changed."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    key = canonical_url(url)
    cur = conn.execute("UPDATE jobs SET status=?, notes=CASE WHEN ? IS NULL THEN notes ELSE ? END "
                       "WHERE canonical_url=? OR url=? OR urls LIKE ?", (status, note, note, key, url, f'%"{key}"%'))
    conn.commit()
    return cur.rowcount > 0


def migrate_scan_history(conn, tsv_path):
    """Import scan-history.tsv. 'added' rows become dedup memory; skipped_* rows become rejected rows.
    Returns a report: counts per status and how much of the skipped noise names an Indian place."""
    from canonical import config as _cfg  # city aliases tell us what counts as India
    path = Path(tsv_path)
    report = {"total": 0, "by_status": {}, "skipped_with_india_location": 0, "skipped_other_location": 0}
    if not path.exists():
        return report
    india_words = {"india", *_cfg().get("city_aliases", {}).keys(), *_cfg().get("city_aliases", {}).values()}
    seen_rows, rej_rows = [], []
    with path.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            status = (r.get("status") or "").strip()
            if not r.get("url") or status == "status":
                continue
            report["total"] += 1
            report["by_status"][status] = report["by_status"].get(status, 0) + 1
            if status == "added":
                seen_rows.append((canonical_url(r["url"]), r.get("first_seen")))
            elif status.startswith("skipped_"):
                loc = (r.get("location") or "").lower()
                report["skipped_with_india_location" if any(w in loc for w in india_words) else "skipped_other_location"] += 1
                rej_rows.append({"title": r.get("title"), "company": r.get("company"), "source": r.get("portal"),
                                 "url": r["url"], "reason": status.removeprefix("skipped_"),
                                 "timestamp": (r.get("first_seen") or "") + "T00:00:00"})
    conn.executemany("INSERT OR IGNORE INTO seen (canonical_url, first_seen) VALUES (?,?)", seen_rows)
    conn.commit()
    add_rejected(conn, rej_rows)
    return report


def render_pipeline(conn, md_path, write=False):
    """Pending section of data/pipeline.md from status=new rows. Lines already in the file whose URL the database
    does not know are kept (the Node scanners still append there). Returns (new_text, added, kept_foreign)."""
    md_path = Path(md_path)
    text = md_path.read_text(encoding="utf-8") if md_path.exists() else "# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n"
    head, sep, tail = text.partition("## Pending")
    pending, sep2, processed = tail.partition("## Processed")
    if not sep or not sep2:
        raise ValueError(f"{md_path} has no '## Pending' and '## Processed' headings; refusing to rewrite it")
    known = {canonical_url(r["url"]) for r in conn.execute("SELECT url FROM jobs")}
    foreign = [l for l in pending.splitlines() if l.startswith("- [ ]") and not _line_known(l, known)]
    rows = conn.execute("SELECT url, company, title, location, flags, confidence FROM jobs WHERE status='new' AND stale=0 ORDER BY first_seen, company")
    lines = [f"- [ ] {r['url']} | {r['company'] or '?'} | {r['title']} | {r['location'] or ''}"
             + (f" | flags: {r['flags']}" if r["flags"] else "") for r in rows]
    new_text = f"{head}## Pending\n\n" + "\n".join(foreign + lines) + ("\n\n" if foreign or lines else "\n") + f"## Processed{processed}"
    if write:
        atomic_write(md_path, new_text)
    return new_text, len(lines), len(foreign)


def _line_known(line, known):
    for tok in line.replace("|", " ").split():
        if tok.startswith("http"):
            return canonical_url(tok) in known
    return True  # a line with no URL is not ours to move


def atomic_write(path, text):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
