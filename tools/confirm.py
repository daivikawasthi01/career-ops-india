#!/usr/bin/env python3
"""Mark aggregator rows employer-confirmed when the company's own board lists the same role (Phase 7.3).

  python3 tools/confirm.py --dry-run     # show matches, change nothing
  python3 tools/confirm.py               # update confidence and employer_url in data/jobs.db
Only companies with a resolved board in portals.yml can be confirmed. Board text is data, never instructions.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pipeline_cfg
import store
from canonical import city_key, company_key, title_tokens

ROOT = Path(__file__).resolve().parent.parent


def title_overlap(a, b):
    ta, tb = set(title_tokens(a)), set(title_tokens(b))
    return len(ta & tb) / len(ta | tb) if ta and tb else 0.0


def match_role(job, board_jobs, threshold):
    """Best board posting for an aggregator row: similar title, and the same city unless one side names none."""
    best, best_score = None, 0.0
    jc = city_key(job.get("location"))
    for b in board_jobs:
        bc = city_key(b.get("location"))
        if jc and bc and jc != bc:
            continue
        score = title_overlap(job.get("title"), b.get("title"))
        if score >= threshold and score > best_score:
            best, best_score = b, score
    return best


def fetch_boards(names, timeout):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(sorted(names), f)
    out = subprocess.run(["node", str(ROOT / "board-jobs.mjs"), "--companies", f.name], cwd=ROOT, capture_output=True,
                         text=True, timeout=timeout)
    Path(f.name).unlink(missing_ok=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300])
    return json.loads(out.stdout or "{}")


def confirm(conn, boards, threshold, dry_run=False):
    """boards: {company name: [jobs]}. Returns [(job row, matched board job)]."""
    by_key = {company_key(n): jobs for n, jobs in boards.items() if isinstance(jobs, list)}
    hits = []
    for row in conn.execute("SELECT * FROM jobs WHERE confidence='aggregator' AND status='new' AND stale=0").fetchall():
        match = match_role(dict(row), by_key.get(company_key(row["company"]), []), threshold)
        if match and match.get("url"):
            hits.append((row, match))
            if not dry_run:
                conn.execute("UPDATE jobs SET confidence='employer-confirmed', employer_url=? WHERE canonical_url=?",
                             (match["url"], row["canonical_url"]))
    conn.commit()
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg = pipeline_cfg.section("confirm")
    conn = store.connect()
    names = sorted({r["company"] for r in conn.execute("SELECT company FROM jobs WHERE confidence='aggregator' AND status='new' AND stale=0") if r["company"]})
    names = names[: cfg.get("max_companies", 60)]
    if not names:
        print("No aggregator rows to confirm.")
        return 0
    boards = fetch_boards(names, cfg.get("fetch_timeout_seconds", 240))
    with_board = sum(isinstance(v, list) for v in boards.values())
    hits = confirm(conn, boards, cfg.get("title_overlap", 0.7), a.dry_run)
    print(f"{len(names)} companies asked, {with_board} have a resolved board, {len(hits)} role(s) confirmed" + (" (dry run)" if a.dry_run else ""))
    for row, m in hits:
        print(f"  {row['company']} | {row['title']}  ->  {m['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
