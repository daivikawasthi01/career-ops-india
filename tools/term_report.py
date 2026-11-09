#!/usr/bin/env python3
"""Which JobSpy search terms added no new rows lately. REPORT ONLY: nothing is edited or deleted.

  python3 tools/term_report.py             # window from config term_report_days (14)
  python3 tools/term_report.py --days 30
"""
import argparse
import sys
from datetime import date, timedelta

import pipeline_cfg
import store


def term_yield(conn, days, today=None):
    """{term: {'runs': n, 'fetched': n, 'new': n}} for runs inside the window."""
    since = ((today or date.today()) - timedelta(days=days)).isoformat()
    out = {}
    for r in conn.execute("SELECT term, COUNT(DISTINCT run_id) runs, SUM(fetched) fetched, SUM(new_rows) new "
                          "FROM term_yield WHERE at >= ? GROUP BY term", (since,)):
        out[r["term"]] = {"runs": r["runs"], "fetched": r["fetched"] or 0, "new": r["new"] or 0}
    return out


def silent_terms(conn, days, today=None):
    """Terms that ran at least once in the window and produced no new row."""
    return sorted(t for t, v in term_yield(conn, days, today).items() if v["new"] == 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=None)
    a = ap.parse_args()
    days = a.days or pipeline_cfg.load().get("term_report_days", 14)
    conn = store.connect()
    y = term_yield(conn, days)
    configured = pipeline_cfg.section("jobspy").get("terms", [])
    print(f"Search-term yield, last {days} days ({len(y)} of {len(configured)} terms ran). Report only.\n")
    for t in sorted(y, key=lambda k: -y[k]["new"]):
        v = y[t]
        print(f"  {v['new']:>4} new  {v['fetched']:>5} fetched  {v['runs']:>2} runs  {t}")
    never = [t for t in configured if t not in y]
    if never:
        print("\nDid not run in the window (budget rotation or no jobspy run): " + ", ".join(never))
    silent = silent_terms(conn, days)
    print("\nNo new rows in the window: " + (", ".join(silent) if silent else "none"))
    if silent:
        print("A term with no NEW rows may still be finding jobs other terms found first. Nothing was changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
