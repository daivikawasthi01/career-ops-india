#!/usr/bin/env python3
"""Is a job still open? Polite check of employer-site URLs, plus staleness by age (Phase 7.2).

  python3 tools/liveness.py --dry-run          # list what would be checked
  python3 tools/liveness.py --limit 40         # check up to 40 rows; updates last_seen / stale in data/jobs.db
Aggregator URLs (LinkedIn, Naukri, Indeed, Internshala ...) are NOT fetched: their terms restrict automated access.
Those rows only go stale by age. Concurrency and per-host delay come from config liveness:.
"""
import argparse
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from urllib.parse import urlparse

import pipeline_cfg
import store
from canonical import config as dedup_config
from canonical import host_matches, host_of

UA = "Mozilla/5.0 (compatible; career-ops-liveness; +single check per job)"


def classify(original_url, final_url, status, body, cfg):
    """alive | gone | generic. A redirect from a deep posting URL to a listing page means the posting is gone."""
    if status in (404, 410):
        return "gone"
    if status >= 400:
        return "error"
    orig = [p for p in urlparse(original_url).path.split("/") if p]
    final_path = urlparse(final_url).path.rstrip("/") or "/"
    final = [p for p in final_path.split("/") if p]
    if len(orig) >= 2 and (final_path.lower() in cfg["generic_paths"] or len(final) <= 1):
        return "generic"
    low = (body or "").lower()
    if any(m in low for m in cfg["gone_markers"]):
        return "gone"
    return "alive"


def fetch(url, timeout):
    """(status, final_url, body). HEAD first; GET when HEAD is refused. Never raises for HTTP errors."""
    def once(method):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.geturl(), (r.read(200_000).decode("utf-8", "ignore") if method == "GET" else "")
        except urllib.error.HTTPError as e:
            return e.code, url, ""
    status, final, body = once("HEAD")
    if status in (403, 405, 501) or status >= 500:
        status, final, body = once("GET")
    elif status < 400:
        # a HEAD cannot show "this job has expired" text, so read the page once when HEAD says OK
        status, final, body = once("GET")
    return status, final, body


class HostPacer:
    """At most one request per host every `delay` seconds, across threads."""
    def __init__(self, delay, clock=time.monotonic, sleep=time.sleep):
        self.delay, self.clock, self.sleep = delay, clock, sleep
        self.next_ok, self.lock = {}, threading.Lock()

    def wait(self, host):
        with self.lock:
            now = self.clock()
            at = max(self.next_ok.get(host, 0), now)
            self.next_ok[host] = at + self.delay
        if at > now:
            self.sleep(at - now)


def mark_stale(conn, days, today=None):
    cutoff = ((today or date.today()) - timedelta(days=days)).isoformat()
    cur = conn.execute("UPDATE jobs SET stale=1 WHERE status='new' AND stale=0 AND last_seen < ?", (cutoff,))
    conn.commit()
    return cur.rowcount


def candidates(conn, today=None, limit=0):
    """New, not-stale rows on employer (non-aggregator) hosts not checked today."""
    agg = dedup_config()["aggregator_hosts"]
    today = (today or date.today()).isoformat()
    rows = conn.execute("SELECT canonical_url, url FROM jobs WHERE status='new' AND stale=0 "
                        "AND (live_checked IS NULL OR live_checked < ?) ORDER BY first_seen", (today,)).fetchall()
    rows = [r for r in rows if not host_matches(host_of(r["url"]), agg)]
    return rows[:limit] if limit else rows


def run(conn, rows, cfg=None, fetcher=fetch, pacer=None, today=None):
    cfg = cfg or pipeline_cfg.section("liveness")
    pacer = pacer or HostPacer(cfg["host_delay_seconds"])
    today = (today or date.today()).isoformat()
    counts = {"alive": 0, "gone": 0, "generic": 0, "error": 0}

    def check(row):
        pacer.wait(host_of(row["url"]))
        try:
            status, final, body = fetcher(row["url"], cfg["timeout_seconds"])
            return row, classify(row["url"], final, status, body, cfg)
        except Exception:  # noqa: BLE001 - a network error says nothing about the job
            return row, "error"

    with ThreadPoolExecutor(max_workers=cfg["concurrency"]) as pool:
        for row, state in pool.map(check, rows):
            counts[state] += 1
            if state == "alive":
                conn.execute("UPDATE jobs SET live_checked=?, last_seen=? WHERE canonical_url=?", (today, today, row["canonical_url"]))
            elif state in ("gone", "generic"):
                conn.execute("UPDATE jobs SET live_checked=?, stale=1, notes=TRIM(COALESCE(notes,'') || ' closed: ' || ?) WHERE canonical_url=?",
                             (today, state, row["canonical_url"]))
    conn.commit()
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg = pipeline_cfg.section("liveness")
    conn = store.connect()
    stale = 0 if a.dry_run else mark_stale(conn, cfg["stale_after_days"])
    rows = candidates(conn, limit=a.limit)
    print(f"{stale} row(s) marked stale by age (not seen for {cfg['stale_after_days']} days); {len(rows)} employer URL(s) to check.")
    if a.dry_run:
        for r in rows[:20]:
            print("  ", r["url"])
        return 0
    counts = run(conn, rows, cfg)
    print("checked: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
