#!/usr/bin/env python3
"""Print a random sample of data/rejected.tsv so you can skim for good jobs that were dropped.

  python3 tools/rejected_sample.py            # 50 rows
  python3 tools/rejected_sample.py -n 100 --reason title --seed 1
"""
import argparse, csv, random, sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent.parent / "data" / "rejected.tsv"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=50)
    ap.add_argument("--file", default=str(DEFAULT))
    ap.add_argument("--reason", help="only rows whose reason starts with this")
    ap.add_argument("--seed", type=int)
    a = ap.parse_args()
    p = Path(a.file)
    if not p.exists():
        sys.exit(f"{p} not found. Run a scan without --dry-run first.")
    with p.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    if a.reason:
        rows = [r for r in rows if (r.get("reason") or "").startswith(a.reason)]
    random.Random(a.seed).shuffle(rows)
    for r in rows[: a.n]:
        print(f"[{r.get('reason')}] {r.get('title')} | {r.get('company')} | {r.get('source')}\n    {r.get('url')}")
    print(f"\n{min(a.n, len(rows))} of {len(rows)} rejected rows shown.")

if __name__ == "__main__":
    main()
