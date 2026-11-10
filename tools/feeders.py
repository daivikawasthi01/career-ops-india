"""Source feeders for mine.py: the tools that keep the lists the scanners read up to date.

mine.py's scanners fetch postings. These feeders find the boards, companies and campus pages that scanners need:
  directory    careersat.tech's list of official careers pages        (weekly)
  boards       verify those pages' ATS boards -> data/directory-boards.yml  (weekly)
  ats-tenants  probe Keka/Darwinbox/Zoho/Eightfold tenants           (weekly, time-boxed, resumable)
  telegram     employer names from public fresher-hiring channels    (every 2 days)
  funding      newly funded Indian startups (Inc42, Entrackr RSS)    (every 2 days, own list: data/funding-companies.txt)
  campus       change detection on campus / programme pages          (every 2 days)
Nothing here edits portals.yml or companies.txt: each feeder writes a reviewable file under data/.
A feeder failure never fails the run; it is reported and retried at the next due time. Pure logic only (no third-party imports),
so it is testable without the scanner dependencies.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def data_dir():
    base = os.environ.get("CAREER_OPS_ROOT") or str(ROOT.parent / "career-ops")
    return Path(base) / "data"


def feeder_list():
    d = data_dir()
    return [
        {"id": "directory", "file": "import-careers-directory.mjs", "args": [], "every": 7, "timeout": 300},
        {"id": "boards", "file": "classify-directory-boards.mjs", "args": ["--max-minutes", "30"], "every": 7, "timeout": 2400},
        {"id": "ats-tenants", "file": "probe-india-ats.mjs", "args": ["--hosts", str(d / "careers-directory-hosts.txt"), "--max-minutes", "30"], "every": 7, "timeout": 2400},
        {"id": "boards-review", "file": "review-india-boards.mjs", "args": ["--apply"], "every": 7, "timeout": 120},
        {"id": "telegram", "file": "telegram-companies.mjs", "args": ["--pages", "5"], "every": 2, "timeout": 600},
        {"id": "funding", "file": "funding-companies.mjs", "args": ["--days", "30"], "every": 2, "timeout": 300},
        {"id": "campus", "file": "watch-campus.mjs", "args": [], "every": 2, "timeout": 1200},
    ]


def select_feeders(feeders, state, explicit_ids, dry_run, due_fn, no_feeders=False):
    """Which feeders run now. Returns (feeders, notes).

    A named --steps runs exactly the feeders named in it. A default run runs those that are due. A dry run or
    --no-feeders runs none (feeders only write files under data/, but a dry run promises to change nothing).
    """
    ids = [f["id"] for f in feeders]
    named = [i for i in explicit_ids if i in ids]
    if no_feeders:
        return [], []
    if dry_run:
        return [], ["mine: feeders skipped in a dry run"]
    if explicit_ids:
        return [f for f in feeders if f["id"] in named], []
    due = [f for f in feeders if due_fn(state, f["id"], f["every"])]
    skipped = [f["id"] for f in feeders if f not in due]
    return due, ([f"mine: feeders not due: {', '.join(skipped)}"] if skipped else [])
