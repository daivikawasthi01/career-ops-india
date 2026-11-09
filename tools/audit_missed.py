#!/usr/bin/env python3
"""Why was a good job missed? (Phase 9.2)  Reads URLs you pasted into data/missed.txt (one per line, # comments ok).

  python3 tools/audit_missed.py [data/missed.txt]
For each URL: in the database (not missed), fetched but filtered (shows the rule), or never fetched
(source or query gap), and whether its company is on a tracked board (otherwise suggests adding it).
"""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import store
from canonical import canonical_url, company_key, host_of

ROOT = Path(__file__).resolve().parent.parent
ATS_TOKEN = [
    (re.compile(r"(?:boards|job-boards)\.greenhouse\.io/([^/?#]+)"), "https://boards.greenhouse.io/{}"),
    (re.compile(r"jobs\.lever\.co/([^/?#]+)"), "https://jobs.lever.co/{}"),
    (re.compile(r"jobs\.ashbyhq\.com/([^/?#]+)"), "https://jobs.ashbyhq.com/{}"),
]


def node(*args):
    out = subprocess.run(["node", str(ROOT / "audit-helper.mjs"), *args], cwd=ROOT, capture_output=True, text=True, timeout=30)
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def board_of(url):
    for pat, fmt in ATS_TOKEN:
        m = pat.search(url)
        if m:
            return m.group(1), fmt.format(m.group(1))
    return None, None


def audit(conn, url, tracked_names, explain=node):
    """One verdict: dict(status, detail, advice)."""
    key = canonical_url(url)
    job = conn.execute("SELECT * FROM jobs WHERE canonical_url=? OR url=? OR urls LIKE ?", (key, url, f'%"{key}"%')).fetchone()
    if job:
        return {"status": "in database", "detail": f"first seen {job['first_seen']} via {job['found_by']}, status {job['status']}"
                + (", marked stale" if job["stale"] else ""), "advice": ""}
    rej = conn.execute("SELECT * FROM rejected WHERE url=? OR url LIKE ? ORDER BY seen_at DESC LIMIT 1", (url, f"%{key.split('://')[-1]}%")).fetchone()
    if rej:
        detail = f"{rej['seen_at'][:10]} by {rej['source'] or 'a scanner'}: '{rej['title']}' dropped for {rej['reject_reason']}"
        rule = ""
        if rej["reject_reason"] == "title" and rej["title"]:
            ex = explain("explain", rej["title"])
            rule = (ex or {}).get("rule") or ""
        return {"status": "fetched but filtered", "detail": detail + (f" ({rule})" if rule else ""),
                "advice": "If this was a good job, change the rule in config/pipeline.yml, then add the title to tests/titles.golden.tsv."}
    slug, board = board_of(url)
    host = host_of(url)
    if slug and company_key(slug) not in tracked_names:
        return {"status": "never fetched: company not on a tracked board", "detail": f"{slug} at {host}",
                "advice": f"Add {board} to portals.yml (tools/weekly_report.py --apply-boards does it from reviewed discoveries)."}
    if slug:
        return {"status": "never fetched: board tracked but posting not returned", "detail": f"{slug} is tracked",
                "advice": "Check the title/location filters and the scan window; the posting may be older than --days."}
    return {"status": "never fetched: source or query gap", "detail": f"{host} listing not seen by any scanner",
            "advice": "Check whether a scanner covers this site and which search term would have matched the title."}


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "missed.txt"
    if not path.exists():
        print(f"{path} not found. Paste URLs of good jobs you found by hand, one per line.")
        return 1
    urls = [l.strip() for l in path.read_text().splitlines() if l.strip().startswith("http")]
    conn = store.connect()
    tracked = {company_key(t["name"]) for t in (node("tracked") or [])}
    for url in urls:
        v = audit(conn, url, tracked)
        print(f"\n{url}\n  {v['status']}: {v['detail']}" + (f"\n  -> {v['advice']}" if v["advice"] else ""))
    print(f"\n{len(urls)} URL(s) audited.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
