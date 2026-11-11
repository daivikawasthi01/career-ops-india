"""Test server for the Blacklist e2e: the real server and routes over a throw-away jobs.db and blacklist file (nothing of yours is touched).
The Node matcher and the scanner's store are replaced by small stand-ins; what the server and the lists do with them is real."""
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import server
from lib import blacklist, config, db, jobs, jobs_prune, locations
from tests.test_jobs_fit import make_jobs_db, _ro

kb_dir = Path(tempfile.mkdtemp(prefix="af-e2e-blacklist-"))
kb = str(kb_dir / "kb.sqlite")
db.init(kb, str(ROOT / "schema.sql"))

jdb = make_jobs_db([("Platform Engineer", "jobs.lever.co/ghost"), ("Cloud Engineer", "jobs.lever.co/ghost2"), ("DevOps Engineer", "jobs.lever.co/real")])
c = sqlite3.connect(jdb)
c.execute("CREATE TABLE seen (canonical_url TEXT PRIMARY KEY, first_seen TEXT, fuzzy_key TEXT, expired_at TEXT)")
c.execute("CREATE TABLE rejected (title TEXT, company TEXT, source TEXT, url TEXT, reject_reason TEXT, seen_at TEXT, UNIQUE(url, reject_reason, seen_at))")
c.execute("UPDATE jobs SET urls = '[]', company = 'Ghost Staffing Pvt Ltd' WHERE title IN ('Platform Engineer', 'Cloud Engineer')")
c.execute("UPDATE jobs SET company = 'Real Works' WHERE title = 'DevOps Engineer'")
c.commit()
c.close()

config.CAREEROPS = kb_dir
config.path = lambda key, section="paths": jdb if key == "jobs_db" else ROOT / config.load()[section][key]
jobs._open = lambda: _ro(jdb)
locations.run_node = lambda locs: []


def stand_in(pairs):
    listed = {re.sub(r"\W+", "", e["company"].lower()) for e in blacklist.entries() if e["scope"] == "company"}
    return [i for i, p in enumerate(pairs) if re.sub(r"\W+", "", p["company"].lower()) in listed]


blacklist.run_node = stand_in
jobs_prune._store = lambda: type("S", (), {"backup_db": staticmethod(lambda p, keep=None: Path(str(p) + ".bak")), "canonical_url": staticmethod(lambda u: u)})
print("DB", kb, flush=True)
server.run(db_path=kb, state_file=kb_dir / "server.json")
