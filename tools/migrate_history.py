#!/usr/bin/env python3
"""Import data/scan-history.tsv into data/jobs.db (dedup memory + rejected rows). Reads the TSV only; never edits it.

  python3 tools/migrate_history.py            # report only (in-memory database)
  python3 tools/migrate_history.py --write    # back up jobs.db if it exists, then import
"""
import argparse
import sys

import store


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--tsv", default=str(store.ROOT / "data" / "scan-history.tsv"))
    a = ap.parse_args()
    if a.write:
        b = store.backup_db()
        print(f"backup: {b}" if b else "no existing jobs.db to back up")
        conn = store.connect()
    else:
        conn = store.connect(":memory:")
    r = store.migrate_scan_history(conn, a.tsv)
    print(f"{r['total']} rows. By status: " + ", ".join(f"{k}={v}" for k, v in sorted(r["by_status"].items(), key=lambda kv: -kv[1])))
    skipped = r["skipped_with_india_location"] + r["skipped_other_location"]
    if skipped:
        print(f"skipped rows: {skipped}; {r['skipped_other_location']} ({r['skipped_other_location'] / skipped:.0%}) name no Indian place "
              "(non-India noise from scan.mjs scanning global boards).")
    if a.write:
        print("rows now: seen=%d rejected=%d" % (conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0],
                                                  conn.execute("SELECT COUNT(*) FROM rejected").fetchone()[0]))
    else:
        print("Report only. Add --write to import into data/jobs.db.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
