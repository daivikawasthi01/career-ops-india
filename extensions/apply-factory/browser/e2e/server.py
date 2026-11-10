"""Test server for the browser e2e: real Ollama, throw-away database and pairing file."""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import server
from lib import db, config

tmp = Path(tempfile.mkdtemp(prefix="af-e2e-"))
kb = str(tmp / "kb.sqlite")
(tmp / "Daivik-Awasthi-Resume.pdf").write_bytes(b"%PDF-1.4 default")
(tmp / "Daivik-Awasthi-DevopsResume.pdf").write_bytes(b"%PDF-1.4 devops")
import shutil
real = ROOT.parent.parent / "output" / "resumes" / "Daivik-Awasthi-Resume.pdf"
if real.exists():  # the studio e2e imports a real CV text pdf; copied so nothing real is ever written
    shutil.copy(real, tmp / "real-cv.pdf")
config.load()["paths_extra"]["cv_tex"] = str(tmp / "cv-tex")
config.load()["resumes"] = {"default": str(tmp / "Daivik-Awasthi-Resume.pdf"), "devops": str(tmp / "Daivik-Awasthi-DevopsResume.pdf"), "ai": str(tmp / "Daivik-Awasthi-AIResume.pdf")}
db.init(kb, str(ROOT / "schema.sql"))
import os
if os.environ.get("AF_SEED_TEX"):  # start the studio test from a ready tex instead of a 3 minute model import
    from lib import cv_store, cv_template
    from tests.test_cv_pipeline import DATA
    cv_store.save("default", cv_template.render(DATA), confirmed=True)
if os.environ.get("AF_SEED_DECL"):  # what earlier applications taught it about declarations
    from lib import knowledge
    with db.tx(kb) as conn:
        knowledge.upsert(conn, "not_a_veteran", "Yes", question_text="I am not a protected veteran", source="manual")
        knowledge.upsert(conn, "disability_status", "No, I do not have a disability", question_text="Disability status", source="manual")
print("DB", kb, flush=True)
server.run(db_path=kb, state_file=tmp / "server.json")
