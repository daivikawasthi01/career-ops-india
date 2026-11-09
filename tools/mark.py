#!/usr/bin/env python3
"""Set a job's status in data/jobs.db (Phase 9.1).

  python3 tools/mark.py URL interested|applied|ignore|new [--note "text"]
  python3 tools/mark.py --sync-excel output/mine-2026-11-09-120000.xlsx     # read the Status column of the Offers sheet
The Excel Status column is the one you edit by hand; rows with a status other than 'new' are written back to the database.
"""
import argparse
import sys

from openpyxl import load_workbook

import store


def sync_excel(conn, path):
    """Apply the Status column of the Offers sheet. Returns (changed, unknown_status, not_found)."""
    ws = load_workbook(path, read_only=True)["Offers"]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h or "").strip().lower() for h in rows[0]]
    try:
        link, status = head.index("link"), head.index("status")
    except ValueError:
        raise SystemExit("the Offers sheet needs 'Link' and 'Status' columns")
    changed = bad = missing = 0
    for r in rows[1:]:
        url, st = r[link], str(r[status] or "").strip().lower()
        if not url or not st or st == "new":
            continue
        if st not in store.STATUSES:
            bad += 1
        elif store.set_status(conn, str(url), st):
            changed += 1
        else:
            missing += 1
    return changed, bad, missing


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?")
    ap.add_argument("status", nargs="?")
    ap.add_argument("--note")
    ap.add_argument("--sync-excel")
    a = ap.parse_args()
    conn = store.connect()
    if a.sync_excel:
        c, bad, missing = sync_excel(conn, a.sync_excel)
        print(f"{c} row(s) updated, {bad} with an unknown status, {missing} not in the database")
        return 0
    if not (a.url and a.status):
        ap.error("give URL and status, or --sync-excel")
    if a.status not in store.STATUSES:
        ap.error(f"status must be one of {', '.join(store.STATUSES)}")
    if not store.set_status(conn, a.url, a.status, a.note):
        print("not found in data/jobs.db (run mine.py first, or check the URL)")
        return 1
    print(f"{a.url} -> {a.status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
