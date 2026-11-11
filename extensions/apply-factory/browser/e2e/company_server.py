"""Test server for the Company tab e2e: the real server and routes with the web search and the mail server replaced by fixed answers,
so the run costs no tokens and sends no mail. Throw-away database and pairing file."""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import server
from lib import company, db, mailcheck

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
print("DB", kb, flush=True)
server.run(db_path=kb, state_file=kb_dir / "server.json")
