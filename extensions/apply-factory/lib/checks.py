"""
What career-ops checks before it drafts an application, run when you open a posting:
blacklist, an earlier application to the same company, whether the posting is still open, whether the page is an
aggregator (unconfirmed until found at the employer), and whether an evaluation report already exists for it.
Each check reuses career-ops' own script and fails alone: one slow or broken check never hides the others.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import yaml

from . import config, nodecli

_BLACKLIST_JS = """
import { readFileSync, existsSync } from 'node:fs';
import { parseBlacklist, findBlacklistEntry } from './scan.mjs';
const [company, url] = process.argv.slice(1);
const path = (process.env.CAREER_OPS_BLACKLIST) || 'data/blacklist.md';
if (!existsSync(path)) { console.log('null'); process.exit(0); }
console.log(JSON.stringify(findBlacklistEntry(parseBlacklist(readFileSync(path, 'utf8')), company, url) ?? null));
"""


def blacklist(company: str, url: str) -> dict:
    rc, out, err = nodecli.run(["--input-type=module", "-e", _BLACKLIST_JS, company, url])
    if rc != 0:
        return {"status": "error", "detail": err[:160]}
    entry = json.loads(out.strip() or "null")
    return {"status": "hit", "entry": entry} if entry else {"status": "clear"}


def duplicate(company: str, title: str, url: str) -> dict:
    rc, out, err = nodecli.run(["precheck-duplicate.mjs", "--company", company, "--title", title, "--url", url, "--json"])
    if rc != 0:
        return {"status": "error", "detail": err[:160]}
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"status": "error", "detail": "unreadable output"}
    rows = data.get("matches") or data.get("rows") or data.get("candidates") or []
    return {"status": "found" if rows else "clear", "rows": rows[:5]}


def liveness(url: str) -> dict:
    rc, out, err = nodecli.run(["check-liveness.mjs", "--no-fallback", "--no-record", url], timeout=40)
    text = (out + err).lower()
    for verdict in ("expired", "active", "uncertain"):
        if re.search(rf"\b{verdict}\b", text):
            return {"status": verdict}
    return {"status": "uncertain", "detail": "no verdict"}


def aggregator(url: str) -> dict:
    cfg = yaml.safe_load((config.CAREEROPS / "config" / "pipeline.yml").read_text())
    hosts = cfg.get("dedup", {}).get("aggregator_hosts", [])
    host = urlsplit(url).hostname or ""
    hit = next((h for h in hosts if host == h or host.endswith("." + h)), None)
    return {"status": "aggregator" if hit else "employer", "host": hit}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def report_for(company: str, url: str) -> dict:
    """The evaluation report for this posting, matched by URL first, then by company name."""
    best = None
    for p in sorted((config.CAREEROPS / "reports").glob("*.md")):
        head = p.read_text(errors="ignore")[:1500]
        m_url = re.search(r"\*\*URL:\*\*\s*(\S+)", head)
        m_score = re.search(r"\*\*Score:\*\*\s*([\d.]+)", head)
        m_title = re.search(r"^# Evaluation:\s*(.+)$", head, re.M)
        entry = {"path": str(p.relative_to(config.CAREEROPS)), "num": p.name.split("-")[0],
                 "score": float(m_score.group(1)) if m_score else None, "title": m_title.group(1).strip() if m_title else p.stem}
        if m_url and url and _norm(m_url.group(1)) == _norm(url):
            return {"status": "match", **entry}
        if company and _norm(company) in _norm(entry["title"]):
            best = best or {"status": "company", **entry}
    return best or {"status": "none"}


def preflight(company: str, title: str, url: str) -> dict:
    jobs = {"blacklist": lambda: blacklist(company, url), "duplicate": lambda: duplicate(company, title, url),
            "liveness": lambda: liveness(url), "aggregator": lambda: aggregator(url), "report": lambda: report_for(company, url)}
    out: dict = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {k: pool.submit(fn) for k, fn in jobs.items()}
        for k, f in futures.items():
            try:
                out[k] = f.result(timeout=60)
            except Exception as e:  # one failing check must not hide the rest
                out[k] = {"status": "error", "detail": str(e)[:160]}
    return out
