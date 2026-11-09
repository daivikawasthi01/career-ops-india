#!/usr/bin/env python3
"""Regenerate the Pending section of data/pipeline.md from jobs.db rows with status=new.

  python3 tools/render_pipeline.py            # dry run: say what would change
  python3 tools/render_pipeline.py --write    # back up pipeline.md, then replace it atomically
Processed rows are never touched. Pending lines the database does not know are kept.
"""
import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

import store

PIPELINE = store.ROOT / "data" / "pipeline.md"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--db", default=str(store.DB_PATH))
    ap.add_argument("--file", default=str(PIPELINE))
    a = ap.parse_args()
    conn = store.connect(a.db)
    path = Path(a.file)
    _, added, foreign = store.render_pipeline(conn, path, write=False)
    print(f"{added} new job(s) from the database, {foreign} pending line(s) kept that the database does not know.")
    if not a.write:
        print("Dry run. Add --write to back up and replace the file.")
        return 0
    backup = path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, backup)
    store.render_pipeline(conn, path, write=True)
    print(f"Wrote {path}. Backup: {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
