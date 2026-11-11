"""Test server for the Company tab e2e: the real server and routes with the web search and the mail server replaced by fixed answers,
so the run costs no tokens and sends no mail. Throw-away database and pairing file."""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import server
from lib import company, db, gmail, mailcheck, outreach, resume

kb_dir = Path(tempfile.mkdtemp(prefix="af-e2e-company-"))
kb = str(kb_dir / "kb.sqlite")
db.init(kb, str(ROOT / "schema.sql"))

SOURCES = [{"title": "About", "uri": "https://acme.com/about"}, {"title": "News", "uri": "https://news.example/cto"}]


def fake_search(prompt, **kw):
    if "email address format" in prompt:  # the company mails from acme-mail.com, not its website domain
        return {"text": '{"domains": [{"domain": "acme-mail.com", "pattern": "first.last", "source": "https://acme.com/about"}], "examples": [{"name": "Sam Rivera", "email": "sam.rivera@acme-mail.com", "source": "https://news.example/cto"}]}', "sources": SOURCES}
    if "employees" in prompt:
        return {"text": '{"employees": 180, "employees_note": "about 180 people (2025)", "hq": "Bengaluru, India", "summary": "Payments for small businesses.", "source": "https://acme.com/about"}', "sources": SOURCES}
    return {"text": '{"people": [{"name": "Ada Lovelace", "title": "CTO", "kind": "engineering", "source": "https://news.example/cto", "linkedin": null},'
                    '{"name": "Grace Hopper", "title": "Head of Talent", "kind": "talent", "source": "https://acme.com/about", "linkedin": "https://www.linkedin.com/in/grace"}]}', "sources": SOURCES}


page = '<a href="mailto:hello@acme.com">hello</a> <a href="tel:+918012345678">call</a>'
company.search = fake_search
company.fetch_text = lambda url, timeout=8: (404, "") if "robots" in url else ((200, page) if url.rstrip("/").endswith(("acme.com", "/contact")) else (404, ""))
company.domain_for = lambda name, url="": ("acme.com", "scanner discovery")
mailcheck.doh = lambda name, rtype, timeout=6: ({"Answer": [{"data": "10 mx." + name + "."}]} if rtype == "MX" and name in ("acme.com", "acme-mail.com") else {})


def fake_find(name, domains, known=None, prefer=None):
    domain = domains[0]
    rows = [("ada.lovelace", "accepted", "low", "low"), ("ada", "rejected", "high", "high")]
    return {"domain": domain, "provider": "google", "policy": {"spf": True, "dmarc": "reject"}, "catch_all": False, "hosts": ["aspmx.l.google.com"], "probes": 3,
            "rows": [{"address": f"{l}@{domain}", "shape": "first.last", "verdict": v, "risk": mailcheck.risk(v, "google", {"dmarc": "reject"}, f"{l}@{domain}")} for l, v, _, _ in rows]}


mailcheck.find_multi = fake_find
mailcheck.generic = lambda domain: {**fake_find("x", [domain]), "rows": [{"address": f"careers@{domain}", "shape": "generic", "verdict": "catch-all",
                                    "risk": mailcheck.risk("catch-all", "proofpoint", {"dmarc": "none"}, f"careers@{domain}")}]}
# Outreach: the model, Google and the contact list are replaced; what the server does with them is real.
import tempfile as _t
_cv = Path(_t.mkdtemp()) / "Daivik-Awasthi-Resume.pdf"
_cv.write_bytes(b"%PDF-1.4 cv")
outreach.draft = lambda person, company, title, jd, report="": {"subject": f"{title} at {company}: a quick question", "words": 42,
    "body": f"Hi {person['name'].split()[0]},\n\nI built a deploy pipeline that maps to your platform team. Could we talk for ten minutes?\n\nBest,\nDaivik"}
resume.pick = lambda title, jd="": ("default", _cv)
outreach.cover.draft = lambda title, company, jd, report="", person_name="": {"text": "x", "from_report": False, "tex": (
    "\\documentclass[11pt]{article}\n\\begin{document}\nDear " + (person_name.split()[0] if person_name else "team") + ",\n\n"
    "You ask for Kubernetes operations; at Acme I built that tooling.\n\n\\end{document}\n")}   # tectonic compiles it for real
outreach.log_contact = lambda person, company, email, *a, **k: "cold email draft today; follow up in four business days"
_state = {"connected": False}
gmail.status = lambda: {"configured": True, "connected": _state["connected"]}
gmail.start = lambda: "about:blank#signin"
def _create(to, subject, body, attachments=None):
    cover = next((a[1] for a in attachments or [] if a[0].startswith("Cover-Letter")), b"")
    from lib import tex as _tex
    (kb_dir / "drafts.json").write_text(json.dumps({"to": to, "subject": subject, "files": [a[0] for a in attachments or []],
                                                    "cover_has_edit": b"on-call" in _tex.pdf_text(cover).encode() if cover.startswith(b"%PDF") else False}))
    return {"draft_id": "d1", "message_id": "m1", "url": "about:blank#drafts"}
gmail.create_draft = _create
import json, threading, time
threading.Thread(target=lambda: (time.sleep(0.2), None), daemon=True).start()
(kb_dir / "connect.flag").write_text("")
def _watch():
    while True:   # the e2e "signs in" by creating this file
        if (kb_dir / "signed-in").exists():
            _state["connected"] = True
        time.sleep(0.3)
threading.Thread(target=_watch, daemon=True).start()
print("DB", kb, flush=True)
server.run(db_path=kb, state_file=kb_dir / "server.json")
