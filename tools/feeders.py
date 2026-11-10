"""Source feeders for mine.py: the tools that keep the lists the scanners read up to date.

mine.py's scanners fetch postings. These feeders find the boards, companies and campus pages that scanners need:
  directory    careersat.tech's list of official careers pages
  boards       verify those pages' ATS boards -> data/directory-boards.yml  (time-boxed, resumable)
  ats-tenants  probe Keka/Darwinbox/Zoho/Eightfold tenants           (time-boxed, resumable)
  boards-review  keep the Indian boards with matching company names and add them to portals.yml
  telegram     employer names from public fresher-hiring channels
  funding      newly funded Indian startups (Inc42, Entrackr RSS)    (own list: data/funding-companies.txt)
  campus       change detection on campus / programme pages
Every real run runs every feeder, in this order; there is no per-feeder schedule.
Nothing here edits portals.yml or companies.txt: each feeder writes a reviewable file under data/.
A feeder failure never fails the run; it is reported and tried again at the next run. Pure logic only (no third-party imports),
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
        {"id": "directory", "file": "import-careers-directory.mjs", "args": [], "timeout": 300},
        {"id": "boards", "file": "classify-directory-boards.mjs", "args": ["--max-minutes", "30"], "timeout": 2400},
        {"id": "ats-tenants", "file": "probe-india-ats.mjs", "args": ["--hosts", str(d / "careers-directory-hosts.txt"), "--max-minutes", "30"], "timeout": 2400},
        {"id": "boards-review", "file": "review-india-boards.mjs", "args": ["--apply"], "timeout": 120},
        {"id": "telegram", "file": "telegram-companies.mjs", "args": ["--pages", "5"], "timeout": 600},
        {"id": "funding", "file": "funding-companies.mjs", "args": ["--days", "30"], "timeout": 300},
        {"id": "campus", "file": "watch-campus.mjs", "args": [], "timeout": 1200},
    ]


def select_feeders(feeders, explicit_ids, dry_run, no_feeders=False):
    """Which feeders run now. Returns (feeders, notes).

    A named --steps runs exactly the feeders named in it. A default run runs all of them. A dry run or --no-feeders runs
    none (feeders only write files under data/, but a dry run promises to change nothing).
    """
    if no_feeders:
        return [], []
    if dry_run:
        return [], ["mine: feeders skipped in a dry run"]
    if explicit_ids:
        return [f for f in feeders if f["id"] in explicit_ids], []
    return list(feeders), []
